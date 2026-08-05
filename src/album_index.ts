import { sonosMaxContainerTotal } from "./config";

// A cached alphabetical index of the album catalog, used to break the huge flat "Albums" list
// into bounded per-letter buckets (Sonos S2 rejects a single browsable container that advertises
// a very large total).
//
// It stores the scanned album snapshot (`items`) plus CONTIGUOUS runs of same-letter albums; run
// offsets index the immutable snapshot, NOT live getAlbumList2. This is deliberate: Navidrome
// re-scans reorder the catalog, so serving a letter by re-fetching live offsets drifts and returns
// wrong-letter albums. Serving from the snapshot is drift-proof (the snapshot only changes when the
// whole index is rebuilt).

export type AlbumIndexBucket = {
  key: string; // bucket key (a letter A-Z, or "#" for non-letters)
  label: string; // display label
  offset: number; // offset of this run's first album in the snapshot (`items`)
  count: number; // number of albums in this contiguous run
};

export type AlbumIndex<T = { name: string }> = {
  total: number;
  // Contiguous runs in scan order. A letter may appear in more than one run when a stray title
  // sorts away from its neighbours; correctness does not depend on runs being one-per-letter.
  buckets: AlbumIndexBucket[];
  // The scanned album snapshot, in scan order. Runs index into this array. For a disk-backed
  // (large-catalog) index this is EMPTY — the records live in `snapshotFile` and a page is read on
  // demand via `offsets` (see readAlbumIndexPage/readAlbumIndexAll in album_snapshot.ts), so the
  // full snapshot is never resident. Absent for in-memory (small/test) indexes.
  items: T[];
  // Slice 1 disk-backed snapshot. `snapshotFile` is an absolute path to an IMMUTABLE, per-build
  // file; `offsets[i]` is the byte offset of record i within it (offsets[total] = end of records).
  // A page read opens the file and reads exactly [offsets[s], offsets[e]) for the requested slice.
  // Because the file is never rewritten (each rebuild is a new file) offsets always resolve against
  // the same bytes they were built from — drift is impossible across a rebuild.
  snapshotFile?: string;
  offsets?: Uint32Array;
  // Distinct release years across the scanned catalog (sorted ascending), collected during the same
  // scan that builds the buckets so the "Years" browse filter is O(1) and complete rather than a
  // silently-truncated first page. Absent on a pre-change index or a small catalog that never built
  // one (years() then falls back to a paged collection).
  years?: string[];
  // The sum of every record's albumCount, collected during the ARTIST index scan. The artist index
  // is the single cached view of getArtists, and the whole-catalog album total (albumCount /
  // peekAlbumCount / getAlbumList2's alphabetical total) is summed from it. A resident artist index
  // leaves this undefined and the total is summed from `items`; a DISK-BACKED index has `items: []`,
  // so the total must be carried here (persisted in the snapshot trailer) to stay O(1). Absent on an
  // album index (which has no albumCount) and on a resident artist index.
  totalAlbumCount?: number;
};

// A flat "Albums" list up to this size is browsed as-is (simple, and safe on older S1 hardware),
// and a catalog this small never builds the index at all; a larger catalog builds the snapshot and
// is split into bounded per-letter buckets, because Sonos rejects a single browsable container
// advertising a very large total (observed: ~23k ok, ~115k rejected).
// Configurable via BNB_SONOS_MAX_CONTAINER_TOTAL (default 20000). Read once at module load.
export const MAX_ALBUMS_FLAT = sonosMaxContainerTotal();

// Navidrome's default ND_IGNOREDARTICLES ("The El La Los Las Le Les Os As O A"): leading articles
// stripped when sorting, so e.g. "The Doors" sorts under D and "O Bem" under B. We mirror it so
// our buckets line up with the order Navidrome returns. A non-default list only shifts edge titles.
export const DEFAULT_IGNORED_ARTICLES = [
  "the",
  "el",
  "la",
  "los",
  "las",
  "le",
  "les",
  "os",
  "as",
  "o",
  "a",
];

// Fold diacritics (é -> e, Ü -> u) so accented titles bucket under their base letter, matching
// Navidrome's collation.
const foldDiacritics = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// The alphabetical bucket a title sorts into. Diacritics folded, leading article stripped (only
// when followed by a space, so "Theatre" stays under T); anything that doesn't then start with a
// latin A-Z (numbers, symbols, non-latin scripts) maps to "#".
export function albumBucketKey(
  title: string,
  ignoredArticles: string[] = DEFAULT_IGNORED_ARTICLES
): string {
  let t = foldDiacritics((title || "").trim().toLowerCase());
  for (const raw of ignoredArticles) {
    // Normalize caller-supplied articles (a non-default ND_IGNOREDARTICLES may be mixed-case or
    // padded), and require any Unicode whitespace after the article (space, tab, NBSP, ...) so a
    // title like "Los Lobos" still sorts under L while "Theatre" stays under T.
    const a = raw.trim().toLowerCase();
    if (a.length > 0 && t.startsWith(a) && /^\s/.test(t.slice(a.length))) {
      t = t.slice(a.length).replace(/^\s+/, "");
      break;
    }
  }
  // Test the (folded, lowercased) first char directly so the key is always a single A-Z letter or
  // "#". Uppercasing first would turn e.g. German "ß" into the two-char "SS".
  const first = t.charAt(0);
  return first >= "a" && first <= "z" ? first.toUpperCase() : "#";
}

// Order bucket keys for the A-Z menu: "#" first, then A..Z.
const compareBucketKeys = (a: string, b: string): number =>
  a === b ? 0 : a === "#" ? -1 : b === "#" ? 1 : a < b ? -1 : 1;

// Accumulates the contiguous-run bucket table one album at a time, in scan order. A new run starts
// whenever the bucket key changes, so each run is an exact [offset, offset+count) slice of the
// snapshot. Shared by the in-memory reduce (buildAlbumIndexFromPages) and the disk-streaming build
// (Subsonic.buildAlbumIndex) so the two paths cannot diverge in how they bucket.
export class BucketBuilder<T extends { name: string }> {
  readonly buckets: AlbumIndexBucket[] = [];
  private current: AlbumIndexBucket | undefined;
  total = 0;

  append(album: T, ignoredArticles?: string[]): void {
    const key = albumBucketKey(album.name, ignoredArticles);
    if (!this.current || this.current.key !== key) {
      this.current = { key, label: key, offset: this.total, count: 0 };
      this.buckets.push(this.current);
    }
    this.current.count++;
    this.total++;
  }
}

// Reduce the scanned album pages (in alphabeticalByName order) into the snapshot + contiguous runs.
// Pure so it can be unit-tested without the Subsonic client. A new run starts whenever the bucket
// key changes, so each run is an exact [offset, offset+count) slice of the stored `items` snapshot.
export function buildAlbumIndexFromPages<T extends { name: string }>(
  pages: T[][],
  ignoredArticles?: string[]
): AlbumIndex<T> {
  const builder = new BucketBuilder<T>();
  for (const page of pages) {
    for (const album of page) {
      builder.append(album, ignoredArticles);
    }
  }
  return { total: builder.total, buckets: builder.buckets, items: pages.flat() };
}

// Serve one page of a letter directly from the stored snapshot: gather the letter's contiguous
// runs and slice `items` across them. Drift-proof - never re-fetches by live offset. Returns the
// page's items and the letter's total (so the container never advertises the whole-catalog total).
export function albumIndexPage<T>(
  index: AlbumIndex<T>,
  key: string,
  pageIndex: number,
  pageCount: number
): { items: T[]; total: number } {
  // Defence in depth: a malformed/old-schema index (no snapshot) yields an empty page rather than
  // throwing. The versioned cache key is the primary guard; this is the backstop.
  if (!Array.isArray(index.items)) return { items: [], total: 0 };
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
    for (let i = from; i < from + n; i++) items.push(index.items[i]!);
    take -= n;
    skip = 0;
  }
  return { items, total };
}

// The distinct letters to show in the Albums A-Z menu, each once, ordered "#" then A..Z. The
// underlying runs are scattered by Navidrome's collation, but the menu always reads in order (each
// letter's leaf still gathers all of its runs).
export function albumIndexLetters(
  index: AlbumIndex<any>
): { key: string; label: string }[] {
  const seen = new Set<string>();
  const letters: { key: string; label: string }[] = [];
  for (const b of index.buckets) {
    if (!seen.has(b.key)) {
      seen.add(b.key);
      letters.push({ key: b.key, label: b.label });
    }
  }
  return letters.sort((a, b) => compareBucketKeys(a.key, b.key));
}

// A lazily-built, memoized per-letter ranges map, so looking up a letter's runs is O(1) after the
// first access instead of an O(buckets) filter on every browse page. Memoized in a WeakMap keyed by
// the index object: a cache-resident index (the common case — frozen and shared across every browse
// of a user) pays the one O(buckets) build ever, and the map is garbage-collected with the index
// when a rebuild replaces it. The index is treated as immutable (frozen when persisted; never
// mutated by callers), so a memo built from `buckets` cannot go stale.
const rangesByKeyCache = new WeakMap<AlbumIndex<any>, Map<string, AlbumIndexBucket[]>>();

function rangesByKey(
  index: AlbumIndex<any>
): Map<string, AlbumIndexBucket[]> {
  let m = rangesByKeyCache.get(index);
  if (m === undefined) {
    m = new Map();
    for (const b of index.buckets) {
      const arr = m.get(b.key);
      if (arr) arr.push(b);
      else m.set(b.key, [b]);
    }
    rangesByKeyCache.set(index, m);
  }
  return m;
}

// Every contiguous range that belongs to a letter (usually one, occasionally more for stray
// titles). The leaf browse pages across these ranges so it returns exactly that letter's albums.
export function albumIndexRangesFor(
  index: AlbumIndex<any>,
  key: string
): AlbumIndexBucket[] {
  return rangesByKey(index).get(key) ?? [];
}

// Total number of albums in a letter (across all its runs). Used to decide whether a letter fits
// in one bounded container or must be split into fixed-size sub-buckets.
export function albumIndexLetterTotal(
  index: AlbumIndex<any>,
  key: string
): number {
  return albumIndexRangesFor(index, key).reduce((sum, r) => sum + r.count, 0);
}

// Slice the raw snapshot in scan order, for the flat (small-library) browse. Drift-proof, and an
// old/malformed index without a snapshot yields an empty page rather than throwing.
export function albumIndexAll<T>(
  index: AlbumIndex<T>,
  pageIndex: number,
  pageCount: number
): T[] {
  return Array.isArray(index.items)
    ? index.items.slice(pageIndex, pageIndex + pageCount)
    : [];
}

// The SMAPI alphabet scrubber. A container that advertises canScroll gets asked for
// getScrollIndices, and answers with "A,0,B,120,C,340,..." mapping each letter to the item offset
// where it starts, so the Sonos app can jump straight there. That is the native way to navigate a
// long list, and it removes the extra per-letter container tap that bucketing forces on the user.
//
// Built from the bucket table rather than by scanning the records: the buckets already carry each
// letter's starting offset, so this is O(26) instead of O(total). At 24,797 artists that matters.
//
// Every one of A-Z must appear, even letters the catalog has nothing under: the scrubber maps a
// touch position to a list offset, so a missing letter would leave a dead zone. A letter with no
// items points at the position where it WOULD start, which is where the previous letter ended.
export function scrollIndicesFrom(index: AlbumIndex<any>): string {
  // First offset and last end per bucket key. A key can span several chunk buckets, so the letter
  // starts at the lowest offset and ends after the highest.
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  for (const b of index.buckets) {
    start.set(b.key, Math.min(start.get(b.key) ?? b.offset, b.offset));
    end.set(b.key, Math.max(end.get(b.key) ?? 0, b.offset + b.count));
  }
  const out: string[] = [];
  // Running end-of-catalog-so-far. A letter with NO items points here: the offset where it would
  // begin, which is where the previous populated letter ended.
  //
  // This deliberately differs from upstream's version, which carries the previous letter's START
  // forward, so every letter after the last populated one points at the beginning of that letter.
  // Dragging the scrubber to Z would then jump to C. Pointing past-the-end letters at the end of
  // the catalog is what the scrubber is for.
  let running = 0;
  for (let c = 0; c < 26; c++) {
    const letter = String.fromCharCode(65 + c);
    const at = start.get(letter);
    if (at !== undefined) {
      out.push(letter, `${at}`);
      running = end.get(letter) ?? at;
    } else {
      out.push(letter, `${running}`);
    }
  }
  return out.join(",");
}
