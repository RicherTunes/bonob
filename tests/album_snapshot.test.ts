import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";

import { AlbumSummary } from "../src/music_library";
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

  it("also sweeps stale .tmp files left by a build that crashed before its rename", async () => {
    const key = "albumIndex:v3:tmp";
    const good = writeNamedSnapshot(dir, key, 1_000, 100);
    const staleTmp = path.join(
      dir,
      `albumSnapshot.v3.${keyHashOf(key)}.${gen(500)}.tmp`
    );
    fs.writeFileSync(staleTmp, Buffer.alloc(50));

    await enforceSnapshotBounds(dir, {});

    expect(fs.existsSync(good)).toBe(true);
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
