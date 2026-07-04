import fs from "fs";
import os from "os";
import path from "path";
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
});
