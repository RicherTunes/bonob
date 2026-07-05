import _ from "underscore";
import { createHash } from "crypto";
import { generateRandomString } from "./random";
import { pipe } from "fp-ts/lib/function";
import { either as E } from "fp-ts";

import jwsEncryption from "./encryption";

export type BUrn = {
  system: string;
  resource: string;
};

// Tiny URN serializer/parser for the "bnb:<system>:<resource>" format
// previously provided by urn-lib. Components are non-empty; resource may
// contain ":" since we only split on the first two.
const BURN = {
  format: ({ system, resource }: BUrn): string =>
    `bnb:${system}:${resource}`,
  parse: (s: string): BUrn | undefined => {
    const m = s.match(/^bnb:([^:]+):(.+)$/);
    return m ? { system: m[1]!, resource: m[2]! } : undefined;
  },
  validate: (b: BUrn | undefined): string[] | undefined => {
    if (!b) return ["invalid format"];
    if (!b.system || !b.resource) return ["empty component"];
    return undefined;
  },
};

const DEFAULT_FORMAT_OPTS = {
  shorthand: false,
  encrypt: false,
}

const SHORTHAND_MAPPINGS: Record<string, string> = {
  "internal" : "i",
  "external": "e",
  "subsonic": "s",
  "navidrome": "n",
  "encrypted": "x",
  "deezer": "d"
}
const REVERSE_SHORTHAND_MAPPINGS: Record<string, string> = Object.keys(SHORTHAND_MAPPINGS).reduce((ret, key) => {
  ret[SHORTHAND_MAPPINGS[key] as unknown as string] = key;
  return ret;
}, {} as Record<string, string>)
if(SHORTHAND_MAPPINGS.length != REVERSE_SHORTHAND_MAPPINGS.length) {
  throw `Invalid SHORTHAND_MAPPINGS, must be duplicate!`
}

// Derive a STABLE art-burn signing key from the app secret (with domain separation), so that
// signed art URLs survive a bonob restart. This was previously random per process, which meant
// every restart invalidated every art URL Sonos had cached -> "Invalid signature" -> blank
// artwork after every redeploy. sha256 gives 256 bits of key material. Falls back to a random
// 32-char salt (~192 bits) when no secret is configured (tests / local dev); art then simply
// won't survive a restart, as before.
export const deriveBurnSalt = (secret: string | undefined): string =>
  secret
    ? createHash("sha256").update(`bonob:art-burn-salt:${secret}`).digest("hex")
    : generateRandomString(32);

export const BURN_SALT = deriveBurnSalt(process.env["BNB_SECRET"]);
const encryptor = jwsEncryption(BURN_SALT);

export const format = (
  burn: BUrn,
  opts: Partial<{ shorthand: boolean; encrypt: boolean }> = {}
): string => {
  const o = { ...DEFAULT_FORMAT_OPTS, ...opts }
  let toBurn = burn;
  if(o.shorthand) {
    toBurn = {
      ...toBurn,
      system: SHORTHAND_MAPPINGS[toBurn.system] || toBurn.system
    }
  }
  if(o.encrypt) {
    const encryptedToBurn = {
      system: "encrypted",
      resource: encryptor.encrypt(BURN.format(toBurn))
    }
    return format(encryptedToBurn, { ...opts, encrypt: false })
  } else {
    return BURN.format(toBurn);
  }
};

export const formatForURL = (burn: BUrn) => {
  if(burn.system == "external" || burn.system == "deezer") return format(burn, { shorthand: true, encrypt: true })
  else return format(burn, { shorthand: true })
}

export const parse = (burn: string, opts: { allowExternal?: boolean } = {}): BUrn => {
  const result = BURN.parse(burn)!;
  const validationErrors = BURN.validate(result) || [];
  if (validationErrors.length > 0) {
    throw new Error(`Invalid burn: '${burn}'`);
  }
  const system = result.system as string;
  const x = {
    system: REVERSE_SHORTHAND_MAPPINGS[system] || system,
    resource: result.resource as string,
  };
  if(x.system == "encrypted") {
    return pipe(
      encryptor.decrypt(x.resource),
      E.match(
        (err) => { throw new Error(err) },
        // Content that arrived inside a signature-verified encrypted wrapper is
        // trusted, so an external image URL is only honoured on this path.
        (z) => parse(z, { allowExternal: true })
      )
    );
  } else if ((x.system == "external" || x.system == "deezer") && !opts.allowExternal) {
    // A client-supplied (unsigned) external/deezer burn would let the /art handler
    // fetch/resolve on a client's behalf. Only accept these via the encrypted (signed) path.
    throw new Error(`Refusing to resolve an unsigned ${x.system} burn: '${burn}'`);
  } else {
    return x;
  }
}

export function assertSystem(urn: BUrn, system: string): BUrn {
  if (urn.system != system) throw `Unsupported urn: '${format(urn)}'`;
  else return urn;
}