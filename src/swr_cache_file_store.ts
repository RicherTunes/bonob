import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { SwrCacheStore } from "./swr_cache";
import logger from "./logger";

// A file-backed SwrCacheStore so the browse cache survives a restart. One JSON file per key
// (named by a hash of the key) under `dir`, each holding { key, at, value }. Writes are atomic
// (temp file + rename). Best-effort throughout: any I/O error is logged and swallowed so
// persistence never breaks serving.
export function fileStore(dir: string): SwrCacheStore {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn(`SwrCache file store: could not create ${dir}: ${e}`);
  }

  const fileFor = (key: string) =>
    path.join(dir, createHash("sha1").update(key).digest("hex") + ".json");

  return {
    load() {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }
      const out: Array<{ key: string; at: number; value: unknown }> = [];
      for (const f of files) {
        try {
          const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (e && typeof e.key === "string" && typeof e.at === "number") {
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
      }
    },
  };
}
