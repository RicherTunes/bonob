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
          // deezer burns carry an artist name and are resolved server-side; like external they
          // are only honoured via the signed encrypted wrapper (refused at the top level).
          burn: { system: "deezer", resource: "Radiohead" },
          asString: "bnb:deezer:Radiohead",
          shorthand: "bnb:d:Radiohead",
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

  describe("invalid input", () => {
    // Covers BURN.parse's no-match arm (-> undefined), BURN.validate's `!b` arm, and parse()'s
    // validation throw. A mutant that drops the `validationErrors.length > 0` throw returns a
    // bogus {system: undefined, resource: undefined} instead of throwing -> red.
    it("rejects a string that is not a burn at all", () => {
      expect(() => parse("not-a-burn")).toThrow(/Invalid burn: 'not-a-burn'/);
    });

    it("rejects a malformed encrypted burn (decrypt failure throws, not silently swallowed)", () => {
      // Covers the E.match error branch in the encrypted parse path. A mutant that returns the
      // error instead of throwing (e.g. `(err) => err`) makes this red.
      expect(() => parse("bnb:encrypted:cannot-decrypt-this")).toThrow();
    });

    it("preserves an unknown system through shorthand formatting (the || fallback)", () => {
      // SHORTHAND_MAPPINGS has no entry for 'made-up-system', so format must fall back to the
      // original system string. Drop the fallback and the system becomes 'undefined'.
      expect(
        format({ system: "made-up-system", resource: "r" }, { shorthand: true })
      ).toEqual("bnb:made-up-system:r");
    });
  });
});


describe("shorthand mappings", () => {
  // The module-load guard used to compare `.length` on two Records - undefined on both sides, so
  // it could never fire. The hazard is real: two systems sharing a shorthand letter silently
  // collapse the reverse map, and one system's burns then decode as the other's.
  // The uniqueness of the shorthand letters is enforced at MODULE LOAD by the guard in burn.ts:
  // if two systems shared a letter, the reverse map would be short and importing this module would
  // throw. So every test in this file importing successfully IS that assertion. What is worth
  // pinning here is the behaviour that guard protects: every system survives a round trip.
  it("round-trips every system", () => {
    for (const system of ["internal", "external", "subsonic", "navidrome", "deezer"]) {
      const urn = { system, resource: `${system}-resource` };
      expect(parse(formatForURL(urn))).toEqual(urn);
    }
  });
});
