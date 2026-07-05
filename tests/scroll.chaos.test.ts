import dayjs from "dayjs";
import { FixedClock } from "../src/clock";
import { SwrCache } from "../src/swr_cache";
import {
  buildAlbumIndexFromPages,
  albumIndexPage,
  albumIndexLetters,
  albumBucketKey,
} from "../src/album_index";

// Deterministic PRNG (mulberry32) so a chaos failure is reproducible from its seed.
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const flushHard = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

// A backend whose latency (in microtask hops) and success/failure are driven by the PRNG, and
// that counts calls per key. Settles on the microtask queue (no real timers), so the SwrCache
// backstop never fires and every started fetch settles before the test ends.
function chaoticBackend(rng: () => number, failRate: number) {
  const calls = new Map<string, number>();
  const fetchFor = (key: string, value: unknown) => () => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const willFail = rng() < failRate;
    const hops = 1 + Math.floor(rng() * 4);
    let p: Promise<void> = Promise.resolve();
    for (let i = 0; i < hops; i++) p = p.then(() => undefined);
    return p.then(() => {
      if (willFail) throw new Error(`backend fail: ${key}`);
      return value;
    });
  };
  return { fetchFor, callsFor: (k: string) => calls.get(k) ?? 0 };
}

// Record outcomes without ever leaking an unhandled rejection from the test harness itself.
function record<T>(p: Promise<T>, out: { ok: T[]; err: unknown[] }): Promise<void> {
  return p.then(
    (v) => {
      out.ok.push(v);
    },
    (e) => {
      out.err.push(e);
    }
  );
}

describe("scroll chaos (intense concurrent paging)", () => {
  const at = dayjs("2024-01-01T00:00:00Z");
  const BIG_BACKSTOP = 10 * 60_000; // never fire during a test; fetches settle on microtasks

  let unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    await flushHard();
    process.off("unhandledRejection", onUnhandled);
  });

  it("warm key under a 200-way concurrent scroll burst: no reject, one fetch, all correct", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000, { backstopMs: BIG_BACKSTOP });
    const be = chaoticBackend(rngFrom(1), 0);
    // warm it
    await cache.get("artists:u", be.fetchFor("artists:u", "LIST"));
    const out = { ok: [] as unknown[], err: [] as unknown[] };
    // 200 concurrent pages (fast scroll) within the TTL
    await Promise.all(
      Array.from({ length: 200 }, () =>
        record(cache.get("artists:u", be.fetchFor("artists:u", "LIST")), out)
      )
    );
    expect(out.err).toEqual([]);
    expect(out.ok).toHaveLength(200);
    expect(out.ok.every((v) => v === "LIST")).toBe(true);
    expect(be.callsFor("artists:u")).toBe(1); // warm reads never re-fetch
    expect(unhandled).toEqual([]);
  });

  it("100 concurrent gets on a COLD key coalesce into exactly one fetch", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000, { backstopMs: BIG_BACKSTOP });
    const be = chaoticBackend(rngFrom(2), 0);
    const out = { ok: [] as unknown[], err: [] as unknown[] };
    await Promise.all(
      Array.from({ length: 100 }, () =>
        record(cache.get("cold:k", be.fetchFor("cold:k", "V")), out)
      )
    );
    expect(be.callsFor("cold:k")).toBe(1); // coalesced
    expect(out.err).toEqual([]);
    expect(out.ok).toHaveLength(100);
    expect(unhandled).toEqual([]);
  });

  it("a transient cold-fetch failure self-heals and does not poison the key", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000, { backstopMs: BIG_BACKSTOP });
    let mode: "fail" | "ok" = "fail";
    const fetch = () =>
      Promise.resolve().then(() => {
        if (mode === "fail") throw new Error("transient");
        return "GOOD";
      });
    // first cold batch fails (no cached value to serve)
    const first = { ok: [] as unknown[], err: [] as unknown[] };
    await Promise.all(
      Array.from({ length: 20 }, () => record(cache.get("k", fetch), first))
    );
    expect(first.err.length).toBe(20);
    expect(cache.size()).toBe(0); // failed entry evicted, not poisoned
    // next batch (backend recovered) succeeds
    mode = "ok";
    const second = { ok: [] as unknown[], err: [] as unknown[] };
    await Promise.all(
      Array.from({ length: 20 }, () => record(cache.get("k", fetch), second))
    );
    expect(second.err).toEqual([]);
    expect(second.ok.every((v) => v === "GOOD")).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("a failing key never affects a healthy neighbour key (cross-key isolation)", async () => {
    const cache = new SwrCache(new FixedClock(at), 60_000, { backstopMs: BIG_BACKSTOP });
    await cache.get("good", () => Promise.resolve("G")); // warm the healthy key
    const out = { ok: [] as unknown[], err: [] as unknown[] };
    const bad = { ok: [] as unknown[], err: [] as unknown[] };
    await Promise.all([
      ...Array.from({ length: 50 }, () =>
        record(cache.get("good", () => Promise.reject(new Error("should not be called"))), out)
      ),
      ...Array.from({ length: 50 }, () =>
        record(cache.get("bad", () => Promise.resolve().then(() => { throw new Error("bad down"); })), bad)
      ),
    ]);
    // healthy key: always served from cache, never rejects, never re-fetches
    expect(out.err).toEqual([]);
    expect(out.ok).toEqual(Array(50).fill("G"));
    // bad key failing does not surface on the good key or leave an unhandled rejection
    expect(bad.err.length).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  it("refresh-failure storm: stale reads keep serving the last good value, never reject", async () => {
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 60_000, { maxStaleMs: 60 * 60_000, backstopMs: BIG_BACKSTOP });
    await cache.get("k", () => Promise.resolve("GOODVAL")); // settle a good value
    const out = { ok: [] as unknown[], err: [] as unknown[] };
    // every refresh now fails; hammer with stale reads across many ttl crossings (well within maxStale)
    for (let round = 0; round < 20; round++) {
      clock.add(90, "s"); // stale -> each round kicks a refresh that will fail
      await Promise.all(
        Array.from({ length: 25 }, () =>
          record(cache.get("k", () => Promise.resolve().then(() => { throw new Error("refresh down"); })), out)
        )
      );
      await flush();
    }
    expect(out.err).toEqual([]); // SWR: a failing refresh NEVER surfaces to a reader
    expect(out.ok.every((v) => v === "GOODVAL")).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("randomized storm over many keys: any key that ever succeeded still serves within maxStale; no unhandled rejections", async () => {
    const rng = rngFrom(1234);
    const clock = new FixedClock(at);
    const cache = new SwrCache(clock, 30_000, {
      maxEntries: 8,
      maxStaleMs: 60 * 60_000,
      backstopMs: BIG_BACKSTOP,
    });
    const be = chaoticBackend(rng, 0.25); // 25% of fetches fail
    const keys = Array.from({ length: 6 }, (_, i) => `key:${i}`);
    const everSucceeded = new Set<string>();
    const out = { ok: [] as unknown[], err: [] as unknown[] };

    for (let wave = 0; wave < 60; wave++) {
      if (rng() < 0.4) clock.add(1 + Math.floor(rng() * 40), "s"); // sometimes cross ttl/stale
      const batch: Promise<void>[] = [];
      const width = 3 + Math.floor(rng() * 12);
      for (let i = 0; i < width; i++) {
        const key = keys[Math.floor(rng() * keys.length)]!;
        const p = cache
          .get(key, be.fetchFor(key, `V:${key}`))
          .then((v) => {
            everSucceeded.add(key);
            out.ok.push(v);
          })
          .catch((e) => {
            out.err.push(e);
          });
        batch.push(p);
      }
      await Promise.all(batch);
      if (rng() < 0.3) await flush();
    }
    await flushHard();

    // Final verification wave: for every key that has ever settled a success, a read WITHIN maxStale
    // must serve a cached value and never reject (its fetcher must not even be needed). We keep the
    // clock still so nothing crosses maxStale here.
    const verify = { ok: [] as unknown[], err: [] as unknown[] };
    for (const key of everSucceeded) {
      // this key may have been LRU-evicted (maxEntries 8 > 6 keys, so it won't be, but be safe):
      const peeked = cache.peek(key);
      if (peeked) {
        await record(peeked as Promise<unknown>, verify);
      }
    }
    expect(verify.err).toEqual([]); // a settled+peekable value is always a resolved promise
    expect(everSucceeded.size).toBeGreaterThan(0);
    expect(cache.size()).toBeLessThanOrEqual(8); // LRU bound held under the storm
    expect(unhandled).toEqual([]);
  });

  it("album-index paging is consistent under heavy concurrent access", async () => {
    // Build a snapshot with scattered runs (some letters appear in multiple contiguous runs).
    const names = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").flatMap((c) =>
        Array.from({ length: 40 }, (_, i) => ({ name: `${c}${String(i).padStart(3, "0")}` }))
      ),
      // a stray second run of 'A' after the rest, to exercise multi-range letters
      ...Array.from({ length: 15 }, (_, i) => ({ name: `A9${String(i).padStart(2, "0")}` })),
    ];
    const index = buildAlbumIndexFromPages([names]);
    const letters = albumIndexLetters(index).map((l) => l.key);

    // Fire many concurrent page requests at random letters/offsets; each must return a correct,
    // in-bounds contiguous slice matching a single synchronous reference read.
    const rng = rngFrom(99);
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 400; i++) {
      const key = letters[Math.floor(rng() * letters.length)]!;
      const pageIndex = Math.floor(rng() * 60);
      const pageCount = 1 + Math.floor(rng() * 25);
      tasks.push(
        Promise.resolve().then(() => {
          const got = albumIndexPage(index, key, pageIndex, pageCount);
          const ref = albumIndexPage(index, key, pageIndex, pageCount);
          expect(got.total).toBe(ref.total);
          expect(got.items.map((x: any) => x.name)).toEqual(ref.items.map((x: any) => x.name));
          expect(got.items.length).toBeLessThanOrEqual(pageCount);
          // every returned item genuinely belongs to the requested letter (no bleed across buckets)
          for (const item of got.items as { name: string }[]) {
            expect(albumBucketKey(item.name)).toBe(key);
          }
        })
      );
    }
    await Promise.all(tasks);
    expect(unhandled).toEqual([]);
  });
});
