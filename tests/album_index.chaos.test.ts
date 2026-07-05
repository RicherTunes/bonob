import {
  albumBucketKey,
  buildAlbumIndexFromPages,
  albumIndexPage,
  albumIndexLetters,
  albumIndexRangesFor,
} from "../src/album_index";

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Adversarial title fragments: articles (incl. inconsistent A/O), diacritics, non-latin scripts,
// numbers, symbols, empty/whitespace, XML-special chars, apostrophes, German ß.
const PARTS = [
  "apple", "the doors", "a data", "o bem", "los lobos", "éxodus", "über",
  "日本", "123", "!!!", "", "as i do", "café", "ñandú", "ABBA", "zzz", "A",
  "The", "ß beta", "'quote", "a & b", "<tag>", "  spaced  ", "x", "LDN",
  "La Vie", "9 to 5", "Ω omega", "🎵 emoji", "MMXX",
];

function randomName(r: () => number): string {
  const n = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(PARTS[Math.floor(r() * PARTS.length)]!);
  return parts.join(" ").trim();
}

type Album = { id: string; name: string };

function randomCatalog(r: () => number, size: number, tag: string): Album[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `${tag}-${i}`,
    name: randomName(r),
  }));
}

// Split a flat catalog into scan-sized pages (mirrors the real 500/page scan).
function pageify(catalog: Album[], pageSize: number): Album[][] {
  const pages: Album[][] = [];
  for (let i = 0; i < catalog.length; i += pageSize)
    pages.push(catalog.slice(i, i + pageSize));
  return pages.length ? pages : [[]];
}

describe("album index — chaos / property tests", () => {
  it("every generated name maps to exactly one A-Z letter or '#', never throws", () => {
    const r = rng(555);
    for (let i = 0; i < 20000; i++) {
      const k = albumBucketKey(randomName(r));
      expect(k).toMatch(/^[A-Z#]$/);
    }
  });

  it("index is a complete, non-overlapping partition of the snapshot", () => {
    const r = rng(1);
    for (let trial = 0; trial < 300; trial++) {
      const size = Math.floor(r() * 400);
      const catalog = randomCatalog(r, size, `t${trial}`);
      const idx = buildAlbumIndexFromPages(
        pageify(catalog, 1 + Math.floor(r() * 60))
      );
      expect(idx.total).toEqual(size);
      expect(idx.items.length).toEqual(size);
      // runs contiguous + cover everything exactly once
      let cum = 0;
      for (const b of idx.buckets) {
        expect(b.offset).toEqual(cum);
        cum += b.count;
      }
      expect(cum).toEqual(size);
      // menu is sorted "#" then A..Z, each letter once
      const letters = albumIndexLetters(idx).map((l) => l.key);
      expect([...letters]).toEqual([...letters].sort(cmp));
      expect(new Set(letters).size).toEqual(letters.length);
    }
  });

  it("albumIndexPage(full) returns EXACTLY a letter's albums, in snapshot order", () => {
    const r = rng(42);
    for (let trial = 0; trial < 300; trial++) {
      const size = 1 + Math.floor(r() * 400);
      const catalog = randomCatalog(r, size, `f${trial}`);
      const idx = buildAlbumIndexFromPages(pageify(catalog, 50));
      for (const { key } of albumIndexLetters(idx)) {
        const expected = catalog.filter((a) => albumBucketKey(a.name) === key);
        const { items, total } = albumIndexPage(idx, key, 0, size);
        expect(total).toEqual(expected.length);
        // exact, ordered match (ids), and every item truly belongs to the letter
        expect(items.map((a) => a.id)).toEqual(expected.map((a) => a.id));
        expect(items.every((a) => albumBucketKey(a.name) === key)).toBe(true);
      }
    }
  });

  it("random paging windows tile a letter exactly once — no gaps, no dups", () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const size = 1 + Math.floor(r() * 300);
      const catalog = randomCatalog(r, size, `pg${trial}`);
      const idx = buildAlbumIndexFromPages(pageify(catalog, 40));
      for (const { key } of albumIndexLetters(idx)) {
        const total = albumIndexPage(idx, key, 0, 1).total;
        const seen: string[] = [];
        let at = 0;
        while (at < total) {
          const win = 1 + Math.floor(r() * Math.max(total, 1));
          seen.push(...albumIndexPage(idx, key, at, win).items.map((a) => a.id));
          at += win;
        }
        const expected = catalog
          .filter((a) => albumBucketKey(a.name) === key)
          .map((a) => a.id);
        expect(seen).toEqual(expected);
      }
    }
  });

  it("is DRIFT-PROOF: snapshot serving survives a re-scan that WOULD break offset serving", () => {
    // The exact production failure: Navidrome re-scanned, the offset index went stale, and a
    // served letter returned wrong-letter albums. This test proves (a) snapshot serving is immune
    // and (b) the old offset approach demonstrably drifts on the same mutation - so a regression
    // back to live-offset fetching would be caught.
    const r = rng(9001);
    let offsetApproachDrifted = false;
    for (let trial = 0; trial < 100; trial++) {
      const v1 = randomCatalog(r, 300, `v1-${trial}`);
      const idx = buildAlbumIndexFromPages(pageify(v1, 50));

      // Simulate a re-scan mutating the LIVE catalog (inserts/removes shift every later offset).
      const v2 = [...v1];
      v2.splice(Math.floor(r() * v2.length), 0, {
        id: `new-${trial}`,
        name: randomName(r),
      });
      v2.splice(Math.floor(r() * v2.length), 1 + Math.floor(r() * 4));

      for (const { key } of albumIndexLetters(idx)) {
        // NEW: served from the frozen snapshot - must always be correct.
        const snap = albumIndexPage(idx, key, 0, v1.length);
        expect(snap.items.every((a) => albumBucketKey(a.name) === key)).toBe(true);

        // OLD: re-fetch the same run offsets against the mutated LIVE catalog v2 - drifts.
        for (const run of albumIndexRangesFor(idx, key)) {
          const refetched = v2.slice(run.offset, run.offset + run.count);
          if (refetched.some((a) => a && albumBucketKey(a.name) !== key)) {
            offsetApproachDrifted = true;
          }
        }
      }
    }
    // Confirms the mutation genuinely breaks offset serving (so the test has teeth).
    expect(offsetApproachDrifted).toBe(true);
  });

  it("handles degenerate catalogs without crashing", () => {
    const empty = buildAlbumIndexFromPages<Album>([[]]);
    expect(empty.total).toEqual(0);
    expect(albumIndexLetters(empty)).toEqual([]);
    expect(albumIndexPage(empty, "A", 0, 10)).toEqual({ items: [], total: 0 });

    const one = buildAlbumIndexFromPages([[{ id: "x", name: "Zoo" }]]);
    expect(albumIndexPage(one, "Z", 0, 10).items.map((a) => a.id)).toEqual(["x"]);
    expect(albumIndexPage(one, "Q", 0, 10)).toEqual({ items: [], total: 0 });

    const same = buildAlbumIndexFromPages(
      pageify(
        Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, name: `Apple ${i}` })),
        50
      )
    );
    expect(albumIndexPage(same, "A", 0, 500).total).toEqual(120);
    expect(albumIndexPage(same, "A", 10, 3).items.map((a) => a.id)).toEqual([
      "s10", "s11", "s12",
    ]);
    // page past the end is empty, not an error
    expect(albumIndexPage(same, "A", 1000, 10).items).toEqual([]);
    // ranges of an absent letter
    expect(albumIndexRangesFor(same, "Z")).toEqual([]);
  });
});

const cmp = (a: string, b: string): number =>
  a === b ? 0 : a === "#" ? -1 : b === "#" ? 1 : a < b ? -1 : 1;
