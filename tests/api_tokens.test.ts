import { randomUUID as uuid } from "crypto";

import { FixedClock } from "../src/clock";
import {
  InMemoryAPITokens,
  scopedApiTokenPayload,
  serviceTokenForScopedApiToken,
  sha256
} from "../src/api_tokens";

describe('sha256 minter', () => {
  it('should return the same value for the same salt and authToken', () => {
    const authToken = uuid();
    const token1 = sha256("salty")(authToken);
    const token2 = sha256("salty")(authToken);

    expect(token1).not.toEqual(authToken);
    expect(token1).toEqual(token2);
  });

  it('should returrn different values for the same salt but different authTokens', () => {
    const authToken1 = uuid();
    const authToken2 = uuid();

    const token1 = sha256("salty")(authToken1);
    const token2= sha256("salty")(authToken2);

    expect(token1).not.toEqual(token2);
  });

  it('should return different values for the same authToken but different salts', () => {
    const authToken = uuid();

    const token1 = sha256("salt1")(authToken);
    const token2= sha256("salt2")(authToken);

    expect(token1).not.toEqual(token2);
  });
});

describe("InMemoryAPITokens", () => {
  const clock = new FixedClock();
  const timeout_ms = 10;

  const reverseAuthToken = (authToken: string) => authToken.split("").reverse().join("");

  const accessTokens = new InMemoryAPITokens(clock, `${timeout_ms}ms`, reverseAuthToken);

  it("should return the same access token for the same auth token", () => {
    const authToken = "token1";
    
    const accessToken1 = accessTokens.mint(authToken);
    const accessToken2 = accessTokens.mint(authToken);

    expect(accessToken1).not.toEqual(authToken);
    expect(accessToken1).toEqual(accessToken2);
  });

  describe("when there is an auth token for the access token", () => {
    it("should be able to retrieve it", () => {
      const authToken = uuid();
      const accessToken = accessTokens.mint(authToken);

      expect(accessTokens.authTokenFor(accessToken)).toEqual(authToken);
    });
  });

  describe("when there is no auth token for the access token", () => {
    it("should return undefined", () => {
      expect(accessTokens.authTokenFor(uuid())).toBeUndefined();
    });
  });

  describe("when a token has expired", () => {
    it("should not be returned", () => {
      const authToken = "token1";
      const accessToken = accessTokens.mint(authToken);
      expect(accessTokens.authTokenFor(accessToken)).toEqual(authToken);

      clock.add(timeout_ms + 1, "ms");

      expect(accessTokens.authTokenFor(accessToken)).toBeUndefined();
    });

    it("should be removed on next invocation to mint", () => {
      accessTokens.mint("token1")
      accessTokens.mint("token2")
      expect(accessTokens.authTokens()).toStrictEqual(["token1", "token2"])

      clock.add(timeout_ms + 1, "ms");
      expect(accessTokens.authTokens()).toStrictEqual(["token1", "token2"])

      accessTokens.mint("token3")
      expect(accessTokens.authTokens()).toStrictEqual(["token3"])
    });
  });
});

describe("scopedApiTokenPayload + serviceTokenForScopedApiToken", () => {
  it("round-trips a scoped payload for the matching scope, returning the serviceToken", () => {
    const payload = scopedApiTokenPayload("art", "svc-tok-123");
    // pins the payload SHAPE: a key/scope rename in scopedApiTokenPayload turns this red.
    expect(JSON.parse(payload)).toEqual({
      bonobApiTokenScope: "art",
      serviceToken: "svc-tok-123",
    });
    expect(serviceTokenForScopedApiToken(payload, "art")).toBe("svc-tok-123");
  });

  it("returns undefined when the scope does not match", () => {
    const payload = scopedApiTokenPayload("art", "tok");
    expect(serviceTokenForScopedApiToken(payload, "stream")).toBeUndefined();
  });

  it("returns undefined when serviceToken is present but not a string", () => {
    const payload = JSON.stringify({
      bonobApiTokenScope: "art",
      serviceToken: 12345,
    });
    expect(serviceTokenForScopedApiToken(payload, "art")).toBeUndefined();
  });

  it("returns the raw legacy authToken (allowLegacy) when no scope is present in valid JSON", () => {
    const raw = JSON.stringify({ anything: "but-no-scope" });
    expect(
      serviceTokenForScopedApiToken(raw, "art", { allowLegacy: true })
    ).toBe(raw);
  });

  it("returns undefined for a non-scoped payload when allowLegacy is not set", () => {
    const raw = JSON.stringify({ anything: "but-no-scope" });
    expect(serviceTokenForScopedApiToken(raw, "art")).toBeUndefined();
  });

  it("returns undefined for a falsy authToken even with allowLegacy (the guard short-circuits)", () => {
    // An empty string is the discriminating case: drop the `if (!authToken)` guard and JSON.parse
    // throws -> catch -> allowLegacy returns the empty string instead of undefined.
    expect(
      serviceTokenForScopedApiToken("", "art", { allowLegacy: true })
    ).toBeUndefined();
    expect(serviceTokenForScopedApiToken(undefined, "art")).toBeUndefined();
  });

  it("treats invalid JSON as a legacy token: returned raw with allowLegacy, undefined without", () => {
    const legacy = "not-json{{";
    expect(
      serviceTokenForScopedApiToken(legacy, "art", { allowLegacy: true })
    ).toBe(legacy);
    expect(serviceTokenForScopedApiToken(legacy, "art")).toBeUndefined();
  });
});

describe("InMemoryAPITokens defaults", () => {
  it("mints with sha256('bonob') and a 1h expiry against the system clock", () => {
    const tokens = new InMemoryAPITokens();
    const authToken = uuid();
    const apiToken = tokens.mint(authToken);
    // pins the default minter: changing sha256('bonob') -> sha256('other') turns this red.
    expect(apiToken).toEqual(sha256("bonob")(authToken));
    // pins the default 1h timeout: changing it to e.g. '0ms' expires the token immediately.
    expect(tokens.authTokenFor(apiToken)).toEqual(authToken);
  });
});
