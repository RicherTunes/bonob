import { randomUUID as uuid } from 'crypto';
import ms, { StringValue } from "ms";
import { Clock, SystemClock } from "./clock";


export type Association = {
  serviceToken: string
  userId: string
  nickname: string
}

export interface LinkCodes {
  mint(): string
  clear(): any
  count(): number
  has(linkCode: string): boolean
  associate(linkCode: string, association: Association): any
  associationFor(linkCode: string): Association | undefined
  // Count a failed credential relay against this code. bonob relays credentials to Navidrome
  // server-side, so Navidrome cannot distinguish an attacker from bonob itself; the counting has
  // to happen here. Implementations may burn the code at their own limit.
  recordFailure(linkCode: string): void
}

type Entry = {
  association: Association | undefined;
  expiresAt: number;
  // Failed credential relays against THIS link code. See MAX_LOGIN_ATTEMPTS_PER_LINK_CODE.
  failures: number;
};

// One hour is far longer than the Sonos device-link handshake takes, so it
// never truncates a legitimate flow, while still bounding memory: a link code
// is only used transiently during "Add Service", so anything older is dead.
const DEFAULT_LINK_CODE_TTL: StringValue = "1h";

// getAppLink is UNAUTHENTICATED, so anyone who can reach the SOAP endpoint can mint link codes at
// will. The TTL bounds how LONG a code lives but not HOW MANY exist, and this process also holds
// every API token in memory, so an unbounded map is a cheap way to pressure it.
const DEFAULT_MAX_LIVE_LINK_CODES = 500;

// bonob relays the credentials a user types to Navidrome SERVER-SIDE, which means every guess
// arrives at Navidrome from the VPS's own IP. Navidrome-side brute-force detection therefore sees a
// single client - bonob - which destroys source attribution AND risks bonob itself being throttled
// or banned, taking music down for the whole household. So bonob has to do its own counting.
//
// A link code is a single-use handshake token: a legitimate user types their password once, maybe
// twice after a typo. Burning the code after a handful of failures costs a real user one extra
// "Add Service" tap and costs an attacker the whole code.
export const MAX_LOGIN_ATTEMPTS_PER_LINK_CODE = 5;

export class InMemoryLinkCodes implements LinkCodes {
  private codes: Map<string, Entry> = new Map();
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxLive: number;
  private lastSweepMs = 0;

  constructor(
    clock: Clock = SystemClock,
    ttl: StringValue = DEFAULT_LINK_CODE_TTL,
    maxLive: number = DEFAULT_MAX_LIVE_LINK_CODES
  ) {
    this.clock = clock;
    this.ttlMs = ms(ttl);
    this.sweepIntervalMs = Math.min(60_000, this.ttlMs);
    this.maxLive = Math.max(1, maxLive);
  }

  // Count a failed credential relay. At the limit the code is BURNED rather than merely counted:
  // a spent handshake token is worthless to a legitimate user (they just start Add Service again)
  // and worthless to an attacker, who must go back through getAppLink for each new one.
  recordFailure = (linkCode: string): void => {
    const entry = this.codes.get(linkCode);
    if (!entry) return;
    entry.failures += 1;
    if (entry.failures >= MAX_LOGIN_ATTEMPTS_PER_LINK_CODE) this.codes.delete(linkCode);
  };

  private nowMs = () => this.clock.now().valueOf();

  private evictExpired = () => {
    const now = this.nowMs();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
    this.lastSweepMs = now;
  };

  // Amortise the O(n) sweep: run it at most once per interval, so a flood of
  // mint() calls (getAppLink is unauthenticated) can't turn every mint into a
  // whole-map sweep. Expired codes are also evicted lazily on access via live().
  private maybeSweep = () => {
    if (this.nowMs() - this.lastSweepMs >= this.sweepIntervalMs) this.evictExpired();
  };

  // Returns a still-live entry, evicting it if it has expired.
  private live = (linkCode: string): Entry | undefined => {
    const entry = this.codes.get(linkCode);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.nowMs()) {
      this.codes.delete(linkCode);
      return undefined;
    }
    return entry;
  };

  mint() {
    // Bound memory: unbounded minting (a DoS vector on the unauthenticated
    // getAppLink) can't grow the map without limit.
    this.maybeSweep();
    // Sonos S2 browser-auth link codes are capped at 32 characters; a UUID is
    // 36. Strip the dashes to get a spec-compliant 32-char hex code.
    const linkCode = uuid().replace(/-/g, "");
    this.codes.set(linkCode, {
      association: undefined,
      expiresAt: this.nowMs() + this.ttlMs,
      failures: 0,
    });
    // The sweep bounds AGE; this bounds COUNT. Map preserves insertion order, so the front is the
    // oldest - and a flood evicts its own earlier codes rather than a code a real user is midway
    // through using, because the attacker's are the ones filling the map.
    while (this.codes.size > this.maxLive) {
      const oldest = this.codes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    return linkCode;
  }
  clear = () => { this.codes.clear(); };
  count = () => { this.evictExpired(); return this.codes.size; };
  has = (linkCode: string) => this.live(linkCode) !== undefined;
  associate = (linkCode: string, association: Association) => {
    const entry = this.live(linkCode);
    if (entry) entry.association = association;
    else throw `Invalid linkCode ${linkCode}`;
  };
  associationFor = (linkCode: string) => this.live(linkCode)?.association;
}

