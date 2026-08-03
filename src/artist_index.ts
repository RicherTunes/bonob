import { AlbumIndex, AlbumIndexBucket, MAX_ALBUMS_FLAT } from "./album_index";
import { ArtistRecord } from "./music_library";

// A cached index of the artist catalog, used to break the huge flat "Artists" list into bounded
// per-letter buckets for the SAME reason albums are bucketed: Sonos S2 rejects a single browsable
// container that advertises a very large total, and the Artists container advertises all of them.
//
// THE LOAD-BEARING DIFFERENCE FROM THE ALBUM INDEX: the artist index is built from Navidrome's OWN
// index-letter grouping — the `index[].name` that /rest/getArtists returns. It does NOT re-derive
// letters from artist names (no article-stripping, no diacritic folding, no bonob collation). The
// album index has to derive its buckets from titles because getAlbumList2 returns a flat stream with
// no server-side grouping; getArtists hands us the grouping for free, so we use it verbatim. Forcing
// the two to agree would reintroduce exactly the collation drift the album design fought.

// The S2 container-total ceiling is content-agnostic — it is the same Sonos limit that gates the
// Albums container — so a flat Artists list up to this size is browsed as-is and a larger catalog is
// split into bounded per-letter buckets. One source of truth (BNB_SONOS_MAX_CONTAINER_TOTAL).
export const MAX_ARTISTS_FLAT = MAX_ALBUMS_FLAT;

// Build the artist index from Navidrome's index-letter groups. Each non-empty letter group becomes
// one contiguous bucket over `items`, so a letter's browse page is an exact slice served drift-proof
// from the snapshot (no live re-fetch by offset, which would drift on a Navidrome re-scan). An empty
// letter group (Navidrome returned a `name` with no `artist[]`) contributes no bucket and no items,
// so it never appears in the A-Z menu and never perturbs the offsets.
//
// Pure (no I/O, no freezing) so it can be unit-tested without the Subsonic client; the caller freezes
// the records and the returned arrays. A letter that Navidrome splits across two non-adjacent groups
// would yield two buckets with the same key — albumIndexRangesFor merges them, and the page walk
// handles multiple ranges, so that is correct rather than an edge case to defend against.
export function buildArtistIndex(
  // `artist` is OPTIONAL because Navidrome really does return an index letter with no artist array
  // (and sometimes an empty one). The implementation below already copes via `group.artist || []`;
  // the type asserted a presence the server does not guarantee, which is the same defect shape as
  // TrackStream.headers claiming every header is always present.
  groups: { name: string; artist?: ArtistRecord[] }[]
): AlbumIndex<ArtistRecord> {
  const buckets: AlbumIndexBucket[] = [];
  const items: ArtistRecord[] = [];
  for (const group of groups) {
    const artists = group.artist || [];
    if (artists.length === 0) continue;
    buckets.push({
      key: group.name,
      label: group.name,
      offset: items.length,
      count: artists.length,
    });
    for (const artist of artists) items.push(artist);
  }
  return { total: items.length, buckets, items };
}
