import { option as O, taskEither as TE } from "fp-ts";
import * as A from "fp-ts/Array";
import { ordString } from "fp-ts/lib/Ord";
import { pipe } from "fp-ts/lib/function";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { isIP } from "net";
import { promises as dnsPromises } from "dns";
import { generateRandomString } from "./random";
import {
  Credentials,
  Album,
  AlbumQuery,
  AlbumSummary,
  Genre,
  Track,
  CoverArt,
  AlbumQueryType,
  Encoding,
  albumToAlbumSummary,
  TrackSummary,
  AuthFailure
} from "./music_library";
import sharp from "sharp";
import _ from "underscore";
import { readFile, writeFile } from "fs/promises";
import path from "path";

import axios, { AxiosRequestConfig } from "axios";
import { b64Encode, b64Decode } from "./b64";
import { BUrn } from "./burn";
import { SwrCache } from "./swr_cache";
import { AlbumIndex, BucketBuilder } from "./album_index";
import { AlbumSnapshotWriter } from "./album_snapshot";
import { album, artist } from "./smapi";
import { URLBuilder } from "./url_builder";

export const BROWSER_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
};

export const SUBSONIC_HTTP_TIMEOUT_MS = 30_000;

// Bound hung upstreams process-wide: a Subsonic request that never responds is aborted by axios
// after SUBSONIC_HTTP_TIMEOUT_MS instead of tying up a socket and stacking retries behind the
// SwrCache backstop. Applied as a default (not per-call) so it stays out of the request config
// the tests assert on; the image fetchers set their own shorter timeout which overrides this.
if (axios.defaults) axios.defaults.timeout = SUBSONIC_HTTP_TIMEOUT_MS;

export const t = (password: string, s: string) =>
  createHash("md5").update(`${password}${s}`).digest("hex");

export const t_and_s = (password: string) => {
  const s = generateRandomString();
  return {
    t: t(password, s),
    s,
  };
};

export const ALBUM_INDEX_CACHE_MAX_ENTRIES = 2;

export const DODGY_IMAGE_NAME = "2a96cbd8b46e442fc41c2b86b821562f.png";

const stripIPv6Brackets = (host: string) => host.replace(/^\[|\]$/g, "");

const isPrivateIPv4 = (host: string): boolean => {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
};

// Expand an IPv6 string to its 8 16-bit hextets, resolving "::" zero-compression and a trailing
// embedded dotted IPv4 (e.g. ::ffff:127.0.0.1). Returns undefined if unparseable.
const expandIPv6 = (addr: string): number[] | undefined => {
  const a = addr.split("%")[0]!; // drop any zone id
  if (a === "::") return [0, 0, 0, 0, 0, 0, 0, 0];
  const sides = a.split("::");
  if (sides.length > 2) return undefined;
  const parseGroups = (s: string | undefined): number[] | undefined => {
    if (!s) return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g.includes(".")) {
        if (i !== groups.length - 1 || isIP(g) !== 4) return undefined;
        const o = g.split(".").map((x) => Number(x));
        out.push(((o[0]! << 8) | o[1]!) & 0xffff, ((o[2]! << 8) | o[3]!) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
        out.push(Number.parseInt(g, 16));
      }
    }
    return out;
  };
  const head = parseGroups(sides[0]);
  if (!head) return undefined;
  if (sides.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseGroups(sides[1]);
  if (!tail) return undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return undefined; // "::" must stand for at least one zero group
  return [...head, ...Array(fill).fill(0), ...tail];
};

const hextetsToIPv4 = (hi: number, lo: number): string =>
  `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

const isPrivateIPv6 = (host: string): boolean => {
  const g = expandIPv6(host.toLowerCase());
  if (!g) return true; // unparseable -> treat as unsafe
  const high64Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0;
  // Prefixes that embed an IPv4 in the low 32 bits: ::/96 (IPv4-compatible, also :: and ::1),
  // ::ffff:0:0/96 IPv4-mapped (ffff at hextet 5), and ::ffff:0:0/96 IPv4-translated/SIIT (ffff at
  // hextet 4). Decode the low 32 bits and reject a private/loopback/link-local IPv4.
  if (
    high64Zero &&
    ((g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) ||
      (g[4] === 0xffff && g[5] === 0))
  ) {
    if (g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7]! <= 1) return true; // :: or ::1
    return isPrivateIPv4(hextetsToIPv4(g[6]!, g[7]!));
  }
  // NAT64 well-known prefix 64:ff9b::/96 translates to an IPv4 - block the whole prefix.
  if (
    g[0] === 0x64 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    return true;
  }
  // 6to4 2002::/16 embeds an IPv4 in hextets 1-2 - reject if that IPv4 is private.
  if (g[0] === 0x2002 && isPrivateIPv4(hextetsToIPv4(g[1]!, g[2]!))) {
    return true;
  }
  // unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8
  return (
    (g[0]! & 0xfe00) === 0xfc00 ||
    (g[0]! & 0xffc0) === 0xfe80 ||
    (g[0]! & 0xff00) === 0xff00
  );
};

const isUnsafeExternalImageHost = (host: string): boolean => {
  const normalized = stripIPv6Brackets(host).toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  ) {
    return true;
  }
  const ipKind = isIP(normalized);
  if (ipKind === 4) return isPrivateIPv4(normalized);
  if (ipKind === 6) return isPrivateIPv6(normalized);
  return false;
};

// Generic external art is server-fetched from third-party (Subsonic/Last.fm) metadata, so a
// compromised backend could point it at an internal address. Enforced at fetch time in /art:
// allow only http(s) and reject loopback/link-local/private/metadata hosts. (http is permitted
// because real backends still serve some art over http; the SSRF risk is the host, not the
// scheme. Deezer has its own stricter *.dzcdn.net https allowlist.)
export function isSafeExternalImageUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !isUnsafeExternalImageHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export const isValidImage = (url: string | undefined) =>
  url != undefined && !url.endsWith(DODGY_IMAGE_NAME);

// A READ may be retried once on a transient transport failure (network error / 5xx). Do NOT retry a
// 4xx or a Subsonic-level application error (a valid response reporting a problem) - retrying those
// is pointless, and the GET-based mutations must never be retried.
// Collapse an axios response header value to the single header string we want, or undefined when
// the header is genuinely absent.
//
// axios >= 1.19 types header values as AxiosHeaderValue | undefined (string | number | boolean |
// null | string[]) rather than `string`. That is not merely a typing nicety: these values were
// previously asserted to be `string` and assumed present, which is false for content-range and
// accept-ranges on a non-range response, and for a 200 that carries no content-type at all. The
// stream responder already filtered undefined out at runtime precisely because it happens.
export const headerString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  // A repeated header arrives as an array; the first value is the effective one for the
  // single-valued headers we read here.
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  return String(value);
};

export const isRetryableSubsonicError = (e: unknown): boolean => {
  // Subsonic application-level error (a valid HTTP response reporting a problem) - retrying is pointless.
  if (String(e).startsWith("Subsonic error:")) return false;
  // Real Axios rejections (axios rejects any non-2xx before our own status check): no response means
  // a network/transport/timeout error -> retry; a 5xx -> retry; a 4xx is a client error -> do NOT.
  if (axios.isAxiosError(e)) {
    return !e.response || e.response.status >= 500;
  }
  // Our own "Subsonic (POST) failed with a NNN status" throw (a 2xx that wasn't 200/206).
  const m = String(e).match(/Subsonic (?:POST )?failed with a (\d+) status/);
  if (m) return Number(m[1]) >= 500;
  // Unknown non-Axios error -> treat as a transient transport error.
  return true;
};
// ----------------------------------------------------------------------------
// Cover-art request coordination.
//
// Navidrome (and any Subsonic server) serves cover art via /rest/getCoverArt. Sonos requests art
// for every album/artist/track it shows, so a single browse page fans out dozens of identical
// (per-image) and distinct requests at once. Under restart/resumed-scan contention Navidrome
// returns 429s and slow/invalid responses; without coordination bonob amplifies that pressure (one
// independent upstream call per art tile, no coalescing, no bound) and turns every transient
// failure into a cacheable 404 (so clients never retry the real art).
//
// The CoverArtCoordinator fixes three things per Subsonic instance:
//   1. Coalesces identical IN-FLIGHT requests onto one upstream call (privacy-safe key, below).
//   2. Bounds the number of DISTINCT requests active at once (maxConcurrency) so bonob never opens
//      hundreds of simultaneous sockets to a throttled server.
//   3. Bounds the wait for a slot (maxQueue + queueTimeoutMs): a FIFO queue with a hard cap, and
//      each queued request has a bounded wait. Over-cap or expired waits reject with a
//      classifiable CoverArtBusyError so the HTTP layer can return 503 + no-store + Retry-After.
//
// It does NOT retry: a blind 429/5xx retry loop would amplify throttle pressure. A failure (any
// kind) releases the in-flight entry so the next identical request starts a fresh upstream call.
//
// The coalescing key is a SHA-256 digest of an UNAMBIGUOUS length-prefixed encoding of the full
// credential scope (username + password), the art id, and the normalized size. Length-prefixing
// makes the input to the hash collision-free across differing component boundaries (so "ab"+"c"
// can never collide with "a"+"bc"), and the digest is the ONLY thing stored in the Map/queue, so
// raw credentials, tokens, art ids, and usernames are never persisted or logged by the coordinator.
// Distinct users, passwords, ids, and sizes never share a result.
// ----------------------------------------------------------------------------

// getCoverArt has its own bounded timeout, shorter than the process-wide SUBSONIC_HTTP_TIMEOUT_MS.
// Art tiles are small and high-volume; a hung/slow getCoverArt must not stack up behind the global
// 30s bound and must free its coordinator slot promptly.
export const SUBSONIC_COVER_ART_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_COVER_ART_HTTP_TIMEOUT_MS = SUBSONIC_COVER_ART_HTTP_TIMEOUT_MS;

// Conservative default: a single browse page fans out many art tiles, but the Subsonic server is
// the bottleneck under throttle - keep the simultaneous-socket count low. No env var is added (env
// surface stays exactly as-is); tests inject options via the constructor.
export const DEFAULT_COVER_ART_CONCURRENCY = 4;
export const DEFAULT_COVER_ART_QUEUE = 64;
export const DEFAULT_COVER_ART_QUEUE_TIMEOUT_MS = 5_000;

// The latency estimator is a MEDIAN over a sliding window, not an average.
//
// It began as an EWMA (alpha 0.3) and that was wrong in a way worth recording, because the mistake
// is easy to repeat: an average lets a single pathological sample dominate. With a healthy 50ms
// baseline, ONE art fetch stalling to the 10s http bound moved the estimate to ~3035ms, which at
// concurrency 4 against a 5s deadline collapses the admissible queue from 64 entries to 4; a second
// outlier took it to 0. Sonos would then get 503s while the upstream was answering in 50ms, and
// recovery needed ~10 consecutive good samples. Cover-art latency is exactly the kind of signal
// that produces occasional huge outliers (a cold image cache, one stalled mount), so the estimator
// has to be robust to them by construction rather than tuned to survive them.
//
// A median over the window ignores a minority of outliers outright, and only moves once slowness
// is the common case - which is the condition admission control actually exists for.
// Page size for the one-time album index scan. Named because the loop's terminating condition
// depends on it: a short page means the catalog ended.
export const ALBUM_SCAN_PAGE_SIZE = 500;

// Safety cap on the index scan, to stop a runaway or pathological server walking forever. Raised
// from a hardcoded 2,000,000 - a catalog of millions is the target, and at 2M the old cap silently
// truncated the index rather than refusing. Override with BNB_MAX_INDEX_SCAN_ALBUMS.
export const DEFAULT_MAX_INDEX_SCAN_ALBUMS = (() => {
  const raw = Number.parseInt(process.env["BNB_MAX_INDEX_SCAN_ALBUMS"] || "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 20_000_000;
})();

export const COVER_ART_LATENCY_WINDOW = 16;

// Below this many observations the guard stays dormant. Without it, one cold first fetch was
// adopted as the estimate outright and could gate the queue before anything was really known.
export const COVER_ART_LATENCY_MIN_SAMPLES = 5;

// A transient capacity/availability signal surfaced by the coordinator: the queue is full, or a
// queued request waited past its bounded deadline. Subclass of CoverArtUnavailableError so the HTTP
// layer maps it to a single 503 path (one instanceof check), and so callers can classify it.
export class CoverArtUnavailableError extends Error {
  constructor(message = "cover art temporarily unavailable") {
    super(message);
    this.name = "CoverArtUnavailableError";
    Object.setPrototypeOf(this, CoverArtUnavailableError.prototype);
  }
}

// A sanitized upstream error for non-transient (e.g. 400/401/403 / unexpected) cover-art failures.
// Carries no upstream body, URL, id, username, or credential - only a stable category - so it can
// propagate and be reported (non-404) without leaking identifiers.
export class CoverArtUpstreamError extends Error {
  readonly category: CoverArtErrorCategory;
  constructor(category: CoverArtErrorCategory, message = "cover art upstream error") {
    super(message);
    this.name = "CoverArtUpstreamError";
    this.category = category;
    Object.setPrototypeOf(this, CoverArtUpstreamError.prototype);
  }
}

export class CoverArtBusyError extends CoverArtUnavailableError {
  constructor(message = "cover art coordinator busy") {
    super(message);
    this.name = "CoverArtBusyError";
    Object.setPrototypeOf(this, CoverArtBusyError.prototype);
  }
}

type Queued = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type CoverArtCoordinatorOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
};

// Build an unambiguous, canonical key for coalescing. Each component is length-prefixed so that
// concatenated inputs with different component boundaries cannot collide (e.g. ("ab","c") vs
// ("a","bc")). The password is part of the scope so a credential rotation never serves a prior
// user's cached art to a new one. Only the opaque hex digest is ever stored.
const LENGTH_PREFIX = (s: string) => `${s.length}:`;

// The single definition of "what size is this request for". A size is only meaningful if it is a
// finite positive number; everything else (undefined, 0, negative, NaN, Infinity) means "no size",
// and must mean that identically to the coalescing key and to the upstream request. Keeping this in
// one place is the point: when the key and the request each normalized separately they disagreed,
// and two calls that fetched different images shared a cache slot.
export const normalizedCoverArtSize = (size?: number): number | undefined =>
  typeof size === "number" && Number.isFinite(size) && size > 0 ? size : undefined;

export const coverArtKey = (
  username: string,
  password: string,
  artId: string,
  size?: number
): string => {
  const normalizedSize = normalizedCoverArtSize(size) ?? 0;
  const encoded =
    LENGTH_PREFIX(username) + username +
    LENGTH_PREFIX(password) + password +
    LENGTH_PREFIX(artId) + artId +
    LENGTH_PREFIX(`${normalizedSize}`) + `${normalizedSize}`;
  return createHash("sha256").update(encoded).digest("hex");
};

const isPositiveInteger = (n: number): boolean =>
  Number.isInteger(n) && n > 0;
const isNonNegativeInteger = (n: number): boolean =>
  Number.isInteger(n) && n >= 0;

export class CoverArtCoordinator {
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number;
  private active = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: Queued[] = [];
  // Sliding window of observed slot-hold latencies (ms), newest last. Empty until the first call
  // settles, so a cold coordinator never rejects on an estimate it has not measured yet.
  //
  // The estimator is only ever fed by calls that actually run, and admission control deliberately
  // gates QUEUEING only - a free slot is always used. Those two facts are what let a degraded
  // coordinator recover unaided. They rely on slot holds being bounded: getCoverArt passes
  // SUBSONIC_COVER_ART_HTTP_TIMEOUT_MS, so a stalled upstream still settles and still yields a
  // sample. A caller that routed an UNBOUNDED task through here could pin every slot, starve the
  // estimator, and leave the guard shut - so that bound is load-bearing, not just hygiene.
  private readonly latencySamplesMs: number[] = [];

  constructor(opts: CoverArtCoordinatorOptions = {}) {
    const maxConcurrency = opts.maxConcurrency ?? DEFAULT_COVER_ART_CONCURRENCY;
    const maxQueue = opts.maxQueue ?? DEFAULT_COVER_ART_QUEUE;
    const queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_COVER_ART_QUEUE_TIMEOUT_MS;

    // Validate synchronously so a misconfiguration fails fast at construction, not on the first
    // request. maxQueue = 0 means "no queue": once all slots are busy, extra requests reject at
    // once rather than waiting.
    if (!isPositiveInteger(maxConcurrency)) {
      throw new RangeError(
        `CoverArtCoordinator maxConcurrency must be a positive integer, got ${maxConcurrency}`
      );
    }
    if (!isNonNegativeInteger(maxQueue)) {
      throw new RangeError(
        `CoverArtCoordinator maxQueue must be a non-negative integer, got ${maxQueue}`
      );
    }
    if (!isPositiveInteger(queueTimeoutMs) || !Number.isFinite(queueTimeoutMs)) {
      throw new RangeError(
        `CoverArtCoordinator queueTimeoutMs must be a positive finite integer, got ${queueTimeoutMs}`
      );
    }

    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
  }

  // Coalesce identical in-flight requests onto one upstream call. After ANY settlement the map
  // entry is dropped, so the next identical request starts a fresh upstream call (no sticky
  // failures). The key is opaque (a SHA-256 digest) so the Map never holds credentials/resource
  // values. Generic so it can wrap either a raw-image task or an axios-response task.
  run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = this.acquire(task) as Promise<T>;
    // Drop the entry on settle so a later identical request retries upstream after a failure.
    const tracked = promise.then(
      (v) => {
        this.inFlight.delete(key);
        return v;
      },
      (e) => {
        this.inFlight.delete(key);
        throw e;
      }
    ) as Promise<T>;
    this.inFlight.set(key, tracked as Promise<unknown>);
    return tracked;
  };

  private acquire = (task: () => Promise<unknown>): Promise<unknown> => {
    if (this.active < this.maxConcurrency) return this.execute(task);

    // maxQueue = 0 means no queueing at all: reject immediately when every slot is busy.
    if (this.maxQueue === 0 || this.queue.length >= this.maxQueue) {
      return Promise.reject(new CoverArtBusyError("cover art queue full"));
    }

    // Admission control. maxQueue alone is decoupled from queueTimeoutMs and from how long a slot
    // is actually held, so a deep queue can admit requests it provably cannot serve in time: with
    // an upstream slower than the deadline, EVERY queued request waits the full deadline and then
    // fails. That is the worst of both outcomes - latency AND failure - and each one pins an
    // Express handler plus a Sonos socket for the whole wait to return a 503 that was already
    // knowable. Reject those at admission instead; the queue then only holds requests that a
    // measured upstream can still reach in time.
    const estimatedWaitMs = this.estimatedWaitMs(this.queue.length);
    if (estimatedWaitMs !== undefined && estimatedWaitMs > this.queueTimeoutMs) {
      return Promise.reject(
        new CoverArtBusyError("cover art queue wait would exceed the deadline")
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const entry: Queued = {
        task,
        resolve,
        reject,
        timer: undefined,
      };
      // Each queued request has a bounded wait; reject (and dequeue) on expiry, never holding it.
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new CoverArtBusyError("cover art queue wait timed out"));
        }
      }, this.queueTimeoutMs);
      this.queue.push(entry);
    });
  };

  // How long a request joining the queue at `position` (0-based) would wait: it reaches a slot
  // after ceil((position + 1) / maxConcurrency) turnovers of the observed slot-hold latency.
  // Undefined until a latency has been measured, so a cold coordinator admits normally.
  //
  // This deliberately ignores how far the currently-active calls have already progressed, which
  // makes the estimate conservative by at most one turnover. That bias is the right way round:
  // under a degraded upstream it is better to answer "busy" at once than to hold the caller for
  // the full deadline and answer "busy" anyway.
  private estimatedWaitMs = (position: number): number | undefined => {
    const typical = this.typicalLatencyMs();
    if (typical === undefined) return undefined;
    return Math.ceil((position + 1) / this.maxConcurrency) * typical;
  };

  // Median of the window. Undefined until there are enough samples to be worth acting on, so a
  // cold or barely-exercised coordinator never rejects on an estimate it has not really measured.
  private typicalLatencyMs = (): number | undefined => {
    if (this.latencySamplesMs.length < COVER_ART_LATENCY_MIN_SAMPLES) return undefined;
    const sorted = [...this.latencySamplesMs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  private recordLatency = (sampleMs: number): void => {
    // A non-finite or negative delta can only come from a clock that moved (an NTP step or a VM
    // resume mid-call), never from real elapsed time. Such a sample says nothing about the upstream,
    // so it is discarded rather than clamped to 0 - clamping silently biased the estimate downward
    // and quietly disabled the guard.
    if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
    this.latencySamplesMs.push(sampleMs);
    if (this.latencySamplesMs.length > COVER_ART_LATENCY_WINDOW) {
      this.latencySamplesMs.shift();
    }
  };

  // Start a task under an already-held slot, timing how long it holds that slot so admission
  // control has a measured latency to work from. A synchronous throw is normalized to a rejection
  // so the caller can always attach settle handlers exactly once.
  private startTask = (task: () => Promise<unknown>): Promise<unknown> => {
    // performance.now() is MONOTONIC; Date.now() is not. An NTP step or a VM resume mid-call would
    // otherwise fabricate a latency sample out of a clock movement - backwards producing a negative
    // delta, forwards a huge one - neither of which says anything about the upstream.
    const startedAt = performance.now();
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(task());
    } catch (e) {
      result = Promise.reject(e);
    }
    // A failure still consumed the slot for as long as it took, so it is a valid latency sample.
    const record = () => this.recordLatency(performance.now() - startedAt);
    result.then(record, record);
    return result;
  };

  // Run a task under a newly-taken active slot. The slot is always released exactly once via the
  // settle handler.
  private execute = (task: () => Promise<unknown>): Promise<unknown> => {
    this.active += 1;
    const result = this.startTask(task);
    result.then(
      () => this.onSettled(),
      () => this.onSettled()
    );
    return result;
  };

  // Release a slot: if a queued request is waiting, hand it the freed slot (FIFO) and run it;
  // otherwise decrement the active count. Clears the queued request's wait timer first.
  private onSettled = (): void => {
    const next = this.queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      // Inherits the freed slot (no re-increment), and is timed like any other slot hold.
      const result = this.startTask(next.task);
      result.then(next.resolve, next.reject);
      result.then(
        () => this.onSettled(),
        () => this.onSettled()
      );
      return;
    }
    this.active = Math.max(0, this.active - 1);
  };
}

// Honest classification of an upstream error from getCoverArt. The result is an explicit union;
// "other" is a first-class outcome (never cast away) so unexpected errors propagate deliberately
// instead of being hidden as a cacheable 404.
export type CoverArtErrorCategory = "absent" | "transient" | "other";

export const classifyCoverArtError = (e: unknown): CoverArtErrorCategory => {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    if (status === 404) return "absent";
    // No response = transport/timeout (ECONNABORTED, ENOTFOUND, ETIMEDOUT, ECONNRESET...). A real
    // response status of 429/5xx is throttle/capacity. Both are transient -> the caller retries.
    if (!status || status === 429 || status >= 500) return "transient";
    // Other 4xx (400/401/403) is unexpected for cover art -> "other", surfaced deliberately.
    return "other";
  }
  // Coordinator busy / queue timeout is already a CoverArtUnavailableError -> transient.
  if (e instanceof CoverArtUnavailableError) return "transient";
  return "other";
};

type SubsonicEnvelope = {
  "subsonic-response": SubsonicResponse;
};

type SubsonicResponse = {
  status: string;
};

type album = {
  id: string;
  name: string;
  artist: string | undefined;
  artistId: string | undefined;
  coverArt: string | undefined;
  genre: string | undefined;
  year: string | undefined;
};

type artist = {
  id: string;
  name: string;
  albumCount: number;
  artistImageUrl: string | undefined;
};

type GetArtistsResponse = SubsonicResponse & {
  artists: {
    index: {
      artist: artist[];
      name: string;
    }[];
  };
};

type GetAlbumListResponse = SubsonicResponse & {
  albumList2: {
    album: album[];
  };
};

type genre = {
  songCount: number;
  albumCount: number;
  value: string;
};

export type GetGenresResponse = SubsonicResponse & {
  genres: {
    genre: genre[];
  };
};

type SubsonicError = SubsonicResponse & {
  error: {
    code: string;
    message: string;
  };
};

export type images = {
  smallImageUrl: string | undefined;
  mediumImageUrl: string | undefined;
  largeImageUrl: string | undefined;
};

type artistInfo = images & {
  biography: string | undefined;
  musicBrainzId: string | undefined;
  lastFmUrl: string | undefined;
  similarArtist: artist[];
};

type ArtistSummary = IdName & {
  image: BUrn | undefined;
};

type GetArtistInfoResponse = SubsonicResponse & {
  artistInfo2: artistInfo;
};

type GetArtistResponse = SubsonicResponse & {
  artist: artist & {
    album: album[];
  };
};

export type song = {
  id: string;
  parent: string | undefined;
  title: string;
  album: string | undefined;
  albumId: string | undefined;
  artist: string | undefined;
  artistId: string | undefined;
  track: number | undefined;
  year: string | undefined;
  genre: string | undefined;
  coverArt: string | undefined;
  created: string | undefined;
  duration: number | undefined;
  bitRate: number | undefined;
  suffix: string | undefined;
  contentType: string;
  transcodedContentType: string | undefined;
  type: string | undefined;
  userRating: number | undefined;
  // todo: this field shouldnt be on song?
  starred: string | undefined;
};

export type GetAlbumResponse = {
  album: album & {
    song: song[];
  };
};

export type GetPlaylistResponse = {
  // todo: isnt the type here a composite? playlistSummary && { entry: song[]; }
  playlist: {
    id: string;
    name: string;
    entry: song[];

    // todo: this is an ND specific field?
    coverArt: string | undefined;
  };
};

export type GetPlaylistsResponse = {
  playlists: { 
    playlist: {
      id: string;
      name: string;
      //owner: string,
      //public: boolean,
      //created: string,
      //changed: string,
      //songCount: int,
      //duration: int,

      // todo: this is an ND specific field.
      coverArt: string | undefined;
    }[] 
  };
};

export type GetSimilarSongsResponse = {
  similarSongs2: { song: song[] };
};

export type GetTopSongsResponse = {
  topSongs: { song: song[] };
};

export type GetInternetRadioStationsResponse = {
  internetRadioStations: {
    internetRadioStation: {
      id: string;
      name: string;
      streamUrl: string;
      homePageUrl?: string;
    }[];
  };
};

export type GetSongResponse = {
  song: song;
};

export type GetStarredResponse = {
  starred2: {
    song: song[];
    album: album[];
  };
};

export type PingResponse = {
  status: string;
  version: string;
  type: string;
  serverVersion: string;
};

export type Search3Response = SubsonicResponse & {
  searchResult3: {
    artist: artist[];
    album: album[];
    song: song[];
  };
};

export type OpenSubsonicExtension = {
  name: string;
  versions: number[];
};

type GetOpenSubsonicExtensionsResponse = SubsonicResponse & {
  openSubsonicExtensions: OpenSubsonicExtension[];
};

export function isError(
  subsonicResponse: SubsonicResponse
): subsonicResponse is SubsonicError {
  return (subsonicResponse as SubsonicError).error !== undefined;
}

export type IdName = {
  id: string;
  name: string;
};

export const coverArtURN = (coverArt: string | undefined): BUrn | undefined =>
  pipe(
    coverArt,
    O.fromNullable,
    O.map((it: string) => ({ system: "subsonic", resource: `art:${it}` })),
    O.getOrElseW(() => undefined)
  );

export const artistImageURN = (
  spec: Partial<{
    artistId: string | undefined;
    artistImageURL: string | undefined;
    name: string | undefined;
  }>,
  // Opt-in (BNB_DEEZER_ARTIST_ART, threaded from config): resolve artist photos from Deezer by
  // name instead of Navidrome. Off by default so we never clobber real art a server already has.
  preferDeezer: boolean = false
): BUrn | undefined => {
  const deets = {
    artistId: undefined,
    artistImageURL: undefined,
    name: undefined,
    ...spec,
  };
  // When enabled, prefer a real Deezer photo (resolved lazily by name in the /art route); the
  // Navidrome external URL and library cover art remain the fallbacks.
  if (preferDeezer && deets.name && deets.name.trim().length > 0) {
    return {
      system: "deezer",
      resource: deets.name,
    };
  } else if (deets.artistImageURL && isValidImage(deets.artistImageURL)) {
    return {
      system: "external",
      resource: deets.artistImageURL,
    };
  } else if (artistIsInLibrary(deets.artistId)) {
    return {
      system: "subsonic",
      resource: `art:${deets.artistId!}`,
    };
  } else {
    return undefined;
  }
};

export const asTrackSummary = (
  song: song,
  customPlayers: CustomPlayers
): TrackSummary => ({
  id: song.id,
  name: song.title,
  encoding: pipe(
    customPlayers.encodingFor({ mimeType: song.contentType }),
    O.getOrElse(() => ({
      player: DEFAULT_CLIENT_APPLICATION,
      mimeType: song.transcodedContentType
        ? song.transcodedContentType
        : song.contentType,
    }))
  ),
  duration: song.duration || 0,
  number: song.track || 0,
  genre: maybeAsGenre(song.genre),
  coverArt: coverArtURN(song.coverArt),
  artist: {
    id: song.artistId,
    name: song.artist ? song.artist : "?",
    image: song.artistId
      ? artistImageURN({ artistId: song.artistId })
      : undefined,
  },
  rating: {
    love: song.starred != undefined,
    stars:
      song.userRating && song.userRating <= 5 && song.userRating >= 0
        ? song.userRating
        : 0,
  },
});

export const asTrack = (
  album: AlbumSummary,
  song: song,
  customPlayers: CustomPlayers
): Track => ({
  ...asTrackSummary(song, customPlayers),
  album: album,
});

// Build a track's album summary from the SONG record alone.
//
// search3 (and getRandomSongs, getStarred2, ...) already return complete song records carrying every
// album field a listing needs, so resolving the album with a separate round trip per song was
// fetching data we were already holding. It cost getSong + getAlbum per result, and getAlbum
// returns the album's ENTIRE track list - so 20 search hits pulled 20 full album payloads to read
// 20 album names. This is O(1) per song and independent of library size.
//
// Two honest caveats:
//   - artistId/artistName are the TRACK's artist, which on a compilation differs from the album
//     artist. For a song-driven listing that is the more useful attribution, and it is the only
//     artist a song record carries.
//   - coverArt is the art id the SERVER returned for the song. It is deliberately NOT synthesized
//     from albumId: that works on Navidrome (verified live - albumId, al-<albumId>,
//     al-<albumId>_<hash> and the song's own id all return byte-identical artwork) but OpenSubsonic
//     specifies getCoverArt takes the opaque coverArt value a server handed you, so an id built
//     from an entity id is not portable. Navidrome's per-song art id would otherwise cost one
//     distinct /art url per search hit; that is solved where it belongs, by deduplicating the album
//     tiles in the SMAPI search handler, rather than by fabricating ids here.
export const albumSummaryFromSong = (song: song): AlbumSummary => ({
  id: song.albumId || "",
  name: song.album || "",
  year: song.year,
  genre: maybeAsGenre(song.genre),
  artistId: song.artistId,
  artistName: song.artist,
  coverArt: coverArtURN(song.coverArt),
});

export const asAlbumSummary = (album: album): AlbumSummary => ({
  id: album.id,
  name: album.name,
  year: album.year,
  genre: maybeAsGenre(album.genre),
  artistId: album.artistId,
  artistName: album.artist,
  coverArt: coverArtURN(album.coverArt),
});

export const asGenre = (genreName: string) => ({
  id: b64Encode(genreName),
  name: genreName,
});

export const maybeAsGenre = (
  genreName: string | undefined
): Genre | undefined =>
  pipe(
    genreName,
    O.fromNullable,
    O.map(asGenre),
    O.getOrElseW(() => undefined)
  );

export const asYear = (year: string) => ({
  year: year,
});

export interface CustomPlayers {
  encodingFor({ mimeType }: { mimeType: string }): O.Option<Encoding>;
}

export type CustomClient = {
  mimeType: string;
  transcodedMimeType: string;
};

export class TranscodingCustomPlayers implements CustomPlayers {
  transcodings: Map<string, string>;

  constructor(transcodings: Map<string, string>) {
    this.transcodings = transcodings;
  }

  static from(config: string): TranscodingCustomPlayers {
    const parts: [string, string][] = config
      .split(",")
      .map((it) => it.split(">"))
      .map((pair) => {
        if (pair.length == 1) return [pair[0]!, pair[0]!];
        else if (pair.length == 2) return [pair[0]!, pair[1]!];
        else throw new Error(`Invalid configuration item ${config}`);
      });
    return new TranscodingCustomPlayers(new Map(parts));
  }

  encodingFor = ({ mimeType }: { mimeType: string }): O.Option<Encoding> =>
    pipe(
      this.transcodings.get(mimeType),
      O.fromNullable,
      O.map((transcodedMimeType) => ({
        player: `${DEFAULT_CLIENT_APPLICATION}+${mimeType}`,
        mimeType: transcodedMimeType,
      }))
    );
}

export const NO_CUSTOM_PLAYERS: CustomPlayers = {
  encodingFor(_) {
    return O.none;
  },
};

export const DEFAULT_CLIENT_APPLICATION = "bonob";
export const USER_AGENT = "bonob";

export const asURLSearchParams = (q: any) => {
  const urlSearchParams = new URLSearchParams();
  Object.keys(q).forEach((k) => {
    _.flatten([q[k]]).forEach((v) => {
      urlSearchParams.append(k, `${v}`);
    });
  });
  return urlSearchParams;
};

// OpenSubsonic Transcoding Extension types
export type DirectPlayProfile = {
  containers: string[];
  audioCodecs: string[];
  protocols: string[];
  maxAudioChannels: number;
};

export type TranscodingProfile = {
  container: string;
  audioCodec: string;
  protocol: string;
  maxAudioChannels: number;
};

export type CodecLimitation = {
  name: string;
  comparison: string;
  values: string[];
  required: boolean;
};

export type CodecProfile = {
  type: string;
  name: string;
  limitations: CodecLimitation[];
};

export type ClientInfo = {
  name: string;
  platform: string;
  maxAudioBitrate: number;
  maxTranscodingAudioBitrate: number;
  directPlayProfiles: DirectPlayProfile[];
  transcodingProfiles: TranscodingProfile[];
  codecProfiles: CodecProfile[];
};

export type TranscodeStreamInfo = {
  protocol: string;
  container: string;
  codec: string;
  audioChannels: number;
  audioBitrate: number;
  audioProfile: string;
  audioSamplerate: number;
  audioBitdepth: number;
};

export type TranscodeDecision = {
  canDirectPlay: boolean;
  canTranscode: boolean;
  transcodeReason?: string[];
  errorReason?: string;
  transcodeParams?: string;
  sourceStream?: TranscodeStreamInfo;
  transcodeStream?: TranscodeStreamInfo;
};

type GetTranscodeDecisionResponse = {
  transcodeDecision: TranscodeDecision;
  status: string;
};

export const SONOS_CLIENT_INFO: ClientInfo = {
  name: "bonob-sonos",
  platform: "Sonos",
  maxAudioBitrate: 0,
  maxTranscodingAudioBitrate: 0,
  directPlayProfiles: [
    {
      containers: ["mp3"],
      audioCodecs: ["mp3"],
      protocols: ["http"],
      maxAudioChannels: 2,
    },
    {
      containers: ["ogg"],
      audioCodecs: ["vorbis"],
      protocols: ["http"],
      maxAudioChannels: 2,
    },
    {
      containers: ["flac"],
      audioCodecs: ["flac"],
      protocols: ["http"],
      maxAudioChannels: 2,
    },
    {
      containers: ["mp4"],
      audioCodecs: ["aac", "alac"],
      protocols: ["http"],
      maxAudioChannels: 2,
    },
  ],
  transcodingProfiles: [
    {
      container: "flac",
      audioCodec: "flac",
      protocol: "http",
      maxAudioChannels: 2,
    },
    {
      container: "mp3",
      audioCodec: "mp3",
      protocol: "http",
      maxAudioChannels: 2,
    },
  ],
  codecProfiles: [
    {
      type: "AudioCodec",
      name: "mp3",
      limitations: [
        {
          name: "audioSamplerate",
          comparison: "LessThanEqual",
          values: ["48000"],
          required: true,
        },
        {
          name: "audioChannels",
          comparison: "Equals",
          values: ["1", "2"],
          required: true,
        },
      ],
    },
    {
      type: "AudioCodec",
      name: "vorbis",
      limitations: [
        {
          name: "audioSamplerate",
          comparison: "LessThanEqual",
          values: ["48000"],
          required: true,
        },
        {
          name: "audioChannels",
          comparison: "Equals",
          values: ["1", "2"],
          required: true,
        },
      ],
    },
    {
      type: "AudioCodec",
      name: "aac",
      limitations: [
        {
          name: "audioSamplerate",
          comparison: "LessThanEqual",
          values: ["48000"],
          required: true,
        },
        {
          name: "audioChannels",
          comparison: "Equals",
          values: ["1", "2"],
          required: true,
        },
      ],
    },
    {
      type: "AudioCodec",
      name: "flac",
      limitations: [
        {
          name: "audioSamplerate",
          comparison: "LessThanEqual",
          values: ["48000"],
          required: true,
        },
        {
          name: "audioBitdepth",
          comparison: "LessThanEqual",
          values: ["24"],
          required: true,
        },
        {
          name: "audioChannels",
          comparison: "Equals",
          values: ["1", "2"],
          required: true,
        },
      ],
    },
    {
      type: "AudioCodec",
      name: "alac",
      limitations: [
        {
          name: "audioSamplerate",
          comparison: "LessThanEqual",
          values: ["48000"],
          required: true,
        },
        {
          name: "audioBitdepth",
          comparison: "LessThanEqual",
          values: ["24"],
          required: true,
        },
        {
          name: "audioChannels",
          comparison: "Equals",
          values: ["1", "2"],
          required: true,
        },
      ],
    },
  ],
};

export type ImageFetcher = (url: string) => Promise<CoverArt | undefined>;

export const cachingImageFetcher = (
  cacheDir: string, 
  delegate: ImageFetcher, 
  makeSharp = sharp
) =>
  async (url: string): Promise<CoverArt | undefined> => {
    const filename = path.join(cacheDir, `${createHash("md5").update(url).digest("hex")}.png`);
    return readFile(filename)
      .then((data) => ({ contentType: "image/png", data }))
      .catch(() =>
        delegate(url).then((image) => {
          if (image) {
            return makeSharp(image.data)
              .png()
              .toBuffer()
              .then((png) => {
                return writeFile(filename, png)
                  .then(() => ({ contentType: "image/png", data: png }));
              });
          } else {
            return undefined;
          }
        })
      );
  };

const imageFetcherWith =
  (extra: Record<string, unknown>): ImageFetcher =>
  (url: string): Promise<CoverArt | undefined> =>
    axios
      .get(url, {
        headers: BROWSER_HEADERS,
        responseType: "arraybuffer",
        // Bound external image fetches: a hung/slow upstream must not tie up the
        // process, and a huge response must not exhaust memory. (Defence in depth
        // alongside refusing unsigned external burns in burn.parse.)
        timeout: 10000,
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024,
        ...extra,
      })
      .then((res) => ({
        // An absent content-type collapses to "", which fails the image/* check at the HTTP layer
        // and is refused as art rather than being served as bytes of unknown type.
        contentType: headerString(res.headers["content-type"]) ?? "",
        data: Buffer.from(res.data, "binary"),
      }))
      .catch(() => undefined);

// Generic external art is server-fetched from third-party metadata, so a compromised backend could
// point it at an internal address. Three layers of SSRF defence:
//   1. isSafeExternalImageUrl + resolvedExternalHostIsSafe reject unsafe hosts/resolutions up front;
//   2. maxRedirects:0 stops a 30x to an internal host;
//   3. pinnedSafeExternalLookup resolves ONCE, validates every returned address, and returns the
//      address axios actually connects to - closing the DNS-rebind TOCTOU (the pre-check could see a
//      public answer while the socket got a private one).
// axios callbackifies a promise-style custom lookup (verified against the installed axios http
// adapter), so this is async and returns { address, family } (or an array when opt.all is set).
export const pinnedSafeExternalLookup = async (
  hostname: string,
  options?: { family?: number; hints?: number; all?: boolean }
): Promise<{ address: string; family: number } | { address: string; family: number }[]> => {
  const resolved = await dnsPromises.lookup(hostname, {
    all: true,
    family: options?.family,
    hints: options?.hints,
  });
  const unsafe = resolved.find((a) => isUnsafeExternalImageHost(a.address));
  if (unsafe) {
    throw new Error(
      `refusing external art host '${hostname}' that resolves to '${unsafe.address}'`
    );
  }
  const first = resolved[0];
  if (!first) throw new Error(`no address for external art host '${hostname}'`);
  return options?.all
    ? resolved.map((a) => ({ address: a.address, family: a.family }))
    : { address: first.address, family: first.family };
};

const externalImageFetcher = imageFetcherWith({
  maxRedirects: 0,
  lookup: pinnedSafeExternalLookup,
});

export const resolvedExternalHostIsSafe = async (url: string): Promise<boolean> => {
  try {
    const addresses = await dnsPromises.lookup(new URL(url).hostname, {
      all: true,
    });
    return (
      addresses.length > 0 &&
      !addresses.some((a) => isUnsafeExternalImageHost(a.address))
    );
  } catch {
    return false;
  }
};

export const axiosImageFetcher: ImageFetcher = async (url) => {
  if (!isSafeExternalImageUrl(url) || !(await resolvedExternalHostIsSafe(url)))
    return undefined;
  return externalImageFetcher(url);
};

// Deezer art must NOT follow redirects: the SSRF allowlist only validates the initial *.dzcdn.net
// URL, so a manipulated/compromised response that 30x-es to an internal address would otherwise be
// fetched. dzcdn.net serves images directly, so refusing redirects is correct.
export const deezerImageFetcher = imageFetcherWith({ maxRedirects: 0 });

const AlbumQueryTypeToSubsonicType: Record<AlbumQueryType, string> = {
  alphabeticalByArtist: "alphabeticalByArtist",
  alphabeticalByName: "alphabeticalByName",
  byGenre: "byGenre",
  byYear: "byYear",
  random: "random",
  recentlyPlayed: "recent",
  mostPlayed: "frequent",
  recentlyAdded: "newest",
  favourited: "starred",
  starred: "highest",
};

// Album sections whose contents change per request or with user activity - never cache these
// (caching "random" makes it repeat for the whole TTL; recent/frequent/starred/favourited go
// stale as soon as the user plays or stars something). Stable sections (alphabetical, byGenre,
// byYear, recentlyAdded) are safe to cache - they only change on a library scan.
const VOLATILE_ALBUM_TYPES: ReadonlySet<AlbumQueryType> = new Set([
  "random",
  "recentlyPlayed",
  "mostPlayed",
  "favourited",
  "starred",
]);

const artistIsInLibrary = (artistId: string | undefined) =>
  artistId != undefined && artistId != "-1";

const SERVICE_TOKEN_PREFIX = "enc:";
const SERVICE_TOKEN_ALGORITHM = "aes-256-gcm";

type EncryptedServiceToken = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

const serviceTokenKey = () =>
  createHash("sha256")
    .update(`bonob:subsonic-service-token:${process.env["BNB_SECRET"] || ""}`)
    .digest();

const encryptedServiceToken = (credentials: Credentials): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(SERVICE_TOKEN_ALGORITHM, serviceTokenKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const encrypted: EncryptedServiceToken = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return `${SERVICE_TOKEN_PREFIX}${b64Encode(JSON.stringify(encrypted))}`;
};

const parseEncryptedServiceToken = (token: string): Credentials => {
  if (!token.startsWith(SERVICE_TOKEN_PREFIX)) {
    throw new Error("Not an encrypted service token");
  }
  const parsed = JSON.parse(
    b64Decode(token.slice(SERVICE_TOKEN_PREFIX.length))
  ) as Partial<EncryptedServiceToken>;
  if (
    parsed.v !== 1 ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted service token");
  }
  const decipher = createDecipheriv(
    SERVICE_TOKEN_ALGORITHM,
    serviceTokenKey(),
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
  );
};

export const asToken = (credentials: Credentials) =>
  encryptedServiceToken(credentials);

export const parseToken = (token: string): Credentials => {
  try {
    return parseEncryptedServiceToken(token);
  } catch (e) {
    if (token.startsWith(SERVICE_TOKEN_PREFIX)) throw e;
    return JSON.parse(b64Decode(token));
  }
};

// Freeze a summary AND its immediate object-valued fields (the BUrn image / coverArt,
// the Genre) so a shared cached entry can't be mutated in place by any caller.
function deepFreezeSummary<T extends object>(o: T): T {
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") Object.freeze(v);
  }
  Object.freeze(o);
  return o;
}

export class Subsonic {
  url: URLBuilder;
  customPlayers: CustomPlayers;
  externalImageFetcher: ImageFetcher;
  // Opt-in artist art from Deezer (read from config); public so the music library can thread it
  // through to artistImageURN for the artist-detail and search paths.
  readonly preferDeezerArtistArt: boolean;
  private cache: SwrCache;
  private indexCache: SwrCache;

  // Bounds and coalesces getCoverArt across all libraries on this instance (see CoverArtCoordinator).
  private coverArtCoordinator: CoverArtCoordinator;

  private readonly maxIndexScanAlbums: number;

  // Directory for the disk-backed album snapshot (Slice 1). When set, buildAlbumIndex streams each
  // scanned record to an immutable snapshot file and keeps only buckets + a Uint32Array of byte
  // offsets resident (O(buckets + offsets), not O(albums)). Undefined → in-memory build (no cache
  // volume configured: nothing is persisted and the resident snapshot is acceptable).
  private readonly albumSnapshotDir: string | undefined;

  constructor(
    url: URLBuilder,
    customPlayers: CustomPlayers = NO_CUSTOM_PLAYERS,
    externalImageFetcher: ImageFetcher = axiosImageFetcher,
    cache: SwrCache = SwrCache.disabled(),
    // Separate cache for the album index: it is a heavy (~N/500 request) full-catalog scan that
    // changes only on a library scan, so it must have a much longer TTL than the browse cache
    // (otherwise it would re-scan on every stale browse). Defaults to the browse cache.
    indexCache: SwrCache = cache,
    preferDeezerArtistArt: boolean = false,
    // Cover-art coordination options: an optional test/config object so tests can exercise real
    // coordinator behaviour (concurrency cap, queue depth, queue wait) without poking private
    // fields. All existing positional callers are preserved.
    coverArtCoordinatorOptions: CoverArtCoordinatorOptions = {},
    // Upper bound on the one-time album index scan. Injectable so the truncation guard can be
    // tested without mocking millions of albums, and env-overridable so a very large catalog can
    // be raised without a rebuild.
    maxIndexScanAlbums: number = DEFAULT_MAX_INDEX_SCAN_ALBUMS,
    // Directory on the cache volume for the disk-backed album snapshot (Slice 1). Injected from
    // app.ts so it shares the index cache volume with the persisted store. Defaults to undefined
    // (in-memory build) so existing test/non-cache callers are unchanged.
    albumSnapshotDir: string | undefined = undefined
  ) {
    this.maxIndexScanAlbums = maxIndexScanAlbums;
    this.albumSnapshotDir = albumSnapshotDir;
    this.url = url;
    this.customPlayers = customPlayers;
    this.externalImageFetcher = externalImageFetcher;
    this.preferDeezerArtistArt = preferDeezerArtistArt;
    this.cache = cache;
    this.indexCache = indexCache;
    // One coordinator per Subsonic instance, shared by every logged-in library using it. The key
    // includes the credential scope so distinct users never share a result, while identical
    // concurrent requests for the SAME user/art/size coalesce onto one upstream call.
    this.coverArtCoordinator = new CoverArtCoordinator(coverArtCoordinatorOptions);
  }

  private get = async (
    { username, password }: Credentials,
    path: string,
    q: {} = {},
    config: AxiosRequestConfig | undefined = {}
  ) =>
    axios
      .get(this.url.append({ pathname: path }).href(), {
        params: asURLSearchParams({
          u: username,
          v: "1.16.1",
          c: DEFAULT_CLIENT_APPLICATION,
          ...t_and_s(password),
          ...q,
        }),
        headers: {
          "User-Agent": USER_AGENT,
        },
        ...config,
      })
      .then((response) => {
        if (response.status != 200 && response.status != 206) {
          throw `Subsonic failed with a ${response.status || "no!"} status`;
        } else return response;
      });

  private post = async (
    { username, password }: Credentials,
    path: string,
    q: {} = {},
    headers: {} = {},
    body: any = {},
    config: AxiosRequestConfig | undefined = {}
  ) =>
    axios
      .post(this.url.append({ pathname: path }).href(), body, {
        params: asURLSearchParams({
          u: username,
          v: "1.16.1",
          c: DEFAULT_CLIENT_APPLICATION,
          ...t_and_s(password),
          ...q,
        }),
        headers: {
          "User-Agent": USER_AGENT,
          ...headers
        },
        ...config,
      })
      .then((response) => {
        if (response.status != 200) {
          throw `Subsonic POST failed with a ${response.status || "no!"} status`;
        } else return response;
    });

  private getJSON = async <T>(
    { username, password }: Credentials,
    path: string,
    q: {} = {}
  ): Promise<T> =>
    this.get({ username, password }, path, { f: "json", ...q })
      .then((response) => response.data as SubsonicEnvelope)
      .then((json) => json["subsonic-response"])
      .then((json) => {
        if (isError(json)) throw `Subsonic error:${json.error.message}`;
        else return json as unknown as T;
      });

  // Retry a READ once on a transient transport failure (network error / 5xx). Never on a 4xx or a
  // Subsonic app-level error. The GET-based mutations (star/unstar/setRating/scrobble) stay on plain
  // getJSON below and are NOT routed through here, so they are never retried.
  private getJSONWithRetry = async <T>(
    credentials: Credentials,
    path: string,
    q: {} = {}
  ): Promise<T> => {
    try {
      return await this.getJSON<T>(credentials, path, q);
    } catch (e) {
      if (!isRetryableSubsonicError(e)) throw e;
      return this.getJSON<T>(credentials, path, q);
    }
  };

  private postJSON = async <T>(
    credentials: Credentials,
    path: string,
    q: {} = {},
    body: any = {}
  ): Promise<T> =>
    this.post(
        credentials, 
        path, 
        { f: "json", ...q }, 
        { "Content-Type": "application/json" }, 
        body
      )
      .then((response) => response.data as SubsonicEnvelope)
      .then((json) => json["subsonic-response"])
      .then((json) => {
        if (isError(json)) throw `Subsonic error:${json.error.message}`;
        else return json as unknown as T;
      });

  ping = (credentials: Credentials): TE.TaskEither<AuthFailure, { authenticated: Boolean, type: string}> => 
    pipe(
      TE.tryCatch(
        () => this.getJSON<PingResponse>(credentials, "/rest/ping.view"),
        (e) => new AuthFailure(String(e))
      ),
      TE.chain(it =>
        it.status === "ok"
          ? TE.right({ authenticated: true, type: it.type })
          : TE.left(new AuthFailure("Not authenticated, status not 'ok'"))
      )
    );

  private fetchArtists = (
    credentials: Credentials
  ): Promise<(IdName & { albumCount: number; image: BUrn | undefined })[]> =>
    this.getJSONWithRetry<GetArtistsResponse>(credentials, "/rest/getArtists")
      .then((it) => (it.artists.index || []).flatMap((it) => it.artist || []))
      .then((artists) => {
        // Deep-frozen: this array + its objects are shared across every cache hit and user,
        // so a caller mutating in place (sort/splice/decorate) would corrupt the cache.
        // Current callers treat it read-only (slice2 copies, getAlbumList2 reduces).
        const mapped = artists.map((artist) =>
          deepFreezeSummary({
            id: `${artist.id}`,
            name: artist.name,
            albumCount: artist.albumCount,
            image: artistImageURN(
              {
                artistId: artist.id,
                artistImageURL: artist.artistImageUrl,
                name: artist.name,
              },
              this.preferDeezerArtistArt
            ),
          })
        );
        Object.freeze(mapped);
        return mapped;
      });

  // The full artist list is large (~10MB / ~8s on big libraries) and bonob re-fetches it on
  // every Sonos browse page (getAlbumList2 also uses it for its total). SwrCache serves it
  // stale-while-revalidate, so once warm EVERY browse is instant (a cold ~8s fetch on the
  // browse path exceeds Sonos's SMAPI timeout), coalesces concurrent Sonos pages onto one
  // fetch, and is bounded/hardened. Keyed per user (Navidrome has per-user library ACLs).
  getArtists = (
    credentials: Credentials
  ): Promise<(IdName & { albumCount: number; image: BUrn | undefined })[]> =>
    this.cache.get(`artists:${credentials.username}`, () =>
      this.fetchArtists(credentials)
    );

  // Pre-warm the artist list (the ~8s cold fetch behind both the Artists browse AND the album
  // total) in the background, so the first browse of a session isn't cold. Called on login, so
  // the warm has a head start before the user drills into a section. Safe to call often: the
  // cache coalesces and only re-fetches when stale.
  warmArtists = (credentials: Credentials): void =>
    this.cache.warm(`artists:${credentials.username}`, () =>
      this.fetchArtists(credentials)
    );

  // Total album count, summed from the (cached) artist list - the same source getAlbumList2 uses
  // for its total. Cheap once getArtists is warm (no extra network). Used to decide whether the
  // catalog is large enough to need the bucketed A-Z index; small libraries skip it entirely.
  albumCount = (credentials: Credentials): Promise<number> =>
    this.getArtists(credentials).then((artists) =>
      _.inject(artists, (total, artist) => total + artist.albumCount, 0)
    );

  // Non-blocking peek at the album count: undefined when the artist list is not warm yet, so a live
  // Albums browse can avoid a multi-second cold getArtists; otherwise the already-resolved count.
  peekAlbumCount = (credentials: Credentials): Promise<number> | undefined =>
    this.cache
      .peek<(IdName & { albumCount: number })[]>(
        `artists:${credentials.username}`
      )
      ?.then((artists) =>
        _.inject(artists, (total, artist) => total + artist.albumCount, 0)
      );

  // Non-blocking peek at the artist list itself: the settled cached list, or undefined when it is
  // in-flight or cold. Lets a cold Artists browse fall back to a placeholder rather than block on
  // the multi-second full-artist fetch (which would blow Sonos's ~5s timeout).
  peekArtists = (credentials: Credentials): Promise<unknown> | undefined =>
    this.cache.peek(`artists:${credentials.username}`);

  // Raw, un-cached page of album summaries in alphabeticalByName order (used only by the index
  // scan). The scan captures the summaries themselves - not just names/offsets - so the index is a
  // self-contained SNAPSHOT: serving a letter never re-fetches by live offset, which would drift
  // when Navidrome re-scans and reorders the catalog.
  private scanAlbums = (
    credentials: Credentials,
    offset: number
  ): Promise<AlbumSummary[]> =>
    this.getJSONWithRetry<GetAlbumListResponse>(credentials, "/rest/getAlbumList2", {
      type: "alphabeticalByName",
      size: 500,
      offset,
    }).then((r) => (r.albumList2.album || []).map(asAlbumSummary));

  // Build the alphabetical album index by scanning the whole catalog once (500/page). Heavy
  // (~N/500 requests), so it is only ever run behind the cache (getAlbumIndex) as a background
  // job - never inline on a live browse. A safety cap stops a runaway scan.
  //
  // Slice 1: when a snapshot directory is configured the scan STREAMS each record to an immutable
  // on-disk snapshot file (one append per album, buffered) and keeps only the bucket table + a
  // Uint32Array of per-record byte offsets resident — so a multi-million-album catalog no longer
  // holds its whole ~474 B/album snapshot in memory. Without a directory it falls back to the old
  // resident build (nowhere to persist, and that path is only used by tests/cache-disabled setups).
  // The truncation + duplicate-id guards apply to both paths.
  private buildAlbumIndex = async (
    credentials: Credentials
  ): Promise<AlbumIndex<AlbumSummary>> => {
    const cacheKey = `albumIndex:v3:${credentials.username}`;
    const seen = new Set<string>();
    const builder = new BucketBuilder<AlbumSummary>();
    const writer = this.albumSnapshotDir
      ? new AlbumSnapshotWriter(this.albumSnapshotDir, cacheKey)
      : undefined;
    // `items` is only collected for the resident (no-directory) build; the disk build leaves it
    // empty and serves pages from the snapshot file via readAlbumIndexPage/readAlbumIndexAll.
    const items: AlbumSummary[] | undefined = writer ? undefined : [];
    if (writer) await writer.open();
    // One async write per album is fine: the writer buffers ~64 KiB internally, and the scan is
    // dominated by its (~N/500) HTTP round trips, not local I/O.
    const ingest = async (album: AlbumSummary): Promise<void> => {
      builder.append(album);
      if (writer) await writer.write(album);
      else items!.push(album);
    };
    let complete = false;
    try {
      for (let offset = 0; offset < this.maxIndexScanAlbums; offset += ALBUM_SCAN_PAGE_SIZE) {
        const page = await this.scanAlbums(credentials, offset);
        if (page.length === 0) {
          complete = true;
          break;
        }
        for (const album of page) {
          if (seen.has(album.id)) {
            throw new Error(
              `Inconsistent album index scan: duplicate album id '${album.id}' at offset ${offset}`
            );
          }
          seen.add(album.id);
          await ingest(album);
        }
        if (page.length < ALBUM_SCAN_PAGE_SIZE) {
          complete = true;
          break;
        }
      }
      // Exactly-at-the-cap is a COMPLETE catalog, not a truncated one. The loop runs while
    // `offset < cap`, so a catalog of exactly `cap` albums fills every page and the loop runs out of
    // offsets without ever observing the end - indistinguishable, so far, from a catalog that
    // overflows. One extra probe settles it: an empty page at `cap` means we really did reach the
    // end. The default cap is a multiple of the page size, so this is reachable, not theoretical.
    if (!complete) {
      const probe = await this.scanAlbums(credentials, this.maxIndexScanAlbums);
      if (probe.length === 0) complete = true;
    }

    // Hitting the safety cap is NOT a successful scan. Previously the loop simply ended and the
      // partial result was returned, cached and persisted as if it were the whole catalog: every
      // album past the cap vanished from the A-Z menu and `total` was wrong, with nothing logged.
      // Silent truncation at exactly the scale this cap exists for is worse than refusing - refusing
      // leaves the previous good index in place and says why, which is what the duplicate-id guard
      // above already does for the other way a scan can be untrustworthy. The writer is aborted
      // (below) so a half-written snapshot file is never left behind to be read as complete.
      if (!complete) {
        throw new Error(
          `Album index scan hit its ${this.maxIndexScanAlbums}-album safety cap before reaching the end of the catalog; refusing to cache a truncated index. Raise BNB_MAX_INDEX_SCAN_ALBUMS.`
        );
      }
      if (writer) {
        const { snapshotFile, offsets } = await writer.finalize(builder.buckets);
        return {
          total: builder.total,
          buckets: builder.buckets,
          items: [],
          snapshotFile,
          offsets,
        };
      }
      return { total: builder.total, buckets: builder.buckets, items: items! };
    } catch (e) {
      if (writer) await writer.abort();
      throw e;
    }
  };

  // Cached + persisted alphabetical album index (SwrCache, keyed per user). Serves the bucketed
  // "Albums -> A-Z" browse so no single container advertises the huge global album total.
  getAlbumIndex = (
    credentials: Credentials
  ): Promise<AlbumIndex<AlbumSummary>> =>
    this.indexCache.get(`albumIndex:v3:${credentials.username}`, () =>
      this.buildAlbumIndex(credentials)
    );

  // Peek the album index without triggering a (multi-minute) scan - lets the browse path fall
  // back gracefully while the index is still building on first use. Returns the (already
  // resolved) promise when warm, or undefined when not yet available.
  peekAlbumIndex = (
    credentials: Credentials
  ): Promise<AlbumIndex<AlbumSummary>> | undefined =>
    this.indexCache.peek<AlbumIndex<AlbumSummary>>(
      `albumIndex:v3:${credentials.username}`
    );

  // Kick the index build in the background (on login) so it is ready before the user opens Albums.
  warmAlbumIndex = (credentials: Credentials): void =>
    this.indexCache.warm(`albumIndex:v3:${credentials.username}`, () =>
      this.buildAlbumIndex(credentials)
    );

      // todo: should be getArtistInfo2?
  getArtistInfo = (
    credentials: Credentials,
    id: string
  ): Promise<{
    biography: string | undefined;
    similarArtist: (ArtistSummary & { inLibrary: boolean })[];
    images: {
      s: string | undefined;
      m: string | undefined;
      l: string | undefined;
    };
  }> =>
    this.getJSONWithRetry<GetArtistInfoResponse>(credentials, "/rest/getArtistInfo2", {
      id,
      count: 50,
      includeNotPresent: true,
    })
      .then((it) => it.artistInfo2)
      .then((it) => ({
        biography: it.biography,
        images: {
          s: it.smallImageUrl,
          m: it.mediumImageUrl,
          l: it.largeImageUrl,
        },
        //todo: this does seem to be in OpenSubsonic?? it is also singular
        similarArtist: (it.similarArtist || []).map((artist) => ({
          id: `${artist.id}`,
          name: artist.name,
          // todo: whats this inLibrary used for? it probably should be filtered on??
          inLibrary: artistIsInLibrary(artist.id),
          image: artistImageURN({
            artistId: artist.id,
            artistImageURL: artist.artistImageUrl,
          }),
        })),
        })
      );

  getAlbum = (credentials: Credentials, id: string): Promise<Album>  =>
    this.getJSONWithRetry<GetAlbumResponse>(credentials, "/rest/getAlbum", { id })
      .then((it) => it.album)
      .then((album) => {
        const x: AlbumSummary = {
          id: album.id,
          name: album.name,
          year: album.year,
          genre: maybeAsGenre(album.genre),
          artistId: album.artistId,
          artistName: album.artist,
          coverArt: coverArtURN(album.coverArt)
        }
        return { summary: x, songs: album.song }
      }).then(({ summary, songs }) => {
        const x: AlbumSummary = summary
        const y: Track[] = songs.map((it) => asTrack(summary, it, this.customPlayers))
        return {
          ...x,
          tracks: y
        };
      });
   
  getArtist = (
    credentials: Credentials,
    id: string
  ): Promise<
    IdName & { artistImageUrl: string | undefined; albums: AlbumSummary[] }
  > =>
    this.getJSONWithRetry<GetArtistResponse>(credentials, "/rest/getArtist", {
      id,
    })
      .then((it) => it.artist)
      .then((it) => ({
        id: it.id,
        name: it.name,
        artistImageUrl: it.artistImageUrl,
        albums: this.toAlbumSummary(it.album || []),
      }));

  getCoverArt = (credentials: Credentials, id: string, size?: number) => {
    // Route through the per-instance coordinator: identical concurrent requests for the same
    // user/art/size coalesce onto ONE upstream call, and distinct requests are bounded
    // (concurrency cap + FIFO queue). The coordinator does NOT retry, so a 429/5xx failure
    // releases the slot and a later identical request starts a fresh upstream call.
    // Normalize ONCE, then use the same value for both the coalescing key and the request. These
    // were normalized separately and disagreed: the key mapped any non-positive size to 0 while the
    // request sent the raw value, so getCoverArt(id, -5) and getCoverArt(id) shared a key but asked
    // the server for different things - whichever landed first served both. Infinity was worse
    // still, being truthy it reached the wire as "size=Infinity". /art rejects size <= 0 today so
    // this was latent, but getCoverArt is public and must not rely on a caller-side guard.
    const effectiveSize = normalizedCoverArtSize(size);
    const key = coverArtKey(credentials.username, credentials.password, id, effectiveSize);
    const fetch = () =>
      this.get(credentials, "/rest/getCoverArt", effectiveSize ? { id, size: effectiveSize } : { id }, {
        headers: { "User-Agent": "bonob" },
        responseType: "arraybuffer",
        // getCoverArt is small + high-volume: give it its own bound shorter than the global 30s
        // timeout so a hung/throttled server frees the coordinator slot promptly. Headers,
        // params, and the arraybuffer behaviour are unchanged.
        timeout: SUBSONIC_COVER_ART_HTTP_TIMEOUT_MS,
      });
    return this.coverArtCoordinator.run(key, fetch);
  };

  getTrack = (credentials: Credentials, id: string) =>
    this.getJSONWithRetry<GetSongResponse>(credentials, "/rest/getSong", {
      id,
    })
      .then((it) => it.song)
      .then((song) =>
        this.getAlbum(credentials, song.albumId!).then((album) =>
          asTrack(albumToAlbumSummary(album), song, this.customPlayers)
        )
      );

  getStarred = (credentials: Credentials) =>
    this.getJSONWithRetry<GetStarredResponse>(credentials, "/rest/getStarred2").then(
      (it) => new Set(it.starred2.song.map((it) => it.id))
    );

  // The user's starred/favourite tracks as playable summaries (Favourite Songs section). getStarred2
  // is per-user and volatile, so it is fetched live (never cached).
  starredSongs = (credentials: Credentials) =>
    this.getJSONWithRetry<GetStarredResponse>(credentials, "/rest/getStarred2").then((it) =>
      (it.starred2.song || []).map((s) => asTrackSummary(s, this.customPlayers))
    );

  // Map complete song records straight to Tracks, resolving each album from the song itself. The
  // counterpart to toAlbumSummary, and the reason a song listing needs no per-song round trips.
  toTracks = (songs: song[]): Track[] =>
    songs.map((song) =>
      asTrack(albumSummaryFromSong(song), song, this.customPlayers)
    );

  toAlbumSummary = (albumList: album[]): AlbumSummary[] =>
    albumList.map((album) => ({
      id: album.id,
      name: album.name,
      year: album.year,
      genre: maybeAsGenre(album.genre),
      artistId: album.artistId,
      artistName: album.artist,
      coverArt: coverArtURN(album.coverArt),
    }));

  search3 = (credentials: Credentials, q: any) =>
    this.getJSONWithRetry<Search3Response>(credentials, "/rest/search3", {
      artistCount: 0,
      albumCount: 0,
      songCount: 0,
      ...q,
    }).then((it) => ({
      artists: it.searchResult3.artist || [],
      albums: it.searchResult3.album || [],
      songs: it.searchResult3.song || [],
    }));

  private fetchAlbumListPage = (
    credentials: Credentials,
    q: AlbumQuery
  ): Promise<AlbumSummary[]> =>
    this.getJSONWithRetry<GetAlbumListResponse>(credentials, "/rest/getAlbumList2", {
      type: AlbumQueryTypeToSubsonicType[q.type],
      ...(q.genre ? { genre: b64Decode(q.genre) } : {}),
      ...(q.fromYear ? { fromYear: q.fromYear } : {}),
      ...(q.toYear ? { toYear: q.toYear } : {}),
      size: 500,
      offset: q._index,
    })
      .then((response) => response.albumList2.album || [])
      .then(this.toAlbumSummary)
      .then((albums) => {
        albums.forEach(deepFreezeSummary);
        Object.freeze(albums);
        return albums;
      });

  // Cache each album-list page too: deep offsets get slower (Navidrome's SQLite OFFSET scan).
  // Keyed per user + query so sections / pages / filters cache independently; SwrCache bounds
  // and stale-while-revalidates them. Only unfiltered alphabetical lists need the expensive
  // whole-catalog total from getArtists; filtered/volatile lists advertise a bounded incremental
  // total from the page itself so cold browses do not wait on the artist list.
  getAlbumList2 = async (credentials: Credentials, q: AlbumQuery) => {
    const cachedPage = () =>
      this.cache.get(
        `albumPage:${credentials.username}:${q.type}:${q._index}:${q.genre ?? ""}:${q.fromYear ?? ""}:${q.toYear ?? ""}`,
        () => this.fetchAlbumListPage(credentials, q)
      );
    // Only the unfiltered alphabetical list needs the true whole-catalog total (from the cached
    // getArtists sum); keep its original getArtists+page fetch. Filtered/secondary lists
    // (genre/year/recent/random/starred/...) must NOT wait on the (multi-second, cold) artist list
    // - a full page there would also claim the ~107k catalog and S2 rejects the oversized
    // container - so they advertise a bounded "there may be one more page" total from the page.
    if (q.type === "alphabeticalByName" || q.type === "alphabeticalByArtist") {
      const [total, albums] = await Promise.all([
        this.getArtists(credentials).then((it) =>
          _.inject(it, (total, artist) => total + artist.albumCount, 0)
        ),
        cachedPage(),
      ]);
      const results = albums.slice(0, q._count);
      return {
        results,
        total: albums.length == 500 ? total : q._index + albums.length,
      };
    }
    const albums = await (VOLATILE_ALBUM_TYPES.has(q.type)
      ? this.fetchAlbumListPage(credentials, q)
      : cachedPage());
    const results = albums.slice(0, q._count);
    return {
      results,
      total:
        q._index +
        results.length +
        (results.length >= q._count ? q._count : 0),
    };
  };

  getGenres = (credentials: Credentials) =>
    this.getJSONWithRetry<GetGenresResponse>(credentials, "/rest/getGenres").then((it) =>
      pipe(
        it.genres.genre || [],
        A.filter((it) => it.albumCount > 0),
        A.map((it) => it.value),
        A.sort(ordString),
        A.map(maybeAsGenre),
        A.filter((it) => it != undefined)
      )
    );

  private st4r = (credentials: Credentials, action: string,  { id } : { id: string }) => 
    this.getJSON<SubsonicResponse>(credentials, `/rest/${action}`, { id }).then(it => 
      it.status == "ok"
    );

  star = (credentials: Credentials, ids : { id: string }) => 
    this.st4r(credentials, "star", ids)

  unstar = (credentials: Credentials, ids : { id: string }) => 
    this.st4r(credentials, "unstar", ids)

  setRating = (credentials: Credentials, id: string, rating: number) => 
    this.getJSON<SubsonicResponse>(credentials, `/rest/setRating`, {
      id,
      rating,
    })
    .then(it => it.status == "ok");

  scrobble = (credentials: Credentials, id: string, submission: boolean) =>
    this.getJSON<SubsonicResponse>(credentials, `/rest/scrobble`, {
        id,
        submission,
      })
      .then(it => it.status == "ok")

  stream = (credentials: Credentials, id: string, c: string, range: string | undefined) =>
    this.get(
      credentials,
      `/rest/stream`,
      {
        id,
        c,
      },
      {
        headers: pipe(
          range,
          O.fromNullable,
          O.map((range) => ({
            "User-Agent": USER_AGENT,
            Range: range,
          })),
          O.getOrElse(() => ({
            "User-Agent": USER_AGENT,
          }))
        ),
        responseType: "stream",
      }
    )
    .then((stream) => ({
      status: stream.status,
      headers: {
        "content-type": headerString(stream.headers["content-type"]),
        "content-length": headerString(stream.headers["content-length"]),
        "content-range": headerString(stream.headers["content-range"]),
        "accept-ranges": headerString(stream.headers["accept-ranges"]),
      },
      stream: stream.data,
    }));

  getTranscodeDecision = async (
    credentials: Credentials,
    mediaId: string,
    clientInfo: ClientInfo
  ): Promise<TranscodeDecision> =>
    this.postJSON<GetTranscodeDecisionResponse>(
      credentials,
      `/rest/getTranscodeDecision`,
      { mediaId, mediaType: "song" },
      clientInfo
    )
    .then((json) => json.transcodeDecision);

  getTranscodeStream = (
    credentials: Credentials,
    mediaId: string,
    transcodeParams: string,
    range: string | undefined
  ) =>
    this.get(
      credentials,
      `/rest/getTranscodeStream`,
      {
        mediaId,
        mediaType: "song",
        transcodeParams,
      },
      {
        headers: pipe(
          range,
          O.fromNullable,
          O.map((range) => ({
            "User-Agent": USER_AGENT,
            Range: range,
          })),
          O.getOrElse(() => ({
            "User-Agent": USER_AGENT,
          }))
        ),
        responseType: "stream",
      }
    )
    .then((stream) => ({
      status: stream.status,
      headers: {
        "content-type": headerString(stream.headers["content-type"]),
        "content-length": headerString(stream.headers["content-length"]),
        "content-range": headerString(stream.headers["content-range"]),
        "accept-ranges": headerString(stream.headers["accept-ranges"]),
      },
      stream: stream.data,
    }));

  playlists = (credentials: Credentials) =>
    this.getJSONWithRetry<GetPlaylistsResponse>(credentials, "/rest/getPlaylists")
    .then(({ playlists }) => (playlists.playlist || []).map( it => ({
        id: it.id,
        name: it.name,
        coverArt: coverArtURN(it.coverArt),
      }))
    );

  playlist = (credentials: Credentials, id: string) =>
    this.getJSONWithRetry<GetPlaylistResponse>(credentials, "/rest/getPlaylist", {
      id,
    })
    .then(({ playlist }) => {
      let trackNumber = 1;
      return {
        id: playlist.id,
        name: playlist.name,
        coverArt: coverArtURN(playlist.coverArt),
        entries: (playlist.entry || []).map((entry) => ({
          ...asTrack(
            {
              id: entry.albumId!,
              name: entry.album!,
              year: entry.year,
              genre: maybeAsGenre(entry.genre),
              artistName: entry.artist,
              artistId: entry.artistId,
              coverArt: coverArtURN(entry.coverArt),
            },
            entry,
            this.customPlayers
          ),
          number: trackNumber++,
        })),
      };
    });

    createPlayList = (credentials: Credentials, name: string) =>
      // createPlaylist is a MUTATION (despite using GET + returning a playlist), so it must NOT be
      // retried - a transient blip after the server already created it would double-create.
      this.getJSON<GetPlaylistResponse>(credentials, "/rest/createPlaylist", {
        name,
      })
      .then(({ playlist }) => ({
        id: playlist.id,
        name: playlist.name,
        coverArt: coverArtURN(playlist.coverArt),
      }));

    deletePlayList = (credentials: Credentials, id: string) => 
      this.getJSON<SubsonicResponse>(credentials, "/rest/deletePlaylist", {
        id,
      })
      .then(it => it.status == "ok");

    updatePlaylist = (
      credentials: Credentials, 
      playlistId: string, 
      changes : Partial<{ songIdToAdd: string | undefined, songIndexToRemove: number[] | undefined }> = {}
    ) => 
      this.getJSON<SubsonicResponse>(credentials, "/rest/updatePlaylist", {
        playlistId,
        ...changes
      })
      .then(it => it.status == "ok");

    getSimilarSongs2 = (credentials: Credentials, id: string) =>
      this.getJSONWithRetry<GetSimilarSongsResponse>(
        credentials,
        "/rest/getSimilarSongs2",
        //todo: remove this hard coded 50?
        { id, count: 50 }
      )
      .then((it) => 
        (it.similarSongs2.song || []).map(it => asTrackSummary(it, this.customPlayers))
      );

    getTopSongs = (credentials: Credentials, artist: string) =>
      this.getJSONWithRetry<GetTopSongsResponse>(
        credentials,
        "/rest/getTopSongs",
        //todo: remove this hard coded 50?
        { artist, count: 50 }
      )
      .then((it) => 
        (it.topSongs.song || []).map(it => asTrackSummary(it, this.customPlayers))
      );

  getInternetRadioStations = (credentials: Credentials) =>
    this.getJSONWithRetry<GetInternetRadioStationsResponse>(
      credentials,
      "/rest/getInternetRadioStations"
    )
    .then((it) => it.internetRadioStations.internetRadioStation || [])
    .then((stations) =>
      stations.map((it) => ({
        id: it.id,
        name: it.name,
        url: it.streamUrl,
        homePage: it.homePageUrl,
      }))
    );

  getOpenSubsonicExtensions = (credentials: Credentials): Promise<OpenSubsonicExtension[]> =>
    this.getJSONWithRetry<GetOpenSubsonicExtensionsResponse>(
      credentials,
      "/rest/getOpenSubsonicExtensions.view"
    )
    .then((it) => it.openSubsonicExtensions || [])
    .catch((e: unknown) => {
      if (axios.isAxiosError(e) && e.response?.status === 404) return [];
      throw e
    });
};
