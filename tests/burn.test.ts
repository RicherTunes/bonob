import {
  assertSystem,
  BUrn,
  deriveBurnSalt,
  format,
  formatForURL,
  parse,
} from "../src/burn";
import { jwsEncryption } from "../src/encryption";
import { right } from "fp-ts/Either";

type BUrnSpec = {
  burn: BUrn;
  asString: string;
  shorthand: string;
  parseableTopLevel?: boolean;
};

describe("deriveBurnSalt", () => {
  it("is stable for the same secret (so signed art burns survive a restart)", () => {
    expect(deriveBurnSalt("a-long-stable-secret")).toEqual(
      deriveBurnSalt("a-long-stable-secret")
    );
  });

  it("differs for different secrets", () => {
    expect(deriveBurnSalt("secret-a")).not.toEqual(deriveBurnSalt("secret-b"));
  });

  it("produces at least 32 chars of key material", () => {
    expect(deriveBurnSalt("x").length).toBeGreaterThanOrEqual(32);
  });

  it("falls back (does not derive from a secret) when none is configured", () => {
    // The no-secret path must not reuse a secret's stable derivation. (It uses
    // generateRandomString, which other suites auto-mock, so we don't assert on its output.)
    expect(deriveBurnSalt(undefined)).not.toEqual(deriveBurnSalt("some-secret"));
  });

  it("a burn signed before a restart still verifies after (same secret)", () => {
    // two independent encryptors derived from the same secret = process A and process B
    const encA = jwsEncryption(deriveBurnSalt("stable-secret"));
    const encB = jwsEncryption(deriveBurnSalt("stable-secret"));
    const signed = encA.encrypt("bnb:e:http://navidrome:4533/share/img/abc");
    expect(encB.decrypt(signed)).toStrictEqual(
      right("bnb:e:http://navidrome:4533/share/img/abc")
    );
  });
});

describe("BUrn", () => {
  describe("format", () => {
    (
      [
        {
          burn: { system: "internal", resource: "icon:error" },
          asString: "bnb:internal:icon:error",
          shorthand: "bnb:i:icon:error",
        },
        {
          burn: {
            system: "external",
            resource: "http://example.com/widget.jpg",
          },
          asString: "bnb:external:http://example.com/widget.jpg",
          shorthand: "bnb:e:http://example.com/widget.jpg",
          parseableTopLevel: false,
        },
        {
          burn: { system: "subsonic", resource: "art:1234" },
          asString: "bnb:subsonic:art:1234",
          shorthand: "bnb:s:art:1234",
        },
        {
          burn: { system: "navidrome", resource: "art:1234" },
          asString: "bnb:navidrome:art:1234",
          shorthand: "bnb:n:art:1234",
        },
      ] as BUrnSpec[]
    ).forEach(({ burn, asString, shorthand, parseableTopLevel }) => {
      // external burns are only valid via the signed encrypted wrapper; parsing
      // them at the top level is refused (SSRF guard), so assert accordingly.
      const expectParsed = (stringValue: string) =>
        parseableTopLevel === false
          ? expect(() => parse(stringValue)).toThrow()
          : expect(parse(stringValue)).toEqual(burn);
      describe(asString, () => {
        it("can be formatted as string and then roundtripped back into BUrn", () => {
          const stringValue = format(burn);
          expect(stringValue).toEqual(asString);
          expectParsed(stringValue);
        });

        it("can be formatted as shorthand string and then roundtripped back into BUrn", () => {
          const stringValue = format(burn, { shorthand: true });
          expect(stringValue).toEqual(shorthand);
          expectParsed(stringValue);
        });

        describe(`encrypted ${asString}`, () => {
          it("can be formatted as an encrypted string and then roundtripped back into BUrn", () => {
            const stringValue = format(burn, { encrypt: true });
            expect(stringValue.startsWith("bnb:encrypted:")).toBeTruthy();
            expect(stringValue).not.toContain(burn.system);
            expect(stringValue).not.toContain(burn.resource);
            expect(parse(stringValue)).toEqual(burn);
          });

          it("can be formatted as an encrypted shorthand string and then roundtripped back into BUrn", () => {
            const stringValue = format(burn, {
              shorthand: true,
              encrypt: true,
            });
            expect(stringValue.startsWith("bnb:x:")).toBeTruthy();
            expect(stringValue).not.toContain(burn.system);
            expect(stringValue).not.toContain(burn.resource);
            expect(parse(stringValue)).toEqual(burn);
          });
        });
      });
    });
  });

  describe("formatForURL", () => {
    describe("external", () => {
      it("should be encrypted", () => {
        const burn = {
          system: "external",
          resource: "http://example.com/foo.jpg",
        };
        const formatted = formatForURL(burn);
        expect(formatted.startsWith("bnb:x:")).toBeTruthy();
        expect(formatted).not.toContain("http://example.com/foo.jpg");

        expect(parse(formatted)).toEqual(burn);
      });
    });

    describe("not external", () => {
      it("should be shorthand form", () => {
        expect(formatForURL({ system: "internal", resource: "foo" })).toEqual(
          "bnb:i:foo"
        );
        expect(
          formatForURL({ system: "subsonic", resource: "foo:bar" })
        ).toEqual("bnb:s:foo:bar");
      });
    });
  });

  describe("assertSystem", () => {
    it("should fail if the system is not equal", () => {
      const burn = { system: "external", resource: "something"};
      expect(() => assertSystem(burn, "subsonic")).toThrow(`Unsupported urn: '${format(burn)}'`)
    });

    it("should pass if the system is equal", () => {
      const burn = { system: "external", resource: "something"};
      expect(assertSystem(burn, "external")).toEqual(burn);
    });
  });

  describe("security: untrusted external burns", () => {
    it("refuses to parse a top-level external burn (SSRF guard)", () => {
      expect(() =>
        parse("bnb:external:http://169.254.169.254/latest/meta-data")
      ).toThrow();
      expect(() =>
        parse("bnb:e:http://169.254.169.254/latest/meta-data")
      ).toThrow();
    });

    it("still round-trips an external burn that arrived via the signed encrypted wrapper", () => {
      const burn = { system: "external", resource: "http://cdn.example/a.jpg" };
      expect(parse(formatForURL(burn))).toEqual(burn);
    });
  });
});

