import fs from "fs";
import os from "os";
import path from "path";
import logger from "../src/logger";
import { fileStore } from "../src/swr_cache_file_store";

describe("fileStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "swrstore-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips values across a restart (save, then a fresh store loads)", async () => {
    const s1 = fileStore(dir);
    await s1.save("artists:sonos", 1000, [{ id: "1", name: "A" }]);
    await s1.save("albumPage:sonos:x:0", 2000, [{ id: "a" }]);
    const loaded = fileStore(dir).load();
    expect(loaded).toContainEqual({
      key: "artists:sonos",
      at: 1000,
      value: [{ id: "1", name: "A" }],
    });
    expect(loaded).toContainEqual({
      key: "albumPage:sonos:x:0",
      at: 2000,
      value: [{ id: "a" }],
    });
  });

  it("overwrites the same key so the latest value wins", async () => {
    const s = fileStore(dir);
    await s.save("k", 1, "old");
    await s.save("k", 2, "new");
    const loaded = fileStore(dir).load();
    expect(loaded.filter((e) => e.key === "k")).toEqual([
      { key: "k", at: 2, value: "new" },
    ]);
  });

  it("load() skips a corrupt file instead of throwing", async () => {
    const s = fileStore(dir);
    await s.save("good", 1, "v");
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not json");
    const loaded = fileStore(dir).load();
    expect(loaded).toEqual([{ key: "good", at: 1, value: "v" }]);
  });

  it("load() on an empty dir returns []", async () => {
    expect(fileStore(dir).load()).toEqual([]);
  });

  it("never reads a file larger than maxFileBytes (a huge/hostile file can't OOM startup)", async () => {
    await fileStore(dir, { maxFileBytes: 200 }).save("small", 1, "v");
    fs.writeFileSync(
      path.join(dir, "huge.json"),
      JSON.stringify({ key: "huge", at: 2, value: "x".repeat(1000) })
    );
    const loaded = fileStore(dir, { maxFileBytes: 200 }).load();
    expect(loaded.map((e) => e.key)).toEqual(["small"]);
  });

  // The bound is AMORTISED, not immediate. save() used to rescan the whole directory (readdirSync
  // plus a statSync per file) on EVERY persisted value, synchronously, while SOAP handlers race a
  // 4500ms deadline; it now prunes once per maxFiles saves. So at most maxFiles new files can
  // accumulate between prunes and the directory never exceeds 2x maxFiles - in production that is
  // a 256x reduction in directory scans for at most 256 extra small JSON files, which is a bound
  // on DISK, not a correctness invariant.
  it("keeps the directory bounded across many saves (amortised)", async () => {
    const s = fileStore(dir, { maxFiles: 2 });
    for (const [k, v] of [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["f", "F"]])
      await s.save(k!, 1, v);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(4); // 2x maxFiles
  });

  it("skips an entry with a missing/non-finite timestamp", async () => {
    await fileStore(dir).save("good", 1, "v");
    fs.writeFileSync(path.join(dir, "noat.json"), '{"key":"noat","value":"x"}');
    fs.writeFileSync(path.join(dir, "nullat.json"), '{"key":"nullat","at":null,"value":"x"}');
    const loaded = fileStore(dir).load();
    expect(loaded.map((e) => e.key)).toEqual(["good"]);
  });

  // ---------------------------------------------------------------------------
  // Error paths: persistence is best-effort, so every I/O failure is logged and
  // swallowed. Each branch below pins one catch so a mutation that drops the
  // warn, changes the swallowed error into a throw, or removes the cleanup turns
  // red.
  // ---------------------------------------------------------------------------

  it("logs a warning and keeps going when the cache directory cannot be created", async () => {
    // Construction must not throw even if mkdirSync fails: the warn fires and the
    // store is still returned so serving never breaks on a transient perms error.
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const mkdirSpy = jest
      .spyOn(fs, "mkdirSync")
      .mockImplementation(() => {
        throw new Error("mkdir: permission denied");
      });

    expect(() => fileStore(path.join(dir, "nope"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not create")
    );

    mkdirSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("load() returns [] when the cache directory cannot be read (readdirSync throws)", async () => {
    // listByNewest's readdir catch degrades to [] so a missing/unreadable dir
    // looks like an empty cache rather than crashing the restore.
    const s = fileStore(dir);
    await s.save("good", 1, "v");
    const readdirSpy = jest
      .spyOn(fs, "readdirSync")
      .mockImplementation(() => {
        throw new Error("readdir: permission denied");
      });

    expect(s.load()).toEqual([]);

    readdirSpy.mockRestore();
  });

  it("load() drops an entry whose stat() fails (statSync throws inside listByNewest)", async () => {
    // A file that vanishes between readdir and stat must be silently skipped, not
    // crash the whole restore.
    const s = fileStore(dir);
    await s.save("good", 1, "v");
    const statSpy = jest.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat: no such file");
    });

    expect(s.load()).toEqual([]);

    statSpy.mockRestore();
  });

  it("save() logs a warning and swallows the error when the write fails, and cleans up the temp file", async () => {
    // The atomic write/rename catch: the write rejects -> remove the temp, log, return.
    // Persistence failure must NEVER propagate to the browse path. Now that the write is
    // asynchronous the failure arrives as a REJECTED PROMISE rather than a throw, which is a
    // strictly easier way to become an unhandled rejection - so this pins that it does not.
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const writeSpy = jest
      .spyOn(fs.promises, "writeFile")
      .mockRejectedValue(new Error("write: ENOSPC") as never);
    const rmSpy = jest.spyOn(fs.promises, "rm").mockResolvedValue(undefined as never);

    const s = fileStore(dir);
    await expect(s.save("k", 1, "v")).resolves.toBeUndefined();

    expect(rmSpy).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), {
      force: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );

    writeSpy.mockRestore();
    rmSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("save() still logs and swallows when temp-file cleanup ALSO fails (inner catch)", async () => {
    // An ENOSPC write followed by an rm failure must not escape save() as an unhandled rejection.
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const writeSpy = jest
      .spyOn(fs.promises, "writeFile")
      .mockRejectedValue(new Error("write: ENOSPC") as never);
    const rmSpy = jest
      .spyOn(fs.promises, "rm")
      .mockRejectedValue(new Error("rm: EPERM") as never);

    const s = fileStore(dir);
    await expect(s.save("k", 1, "v")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );

    writeSpy.mockRestore();
    rmSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not rescan the directory on every save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-prune-"));
    const store = fileStore(dir);
    const readdir = jest.spyOn(fs, "readdirSync");
    readdir.mockClear();

    for (let i = 0; i < 25; i++) await store.save(`k${i}`, i, { v: i });

    // one scan for the batch, not one per save
    expect(readdir.mock.calls.length).toBeLessThan(25);
    readdir.mockRestore();
  });

  it("still persists every value it was given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-prune2-"));
    const store = fileStore(dir);
    for (let i = 0; i < 5; i++) await store.save(`key${i}`, i + 1, { v: i });
    expect(fileStore(dir).load().length).toEqual(5);
  });
});

describe("not blocking the event loop", () => {
  // bonob sat at 0% CPU while EVERY SMAPI handler breached its 4500ms deadline - including
  // getMetadata:root, which makes no upstream call at all. The cause was here: save() wrote each
  // persisted value with fs.writeFileSync, on the event loop, and the live browse cache holds
  // multi-megabyte entries (a 5.2MB file was written during the incident) on a disk that a
  // Navidrome library scan was saturating. A synchronous multi-MB write blocks every request in
  // the process regardless of which backend it needs. The prune sweep was already throttled off
  // the hot path for this exact reason; the value write itself was missed.
  it("persists without a synchronous write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-store-async-"));
    const writeSync = jest.spyOn(fs, "writeFileSync");
    try {
      const store = fileStore(dir);
      const big = { rows: new Array(20000).fill("a-reasonably-long-row-of-text") };

      await store.save("bigKey", Date.now(), big);
      await new Promise((r) => setTimeout(r, 250));

      expect(writeSync).not.toHaveBeenCalled();
      const restored = [...store.load()].find((e) => e.key === "bigKey");
      expect(restored).toBeDefined();
      expect((restored!.value as typeof big).rows.length).toEqual(20000);
    } finally {
      writeSync.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps concurrent saves of the same key from corrupting each other", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-store-race-"));
    try {
      const store = fileStore(dir);
      // A shared pid-based temp name means two in-flight saves of one key write the SAME temp
      // file and rename it twice; interleaved, that publishes a truncated document.
      for (let i = 0; i < 12; i++) await store.save("sameKey", Date.now(), { i, pad: "x".repeat(50000) });
      await new Promise((r) => setTimeout(r, 400));

      const restored = [...store.load()].find((e) => e.key === "sameKey");
      expect(restored).toBeDefined();
      expect(typeof (restored!.value as { i: number }).i).toEqual("number");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Per-key chaining still let an unbounded number of DISTINCT keys write at once. fs.promises
  // writes, renames and dns.lookup all share the libuv threadpool (4 by default), so a handful of
  // concurrent multi-MB writes to a saturated disk starve DNS resolution for outbound Navidrome
  // calls - reproducing the original incident's signature with the synchronous write already gone.
  it("does not run unbounded concurrent writes across distinct keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-store-conc-"));
    let inFlight = 0;
    let peak = 0;
    const realWrite = fs.promises.writeFile;
    const spy = jest
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(async (...args: unknown[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await (realWrite as never as (...a: unknown[]) => Promise<void>)(...args);
        } finally {
          inFlight -= 1;
        }
      });
    try {
      const store = fileStore(dir);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.save(`key${i}`, 1, { i }))
      );
      expect(peak).toEqual(1);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // listByNewest is readdirSync + statSync per file, and savesSincePrune is seeded so the FIRST
  // save after every restart prunes - putting a synchronous multi-hundred-syscall sweep in the
  // cold-start window, on the same event loop, for the same reason writeFileSync was a problem.
  it("prunes without synchronous directory syscalls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-store-prune-sync-"));
    const readdirSync = jest.spyOn(fs, "readdirSync");
    const statSync = jest.spyOn(fs, "statSync");
    try {
      const store = fileStore(dir, { maxFiles: 2 });
      readdirSync.mockClear();
      statSync.mockClear();

      for (let i = 0; i < 4; i++) await store.save(`k${i}`, i + 1, { i });

      expect(readdirSync).not.toHaveBeenCalled();
      expect(statSync).not.toHaveBeenCalled();
    } finally {
      readdirSync.mockRestore();
      statSync.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // An async write is in flight across many event-loop turns, so SIGTERM during a redeploy can
  // strand a multi-MB .tmp. Nothing ever removed those: the bound only counts .json files.
  it("sweeps stale temp files on load so they cannot accumulate forever", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-store-tmp-"));
    try {
      const orphan = path.join(dir, "abc.json.999.7.tmp");
      fs.writeFileSync(orphan, "half-written");
      fs.utimesSync(orphan, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

      fileStore(dir).load();

      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
