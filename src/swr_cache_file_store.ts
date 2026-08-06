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
  // A temp file older than this cannot belong to a live write (we serialise writes and none is in
  // flight at construction), so it is an orphan from a previous process.
  const STALE_TEMP_MS = 10 * 60 * 1000;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn(`SwrCache file store: could not create ${dir}: ${e}`);
  }

  const fileFor = (key: string) =>
    path.join(dir, createHash("sha1").update(key).digest("hex") + ".json");

  // The store's json files, newest first, with size (best-effort; unreadable entries dropped).
  // Saves since the directory was last rescanned to enforce the file-count bound. See save().
  // Seeded high so the FIRST save prunes: a restart should reclaim whatever the previous run left.
  let savesSincePrune = Number.MAX_SAFE_INTEGER;

  // Background writes. Serialised GLOBALLY, not per key: fs.promises writes, renames and
  // dns.lookup all share the libuv threadpool (4 slots by default), so an unbounded number of
  // concurrent multi-MB writes to a saturated disk starves DNS for outbound backend calls - the
  // original incident's signature, reproduced with the synchronous write already removed.
  // One at a time also preserves last-write-wins per key for free.
  let writeQueue: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<void>>();
  let tmpCounter = 0;

  // Synchronous variant, used ONLY by load(), which runs once at construction before the HTTP
  // listener starts. Blocking there is not just acceptable but wanted: the cache must be seeded
  // before the first browse. The hot path uses the async variant below.
  const listByNewestSync = (): { path: string; size: number }[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: { path: string; size: number; mtimeMs: number }[] = [];
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* an entry that vanished is simply not a candidate */
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.map(({ path: p, size }) => ({ path: p, size }));
  };

  // ASYNC. This is readdir + a stat per file; as sync calls it blocked the event loop for the
  // same reason writeFileSync did, and savesSincePrune is seeded so the FIRST save after every
  // restart prunes - putting that sweep in the cold-start window, when the box is already slowest.
  const listByNewest = async (): Promise<{ path: string; size: number }[]> => {
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: { path: string; size: number; mtimeMs: number }[] = [];
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = await fs.promises.stat(p);
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // an entry that vanished or cannot be stat'd is simply not a prune candidate
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out.map(({ path: p, size }) => ({ path: p, size }));
  };

  // Orphaned temp files. A synchronous write could only strand one if the process died mid-write;
  // an async write is in flight across many event-loop turns, so a SIGTERM during a redeploy can
  // leave a multi-MB .tmp behind. Nothing ever removed them - the file-count bound only counts
  // .json - so on a bind-mounted cache dir they accumulated forever. Swept at startup, where no
  // write of ours can be in flight yet.
  const sweepStaleTemps = () => {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith(".tmp")) continue;
        const p = path.join(dir, n);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > STALE_TEMP_MS)
            fs.rmSync(p, { force: true });
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* best-effort */
    }
  };


  // Clear orphans left by a previous process before anything else uses the directory.
  sweepStaleTemps();

  return {
    load() {
      const out: { key: string; at: number; value: unknown }[] = [];
      for (const { path: p, size } of listByNewestSync().slice(0, maxFiles)) {
        if (size > maxFileBytes) {
          // Never read an oversized / hostile file - but SAY SO. Skipping silently turns a
          // catalog outgrowing the cap into a permanent, invisible regression: the entry is
          // dropped on every restart, every first browse is cold, and nothing anywhere explains
          // why. That is precisely how a cliff like this stays undiagnosed for months.
          logger.warn(
            `Cache file ${path.basename(p)} is ${size} bytes, over the ${maxFileBytes}-byte read cap; skipping it. Its key will be cold on every restart until the cap is raised.`
          );
          continue;
        }
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
      // ASYNCHRONOUS on purpose. This used to be writeFileSync, on the event loop, and the browse
      // cache holds multi-megabyte entries (a 5.2MB file on the live library). When the disk was
      // saturated by a Navidrome library scan, one such write blocked the whole process: bonob sat
      // at 0% CPU while EVERY handler breached its 4500ms deadline, including getMetadata:root,
      // which makes no upstream call at all. Persistence must never be able to stall serving.
      const file = fileFor(key);
      // Serialised behind every other pending write (see writeQueue).
      const run = writeQueue.then(async () => {
        // Unique per write: a shared per-pid temp name meant two in-flight saves of one key wrote
        // the SAME temp file and renamed it twice, which interleaved can publish a truncated doc.
        const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
        try {
          await fs.promises.writeFile(tmp, JSON.stringify({ key, at, value }));
          await fs.promises.rename(tmp, file); // atomic replace
        } catch (e) {
          try {
            await fs.promises.rm(tmp, { force: true });
          } catch {
            /* ignore cleanup failure */
          }
          logger.warn(`SwrCache file store: could not persist ${key}: ${e}`);
          return;
        }
        // Bound the directory - but NOT on every save. listByNewest() is a directory scan plus a
        // stat of every file; running it per persisted value meant a browse storm paid a full
        // directory scan per cache entry. The bound is a disk-space guard, not a correctness
        // invariant, so pruning once per maxFiles saves is O(1) amortised and still bounds the
        // directory at 2x maxFiles.
        savesSincePrune += 1;
        if (savesSincePrune >= maxFiles) {
          savesSincePrune = 0;
          for (const { path: p } of (await listByNewest()).slice(maxFiles)) {
            try {
              await fs.promises.rm(p, { force: true });
            } catch {
              /* best-effort */
            }
          }
        }
      });

      // The queue must never reject: one failed write would poison every later one.
      const settled = run.catch(() => {});
      writeQueue = settled;
      pending.add(settled);
      void settled.finally(() => pending.delete(settled));
      return settled;
    },

    // Await every write still in flight. Used on shutdown: with a synchronous write, a returned
    // save() meant bytes on disk; asynchronously, a redeploy moments after a browse would
    // otherwise lose the entry this layer exists to preserve.
    async flush() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
