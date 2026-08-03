import { randomUUID as uuid } from "crypto";

import axios, { AxiosError } from "axios";
jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  get: jest.fn(),
  post: jest.fn(),
}));

import * as random from "../src/random";
jest.mock("../src/random");

import { URLBuilder } from "../src/url_builder";
import {
  Subsonic,
  t,
  asURLSearchParams,
  coverArtKey,
  CoverArtCoordinator,
  CoverArtBusyError,
  CoverArtUnavailableError,
  CoverArtUpstreamError,
  classifyCoverArtError,
  headerString,
  DEFAULT_COVER_ART_CONCURRENCY,
  DEFAULT_COVER_ART_QUEUE,
  DEFAULT_COVER_ART_QUEUE_TIMEOUT_MS,
  DEFAULT_COVER_ART_HTTP_TIMEOUT_MS,
} from "../src/subsonic";

// A deferred lets a test control exactly when a mocked upstream call settles, so the coordinator's
// real concurrency/coalescing/queue/timeout behaviour can be exercised deterministically.
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("CoverArtCoordinator options validation (constructor throws synchronously)", () => {
  it("uses a conservative default concurrency of 4 (no env var surface added)", () => {
    expect(DEFAULT_COVER_ART_CONCURRENCY).toBe(4);
    expect(DEFAULT_COVER_ART_QUEUE).toBeGreaterThan(0);
    expect(DEFAULT_COVER_ART_QUEUE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("accepts valid options", () => {
    expect(() => new CoverArtCoordinator({ maxConcurrency: 2, maxQueue: 3, queueTimeoutMs: 50 })).not.toThrow();
    // maxQueue 0 is valid and means "no queue".
    expect(() => new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 0, queueTimeoutMs: 50 })).not.toThrow();
  });

  it("rejects a non-positive-integer maxConcurrency", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "x" as unknown as number]) {
      expect(() => new CoverArtCoordinator({ maxConcurrency: bad })).toThrow(RangeError);
    }
  });

  it("rejects a negative or non-integer maxQueue", () => {
    for (const bad of [-1, 1.5, NaN]) {
      expect(() => new CoverArtCoordinator({ maxQueue: bad })).toThrow(RangeError);
    }
  });

  it("rejects a non-positive-finite-integer queueTimeoutMs", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new CoverArtCoordinator({ queueTimeoutMs: bad })).toThrow(RangeError);
    }
  });
});

describe("coverArtKey (privacy-safe unambiguous coalescing scope)", () => {
  // The key must distinguish ALL of: username, password, art id, and size. Length-prefixing makes
  // the hashed encoding collision-free across differing component boundaries.
  it("is identical for identical username/password/id/size", () => {
    expect(coverArtKey("u", "p", "art:1", 300)).toBe(coverArtKey("u", "p", "art:1", 300));
  });

  it("changes when the password changes (a credential rotation never shares a prior result)", () => {
    expect(coverArtKey("u", "p1", "art:1", 300)).not.toBe(coverArtKey("u", "p2", "art:1", 300));
  });

  it("changes when the username changes", () => {
    expect(coverArtKey("u1", "p", "art:1", 300)).not.toBe(coverArtKey("u2", "p", "art:1", 300));
  });

  it("changes when the art id changes", () => {
    expect(coverArtKey("u", "p", "art:1", 300)).not.toBe(coverArtKey("u", "p", "art:2", 300));
  });

  it("changes when the size changes", () => {
    expect(coverArtKey("u", "p", "art:1", 300)).not.toBe(coverArtKey("u", "p", "art:1", 600));
  });

  it("does not contain the raw username, password, or art id (opaque digest only)", () => {
    const key = coverArtKey("user-secret", "pass-secret", "art:secret-id", 300);
    expect(key).toMatch(/^[0-9a-f]+$/);
    expect(key).not.toContain("user-secret");
    expect(key).not.toContain("pass-secret");
    expect(key).not.toContain("secret-id");
    expect(key).not.toContain("art");
  });

  it("cannot be fooled by component-boundary collisions (length-prefixed encoding)", () => {
    // Without length-prefixing, ("ab","c") and ("a","bc") would hash identically.
    expect(coverArtKey("ab", "p", "c", 0)).not.toBe(coverArtKey("a", "p", "bc", 0));
    // size normalized into the scope too
    expect(coverArtKey("u", "p", "art:1", undefined)).toBe(coverArtKey("u", "p", "art:1", 0));
  });
});

describe("CoverArtCoordinator coalescing + concurrency", () => {
  it("coalesces identical in-flight requests into a single upstream call", async () => {
    const task = jest.fn(() => Promise.resolve(Buffer.from("bytes-a")));
    const coord = new CoverArtCoordinator();
    const key = coverArtKey("u", "p", "art:1", 300);

    const [ra, rb] = await Promise.all([
      coord.run(key, task),
      coord.run(key, task),
    ]);

    expect(task).toHaveBeenCalledTimes(1);
    expect(ra.equals(Buffer.from("bytes-a"))).toBe(true);
    expect(rb.equals(Buffer.from("bytes-a"))).toBe(true);
  });

  it("does NOT coalesce distinct credentials / ids / sizes", async () => {
    const task = jest.fn(() => Promise.resolve(Buffer.from("x")));
    const coord = new CoverArtCoordinator();

    await Promise.all([
      coord.run(coverArtKey("u1", "p", "art:1", 300), task),
      coord.run(coverArtKey("u2", "p", "art:1", 300), task),
      coord.run(coverArtKey("u1", "p2", "art:1", 300), task),
      coord.run(coverArtKey("u1", "p", "art:2", 300), task),
      coord.run(coverArtKey("u1", "p", "art:1", 600), task),
    ]);

    expect(task).toHaveBeenCalledTimes(5);
  });

  it("caps concurrently active upstream calls at maxConcurrency (no over-subscription)", async () => {
    const maxConcurrency = 2;
    let active = 0;
    let peak = 0;
    const inflight: ReturnType<typeof deferred<void>>[] = [];

    const task = () => {
      active += 1;
      peak = Math.max(peak, active);
      const d = deferred<void>();
      inflight.push(d);
      return d.promise.then(() => {
        active -= 1;
        return Buffer.from("x");
      });
    };

    const coord = new CoverArtCoordinator({ maxConcurrency, maxQueue: 10, queueTimeoutMs: 5000 });
    const keys = ["k1", "k2", "k3", "k4", "k5"].map((k) => coverArtKey("u", "p", k, 100));
    const all = keys.map((k) => coord.run(k, task));

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(maxConcurrency);
    expect(inflight.length).toEqual(maxConcurrency);

    while (inflight.length > 0) {
      const next = inflight.shift();
      next!.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(peak).toBeLessThanOrEqual(maxConcurrency);
    }

    const results = await Promise.all(all);
    expect(results.length).toBe(keys.length);
  });

  it("serves the queue in strict FIFO order as active slots free up", async () => {
    const maxConcurrency = 1;
    const inflight: ReturnType<typeof deferred<void>>[] = [];
    const started: string[] = [];

    const coord = new CoverArtCoordinator({ maxConcurrency, maxQueue: 10, queueTimeoutMs: 5000 });

    const taskFor = (label: string) => () => {
      started.push(label);
      const d = deferred<void>();
      inflight.push(d);
      return d.promise.then(() => Buffer.from(label));
    };

    const all = [
      coord.run(coverArtKey("u", "p", "fifo-1", 1), taskFor("1")),
      coord.run(coverArtKey("u", "p", "fifo-2", 2), taskFor("2")),
      coord.run(coverArtKey("u", "p", "fifo-3", 3), taskFor("3")),
    ];

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["1"]);

    inflight.shift()!.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["1", "2"]);

    inflight.shift()!.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["1", "2", "3"]);

    inflight.shift()!.resolve(undefined);
    const results = await Promise.all(all);
    expect(results.map((b) => b.toString("utf8"))).toEqual(["1", "2", "3"]);
  });

  it("with maxQueue=0 rejects immediately when all slots are busy (no queueing at all)", async () => {
    const block = deferred<void>();
    const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 0, queueTimeoutMs: 5000 });

    const running = coord.run(coverArtKey("u", "p", "block", 1), () => block.promise.then(() => Buffer.from("x")));
    await Promise.resolve();
    await Promise.resolve();

    const over = coord.run(coverArtKey("u", "p", "over", 2), () => Promise.resolve(Buffer.from("o")));
    await expect(over).rejects.toBeInstanceOf(CoverArtBusyError);

    block.resolve(undefined);
    await running;
  });

  it("rejects with a classifiable CoverArtBusyError when the queue is full (bounded, not unbounded)", async () => {
    const block = deferred<void>();
    const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: 5000 });

    const running = coord.run(coverArtKey("u", "p", "block", 1), () => block.promise.then(() => Buffer.from("x")));
    await Promise.resolve();
    await Promise.resolve();

    // Fills the single queue slot.
    const queued = coord.run(coverArtKey("u", "p", "queued", 2), () => Promise.resolve(Buffer.from("q")));
    queued.catch(() => {}); // avoid unhandled-rejection noise if it never settles here

    // Third distinct request: queue is full -> reject immediately.
    const over = coord.run(coverArtKey("u", "p", "over", 3), () => Promise.resolve(Buffer.from("o")));
    await expect(over).rejects.toBeInstanceOf(CoverArtBusyError);

    block.resolve(undefined);
    await Promise.allSettled([running, queued]);
  });

  it("rejects with a classifiable CoverArtBusyError when a queued request exceeds its bounded wait deadline", async () => {
    jest.useFakeTimers();
    try {
      const queueTimeoutMs = 1000;
      const block = deferred<void>();
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 5, queueTimeoutMs });

      // Slot held for the whole test; the queued request must wait until its deadline, then reject.
      coord.run(coverArtKey("u", "p", "block", 1), () => block.promise.then(() => Buffer.from("x")));
      const queued = coord.run(coverArtKey("u", "p", "queued", 2), () => Promise.resolve(Buffer.from("q")));

      jest.advanceTimersByTime(queueTimeoutMs + 1);
      await expect(queued).rejects.toBeInstanceOf(CoverArtBusyError);

      // The timed-out entry is dropped from the queue so the slot frees correctly: free the held
      // slot and confirm the coordinator drains to zero active (a fresh request runs immediately).
      block.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();

      const fresh = coord.run(coverArtKey("u", "p", "fresh", 3), () => Promise.resolve(Buffer.from("fresh")));
      await expect(fresh).resolves.toEqual(Buffer.from("fresh"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("never produces an unhandled rejection under fake timers when a queued request times out", async () => {
    // The earlier (impossible) queue-timeout test expected a fresh request to run while the sole
    // blocking slot was still held. This replaces it: under fake timers the timed-out queued
    // promise must reject cleanly with NO unhandled-rejection, and no slot/map leak.
    jest.useFakeTimers();
    const onUnhandled = jest.fn();
    const handler = (reason?: unknown) => onUnhandled(reason);
    process.on("unhandledRejection", handler);
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 5, queueTimeoutMs: 1000 });
      // Slot held forever; queued request waits, then times out.
      const neverSettles = coord.run(coverArtKey("u", "p", "hold", 1), () => new Promise<Buffer>(() => {}));
      neverSettles.catch(() => {});
      const queued = coord.run(coverArtKey("u", "p", "queued", 2), () => Promise.resolve(Buffer.from("q")));

      jest.advanceTimersByTime(1001);
      await expect(queued).rejects.toBeInstanceOf(CoverArtBusyError);
      // Flush any pending microtasks/timers.
      await Promise.resolve();
      await Promise.resolve();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", handler);
      jest.useRealTimers();
    }
  });

  it("releases the in-flight entry after a resolve (fresh same-key request starts a fresh call)", async () => {
    const task = jest.fn(() => Promise.resolve(Buffer.from("ok")));
    const coord = new CoverArtCoordinator();
    const key = coverArtKey("u", "p", "release-ok", 1);
    await coord.run(key, task);
    await coord.run(key, task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight entry and slot after an axios-style reject", async () => {
    const axiosErr = Object.assign(new Error("boom"), {
      isAxiosError: true,
      response: { status: 503, data: Buffer.from("") },
    });
    let calls = 0;
    const task = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(axiosErr) : Promise.resolve(Buffer.from("ok"));
    };
    const coord = new CoverArtCoordinator();
    const key = coverArtKey("u", "p", "release-err", 1);
    await expect(coord.run(key, task)).rejects.toBe(axiosErr);
    await expect(coord.run(key, task)).resolves.toEqual(Buffer.from("ok"));
  });

  it("releases the in-flight entry and slot after a synchronous throw", async () => {
    let calls = 0;
    const task = () => {
      calls += 1;
      if (calls === 1) throw new Error("sync boom");
      return Promise.resolve(Buffer.from("ok"));
    };
    const coord = new CoverArtCoordinator();
    const key = coverArtKey("u", "p", "release-sync", 1);
    await expect(coord.run(key, task)).rejects.toThrow("sync boom");
    await expect(coord.run(key, task)).resolves.toEqual(Buffer.from("ok"));
  });

  it("does NOT retry the upstream task on a 429/5xx reject (one failure is terminal)", async () => {
    const task = jest.fn(() => Promise.reject(
      Object.assign(new Error("throttled"), { isAxiosError: true, response: { status: 429 } })
    ));
    const coord = new CoverArtCoordinator();
    await expect(coord.run(coverArtKey("u", "p", "no-retry", 1), task)).rejects.toBeDefined();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("frees the slot when a QUEUED task rejects after being handed a freed slot", async () => {
    // The inherited-slot path (onSettled -> startTask(next.task) -> result.then(resolve, reject)
    // AND result.then(onSettled, onSettled)) releases the active count on a queued-task REJECT,
    // not only on resolve. Without that reject arm a queued failure would leak the slot and the
    // coordinator would deadlock once every slot had been handed to a failing queued task.
    const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 4, queueTimeoutMs: 5000 });

    const block = deferred<void>();
    const started: string[] = [];

    // First task occupies the only slot.
    const running = coord.run(
      coverArtKey("u", "p", "hold", 1),
      () => {
        started.push("hold");
        return block.promise.then(() => Buffer.from("hold"));
      }
    );

    // Second task queues; it will REJECT once handed the slot.
    const queuedReject = new Error("queued boom");
    const queued = coord.run(
      coverArtKey("u", "p", "queued", 1),
      () => {
        started.push("queued");
        return Promise.reject(queuedReject);
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["hold"]);

    // Release the held slot -> the queued task runs and rejects.
    block.resolve(undefined);
    await expect(running).resolves.toEqual(Buffer.from("hold"));
    await expect(queued).rejects.toBe(queuedReject);

    // The slot must be free again: a fresh distinct request runs IMMEDIATELY (no queue wait),
    // proving the rejected queued task released it.
    const fresh = coord.run(
      coverArtKey("u", "p", "fresh", 1),
      () => {
        started.push("fresh");
        return Promise.resolve(Buffer.from("fresh"));
      }
    );
    await expect(fresh).resolves.toEqual(Buffer.from("fresh"));
    expect(started).toEqual(["hold", "queued", "fresh"]);
  });
});

describe("CoverArtCoordinator admission control (never promise a wait it cannot honour)", () => {
  // Production regime (measured on the VPS): Navidrome runs with ND_DEVARTWORKMAXREQUESTS=10 and
  // ND_DEVARTWORKTHROTTLEBACKLOGTIMEOUT=5s, so with a cold image cache or a stalled music mount a
  // single getCoverArt routinely takes longer than the coordinator's own queue deadline.
  //
  // When that happens a queued request provably CANNOT be served before its deadline, yet the
  // queue still admits it and makes it wait the full deadline before rejecting. That is the worst
  // of both outcomes - latency AND failure - and it pins an Express handler plus a Sonos socket for
  // the whole wait to deliver a 503 that was knowable at admission time. Admission must be decided
  // from observed latency, not discovered after the fact.
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("rejects immediately once observed latency proves the queue cannot drain within the deadline", async () => {
    jest.useFakeTimers();
    try {
      const queueTimeoutMs = 1000;
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs });
      const slowTask = (v: string) => () =>
        new Promise<Buffer>((res) => setTimeout(() => res(Buffer.from(v)), 2000));

      // Observe a SUSTAINED slot hold of 2s, i.e. twice the queue deadline. A single sample is
      // deliberately not enough for the estimator to act on.
      for (let i = 0; i < 8; i++) {
        const seed = coord.run(coverArtKey("u", "p", `seed-${i}`, 1), slowTask(`seed-${i}`));
        jest.advanceTimersByTime(2000);
        await expect(seed).resolves.toEqual(Buffer.from(`seed-${i}`));
      }

      // Re-occupy the only slot with another 2s call.
      const held = coord.run(coverArtKey("u", "p", "held", 1), slowTask("held"));

      // A request queued behind `held` would wait ~2s, but its deadline is 1s. It must reject NOW,
      // with no timer advanced at all - not after burning the full 1s wait.
      const doomed = coord.run(coverArtKey("u", "p", "doomed", 1), () =>
        Promise.resolve(Buffer.from("never"))
      );
      const onRejected = jest.fn();
      doomed.catch(onRejected);
      await flush();

      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(onRejected.mock.calls[0]![0]).toBeInstanceOf(CoverArtBusyError);

      jest.advanceTimersByTime(2000);
      await expect(held).resolves.toEqual(Buffer.from("held"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("still queues normally when observed latency leaves room inside the deadline", async () => {
    jest.useFakeTimers();
    try {
      const queueTimeoutMs = 1000;
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs });
      const fastTask = (v: string) => () =>
        new Promise<Buffer>((res) => setTimeout(() => res(Buffer.from(v)), 100));

      const seed = coord.run(coverArtKey("u", "p", "seed", 1), fastTask("seed"));
      jest.advanceTimersByTime(100);
      await expect(seed).resolves.toEqual(Buffer.from("seed"));

      // A 100ms observed latency means one turnover costs 100ms, well inside the 1s deadline, so a
      // queued request must NOT be rejected at admission - the guard only engages under degradation.
      const held = coord.run(coverArtKey("u", "p", "held", 1), fastTask("held"));
      const queued = coord.run(coverArtKey("u", "p", "queued", 1), fastTask("queued"));
      const onRejected = jest.fn();
      queued.catch(onRejected);
      await flush();
      expect(onRejected).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      await expect(held).resolves.toEqual(Buffer.from("held"));
      jest.advanceTimersByTime(100);
      await expect(queued).resolves.toEqual(Buffer.from("queued"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("admits normally before any latency has been observed (no cold-start false rejection)", async () => {
    const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 8, queueTimeoutMs: 1000 });
    const block = deferred<Buffer>();
    const held = coord.run(coverArtKey("u", "p", "held", 1), () => block.promise);
    const queued = coord.run(coverArtKey("u", "p", "queued", 1), () =>
      Promise.resolve(Buffer.from("q"))
    );
    const onRejected = jest.fn();
    queued.catch(onRejected);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRejected).not.toHaveBeenCalled();

    block.resolve(Buffer.from("held"));
    await expect(held).resolves.toEqual(Buffer.from("held"));
    await expect(queued).resolves.toEqual(Buffer.from("q"));
  });
});

describe("CoverArtCoordinator admission control - adversarial edges", () => {
  // Seeds the latency EWMA with exactly one observation. The first sample sets the average
  // outright, so the estimate afterwards is exact and the boundaries below are not approximate.
  const seedLatency = async (coord: CoverArtCoordinator, ms: number, key = "seed") => {
    const p = coord.run(coverArtKey("u", "p", key, 1), () =>
      new Promise<Buffer>((res) => setTimeout(() => res(Buffer.from(key)), ms))
    );
    jest.advanceTimersByTime(ms);
    await expect(p).resolves.toEqual(Buffer.from(key));
  };

  // The estimator only engages once it has enough evidence, so seed a full window of observations.
  const seedSteadyLatency = async (coord: CoverArtCoordinator, ms: number, n = 8) => {
    for (let i = 0; i < n; i++) await seedLatency(coord, ms, `steady-${ms}-${i}`);
  };

  // Occupies a slot until released. Every real slot hold is bounded by the cover-art http timeout,
  // so a slot is never held indefinitely in production - see the recovery test below, which depends
  // on that invariant.
  const hold = (coord: CoverArtCoordinator, key: string) => {
    let release!: (v: Buffer) => void;
    const p = coord.run(coverArtKey("u", "p", key, 1), () =>
      new Promise<Buffer>((res) => {
        release = res;
      })
    );
    p.catch(() => {});
    return { promise: p, release: () => release(Buffer.from(key)) };
  };

  const settledState = async (p: Promise<unknown>) => {
    const state = { rejected: false, error: undefined as unknown };
    p.catch((e) => {
      state.rejected = true;
      state.error = e;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return state;
  };

  it("a single slow outlier does not collapse an otherwise healthy queue", async () => {
    // The estimator was an EWMA with alpha 0.3, and the field comment claimed one outlier could not
    // start rejecting a healthy queue. That was false. With a healthy 50ms average, ONE art fetch
    // that stalls to the 10s http bound moved the average to ~3035ms, which at concurrency 4 and a
    // 5s deadline collapses the admissible queue from 64 to 4; a second outlier took it to 0. The
    // upstream would be answering in 50ms again while Sonos got 503s. A robust statistic is
    // required, not a faster-decaying average.
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 4, maxQueue: 64, queueTimeoutMs: 5000 });
      await seedSteadyLatency(coord, 50);

      // One pathological sample at the cover-art http bound.
      await seedLatency(coord, 10_000, "outlier");

      // Fill every slot, then queue well past where a collapsed estimator would start refusing.
      const held = [0, 1, 2, 3].map((i) => hold(coord, `held-${i}`));
      const queued = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        coord.run(coverArtKey("u", "p", `q${i}`, 1), () => Promise.resolve(Buffer.from("x")))
      );
      const states = await Promise.all(queued.map((q) => settledState(q)));

      expect(states.filter((s) => s.rejected)).toHaveLength(0);
      held.forEach((h) => h.release());
    } finally {
      jest.useRealTimers();
    }
  });

  it("stays dormant until it has enough samples to be worth trusting", async () => {
    // A single cold first fetch used to be adopted as the estimate outright, so one slow start
    // could gate the queue before anything was really known about the upstream.
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedLatency(coord, 30_000, "one-slow-cold-start");

      hold(coord, "held");
      const queued = coord.run(coverArtKey("u", "p", "after-one", 1), () =>
        Promise.resolve(Buffer.from("x"))
      );
      expect((await settledState(queued)).rejected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("still engages under SUSTAINED degradation, not just a spike", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 4000);

      hold(coord, "held");
      const queued = coord.run(coverArtKey("u", "p", "doomed", 1), () =>
        Promise.resolve(Buffer.from("x"))
      );
      const state = await settledState(queued);
      expect(state.rejected).toBe(true);
      expect(state.error).toBeInstanceOf(CoverArtBusyError);
    } finally {
      jest.useRealTimers();
    }
  });

  it("admits when the estimated wait exactly equals the deadline (strict >, not >=)", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 1000);
      hold(coord, "held");

      // ceil(1/1) * 1000 = 1000, which is not greater than the 1000ms deadline. A request that
      // might just make it is given its chance rather than pre-emptively failed.
      const queued = coord.run(coverArtKey("u", "p", "edge", 1), () => Promise.resolve(Buffer.from("x")));
      const state = await settledState(queued);
      expect(state.rejected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects when the estimated wait is one millisecond over the deadline", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 1001);
      hold(coord, "held");

      const queued = coord.run(coverArtKey("u", "p", "over", 1), () => Promise.resolve(Buffer.from("x")));
      const state = await settledState(queued);
      expect(state.rejected).toBe(true);
      expect(state.error).toBeInstanceOf(CoverArtBusyError);
    } finally {
      jest.useRealTimers();
    }
  });

  it("counts queue position in turnovers of maxConcurrency, not one turnover per waiter", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 2, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 600);
      hold(coord, "held-1");
      hold(coord, "held-2");

      // With 2 slots and a 600ms turnover: positions 0 and 1 are both served in the first
      // turnover (600ms, admitted); position 2 needs a second turnover (1200ms > 1000, rejected).
      const q1 = coord.run(coverArtKey("u", "p", "q1", 1), () => Promise.resolve(Buffer.from("1")));
      const q2 = coord.run(coverArtKey("u", "p", "q2", 1), () => Promise.resolve(Buffer.from("2")));
      const q3 = coord.run(coverArtKey("u", "p", "q3", 1), () => Promise.resolve(Buffer.from("3")));

      expect((await settledState(q1)).rejected).toBe(false);
      expect((await settledState(q2)).rejected).toBe(false);
      const third = await settledState(q3);
      expect(third.rejected).toBe(true);
      expect(third.error).toBeInstanceOf(CoverArtBusyError);
    } finally {
      jest.useRealTimers();
    }
  });

  it("never rejects a request that can start immediately, however bad the observed latency", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 2, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 60_000);

      // Admission control gates QUEUEING only. A free slot must always be used - otherwise a single
      // bad sample would stop the coordinator doing any work at all, and no new samples would ever
      // be observed to correct it.
      const immediate = coord.run(coverArtKey("u", "p", "free-slot", 1), () =>
        Promise.resolve(Buffer.from("ok"))
      );
      await expect(immediate).resolves.toEqual(Buffer.from("ok"));
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers on its own after degradation, because active calls keep supplying samples", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });
      await seedSteadyLatency(coord, 5000);

      // Degraded: queueing is refused.
      const blocked = hold(coord, "held");
      const refused = coord.run(coverArtKey("u", "p", "refused", 1), () => Promise.resolve(Buffer.from("x")));
      expect((await settledState(refused)).rejected).toBe(true);

      // The in-flight call finishes - which it always does within SUBSONIC_COVER_ART_HTTP_TIMEOUT_MS,
      // the invariant this recovery depends on. Once a slot is free the guard cannot block it, so
      // fast calls run and, once they are the MAJORITY of the window, move the median and reopen the
      // queue unaided. Without that bound on slot-hold time a permanently hung upstream would starve
      // the estimator and the guard would stay shut, so the http timeout is load-bearing here.
      blocked.release();
      await blocked.promise;
      for (let i = 0; i < 12; i++) {
        await seedLatency(coord, 50, `fast-${i}`);
      }

      hold(coord, "held-again");
      const admitted = coord.run(coverArtKey("u", "p", "admitted", 1), () => Promise.resolve(Buffer.from("y")));
      expect((await settledState(admitted)).rejected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats a slow FAILURE as a latency sample too (it consumed the slot just the same)", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 1000 });

      for (let i = 0; i < 8; i++) {
        const failing = coord.run(coverArtKey("u", "p", `slow-fail-${i}`, 1), () =>
          new Promise<Buffer>((_, rej) => setTimeout(() => rej(new Error("upstream")), 4000))
        );
        failing.catch(() => {});
        jest.advanceTimersByTime(4000);
        await expect(failing).rejects.toBeDefined();
      }

      // A run of 4s failures is evidence the upstream is slow, not evidence it is fast.
      hold(coord, "held");
      const queued = coord.run(coverArtKey("u", "p", "after-fail", 1), () => Promise.resolve(Buffer.from("x")));
      expect((await settledState(queued)).rejected).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps admitted requests in FIFO order - the guard sheds the tail, never reorders the head", async () => {
    jest.useFakeTimers();
    try {
      const coord = new CoverArtCoordinator({ maxConcurrency: 1, maxQueue: 64, queueTimeoutMs: 5000 });
      await seedSteadyLatency(coord, 100);

      const started: string[] = [];
      const inflight: Array<(v: Buffer) => void> = [];
      const taskFor = (label: string) => () => {
        started.push(label);
        return new Promise<Buffer>((res) => inflight.push(res));
      };

      const a = coord.run(coverArtKey("u", "p", "a", 1), taskFor("a"));
      const b = coord.run(coverArtKey("u", "p", "b", 1), taskFor("b"));
      const c = coord.run(coverArtKey("u", "p", "c", 1), taskFor("c"));
      [a, b, c].forEach((p) => p.catch(() => {}));

      await Promise.resolve();
      expect(started).toEqual(["a"]);

      inflight.shift()!(Buffer.from("a"));
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toEqual(["a", "b"]);

      inflight.shift()!(Buffer.from("b"));
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toEqual(["a", "b", "c"]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("headerString (axios >= 1.19 header values are not plain strings)", () => {
  it("passes a plain string through", () => {
    expect(headerString("image/png")).toEqual("image/png");
  });

  it("treats an absent header as undefined, not the string 'undefined'", () => {
    expect(headerString(undefined)).toBeUndefined();
    expect(headerString(null)).toBeUndefined();
  });

  it("takes the first value of a repeated header", () => {
    expect(headerString(["image/png", "image/jpeg"])).toEqual("image/png");
  });

  it("treats an empty repeated header as absent", () => {
    expect(headerString([])).toBeUndefined();
  });

  it("stringifies a numeric header (content-length arrives as a number)", () => {
    expect(headerString(1234)).toEqual("1234");
  });
});

describe("classifyCoverArtError (honest explicit union)", () => {
  const axiosErr = (status: number | undefined, code?: string) => {
    const e = new AxiosError(
      status != undefined ? `Request failed with status code ${status}` : code || "network error",
      code,
      undefined,
      undefined,
      status != undefined ? { status, data: Buffer.from("") } as any : undefined,
    );
    return e;
  };

  it("classifies a real 404 AxiosError as absent", () => {
    expect(classifyCoverArtError(axiosErr(404))).toBe("absent");
  });

  it("classifies 429 and 5xx as transient", () => {
    expect(classifyCoverArtError(axiosErr(429))).toBe("transient");
    expect(classifyCoverArtError(axiosErr(500))).toBe("transient");
    expect(classifyCoverArtError(axiosErr(503))).toBe("transient");
  });

  it("classifies transport/timeout (no response, ECONNABORTED) as transient", () => {
    expect(classifyCoverArtError(axiosErr(undefined, "ECONNABORTED"))).toBe("transient");
    expect(classifyCoverArtError(new AxiosError("net", "ENOTFOUND"))).toBe("transient");
  });

  it("classifies 400/401/403 as other (never absent/transient)", () => {
    expect(classifyCoverArtError(axiosErr(400))).toBe("other");
    expect(classifyCoverArtError(axiosErr(401))).toBe("other");
    expect(classifyCoverArtError(axiosErr(403))).toBe("other");
  });

  it("classifies CoverArtUnavailableError (incl. busy) as transient", () => {
    expect(classifyCoverArtError(new CoverArtUnavailableError())).toBe("transient");
    expect(classifyCoverArtError(new CoverArtBusyError("full"))).toBe("transient");
  });

  it("classifies any other value as other (never absent)", () => {
    expect(classifyCoverArtError(new CoverArtUpstreamError("other"))).toBe("other");
    expect(classifyCoverArtError("BOOOM")).toBe("other");
    expect(classifyCoverArtError(undefined)).toBe("other");
  });
});

describe("Subsonic.getCoverArt (bounded timeout + coordinator wiring)", () => {
  const url = new URLBuilder("http://127.0.0.22:4567/some-context-path");
  const username = `usercov-${uuid()}`;
  const password = `passcov-${uuid()}`;
  const credentials = { username, password };
  const salt = "saltysalty";
  const mockRandomstring = jest.fn();
  const mockGET = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
    (random.generateRandomString as jest.Mock) = mockRandomstring;
    axios.get = mockGET;
    mockRandomstring.mockReturnValue(salt);
  });

  const authParams = {
    u: username,
    v: "1.16.1",
    c: "bonob",
    t: t(password, salt),
    s: salt,
  };
  const headers = { "User-Agent": "bonob" };

  // The coalescing key and the upstream request must agree on the size, or two calls that ask the
  // server for DIFFERENT things can share one key and whichever starts first serves both. The key
  // mapped any non-positive size to 0 while the request still sent the raw value, so
  // getCoverArt(id, -5) and getCoverArt(id) collided. /art rejects size <= 0 today, so this was
  // latent rather than live - but the coordinator must not depend on a caller-side guard to be
  // correct, and getCoverArt is public API reachable from elsewhere.
  describe("size normalization is shared by the key and the request", () => {
    // Compare the params EXPLICITLY by their entries. `expect.objectContaining({ params })` does
    // NOT compare URLSearchParams contents - it passes against completely different params - so an
    // assertion written that way is vacuous. (A bare object argument does compare correctly; it is
    // objectContaining specifically that is blind here.)
    const sentParams = (call: unknown[]) =>
      [...((call[1] as { params: URLSearchParams }).params).entries()].sort();

    const expectedParams = (extra: Record<string, string> = {}) =>
      [...asURLSearchParams({ ...authParams, id: "art:42", ...extra }).entries()].sort();

    it.each([
      ["a negative size", -5],
      ["zero", 0],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ])("treats %s as 'no size' in the request, matching the key", async (_label, size) => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          data: Buffer.from("img"),
        })
      );

      await new Subsonic(url).getCoverArt(credentials, "art:42", size as number);

      // No size parameter at all - exactly what the key encodes for these values.
      expect(sentParams(mockGET.mock.calls[0]!)).toEqual(expectedParams());
    });

    it("sends a positive size unchanged", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          data: Buffer.from("img"),
        })
      );

      await new Subsonic(url).getCoverArt(credentials, "art:42", 300);

      expect(sentParams(mockGET.mock.calls[0]!)).toEqual(expectedParams({ size: "300" }));
    });

    it("coalesces a non-positive size with an absent size, since both fetch the same thing", async () => {
      const subsonic = new Subsonic(url);
      const block = deferred<void>();
      mockGET.mockImplementation(() =>
        block.promise.then(() => ({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          data: Buffer.from("img"),
        }))
      );

      const a = subsonic.getCoverArt(credentials, "art:42", -5);
      const b = subsonic.getCoverArt(credentials, "art:42");
      await Promise.resolve();

      expect(mockGET).toHaveBeenCalledTimes(1);

      block.resolve(undefined);
      await Promise.all([a, b]);
    });

    it("still distinguishes two DIFFERENT positive sizes", async () => {
      const subsonic = new Subsonic(url);
      const block = deferred<void>();
      mockGET.mockImplementation(() =>
        block.promise.then(() => ({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          data: Buffer.from("img"),
        }))
      );

      const a = subsonic.getCoverArt(credentials, "art:42", 180);
      const b = subsonic.getCoverArt(credentials, "art:42", 300);
      await Promise.resolve();

      expect(mockGET).toHaveBeenCalledTimes(2);

      block.resolve(undefined);
      await Promise.all([a, b]);
    });
  });

  it("sends the cover-art http timeout (shorter than the global 30s) while preserving headers/params/arraybuffer", async () => {
    mockGET.mockImplementationOnce(() =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "image/jpeg" },
        data: Buffer.from("img"),
      })
    );

    await new Subsonic(url).getCoverArt(credentials, "art:42", 300);

    expect(axios.get).toHaveBeenCalledWith(
      url.append({ pathname: "/rest/getCoverArt" }).href(),
      {
        params: asURLSearchParams({ ...authParams, id: "art:42", size: 300 }),
        headers,
        responseType: "arraybuffer",
        timeout: DEFAULT_COVER_ART_HTTP_TIMEOUT_MS,
      }
    );
  });

  it("coalesces two concurrent identical getCoverArt calls into a single upstream fetch", async () => {
    const seenIds: string[] = [];
    mockGET.mockImplementation((_href: string, config: any) => {
      seenIds.push(config.params.get("id"));
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "image/png" },
        data: Buffer.from("shared"),
      });
    });

    const subsonic = new Subsonic(url);
    const [a, b] = await Promise.all([
      subsonic.getCoverArt(credentials, "art:coalesce", 200),
      subsonic.getCoverArt(credentials, "art:coalesce", 200),
    ]);

    expect(seenIds).toEqual(["art:coalesce"]);
    expect(Buffer.from(a.data, "binary").toString()).toBe("shared");
    expect(Buffer.from(b.data, "binary").toString()).toBe("shared");
  });

  it("does not coalesce across different credentials (changed password = separate fetch)", async () => {
    const seenIds: string[] = [];
    mockGET.mockImplementation((_href: string, config: any) => {
      seenIds.push(config.params.get("id") + ":" + config.params.get("u"));
      return Promise.resolve({ status: 200, headers: { "content-type": "image/png" }, data: Buffer.from("x") });
    });
    const subsonic = new Subsonic(url);
    await Promise.all([
      subsonic.getCoverArt({ username, password }, "art:same", 200),
      subsonic.getCoverArt({ username, password: "different" }, "art:same", 200),
    ]);
    expect(seenIds.length).toBe(2);
  });

  it("produces exactly one upstream call for a single 429 (no hidden retry)", async () => {
    mockGET.mockImplementation(() =>
      Promise.reject(Object.assign(new AxiosError("429"), { isAxiosError: true, response: { status: 429 } }))
    );
    const subsonic = new Subsonic(url);
    await expect(subsonic.getCoverArt(credentials, "art:once-429", 100)).rejects.toBeDefined();
    expect(mockGET).toHaveBeenCalledTimes(1);
  });

  it("produces exactly one upstream call for a single 5xx (no hidden retry)", async () => {
    mockGET.mockImplementation(() =>
      Promise.reject(Object.assign(new AxiosError("503"), { isAxiosError: true, response: { status: 503 } }))
    );
    const subsonic = new Subsonic(url);
    await expect(subsonic.getCoverArt(credentials, "art:once-503", 100)).rejects.toBeDefined();
    expect(mockGET).toHaveBeenCalledTimes(1);
  });

  it("shares one coordinator across multiple libraries built from the same Subsonic instance", async () => {
    // Two SubsonicMusicLibrary instances (different logged-in users) on the SAME Subsonic instance
    // must funnel through one coordinator. A concurrent identical request per user coalesces to one
    // call each (2 total), not 4.
    const seenIds: string[] = [];
    mockGET.mockImplementation((_href: string, config: any) => {
      seenIds.push(config.params.get("u") + ":" + config.params.get("id"));
      return Promise.resolve({ status: 200, headers: { "content-type": "image/png" }, data: Buffer.from("x") });
    });
    const subsonic = new Subsonic(url);
    // Reuse the coordinator via getCoverArt directly with two credential scopes.
    await Promise.all([
      subsonic.getCoverArt({ username: "alice", password: "p" }, "art:shared-coord", 200),
      subsonic.getCoverArt({ username: "alice", password: "p" }, "art:shared-coord", 200),
      subsonic.getCoverArt({ username: "bob", password: "p" }, "art:shared-coord", 200),
      subsonic.getCoverArt({ username: "bob", password: "p" }, "art:shared-coord", 200),
    ]);
    expect(seenIds).toEqual(["alice:art:shared-coord", "bob:art:shared-coord"]);
  });
});
