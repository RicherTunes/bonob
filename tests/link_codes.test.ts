import { InMemoryLinkCodes } from "../src/link_codes"
import { FixedClock } from "../src/clock"
import dayjs from "dayjs"

describe("InMemoryLinkCodes", () => {
  const linkCodes = new InMemoryLinkCodes()

  describe('minting', () => {
    it('should be able to mint unique codes', () => {
      const code1 = linkCodes.mint()
      const code2 = linkCodes.mint()
      const code3 = linkCodes.mint()

      expect(code1).not.toEqual(code2);
      expect(code1).not.toEqual(code3);
    });

    it('should mint codes within the Sonos 32-character limit', () => {
      // Sonos S2 browser-auth rejects link codes longer than 32 chars.
      const code = linkCodes.mint()
      expect(code).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe("associating a code with a user", () => {
    describe('when token is valid', () => {
      it('should associate the token', () => {
        const linkCode = linkCodes.mint();
        const association = { serviceToken: "token123", nickname: "bob", userId: "1" };

        linkCodes.associate(linkCode, association);

        expect(linkCodes.associationFor(linkCode)).toEqual(association);
      }); 
    });

    describe('when token is valid', () => {
      it('should throw an error', () => {
        const invalidLinkCode = "invalidLinkCode";
        const association = { serviceToken: "token456", nickname: "bob", userId: "1" };

        expect(() => linkCodes.associate(invalidLinkCode, association)).toThrow(`Invalid linkCode ${invalidLinkCode}`)
      }); 
    });
  });

  describe('fetching an association for a linkCode', () => {
    describe('when the token doesnt exist', () => {
      it('should return undefined', () => {
        const missingLinkCode = 'someLinkCodeThatDoesntExist';
        expect(linkCodes.associationFor(missingLinkCode)).toBeUndefined()
      });
    })
  });

  describe('expiry (TTL)', () => {
    const association = { serviceToken: "t", nickname: "n", userId: "1" };

    it('should evict a link code once its TTL has elapsed', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, 60 * 60 * 1000);

      const code = codes.mint();
      expect(codes.has(code)).toBe(true);

      clock.add(61, "m");

      expect(codes.has(code)).toBe(false);
      expect(codes.associationFor(code)).toBeUndefined();
      expect(codes.count()).toEqual(0);
      expect(() => codes.associate(code, association)).toThrow();
    });

    it('should keep a link code valid within its TTL', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, 60 * 60 * 1000);

      const code = codes.mint();
      clock.add(59, "m");
      codes.associate(code, association);

      expect(codes.associationFor(code)).toEqual(association);
    });

    it('should evict expired codes when minting so memory stays bounded', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, 60 * 60 * 1000);

      codes.mint();
      clock.add(61, "m");
      codes.mint();

      expect(codes.count()).toEqual(1);
    });
  });
})