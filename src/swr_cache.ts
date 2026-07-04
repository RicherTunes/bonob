import { Clock, SystemClock } from "./clock";

type Entry = {
  at: number; // completion time of the most recent successful fetch
  value: Promise<unknown>;
  inFlight: boolean; // a fetch (cold OR refresh) is currently running for this key
};

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

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    opts: { maxEntries?: number; maxStaleMs?: number; backstopMs?: number } = {}
  ) {
    this.maxEntries = opts.maxEntries ?? 50;
    this.maxStaleMs = opts.maxStaleMs ?? 4 * Math.max(ttlMs, 0);
    this.backstopMs = opts.backstopMs ?? 60_000;
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

  get<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return fetch();
    const now = this.clock.now().valueOf();
    const entry = this.entries.get(key);
    if (entry) {
      const age = now - entry.at;
      // Past the hard stale cap with nothing in flight: treat as absent, so we never
      // serve ancient data and a revoked credential can't browse cached lists forever.
      if (age >= this.maxStaleMs && !entry.inFlight) {
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

  private coldFetch<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const value = this.withBackstop(fetch());
    const entry: Entry = { at: this.clock.now().valueOf(), value, inFlight: true };
    this.entries.set(key, entry);
    this.evictOverCap();
    value
      .then(() => {
        entry.at = this.clock.now().valueOf(); // stamp completion, not start
        entry.inFlight = false;
      })
      .catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    return value;
  }

  private refresh<T>(key: string, fetch: () => Promise<T>, stale: Entry): void {
    this.withBackstop(fetch())
      .then((v) => {
        // Only replace if the stale entry is still current — an LRU eviction or an
        // invalidate() in the meantime must not be resurrected by a late refresh.
        if (this.entries.get(key) === stale) {
          this.entries.set(key, {
            at: this.clock.now().valueOf(),
            value: Promise.resolve(v),
            inFlight: false,
          });
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
