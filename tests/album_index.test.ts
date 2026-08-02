import {
  albumBucketKey,
  buildAlbumIndexFromPages,
  albumIndexLetters,
  albumIndexRangesFor,
  albumIndexLetterTotal,
  albumIndexAll,
  DEFAULT_IGNORED_ARTICLES,
} from "../src/album_index";

const names = (...ns: string[]) => ns.map((name) => ({ name }));

describe("albumBucketKey", () => {
  it("buckets by the first letter, uppercased", () => {
    expect(albumBucketKey("Doolittle")).toEqual("D");
    expect(albumBucketKey("kid a")).toEqual("K");
  });

  it("strips Navidrome's default leading articles (incl. A and O)", () => {
    expect(albumBucketKey("The Doors")).toEqual("D");
    expect(albumBucketKey("A 120")).toEqual("#"); // -> "120" -> non-letter
    expect(albumBucketKey("O Bem do Amor")).toEqual("B"); // -> "bem..."
    expect(albumBucketKey("Los Lobos")).toEqual("L"); // -> "lobos"
    expect(albumBucketKey("Os Mutantes")).toEqual("M"); // -> "mutantes"
  });

  it("only strips an article when followed by a space", () => {
    expect(albumBucketKey("Theatre")).toEqual("T");
    expect(albumBucketKey("Analog")).toEqual("A");
  });

  it("folds diacritics so accented titles sort under the base letter", () => {
    expect(albumBucketKey("Éxodus")).toEqual("E");
    expect(albumBucketKey("Ábba")).toEqual("A");
    expect(albumBucketKey("Über")).toEqual("U");
  });

  it("maps numbers, symbols and non-latin scripts to '#'", () => {
    expect(albumBucketKey("123456")).toEqual("#");
    expect(albumBucketKey("!!!")).toEqual("#");
    expect(albumBucketKey("日本")).toEqual("#");
    expect(albumBucketKey("")).toEqual("#");
  });

  it("always returns a single-character key (German ß does not become 'SS')", () => {
    const key = albumBucketKey("ßeta");
    expect(key).toEqual("#");
    expect(key.length).toEqual(1);
  });

  it("exposes Navidrome's default article list", () => {
    expect(DEFAULT_IGNORED_ARTICLES).toEqual(
      expect.arrayContaining(["the", "a", "o", "os", "as", "los", "las"])
    );
  });

  it("normalizes caller-supplied articles (case/whitespace) and strips on any Unicode whitespace", () => {
    // caller passes mixed-case / padded articles
    expect(albumBucketKey("The Doors", [" The "])).toEqual("D");
    // article followed by a non-breaking space or tab still strips
    expect(albumBucketKey("The Doors")).toEqual("D");
    expect(albumBucketKey("Los\tLobos")).toEqual("L");
    // an empty article never strips everything
    expect(albumBucketKey("Apple", ["", "the"])).toEqual("A");
  });
});

describe("albumIndexLetterTotal", () => {
  it("sums the counts of all of a letter's runs", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Banana", "Apex", "Avocado"), // A(0,1), B(1,1), A(2,2)
    ]);
    expect(albumIndexLetterTotal(idx, "A")).toEqual(3);
    expect(albumIndexLetterTotal(idx, "B")).toEqual(1);
    expect(albumIndexLetterTotal(idx, "Z")).toEqual(0);
  });
});

describe("albumIndexAll", () => {
  it("slices the raw snapshot for the flat browse", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Banana", "Cherry", "Date"),
    ]);
    expect(albumIndexAll(idx, 1, 2).map((a) => a.name)).toEqual([
      "Banana",
      "Cherry",
    ]);
    expect(albumIndexAll(idx, 0, 100).length).toEqual(4);
  });

  it("is empty for a malformed index without a snapshot", () => {
    expect(
      albumIndexAll({ total: 0, buckets: [] } as any, 0, 10)
    ).toEqual([]);
  });
});

describe("buildAlbumIndexFromPages (contiguous runs)", () => {
  it("makes one run per contiguous letter and records exact offsets", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Avocado", "Banana", "Cherry"),
    ]);
    expect(idx.total).toEqual(4);
    expect(idx.buckets).toEqual([
      { key: "A", label: "A", offset: 0, count: 2 },
      { key: "B", label: "B", offset: 2, count: 1 },
      { key: "C", label: "C", offset: 3, count: 1 },
    ]);
  });

  it("does NOT merge non-contiguous same-letter albums (stays a separate run)", () => {
    // A stray "A" after "B" (e.g. a title Navidrome sorts elsewhere) must not corrupt
    // the "A" range - it becomes its own contiguous run so every offset stays exact.
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Avocado", "Banana", "Apex"),
    ]);
    expect(idx.buckets).toEqual([
      { key: "A", label: "A", offset: 0, count: 2 },
      { key: "B", label: "B", offset: 2, count: 1 },
      { key: "A", label: "A", offset: 3, count: 1 },
    ]);
  });

  it("spans pages seamlessly", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Avocado"),
      names("Apricot", "Banana"),
    ]);
    expect(idx.total).toEqual(4);
    expect(idx.buckets).toEqual([
      { key: "A", label: "A", offset: 0, count: 3 },
      { key: "B", label: "B", offset: 3, count: 1 },
    ]);
  });
});

describe("albumIndexLetters", () => {
  it("returns each letter once, ordered '#' then A..Z, regardless of scattered run order", () => {
    const idx = buildAlbumIndexFromPages([
      // runs (Navidrome's scattered order): C, A, 9(->#), B, A
      names("Cherry", "Apple", "9 to 5", "Banana", "Apex"),
    ]);
    expect(albumIndexLetters(idx)).toEqual([
      { key: "#", label: "#" },
      { key: "A", label: "A" },
      { key: "B", label: "B" },
      { key: "C", label: "C" },
    ]);
  });
});

describe("albumIndexRangesFor", () => {
  it("returns every contiguous range for a letter", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Banana", "Apex"), // A(0,1), B(1,1), A(2,1)
    ]);
    expect(albumIndexRangesFor(idx, "A")).toEqual([
      { key: "A", label: "A", offset: 0, count: 1 },
      { key: "A", label: "A", offset: 2, count: 1 },
    ]);
    expect(albumIndexRangesFor(idx, "Z")).toEqual([]);
  });

  it("looks up a letter in O(1) via a memoized map (no re-filter, live bucket objects)", () => {
    // The lookup must not re-filter `buckets` on every call. A per-index memo returns the same
    // array instance on repeat and the actual bucket objects (so it cannot drift from `buckets`).
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Banana", "Apex"), // A(0,1), B(1,1), A(2,1)
    ]);
    const first = albumIndexRangesFor(idx, "A");
    const again = albumIndexRangesFor(idx, "A");
    expect(again).toBe(first); // memoized: identical array, not a fresh filter result
    expect(first[0]).toBe(idx.buckets[0]); // the live bucket object, in scan order
    expect(first[1]).toBe(idx.buckets[2]);
    // A letter with no runs yields a stable empty array (still O(1)).
    expect(albumIndexRangesFor(idx, "Z")).toEqual([]);
  });
});
