import { asToken, parseToken } from "../src/subsonic";
import { b64Decode, b64Encode } from "../src/b64";

describe("Subsonic service tokens", () => {
  const OLD_ENV = process.env;
  const credentials = {
    username: "alice@example.com",
    password: "correct horse battery staple",
  };

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      BNB_SECRET: "test-secret-with-at-least-thirty-two-chars",
    };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("encrypts newly issued service tokens without exposing credentials as base64 JSON", () => {
    const token = asToken(credentials);

    expect(token).toMatch(/^enc:/);
    const decodedEnvelope = b64Decode(token.slice("enc:".length));
    expect(decodedEnvelope).not.toContain(credentials.username);
    expect(decodedEnvelope).not.toContain(credentials.password);
  });

  it("round-trips encrypted service tokens", () => {
    expect(parseToken(asToken(credentials))).toEqual(credentials);
  });

  it("parses legacy plaintext base64 service tokens", () => {
    const legacyToken = b64Encode(JSON.stringify(credentials));

    expect(parseToken(legacyToken)).toEqual(credentials);
  });

  it("rejects tampered encrypted service tokens", () => {
    const token = asToken(credentials);
    const envelope = JSON.parse(b64Decode(token.slice("enc:".length)));
    envelope.ciphertext = envelope.ciphertext.replace(/.$/, (c: string) =>
      c === "A" ? "B" : "A"
    );

    expect(() =>
      parseToken(`enc:${b64Encode(JSON.stringify(envelope))}`)
    ).toThrow();
  });
});
