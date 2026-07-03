import { randomUUID as uuid } from 'crypto';
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
}

type Entry = { association: Association | undefined; expiresAt: number };

// One hour is far longer than the Sonos device-link handshake takes, so it
// never truncates a legitimate flow, while still bounding memory: a link code
// is only used transiently during "Add Service", so anything older is dead.
const DEFAULT_LINK_CODE_TTL_MS = 60 * 60 * 1000;

export class InMemoryLinkCodes implements LinkCodes {
  private codes: Map<string, Entry> = new Map();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(clock: Clock = SystemClock, ttlMs: number = DEFAULT_LINK_CODE_TTL_MS) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  private nowMs = () => this.clock.now().valueOf();

  private evictExpired = () => {
    const now = this.nowMs();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
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
    // Evict on mint so unbounded minting (a DoS vector on getAppLink) can't grow
    // memory without limit.
    this.evictExpired();
    // Sonos S2 browser-auth link codes are capped at 32 characters; a UUID is
    // 36. Strip the dashes to get a spec-compliant 32-char hex code.
    const linkCode = uuid().replace(/-/g, "");
    this.codes.set(linkCode, {
      association: undefined,
      expiresAt: this.nowMs() + this.ttlMs,
    });
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

