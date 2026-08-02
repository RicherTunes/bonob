import { withTimeout, faultOrFallback, SMAPI_BROWSE_TIMEOUT_MS } from "../src/timeout";
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
