// A cached alphabetical index of the album catalog, used to break the huge flat "Albums" list
// into bounded per-letter buckets (Sonos S2 rejects a single browsable container that advertises
// a very large total). The index records, for each first-letter bucket, the offset of its first
// album in the getAlbumList2(type=alphabeticalByName) ordering and how many albums it holds.

export type AlbumIndexBucket = {
  key: string; // stable bucket key (a letter A-Z, or "#" for non-letters)
  label: string; // display label
  offset: number; // offset of the bucket's first album in alphabeticalByName order
  count: number; // number of albums in the bucket
};

export type AlbumIndex = {
  total: number;
  buckets: AlbumIndexBucket[];
};

// Navidrome's default ND_IGNOREDARTICLES: leading articles stripped when sorting. We mirror it
// so our buckets line up with the order Navidrome actually returns (e.g. "The Doors" sorts under
// D, not T). A non-default ND_IGNOREDARTICLES would only shift a few edge titles by one bucket.
export const DEFAULT_IGNORED_ARTICLES = ["the", "el", "la", "los", "las", "le", "les"];

// The alphabetical bucket a title sorts into. Leading article stripped (only when followed by a
// space, so "Theatre" stays under T); non-letter first characters map to "#".
export function albumBucketKey(
  title: string,
  ignoredArticles: string[] = DEFAULT_IGNORED_ARTICLES
): string {
  let t = (title || "").trim().toLowerCase();
  for (const a of ignoredArticles) {
    if (t.startsWith(a + " ")) {
      t = t.slice(a.length + 1).trim();
      break;
    }
  }
  const c = t.charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

// Reduce the scanned album pages (in alphabeticalByName order) into the bucket index. Pure so it
// can be unit-tested without the Subsonic client; the scan orchestration lives in the client.
export function buildAlbumIndexFromPages(
  pages: { name: string }[][],
  ignoredArticles?: string[]
): AlbumIndex {
  const buckets: AlbumIndexBucket[] = [];
  const byKey = new Map<string, AlbumIndexBucket>();
  let offset = 0;
  for (const page of pages) {
    for (const album of page) {
      const key = albumBucketKey(album.name, ignoredArticles);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { key, label: key, offset, count: 0 };
        byKey.set(key, bucket);
        buckets.push(bucket);
      }
      bucket.count++;
      offset++;
    }
  }
  return { total: offset, buckets };
}
