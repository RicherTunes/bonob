import { Clock, SystemClock } from "./clock";

type Entry = {
  at: number; // completion time of the most recent successful fetch (start time until settled)
  value: Promise<unknown>;
  inFlight: boolean; // a fetch (cold OR refresh) is currently running for this key
  settled: boolean; // has a fetch ever successfully resolved a value for this entry?
};

// A durable backing store so the cache can survive process restarts (e.g. a bonob
// redeploy): load() seeds the cache on construction, save() persists each resolved
// value. Values are whatever the fetcher returns and must be JSON-serializable.
export interface SwrCacheStore {
  load(): Array<{ key: string; at: number; value: unknown }>;
  save(key: string, at: number, value: unknown): void;
}

/**
 * A small stale-while-revalidate async cache with request coalescing, a bounded
 * size (LRU) and a hard stale cap. Built for bonob's large browse lists (e.g.
 * getArtists is ~10MB / multi-second on big libraries) which Sonos re-fetches on
 * every browse page — a cold fetch on the browse path exceeds Sonos's SMAPI timeout.
 *
 *  - get(key, fetch): serve the cached value instantly (fresh OR stale); on a stale
 *    hit kick ONE background refresh (never while a fetch is already in flight);
 *    coalesce concurrent misses onto one in-flight promise; evict a failed cold fetch
 *    so the next call retries; keep serving stale when a refresh fails, but only up to
 *    maxStaleMs — then go cold. That cap bounds how long a revoked/rotated credential
 *    keeps browsing cached lists (a cache hit performs no upstream auth).
 *  - invalidate(key): drop an entry (call after mutating the cached resource).
 *  - Disabled when ttlMs <= 0 (get() just calls through, nothing is stored).
 *
 * The REAL fetch timeout belongs in the fetcher (so the socket is actually aborted);
 * the backstop here only guarantees a fetcher-without-a-timeout can't wedge a key's
 * in-flight flag forever.
 */
export class SwrCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxStaleMs: number;
  private readonly backstopMs: number;
  private readonly store?: SwrCacheStore;
  private readonly revive: (v: unknown) => unknown;
  private readonly persistMaxAgeMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    opts: {
      maxEntries?: number;
      maxStaleMs?: number;
      backstopMs?: number;
      store?: SwrCacheStore;
      revive?: (v: unknown) => unknown;
      persistMaxAgeMs?: number;
    } = {}
  ) {
    this.maxEntries = opts.maxEntries ?? 50;
    this.maxStaleMs = opts.maxStaleMs ?? 4 * Math.max(ttlMs, 0);
    this.backstopMs = opts.backstopMs ?? 60_000;
    this.store = opts.store;
    this.revive = opts.revive ?? ((v) => v);
    // How old a persisted entry may be and still be restored on startup. Independent of the
    // live maxStale cap: a restored value is served instantly then revalidated (see seed), so
    // the cache survives a restart of any length up to this bound without a cold first browse.
    this.persistMaxAgeMs = opts.persistMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    // Restore a persisted cache on startup so the first browse after a restart isn't cold.
    if (this.store && ttlMs > 0) {
      for (const e of this.store.load()) this.seed(e.key, this.revive(e.value), e.at);
    }
  }

  // Insert a resolved, settled entry (restores a persisted value on startup). Skips anything
  // already past the stale cap, so a long downtime never seeds ancient data.
  private seed(key: string, value: unknown, at: number): void {
    const now = this.clock.now().valueOf();
    // Reject a bad timestamp (a future or non-finite `at` from clock skew / a hostile file
    // would otherwise read as "fresh forever") or an entry older than the persistence cap.
    if (!Number.isFinite(at) || at > now || now - at >= this.persistMaxAgeMs) return;
    // Serve the restored value instantly, but if it is already older than the TTL, clamp its
    // timestamp to "just stale" so the first access revalidates it in the background instead
    // of the hard maxStale cap dropping it after a long downtime. This is what lets the cache
    // survive a restart of any length (up to persistMaxAgeMs) without a cold first browse.
    const effectiveAt = now - at > this.ttlMs ? now - this.ttlMs : at;
    this.entries.set(key, {
      at: effectiveAt,
      value: Promise.resolve(value),
      inFlight: false,
      settled: true,
    });
    this.evictOverCap();
  }

  private persist(key: string, at: number, value: unknown): void {
    if (!this.store) return;
    try {
      this.store.save(key, at, value);
    } catch {
      // best-effort durability; a failed write must never break serving
    }
  }

  static disabled(clock: Clock = SystemClock): SwrCache {
    return new SwrCache(clock, 0);
  }

  size(): number {
    return this.entries.size;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  // Warm a key in the background without waiting on it: kick a fetch (which coalesces with
  // any in-flight one and refreshes if stale) and swallow errors. Used to pre-warm a slow
  // list (e.g. getArtists) on connect so the first browse of a session isn't cold.
  warm<T>(key: string, fetch: () => Promise<T>): void {
    void this.get(key, fetch).catch(() => {});
  }

  get<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return fetch();
    const now = this.clock.now().valueOf();
    const entry = this.entries.get(key);
    if (entry) {
      const age = now - entry.at;
      // Hard stale cap, but only once we actually HAVE a resolved (stale) value: past
      // maxStale we never serve it, even mid-refresh (a hung refresh must not extend the
      // cap, and a revoked credential must not keep browsing). A cold fetch still in flight
      // has no value yet, so leave it to coalesce rather than delete + double-fetch.
      if (age >= this.maxStaleMs && entry.settled) {
        this.entries.delete(key);
      } else {
        this.touch(key, entry);
        if (age >= this.ttlMs && !entry.inFlight) {
          entry.inFlight = true;
          this.refresh(key, fetch, entry);
        }
        return entry.value as Promise<T>;
      }
    }
    return this.coldFetch(key, fetch);
  }

  // Call the fetcher, turning a synchronous throw into a rejection so it never escapes
  // (a sync throw from a refresh would otherwise leave inFlight=true and wedge the key).
  // Kept synchronous (no extra microtask) to preserve coalescing of concurrent misses.
  private invoke<T>(fetch: () => Promise<T>): Promise<T> {
    try {
      return fetch();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private coldFetch<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const value = this.withBackstop(this.invoke(fetch));
    const entry: Entry = {
      at: this.clock.now().valueOf(),
      value,
      inFlight: true,
      settled: false,
    };
    this.entries.set(key, entry);
    this.evictOverCap();
    value
      .then((v) => {
        // Only commit if this entry is still current. If it was LRU-evicted or replaced while
        // in flight (e.g. many warm-on-login users churn the cache), don't resurrect it or
        // persist stale data over a newer entry's file. Coalesced callers still get `value`.
        if (this.entries.get(key) !== entry) return;
        entry.at = this.clock.now().valueOf(); // stamp completion, not start
        entry.inFlight = false;
        entry.settled = true;
        this.persist(key, entry.at, v);
      })
      .catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    return value;
  }

  private refresh<T>(key: string, fetch: () => Promise<T>, stale: Entry): void {
    this.withBackstop(this.invoke(fetch))
      .then((v) => {
        // Only replace if the stale entry is still current — an LRU eviction or an
        // invalidate() in the meantime must not be resurrected by a late refresh.
        if (this.entries.get(key) === stale) {
          const at = this.clock.now().valueOf();
          this.entries.set(key, {
            at,
            value: Promise.resolve(v),
            inFlight: false,
            settled: true,
          });
          this.persist(key, at, v);
        }
      })
      .catch(() => {
        stale.inFlight = false; // keep serving stale; a later access may retry
      });
  }

  private withBackstop<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SwrCache backstop timed out")),
          this.backstopMs
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private touch(key: string, entry: Entry): void {
    // Map preserves insertion order: delete + set moves the key to most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
