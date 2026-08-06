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

  it("round-trips values across a restart (save, then a fresh store loads)", () => {
    const s1 = fileStore(dir);
    s1.save("artists:sonos", 1000, [{ id: "1", name: "A" }]);
    s1.save("albumPage:sonos:x:0", 2000, [{ id: "a" }]);
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

  it("overwrites the same key so the latest value wins", () => {
    const s = fileStore(dir);
    s.save("k", 1, "old");
    s.save("k", 2, "new");
    const loaded = fileStore(dir).load();
    expect(loaded.filter((e) => e.key === "k")).toEqual([
      { key: "k", at: 2, value: "new" },
    ]);
  });

  it("load() skips a corrupt file instead of throwing", () => {
    const s = fileStore(dir);
    s.save("good", 1, "v");
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not json");
    const loaded = fileStore(dir).load();
    expect(loaded).toEqual([{ key: "good", at: 1, value: "v" }]);
  });

  it("load() on an empty dir returns []", () => {
    expect(fileStore(dir).load()).toEqual([]);
  });

  it("never reads a file larger than maxFileBytes (a huge/hostile file can't OOM startup)", () => {
    fileStore(dir, { maxFileBytes: 200 }).save("small", 1, "v");
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
  it("keeps the directory bounded across many saves (amortised)", () => {
    const s = fileStore(dir, { maxFiles: 2 });
    for (const [k, v] of [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["f", "F"]])
      s.save(k!, 1, v);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(4); // 2x maxFiles
  });

  it("skips an entry with a missing/non-finite timestamp", () => {
    fileStore(dir).save("good", 1, "v");
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

  it("logs a warning and keeps going when the cache directory cannot be created", () => {
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

  it("load() returns [] when the cache directory cannot be read (readdirSync throws)", () => {
    // listByNewest's readdir catch degrades to [] so a missing/unreadable dir
    // looks like an empty cache rather than crashing the restore.
    const s = fileStore(dir);
    s.save("good", 1, "v");
    const readdirSpy = jest
      .spyOn(fs, "readdirSync")
      .mockImplementation(() => {
        throw new Error("readdir: permission denied");
      });

    expect(s.load()).toEqual([]);

    readdirSpy.mockRestore();
  });

  it("load() drops an entry whose stat() fails (statSync throws inside listByNewest)", () => {
    // A file that vanishes between readdir and stat must be silently skipped, not
    // crash the whole restore.
    const s = fileStore(dir);
    s.save("good", 1, "v");
    const statSpy = jest.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat: no such file");
    });

    expect(s.load()).toEqual([]);

    statSpy.mockRestore();
  });

  it("save() logs a warning and swallows the error when the write fails, and cleans up the temp file", () => {
    // The atomic write/rename catch: writeFileSync throws -> remove the temp, log,
    // return. Persistence failure must NEVER propagate to the browse path.
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("write: ENOSPC");
    });
    const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    const s = fileStore(dir);
    expect(() => s.save("k", 1, "v")).not.toThrow();
    // The temp file cleanup ran (best-effort, force: true).
    expect(rmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      { force: true }
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );

    writeSpy.mockRestore();
    rmSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("save() still logs and swallows when temp-file cleanup ALSO fails (inner catch)", () => {
    // The inner `catch { /* ignore */ }` around rmSync: an ENOSPC write followed
    // by an rm failure must not turn into an unhandled throw out of save().
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("write: ENOSPC");
    });
    const rmSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("rm: permission denied");
    });

    const s = fileStore(dir);
    expect(() => s.save("k", 1, "v")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not persist")
    );

    writeSpy.mockRestore();
    rmSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("prune cost", () => {
  // save() used to run listByNewest() - a readdirSync plus a statSync of EVERY file in the
  // directory - on every persisted value, synchronously, on the event loop, while SOAP handlers
  // are racing a 4500ms browse deadline. A browse storm that populates many albumPage/search3
  // keys paid that repeatedly. The write itself is one small file; the directory scan is the cost.
  it("does not rescan the directory on every save", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-prune-"));
    const store = fileStore(dir);
    const readdir = jest.spyOn(fs, "readdirSync");
    readdir.mockClear();

    for (let i = 0; i < 25; i++) store.save(`k${i}`, i, { v: i });

    // one scan for the batch, not one per save
    expect(readdir.mock.calls.length).toBeLessThan(25);
    readdir.mockRestore();
  });

  it("still persists every value it was given", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bonob-prune2-"));
    const store = fileStore(dir);
    for (let i = 0; i < 5; i++) store.save(`key${i}`, i + 1, { v: i });
    expect(fileStore(dir).load().length).toEqual(5);
  });
});
