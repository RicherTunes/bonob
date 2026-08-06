import { left, right } from 'fp-ts/Either'

import jws from 'jws';

import { jwsEncryption } from '../src/encryption';

describe("jwsEncryption", () => {
  it("can encrypt and decrypt", () => {
    const e = jwsEncryption("secret squirrel");

    const value = "bobs your uncle"
    const hash = e.encrypt(value)
    expect(hash).not.toContain(value);
    expect(e.decrypt(hash)).toEqual(right(value));
  });

  it("returns different values for different secrets", () => {
    const e1 = jwsEncryption("e1");
    const e2 = jwsEncryption("e2");

    const value = "bobs your uncle"
    const h1 = e1.encrypt(value)
    const h2 = e2.encrypt(value)

    expect(h1).not.toEqual(h2);
  });

  it("rejects a token that was not signed with this secret (no decode-without-verify bypass)", () => {
    const attacker = jwsEncryption("attacker-secret");
    const server = jwsEncryption("real-secret");

    const forged = attacker.encrypt("bnb:external:http://169.254.169.254/latest/meta-data");

    expect(server.decrypt(forged)).toEqual(left("Invalid signature"));
  });

  it("rejects an alg:none forged token", () => {
    const server = jwsEncryption("real-secret");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from("bnb:external:http://evil.example/x").toString("base64url");
    const forged = `${header}.${payload}.`;

    expect(server.decrypt(forged)).toEqual(left("Invalid signature"));
  });

  it("rejects a token whose signature has been tampered with", () => {
    const e = jwsEncryption("real-secret");
    const token = e.encrypt("bnb:subsonic:art:1");
    const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");

    expect(e.decrypt(tampered)).toEqual(left("Invalid signature"));
  });

  it("rejects garbage / malformed input without throwing", () => {
    const e = jwsEncryption("real-secret");

    expect(e.decrypt("not-a-jws")).toEqual(left("Invalid signature"));
    expect(e.decrypt("")).toEqual(left("Invalid signature"));
    expect(e.decrypt("a.b")).toEqual(left("Invalid signature"));
  });

  it("returns left('Failed to decrypt jws') when a verified token cannot be decoded", () => {
    // The decrypt path verifies first, then decodes. jws.verify does NOT call
    // jws.decode (it uses jwa directly), so stubbing decode to return null
    // isolates the `decode -> fromNullable -> match` tail: the O.none branch must
    // yield left("Failed to decrypt jws") rather than pass or throw. jws.verify
    // runs for real against the genuine signature, so this is NOT bypassing the
    // security check - it simulates a token that verifies but won't decode.
    const e = jwsEncryption("real-secret");
    const token = e.encrypt("payload-value");

    const decodeSpy = jest.spyOn(jws, "decode").mockReturnValue(null as any);
    try {
      expect(e.decrypt(token)).toEqual(left("Failed to decrypt jws"));
    } finally {
      decodeSpy.mockRestore();
    }
  });
})

// cryptoEncryption was REMOVED, along with these tests. It had no callers in src/ and carried a
// module-level `const IV = randomBytes(16)` reused for every encryption under one key - exactly
// what CBC mode forbids. The tests were the only thing keeping it alive, which is how a landmine
// survives a codebase: nothing uses it, so nothing exercises the flaw, so nothing removes it.
