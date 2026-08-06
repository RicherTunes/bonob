import { InMemoryLinkCodes, MAX_LOGIN_ATTEMPTS_PER_LINK_CODE } from "../src/link_codes"
import { FixedClock, SystemClock } from "../src/clock"
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
      const codes = new InMemoryLinkCodes(clock, "1h");

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
      const codes = new InMemoryLinkCodes(clock, "1h");

      const code = codes.mint();
      clock.add(59, "m");
      codes.associate(code, association);

      expect(codes.associationFor(code)).toEqual(association);
    });

    it('should evict expired codes when minting so memory stays bounded', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, "1h");

      codes.mint();
      clock.add(61, "m");
      codes.mint();

      expect(codes.count()).toEqual(1);
    });

    it('should treat a code as expired exactly at the TTL boundary', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, "1h");

      const code = codes.mint();
      clock.add(60, "m"); // exactly at expiry

      expect(codes.has(code)).toBe(false);
    });

    it('should evict only the expired codes when minting, keeping live ones', () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const codes = new InMemoryLinkCodes(clock, "1h");

      const old1 = codes.mint();
      const old2 = codes.mint();
      clock.add(61, "m");
      const fresh = codes.mint();

      expect(codes.count()).toEqual(1);
      expect(codes.has(fresh)).toBe(true);
      expect(codes.has(old1)).toBe(false);
      expect(codes.has(old2)).toBe(false);
    });
  });
})
describe("InMemoryLinkCodes bounds and login throttling", () => {
  // getAppLink is UNAUTHENTICATED and mints a link code every call, so an attacker can mint
  // freely. The TTL sweep bounds age but not COUNT, so a flood is unbounded memory in a process
  // that also holds every API token in memory.
  it("caps how many live link codes it will hold", () => {
    const codes = new InMemoryLinkCodes(SystemClock, "1h", 100);
    for (let i = 0; i < 500; i++) codes.mint();
    expect(codes.count()).toBeLessThanOrEqual(100);
  });

  it("evicts the OLDEST when capped, so a flood cannot push out a code minted seconds ago", () => {
    const codes = new InMemoryLinkCodes(SystemClock, "1h", 3);
    const first = codes.mint();
    codes.mint();
    codes.mint();
    expect(codes.has(first)).toBe(true);
    codes.mint(); // over cap: the oldest goes
    expect(codes.has(first)).toBe(false);
  });

  // bonob relays credentials to Navidrome server-side, so every guess arrives from the VPS's own
  // IP. Navidrome-side brute-force detection therefore sees ONE client - bonob - which both
  // destroys source attribution and risks bonob itself being banned, taking music down for the
  // household. bonob has to do its own counting.
  it("refuses a link code after too many failed attempts", () => {
    const codes = new InMemoryLinkCodes(SystemClock, "1h");
    const code = codes.mint();
    expect(codes.has(code)).toBe(true);
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS_PER_LINK_CODE; i++) codes.recordFailure(code);
    expect(codes.has(code)).toBe(false);
  });

  it("a successful association is unaffected by earlier failures below the limit", () => {
    const codes = new InMemoryLinkCodes(SystemClock, "1h");
    const code = codes.mint();
    codes.recordFailure(code);
    codes.associate(code, {
      serviceToken: "t",
      userId: "u",
      nickname: "n",
    });
    expect(codes.associationFor(code)).toBeDefined();
  });
});
