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

  it("caps the directory to maxFiles on save (bounds disk)", () => {
    const s = fileStore(dir, { maxFiles: 2 });
    s.save("a", 1, "A");
    s.save("b", 2, "B");
    s.save("c", 3, "C");
    s.save("d", 4, "D");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(2);
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
