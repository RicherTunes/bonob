import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { SwrCacheStore } from "./swr_cache";
import logger from "./logger";

// A file-backed SwrCacheStore so the browse cache survives a restart. One JSON file per key
// (named by a hash of the key) under `dir`, each holding { key, at, value }. Writes are atomic
// (temp file + rename) and best-effort: any I/O error is logged and swallowed so persistence
// never breaks serving.
//
// Bounded on disk (a busy library browses many album offsets over many restarts): at most
// `maxFiles` files are kept, the oldest pruned on each write; and a file larger than
// `maxFileBytes` is never read, so a corrupt/hostile multi-GB file cannot OOM or stall startup.
export function fileStore(
  dir: string,
  opts: { maxFiles?: number; maxFileBytes?: number } = {}
): SwrCacheStore {
  const maxFiles = opts.maxFiles ?? 256;
  const maxFileBytes = opts.maxFileBytes ?? 16 * 1024 * 1024;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn(`SwrCache file store: could not create ${dir}: ${e}`);
  }

  const fileFor = (key: string) =>
    path.join(dir, createHash("sha1").update(key).digest("hex") + ".json");

  // The store's json files, newest first, with size (best-effort; unreadable entries dropped).
  const listByNewest = (): { path: string; size: number }[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((f) => {
        try {
          const p = path.join(dir, f);
          const st = fs.statSync(p);
          return { path: p, size: st.size, mtime: st.mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((x): x is { path: string; size: number; mtime: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime);
  };

  return {
    load() {
      const out: { key: string; at: number; value: unknown }[] = [];
      for (const { path: p, size } of listByNewest().slice(0, maxFiles)) {
        if (size > maxFileBytes) continue; // never read an oversized / hostile file
        try {
          const e = JSON.parse(fs.readFileSync(p, "utf8"));
          if (
            e &&
            typeof e.key === "string" &&
            typeof e.at === "number" &&
            Number.isFinite(e.at)
          ) {
            out.push({ key: e.key, at: e.at, value: e.value });
          }
        } catch {
          // skip a corrupt/partial file rather than fail the whole restore
        }
      }
      return out;
    },

    save(key, at, value) {
      const file = fileFor(key);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ key, at, value }));
        fs.renameSync(tmp, file); // atomic replace
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore cleanup failure */
        }
        logger.warn(`SwrCache file store: could not persist ${key}: ${e}`);
        return;
      }
      // Bound the directory: prune the oldest files beyond maxFiles.
      for (const { path: p } of listByNewest().slice(maxFiles)) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
