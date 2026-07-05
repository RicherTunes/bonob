import {
  albumBucketKey,
  buildAlbumIndexFromPages,
  albumIndexLetters,
  albumIndexRangesFor,
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

  it("exposes Navidrome's default article list", () => {
    expect(DEFAULT_IGNORED_ARTICLES).toEqual(
      expect.arrayContaining(["the", "a", "o", "os", "as", "los", "las"])
    );
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
  it("returns each letter once, in first-appearance order", () => {
    const idx = buildAlbumIndexFromPages([
      names("Apple", "Banana", "Apex"), // runs: A, B, A
    ]);
    expect(albumIndexLetters(idx)).toEqual([
      { key: "A", label: "A" },
      { key: "B", label: "B" },
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
});
