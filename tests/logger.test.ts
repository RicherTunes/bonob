import logger, { debugIt } from "../src/logger";

describe("debugIt", () => {
  it("logs the value at debug level and returns it unchanged (the pass-through identity)", () => {
    // debugIt is a debugging helper: it must (a) hand the exact value to logger.debug and
    // (b) return that same value so it can be spliced into an expression without changing
    // behaviour. Pinning both halves kills a mutation to either side.
    const spy = jest.spyOn(logger, "debug").mockImplementation(() => logger);

    const value = { id: "x", n: 42 };
    const result = debugIt(value);

    expect(spy).toHaveBeenCalledWith(value);
    expect(spy).toHaveBeenCalledTimes(1);
    // Same reference, not a copy: a `return { ...thing }` mutation must fail.
    expect(result).toBe(value);

    spy.mockRestore();
  });

  it("passes through primitives (string) the same way", () => {
    const spy = jest.spyOn(logger, "debug").mockImplementation(() => logger);
    try {
      expect(debugIt("hello")).toBe("hello");
      expect(spy).toHaveBeenCalledWith("hello");
    } finally {
      spy.mockRestore();
    }
  });
});
