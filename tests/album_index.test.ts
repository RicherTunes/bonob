import { albumBucketKey, buildAlbumIndexFromPages } from "../src/album_index";

describe("albumBucketKey", () => {
  it("maps a plain title to its uppercase first letter", () => {
    expect(albumBucketKey("Amsterdam")).toEqual("A");
    expect(albumBucketKey("beatles")).toEqual("B");
    expect(albumBucketKey("Zoo")).toEqual("Z");
  });

  it("strips a leading article, mirroring Navidrome's default sort", () => {
    expect(albumBucketKey("The Beatles")).toEqual("B");
    expect(albumBucketKey("la vie en rose")).toEqual("V");
    expect(albumBucketKey("Los Lobos")).toEqual("L"); // "Lobos" -> L (only the article is stripped)
    expect(albumBucketKey("An Awesome Album")).toEqual("A"); // "An" not in default ignored list -> stays A
  });

  it("buckets non-letters (numbers, symbols) under '#'", () => {
    expect(albumBucketKey("369")).toEqual("#");
    expect(albumBucketKey("!")).toEqual("#");
    expect(albumBucketKey("\"&\" (Ampersand)")).toEqual("#");
    expect(albumBucketKey("  ")).toEqual("#");
  });

  it("does not strip an article that isn't followed by a space", () => {
    expect(albumBucketKey("Theatre")).toEqual("T"); // "The" only stripped when followed by a space
    expect(albumBucketKey("Elastic")).toEqual("E");
  });
});

describe("buildAlbumIndexFromPages", () => {
  const names = (arr: string[]) => arr.map((name) => ({ name }));

  it("records the first offset + count for each bucket across pages, preserving order", () => {
    // simulate two pages (alphabeticalByName order)
    const page1 = names(["369", "Amsterdam", "Apple", "Banana"]); // offsets 0..3
    const page2 = names(["Cat", "The Doors", "Zoo"]); // offsets 4..6 ("The Doors" -> D)
    const idx = buildAlbumIndexFromPages([page1, page2]);
    expect(idx.total).toEqual(7);
    expect(idx.buckets).toEqual([
      { key: "#", label: "#", offset: 0, count: 1 },
      { key: "A", label: "A", offset: 1, count: 2 },
      { key: "B", label: "B", offset: 3, count: 1 },
      { key: "C", label: "C", offset: 4, count: 1 },
      { key: "D", label: "D", offset: 5, count: 1 },
      { key: "Z", label: "Z", offset: 6, count: 1 },
    ]);
  });

  it("returns an empty index for no albums", () => {
    expect(buildAlbumIndexFromPages([])).toEqual({ total: 0, buckets: [] });
  });
});
