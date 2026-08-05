import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";

import { AlbumSummary } from "../src/music_library";
import logger from "../src/logger";
import {
  BucketBuilder,
  buildAlbumIndexFromPages,
  albumIndexPage,
  albumIndexAll,
} from "../src/album_index";
import {
  AlbumSnapshotWriter,
  albumIndexStore,
  readAlbumIndexPage,
  readAlbumIndexAll,
  enforceSnapshotBounds,
} from "../src/album_snapshot";

// Build a disk-backed index the same way Subsonic.buildAlbumIndex does: stream records to the
// snapshot file while bucketing, then finalize. Returns the disk-backed AlbumIndex (items empty,
// offsets + snapshotFile set).
async function buildDiskIndex(
  dir: string,
  key: string,
  records: AlbumSummary[]
) {
  const builder = new BucketBuilder<AlbumSummary>();
  const writer = new AlbumSnapshotWriter(dir, key);
  await writer.open();
  for (const album of records) {
    builder.append(album);
    await writer.write(album);
  }
  const { snapshotFile, offsets } = await writer.finalize(builder.buckets);
  return {
    total: builder.total,
    buckets: builder.buckets,
    items: [] as AlbumSummary[],
    snapshotFile,
    offsets,
  };
}

// Full AlbumSummary records (year + genre included) so a round-trip assertion actually exercises
// field preservation — a fixture with only {id,name} cannot detect a field being dropped.
const names = (...ns: string[]) =>
  ns.map(
    (name, i) =>
      ({
        id: `${name}-${i}`,
        name,
        year: `${1970 + (i % 50)}`,
        genre: { name: "Rock", id: "rock" },
        coverArt: { system: "subsonic", resource: `art:${name}-${i}` } as any,
        artistId: "artist-0",
        artistName: "Artist 0",
      } as AlbumSummary)
  );

// A deterministic catalog of AlbumSummary records (full record, incl. year/genre — never dropped).
const catalog = (size: number, tag: string): AlbumSummary[] =>
  Array.from({ length: size }, (_, i) => ({
    id: `${tag}-${i}`,
    name: `Album ${tag} ${i}`,
    year: `${1970 + (i % 50)}`,
    genre: { name: "Rock", id: "rock" },
    coverArt: { system: "subsonic", resource: `art:${tag}-${i}` } as any,
    artistId: `artist-${tag}`,
    artistName: `Artist ${tag}`,
  }));

describe("album_snapshot: disk page matches the in-memory index", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves the same items/total as the resident index for every letter and page", async () => {
    // Scattered runs (a stray "A" after "B") so pages span multiple ranges too.
    const records = names(
      "Apple",
      "Avocado",
      "Banana",
      "Apex",
      "Cherry",
      "Cantaloupe",
      "Date"
    );
    const mem = buildAlbumIndexFromPages([records]);
    const disk = await buildDiskIndex(dir, "albumIndex:v3:user", records);

    // Sanity: the shared BucketBuilder keeps bucketing identical.
    expect(disk.buckets).toEqual(mem.buckets);
    expect(disk.total).toBe(mem.total);
    // Disk-backed: items empty, offsets resident as a Uint32Array.
    expect(disk.items).toEqual([]);
    expect(disk.offsets).toBeInstanceOf(Uint32Array);
    expect(disk.offsets!.length).toBe(records.length + 1);
    expect(disk.offsets![0]).toBe(0);

    for (const key of ["A", "B", "C", "D", "Z"]) {
      for (let page = 0; page < 5; page++) {
        const fromMem = albumIndexPage(mem, key, page, 2);
        const fromDisk = await readAlbumIndexPage(disk, key, page, 2);
        expect(fromDisk.total).toBe(fromMem.total);
        expect(fromDisk.items.map((a) => a.id)).toEqual(
          fromMem.items.map((a) => (a as { id: string }).id)
        );
        // The full AlbumSummary round-trips (year + genre survive — never dropped).
        for (const a of fromDisk.items) {
          expect(typeof a.year).toBe("string");
          expect(a.genre).toEqual({ name: "Rock", id: "rock" });
        }
      }
    }
  });

  it("readAlbumIndexAll slices the same scan-order range as the resident index", async () => {
    const records = catalog(25, "x");
    const mem = buildAlbumIndexFromPages([records]);
    const disk = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    expect(await readAlbumIndexAll(disk, 5, 10)).toEqual(albumIndexAll(mem, 5, 10));
    expect((await readAlbumIndexAll(disk, 0, 100)).length).toBe(25);
    expect(await readAlbumIndexAll(disk, 30, 10)).toEqual([]); // past the end
  });

  it("readAlbumIndexPage falls back to the synchronous slice for an in-memory index", async () => {
    const mem = buildAlbumIndexFromPages([names("Apple", "Avocado", "Banana")]);
    const page = await readAlbumIndexPage(mem, "A", 0, 10);
    expect(page.items.map((a) => a.name)).toEqual(["Apple", "Avocado"]);
    expect(page.total).toBe(2);
  });
});

describe("album_snapshot: letter bucketing is unchanged on the disk path", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("produces the same contiguous runs the pure reducer does", async () => {
    const records = names(
      "Apple",
      "Avocado",
      "Banana",
      "Apex",
      "9 to 5",
      "Cherry"
    );
    const mem = buildAlbumIndexFromPages([records]);
    const disk = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    expect(disk.buckets).toEqual([
      { key: "A", label: "A", offset: 0, count: 2 },
      { key: "B", label: "B", offset: 2, count: 1 },
      { key: "A", label: "A", offset: 3, count: 1 },
      { key: "#", label: "#", offset: 4, count: 1 },
      { key: "C", label: "C", offset: 5, count: 1 },
    ]);
    expect(disk.buckets).toEqual(mem.buckets);
  });
});

describe("album_snapshot: a truncated or corrupt snapshot is refused, never served", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid snapshot on restart", async () => {
    const records = catalog(10, "ok");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.key).toBe("albumIndex:v3:user");
    expect(loaded[0]!.value).toMatchObject({ total: 10 });
    // The restored index serves the same page the freshly-built one does.
    const disk = loaded[0]!.value as any;
    const page = await readAlbumIndexPage(disk, "A", 0, 10);
    expect(page.items.map((a: any) => a.id)).toEqual(
      (await readAlbumIndexPage(built, "A", 0, 10)).items.map((a) => a.id)
    );
    // built file is retained (it is the newest).
    expect(fs.existsSync(built.snapshotFile)).toBe(true);
  });

  it("refuses a file truncated mid-records (footer/trailer lost)", async () => {
    const records = catalog(50, "trunc");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    // Chop off the last 200 bytes (footer + part of trailer / records).
    const size = fs.statSync(built.snapshotFile).size;
    fs.truncateSync(built.snapshotFile, size - 200);
    expect(albumIndexStore(dir).load()).toEqual([]);
  });

  it("refuses a file whose footer magic is wrong", async () => {
    const records = catalog(10, "magic");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    const size = fs.statSync(built.snapshotFile).size;
    const fd = fs.openSync(built.snapshotFile, "r+");
    // Overwrite the 4 magic bytes at the very end (footer = [len:4][magic:4]).
    fs.writeSync(fd, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, size - 4);
    fs.closeSync(fd);
    expect(albumIndexStore(dir).load()).toEqual([]);
  });

  it("refuses a file extended with trailing garbage (footer no longer at the end)", async () => {
    const records = catalog(10, "extend");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    // Append garbage after the footer: the last 8 bytes are no longer the magic footer, and the
    // recorded record-region end (offsets[total]) no longer matches where a trailer would start.
    fs.appendFileSync(built.snapshotFile, Buffer.from("garbage that extends the file"));
    expect(albumIndexStore(dir).load()).toEqual([]);
  });

  it("ignores an unrelated / garbage file in the directory", async () => {
    fs.writeFileSync(path.join(dir, "albumSnapshot.v3.deadbeef.dat"), "not a snapshot");
    fs.writeFileSync(path.join(dir, "random.json"), "{}");
    const records = catalog(5, "good");
    await buildDiskIndex(dir, "albumIndex:v3:user", records);
    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.value).toMatchObject({ total: 5 });
  });

  it("a short read after load (file shrank) throws rather than serving partial data", async () => {
    const records = catalog(20, "shrink");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    const disk = albumIndexStore(dir).load()[0]!.value as any;
    // Truncate INTO the records region. Records live at the START of the file ([0, offsets[total]));
    // the trailer + 8-byte footer are at the END. A tail truncation only eats the trailer/footer and
    // leaves every record readable, so it would never produce a short read. Cutting below the
    // records-region end makes the full-page read [0, offsets[total]) come up short.
    const recordsEnd = disk.offsets[disk.total] as number;
    fs.truncateSync(built.snapshotFile, recordsEnd - 10);
    await expect(readAlbumIndexPage(disk, "A", 0, 20)).rejects.toThrow(/short read/);
  });

  it("a read with the right byte count but misaligned record boundaries is refused", async () => {
    const records = catalog(20, "misalign");
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", records);
    const disk = albumIndexStore(dir).load()[0]!.value as any;
    // Overwrite the records region IN PLACE (same file size, so the byte-range read returns the
    // right byte COUNT) with bytes whose newlines no longer line up with the loaded offsets — the
    // decoded records either fail to parse or do not number `n`, and the read is refused rather than
    // returned as garbage. (Load-time validation only checks structure; this is the read-time guard.)
    const recordsEnd = disk.offsets[disk.total] as number;
    const buf = fs.readFileSync(built.snapshotFile);
    buf.fill(0x41 /* 'A' */, 0, recordsEnd); // no newlines → record boundaries no longer line up
    fs.writeFileSync(built.snapshotFile, buf);
    await expect(readAlbumIndexPage(disk, "A", 0, 20)).rejects.toThrow();
  });
});

describe("album_snapshot: drift is impossible across a rebuild", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an in-flight index keeps reading its own immutable file after a rebuild", async () => {
    const key = "albumIndex:v3:user";
    // Build A: a catalog where "A" holds Apple/Avocado.
    const indexA = await buildDiskIndex(
      dir,
      key,
      names("Apple", "Avocado", "Banana")
    );
    const pageA_before = await readAlbumIndexPage(indexA, "A", 0, 10);
    expect(pageA_before.items.map((a) => a.name)).toEqual(["Apple", "Avocado"]);

    // Rebuild for the SAME key with a DIFFERENT catalog (a Navidrome rescan reordered everything;
    // now "A" holds entirely different records).
    const indexB = await buildDiskIndex(
      dir,
      key,
      names("Apricot", "Aubergine", "Blueberry")
    );

    // Different immutable files.
    expect(indexA.snapshotFile).not.toBe(indexB.snapshotFile);

    // The OLD index A still reads its OWN file — its offsets never point into B's file, so it
    // returns A's records, NOT B's. This is exactly the drift (wrong-letter) class the snapshot
    // exists to prevent.
    const pageA_after = await readAlbumIndexPage(indexA, "A", 0, 10);
    expect(pageA_after.items.map((a) => a.name)).toEqual(["Apple", "Avocado"]);
    expect(pageA_after.items.map((a) => a.name)).not.toContain("Apricot");

    // The new index reads its own file.
    const pageB = await readAlbumIndexPage(indexB, "A", 0, 10);
    expect(pageB.items.map((a) => a.name)).toEqual(["Apricot", "Aubergine"]);

    // A's file is still on disk (cleanup keeps the previous snapshot).
    expect(fs.existsSync(indexA.snapshotFile!)).toBe(true);
  });

  it("rebuilds for one key collapse to a single loaded entry and a bounded file count", async () => {
    const key = "albumIndex:v3:multi";
    // Four rebuilds for the same key. load() dedups by key (one entry), and cleanup keeps at most
    // two .dat files per key so disk does not grow unbounded across rebuilds.
    for (let i = 0; i < 4; i++) {
      await buildDiskIndex(dir, key, catalog(3 + i, `g${i}`));
    }
    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.key).toBe(key);
    const datFiles = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("albumSnapshot.v3.") && n.endsWith(".dat"));
    expect(datFiles.length).toBeLessThanOrEqual(2);
  });
});

// Craft a generation token with a KNOWN order, mirroring generationToken() in album_snapshot.ts
// (9-char zero-padded base36 timestamp + 10 hex). base36's char-code order matches its digit-value
// order, so these zero-padded tokens sort lexicographically as numbers — letting a test assert
// eviction order deterministically without waiting on real wall-clock time.
const gen = (ts: number) => ts.toString(36).padStart(9, "0") + "0000000000";
const keyHashOf = (key: string) =>
  createHash("sha1").update(key).digest("hex");
const writeNamedSnapshot = (dir: string, key: string, ts: number, bytes: number) => {
  const full = path.join(dir, `albumSnapshot.v3.${keyHashOf(key)}.${gen(ts)}.dat`);
  fs.writeFileSync(full, Buffer.alloc(bytes));
  return full;
};

describe("album_snapshot: disk bounding — generation token, not mtime; global bound across keys", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-bound-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("evicts by GENERATION token and is unmoved by a deliberately misleading mtime", async () => {
    // The negative test for findings 1+3: ordering must ride on the token embedded in the name,
    // never on filesystem mtimeMs. Here the OLDER generation is given the NEWER mtime — exactly the
    // tie that made the old mtime-based pruning pick the wrong "previous" and evict the live file.
    // A mtime-based keepPerKey=1 implementation would retain `older`; the token-based one retains
    // `newer`.
    const key = "albumIndex:v3:tie";
    const older = writeNamedSnapshot(dir, key, 1_000, 500); // older TOKEN
    const newer = writeNamedSnapshot(dir, key, 2_000, 500); // newer TOKEN
    const t = Date.now() / 1000;
    fs.utimesSync(older, t, t + 100); // older gen, NEWER mtime (adversarial)
    fs.utimesSync(newer, t, t); // newer gen, OLDER mtime

    await enforceSnapshotBounds(dir, { keepPerKey: 1, protectPerKey: 1 });

    expect(fs.existsSync(newer)).toBe(true); // newest generation kept despite OLDER mtime
    expect(fs.existsSync(older)).toBe(false); // older generation evicted despite NEWER mtime
  });

  it("retains the previous generation across a rebuild so an in-flight browse keeps its file", async () => {
    // RETAIN-not-delete: with keepPerKey 2, a rebuild does not delete the immediately-previous
    // generation. An in-flight browse that still holds the superseded AlbumIndex keeps a readable
    // file (this is the live-reader window the snapshot's immutability exists to protect).
    const key = "albumIndex:v3:retain";
    const g1 = writeNamedSnapshot(dir, key, 1_000, 500);
    const g2 = writeNamedSnapshot(dir, key, 2_000, 500); // a rebuild

    await enforceSnapshotBounds(dir, { keepPerKey: 2, protectPerKey: 1 });

    expect(fs.existsSync(g1)).toBe(true); // previous generation retained
    expect(fs.existsSync(g2)).toBe(true); // newest retained
  });

  it("bounds TOTAL bytes across ALL keys, evicting the globally-oldest generation first", async () => {
    // Two keys, each an old + new generation (1000 B each, 4000 B total). A 3500 B cap forces one
    // eviction. The globally-oldest generation (key1's old, token 1000 — older than key2's old at
    // 2000) is reclaimed; both keys keep their newest (the active indexes).
    const k1 = "albumIndex:v3:k1";
    const k2 = "albumIndex:v3:k2";
    const k1Old = writeNamedSnapshot(dir, k1, 1_000, 1000);
    const k1New = writeNamedSnapshot(dir, k1, 3_000, 1000);
    const k2Old = writeNamedSnapshot(dir, k2, 2_000, 1000);
    const k2New = writeNamedSnapshot(dir, k2, 4_000, 1000);

    await enforceSnapshotBounds(dir, { maxBytes: 3500, keepPerKey: 2, protectPerKey: 1 });

    expect(fs.existsSync(k1Old)).toBe(false); // globally-oldest reclaimed
    expect(fs.existsSync(k2Old)).toBe(true); // newer than k1Old, still under cap
    expect(fs.existsSync(k1New)).toBe(true); // active index protected
    expect(fs.existsSync(k2New)).toBe(true); // active index protected
  });

  it("never evicts the active newest-per-key even when the cap is below the active set", async () => {
    // A cap smaller than a single active index: reclaim everything reclaimable, but never the
    // newest per key (protectPerKey 1) — evicting it would break every current and next read. The
    // store logs and stays over the cap rather than corrupting serving.
    const key = "albumIndex:v3:smallcap";
    const old = writeNamedSnapshot(dir, key, 1_000, 1000);
    const now = writeNamedSnapshot(dir, key, 2_000, 1000);

    await enforceSnapshotBounds(dir, { maxBytes: 1, keepPerKey: 2, protectPerKey: 1 });

    expect(fs.existsSync(old)).toBe(false); // reclaimable older generation evicted
    expect(fs.existsSync(now)).toBe(true); // active newest NEVER evicted, even over the cap
  });

  it("applies BOTH layers correctly: per-key cap then global cap, with honest accounting", async () => {
    // Three generations of one key (oldest/mid/newest), keepPerKey 2, tiny global cap. Layer 1
    // evicts the rank-2 (oldest, beyond the per-key cap of 2); Layer 2 then evicts the rank-1
    // (reclaimable, oldest-first) to meet the byte cap, leaving ONLY the active newest. This catches
    // an accounting bug where Layer 2 re-counted files Layer 1 already deleted.
    const key = "albumIndex:v3:layers";
    const oldest = writeNamedSnapshot(dir, key, 1_000, 1000);
    const mid = writeNamedSnapshot(dir, key, 2_000, 1000);
    const newest = writeNamedSnapshot(dir, key, 3_000, 1000);

    await enforceSnapshotBounds(dir, { maxBytes: 1, keepPerKey: 2, protectPerKey: 1 });

    expect(fs.existsSync(oldest)).toBe(false); // Layer 1: beyond keepPerKey
    expect(fs.existsSync(mid)).toBe(false); // Layer 2: reclaimable to meet the byte cap
    expect(fs.existsSync(newest)).toBe(true); // active newest, never evicted
  });

  // enforceSnapshotBounds runs from finalize(), i.e. WHILE other builds may still be streaming
  // into their own .tmp files, and it cannot tell "stale, from a crashed build" apart from
  // "in flight, owned by a build running right now". It used to sweep .tmp here, so the first
  // build to finish deleted every other in-flight build's temp file and those builds died with
  // ENOENT on their own rename. Sweeping is albumIndexStore().load()'s job, at startup, when no
  // build can be in flight. See the concurrent-build property test.
  it("must NOT sweep .tmp files: a concurrent build may own them", async () => {
    const key = "albumIndex:v3:tmp";
    const good = writeNamedSnapshot(dir, key, 1_000, 100);
    const inFlightTmp = path.join(
      dir,
      `albumSnapshot.v3.${keyHashOf(key)}.${gen(500)}.tmp`
    );
    fs.writeFileSync(inFlightTmp, Buffer.alloc(50));

    await enforceSnapshotBounds(dir, {});

    expect(fs.existsSync(good)).toBe(true);
    expect(fs.existsSync(inFlightTmp)).toBe(true);
  });

  it("albumIndexStore().load() is what sweeps stale .tmp, at startup", () => {
    const key = "albumIndex:v3:tmp-startup";
    const staleTmp = path.join(
      dir,
      `albumSnapshot.v3.${keyHashOf(key)}.${gen(500)}.tmp`
    );
    fs.writeFileSync(staleTmp, Buffer.alloc(50));

    albumIndexStore(dir).load();

    expect(fs.existsSync(staleTmp)).toBe(false);
  });
});

describe("album_snapshot: years persist in the trailer and survive a restart", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-years-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the distinct years through finalize -> load", async () => {
    const records = catalog(10, "yr"); // years 1970..1979
    const builder = new BucketBuilder<AlbumSummary>();
    const writer = new AlbumSnapshotWriter(dir, "albumIndex:v3:years");
    await writer.open();
    for (const album of records) {
      builder.append(album);
      await writer.write(album);
    }
    const years = [...new Set(records.map((r) => r.year!))].sort();
    await writer.finalize(builder.buckets, years);

    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    const idx = loaded[0]!.value as any;
    // The years persisted in the trailer are restored on the resident index (O(1) serve after a
    // restart, not a re-scan).
    expect(idx.years).toEqual(years);
  });

  it("loads a trailer with NO years field (back-compat) as years undefined, not rejected", async () => {
    // buildDiskIndex finalizes without passing years, exactly like a pre-change v3 snapshot.
    const built = await buildDiskIndex(dir, "albumIndex:v3:noyears", catalog(5, "ny"));
    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect((loaded[0]!.value as any).years).toBeUndefined();
    expect(built.snapshotFile).toBeDefined();
  });

  it("loads a snapshot whose years are NUMBERS, which is what the writer actually produces", async () => {
    // Found by deploying and reading the real 30.8MB snapshot off the VPS: all 113 years were
    // stored as NUMBERS, and validateTrailer required `every(y => typeof y === "string")`. So the
    // writer emitted a trailer its own validator rejected, load() returned zero entries, and EVERY
    // restart silently discarded a valid index and paid a full ~17-minute catalog rescan.
    //
    // Navidrome returns `year` as a JSON number while the `album.year` type says string - the same
    // "the type asserts what the server does not send" defect as TrackStream.headers. Existing
    // files must keep loading, so numbers are accepted and coerced rather than rejected.
    const records = catalog(6, "yrnum");
    const builder = new BucketBuilder<AlbumSummary>();
    const writer = new AlbumSnapshotWriter(dir, "albumIndex:v3:yrnum");
    await writer.open();
    for (const album of records) {
      builder.append(album);
      await writer.write(album);
    }
    // Exactly what the live file contained: numeric years.
    await writer.finalize(builder.buckets, [1970, 1971, 1972] as unknown as string[]);

    const loaded = albumIndexStore(dir).load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0]!.value as { years?: string[] }).years).toEqual([
      "1970",
      "1971",
      "1972",
    ]);
  });

  it("refuses a trailer whose years field is malformed (corruption, not back-compat)", async () => {
    const records = catalog(5, "bad");
    const built = await buildDiskIndex(dir, "albumIndex:v3:badyears", records);
    // Patch the trailer's JSON in place: replace the well-formed trailer by rewriting the file with a
    // trailer whose `years` is not a string[]. The footer (last 8 bytes) and record region are kept
    // intact by rebuilding from a fresh writer's structure is overkill; instead corrupt just the
    // years value by hand-editing the parsed trailer and re-serializing.
    const raw = fs.readFileSync(built.snapshotFile);
    // Locate the trailer: it is the bytes between (size - 8 - trailerLen) and (size - 8).
    const size = raw.length;
    const trailerLen = raw.readUInt32LE(size - 8);
    const trailerStart = size - 8 - trailerLen;
    const trailer = JSON.parse(raw.subarray(trailerStart, size - 8).toString("utf8"));
    trailer.years = "not-an-array"; // malformed
    const newTrailerBuf = Buffer.from(JSON.stringify(trailer), "utf8");
    // Rebuild the file: records + new trailer + a footer with the new trailer length + original magic.
    const recordsRegion = raw.subarray(0, trailerStart);
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(newTrailerBuf.length, 0);
    footer.writeUInt32LE(raw.readUInt32LE(size - 4), 4); // preserve the original magic
    fs.writeFileSync(built.snapshotFile, Buffer.concat([recordsRegion, newTrailerBuf, footer]));
    // offsets[total] still equals the (unchanged) record-region length, so only the years check fails.
    expect(albumIndexStore(dir).load()).toEqual([]);
  });
});

// --- helpers for the recovery / mutation-killing tests below ---

// Rewrite a built snapshot's trailer in place: parse the existing trailer JSON, run `mutate` on it,
// re-serialize, and rewrite the file as [records region][new trailer][footer (new len, same magic)].
// The records region is byte-identical and the footer magic is preserved, so readTrailerSync still
// reaches validateTrailer, and trailerStart always recomputes to the (unchanged) records-region end.
// Each caller mutates EXACTLY one field, so the targeted validateTrailer guard is the one that fires.
const overwriteTrailer = (file: string, mutate: (t: any) => void) => {
  const raw = fs.readFileSync(file);
  const size = raw.length;
  const trailerLen = raw.readUInt32LE(size - 8);
  const magic = raw.readUInt32LE(size - 4);
  const trailerStart = size - 8 - trailerLen;
  const trailer = JSON.parse(raw.subarray(trailerStart, size - 8).toString("utf8"));
  mutate(trailer);
  const newTrailerBuf = Buffer.from(JSON.stringify(trailer), "utf8");
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(newTrailerBuf.length, 0);
  footer.writeUInt32LE(magic, 4);
  fs.writeFileSync(file, Buffer.concat([raw.subarray(0, trailerStart), newTrailerBuf, footer]));
};

// A byte buffer of exactly `len` bytes that decodes as TWO valid JSON values (so a page expecting ONE
// record sees a count mismatch). Layout: `"x"\n` then `"<pad>"\n`. Both lines are valid JSON; pad
// fills the remainder with 'x's inside a JSON string so the byte length matches the original record.
const twoJsonLinesFilling = (len: number): Buffer => {
  const pad = len - 7; // 4 (line1) + pad + 3 (quote+quote+newline)
  if (pad <= 0) throw new Error(`record too short to split: ${len}`);
  return Buffer.concat([
    Buffer.from('"x"\n'),
    Buffer.from('"'),
    Buffer.alloc(pad, 0x78),
    Buffer.from('"\n'),
  ]);
};

// validateTrailer is the guard against a half-written snapshot being served as complete. Each row
// corrupts ONE trailer field in a way that the magic, length, JSON parse, and record-region invariant
// all still hold, so readTrailerSync reaches validateTrailer and the targeted guard is the SOLE one
// that fires (every corruption below is accepted if and only if its own guard is removed).
describe("album_snapshot: validateTrailer refuses each structurally corrupt trailer", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-validate-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, (t: any) => void]> = [
    ["version is not ALBUM_SNAPSHOT_VERSION", (t) => { t.v = 2; }],
    ["key is empty", (t) => { t.key = ""; }],
    ["at is zero", (t) => { t.at = 0; }],
    ["at is non-finite", (t) => { t.at = Number.NaN; }],
    ["offsets length is not total+1 (longer, offsets[total] preserved)", (t) => {
      t.offsets = [...t.offsets, ...Array(9).fill(0)];
    }],
    ["bucket.key is not a string", (t) => { t.buckets[0].key = 9; }],
    ["bucket.offset breaks run contiguity", (t) => { t.buckets[0].offset = 1; }],
    ["bucket counts no longer sum to total", (t) => {
      t.buckets[t.buckets.length - 1].count += 1;
    }],
    ["offsets[0] is not zero", (t) => { t.offsets[0] = 1; }],
    ["an offset is negative", (t) => { t.offsets[1] = -1; }],
    ["an offset exceeds the uint32 ceiling", (t) => { t.offsets[1] = 0x100000000; }],
    ["an offset is not an integer", (t) => { t.offsets[1] = 1.5; }],
    ["offsets[total] no longer lands at the trailer start", (t) => {
      t.offsets[t.total] = t.offsets[t.total] + 5;
    }],
  ];

  it.each(cases)("refuses a trailer whose %s", async (_label, mutate) => {
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", catalog(10, "c"));
    overwriteTrailer(built.snapshotFile, mutate);
    expect(albumIndexStore(dir).load()).toEqual([]);
  });
});

describe("album_snapshot: crash / partial-write recovery arms", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-recover-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("readTrailerSync swallows a stat failure and refuses the file (defensive outer catch)", () => {
    // A snapshot file that vanishes between readdirSync and readTrailerSync (or whose stat otherwise
    // fails) must not take the whole load() down: readTrailerSync's outer try/catch turns it into a
    // refused (skipped) file. Build first (no spy), then make statSync throw for the load.
    return buildDiskIndex(dir, "albumIndex:v3:user", catalog(5, "c")).then(() => {
      const spy = jest.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("boom");
      });
      try {
        expect(albumIndexStore(dir).load()).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("write() refuses a record that would cross the 4 GiB addressable limit", async () => {
    // The resident index is a Uint32Array, so a record past 4 GiB can never be located. The guard is
    // a pure arithmetic check on (flushedBytes + batchBytes + buf.length); fake flushedBytes near the
    // ceiling (avoids 4 GiB of real I/O) and confirm the next record is rejected.
    const w = new AlbumSnapshotWriter(dir, "albumIndex:v3:big");
    await w.open();
    (w as any).flushedBytes = 0xffffffff - 10;
    await expect(w.write({ id: "x" })).rejects.toThrow(/4 GiB addressable limit/);
    await w.abort();
  });

  it("flush() refuses when a batch is pending but open() was never called", async () => {
    const w = new AlbumSnapshotWriter(dir, "albumIndex:v3:noflush");
    await w.write({ id: "a" }); // buffers under the flush threshold, no fh required
    await expect((w as any).flush()).rejects.toThrow(/used before open/);
  });

  it("finalize() refuses before open()", async () => {
    const w = new AlbumSnapshotWriter(dir, "albumIndex:v3:nofinalize");
    await expect(w.finalize([])).rejects.toThrow(/used before open/);
  });

  it("abort() drops the temp file and writes no .dat", async () => {
    const w = new AlbumSnapshotWriter(dir, "albumIndex:v3:abort");
    await w.open();
    await w.write({ id: "a" });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length).toBe(1);
    await w.abort();
    expect(
      fs.readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".dat"))
    ).toEqual([]);
  });
});

describe("album_snapshot: on-disk decode guards refuse right-bytes / wrong-structure reads", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-decode-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("readAlbumIndexPage refuses when decoded record count is wrong (right byte count, wrong shape)", async () => {
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", catalog(10, "c"));
    // Overwrite the FIRST record's byte range [0, offsets[1]) with TWO valid JSON values that fill
    // exactly the same number of bytes. The byte-range read returns the right COUNT of bytes; the
    // newline split now yields 2 records for a page that expected 1 → refused rather than served.
    const firstEnd = built.offsets![1]!;
    const raw = fs.readFileSync(built.snapshotFile);
    fs.writeFileSync(
      built.snapshotFile,
      Buffer.concat([twoJsonLinesFilling(firstEnd), raw.subarray(firstEnd)])
    );
    await expect(readAlbumIndexPage(built, "A", 0, 1)).rejects.toThrow(/decode mismatch/);
  });

  it("readAlbumIndexAll refuses when decoded record count is wrong", async () => {
    const built = await buildDiskIndex(dir, "albumIndex:v3:user", catalog(10, "c"));
    const firstEnd = built.offsets![1]!;
    const raw = fs.readFileSync(built.snapshotFile);
    fs.writeFileSync(
      built.snapshotFile,
      Buffer.concat([twoJsonLinesFilling(firstEnd), raw.subarray(firstEnd)])
    );
    await expect(readAlbumIndexAll(built, 0, 1)).rejects.toThrow(/decode mismatch/);
  });
});

describe("album_snapshot: disk-bound enforcer tolerates failure", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-boundrec-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a missing directory (readdirSync throws → return)", async () => {
    const missing = path.join(os.tmpdir(), "bonob-no-such-dir-" + Date.now());
    expect(fs.existsSync(missing)).toBe(false);
    await expect(enforceSnapshotBounds(missing, {})).resolves.toBeUndefined();
  });

  it("continues evicting when one rm fails (best-effort, never throws)", async () => {
    // Three generations of one key; the OLDEST is beyond keepPerKey=2 (Layer 1), the middle is
    // reclaimable (Layer 2). Make rm reject for the middle file only: it must be left in place, the
    // other eviction must still happen, and enforceSnapshotBounds must NOT throw.
    const key = "albumIndex:v3:rmfail";
    const newest = writeNamedSnapshot(dir, key, 3_000, 100); // rank 0 — protected
    const mid = writeNamedSnapshot(dir, key, 2_000, 100); // rank 1 — reclaimable (rm will fail)
    const oldest = writeNamedSnapshot(dir, key, 1_000, 100); // rank 2 — beyond keepPerKey (Layer 1)

    const realRm = fs.promises.rm.bind(fs.promises);
    const spy = jest.spyOn(fs.promises, "rm").mockImplementation(((
      p: any,
      o?: any
    ) =>
      String(p) === mid
        ? Promise.reject(new Error("locked"))
        : realRm(p, o)) as any);

    try {
      await enforceSnapshotBounds(dir, {
        maxBytes: 1,
        keepPerKey: 2,
        protectPerKey: 1,
      });
      expect(fs.existsSync(newest)).toBe(true); // active index protected
      expect(fs.existsSync(oldest)).toBe(false); // Layer 1 eviction succeeded
      expect(fs.existsSync(mid)).toBe(true); // rm failed → best-effort left in place
    } finally {
      spy.mockRestore();
    }
  });

  it("Layer 2 evicts the globally-oldest reclaimable generations first (comparator direction)", async () => {
    // Five generations of one key, keepPerKey 4, protectPerKey 1, a 250-byte cap. After Layer 1
    // drops the single oldest, Layer 2 must evict the OLDEST of the reclaimable set until under the
    // cap — i.e. g2000 then g3000, leaving g4000. Inverting the comparator evicts g4000/g3000 first
    // and leaves g2000, which this assertion catches.
    const key = "albumIndex:v3:l2cmp";
    const g1 = writeNamedSnapshot(dir, key, 1_000, 100); // rank 4 — Layer 1
    const g2 = writeNamedSnapshot(dir, key, 2_000, 100); // reclaimable, oldest
    const g3 = writeNamedSnapshot(dir, key, 3_000, 100); // reclaimable
    const g4 = writeNamedSnapshot(dir, key, 4_000, 100); // reclaimable, kept under the cap
    const g5 = writeNamedSnapshot(dir, key, 5_000, 100); // rank 0 — protected

    await enforceSnapshotBounds(dir, { maxBytes: 250, keepPerKey: 4, protectPerKey: 1 });

    expect(fs.existsSync(g5)).toBe(true);
    expect(fs.existsSync(g4)).toBe(true); // survived because g2+g3 reclaimed first
    expect(fs.existsSync(g3)).toBe(false);
    expect(fs.existsSync(g2)).toBe(false);
    expect(fs.existsSync(g1)).toBe(false);
  });
});

describe("album_snapshot: store startup recovery arms", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("albumIndexStore logs and continues when it cannot create the store dir", () => {
    const spyMk = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("cannot mkdir");
    });
    const spyWarn = jest.spyOn(logger, "warn").mockImplementation((() => undefined) as any);
    try {
      expect(() => albumIndexStore(dir)).not.toThrow();
      expect(spyWarn).toHaveBeenCalled();
    } finally {
      spyMk.mockRestore();
      spyWarn.mockRestore();
    }
  });

  it("load() sweeps stale .tmp files at startup", async () => {
    await buildDiskIndex(dir, "albumIndex:v3:user", catalog(3, "c"));
    const staleTmp = path.join(
      dir,
      `albumSnapshot.v3.${keyHashOf("albumIndex:v3:user")}.${gen(500)}.tmp`
    );
    fs.writeFileSync(staleTmp, Buffer.alloc(20));
    expect(fs.existsSync(staleTmp)).toBe(true);
    const loaded = albumIndexStore(dir).load();
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(loaded.length).toBe(1);
  });

  it("load() tolerates a rmSync failure during the .tmp sweep (best-effort)", async () => {
    await buildDiskIndex(dir, "albumIndex:v3:user", catalog(3, "c"));
    const staleTmp = path.join(
      dir,
      `albumSnapshot.v3.${keyHashOf("albumIndex:v3:user")}.${gen(500)}.tmp`
    );
    fs.writeFileSync(staleTmp, Buffer.alloc(20));
    const spy = jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("locked");
    });
    try {
      // The .tmp sweep is best-effort; a failure must not prevent the .dat from loading.
      expect(() => albumIndexStore(dir).load()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("load() returns [] when the store directory cannot be read", () => {
    const spy = jest.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("io");
    });
    try {
      expect(albumIndexStore(dir).load()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("load() keeps the newest-at entry for a key (does not overwrite with an older generation)", async () => {
    // Two valid snapshots for the same key. We swap their `at` values so the FIRST-iterated file
    // (older generation token) carries the NEWER at: it sets the bar, and the second file's older at
    // must NOT overwrite it (the `trailer.at > existing.at` guard's else arm).
    const a = await buildDiskIndex(dir, "albumIndex:v3:user", catalog(4, "a"));
    const b = await buildDiskIndex(dir, "albumIndex:v3:user", catalog(4, "b"));
    const atA = 9_000;
    const atB = 1_000;
    overwriteTrailer(a.snapshotFile!, (t: any) => { t.at = atA; });
    overwriteTrailer(b.snapshotFile!, (t: any) => { t.at = atB; });

    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.at).toBe(atA); // the newer-at wins regardless of iteration order
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Loop 2 RESIDUAL. Each test below is a MUTATION-KILLER (verified green → mutated src red →
// restored). Branches that are genuinely masked/dead are NOT tested here — they are proven in the
// dead-branch ledger at the bottom of this file. "One real mutation-killing test > ten line-touchers."
// ─────────────────────────────────────────────────────────────────────────────

describe("album_snapshot: Loop 2 residual mutation-killers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-l2-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // L257 `if (this.batch.length === 0) return`. flush() must short-circuit on an empty batch BEFORE
  // the fh check, so a flush with nothing pending is safe even on an UNOPENED writer. Removing the
  // guard makes flush() reach `if (!fh) throw "used before open"` for this input. (The "opened +
  // empty batch" path that finalize() takes is harmless either way — the no-op for-loop absorbs it —
  // so the unopened-empty case is the SOLE mutation-killing input.)
  it("flush() on an empty batch never requires open() (L257)", async () => {
    const w = new AlbumSnapshotWriter(dir, "albumIndex:v3:emptyflush");
    await expect((w as any).flush()).resolves.toBeUndefined();
  });

  // L349 default-param `= {}`. enforceSnapshotBounds reads opts.maxBytes/keepPerKey/protectPerKey via
  // `??`, so an empty opts object is fine — but a MISSING opts (undefined) only works because of the
  // `= {}` default. Removing the default makes `opts.maxBytes` throw TypeError on a no-arg call.
  it("enforceSnapshotBounds() applies defaults when opts is omitted entirely (L349)", async () => {
    // Removing the `= {}` default makes `opts.maxBytes` throw a TypeError on a no-arg call, so the
    // promise would REJECT - resolving is itself what kills that mutation. (This used to also
    // assert a stray .tmp was swept as proof it ran; enforceSnapshotBounds deliberately no longer
    // sweeps .tmp, because a concurrent build may own it.)
    await expect(enforceSnapshotBounds(dir)).resolves.toBeUndefined();
    // ...and a well-under-bounds directory is left completely intact.
    const key = "albumIndex:v3:defaults";
    const kept = writeNamedSnapshot(dir, key, 1_000, 100);
    await expect(enforceSnapshotBounds(dir)).resolves.toBeUndefined(); // no opts
    expect(fs.existsSync(kept)).toBe(true);
  });

  // L528/L529 in-memory deferral in readAlbumIndexAll. The analogous readAlbumIndexPage deferral
  // (L490) is covered; this one was not. Removing the guard makes `index.offsets[start]` throw on a
  // resident (no-snapshotFile) index.
  it("readAlbumIndexAll falls back to the synchronous slice for an in-memory index (L529)", async () => {
    const mem = buildAlbumIndexFromPages([names("Apple", "Avocado", "Banana")]);
    const first = await readAlbumIndexAll(mem, 0, 2);
    expect(first.map((a) => a.name)).toEqual(["Apple", "Avocado"]);
    const past = await readAlbumIndexAll(mem, 5, 2);
    expect(past).toEqual([]); // off the end
  });

  // L401 per-key ranking comparator `(a,b) => a.gen<b.gen ? 1 : a.gen>b.gen ? -1 : 0`. Existing
  // tests sort <=2 files per key, so V8 evaluates only one comparison direction; both ` < ` and ` > `
  // arms need a multi-element sort to fire. Inverting the comparator keeps the wrong generation, which
  // the survival assertions catch (mutation-killing the DIRECTION of every arm the sort evaluates).
  it("ranks four generations so only the newest survives keepPerKey=1 (L401 both directions)", async () => {
    const key = "albumIndex:v3:rank4";
    const g1 = writeNamedSnapshot(dir, key, 1_000, 100); // oldest
    const g2 = writeNamedSnapshot(dir, key, 2_000, 100);
    const g3 = writeNamedSnapshot(dir, key, 3_000, 100);
    const g4 = writeNamedSnapshot(dir, key, 4_000, 100); // newest
    await enforceSnapshotBounds(dir, { keepPerKey: 1, protectPerKey: 1 });
    expect(fs.existsSync(g4)).toBe(true);
    expect(fs.existsSync(g3)).toBe(false);
    expect(fs.existsSync(g2)).toBe(false);
    expect(fs.existsSync(g1)).toBe(false);
  });

  // L417: the beyondCap `.sort(...)` line + comparator. The filter (L416) is the mutation-killed part
  // (inverting it evicts the retained generations instead), so the survival assertions are real. The
  // sort order itself is cosmetic (the loop evicts ALL of beyondCap), but cross-key files make readdir
  // return them in keyHash order ≠ gen order, so V8's insertion sort evaluates BOTH comparator
  // directions — covering the `a.gen < b.gen` arm that same-key (ascending-gen) inputs cannot.
  it("Layer 1 evicts every generation beyond the per-key cap across keys (L417)", async () => {
    // keyHashes: a(022..) < e(2ce..) < b(53b..). readdir returns a's file before e's, so beyondCap
    // = [a-old(gen5000)? ...] — gen order is decoupled from readdir order across keys.
    const ka = "albumIndex:v3:a";
    const ke = "albumIndex:v3:e";
    const aOld = writeNamedSnapshot(dir, ka, 2_000, 100); // a, rank 1 — beyond cap (keepPerKey 1)
    const aNew = writeNamedSnapshot(dir, ka, 5_000, 100); // a, rank 0 — retained
    const eOld = writeNamedSnapshot(dir, ke, 1_000, 100); // e, rank 1 — beyond cap
    const eNew = writeNamedSnapshot(dir, ke, 6_000, 100); // e, rank 0 — retained
    await enforceSnapshotBounds(dir, { keepPerKey: 1, protectPerKey: 1 });
    expect(fs.existsSync(aNew)).toBe(true);
    expect(fs.existsSync(eNew)).toBe(true);
    expect(fs.existsSync(aOld)).toBe(false); // filter L416: a's rank-1 is beyond cap
    expect(fs.existsSync(eOld)).toBe(false); // filter L416: e's rank-1 is beyond cap
  });

  // L429 Layer-2 reclaimable comparator, CROSS-KEY so V8's insertion sort evaluates the
  // `a.gen < b.gen` direction (same-key inputs are readdir-ascending, which only yield `>`). Three
  // keys, each a protected newest + a reclaimable older gen; a 450 B cap reclaims exactly two of the
  // three reclaimable files OLDEST-first. Inverting the comparator reclaims NEWEST-first, leaving the
  // oldest reclaimable (b, gen 1000) on disk instead of the newest reclaimable (a, gen 3000) — the
  // a/b survival assertions flip, killing the comparator-direction mutation.
  it("Layer 2 reclaims oldest reclaimable across keys until under the cap (L429 both directions)", async () => {
    // readdir order by keyHash: a(022) < e(2ce) < b(53b). reclaimable in readdir order:
    //   [a-gen3000, e-gen2000, b-gen1000] — strictly DESCENDING by gen, so inserting each into the
    //   sorted prefix compares an OLDER first arg → the `a.gen < b.gen` arm fires.
    const aNew = writeNamedSnapshot(dir, "albumIndex:v3:a", 5_000, 100); // a rank 0 (protected)
    const aOld = writeNamedSnapshot(dir, "albumIndex:v3:a", 3_000, 100); // a rank 1 (reclaimable)
    const eNew = writeNamedSnapshot(dir, "albumIndex:v3:e", 4_000, 100); // e rank 0 (protected)
    const eOld = writeNamedSnapshot(dir, "albumIndex:v3:e", 2_000, 100); // e rank 1 (reclaimable)
    const bNew = writeNamedSnapshot(dir, "albumIndex:v3:b", 6_000, 100); // b rank 0 (protected)
    const bOld = writeNamedSnapshot(dir, "albumIndex:v3:b", 1_000, 100); // b rank 1 (reclaimable)
    // 6 files × 100 B = 600 B; cap 450 → reclaim 150 B: evict bOld(gen1000) then eOld(gen2000),
    // leaving aOld(gen3000) on disk. Inverted comparator evicts aOld then eOld, leaving bOld.
    await enforceSnapshotBounds(dir, { maxBytes: 450, keepPerKey: 2, protectPerKey: 1 });
    expect(fs.existsSync(aOld)).toBe(true); // newest reclaimable — survives correct-oldest-first
    expect(fs.existsSync(bOld)).toBe(false); // oldest reclaimable — evicted first
    expect(fs.existsSync(eOld)).toBe(false); // next-oldest — evicted to meet the cap
    expect(fs.existsSync(aNew)).toBe(true);
    expect(fs.existsSync(eNew)).toBe(true);
    expect(fs.existsSync(bNew)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEAD-BRANCH LEDGER — branches/lines left uncovered because they are MASKED defense-in-depth or
// unreachable. Each entry was VERIFIED by mutating the source (weakening/removing the guard) and
// confirming the full suite stayed green — i.e. NO test could tell, because a later guard or the
// outer try/catch produces the identical outcome for every reachable input. "Defense-in-depth is
// valid only with a masking guard" — the masking guard is named in each entry.
// ─────────────────────────────────────────────────────────────────────────────
//
// readTrailerSync (L150): everything sits inside `try { ... } catch { return null; }` (L173). VERIFIED
// by deleting ALL FIVE inner checks at once (size<8, readSync!==8, trailerByteLen<=0|size<8+len,
// readSync!==len, and the inner JSON.parse catch) while keeping the read calls — full suite green.
//
//   L154 `size < 8`: a sub-8-byte file then openSync + readSync at the negative offset size-8 throws
//   → outer catch → null. (Or the all-zero footer → magic 0 ≠ SNAPSHOT_MAGIC at L161.) Masked by the
//   outer catch / L161.
//   L158 `readSync(...) !== 8`: a short footer read leaves bytes 4-7 zero → magic 0 → refused at L161.
//   Masked by L161 (magic check).
//   L162 `trailerByteLen <= 0`: with trailerByteLen=0 the read of 0 bytes yields "" → JSON.parse("")
//   throws → outer catch → null. (size<8+len is false since size≥8.) Masked by L170/outer catch.
//   L164 `readSync(...) !== trailerByteLen`: a short trailer read yields partial/garbage → JSON.parse
//   throws → outer catch → null. Masked by L170/outer catch.
//   L170 inner `catch { return null; }` around JSON.parse: without it, JSON.parse throws straight to
//   the outer catch → null. Masked by the outer catch (L173).
//
// validateTrailer (L101): every early type/shape guard is masked by a LATER guard that refuses the
//   same input, so removing any single one does not change load()'s outcome. VERIFIED one-by-one.
//
//   L106 `!t || typeof t !== "object"`: a primitive (number/string/boolean) reaches `.v` → undefined
//   → refused at L108; null → `.v` throws → readTrailerSync's outer catch → null. Masked by L108 /
//   outer catch. (Verified: dropping `typeof !== "object"` left the suite green.)
//   L111 `typeof o.total !== "number"`: Number.isInteger is false for EVERY non-number, so the very
//   next operand (`!Number.isInteger(o.total)`) catches the same values. Masked by L111's own
//   `!Number.isInteger` operand. (Verified: dropping `typeof !== "number"` left the suite green.)
//   L112 `!Array.isArray(o.buckets)`: a non-iterable buckets throws in `for..of` → outer catch; a
//   string buckets iterates chars whose `.key` is undefined → refused at L121. Masked by L121 / outer
//   catch. (Verified: dropping the buckets isArray operand left the suite green.)
//   L121 `!b` (null bucket): without the guard, `null.key` throws → outer catch → null. Masked by the
//   outer catch. (The `typeof b.key/label !== "string"` arms ARE mutation-killed by the existing
//   "bucket.key is not a string" case — only the `!b` short-circuit is masked.)
//   L122 `typeof b.offset/count !== "number"`: without it, a non-number offset trips L123's
//   `!Number.isInteger` and a non-number count breaks the L126 sum. Masked by L123 / L126.
//
// AlbumSnapshotWriter:
//   L253 auto-flush `if (batchBytes >= flushThreshold)`: a pure performance path — every record is
//   flushed at finalize() regardless, so the on-disk byte content is identical whether or not the
//   mid-build flush fires. VERIFIED: replacing the condition with `false` left the full suite green.
//   No correctness mutation can be killed by it.
//   L312 abort `if (this.fh)` false arm (fh undefined): without the guard, `undefined.close()`
//   throws into the surrounding `try { ... } catch {}` → swallowed → identical outcome. VERIFIED:
//   replacing with `await this.fh!.close()` left the suite green. Masked by the abort try/catch.
//
// Comparator TIE arms (the `0` return):
//   L401 per-key ranking: a tie needs two SAME-key files with the SAME gen token. The gen token is
//   the filename suffix (`albumSnapshot.v3.<keyHash>.<gen>.dat`), so two such files have the SAME
//   path and cannot coexist. Within a key the tie arm is UNREACHABLE. (Across keys the keyHash
//   differs, so they are never compared by L401, which sorts within one byKey bucket.)
//   L417 / L429 tie arm: cross-key same-gen IS constructible on disk (two keys, same ts → same gen),
//   but the generator embeds 5 random bytes (10 hex chars), making tokens globally unique in
//   production. The L417 tie is also moot because the loop evicts ALL of beyondCap regardless of
//   order; the L429 tie only affects which of two equal-generation files is reclaimed first, and both
//   are reclaimable, so no survival assertion can distinguish them. Not mutation-killing.
//
// Comparator DIRECTION arm L401 `a.gen < b.gen ? 1` (arm 51,0): UNCOVERABLE in this environment but
//   NOT dead. L401 sorts WITHIN one byKey bucket (one keyHash), and readdir returns same-key files in
//   ascending-gen order (the filename suffix is a zero-padded token). V8's binary insertion sort then
//   inserts each NEWER element into an older prefix, so the comparator's first argument is always the
//   NEWER file → `a.gen < b.gen` is never true (only `>` fires, arm 52,0). The comparator's DIRECTION
//   is still mutation-killed: inverting it (the test above + the existing "evicts by GENERATION token"
//   suite) evicts the wrong generation. Cross-key inputs cannot reach L401 (it sorts within one key).
//   On Linux (arbitrary readdir order) this arm would be reachable; on Windows (sorted readdir) it is not.
//
// readByteRange / decodeJsonlRecords (module-private, not exported):
//   L451 `if (len <= 0) return Buffer.alloc(0)`: the only callers are readAlbumIndexPage and
//   readAlbumIndexAll. Both compute `end > start` before calling (page: n ≥ 1 since `skip < r.count`;
//   flat: guarded by `if (end <= start) return []` at L535). Each written record is at least
//   `"0"\n` (2 bytes), so offsets strictly increase and end-start is always > 0. Unreachable.
//   L470 `if (text.length === 0) return []`: decodeJsonlRecords is only reached with a buffer from
//   readByteRange, which (per L451 above) is always non-empty, so `buf.toString("utf8")` is non-empty.
//   Unreachable.

describe("album_snapshot: a finalizing writer must not destroy ANOTHER build in flight", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-snap-concurrent-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an in-flight build's .tmp alone when a second writer finalizes", async () => {
    // Deploy blocker found by adversarial review, reproduced end-to-end against the real classes.
    //
    // enforceSnapshotBounds swept EVERY .tmp matching ANY kind prefix, and finalize() calls it.
    // With one writer that was harmless - nothing else ever had a .tmp open. Adding a SECOND,
    // much faster writer to the SAME directory made it lethal: the artist build (seconds) finalizes
    // in the middle of the album build (~15 min at 113k albums) and unlinks the album build's temp
    // file. Fifteen minutes and ~230 Navidrome requests later the album rename fails ENOENT, the
    // index is discarded, and the Albums browse falls back to a placeholder - then repeats the
    // doomed scan on every retry.
    //
    // The sweep is only safe where it began: at startup, when no build is running.
    const albumWriter = new AlbumSnapshotWriter(dir, "albumIndex:v3:alex");
    await albumWriter.open();
    await albumWriter.write(catalog(1, "a")[0]!);

    const albumTmp = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("albumSnapshot.v3.") && n.endsWith(".tmp"));
    expect(albumTmp).toHaveLength(1); // the album build is genuinely in flight

    // A second, faster build for a DIFFERENT kind finishes while the album build is still open.
    const other = new AlbumSnapshotWriter(dir, "albumIndex:v3:someone-else");
    await other.open();
    await other.write(catalog(1, "b")[0]!);
    await other.finalize([{ key: "B", label: "B", offset: 0, count: 1 }]);

    // The in-flight build's temp file must still exist...
    expect(fs.existsSync(path.join(dir, albumTmp[0]!))).toBe(true);
    // ...and its own finalize must still succeed rather than throwing ENOENT.
    await expect(
      albumWriter.finalize([{ key: "A", label: "A", offset: 0, count: 1 }])
    ).resolves.toBeDefined();
  });
});
