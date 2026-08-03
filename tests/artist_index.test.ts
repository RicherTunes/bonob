import {
  buildArtistIndex,
  MAX_ARTISTS_FLAT,
} from "../src/artist_index";
import { MAX_ALBUMS_FLAT } from "../src/album_index";
import {
  albumIndexLetters,
  albumIndexPage,
  albumIndexLetterTotal,
} from "../src/album_index";
import { ArtistRecord } from "../src/music_library";

const rec = (id: string, name: string, albumCount = 0): ArtistRecord => ({
  id,
  name,
  albumCount,
  image: undefined,
});

describe("buildArtistIndex", () => {
  it("uses Navidrome's index[].name verbatim as the bucket key — it does NOT re-derive the letter from the artist name", () => {
    // Navidrome grouped "The Doors" under "T". The album path would derive "D" (strip "The"); the
    // artist path must take Navidrome's letter as-is. This is the load-bearing difference.
    const idx = buildArtistIndex([
      {
        name: "T",
        artist: [rec("1", "The Doors"), rec("2", "Tori Amos")],
      },
    ]);

    expect(idx.buckets).toEqual([
      { key: "T", label: "T", offset: 0, count: 2 },
    ]);
    expect(idx.total).toEqual(2);
  });

  it("keeps arbitrary Navidrome letter labels (ranges, symbols) as the bucket key", () => {
    // Whatever Navidrome says the letter is — a range, a symbol — that is the letter.
    const idx = buildArtistIndex([
      { name: "#", artist: [rec("1", "12 Rodos")] },
      { name: "D-Z", artist: [rec("2", "Django"), rec("3", "Zeppelin")] },
    ]);

    expect(idx.buckets.map((b) => b.key)).toEqual(["#", "D-Z"]);
  });

  it("builds one contiguous bucket per non-empty letter group, with running offsets", () => {
    const idx = buildArtistIndex([
      { name: "A", artist: [rec("a1", "A1"), rec("a2", "A2")] },
      { name: "B", artist: [rec("b1", "B1")] },
      { name: "C", artist: [rec("c1", "C1"), rec("c2", "C2"), rec("c3", "C3")] },
    ]);

    expect(idx.buckets).toEqual([
      { key: "A", label: "A", offset: 0, count: 2 },
      { key: "B", label: "B", offset: 2, count: 1 },
      { key: "C", label: "C", offset: 3, count: 3 },
    ]);
    expect(idx.total).toEqual(6);
    // Buckets are a contiguous, in-order partition of [0, total).
    let expected = 0;
    for (const b of idx.buckets) {
      expect(b.offset).toEqual(expected);
      expected += b.count;
    }
    expect(expected).toEqual(idx.total);
  });

  it("lays items out in scan order across the groups", () => {
    const idx = buildArtistIndex([
      { name: "A", artist: [rec("a1", "A1"), rec("a2", "A2")] },
      { name: "B", artist: [rec("b1", "B1")] },
    ]);

    expect(idx.items.map((a) => a.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("skips a letter group that has no artist[] (or an empty one) — no bucket, no items, offsets stay contiguous", () => {
    const idx = buildArtistIndex([
      { name: "A", artist: [rec("a1", "A1")] },
      { name: "B" }, // Navidrome returned the letter with no artists
      { name: "C", artist: [] }, // explicit empty array
      { name: "D", artist: [rec("d1", "D1")] },
    ]);

    expect(idx.buckets.map((b) => b.key)).toEqual(["A", "D"]);
    expect(idx.total).toEqual(2);
    expect(idx.items.map((a) => a.id)).toEqual(["a1", "d1"]);
    // The D bucket offset skips the two empty letters cleanly.
    expect(idx.buckets[1]).toEqual({ key: "D", label: "D", offset: 1, count: 1 });
  });

  it("returns an empty index when there are no groups", () => {
    expect(buildArtistIndex([])).toEqual({ total: 0, buckets: [], items: [] });
  });

  it("produces an index the shared album machinery can serve from (letters + per-letter page)", () => {
    // This is the reuse contract: the artist index is a plain AlbumIndex<ArtistRecord>, so the
    // already-hardened albumIndexLetters / albumIndexPage / albumIndexLetterTotal work on it.
    const idx = buildArtistIndex([
      { name: "B", artist: [rec("b1", "B1")] },
      { name: "A", artist: [rec("a1", "A1"), rec("a2", "A2")] },
    ]);

    // The A-Z menu reads distinct letters, ordered "#" then A..Z (display order only — leaf
    // contents are untouched).
    expect(albumIndexLetters(idx).map((l) => l.key)).toEqual(["A", "B"]);

    // A letter's total is summed across its runs.
    expect(albumIndexLetterTotal(idx, "A")).toEqual(2);

    // A letter's page is an exact slice of the items.
    const page = albumIndexPage(idx, "A", 0, 10);
    expect(page.total).toEqual(2);
    expect(page.items.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("MAX_ARTISTS_FLAT", () => {
  it("is the same S2 container-total ceiling as MAX_ALBUMS_FLAT (one source of truth)", () => {
    expect(MAX_ARTISTS_FLAT).toEqual(MAX_ALBUMS_FLAT);
  });
});
