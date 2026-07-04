import dayjs from "dayjs";
import { FixedClock } from "../src/clock";
import { SwrCache } from "../src/swr_cache";

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
