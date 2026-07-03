import { left, right } from 'fp-ts/Either'

import { cryptoEncryption, jwsEncryption } from '../src/encryption';

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
})

describe("cryptoEncryption", () => {
  it("can encrypt and decrypt", () => {
    const e = cryptoEncryption("secret squirrel");

    const value = "bobs your uncle"
    const hash = e.encrypt(value)
    expect(hash).not.toContain(value);
    expect(e.decrypt(hash)).toEqual(right(value));
  });

  it("returns different values for different secrets", () => {
    const e1 = cryptoEncryption("e1");
    const e2 = cryptoEncryption("e2");

    const value = "bobs your uncle"
    const h1 = e1.encrypt(value)
    const h2 = e2.encrypt(value)

    expect(h1).not.toEqual(h2);
  });
  
  it("should return left on invalid value", () => {
    const e = cryptoEncryption("secret squirrel");

    expect(e.decrypt("not-valid")).toEqual(left("Invalid value to decrypt"));
  });
})
