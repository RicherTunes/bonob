import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { SwrCacheStore } from "./swr_cache";
import logger from "./logger";
import {
  AlbumIndex,
  AlbumIndexBucket,
  albumIndexPage,
  albumIndexAll,
  albumIndexRangesFor,
} from "./album_index";

// Slice 1: disk-backed index snapshots, shared by the ALBUM and ARTIST indexes.
//
// Each index used to hold its entire scanned snapshot (`AlbumIndex.items`) in memory — about
// 474 B/album (albums) / ~400-600 B/artist (artists), which crosses the container limit around
// 900k albums / ~860k artists. This module moves the records to disk and keeps only the bucket
// table + a Uint32Array of per-record byte offsets resident, so resident memory is
// O(buckets + offsets) rather than O(records). Serving a browse page does one async read of just
// that page's contiguous byte range.
//
// The album and artist indexes share the SAME structural format and the SAME directory; only three
// per-kind knobs differ (see SnapshotKind): the filename prefix, the trailer version (which mirrors
// the cache-key version), and the one kind-specific payload field persisted in the trailer (album
// `years`, artist `totalAlbumCount`). Generalizing — rather than writing a parallel artist
// implementation — is deliberate: the writer, the trailer + magic footer, generation-token
// retention, the global byte cap, the short-read and boundary guards, and the atomic swap are all
// genuinely identical, and a second copy would drift.
//
// FILE FORMAT (one immutable file per build, text — NOT a binary format):
//
//   <record0>\n <record1>\n ... <recordN-1>\n   each record is one summary as JSON
//   <trailer>                                   one JSON object (see SnapshotTrailer), UTF-8
//   <footer>                                    8 bytes: uint32LE trailerByteLen, uint32LE magic
//
// The 8-byte footer is structural metadata to locate the text trailer; the records themselves are
// JSON text. A trailer holds { v, key, at, total, buckets, offsets, <payloadField>? } where offsets
// is the (total+1) per-record byte offsets and <payloadField> is the kind-specific payload (album
// `years`, artist `totalAlbumCount`). The footer lets a reader find the trailer in two small
// positional reads (stat + read-last-8 + read-trailer) without scanning the records.
//
// DRIFT IS IMPOSSIBLE: each build writes a NEW, uniquely-named, never-overwritten file. The
// `AlbumIndex` an in-flight browse holds references its own immutable file path + the offsets that
// were built from that exact file, so an offset always resolves against the bytes it describes. A
// rebuild produces a new file and a new `AlbumIndex`; the old one keeps reading its old file (which
// is only deleted best-effort once it is no longer the newest, see enforceSnapshotBounds).

// The structural footer magic is shared by every kind: it only asserts "this is a snapshot file of
// SOME kind"; the filename prefix disambiguates WHICH kind. One constant keeps the read path simple.
const SNAPSHOT_MAGIC = 0xb0b0_a17e;

// Version + magic per kind. The version mirrors the SwrCache key bump (albumIndex:v3 / artists:v2)
// so a persisted file from a mismatched key version is never misread as this format.
export const ALBUM_SNAPSHOT_VERSION = 3;
export const ARTIST_SNAPSHOT_VERSION = 2;

// The per-kind layer over the shared structural format. Three knobs differ between album and artist
// snapshots; everything else (records + trailer + footer, generation token, retention, guards) is
// identical and shared.
export type SnapshotKind = {
  // Filename stem prefix, e.g. "albumSnapshot.v3." / "artistSnapshot.v2.". A store/loader only ever
  // recognises its own prefix, so an album reader never touches an artist file (and vice versa).
  prefix: string;
  // Trailer version. Mirrors the cache-key version so a persisted file from a mismatched key is
  // refused rather than misread.
  version: number;
  // The trailer field name carrying this kind's payload ("years" / "totalAlbumCount"). The writer
  // stores the payload under this key; the validator reads + checks it under this key. Kept as a
  // real named field (not an opaque blob) so the album file format is byte-for-byte unchanged.
  payloadField: string;
  // Validate the kind-specific payload read from a parsed trailer. Return null to REFUSE the file
  // (corruption); return undefined when the field is legitimately absent (back-compat); else the
  // typed payload.
  validatePayload: (raw: unknown) => unknown | null;
  // Apply the validated payload to the reconstructed resident index (set idx.years / idx.totalAlbumCount).
  applyPayload: (index: AlbumIndex<any>, payload: unknown) => void;
  // Normalize the payload on the way OUT. The reader coerces too, and BOTH are wanted: the reader
  // must cope with files this process did not write (every existing file has NUMERIC years), and
  // the writer must stop producing them so a rollback to an older reader is not re-armed. Keeping
  // only one side is what re-introduced the outage during a merge.
  normalizePayload?: (payload: unknown) => unknown;
};

export const ALBUM_KIND: SnapshotKind = {
  prefix: "albumSnapshot.v3.",
  version: ALBUM_SNAPSHOT_VERSION,
  payloadField: "years",
  validatePayload: (raw) => {
    // OPTIONAL: a v3 file written before this field existed has none (and validates fine), so no
    // version bump is needed. A present-but-malformed value means corruption → refused.
    if (raw === undefined) return undefined;
    // Each entry must be a string OR a finite number, and numbers are COERCED rather than
    // refused. Requiring string[] here was an outage-grade bug: Navidrome returns `year` as a JSON
    // number while album.year is typed string, so the writer emitted numeric years and this
    // validator rejected the trailer it had just written - load() returned zero entries and every
    // restart discarded a valid 30MB index for a ~17-minute rescan, silently. Verified against the
    // live file: all 113 years were numbers. Generalizing this validator re-introduced the bug by
    // branching before the fix, so it is pinned by a test that writes NUMERIC years.
    if (
      !Array.isArray(raw) ||
      !(raw as unknown[]).every(
        (y) => typeof y === "string" || (typeof y === "number" && Number.isFinite(y))
      )
    )
      return null;
    return (raw as unknown[]).map((y) => String(y));
  },
  applyPayload: (index, payload) => {
    index.years = payload as string[] | undefined;
  },
  normalizePayload: (payload) =>
    payload === undefined ? undefined : (payload as unknown[]).map((y) => String(y)),
};

export const ARTIST_KIND: SnapshotKind = {
  prefix: "artistSnapshot.v2.",
  version: ARTIST_SNAPSHOT_VERSION,
  payloadField: "totalAlbumCount",
  validatePayload: (raw) => {
    // OPTIONAL: a resident (no-directory) artist index never writes a snapshot, so there is no
    // back-compat concern, but the field is still optional on the trailer for symmetry with years.
    if (raw === undefined) return undefined;
    // A bad total DOWNGRADES to absent rather than refusing the file. Refusing would discard a
    // perfectly good artist index over one unusable number.
    if (typeof raw !== "number" || !Number.isInteger(raw) || (raw as number) < 0) return undefined;
    return raw;
  },
  applyPayload: (index, payload) => {
    index.totalAlbumCount = payload as number | undefined;
  },
};

// Every index-snapshot kind that shares the index cache directory. The bound enforcer and the store
// loader must recognise them all so a rebuild's retention and a restart's load can neither miss nor
// mis-evict the other kind's active generation in the shared directory.
const INDEX_KINDS: SnapshotKind[] = [ALBUM_KIND, ARTIST_KIND];

// Generation token + global-bound configuration.
//
// IDENTITY AND ORDERING RIDE ON THE GENERATION TOKEN EMBEDDED IN THE FILENAME, NEVER ON FILESYSTEM
// mtimeMs. mtimeMs is set by the OS and ties under concurrent finalizes, so the old mtime-based
// "keep the previous generation" pruning was racy: two builds that landed in the same mtime tick
// made "which is the previous generation" arbitrary, so the code could evict the live/newest file.
// The token is a fixed-width zero-padded base36 build timestamp (orders builds chronologically)
// followed by random hex (breaks the tie when two builds finalize in the same millisecond). Because
// base36's char-code order matches its digit-value order, the whole token sorts lexicographically
// as (timestamp, random) — total, tie-free ordering straight off the name, no stat() needed.
const GEN_TS_WIDTH = 9; // Date.now() (~1.8e12) is 8 base36 digits today; 9 covers until ~year 2089
const GEN_RND_BYTES = 5; // 10 hex chars of randomness — tie-break within a millisecond

export const DEFAULT_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB global cap (all keys)
export const DEFAULT_SNAPSHOT_KEEP_PER_KEY = 2; // retain the newest N generations per key
export const DEFAULT_SNAPSHOT_PROTECT_PER_KEY = 1; // never evict the newest N per key (the live set)

const generationToken = (): string =>
  Date.now().toString(36).padStart(GEN_TS_WIDTH, "0") +
  randomBytes(GEN_RND_BYTES).toString("hex");

// A validated trailer. `payload` is the kind-specific value (years / totalAlbumCount) already
// checked by the kind's validatePayload, or undefined when the field was absent.
type SnapshotTrailer = {
  v: number;
  key: string;
  at: number;
  total: number;
  buckets: AlbumIndexBucket[];
  offsets: number[]; // length total+1
  payload: unknown;
};

const keyHash = (key: string): string =>
  createHash("sha1").update(key).digest("hex");

// Split a snapshot filename into its { kind, keyHash, gen } segments, or null for a foreign name.
// `<prefix><keyHash>.<gen>.dat` — keyHash is hex (no dots), gen has no dots, so the last dot in the
// stem separates them. Used by the bound enforcer to group + order files, and by the store loader to
// pick the validating kind, without reading any trailer (eviction never pays a per-file read).
const parseSnapshotName = (
  n: string,
  kinds: SnapshotKind[]
): { kind: SnapshotKind; keyHash: string; gen: string } | null => {
  for (const kind of kinds) {
    if (!n.startsWith(kind.prefix) || !n.endsWith(".dat")) continue;
    const stem = n.slice(kind.prefix.length, n.length - ".dat".length);
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) return null;
    return { kind, keyHash: stem.slice(0, dot), gen: stem.slice(dot + 1) };
  }
  return null;
};

// Validate a parsed trailer against the actual file it came from. Returns the trailer typed, or
// null if anything is inconsistent — a truncated/garbled/partial file is REFUSED rather than served.
// This is the guard against "a half-written snapshot read as complete": a file truncated mid-build
// either loses its footer (magic mismatch), its trailer (JSON parse / structural failure), or the
// recorded record-region size (offsets[total]) no longer matches where the trailer actually starts.
function validateTrailer(
  t: unknown,
  fileSize: number,
  trailerByteLen: number,
  kind: SnapshotKind
): SnapshotTrailer | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (o.v !== kind.version) return null;
  if (typeof o.key !== "string" || o.key.length === 0) return null;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0) return null;
  if (typeof o.total !== "number" || !Number.isInteger(o.total) || o.total < 0) return null;
  if (!Array.isArray(o.buckets) || !Array.isArray(o.offsets)) return null;
  const buckets = o.buckets as AlbumIndexBucket[];
  const offsets = o.offsets as number[];
  if (offsets.length !== o.total + 1) return null;
  // Buckets must be a contiguous, in-order partition of [0, total): each run starts where the
  // previous ended, and together they cover exactly the snapshot.
  let expected = 0;
  for (const b of buckets) {
    if (!b || typeof b.key !== "string" || typeof b.label !== "string") return null;
    if (typeof b.offset !== "number" || typeof b.count !== "number") return null;
    if (!Number.isInteger(b.offset) || !Number.isInteger(b.count) || b.count < 0) return null;
    if (b.offset !== expected) return null;
    expected += b.count;
  }
  if (expected !== o.total) return null;
  // offsets[0] is byte 0; every offset must be a non-negative integer that fits uint32 (the resident
  // index is a Uint32Array, so a record past 4 GiB cannot be addressed and must be refused at build).
  if (offsets[0] !== 0) return null;
  for (const off of offsets) {
    if (typeof off !== "number" || !Number.isInteger(off) || off < 0 || off > 0xffffffff) return null;
  }
  // The recorded end of the record region must land exactly where the trailer begins in THIS file.
  // A truncated/extended/edited records region breaks this equality.
  const trailerStart = fileSize - 8 - trailerByteLen;
  if (offsets[o.total] !== trailerStart) return null;
  // The kind-specific payload (album years / artist totalAlbumCount). OPTIONAL on the trailer (a
  // pre-change file, or a resident-only kind, has none); a present-but-malformed value is corruption.
  const payload = kind.validatePayload(o[kind.payloadField]);
  if (payload === null) return null;
  return { v: kind.version, key: o.key, at: o.at, total: o.total, buckets, offsets, payload };
}

// Read + validate the trailer of a snapshot file synchronously (used only at startup load, never on
// the browse path). Returns null for any missing/truncated/corrupt file.
function readTrailerSync(file: string, kind: SnapshotKind): SnapshotTrailer | null {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    if (size < 8) return null;
    fd = fs.openSync(file, "r");
    const footer = Buffer.alloc(8);
    // Footer is the last 8 bytes.
    if (fs.readSync(fd, footer, 0, 8, size - 8) !== 8) return null;
    const trailerByteLen = footer.readUInt32LE(0);
    const magic = footer.readUInt32LE(4);
    if (magic !== SNAPSHOT_MAGIC) return null;
    if (trailerByteLen <= 0 || size < 8 + trailerByteLen) return null;
    const trailerBuf = Buffer.alloc(trailerByteLen);
    if (fs.readSync(fd, trailerBuf, 0, trailerByteLen, size - 8 - trailerByteLen) !== trailerByteLen)
      return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trailerBuf.toString("utf8"));
    } catch {
      return null;
    }
    return validateTrailer(parsed, size, trailerByteLen, kind);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

// Rebuild the resident AlbumIndex (buckets + Uint32Array offsets; items empty) from a validated
// trailer, pointing at the given immutable file path, with the kind-specific payload applied.
function indexFromTrailer(
  trailer: SnapshotTrailer,
  file: string,
  kind: SnapshotKind
): AlbumIndex<any> {
  const index: AlbumIndex<any> = {
    total: trailer.total,
    buckets: trailer.buckets,
    items: [],
    snapshotFile: file,
    offsets: Uint32Array.from(trailer.offsets),
  };
  kind.applyPayload(index, trailer.payload);
  return index;
}

// A streaming, buffered writer that appends one record per item to a temp file, tracks the byte
// offset of each, then finalizes the trailer + footer and atomically renames into place. Records
// are flushed in ~64 KiB batches so a multi-million-record build does not issue one syscall per
// record, and nothing holds the whole snapshot in memory.
export class SnapshotWriter {
  private readonly kind: SnapshotKind;
  private fh?: fs.promises.FileHandle;
  private readonly tmp: string;
  private readonly dest: string;
  private readonly offsets: number[] = [];
  private flushedBytes = 0;
  private batch: Buffer[] = [];
  private batchBytes = 0;
  private readonly flushThreshold = 64 * 1024;

  constructor(
    private readonly dir: string,
    private readonly key: string,
    kind: SnapshotKind,
    // Global-bound options forwarded to enforceSnapshotBounds after each finalize. Defaults keep the
    // disk footprint bounded across rebuilds AND across users without touching the live indexes.
    private readonly opts: {
      maxBytes?: number;
      keepPerKey?: number;
      protectPerKey?: number;
    } = {}
  ) {
    this.kind = kind;
    const base = `${kind.prefix}${keyHash(key)}.${generationToken()}`;
    this.tmp = path.join(dir, `${base}.tmp`);
    this.dest = path.join(dir, `${base}.dat`);
  }

  async open(): Promise<void> {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* best-effort; the write below will surface a real error */
    }
    this.fh = await fs.promises.open(this.tmp, "w");
  }

  async write(record: unknown): Promise<void> {
    // Record the start offset of THIS record before it enters the batch.
    this.offsets.push(this.flushedBytes + this.batchBytes);
    const buf = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (buf.length > 0xffffffff - this.flushedBytes - this.batchBytes) {
      // A record past the 4 GiB uint32 address space can never be located by the resident index.
      throw new Error(
        "Index snapshot exceeds the 4 GiB addressable limit; refusing to write an un-locatable record"
      );
    }
    this.batch.push(buf);
    this.batchBytes += buf.length;
    if (this.batchBytes >= this.flushThreshold) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    const fh = this.fh;
    if (!fh) throw new Error("SnapshotWriter used before open");
    for (const b of this.batch) await fh.write(b);
    this.flushedBytes += this.batchBytes;
    this.batch = [];
    this.batchBytes = 0;
  }

  // Append trailer + footer, close, atomically rename tmp -> dest, then enforce the global disk
  // bound. `payload` is the kind-specific value (album distinct years / artist total album count),
  // persisted into the trailer so the O(1) browse filters stay O(1) after a restart, not just on the
  // build that scanned. Omitted (undefined) → the field is absent on the trailer (back-compat).
  // Returns the absolute file path + the resident Uint32Array offset index.
  async finalize(
    buckets: AlbumIndexBucket[],
    payload?: unknown
  ): Promise<{ snapshotFile: string; offsets: Uint32Array }> {
    const fh = this.fh;
    if (!fh) throw new Error("SnapshotWriter used before open");
    await this.flush();
    this.offsets.push(this.flushedBytes); // offsets[total] = end of records
    const total = this.offsets.length - 1;
    // Build the trailer with the structural fields, then layer the kind payload under its own field
    // name LAST — so an album trailer is byte-identical to the original {…,offsets,years} literal,
    // and an absent payload (undefined) is omitted by JSON.stringify exactly as before.
    const trailer: Record<string, unknown> = {
      v: this.kind.version,
      key: this.key,
      at: Date.now(),
      total,
      buckets,
      offsets: this.offsets,
    };
    // Normalization is applied on BOTH sides, deliberately - see SnapshotKind.normalizePayload.
    // The READER must coerce because it has to cope with files this process did not write, whose
    // years ARE numbers; the WRITER must normalize so it stops producing them, or a rollback to an
    // older reader re-arms the original outage. Keeping only one side is exactly what re-introduced
    // that outage during a merge, so do not "simplify" either half away.
    const outgoing = this.kind.normalizePayload ? this.kind.normalizePayload(payload) : payload;
    if (outgoing !== undefined) trailer[this.kind.payloadField] = outgoing;
    const trailerBuf = Buffer.from(JSON.stringify(trailer), "utf8");
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(trailerBuf.length, 0);
    footer.writeUInt32LE(SNAPSHOT_MAGIC, 4);
    await fh.write(trailerBuf);
    await fh.write(footer);
    await fh.close();
    this.fh = undefined;
    // Atomic swap. `dest` is a brand-new, uniquely-named file, so this rename never replaces an
    // existing file (no Windows rename-over-existing subtlety). An in-flight browse reading an older
    // snapshot keeps reading it: its path is immutable, and the bound enforcer retains the previous
    // generation (RETAIN-not-delete — see enforceSnapshotBounds).
    await fs.promises.rename(this.tmp, this.dest);
    // Bound the disk footprint GLOBALLY across all keys. This REPLACES the old per-finalize
    // "delete down to the newest two by mtime" prune: that was racy under an mtime tie (it could
    // evict the live file) and bounded only a single key. The enforcer never throws — every step is
    // best-effort — so a bound failure cannot risk the just-finalized build.
    await enforceSnapshotBounds(this.dir, this.opts);
    return { snapshotFile: this.dest, offsets: Uint32Array.from(this.offsets) };
  }

  // Drop the temp file on a failed/aborted build so a half-written snapshot is never left behind.
  async abort(): Promise<void> {
    try {
      if (this.fh) await this.fh.close();
    } catch {
      /* best-effort */
    }
    this.fh = undefined;
    try {
      await fs.promises.rm(this.tmp, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

// The album writer — the album kind baked in. Kept as a named class (not just a factory) so existing
// callers and tests construct it exactly as before; it inherits the full generic implementation.
export class AlbumSnapshotWriter extends SnapshotWriter {
  constructor(
    dir: string,
    key: string,
    opts: {
      maxBytes?: number;
      keepPerKey?: number;
      protectPerKey?: number;
    } = {}
  ) {
    super(dir, key, ALBUM_KIND, opts);
  }
}

// The artist writer — the artist kind baked in. Same implementation; only the prefix, version and
// payload field differ.
export class ArtistSnapshotWriter extends SnapshotWriter {
  constructor(
    dir: string,
    key: string,
    opts: {
      maxBytes?: number;
      keepPerKey?: number;
      protectPerKey?: number;
    } = {}
  ) {
    super(dir, key, ARTIST_KIND, opts);
  }
}

// RETAIN-not-delete disk bounding, applied GLOBALLY across every cache key after each finalize.
//
// Two layers, both ordered by the GENERATION TOKEN in the filename (never filesystem mtime — see
// generationToken):
//
//   1. PER-KEY GENERATION CAP (`keepPerKey`, default 2). For each key, retain only the newest
//      `keepPerKey` generations; evict the older ones. This is what makes a rebuild leave a bounded
//      file count per key, and retaining the previous generation is what keeps an in-flight browse
//      (which may still hold the just-superseded AlbumIndex) reading a live file.
//
//   2. GLOBAL BYTE CAP (`maxBytes`, default 4 GiB) across ALL keys — the cross-key bound the old
//      per-key prune could not provide, and the one that stops a many-user `/cache` bind mount from
//      walking into ENOSPC and taking the service down. When the total exceeds it, evict the OLDEST
//      generations across all keys (oldest token first) until under the cap — but never the newest
//      `protectPerKey` (default 1) of any key, because that is the active index a live or next browse
//      reads. If even the protected set exceeds the cap (a cap smaller than the active catalog needs),
//      nothing more is evicted and a warning is logged: refusing to evict beats breaking every read.
//
// The cap spans EVERY index kind in the directory (album + artist): album and artist keys hash
// differently, so per-key retention never trades one off against the other, but the GLOBAL byte cap
// sees them together and protects each kind's active newest-per-key equally — retention can never let
// one kind evict the other's active generation.
//
// Every eviction is best-effort. On Windows, deleting a file a reader has open fails (caught, left
// in place — the reader keeps reading it, space reclaimed later); on Linux an unlink of an open fd
// leaves that fd readable. Because reads open/close per call (readByteRange holds no persistent fd),
// the only divergence is a transiently-unreachable reclaim, never wrong data and never a broken read.
export async function enforceSnapshotBounds(
  dir: string,
  opts: {
    maxBytes?: number;
    keepPerKey?: number;
    protectPerKey?: number;
  } = {},
  kinds: SnapshotKind[] = INDEX_KINDS
): Promise<void> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const keepPerKey = Math.max(1, opts.keepPerKey ?? DEFAULT_SNAPSHOT_KEEP_PER_KEY);
  // The protected set is always a subset of the retained set, and at least the single newest.
  const protectPerKey = Math.max(
    1,
    Math.min(opts.protectPerKey ?? DEFAULT_SNAPSHOT_PROTECT_PER_KEY, keepPerKey)
  );

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // NO .tmp sweep here. This function runs from finalize(), i.e. while OTHER builds may still be
  // streaming records into their own .tmp files, and a sweep cannot tell "stale, from a crashed
  // build" apart from "in flight, owned by a build running right now".
  //
  // With a single writer that was merely harmless. With TWO kinds writing to the same directory it
  // is destructive: the artist build (seconds) finalizes in the middle of the album build (~15 min
  // at 113k albums) and unlinks the album build's temp file, so the album rename fails ENOENT a
  // quarter of an hour and ~230 Navidrome requests later, and Albums decays to a placeholder that
  // re-runs the same doomed scan on every retry. Two users logging in close together reproduces the
  // same thing with one kind.
  //
  // Stale .tmp files are swept in the store's load() instead, which runs at startup when no build
  // can be in flight. Pinned by the concurrent-build property test in
  // tests/album_snapshot_properties.test.ts - keep that test.

  // Parse + stat every snapshot file. A file we cannot stat is left alone (not blindly evicted).
  type SF = { full: string; keyHash: string; gen: string; size: number };
  const files: SF[] = [];
  for (const n of names) {
    const parsed = parseSnapshotName(n, kinds);
    if (!parsed) continue;
    const full = path.join(dir, n);
    try {
      files.push({ full, keyHash: parsed.keyHash, gen: parsed.gen, size: fs.statSync(full).size });
    } catch {
      /* unreadable → not safely evictable; leave it */
    }
  }

  // Rank each file within its key, newest token first (gen sorts as (timestamp, random), tie-free).
  const byKey = new Map<string, SF[]>();
  for (const f of files) {
    const arr = byKey.get(f.keyHash);
    if (arr) arr.push(f);
    else byKey.set(f.keyHash, [f]);
  }
  const rankByFull = new Map<string, number>();
  for (const arr of byKey.values()) {
    arr.sort((a, b) => (a.gen < b.gen ? 1 : a.gen > b.gen ? -1 : 0)); // newest (largest gen) first
    arr.forEach((f, i) => rankByFull.set(f.full, i));
  }

  const rm = async (f: SF): Promise<number> => {
    try {
      await fs.promises.rm(f.full, { force: true });
      return f.size;
    } catch {
      return 0; // best-effort: a Windows delete of an open file fails; leave it, reclaim later
    }
  };

  // Layer 1: always evict every generation beyond the per-key cap, oldest-of-key first.
  const beyondCap = files
    .filter((f) => rankByFull.get(f.full)! >= keepPerKey)
    .sort((a, b) => (a.gen < b.gen ? -1 : a.gen > b.gen ? 1 : 0)); // oldest first
  for (const f of beyondCap) await rm(f);

  // Layer 2: if the global byte cap is exceeded, evict the oldest remaining generations across all
  // keys, never dipping into the newest protectPerKey of any key. Operate ONLY on the files that
  // survived Layer 1 (rank < keepPerKey): rm(force:true) silently no-ops on an already-deleted file,
  // so including Layer-1 victims here would double-count their size as reclaimed.
  const remaining = files.filter((f) => rankByFull.get(f.full)! < keepPerKey);
  let total = remaining.reduce((s, f) => s + f.size, 0);
  if (total > maxBytes) {
    const reclaimable = remaining
      .filter((f) => rankByFull.get(f.full)! >= protectPerKey)
      .sort((a, b) => (a.gen < b.gen ? -1 : a.gen > b.gen ? 1 : 0)); // oldest first
    for (const f of reclaimable) {
      if (total <= maxBytes) break;
      total -= await rm(f);
    }
    if (total > maxBytes) {
      // The active (newest-per-key) indexes alone exceed the cap. Do NOT evict them — that would
      // break every current and subsequent read. Surface the misconfiguration instead.
      logger.warn(
        `Index snapshot store at ${dir} is ${total} bytes, over its ${maxBytes}-byte bound even ` +
          `after evicting every reclaimable generation; retaining active indexes. Raise ` +
          `BNB_ALBUM_SNAPSHOT_MAX_BYTES.`
      );
    }
  }
}

// Async read of an exact byte range [start, end). One open/read/close per call — no persistent fd
// to leak or to race an atomic swap. A short read (file shrank after load) throws rather than serve
// partial data.
async function readByteRange(file: string, start: number, end: number): Promise<Buffer> {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    if (bytesRead !== len) {
      throw new Error(
        `Index snapshot short read: wanted ${len} bytes at ${start}, got ${bytesRead} (${file})`
      );
    }
    return buf;
  } finally {
    await fh.close();
  }
}

// Decode a buffer of newline-delimited JSON records (the contents of one contiguous byte range).
function decodeJsonlRecords(buf: Buffer): any[] {
  const text = buf.toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  const out: any[] = [];
  for (const line of lines) {
    if (line.length === 0) continue; // trailing newline yields a final empty element
    out.push(JSON.parse(line));
  }
  return out;
}

// Serve one page of a letter directly from the on-disk snapshot. Mirrors the pure albumIndexPage
// walk over the letter's contiguous runs, but reads each run-slice's byte range from disk instead of
// slicing a resident array. Drift-proof — the offsets and the file are from the same immutable
// build. In-memory (small/test) indexes defer to the synchronous albumIndexPage.
export async function readAlbumIndexPage<T>(
  index: AlbumIndex<T>,
  key: string,
  pageIndex: number,
  pageCount: number
): Promise<{ items: T[]; total: number }> {
  if (!index.snapshotFile || !index.offsets) {
    return albumIndexPage(index, key, pageIndex, pageCount);
  }
  const offsets = index.offsets;
  const ranges = albumIndexRangesFor(index, key);
  const total = ranges.reduce((sum, r) => sum + r.count, 0);
  const items: T[] = [];
  let skip = pageIndex;
  let take = pageCount;
  for (const r of ranges) {
    if (take <= 0) break;
    if (skip >= r.count) {
      skip -= r.count;
      continue;
    }
    const from = r.offset + skip;
    const n = Math.min(r.count - skip, take);
    const buf = await readByteRange(index.snapshotFile, offsets[from]!, offsets[from + n]!);
    const recs = decodeJsonlRecords(buf);
    if (recs.length !== n) {
      throw new Error(
        `Index snapshot page decode mismatch: expected ${n} records, got ${recs.length}`
      );
    }
    for (const rec of recs) items.push(rec as T);
    take -= n;
    skip = 0;
  }
  return { items, total };
}

// Slice the on-disk snapshot in scan order, for the flat (small/shrunk-library) browse. Drift-proof;
// in-memory indexes defer to the synchronous albumIndexAll.
export async function readAlbumIndexAll<T>(
  index: AlbumIndex<T>,
  pageIndex: number,
  pageCount: number
): Promise<T[]> {
  if (!index.snapshotFile || !index.offsets) {
    return albumIndexAll(index, pageIndex, pageCount);
  }
  const offsets = index.offsets;
  const total = index.total;
  const start = Math.min(Math.max(0, pageIndex), total);
  const end = Math.min(total, pageIndex + pageCount);
  if (end <= start) return [];
  const buf = await readByteRange(index.snapshotFile, offsets[start]!, offsets[end]!);
  const recs = decodeJsonlRecords(buf);
  if (recs.length !== end - start) {
    throw new Error(
      `Index snapshot flat decode mismatch: expected ${end - start} records, got ${recs.length}`
    );
  }
  return recs as T[];
}

// A SwrCacheStore that persists each built index as one self-describing snapshot file. The BUILD
// writes the snapshot (it is the only place that streams the records), so save() is a no-op;
// persistence is the file itself. load() scans the directory at startup, validates each file's
// trailer against ITS kind (picked from the filename prefix), and reconstructs the newest valid index
// per cache key — across every index kind that shares the directory.
//
// (The name predates the artist index joining the index cache; the store now loads every index-snapshot
// kind — album AND artist — from the shared directory, keyed by each trailer's own cache key.)
export function albumIndexStore(dir: string): SwrCacheStore {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn(`Index snapshot store: could not create ${dir}: ${e}`);
  }

  return {
    // The build has already written the snapshot file atomically; nothing more to persist.
    save() {
      /* no-op */
    },

    load() {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      // Drop stale .tmp files left by a build that crashed before its atomic rename. Safe at startup
      // (no build is running yet); a .dat only ever appears via rename from a .tmp.
      for (const n of names.filter((n) => INDEX_KINDS.some((k) => n.startsWith(k.prefix)) && n.endsWith(".tmp"))) {
        try {
          fs.rmSync(path.join(dir, n), { force: true });
        } catch {
          /* best-effort */
        }
      }
      // Newest valid trailer per cache key wins; corrupt/truncated files are skipped (→ cold rebuild).
      const newestByKey = new Map<string, { at: number; value: unknown }>();
      for (const n of names) {
        const kind = INDEX_KINDS.find((k) => n.startsWith(k.prefix) && n.endsWith(".dat"));
        if (!kind) continue;
        const full = path.join(dir, n);
        const trailer = readTrailerSync(full, kind);
        if (!trailer) {
          // Never skip silently: a refused snapshot is indistinguishable from no snapshot, which is
          // exactly why the numeric-years outage survived a full day of restarts undetected.
          logger.warn(`Snapshot ${n} failed trailer validation and was skipped; its index will cold-rebuild.`);
          continue;
        }
        const existing = newestByKey.get(trailer.key);
        if (!existing || trailer.at > existing.at) {
          newestByKey.set(trailer.key, {
            at: trailer.at,
            value: indexFromTrailer(trailer, full, kind),
          });
        }
      }
      // NEWEST FIRST. SwrCache's seeding contract depends on it: it reverses what the store hands
      // back so the OLDEST entry is inserted first and is therefore the first eviction candidate
      // (swr_cache.ts). readdir order is arbitrary, so without this sort a restart could evict a
      // live index and pay a full catalog rescan for it.
      return [...newestByKey.entries()]
        .map(([key, { at, value }]) => ({ key, at, value }))
        .sort((a, b) => b.at - a.at);
    },
  };
}
