import {
  getMetadataResult,
  searchResult,
  inSmapiOrder,
  sanitizeXml,
} from "../src/smapi";
import { slice2 } from "../src/music_library";

// ---------------------------------------------------------------------------
// Property-based tests over the SMAPI RESPONSE layer.
//
// The equivalent suite over the snapshot format found a live production bug on
// its first run (concurrent builds deleting each other's temp files). This one
// exists for the same reason: the response layer has now produced two defects of
// the same shape, both invisible because Sonos tolerated them, and both found
// only by validating captured production traffic against the WSDL:
//
//   1. count emitted before index, violating the mediaList xs:sequence
//   2. itemType emitted before id, violating AbstractMedia
//
// Both are instances of "the response was well-formed and semantically right,
// but structurally out of contract". A per-case example test does not catch that
// class; a property over arbitrary inputs does.
//
// Seeded PRNG rather than a property-testing dependency, so failures reproduce
// from the printed seed.
// ---------------------------------------------------------------------------

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEEDS = [1, 2, 3, 7, 13, 42, 99, 1234, 31337, 2026];

// The mediaCollection key space, in the order the WSDL declares it. The property below shuffles a
// random SUBSET of these into a random order and asserts the emitted object comes back in exactly
// this relative order.
const COLLECTION_KEYS_IN_ORDER = [
  "id",
  "itemType",
  "displayType",
  "title",
  "summary",
  "artist",
  "artistId",
  "canScroll",
  "canPlay",
  "canEnumerate",
  "canAddToFavorites",
  "albumArtURI",
];

const TRACK_KEYS_IN_ORDER = [
  "artistId",
  "artist",
  "albumId",
  "album",
  "genreId",
  "genre",
  "duration",
  "albumArtURI",
  "trackNumber",
  "canPlay",
];

const shuffledSubset = (r: () => number, keys: string[]) => {
  const chosen = keys.filter(() => r() > 0.35);
  const use = chosen.length ? chosen : [keys[0]!];
  // Fisher-Yates on a copy, so the input order is genuinely arbitrary rather than
  // "the right order with gaps" - the latter would pass even with no ordering at all.
  const shuffled = [...use];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const obj: Record<string, unknown> = {};
  for (const k of shuffled) obj[k] = `v-${k}`;
  return obj;
};

describe("SMAPI response layer: property-based", () => {
  describe("emitted media is always in WSDL element order", () => {
    it.each(SEEDS)(
      "seed %i: an arbitrary shuffled subset of mediaCollection keys comes back in schema order",
      (seed) => {
        const r = rng(seed);
        for (let round = 0; round < 25; round++) {
          const input = shuffledSubset(r, COLLECTION_KEYS_IN_ORDER);
          const out = Object.keys(inSmapiOrder(input));
          const expected = COLLECTION_KEYS_IN_ORDER.filter((k) =>
            Object.prototype.hasOwnProperty.call(input, k)
          );
          expect(out).toEqual(expected);
        }
      }
    );

    it.each(SEEDS)(
      "seed %i: nested trackMetadata is ordered by ITS own sequence, not the collection one",
      (seed) => {
        const r = rng(seed);
        for (let round = 0; round < 25; round++) {
          const track = shuffledSubset(r, TRACK_KEYS_IN_ORDER);
          const out = Object.keys(
            (inSmapiOrder({ itemType: "track", id: "t", trackMetadata: track }) as any)
              .trackMetadata
          );
          const expected = TRACK_KEYS_IN_ORDER.filter((k) =>
            Object.prototype.hasOwnProperty.call(track, k)
          );
          expect(out).toEqual(expected);
        }
      }
    );

    it.each(SEEDS)(
      "seed %i: ordering never drops, duplicates or rewrites a value",
      (seed) => {
        const r = rng(seed);
        for (let round = 0; round < 25; round++) {
          const input: Record<string, unknown> = shuffledSubset(
            r,
            COLLECTION_KEYS_IN_ORDER
          );
          // attributes is an XML ATTRIBUTE group, not an element: the schema never names it, and
          // dropping it would silently strip readOnly/userContent from playlist tiles.
          if (r() > 0.5) input["attributes"] = { readOnly: true };
          const out = inSmapiOrder(input) as Record<string, unknown>;
          expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
          for (const k of Object.keys(input)) expect(out[k]).toEqual(input[k]);
        }
      }
    );
  });

  describe("result envelopes", () => {
    it.each(SEEDS)(
      "seed %i: index, count and total always lead, whatever the caller passes",
      (seed) => {
        const r = rng(seed);
        for (let round = 0; round < 25; round++) {
          const n = Math.floor(r() * 8);
          const items = Array.from({ length: n }, (_, i) => ({
            itemType: "album",
            id: `album-${i}`,
            title: `Album ${i}`,
          }));
          const withIndex = r() > 0.5;
          const withTotal = r() > 0.5;
          const built = getMetadataResult({
            mediaCollection: items,
            ...(withIndex ? { index: Math.floor(r() * 500) } : {}),
            ...(withTotal ? { total: Math.floor(r() * 100000) } : {}),
          }).getMetadataResult;

          expect(Object.keys(built).slice(0, 3)).toEqual([
            "index",
            "count",
            "total",
          ]);
          // count must describe what was actually emitted, never what the caller wished
          expect(built.count).toEqual(n);
        }
      }
    );

    it.each(SEEDS)("seed %i: searchResult obeys the same contract", (seed) => {
      const r = rng(seed);
      for (let round = 0; round < 15; round++) {
        const n = Math.floor(r() * 6);
        const built = searchResult({
          mediaMetadata: Array.from({ length: n }, (_, i) => ({
            itemType: "track",
            id: `track-${i}`,
            title: `Track ${i}`,
          })),
        }).searchResult;
        expect(Object.keys(built).slice(0, 3)).toEqual(["index", "count", "total"]);
        expect(built.count).toEqual(n);
      }
    });
  });

  describe("paging", () => {
    it.each(SEEDS)(
      "seed %i: concatenating every page equals the whole list, at any page size",
      (seed) => {
        const r = rng(seed);
        const n = 1 + Math.floor(r() * 60);
        const all = Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
        for (let size = 1; size <= n + 2; size++) {
          const paged: { id: string }[] = [];
          for (let offset = 0; offset < n; offset += size) {
            const [page] = slice2<{ id: string }>({ _index: offset, _count: size })(all);
            paged.push(...page);
          }
          expect(paged.map((it) => it.id)).toEqual(all.map((it) => it.id));
        }
      }
    );

    it.each(SEEDS)(
      "seed %i: a page past the end is empty rather than wrapping",
      (seed) => {
        const r = rng(seed);
        const n = 1 + Math.floor(r() * 30);
        const all = Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));
        const [page, total] = slice2<{ id: string }>({
          _index: n + 1 + Math.floor(r() * 100),
          _count: 10,
        })(all);
        expect(page).toEqual([]);
        expect(total).toEqual(n);
      }
    );
  });

  describe("sanitisation composes with ordering", () => {
    // sanitizeXml strips XML-illegal characters; inSmapiOrder reorders keys. Neither may undo the
    // other, and the emit path runs them together.
    it.each(SEEDS)(
      "seed %i: control characters are stripped AND order is still correct",
      (seed) => {
        const r = rng(seed);
        for (let round = 0; round < 15; round++) {
          // Only characters XML 1.0 actually forbids. TAB (0x09), LF (0x0A) and CR (0x0D) are
          // LEGAL and must survive: an earlier version of this generator emitted TAB and "failed",
          // which was the test being wrong, not sanitizeXml.
          const illegal = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f,
          ];
          const dirty = String.fromCharCode(
            illegal[Math.floor(r() * illegal.length)]!
          );
          const input = {
            albumArtURI: `http://art/${dirty}x`,
            itemType: "album",
            title: `A${dirty}Title`,
            id: "album-1",
          };
          const out = inSmapiOrder(sanitizeXml(input)) as Record<string, string>;
          expect(Object.keys(out)).toEqual([
            "id",
            "itemType",
            "title",
            "albumArtURI",
          ]);
          expect(out["title"]).not.toContain(dirty);
          expect(out["albumArtURI"]).not.toContain(dirty);
        }
      }
    );
  });
});
