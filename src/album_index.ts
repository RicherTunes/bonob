// A cached alphabetical index of the album catalog, used to break the huge flat "Albums" list
// into bounded per-letter buckets (Sonos S2 rejects a single browsable container that advertises
// a very large total). The index records CONTIGUOUS runs of same-letter albums in the
// getAlbumList2(type=alphabeticalByName) order, so every (offset,count) range is exact even when a
// title lands outside its apparent letter (Navidrome's collation and ours can never match 100%).

export type AlbumIndexBucket = {
  key: string; // bucket key (a letter A-Z, or "#" for non-letters)
  label: string; // display label
  offset: number; // offset of this run's first album in alphabeticalByName order
  count: number; // number of albums in this contiguous run
};

export type AlbumIndex = {
  total: number;
  // Contiguous runs in scan order. A letter may appear in more than one run when a stray title
  // sorts away from its neighbours; correctness does not depend on runs being one-per-letter.
  buckets: AlbumIndexBucket[];
};

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
  for (const a of ignoredArticles) {
    if (t.startsWith(a + " ")) {
      t = t.slice(a.length + 1).trim();
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

// Reduce the scanned album pages (in alphabeticalByName order) into contiguous runs. Pure so it
// can be unit-tested without the Subsonic client. A new run starts whenever the bucket key changes
// from the previous album, so each run is an exact [offset, offset+count) slice of the catalog.
export function buildAlbumIndexFromPages(
  pages: { name: string }[][],
  ignoredArticles?: string[]
): AlbumIndex {
  const buckets: AlbumIndexBucket[] = [];
  let offset = 0;
  let current: AlbumIndexBucket | undefined;
  for (const page of pages) {
    for (const album of page) {
      const key = albumBucketKey(album.name, ignoredArticles);
      if (!current || current.key !== key) {
        current = { key, label: key, offset, count: 0 };
        buckets.push(current);
      }
      current.count++;
      offset++;
    }
  }
  return { total: offset, buckets };
}

// The distinct letters to show in the Albums A-Z menu, each once, ordered "#" then A..Z. The
// underlying runs are scattered by Navidrome's collation, but the menu always reads in order (each
// letter's leaf still gathers all of its runs).
export function albumIndexLetters(
  index: AlbumIndex
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

// Every contiguous range that belongs to a letter (usually one, occasionally more for stray
// titles). The leaf browse pages across these ranges so it returns exactly that letter's albums.
export function albumIndexRangesFor(
  index: AlbumIndex,
  key: string
): AlbumIndexBucket[] {
  return index.buckets.filter((b) => b.key === key);
}
