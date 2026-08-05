import fs from "fs";
import os from "os";
import path from "path";

import { AlbumSummary } from "../src/music_library";
import { BucketBuilder } from "../src/album_index";
import {
  AlbumSnapshotWriter,
  albumIndexStore,
  readAlbumIndexPage,
  readAlbumIndexAll,
} from "../src/album_snapshot";

// ---------------------------------------------------------------------------
// Property-based round-trip tests over the snapshot format.
//
// This subsystem has produced four production bugs of the SAME shape, each found
// by hand (or by deploying), one at a time:
//
//   1. a validator rejecting its own writer's output (numeric years)
//   2. a writer normalising on one side only
//   3. a sweep deleting a .tmp another build owned
//   4. a NaN payload making an index permanently unloadable
//
// Every one of them is an instance of "write -> read -> serve was not lossless,
// and it degraded SILENTLY". That invariant is not expressed anywhere testable,
// so the same shape keeps coming back. These tests state it directly: for an
// arbitrary catalog, the data that goes in comes back out, whole, in order, at
// any page size - and a failure is loud rather than an empty list.
//
// No property-testing dependency: a small seeded PRNG keeps runs deterministic
// and lets a failure be reproduced from the printed seed alone.
// ---------------------------------------------------------------------------

// mulberry32 - tiny, deterministic, good enough to shuffle field shapes around.
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Deliberately nasty name pool: the bucketing key is derived from these, so it must
// survive unicode, punctuation-leading names, digits, empty-ish strings and case.
const NAME_POOL = [
  "Abba",
  "!!!",
  "4 Non Blondes",
  "Éowyn",
  "日本語のアルバム",
  "  leading space",
  "",
  "ZZ Top",
  "a",
  "The Very Long Album Name That Goes On And On For Quite A While Indeed",
  "quote\"and<angle>&amp",
  "🎵 emoji album",
];

type GeneratedRecord = AlbumSummary & { year?: unknown };

// Generate a record whose OPTIONAL fields are genuinely sometimes absent, sometimes
// numeric, sometimes string. The numeric-year case is bug #1 reproduced generically:
// the writer emitted numbers, the validator only accepted strings.
const generateRecord = (r: () => number, i: number): GeneratedRecord => {
  const name = NAME_POOL[Math.floor(r() * NAME_POOL.length)]!;
  const yearRoll = r();
  const rec: any = {
    id: `album-${i}`,
    name,
    artistId: r() < 0.9 ? `artist-${Math.floor(r() * 50)}` : undefined,
    artistName: r() < 0.9 ? `Artist ${Math.floor(r() * 50)}` : undefined,
    coverArt: r() < 0.7 ? { system: "subsonic", resource: `art:${i}` } : undefined,
  };
  // year: absent | numeric | string - all three occur in real Navidrome payloads
  if (yearRoll < 0.33) rec.year = undefined;
  else if (yearRoll < 0.66) rec.year = 1960 + Math.floor(r() * 60);
  else rec.year = `${1960 + Math.floor(r() * 60)}`;
  if (r() < 0.5) rec.genre = { id: `g${Math.floor(r() * 5)}`, name: "Rock" };
  return rec as GeneratedRecord;
};

const generateCatalog = (seed: number, size: number): GeneratedRecord[] => {
  const r = rng(seed);
  return Array.from({ length: size }, (_, i) => generateRecord(r, i));
};

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-snap-prop-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const buildDiskIndex = async (
  dir: string,
  key: string,
  records: GeneratedRecord[]
) => {
  const builder = new BucketBuilder<AlbumSummary>();
  const writer = new AlbumSnapshotWriter(dir, key);
  await writer.open();
  for (const rec of records) {
    builder.append(rec as AlbumSummary);
    await writer.write(rec as AlbumSummary);
  }
  const { snapshotFile, offsets } = await writer.finalize(builder.buckets);
  return {
    total: builder.total,
    buckets: builder.buckets,
    items: [] as AlbumSummary[],
    snapshotFile,
    offsets,
  };
};

// Seeds are fixed so CI is deterministic; each is printed on failure so a red run
// is reproducible by rerunning that single seed.
const SEEDS = [1, 2, 3, 7, 13, 42, 99, 1234, 31337, 2026];

describe("snapshot format: property-based round-trip", () => {
  describe("write -> read is lossless for arbitrary catalogs", () => {
    it.each(SEEDS)(
      "seed %i: every record survives write -> read, field for field, in order",
      async (seed) => {
        const size = 1 + (seed % 40);
        const records = generateCatalog(seed, size);
        await withTempDir(async (dir) => {
          const index = await buildDiskIndex(dir, `albumIndex:v3:seed${seed}`, records);
          const read = await readAlbumIndexAll<AlbumSummary>(index, 0, records.length);

          expect(read.length).toEqual(records.length);
          read.forEach((got, i) => {
            const want = records[i]!;
            // ids and names must be byte-identical - these drive tile identity
            expect(got.id).toEqual(want.id);
            expect(got.name).toEqual(want.name);
            expect(got.artistId).toEqual(want.artistId);
            expect(got.artistName).toEqual(want.artistName);
            // year is the field that produced two separate production bugs. Whatever
            // the writer accepted, the reader must return something equal by value -
            // never dropped, never NaN, never a rejected record.
            if (want.year === undefined) {
              expect(got.year === undefined || got.year === null).toBe(true);
            } else {
              expect(String(got.year)).toEqual(String(want.year));
              expect(String(got.year)).not.toEqual("NaN");
            }
          });
        });
      }
    );
  });

  describe("paging is consistent at every page size", () => {
    it.each(SEEDS)(
      "seed %i: concatenating all pages equals reading everything at once",
      async (seed) => {
        const size = 1 + (seed % 37);
        const records = generateCatalog(seed, size);
        await withTempDir(async (dir) => {
          const index = await buildDiskIndex(dir, `albumIndex:v3:page${seed}`, records);
          const all = await readAlbumIndexAll<AlbumSummary>(index, 0, records.length);

          // every page size from 1..size+2, including sizes that overrun the end
          for (let pageSize = 1; pageSize <= size + 2; pageSize++) {
            const paged: AlbumSummary[] = [];
            for (let offset = 0; offset < size; offset += pageSize) {
              paged.push(
                ...(await readAlbumIndexAll<AlbumSummary>(index, offset, pageSize))
              );
            }
            expect(paged.map((it) => it.id)).toEqual(all.map((it) => it.id));
          }
        });
      }
    );

    it.each(SEEDS)(
      "seed %i: reading past the end yields nothing rather than throwing or wrapping",
      async (seed) => {
        const records = generateCatalog(seed, 1 + (seed % 11));
        await withTempDir(async (dir) => {
          const index = await buildDiskIndex(dir, `albumIndex:v3:end${seed}`, records);
          const past = await readAlbumIndexAll<AlbumSummary>(
            index,
            records.length + 5,
            10
          );
          expect(past).toEqual([]);
        });
      }
    );
  });

  describe("per-letter pages agree with the full listing", () => {
    // NOTE ON A LOAD-BEARING PRECONDITION: a bucket is stored as an OFFSET RANGE into the
    // snapshot file, not as a list of member ids. That only describes the records it claims
    // when the records were appended in sorted order - which is what production does
    // (buildAlbumIndex scans Navidrome alphabeticalByName). Feed the builder unsorted records
    // and every letter page silently returns the wrong slice, with no error anywhere.
    //
    // So these bucket properties are stated under sorted input deliberately. If a future change
    // starts feeding records in a different order, this is where it must fail loudly.
    it.each(SEEDS)(
      "seed %i: with sorted input (as buildAlbumIndex feeds it) buckets partition the catalog into contiguous slices",
      async (seed) => {
        const r = rng(seed);
        // simple ASCII names so plain lexicographic order matches the bucketer's grouping
        const records = Array.from({ length: 1 + (seed % 29) }, (_, i) => ({
          id: `album-${i}`,
          name: `${String.fromCharCode(65 + Math.floor(r() * 26))}${Math.floor(
            r() * 1000
          )}`,
        })) as GeneratedRecord[];
        records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        records.forEach((rec, i) => (rec.id = `album-${i}`));

        await withTempDir(async (dir) => {
          const index = await buildDiskIndex(dir, `albumIndex:v3:sorted${seed}`, records);
          const all = await readAlbumIndexAll<AlbumSummary>(index, 0, records.length);

          let seen = 0;
          const fromBuckets: string[] = [];
          for (const bucket of index.buckets) {
            const page = await readAlbumIndexPage<AlbumSummary>(
              index,
              bucket.key,
              0,
              records.length
            );
            expect(page.items.length).toEqual(page.total);
            // contiguous: this bucket is exactly the next slice of the full listing
            expect(page.items.map((it) => it.id)).toEqual(
              all.slice(seen, seen + page.total).map((it) => it.id)
            );
            fromBuckets.push(...page.items.map((it) => it.id));
            seen += page.total;
          }
          // and a partition: every record in exactly one bucket, none lost or duplicated
          expect(seen).toEqual(records.length);
          expect(new Set(fromBuckets).size).toEqual(records.length);
          expect(fromBuckets.slice().sort()).toEqual(
            all.map((it) => it.id).slice().sort()
          );
        });
      }
    );
  });

  describe("persistence survives a restart without silent degradation", () => {
    it.each(SEEDS)(
      "seed %i: a written snapshot is restored by the store and still reads back whole",
      async (seed) => {
        const records = generateCatalog(seed, 1 + (seed % 23));
        await withTempDir(async (dir) => {
          const key = `albumIndex:v3:restore${seed}`;
          const built = await buildDiskIndex(dir, key, records);
          const before = await readAlbumIndexAll<AlbumSummary>(built, 0, records.length);

          // simulate a process restart: a brand new store over the same directory
          const restored = albumIndexStore(dir).load();
          const entry = restored.find((e) => e.key === key);
          expect(entry).toBeDefined();

          const after = await readAlbumIndexAll<AlbumSummary>(
            entry!.value as any,
            0,
            records.length
          );
          // The failure mode this guards is the dangerous one: an index that loads as
          // EMPTY rather than failing loudly, which reads as "no albums" to the user
          // and silently re-triggers a full catalog rescan on every restart.
          expect(after.length).toEqual(records.length);
          expect(after.map((it) => it.id)).toEqual(before.map((it) => it.id));
        });
      }
    );
  });

  describe("degenerate catalogs", () => {
    it("an empty catalog round-trips as empty without throwing", async () => {
      await withTempDir(async (dir) => {
        const index = await buildDiskIndex(dir, "albumIndex:v3:empty", []);
        expect(await readAlbumIndexAll<AlbumSummary>(index, 0, 10)).toEqual([]);
        expect(index.total).toEqual(0);
      });
    });

    it("a catalog whose records all share one bucket still pages correctly", async () => {
      const records: GeneratedRecord[] = Array.from({ length: 25 }, (_, i) => ({
        id: `album-${i}`,
        name: `Aardvark ${i}`,
      })) as GeneratedRecord[];
      await withTempDir(async (dir) => {
        const index = await buildDiskIndex(dir, "albumIndex:v3:onebucket", records);
        const all = await readAlbumIndexAll<AlbumSummary>(index, 0, 25);
        expect(all.map((it) => it.id)).toEqual(records.map((it) => it.id));
      });
    });

    it("records with only the required fields do not lose their identity", async () => {
      const records: GeneratedRecord[] = [
        { id: "bare-1", name: "" },
        { id: "bare-2", name: "x" },
      ] as GeneratedRecord[];
      await withTempDir(async (dir) => {
        const index = await buildDiskIndex(dir, "albumIndex:v3:bare", records);
        const all = await readAlbumIndexAll<AlbumSummary>(index, 0, 10);
        expect(all.map((it) => it.id)).toEqual(["bare-1", "bare-2"]);
        expect(all.map((it) => it.name)).toEqual(["", "x"]);
      });
    });
  });

  describe("concurrent builds do not corrupt each other", () => {
    // Bug #3 was a sweep deleting a .tmp that ANOTHER in-flight build owned: the fast
    // build finished and swept, destroying the slow build's temp file mid-write. Two
    // builds racing in one directory must both produce readable snapshots.
    it("two builds writing into the same directory both survive", async () => {
      await withTempDir(async (dir) => {
        const a = generateCatalog(101, 30);
        const b = generateCatalog(202, 12);

        const [ia, ib] = await Promise.all([
          buildDiskIndex(dir, "albumIndex:v3:concurrent-a", a),
          buildDiskIndex(dir, "albumIndex:v3:concurrent-b", b),
        ]);

        expect(
          (await readAlbumIndexAll<AlbumSummary>(ia, 0, a.length)).map((it) => it.id)
        ).toEqual(a.map((it) => it.id));
        expect(
          (await readAlbumIndexAll<AlbumSummary>(ib, 0, b.length)).map((it) => it.id)
        ).toEqual(b.map((it) => it.id));
      });
    });
  });
});
