import { withTimeout, faultOrFallback, SMAPI_BROWSE_TIMEOUT_MS } from "../src/timeout";

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
