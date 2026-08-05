import { withTimeout, withDeadline, faultOrFallback, describeReason, SMAPI_BROWSE_TIMEOUT_MS } from "../src/timeout";
import logger from "../src/logger";

describe("withTimeout", () => {
  it("resolves to the value when it settles in time", async () => {
    expect(await withTimeout(Promise.resolve("quick"), 1000, "fallback")).toBe(
      "quick"
    );
  });

  it("resolves to the fallback when the promise is too slow", async () => {
    const never = new Promise<string>(() => {});
    expect(await withTimeout(never, 10, "fallback")).toBe("fallback");
  });
});

// A browse or search that blows the deadline degrades to an empty result or a placeholder, which in
// the Sonos app is indistinguishable from "nothing matched" or "still loading". Until these paths
// said something, a user-visible failure left NO trace at all: that is why "search only returns
// albums" and the stuck "Loading, please try again" tile could not be diagnosed from the logs.
// Degrading silently is the defect; degrading loudly is the fix.
describe("withTimeout observability", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => warn.mockRestore());

  it("says nothing when the promise settles in time", async () => {
    await withTimeout(Promise.resolve("quick"), 1000, "fallback", "search:artists");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with the context and the deadline when it degrades", async () => {
    const never = new Promise<string>(() => {});
    await withTimeout(never, 10, "fallback", "search:artists");

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("search:artists");
    expect(message).toContain("10");
  });

  it("stays silent when no context is supplied, so existing callers are unchanged", async () => {
    const never = new Promise<string>(() => {});
    await withTimeout(never, 10, "fallback");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT log a SMAPI fault that arrives after the deadline - it carries a fresh auth token", async () => {
    // The token-refresh fault this codebase throws (smapi.ts) is a NON-Error object whose detail
    // carries a newly minted JWT. describeReason JSON-serialized non-Errors wholesale, and the
    // 300-char cap still let most of the JWT header and the leading payload through. The refresh is
    // a network round trip, so exceeding the 4.5s deadline is precisely the degraded condition this
    // logging was added for - which means the leak fires exactly when it is most likely to be hit.
    // faultOrFallback already stays quiet for faults; the post-deadline follow-up must too.
    const fault = {
      Fault: {
        faultcode: "Client.TokenRefreshRequired",
        faultstring: "Token has expired",
        detail: {
          refreshAuthTokenResult: {
            authToken: "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETJWTPAYLOAD.sig",
            privateKey: "nonsense",
          },
        },
      },
    };

    let fail!: (e: unknown) => void;
    const slow = new Promise<string>((_, rej) => {
      fail = rej;
    });

    await withTimeout(slow, 10, "fallback", "getMetadata:root");
    warn.mockClear();

    fail(fault);
    await slow.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("SUPERSECRETJWTPAYLOAD");
    expect(logged).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(logged).not.toContain("authToken");

    // And nothing is logged AT ALL. Asserting only the absence of the credential left the
    // isSmapiFault guard unpinned: describeReason renders objects by shape, so deleting the guard
    // still leaked nothing and the test stayed green. An independent mutation run caught that. The
    // guard's other job is semantic - a SMAPI fault is the protocol working, not a degradation - so
    // losing it would warn on every routine token refresh. That is what this pins.
    expect(warn).not.toHaveBeenCalled();
  });

  it("never serializes an arbitrary object rejection's contents", async () => {
    let fail!: (e: unknown) => void;
    const slow = new Promise<string>((_, rej) => {
      fail = rej;
    });

    await withTimeout(slow, 10, "fallback", "search:tracks");
    warn.mockClear();

    fail({ nested: { secret: "DO-NOT-LOG-ME" }, token: "ALSO-SECRET" });
    await slow.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("DO-NOT-LOG-ME");
    expect(logged).not.toContain("ALSO-SECRET");
  });

  it("neutralizes the context, which embeds a Sonos-supplied container id", async () => {
    // The SMAPI handlers build their context from the browsed/searched id, which comes straight
    // off the wire. Interpolating it raw would hand a client the ability to forge log lines.
    const never = new Promise<string>(() => {});
    await withTimeout(never, 10, "fallback", 'getMetadata:x\r\nFORGED admin login');

    const message = String(warn.mock.calls[0]![0]);
    expect(message).not.toContain("\r");
    expect(message).not.toContain("\n");
    expect(message).toContain("\\x0d");
    expect(message).toContain("\\x0a");
  });

  it("reports how long the abandoned work actually took once it finally settles", async () => {
    // The deadline tells you it was too slow; only the eventual settle tells you by how much, which
    // is what distinguishes "just over budget" from "the backend is wedged".
    let release!: (v: string) => void;
    const slow = new Promise<string>((res) => {
      release = res;
    });

    expect(await withTimeout(slow, 10, "fallback", "search:tracks")).toBe("fallback");
    expect(warn).toHaveBeenCalledTimes(1);

    release("late");
    await slow;
    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("search:tracks");
  });

  it("reports an abandoned promise that eventually REJECTS, without an unhandled rejection", async () => {
    const onUnhandled = jest.fn();
    const handler = (reason?: unknown) => onUnhandled(reason);
    process.on("unhandledRejection", handler);
    try {
      let fail!: (e: unknown) => void;
      const slow = new Promise<string>((_, rej) => {
        fail = rej;
      });

      expect(await withTimeout(slow, 10, "fallback", "browse:albums")).toBe("fallback");

      fail(new Error("upstream died"));
      await slow.catch(() => {});
      await Promise.resolve();
      await Promise.resolve();

      expect(onUnhandled).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("browse:albums"))).toBe(true);
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });
});

describe("faultOrFallback (browse backstop catch)", () => {
  it("returns the fallback for a plain backend error", () => {
    expect(faultOrFallback("fb")(new Error("boom"))).toBe("fb");
    expect(faultOrFallback("fb")("Subsonic error: nope")).toBe("fb");
  });

  it("re-throws a SMAPI/auth fault so it still reaches Sonos", () => {
    const fault = {
      Fault: { faultcode: "Client.LoginUnauthorized", faultstring: "x" },
    };
    let thrown: unknown;
    try {
      faultOrFallback("fb")(fault);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(fault);
  });

  it("keeps the browse deadline under Sonos's 5s SMAPI timeout", () => {
    expect(SMAPI_BROWSE_TIMEOUT_MS).toBeLessThan(5000);
  });
});

describe("describeReason", () => {
  it("renders null/undefined as their string form (not '[object Object]')", () => {
    // Pins the `e === null || e === undefined ? String(e)` arm: a mutant that drops this arm
    // (so null falls through to the object branch) yields '[object: ]' instead of 'null'.
    expect(describeReason(null)).toEqual("null");
    expect(describeReason(undefined)).toEqual("undefined");
  });

  it("renders a primitive (non-Error, non-string, non-object) as String(e)", () => {
    // Pins the final `else String(e)`: a number is typeof 'number', so it must NOT take the
    // object branch. Inverting `typeof e === 'object'` -> `!==` makes 42 take the object branch
    // and emit '[object: ]' -> red.
    expect(describeReason(42)).toEqual("42");
    expect(describeReason(true)).toEqual("true");
  });

  it("names an object without a constructor (Object.create(null)) as 'object'", () => {
    // Pins the `?? 'object'` fallback in the constructor-name lookup: Object.create(null) has no
    // constructor, so constructor?.name is undefined and the nullish-coalescing arm must fire.
    expect(describeReason(Object.create(null))).toEqual("[object: ]");
  });
});

describe("faultOrFallback observability", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => warn.mockRestore());

  it("warns with the context and the reason when it swallows a backend error", () => {
    faultOrFallback("fb", "search:tracks")(new Error("connect ECONNREFUSED"));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("search:tracks");
    expect(message).toContain("connect ECONNREFUSED");
  });

  it("does NOT warn when re-throwing a SMAPI fault - that is not a degradation", () => {
    const fault = { Fault: { faultcode: "Client.LoginUnauthorized", faultstring: "x" } };
    expect(() => faultOrFallback("fb", "browse:root")(fault)).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when no context is supplied", () => {
    faultOrFallback("fb")(new Error("boom"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("neutralizes both the context and the reason against log forging", () => {
    faultOrFallback("fb", "search:a\r\nFORGED")(new Error("boom\r\nALSO FORGED"));

    const message = String(warn.mock.calls[0]![0]);
    expect(message).not.toContain("\r");
    expect(message).not.toContain("\n");
  });

  it("never lets a non-Error reason break the log call", () => {
    expect(faultOrFallback("fb", "search:albums")("Subsonic error: nope")).toBe("fb");
    expect(String(warn.mock.calls[0]![0])).toContain("Subsonic error: nope");
  });

  it("names an object rejection by shape without serializing its contents", () => {
    faultOrFallback("fb", "search:albums")({ token: "SECRET-VALUE", nested: { a: 1 } });
    const message = String(warn.mock.calls[0]![0]);
    expect(message).not.toContain("SECRET-VALUE");
    expect(message).toContain("search:albums");
  });

  it("does not leak credentials from an axios-style error into the log", () => {
    // Subsonic auth travels in the query string (u/t/s), so an error carrying a config.url would
    // put the salted token straight into the log if the reason were serialized wholesale. This is
    // the same defect that produced "Failed getting coverArt for urn:'[object Object]'".
    const axiosish = Object.assign(new Error("Request failed with status code 500"), {
      isAxiosError: true,
      config: { url: "http://navidrome:4533/rest/search3?u=sonos&t=deadbeefsalted&s=abc" },
      response: { status: 500 },
    });

    faultOrFallback("fb", "search:tracks")(axiosish);

    const message = String(warn.mock.calls[0]![0]);
    expect(message).not.toContain("deadbeefsalted");
    expect(message).toContain("search:tracks");
  });
});

describe("withDeadline (playback paths)", () => {
  // getMediaURI and getMediaMetadata are the PLAYBACK paths and were the only SMAPI handlers with
  // no time bound at all. A browse fallback is wrong here: substituting a placeholder URI would
  // hand Sonos something that is not the track. Sonos gives up around 5s regardless, so the right
  // degradation is to fail deterministically just under that, with a logged reason.
  it("rejects once the deadline passes instead of hanging", async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => {});
    const guarded = withDeadline(never, 4500, "getMediaURI:track:t1");
    const assertion = expect(guarded).rejects.toBeDefined();
    jest.advanceTimersByTime(4501);
    await assertion;
    jest.useRealTimers();
  });

  it("resolves normally when the work finishes in time", async () => {
    await expect(
      withDeadline(Promise.resolve("ok"), 4500, "getMediaURI:track:t1")
    ).resolves.toEqual("ok");
  });

  it("logs the breach so a slow playback path is visible", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const never = new Promise<string>(() => {});
    const guarded = withDeadline(never, 100, "getMediaURI:track:t1");
    const assertion = expect(guarded).rejects.toBeDefined();
    jest.advanceTimersByTime(101);
    await assertion;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("getMediaURI:track")
    );
    warn.mockRestore();
    jest.useRealTimers();
  });

  // A SMAPI fault must reach Sonos unchanged (the token-refresh fault carries a fresh credential),
  // exactly as faultOrFallback already guarantees.
  it("passes a rejection straight through when it beats the deadline", async () => {
    const boom = Promise.reject(new Error("upstream down"));
    await expect(withDeadline(boom, 4500, "getMediaURI:track:t1")).rejects.toThrow(
      "upstream down"
    );
  });
});
