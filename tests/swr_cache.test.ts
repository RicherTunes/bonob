import dayjs from "dayjs";
import { FixedClock } from "../src/clock";
import { SwrCache } from "../src/swr_cache";
import logger from "../src/logger";

// A fetch whose resolution/rejection the test controls, and that counts calls.
function deferredFetcher<T>() {
  let calls = 0;
  const controls: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const fetch = () => {
    calls++;
    return new Promise<T>((resolve, reject) => controls.push({ resolve, reject }));
  };
  return {
    fetch,
    get calls() {
      return calls;
    },
    // settle the Nth (0-based) in-flight fetch
    resolve: (i: number, v: T) => controls[i]!.resolve(v),
    reject: (i: number, e: unknown) => controls[i]!.reject(e),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("SwrCache", () => {
  const at = dayjs("2024-01-01T00:00:00Z");

  it("is disabled at ttl<=0: always calls through, never caches", async () => {
    const cache = new SwrCache(new FixedClock(at), 0);
    const f = deferredFetcher<number>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, 1);
    await p1;
    const p2 = cache.get("k", f.fetch);
    f.resolve(1, 2);
    await p2;
    expect(f.calls).toBe(2);
  });

  it("caches within the TTL (one fetch for two gets)", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, "v");
    expect(await p1).toBe("v");
    expect(await cache.get("k", f.fetch)).toBe("v");
    expect(f.calls).toBe(1);
  });

  it("coalesces concurrent gets into a single fetch", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    const a = cache.get("k", f.fetch);
    const b = cache.get("k", f.fetch);
    const c = cache.get("k", f.fetch);
    f.resolve(0, "v");
    expect(await Promise.all([a, b, c])).toEqual(["v", "v", "v"]);
    expect(f.calls).toBe(1);
  });

  it("serves stale instantly and refreshes in the background (SWR)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000);
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, "old");
    expect(await p1).toBe("old");

    clock.add(2, "m"); // stale (past 60s ttl)
    const stale = await cache.get("k", f.fetch); // returns instantly...
    expect(stale).toBe("old");
    expect(f.calls).toBe(2); // ...and kicked a background refresh
    f.resolve(1, "new");
    await flush();
    expect(await cache.get("k", f.fetch)).toBe("new"); // refreshed value now served
  });

  it("does NOT double-fetch: a stale read while a cold fetch is still in flight (ttl < fetch time)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 10); // tiny ttl
    const f = deferredFetcher<string>();
    const cold = cache.get("k", f.fetch); // in flight, not yet resolved
    clock.add(1, "s"); // now "stale" by wall clock, but the fetch is still running
    const second = cache.get("k", f.fetch); // must coalesce, not launch a 2nd fetch
    expect(f.calls).toBe(1);
    f.resolve(0, "v");
    expect(await Promise.all([cold, second])).toEqual(["v", "v"]);
  });

  it("evicts a failed cold fetch so the next call retries", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.reject(0, new Error("boom"));
    await expect(p1).rejects.toBeDefined();
    const p2 = cache.get("k", f.fetch);
    f.resolve(1, "v");
    expect(await p2).toBe("v");
    expect(f.calls).toBe(2);
  });

  it("keeps serving stale when a background refresh fails (within maxStale)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000);
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, "old");
    await p1;

    clock.add(2, "m");
    const stale = await cache.get("k", f.fetch);
    expect(stale).toBe("old");
    f.reject(1, new Error("refresh down"));
    await flush();
    // refresh failed -> still serve stale, and a later access can retry the refresh
    expect(await cache.get("k", f.fetch)).toBe("old");
    expect(f.calls).toBe(3);
    f.resolve(2, "old"); // settle the retry refresh so no backstop timer dangles
    await flush();
  });

  it("stops serving stale past maxStaleMs (goes cold instead of serving ancient data)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000, { maxStaleMs: 5 * 60_000 });
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, "old");
    await p1;

    clock.add(10, "m"); // past maxStale (5m)
    const p2 = cache.get("k", f.fetch); // must NOT resolve to stale "old"; it's a cold fetch
    let settled = false;
    p2.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false); // still awaiting the fresh fetch, not served stale
    f.resolve(1, "fresh");
    expect(await p2).toBe("fresh");
  });

  it("bounds size with LRU (evicts least-recently-used over maxEntries)", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000, { maxEntries: 2 });
    const f = deferredFetcher<string>();
    await settle(cache, "a", f, "A");
    await settle(cache, "b", f, "B");
    await cache.get("a", f.fetch); // touch a -> b becomes LRU
    await settle(cache, "c", f, "C"); // over cap -> evicts b (the LRU)
    expect(cache.size()).toBe(2);

    // a and c are still cached (hits, no new fetch)
    const before = f.calls;
    await cache.get("a", f.fetch);
    await cache.get("c", f.fetch);
    expect(f.calls).toBe(before);

    // b was evicted -> a fresh fetch happens
    const pb = cache.get("b", f.fetch);
    f.resolve(f.calls - 1, "B2");
    expect(await pb).toBe("B2");
    expect(f.calls).toBe(before + 1);
  });

  it("invalidate() drops a key so the next get refetches", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    await settle(cache, "k", f, "v");
    cache.invalidate("k");
    const p = cache.get("k", f.fetch);
    f.resolve(f.calls - 1, "v2");
    expect(await p).toBe("v2");
    expect(f.calls).toBe(2);
  });

  it("evictOverCap terminates when the map empties under a degenerate maxEntries<0 (no infinite loop)", async () => {
    // maxEntries has no floor (`opts.maxEntries ?? 50`), so a negative cap keeps the
    // `while (this.entries.size > maxEntries)` loop true for an EMPTY map; the
    // `if (oldest === undefined) break` is the only thing that lets evictOverCap return. A mutant
    // that drops the break infinite-loops (this.entries.delete(undefined) is a no-op, size stays 0)
    // and this test hangs instead of resolving -> red.
    const cache = new SwrCache(new FixedClock(at), 60_000, { maxEntries: -1 });
    const f = deferredFetcher<number>();
    const p = cache.get("k", f.fetch); // insert, then evictOverCap empties the map and hits the break
    f.resolve(0, 1);
    await p;
    expect(cache.size()).toBe(0);
    // The entry was evicted: a follow-up get is a cold miss (a fresh fetch happens).
    const f2 = deferredFetcher<number>();
    const p2 = cache.get("k", f2.fetch);
    expect(f2.calls).toBe(1);
    f2.resolve(0, 2);
    await p2;
  });

  it("enforces maxStale even while a refresh is in flight (a hung refresh can't extend it)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000, { maxStaleMs: 5 * 60_000 });
    const f = deferredFetcher<string>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, "old");
    await p1;

    clock.add(2, "m"); // stale -> serve stale + kick a refresh (index 1) we leave hanging
    expect(await cache.get("k", f.fetch)).toBe("old");
    expect(f.calls).toBe(2);

    clock.add(10, "m"); // 12m total, past maxStale 5m, refresh still in flight
    const p3 = cache.get("k", f.fetch); // must cold-fetch (index 2), NOT serve stale
    let served: string | undefined;
    p3.then((v) => (served = v));
    await flush();
    expect(served).toBeUndefined();
    expect(f.calls).toBe(3);
    f.resolve(2, "fresh");
    expect(await p3).toBe("fresh");
    f.resolve(1, "orphan"); // settle the orphaned refresh (discarded by identity guard)
    await flush();
  });

  it("does not wedge if the fetcher throws synchronously (rejects, then retries)", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    let boom = true;
    const fetch = () => {
      if (boom) throw new Error("sync boom");
      return Promise.resolve("v");
    };
    await expect(cache.get("k", fetch)).rejects.toThrow(/sync boom/);
    boom = false;
    expect(await cache.get("k", fetch)).toBe("v");
  });

  it("warm() kicks a background fetch that populates the cache without waiting", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    cache.warm("k", f.fetch); // returns void, does not block
    expect(f.calls).toBe(1); // fetch kicked
    f.resolve(0, "warmed");
    await flush();
    const got = await cache.get("k", f.fetch); // now a cache hit
    expect(got).toBe("warmed");
    expect(f.calls).toBe(1); // no extra fetch
  });

  it("warm() swallows fetch errors (no unhandled rejection)", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    cache.warm("k", f.fetch);
    f.reject(0, new Error("warm failed"));
    await flush(); // must not throw / leave an unhandled rejection
    const got = cache.get("k", f.fetch); // evicted -> refetch
    f.resolve(1, "ok");
    expect(await got).toBe("ok");
  });

  it("warm() LOGS a failed background fetch instead of swallowing it", async () => {
    // warm() was `void this.get(key, fetch).catch(() => {})`. The album index build runs through it,
    // so a build that threw left NO trace anywhere: no error, no warning, no partial file. Observed
    // live - a rebuild started, died, removed its .tmp, and the only evidence was the ABSENCE of a
    // snapshot 11 minutes later. A background job that can fail invisibly is a job you cannot
    // operate. Swallowing the rejection is right (it must not become an unhandled rejection);
    // swallowing the INFORMATION is not.
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const cache = new SwrCache(new FixedClock(at), 60_000);
      cache.warm("albumIndex:v3:someone", () =>
        Promise.reject(new Error("Inconsistent album index scan: duplicate album id"))
      );
      await flush();

      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("albumIndex:v3:someone");
      expect(msg).toContain("Inconsistent album index scan");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the NEWEST persisted entries when the store has more than maxEntries", async () => {
    // The store returns files newest-first, seeding inserted them in that order, and
    // evictOverCap removes `entries.keys().next()` - the FIRST inserted. So a restart kept the
    // OLDEST maxEntries and threw away the newest, which is backwards.
    //
    // Live consequence: the album/artist index entries are the ones written most recently, so on a
    // catalog with more than maxEntries (50) persisted browse pages - genres x pages, years,
    // recentlyAdded - the entry that matters is evicted during startup seeding and every restart
    // pays a cold browse. This defeats the whole point of persisting the cache.
    const now = dayjs(at).valueOf();
    // newest-first, exactly as fileStore.load() returns them
    const persisted = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i}`, // k0 is NEWEST, k59 is OLDEST
      at: now - i * 1000,
      value: `v${i}`,
    }));
    const store = { load: () => persisted, save: jest.fn() };

    const cache = new SwrCache(new FixedClock(at), 60_000, { store, maxEntries: 50 });

    expect(cache.size()).toBe(50);
    // The 50 newest must survive...
    expect(cache.peek("k0")).toBeDefined();
    expect(cache.peek("k49")).toBeDefined();
    // ...and the 10 oldest must be the ones dropped.
    expect(cache.peek("k50")).toBeUndefined();
    expect(cache.peek("k59")).toBeUndefined();
  });

  it("seeds from a store on construction so a restart serves without a fetch", async () => {
    const store = {
      load: () => [{ key: "artists:sonos", at: at.valueOf(), value: ["a", "b"] }],
      save: () => {},
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, { store });
    const f = deferredFetcher<string[]>();
    const got = await cache.get("artists:sonos", f.fetch);
    expect(got).toEqual(["a", "b"]); // from the seeded store
    expect(f.calls).toBe(0); // no fetch needed
  });

  it("persists each resolved value to the store", async () => {
    const saved: Array<{ key: string; at: number; value: unknown }> = [];
    const store = {
      load: () => [],
      save: (key: string, at2: number, value: unknown) =>
        saved.push({ key, at: at2, value }),
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, { store });
    const f = deferredFetcher<string>();
    const p = cache.get("k", f.fetch);
    f.resolve(0, "v");
    await p;
    await flush();
    expect(saved).toContainEqual({ key: "k", at: at.valueOf(), value: "v" });
  });

  it("seeds a stale persisted entry (served instantly) and revalidates on first access", async () => {
    const clock = new FixedClock(at);
    const store = {
      load: () => [{ key: "k", at: at.valueOf() - 100 * 60_000, value: "restored" }],
      save: () => {},
    };
    const cache = new SwrCache(clock, 60_000, { maxStaleMs: 5 * 60_000, store });
    const f = deferredFetcher<string>();
    const served = await cache.get("k", f.fetch); // stale seed served instantly...
    expect(served).toBe("restored");
    expect(f.calls).toBe(1); // ...and kicked a background refresh
    f.resolve(0, "fresh");
    await flush();
    expect(await cache.get("k", f.fetch)).toBe("fresh");
  });

  it("does not seed a persisted entry older than persistMaxAge", async () => {
    const store = {
      load: () => [{ key: "k", at: at.valueOf() - 8 * 24 * 60 * 60_000, value: "ancient" }],
      save: () => {},
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, {
      persistMaxAgeMs: 7 * 24 * 60 * 60_000,
      store,
    });
    const f = deferredFetcher<string>();
    const p = cache.get("k", f.fetch); // 8 days > 7-day cap -> cold fetch
    f.resolve(0, "fresh");
    expect(await p).toBe("fresh");
    expect(f.calls).toBe(1);
  });

  it("does not seed a persisted entry with a future or non-finite timestamp", async () => {
    const store = {
      load: () => [{ key: "future", at: at.valueOf() + 1_000_000, value: "future-val" }],
      save: () => {},
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, { store });
    const f = deferredFetcher<string>();
    const p = cache.get("future", f.fetch); // future timestamp not seeded -> cold fetch
    f.resolve(0, "fresh");
    expect(await p).toBe("fresh");
    expect(f.calls).toBe(1);
  });

  it("applies revive() to seeded values (e.g. to re-freeze)", async () => {
    const store = {
      load: () => [{ key: "k", at: at.valueOf(), value: { x: 1 } }],
      save: () => {},
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, {
      store,
      revive: (v) => Object.freeze(v as object),
    });
    const got = await cache.get("k", async () => ({ x: 999 }));
    expect(Object.isFrozen(got)).toBe(true);
  });

  it("does not seed from a store when disabled (ttl<=0)", async () => {
    const store = {
      load: () => [{ key: "k", at: at.valueOf(), value: "seeded" }],
      save: () => {},
    };
    const cache = new SwrCache(new FixedClock(at), 0, { store });
    const f = deferredFetcher<string>();
    const p = cache.get("k", f.fetch); // disabled -> always fetch
    f.resolve(0, "fetched");
    expect(await p).toBe("fetched");
  });

  it("peek() returns a settled value or undefined, and never triggers a fetch", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const f = deferredFetcher<string>();
    expect(cache.peek("k")).toBeUndefined(); // absent
    const p = cache.get("k", f.fetch); // in flight, not settled
    expect(cache.peek("k")).toBeUndefined(); // still no resolved value
    f.resolve(0, "v");
    await p;
    const peeked = cache.peek<string>("k");
    expect(peeked).toBeDefined();
    expect(await peeked!).toBe("v");
    expect(f.calls).toBe(1); // peek itself fetched nothing
  });

  it("backstop on a REFRESH does not admit a second concurrent fetch while the first still runs", async () => {
    // The backstop bounds how long a CALLER waits; it cannot abort the underlying work. The
    // rejection handler used to clear `inFlight`, so the next stale access started a SECOND fetch
    // while the first was still running - and so on, stacking indefinitely.
    //
    // Reachable rather than theoretical: the album index fetch is a full catalog scan (~15 min at
    // 107k albums) against a 20-minute backstop, and each pile-on is another full scan aimed at
    // Navidrome. Nothing awaits a promise here that is not guaranteed to settle.
    jest.useFakeTimers();
    const micro = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    try {
      const clock = new FixedClock(at);
      const cache = new SwrCache(clock, 60_000, { backstopMs: 1000, maxStaleMs: 60 * 60_000 });
      const f = deferredFetcher<string>();

      const first = cache.get("k", f.fetch);
      f.resolve(0, "v1");
      expect(await first).toBe("v1");
      expect(f.calls).toBe(1);

      // Stale -> kicks a background refresh (fetch #2) that we never settle.
      clock.add(2, "m");
      expect(await cache.get("k", f.fetch)).toBe("v1");
      expect(f.calls).toBe(2);

      // The refresh's backstop fires while fetch #2 is STILL RUNNING.
      jest.advanceTimersByTime(1001);
      await micro();

      // A further stale access must serve stale and must NOT start fetch #3.
      expect(await cache.get("k", f.fetch)).toBe("v1");
      await micro();
      expect(f.calls).toBe(2);

      // Once the real fetch finally settles, the key accepts refreshes again.
      f.resolve(1, "v2");
      await micro();
      clock.add(10, "m");
      void cache.get("k", f.fetch);
      await micro();
      expect(f.calls).toBe(3);
      f.resolve(2, "v3");
      await micro();
    } finally {
      jest.useRealTimers();
    }
  });

  it("backstop: a hung fetch rejects after backstopMs (and frees the key)", async () => {
    jest.useFakeTimers();
    try {
      const cache = new SwrCache(new FixedClock(at), 60_000, { backstopMs: 1000 });
      const hung = cache.get("k", () => new Promise(() => {})); // never settles
      const rejection = expect(hung).rejects.toThrow(/backstop|timed out/i);
      jest.advanceTimersByTime(1001);
      await rejection;
      // key freed -> a retry with a good fetch works
      const f = deferredFetcher<string>();
      const p = cache.get("k", f.fetch);
      f.resolve(0, "ok");
      expect(await p).toBe("ok");
    } finally {
      jest.useRealTimers();
    }
  });

  // peek() honours the same hard stale cap as get(): past maxStaleMs it reports nothing, so a
  // caller that falls back until warm does not consume ancient data. A mutant that loosens the
  // check (>= -> <) makes peek return the stale entry -> red.
  it("peek() returns undefined once the settled entry is past maxStaleMs (and never fetches)", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000, { maxStaleMs: 5 * 60_000 });
    const f = deferredFetcher<string>();
    await settle(cache, "k", f, "v");
    expect(cache.peek<string>("k")).toBeDefined();
    clock.add(5, "m"); // exactly past maxStale (5 * 60_000ms)
    expect(cache.peek("k")).toBeUndefined();
    expect(f.calls).toBe(1); // peek itself fetched nothing
  });

  // disabled() is a factory that must produce a TTL=0 cache (always calls through). A mutant that
  // changes the 0 -> e.g. 60_000 makes the second get a cache hit (f.calls stays 1) -> red.
  it("SwrCache.disabled() returns a pass-through cache (ttl<=0)", async () => {
    const cache = SwrCache.disabled();
    const f = deferredFetcher<number>();
    const p1 = cache.get("k", f.fetch);
    f.resolve(0, 1);
    expect(await p1).toBe(1);
    const p2 = cache.get("k", f.fetch);
    f.resolve(1, 2);
    expect(await p2).toBe(2);
    expect(f.calls).toBe(2);
  });

  // A cold fetch that resolves AFTER its entry was LRU-evicted must NOT be persisted over a newer
  // entry's store slot. The identity guard (line 183) is the only thing preventing that; drop it
  // and 'a' shows up in the store even though it was evicted before it resolved.
  it("does not persist a cold fetch that resolves after its entry was LRU-evicted", async () => {
    const saved: Array<{ key: string; value: unknown }> = [];
    const store = {
      load: () => [],
      save: (key: string, _at2: number, value: unknown) =>
        saved.push({ key, value }),
    };
    const cache = new SwrCache(new FixedClock(at), 60_000, {
      maxEntries: 1,
      store,
    });
    const fa = deferredFetcher<string>();
    const pa = cache.get("a", fa.fetch); // entry A in flight
    // Evict A by cold-fetching B (maxEntries:1 -> oldest 'a' evicted)
    const fb = deferredFetcher<string>();
    const pb = cache.get("b", fb.fetch);
    fb.resolve(0, "B");
    expect(await pb).toBe("B");
    // A resolves late; its success must be dropped (not persisted).
    fa.resolve(0, "A");
    await pa;
    await flush();
    expect(saved.find((e) => e.key === "a")).toBeUndefined();
    expect(saved.find((e) => e.key === "b")).toBeDefined();
  });

  // Symmetric to the above on the REJECTION side: a cold fetch that rejects after a NEW entry has
  // taken its key must not delete the replacement. The catch's identity guard (line 190) is what
  // prevents that; drop it and the late rejection of A evicts A2.
  it("does not delete a replacement entry when an earlier cold fetch under the same key later rejects", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000);
    const fa = deferredFetcher<string>();
    const pa = cache.get("a", fa.fetch); // entry A in flight
    cache.invalidate("a"); // drop A
    const fb = deferredFetcher<string>();
    const pb = cache.get("a", fb.fetch); // entry A2 now lives under 'a'
    fb.resolve(0, "A2");
    expect(await pb).toBe("A2");
    fa.reject(0, new Error("A failed")); // A rejects late; catch must spare A2
    await pa.catch(() => {}); // swallow the original caller's rejection
    await flush();
    expect(cache.peek<string>("a")).toBeDefined();
    expect(await cache.peek<string>("a")).toBe("A2");
  });
});

// helper: get + settle the just-issued fetch to a value
async function settle(
  cache: SwrCache,
  key: string,
  f: ReturnType<typeof deferredFetcher<string>>,
  v: string
) {
  const p = cache.get(key, f.fetch);
  f.resolve(f.calls - 1, v);
  return p;
}
