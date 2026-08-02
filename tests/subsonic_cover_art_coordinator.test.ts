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

      // Observe one real slot hold of 2s, i.e. twice the queue deadline.
      const seed = coord.run(coverArtKey("u", "p", "seed", 1), slowTask("seed"));
      jest.advanceTimersByTime(2000);
      await expect(seed).resolves.toEqual(Buffer.from("seed"));

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
