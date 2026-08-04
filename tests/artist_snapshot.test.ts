import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";

import { ArtistRecord } from "../src/music_library";
import { AlbumIndexBucket } from "../src/album_index";
import {
  ArtistSnapshotWriter,
  albumIndexStore,
  readAlbumIndexPage,
  readAlbumIndexAll,
  enforceSnapshotBounds,
} from "../src/album_snapshot";

// Build a disk-backed ARTIST index the way Subsonic.fetchArtistIndex does: stream records to the
// snapshot file while building one contiguous bucket per Navidrome letter group, then finalize with
// the whole-catalog album total. Returns the disk-backed index (items empty, offsets resident).
async function buildDiskArtistIndex(
  dir: string,
  key: string,
  groups: { name: string; artist: ArtistRecord[] }[]
) {
  const writer = new ArtistSnapshotWriter(dir, key);
  await writer.open();
  const buckets: AlbumIndexBucket[] = [];
  let total = 0;
  let totalAlbumCount = 0;
  for (const g of groups) {
    if (g.artist.length === 0) continue;
    buckets.push({ key: g.name, label: g.name, offset: total, count: g.artist.length });
    for (const a of g.artist) {
      await writer.write(a);
      total++;
      totalAlbumCount += a.albumCount;
    }
  }
  const { snapshotFile, offsets } = await writer.finalize(buckets, totalAlbumCount);
  return { total, buckets, items: [] as ArtistRecord[], snapshotFile, offsets, totalAlbumCount };
}

const rec = (id: string, name: string, albumCount = 0): ArtistRecord => ({
  id,
  name,
  albumCount,
  image: undefined,
});

describe("artist_snapshot: a disk-backed artist index is served page-by-page from disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-artist-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps items empty, offsets resident, and serves each Navidrome letter from disk", async () => {
    const groups = [
      { name: "A", artist: [rec("a1", "Aphex", 1), rec("a2", "Autechre", 3)] },
      { name: "B", artist: [rec("b1", "Boards", 2)] },
    ];
    const disk = await buildDiskArtistIndex(dir, "artists:v2:user", groups);

    // DISK-BACKED: items empty, offsets a Uint32Array of (total + 1), snapshot file on disk.
    expect(disk.items).toEqual([]);
    expect(disk.offsets).toBeInstanceOf(Uint32Array);
    expect(disk.offsets.length).toBe(3 + 1);
    expect(disk.offsets[0]).toBe(0);
    expect(fs.existsSync(disk.snapshotFile)).toBe(true);
    // The whole-catalog album total (sum of albumCount) is carried on the index.
    expect(disk.totalAlbumCount).toBe(1 + 3 + 2);

    // Each letter is served from disk as an exact slice (Navidrome letters verbatim).
    const a = await readAlbumIndexPage(disk, "A", 0, 10);
    expect(a.total).toBe(2);
    expect(a.items.map((x) => x.id)).toEqual(["a1", "a2"]);
    const b = await readAlbumIndexPage(disk, "B", 0, 10);
    expect(b.items.map((x) => x.id)).toEqual(["b1"]);
    // A second page of "A" is empty, total still the letter's.
    const aPage2 = await readAlbumIndexPage(disk, "A", 2, 10);
    expect(aPage2.items).toEqual([]);
    expect(aPage2.total).toBe(2);

    // The flat scan-order slice works too (the legacy flat-list path).
    expect((await readAlbumIndexAll(disk, 0, 100)).map((x) => x.id)).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
  });
});

describe("artist_snapshot: totalAlbumCount round-trips through finalize -> load", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-artist-tac-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores totalAlbumCount on the resident index after a restart", async () => {
    const built = await buildDiskArtistIndex(
      dir,
      "artists:v2:user",
      [
        { name: "A", artist: [rec("a1", "Aphex", 4), rec("a2", "Autechre", 1)] },
        { name: "B", artist: [rec("b1", "Boards", 2)] },
      ]
    );
    // albumIndexStore loads EVERY index kind in the shared dir; the artist snapshot is reconstructed
    // with its persisted totalAlbumCount, items empty, offsets resident.
    const loaded = albumIndexStore(dir).load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.key).toBe("artists:v2:user");
    const idx = loaded[0]!.value as any;
    expect(idx.totalAlbumCount).toBe(4 + 1 + 2);
    expect(idx.items).toEqual([]);
    expect(idx.offsets).toBeInstanceOf(Uint32Array);
    // The restored index serves the same letter page the freshly-built one does.
    expect(
      (await readAlbumIndexPage(idx, "A", 0, 10)).items.map((x: any) => x.id)
    ).toEqual((await readAlbumIndexPage(built, "A", 0, 10)).items.map((x) => x.id));
    // built file is retained (it is the newest).
    expect(fs.existsSync(built.snapshotFile)).toBe(true);
  });

  it("DOWNGRADES a malformed totalAlbumCount instead of discarding the whole index", async () => {
    const built = await buildDiskArtistIndex(
      dir,
      "artists:v2:user",
      [{ name: "A", artist: [rec("a1", "Aphex", 1)] }]
    );
    // Hand-edit the trailer: totalAlbumCount must be a non-negative integer; a string is corruption.
    const raw = fs.readFileSync(built.snapshotFile);
    const size = raw.length;
    const trailerLen = raw.readUInt32LE(size - 8);
    const magic = raw.readUInt32LE(size - 4);
    const trailerStart = size - 8 - trailerLen;
    const trailer = JSON.parse(raw.subarray(trailerStart, size - 8).toString("utf8"));
    trailer.totalAlbumCount = "not-a-number";
    const newTrailerBuf = Buffer.from(JSON.stringify(trailer), "utf8");
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(newTrailerBuf.length, 0);
    footer.writeUInt32LE(magic, 4);
    fs.writeFileSync(
      built.snapshotFile,
      Buffer.concat([raw.subarray(0, trailerStart), newTrailerBuf, footer])
    );
    // Refusing the file over one unusable number would throw away a perfectly good artist index -
    // the failure mode the numeric-years outage taught us to avoid. The index still loads; only the
    // total is absent.
    const loaded = albumIndexStore(dir).load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0]!.value as { totalAlbumCount?: number }).totalAlbumCount).toBeUndefined();
  });
});

// Craft a generation token with a KNOWN order (mirrors album_snapshot.test.ts): 9-char zero-padded
// base36 timestamp + 10 hex. base36 char-code order matches digit-value order, so these zero-padded
// tokens sort lexicographically as numbers — deterministic eviction order without real wall-clock.
const gen = (ts: number) => ts.toString(36).padStart(9, "0") + "0000000000";
const keyHashOf = (key: string) => createHash("sha1").update(key).digest("hex");
const writeNamed = (dir: string, prefix: string, key: string, ts: number, bytes: number) => {
  const full = path.join(dir, `${prefix}${keyHashOf(key)}.${gen(ts)}.dat`);
  fs.writeFileSync(full, Buffer.alloc(bytes));
  return full;
};

describe("artist_snapshot: the shared directory bounds album + artist together", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-artist-bound-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // NEGATIVE for the enforcer generalization: the OLD enforceSnapshotBounds only knew the album
  // prefix, so it was BLIND to artist files — it would see only the album files, never reach the byte
  // cap, and evict nothing (so BOTH old generations would survive). The generalized enforcer sees
  // both kinds and reclaims one. Reverting src/ turns this red.
  it("the global byte cap spans album + artist and reclaims the globally-oldest generation", async () => {
    const albumKey = "albumIndex:v3:user";
    const artistKey = "artists:v2:user";
    const albumOld = writeNamed(dir, "albumSnapshot.v3.", albumKey, 1_000, 1000);
    const albumNew = writeNamed(dir, "albumSnapshot.v3.", albumKey, 2_000, 1000);
    const artistOld = writeNamed(dir, "artistSnapshot.v2.", artistKey, 1_000, 1000);
    const artistNew = writeNamed(dir, "artistSnapshot.v2.", artistKey, 2_000, 1000);

    // 4 × 1000 B = 4000 B; keepPerKey 2 keeps both generations per key (no Layer-1 eviction); a 3500 B
    // cap forces ONE Layer-2 eviction of the globally-oldest reclaimable generation.
    await enforceSnapshotBounds(dir, { maxBytes: 3500, keepPerKey: 2, protectPerKey: 1 });

    // Each kind's ACTIVE newest (the live index) is protected — retention never lets one kind evict
    // the other's active generation.
    expect(fs.existsSync(albumNew)).toBe(true);
    expect(fs.existsSync(artistNew)).toBe(true);
    // Exactly one of the two old generations (token 1000) is reclaimed to get under the cap; the
    // other survives. (Old code blind to artist files would keep BOTH olds → this assertion fails.)
    const oldSurvivors = [fs.existsSync(albumOld), fs.existsSync(artistOld)].filter(Boolean).length;
    expect(oldSurvivors).toBe(1);
  });

  it("never evicts either kind's active newest even when the cap is below the active set", async () => {
    const albumKey = "albumIndex:v3:user";
    const artistKey = "artists:v2:user";
    const albumNew = writeNamed(dir, "albumSnapshot.v3.", albumKey, 2_000, 1000);
    const artistNew = writeNamed(dir, "artistSnapshot.v2.", artistKey, 2_000, 1000);

    // A 1-byte cap below the 2000 B active set: reclaim everything reclaimable (nothing here — both
    // are the protected newest-per-key) and retain both, logging rather than breaking reads.
    await enforceSnapshotBounds(dir, { maxBytes: 1, keepPerKey: 1, protectPerKey: 1 });

    expect(fs.existsSync(albumNew)).toBe(true);
    expect(fs.existsSync(artistNew)).toBe(true);
  });
});

describe("artist_snapshot: the writer aborts cleanly on a failed build", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-artist-abort-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops the half-written temp file when abort() is called", async () => {
    const w = new ArtistSnapshotWriter(dir, "artists:v2:user");
    await w.open();
    await w.write(rec("a1", "Aphex", 1));
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length).toBe(1);
    await w.abort();
    expect(
      fs.readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".dat"))
    ).toEqual([]);
  });
});
