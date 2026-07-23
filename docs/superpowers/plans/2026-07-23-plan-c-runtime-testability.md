# Plan C — Runtime testability implementation plan

**Status:** Ready for execution
**Date:** 2026-07-23
**Repository:** `RicherTunes/bonob`
**Spec:** `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`
**Entry dependency:** Plan B has supplied an exact-`master` candidate digest. Every code slice below starts from the exact current `master` and produces a new exact-master artifact/gate set (spec §4 last paragraph; acceptance criterion 8). Evidence from an earlier code SHA cannot promote a later one.

## 1. Purpose

Plan C makes bonob runtime-testable and safely observable without changing protocol behavior. It is the prerequisite for every post-convergence production promotion, including every Plan D protocol release (spec §1.1 last paragraph; acceptance criterion 14). The deliverables, in mandatory dependency order, are:

1. a behavior-preserving application factory + lifecycle coordinator that owns the listener and a shared cancellation signal;
2. registries for active requests, streams, sockets, and background tasks that observe cancellation;
3. cache refresh/writer quiescence plus versioned envelopes and semantic validation;
4. graceful shutdown that drains/bounds the registries and preserves valid cache;
5. protected internal diagnostics exposing only aggregate health;
6. privacy-safe 429/error attribution and redaction in outbound request logging;
7. a fully disposable candidate topology (Bonob + Navidrome/data/media/cache/credential) with unique candidate sentinels;
8. default-deny candidate/resolver/proxy egress and negative production-reachability proof;
9. a safe browser-link harness (`scripts/bonob-e2e-sweep.ts`) that authenticates through Bonob's real flow and is aggregate-only;
10. cold-cache and snapshot-cache runs against candidate-owned fixtures;
11. an objective two-hour / 1,000-cycle soak with defined sampling and thresholds.

No slice here changes protocol behavior, performs a module extraction, or promotes anything to production (spec §1.1, §11 non-goals).

## 2. Source baseline (read-only evidence)

All line references below were captured against the worktree HEAD `3d45ad2ca26fd1ec3d8f8b52a11aa7f6b13b3634`.

- The app is constructed and a listener is bound at `src/app.ts:147` (`const app = server(...)`) and `src/app.ts:169` (`app.listen(config.port, ...)`).
- The only signal handler is `process.on('SIGTERM', ...)` at `src/app.ts:189`, which closes the HTTP server and calls `process.exit(0)` — it never broadcasts cancellation, drains registries, or quiesces cache writers.
- The HTTP factory is `function server(...)` at `src/server.ts:166`, exported default at `src/server.ts:752`. It returns an Express app but does NOT bind a listener; the listener is bound in `app.ts`.
- `ServerOpts` is declared at `src/server.ts:103` and consumed with defaults at `src/server.ts:146`/`src/server.ts:171`.
- Streams are proxied in `src/server.ts:448` (`app.get("/stream/track/:id", ...)`); the upstream stream is destroyed on `res.on('close')` at `src/server.ts:487` and piped at `src/server.ts:532`. There is no registry of active streams/sockets.
- `SwrCache` is `export class SwrCache` at `src/swr_cache.ts:37`; `SwrCacheStore` interface at `src/swr_cache.ts:13`; `warm` at `src/swr_cache.ts:118`, `peek` at `src/swr_cache.ts:126`, `invalidate` at `src/swr_cache.ts:111`, `get` at `src/swr_cache.ts:133`. There is no quiesce/close or shutdown hook.
- The file store is `export function fileStore` at `src/swr_cache_file_store.ts:15`; `load()` at `src/swr_cache_file_store.ts:54` validates only `{ key:string, at:number }` and does not use a versioned envelope.
- `Subsonic` is declared at `src/subsonic.ts:1048`; outbound GET/POST use `axios` directly at `src/subsonic.ts:1077` and `src/subsonic.ts:1103` with no integration label, correlation ID, or redaction of completion logs. Image fetchers are defined at `src/subsonic.ts:856`/`src/subsonic.ts:927`/`src/subsonic.ts:936`.
- `regUrl` is built from `bonobUrl` in `SonosSoap.getAppLink()` at `src/smapi.ts:226`/`src/smapi.ts:233`.
- `InMemoryAPITokens` is at `src/api_tokens.ts:50`; `JWTSmapiLoginTokens` at `src/smapi_auth.ts:95`; `InMemoryLinkCodes` at `src/link_codes.ts` (process-local map).
- Config is read once via `readConfig()` (default export at the bottom of `src/config.ts`) and parsed at `src/app.ts:13`; `authTimeout`/`linkCodeTimeout`/`port`/`bonobUrl` are the relevant fields.
- Tests use Jest (config `jest.config.js`), SWC transform, `tests/` directory, `tests/setup.js` stubs `console.log`. Existing patterns: `tests/swr_cache.test.ts`, `tests/swr_cache_file_store.test.ts`, `tests/scroll.chaos.test.ts` (deterministic PRNG), `tests/server.test.ts` (supertest against `makeServer`).

## 3. Dependency order and acceptance-criterion map

The task sequence below is mandatory. A later task MUST NOT be started until its predecessors are merged, because each layer's tests depend on the seams introduced by the layer before it (spec §5.2 paragraph 1: "Shutdown, harness, and soak evidence is invalid until these ownership seams and registry invariants have focused tests").

| Task | Title | Primary spec/acceptance refs |
|---|---|---|
| C1 | App factory + lifecycle coordinator | §5.2 ¶1; criterion 10 |
| C2 | Shared cancellation + registries | §5.2 ¶1; criterion 10 |
| C3 | Cache quiescence | §5.2 ¶1; criterion 10, 14 |
| C4 | Versioned cache envelope | §7.1; criterion 12 |
| C5 | Semantic cache validators | §7.1; criterion 12 |
| C6 | Graceful shutdown | §5.2 list 1–6; criterion 14 |
| C7 | Protected diagnostics | §5.2 ¶3; criterion 10 |
| C8 | Attribution + redaction | §5.2 ¶2; criterion 13 |
| C9 | Disposable candidate topology | §6, §7.1; criterion 9, 11 |
| C10 | Default-deny egress + negatives | §7.1 ¶3; criterion 11 |
| C11 | Safe browser-link harness | §6; criterion 13 |
| C12 | Cold + snapshot cache runs | §7.1 list 1–2; criterion 12 |
| C13 | Two-hour / 1,000-cycle soak | §5.2 ¶4; criterion 15 |

Criteria 8 (exact-master artifact per slice) and 16 (machine-evaluated §9 table) are cross-cutting and enforced by the per-task gate commands, not by a single task. Criterion 13's redaction/forced-429 requirement is exercised in C8 and re-used by C11/C13.

Each task ends with the exact-master artifact gate (Plan B build/audit/scan/smoke/candidate-tested digest) as its final checkbox group, so every code slice is independently executable and independently promotable.

---

## Task C1 — Application factory and lifecycle coordinator

**Goal:** Split `src/app.ts` so the HTTP app can be constructed without binding a listener, and a new lifecycle coordinator owns listener start/stop. No behavior change in the happy path (spec §5.2 ¶1).

**Files:**
- new `src/app_factory.ts` — exports `createApp(config, opts?) : { app, lifecycle, components }`.
- new `src/lifecycle.ts` — exports `class LifecycleCoordinator`.
- edit `src/app.ts` — replace inline construction with `createApp(...)` and call `lifecycle.start()`.
- new `tests/app_factory.test.ts`.
- new `tests/lifecycle.test.ts`.

**Interfaces/signatures (exact):**

```ts
// src/lifecycle.ts
export interface LifecycleHooks {
  onShutdownBegin?(): void;            // after become-unready, before drain
  onShutdownDrained?(): void;          // after registries drained/bounded
  onShutdownEnd?(clean: boolean): void;
}

export class LifecycleCoordinator {
  constructor(opts: {
    drainIntervalMs: number;            // compose grace must exceed this
    hooks?: LifecycleHooks;
  });
  readonly appReady: boolean;           // flipped false at shutdown begin
  start(): void;                        // idempotent
  shutdown(): Promise<{ clean: boolean; reason?: string }>; // idempotent (returns prior result)
}
```

```ts
// src/app_factory.ts
import { Express } from "express";
export interface AppComponents {
  app: Express;
  lifecycle: LifecycleCoordinator;
}
export function createApp(
  userConfig: ReturnType<typeof import("./config").default>,
  overrides?: Partial<import("./server").ServerOpts>
): AppComponents;
```

**Why:** `src/app.ts:169` binds the listener in the same module that constructs the app, so tests cannot construct the app without a port and there is no object to attach shutdown hooks to. `createApp` returns the un-listened app + a coordinator; `app.ts` calls `createApp` then binds the listener through the coordinator.

### Steps

- [ ] **C1.1** Write `tests/lifecycle.test.ts` with a failing test: constructing `LifecycleCoordinator({ drainIntervalMs: 50 })`, calling `shutdown()` resolves `{ clean: true }`, and `start()` is idempotent (second `start()` is a no-op). Run: `npx jest tests/lifecycle.test.ts` → expect **fail** (module `./lifecycle` not found).
- [ ] **C1.2** Implement `src/lifecycle.ts` minimal: `start()` no-op idempotent flag, `shutdown()` resolves `{ clean: true }` once and caches the result. Run: `npx jest tests/lifecycle.test.ts` → expect **pass**.
- [ ] **C1.3** Write `tests/app_factory.test.ts` failing test: `createApp(validConfig)` returns an `app` that is an Express instance and has no listener bound (assert `app.listen` is not called by spying on it, and `/about` via `supertest` returns 200 without `app.listen`). Run → expect **fail** (module not found).
- [ ] **C1.4** Implement `src/app_factory.ts`: move the construction logic currently inline in `src/app.ts:20`–`src/app.ts:165` into `createApp`, threading the existing `server(...)` call (`src/server.ts:166`) and the existing `ServerOpts` (`src/server.ts:103`). Do NOT bind a listener. Run `npx jest tests/app_factory.test.ts` → expect **pass**.
- [ ] **C1.5** Edit `src/app.ts` to call `createApp(config)` and then bind the listener (`app.listen(config.port, ...)`) exactly as today at `src/app.ts:169`. Assert the existing `tests/smapi.test.ts`, `tests/server.test.ts` still pass: `npx jest tests/smapi.test.ts tests/server.test.ts` → expect **pass**.
- [ ] **C1.6** Full gate (exact-master artifact): `npm run build && npm test && npm audit --omit=dev && docker build . && docker run --rm <image> /about smoke`. Record the new digest. Commit `feat(c1): app factory and lifecycle coordinator`.

---

## Task C2 — Shared cancellation and active registries

**Goal:** A shared cancellation signal plus explicit registries for active requests, streams, sockets, and background tasks, all observing cancellation (spec §5.2 ¶1; acceptance criterion 10).

**Files:**
- new `src/cancellation.ts` — `class CancellationToken` + `cancellationSource()`.
- new `src/registries.ts` — `RequestRegistry`, `StreamRegistry`, `SocketRegistry`, `BackgroundTaskRegistry`.
- edit `src/lifecycle.ts` — own a `cancellationSource` and the four registries.
- new `tests/cancellation.test.ts`.
- new `tests/registries.test.ts`.

**Interfaces/signatures (exact):**

```ts
// src/cancellation.ts
export type CancelReason = "shutdown" | "signal";
export class CancellationToken {
  readonly cancelled: boolean;
  readonly reason?: CancelReason;
  onCancel(cb: (reason: CancelReason) => void): () => void; // returns unsubscribe
  throwIfCancelled(): void; // throws CancellationError
}
export function cancellationSource(): {
  token: CancellationToken;
  cancel(reason: CancelReason): void;
};
```

```ts
// src/registries.ts
export interface RegisteredStream { destroy(): void; id: string; }
export interface RegisteredSocket { destroy(): void; id: string; }
export class RequestRegistry {
  register(): { id: string; done(): void };
  activeCount(): number;
  drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>;
}
export class StreamRegistry {
  register(destroyable: { destroy(): void }): RegisteredStream;
  activeCount(): number;
  drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>; // destroys leftovers
}
export class SocketRegistry { /* same shape as StreamRegistry */ }
export class BackgroundTaskRegistry {
  register(task: { cancel(): void; id: string }): void;
  activeCount(): number;
  drain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }>;
}
```

**Why:** There is currently no place that tracks the in-flight SOAP request at `src/smapi.ts` (handlers `getMetadata`/`search` etc.), the stream opened at `src/server.ts:478`–`src/server.ts:487`, or background work like `sonosSystem.register(...)` at `src/app.ts:174` and cache refreshes. Shutdown cannot drain what it cannot see.

### Steps

- [ ] **C2.1** Write `tests/cancellation.test.ts` failing test: `cancellationSource()` produces a token where `cancelled` is false; after `cancel("shutdown")`, all `onCancel` callbacks fire exactly once, and `throwIfCancelled()` throws `CancellationError` with `reason === "shutdown"`. Run → expect **fail**.
- [ ] **C2.2** Implement `src/cancellation.ts`. Run → expect **pass**.
- [ ] **C2.3** Write `tests/registries.test.ts` failing tests: `RequestRegistry` — registering returns `{done}`, `activeCount()` is 1 then 0 after `done()`; `drain(50)` on an already-empty registry resolves `{drained:true, remaining:0}`; a never-done request makes `drain(50)` resolve `{drained:false, remaining:1}`. `StreamRegistry` — `register({destroy})` then `drain(50)` calls `destroy()` and resolves `{drained:true, remaining:0}`. Run → expect **fail**.
- [ ] **C2.4** Implement `src/registries.ts`. Run → expect **pass**.
- [ ] **C2.5** Edit `src/lifecycle.ts` to construct a `cancellationSource` and the four registries; expose `lifecycle.cancellation: CancellationToken`, `lifecycle.requests/streams/sockets/background` registries; in `shutdown()` call `cancel("shutdown")` then `Promise.all` of the four `drain(drainIntervalMs)`. Update `tests/lifecycle.test.ts` to assert cancellation is broadcast and drains return within the interval. Run: `npx jest tests/lifecycle.test.ts tests/cancellation.test.ts tests/registries.test.ts` → expect **pass**.
- [ ] **C2.6** Full exact-master artifact gate (build/audit/scan/smoke/candidate-tested digest). Record digest. Commit `feat(c2): shared cancellation and active registries`.

---

## Task C3 — Cache refresh and writer quiescence

**Goal:** `SwrCache` and `SwrCacheStore` observe the cancellation signal and can be quiesced/closed on shutdown without corrupting the last valid persisted index (spec §5.2 ¶1; criterion 10, 14).

**Files:**
- edit `src/swr_cache.ts` — add `link(cancellation: CancellationToken): void`, `quiesce(): void`, `close(): void`.
- edit `src/swr_cache_file_store.ts` — add optional `close()`/sync barrier.
- edit `src/lifecycle.ts` — register each cache for quiesce/close.
- new `tests/swr_cache_quiesce.test.ts`.

**Interfaces/signatures (exact):**

```ts
// additions to src/swr_cache.ts SwrCache
link(cancellation: CancellationToken): void;   // abort new refreshes when token cancels
quiesce(): void;                               // stop starting refreshes; let in-flight settle
close(): void;                                 // idempotent; no new get/warm; in-flight may reject
```

```ts
// additions to src/swr_cache_file_store.ts SwrCacheStore
export interface SwrCacheStore {
  load(): Array<{ key: string; at: number; value: unknown }>;
  save(key: string, at: number, value: unknown): void;
  close?(): void;                              // optional flush barrier; never throws
}
```

**Why:** `SwrCache.get` at `src/swr_cache.ts:133` starts background refreshes via `this.refresh` at `src/swr_cache.ts:195` that call `this.persist` at `src/swr_cache.ts:94`, which writes through `fileStore.save` at `src/swr_cache_file_store.ts:75` (temp + rename). A refresh aborted mid-write by `process.exit(0)` at `src/app.ts:194` can leave a torn file; `load()` at `src/swr_cache_file_store.ts:54` skips corrupt JSON but a half-renamed file can still be observed.

### Steps

- [ ] **C3.1** Write `tests/swr_cache_quiesce.test.ts` failing tests using `FixedClock` and `deferredFetcher` (pattern from `tests/swr_cache.test.ts:5`): (a) after `quiesce()`, a stale `get` serves the stale value and does NOT start a refresh (fetch call count stays at the prior value); (b) `link(token)` then `cancel("shutdown")` makes a subsequent stale `get` serve stale without starting a refresh; (c) `close()` is idempotent and after it a `get` rejects (no new fetch started). Run → expect **fail**.
- [ ] **C3.2** Implement `quiesce`/`link`/`close` in `src/swr_cache.ts`: add a `quiesced`/`closed` flag checked at the top of `get`/`warm`/`refresh`; when linked token cancels, set the quiesced flag via `token.onCancel`. Run `npx jest tests/swr_cache_quiesce.test.ts` → expect **pass**.
- [ ] **C3.3** Write a failing test in `tests/swr_cache_file_store.test.ts`: a store with a `close()` that tracks a flushed flag; `SwrCache.close()` calls `store.close?.()`. Run → expect **fail**.
- [ ] **C3.4** Add optional `close()` to the `SwrCacheStore` interface and a best-effort flush in `fileStore`. Wire `SwrCache.close()` to invoke `store.close?.()`. Run → expect **pass**.
- [ ] **C3.5** Edit `src/lifecycle.ts` `shutdown()` to call `quiesce()` on all linked caches at shutdown-begin, await the drain interval, then `close()` them at shutdown-end. Update `tests/lifecycle.test.ts`. Run: `npx jest tests/swr_cache_quiesce.test.ts tests/swr_cache_file_store.test.ts tests/lifecycle.test.ts` → expect **pass**.
- [ ] **C3.6** Full exact-master artifact gate. Record digest. Commit `feat(c3): cache quiescence and writer close`.

---

## Task C4 — Versioned cache envelope

**Goal:** Persisted cache records use a versioned envelope so load validates shape/version/size/hash before use (spec §7.1 ¶3; criterion 12). Candidate uses only per-run copies of a candidate-owned fixture whose source hashes remain unchanged.

**Files:**
- new `src/cache_envelope.ts` — `ENVELOPE_VERSION`, `wrapEnvelope`, `parseEnvelope`.
- edit `src/swr_cache_file_store.ts` — write/read through the envelope.
- new `tests/cache_envelope.test.ts`.
- edit `tests/swr_cache_file_store.test.ts` — envelope round-trip + rejection cases.

**Interfaces/signatures (exact):**

```ts
// src/cache_envelope.ts
export const ENVELOPE_VERSION = 1;
export type RecordKind =
  | "artists" | "albumPage" | "albumIndex" | "deezer";

export interface CacheEnvelope<T = unknown> {
  kind: RecordKind;
  schemaVersion: number;
  producer: string;            // producer commit/version (short)
  createdAt: number;           // epoch ms
  payloadLength: number;
  payloadHash: string;         // sha256 hex of the JSON payload
  payload: T;
}
export function wrapEnvelope(kind: RecordKind, payload: unknown, producer: string): CacheEnvelope;
export type EnvelopeParseResult =
  | { ok: true; envelope: CacheEnvelope }
  | { ok: false; reason: string };   // reason codes: BAD_SHAPE | WRONG_VERSION | BAD_SIZE | BAD_HASH | FUTURE_VERSION
export function parseEnvelope(raw: unknown, opts: { maxBytes: number }): EnvelopeParseResult;
```

**Why:** `fileStore.load` at `src/swr_cache_file_store.ts:54` validates only `typeof e.key === "string" && typeof e.at === "number"`. A fixture/corrupt file with arbitrary `value` is accepted; the spec requires record kind, schema version, producer, creation time, payload length, payload hash, and payload, validated in that order (§7.1).

### Steps

- [ ] **C4.1** Write `tests/cache_envelope.test.ts` failing tests: `wrapEnvelope("albumPage", {x:1}, "abc")` sets `payloadHash` to the sha256 of the JSON payload, `payloadLength` to its byte length, `ENVELOPE_VERSION`; `parseEnvelope(envelope, {maxBytes: big})` returns `{ok:true}`; `parseEnvelope({...envelope, payloadHash:"deadbeef"}, ...)` returns `{ok:false, reason:"BAD_HASH"}`; a missing field returns `{ok:false, reason:"BAD_SHAPE"}`; an envelope with a higher version returns `{ok:false, reason:"FUTURE_VERSION"}`. Run → expect **fail**.
- [ ] **C4.2** Implement `src/cache_envelope.ts`. Run → expect **pass**.
- [ ] **C4.3** Add failing tests to `tests/swr_cache_file_store.test.ts`: a `save` then fresh `load` round-trips an envelope (assert `loaded[0].value` is the unwrapped payload and the on-disk file contains `schemaVersion`/`payloadHash`); a file with a wrong `payloadHash` is skipped on `load` (not silently accepted). Run → expect **fail**.
- [ ] **C4.4** Edit `src/swr_cache_file_store.ts` so `save` writes `{ key, at, value: wrapEnvelope(...) }` and `load` runs `parseEnvelope` and skips anything `!ok`. Run → expect **pass**.
- [ ] **C4.5** Regression: `npx jest tests/swr_cache.test.ts tests/swr_cache_file_store.test.ts tests/cache_envelope.test.ts` → expect **pass**.
- [ ] **C4.6** Full exact-master artifact gate. Record digest. Commit `feat(c4): versioned cache envelope`.

---

## Task C5 — Semantic cache validators

**Goal:** After envelope shape/version/size/hash, a record-kind semantic validator checks types, unique stable IDs, bounds, referenced ranges, bucket completeness/disjointness, and configured container limits (spec §7.1 ¶3; criterion 12).

**Files:**
- new `src/cache_validators.ts` — per-kind validators keyed on `RecordKind`.
- edit `src/swr_cache_file_store.ts` — run the validator after a successful `parseEnvelope`.
- new `tests/cache_validators.test.ts`.

**Interfaces/signatures (exact):**

```ts
// src/cache_validators.ts
export type SemanticResult = { ok: true } | { ok: false; reason: string };
// reason codes: DUPLICATE_ID | ID_BOUND | RANGE_BOUND | BUCKET_OVERLAP | BUCKET_GAP | CONTAINER_LIMIT | TYPE
export type SemanticValidator = (payload: unknown, opts: { maxContainerTotal: number }) => SemanticResult;
export const validators: Record<RecordKind, SemanticValidator>;
export function validateRecord(kind: RecordKind, payload: unknown, opts: { maxContainerTotal: number }): SemanticResult;
```

Validators:
- `artists` — array of `{id:string}`; all `id` unique; count ≤ `maxContainerTotal`.
- `albumPage` — array of `{id:string}`; unique ids within the page; count ≤ page bound.
- `albumIndex` — matches `AlbumIndex` shape (`src/album_index.ts:20`): `buckets` contiguous/non-overlapping (`offset`/`count` ranges within `[0, items.length)` and disjoint), `total` consistent; count ≤ `maxContainerTotal`.
- `deezer` — a string URL or undefined; no object payload.

**Why:** The envelope only proves the bytes are intact. The spec requires "a record-kind semantic validator checks types, unique stable IDs, bounds, referenced ranges, bucket completeness/disjointness, and configured container limits". `AlbumIndex` (`src/album_index.ts:13`) has `buckets` that index into `items`, so a persisted snapshot with overlapping/gapping buckets would serve wrong-letter albums.

### Steps

- [ ] **C5.1** Write `tests/cache_validators.test.ts` failing tests per kind: `artists` rejects a duplicate id; `albumPage` accepts a valid page; `albumIndex` rejects overlapping buckets (`[{offset:0,count:5},{offset:3,count:2}]`) and a bucket referencing beyond `items.length`; `albumIndex` rejects `total` exceeding `maxContainerTotal`. Run → expect **fail**.
- [ ] **C5.2** Implement `src/cache_validators.ts` using `AlbumIndexBucket`/`AlbumIndex` from `src/album_index.ts`. Run → expect **pass**.
- [ ] **C5.3** Wire `fileStore.load` to call `validateRecord(kind, payload, { maxContainerTotal: DEFAULT_SONOS_MAX_CONTAINER_TOTAL })` after `parseEnvelope` and skip records returning `!ok`. Add a failing test that a semantically-invalid persisted record is skipped. Run → expect **fail** then after edit **pass**.
- [ ] **C5.4** Regression: `npx jest tests/cache_validators.test.ts tests/swr_cache_file_store.test.ts tests/album_index.test.ts` → expect **pass**.
- [ ] **C5.5** Full exact-master artifact gate. Record digest. Commit `feat(c5): semantic cache validators`.

---

## Task C6 — Graceful shutdown

**Goal:** On `SIGTERM`/`SIGINT`, Bonob becomes unready, broadcasts cancellation, quiesces cache, drains/bounds registries, destroys leftovers, closes the HTTP server, preserves valid cache, and exits nonzero when shutdown is not clean (spec §5.2 list 1–6; criterion 14). The compose stop grace period must exceed Bonob's drain interval.

**Files:**
- edit `src/app.ts` — replace `process.on('SIGTERM', ...)` at `src/app.ts:189` with a call to `lifecycle.shutdown()`.
- edit `src/lifecycle.ts` — orchestrate the six steps.
- new `tests/graceful_shutdown.test.ts`.
- edit `etc/docker-compose.yaml` — add `stop_grace_period` greater than drain interval.

**Interfaces/signatures (exact):**

```ts
// src/lifecycle.ts shutdown steps (asserted by tests)
// 1. set appReady=false; reject new connections
// 2. cancellationSource.cancel("shutdown")  -> registries + caches observe
// 3. await drain(drainIntervalMs) for requests/streams/sockets/background
// 4. after interval: destroy leftover streams/sockets; close http server
// 5. cache.close() preserving last valid persisted index
// 6. return { clean }; caller exits process.exit(clean ? 0 : 1)
export async function runGracefulShutdown(
  lifecycle: LifecycleCoordinator,
  httpServer: import("http").Server
): Promise<{ clean: boolean; reason?: string }>;
```

**Why:** Today `src/app.ts:189`–`src/app.ts:194` closes only the HTTP server and hard-exits 0, which (a) leaves in-flight SOAP handlers and streams at `src/server.ts:478` orphaned, (b) can tear a cache write at `src/swr_cache_file_store.ts:75`, and (c) always exits 0 even when work did not drain. `app.listen` returns the `http.Server` at `src/app.ts:169` (`expressServer`), which must be threaded into `runGracefulShutdown`.

### Steps

- [ ] **C6.1** Write `tests/graceful_shutdown.test.ts` failing tests using `supertest` + a real `http.Server` from `createApp(...).app.listen(0)`:
  - normal request completes before shutdown resolves;
  - a long stream (`res.on('close')` destroys the upstream at `src/server.ts:487`) is drained or destroyed within `drainIntervalMs`;
  - forced expiry (drain interval elapses) destroys leftover streams and still returns a defined result;
  - calling `shutdown()` twice is idempotent (second resolves the same `{clean,reason}`);
  - after shutdown, the cache's last valid persisted index is unchanged (write a fixture, run a refresh, shut down mid nothing, reload and assert equality).
  Run → expect **fail**.
- [ ] **C6.2** Implement `runGracefulShutdown` and wire `LifecycleCoordinator.shutdown()` to call it when an `httpServer` is registered (`lifecycle.attachHttp(server)`). In `src/app.ts`, capture `const httpServer = app.listen(...)` and call `runGracefulShutdown(lifecycle, httpServer).then(({clean}) => process.exit(clean?0:1))` from both `SIGTERM` and `SIGINT` handlers. Run → expect **pass**.
- [ ] **C6.3** Add restart-cache test: build a cache with `fileStore` over a temp dir, write a valid envelope, construct a fresh app via `createApp`, assert the persisted entry loads and is served (no cold rebuild). Run → expect **pass**.
- [ ] **C6.4** Edit `etc/docker-compose.yaml`: set `bonob.stop_grace_period` to a value strictly greater than `BNB_SHUTDOWN_DRAIN_MS` (e.g. `90s` for a `60s` drain). Add a test/doc note that the gate verifies `stop_grace_period > drainIntervalMs`. Run `npx jest tests/graceful_shutdown.test.ts` → expect **pass**.
- [ ] **C6.5** Full exact-master artifact gate; confirm image smoke includes a clean `SIGTERM` stop within grace. Record digest. Commit `feat(c6): graceful shutdown`.

---

## Task C7 — Protected internal diagnostics

**Goal:** Diagnostics report cache schema/load status, file/entry counts, last successful refresh, refresh-in-progress, upstream timing aggregates, active requests, and active streams — exposing no library metadata or credentials, available only through loopback or a protected operator path, never the public Sonos vhost (spec §5.2 ¶3; criterion 10).

**Files:**
- new `src/diagnostics.ts` — `buildDiagnostics(components)`, `redactedDiagnosticsSnapshot`.
- edit `src/server.ts` — register a `/internal/diagnostics` route guarded by loopback/operator check.
- edit `src/app_factory.ts` — wire the registries (C2) and cache status into diagnostics.
- new `tests/diagnostics.test.ts`.

**Interfaces/signatures (exact):**

```ts
// src/diagnostics.ts
export interface DiagnosticsSnapshot {
  cache: {
    schemaVersion: number;            // ENVELOPE_VERSION
    loadStatus: "ok" | "partial" | "empty";
    fileCount: number;
    entryCount: number;
    lastSuccessfulRefresh?: number;   // epoch ms, or absent
    refreshInProgress: boolean;
  };
  upstream: {
    navidrome: TimingAggregate;       // see C8
    deezer?: TimingAggregate;
    lastfm?: TimingAggregate;
    proxy?: TimingAggregate;
  };
  activeRequests: number;
  activeStreams: number;
}
export type TimingAggregate = {
  count: number;
  p95Ms: number;
  p99Ms: number;
  errorCount: number;
};
export function buildDiagnostics(deps: {
  cacheStatus: () => Omit<DiagnosticsSnapshot["cache"], never>;
  upstream: () => DiagnosticsSnapshot["upstream"];
  requests: RequestRegistry;
  streams: StreamRegistry;
}): DiagnosticsSnapshot;
export function isLoopbackOrOperator(req: import("express").Request, opts: { operatorTokenHash?: string }): boolean;
```

**Why:** There is currently no operator view of cache health or active work; the only `/about` route is public and minimal. The spec mandates aggregate-only, loopback/operator-gated diagnostics that never carry library metadata or credentials.

### Steps

- [ ] **C7.1** Write `tests/diagnostics.test.ts` failing tests: `buildDiagnostics` with stubbed deps returns a snapshot whose `cache.entryCount` equals the stub, `activeRequests`/`activeStreams` equal the registry counts, and the JSON contains no field named like `secret`/`token`/`password`/`username` and no media `title`/`artist`/`album` (assert with a regex scan over `JSON.stringify`). `isLoopbackOrOperator` returns true for `127.0.0.1`/`::1` and false for a public IP without a matching operator token. Run → expect **fail**.
- [ ] **C7.2** Implement `src/diagnostics.ts`. Run → expect **pass**.
- [ ] **C7.3** Add failing test: a `supertest` request to `/internal/diagnostics` from a non-loopback remote IP without the operator token returns `404` (route hidden), and from loopback returns `200` with the snapshot and `Cache-Control: no-store`. Run → expect **fail**.
- [ ] **C7.4** Edit `src/server.ts` to add the guarded route using `isLoopbackOrOperator`; edit `src/app_factory.ts` to pass the real registries + cache status into `buildDiagnostics`. Run → expect **pass**.
- [ ] **C7.5** Add a redaction scan test: feed a snapshot with a fake `token` field (should never exist) and assert the public serializer omits it; this guards against future fields leaking. Run → expect **pass**.
- [ ] **C7.6** Full exact-master artifact gate. Record digest. Commit `feat(c7): protected diagnostics`.

---

## Task C8 — Outbound attribution and privacy-safe redaction

**Goal:** Outbound request logging gains a generated correlation ID and a fixed integration label (`navidrome`, `deezer`, `lastfm`, `proxy`); completion logs contain only integration, status, latency, retry attempt, outcome class, and correlation ID; URLs/query/authorization/cookies/headers/usernames/tokens/metadata/bodies are prohibited; redaction tests cover success and failure paths including 429, timeout, DNS, TLS, malformed-response (spec §5.2 ¶2; criterion 13).

**Files:**
- new `src/outbound_log.ts` — `withOutboundLogging(axiosInstance, integration)`, `redactedCompletion`, `newCorrelationId`.
- edit `src/subsonic.ts` — wrap `axios` usages at `src/subsonic.ts:1077`/`src/subsonic.ts:1103` and image fetchers at `src/subsonic.ts:856`/`src/subsonic.ts:927`/`src/subsonic.ts:936`.
- new `tests/outbound_log.test.ts`.

**Interfaces/signatures (exact):**

```ts
// src/outbound_log.ts
export type IntegrationLabel = "navidrome" | "deezer" | "lastfm" | "proxy";
export type OutcomeClass =
  | "success" | "client_4xx" | "server_5xx" | "timeout" | "dns"
  | "tls" | "malformed" | "cancelled" | "network";
export interface OutboundCompletion {
  integration: IntegrationLabel;
  correlationId: string;
  status?: number;
  latencyMs: number;
  retryAttempt: number;
  outcome: OutcomeClass;
}
export function newCorrelationId(): string;             // opaque, no host/path
export function classifyOutcome(error: unknown, status?: number): OutcomeClass;
export function redactedCompletion(c: OutboundCompletion): Record<string, unknown>; // ONLY the six fields
export function withOutboundLogging(instance: import("axios").AxiosInstance, integration: IntegrationLabel, opts: { sink: (c: OutboundCompletion) => void; cancellation?: CancellationToken }): import("axios").AxiosInstance;
```

**Why:** `Subsonic.get`/`post` at `src/subsonic.ts:1077`/`src/subsonic.ts:1103` call `axios` directly with `username`/`password`/salt in query params; the existing `logger.debug` at `src/server.ts:496`/`src/server.ts:522` logs `headers` (which can carry auth). A 429 from Navidrome currently has no integration label or correlation ID and its URL (with token) could leak.

### Steps

- [ ] **C8.1** Write `tests/outbound_log.test.ts` failing tests:
  - `redactedCompletion({...})` returns an object with EXACTLY keys `integration, correlationId, status, latencyMs, retryAttempt, outcome` (use `Object.keys` deep-equal) and nothing else;
  - `classifyOutcome` maps a 200 → `success`, 429 → `client_4xx`, 503 → `server_5xx`, an `axios` timeout error (`code: 'ECONNABORTED'`) → `timeout`, `ENOTFOUND` → `dns`, `CERT_HAS_EXPIRED` → `tls`, a JSON parse error → `malformed`;
  - `withOutboundLogging` on a mocked axios emits a completion to `sink` for a success and a forced 429, and the emitted object's string form does NOT contain the request URL, the `u`/`t`/`s` params, any `Authorization`/`Cookie` header, or the response body.
  Run → expect **fail**.
- [ ] **C8.2** Implement `src/outbound_log.ts` using axios request/response interceptors; compute `latencyMs` from request/start timestamp; derive `outcome` from `classifyOutcome`. Run → expect **pass**.
- [ ] **C8.3** Add failing tests for failure paths: simulate a timeout, a DNS failure, a TLS error, and a malformed JSON response through `withOutboundLogging` and assert each emits the right `outcome` and contains no URL/credential/body. Run → expect **fail** then after wiring **pass**.
- [ ] **C8.4** Edit `src/subsonic.ts` to route `get`/`post`/image fetchers through a module-level axios instance wrapped by `withOutboundLogging(..., "navidrome"|"deezer"|"proxy", ...)`; pass the lifecycle cancellation token so in-flight requests observe shutdown. Add a forced-429 test against the `Subsonic` class (mock axios) asserting the sink receives `outcome:"client_4xx", status:429`. Run → expect **pass**.
- [ ] **C8.5** Assert the public request log (`redactAccessTokenFromUrl` at `src/server.ts:127`) continues to mask `bat` and that no new outbound log emits a raw URL. Run: `npx jest tests/outbound_log.test.ts tests/server.test.ts` → expect **pass**.
- [ ] **C8.6** Full exact-master artifact gate; confirm scan/redaction evidence. Record digest. Commit `feat(c8): outbound attribution and redaction`.

---

## Task C9 — Fully disposable candidate topology

**Goal:** Each candidate stack contains candidate Bonob + disposable candidate Navidrome (or immutable equivalent) with unique candidate credentials, candidate-owned metadata/data/media, and a per-run cache directory; it joins no production network and mounts no production state (spec §6, §7.1; criteria 9, 11). Root-only credential no-follow/open/`fstat` checks pass with accurate token-revocation wording.

**Files:**
- new `candidate/docker-compose.candidate.yaml` — candidate stack with unique aliases on an internal network.
- new `candidate/env.candidate.example` — unique candidate creds (no production values).
- new `candidate/init-smoke-account.sh` — creates the dedicated non-admin smoke account in candidate Navidrome.
- new `candidate/README.md` — topology, sentinel, and credential-handling rules.
- new `tests/candidate_topology.test.ts` — static/structural assertions over the compose file.

**Interfaces/signatures (exact):**

```yaml
# candidate/docker-compose.candidate.yaml (key invariants asserted by tests)
services:
  navidrome-candidate:
    image: deluan/navidrome:<pinned-digest>          # NOT :latest, NOT production
    networks: [candidate_net]                         # internal only
    volumes:
      - candidate-navidrome-data:/data                # named disposable volume
      - ./media-fixture:/music:ro                     # candidate-owned read-only fixture
  bonob-candidate:
    image: ghcr.io/richertunes/bonob@sha256:<candidate-digest>   # Plan B digest
    environment:
      BNB_URL: <canonical-origin>                     # candidate canonical origin value
      BNB_SUBSONIC_URL: http://navidrome-candidate:4533
      BNB_SUBSONIC_CACHE_DIR: /cache                  # per-run disposable
      BNB_SECRET: <unique-candidate-secret>           # unique, not production
    networks: [candidate_net]
networks:
  candidate_net:
    internal: true                                    # no default external route
volumes:
  candidate-navidrome-data:
```

**Why:** The existing `etc/docker-compose.yaml` uses `simojenki/bonob:latest`, `:latest` Navidrome, host bind-mounts (`/tmp/navidrome/...`), and `BNB_SECRET: changeme` — none of which is disposable, isolated, or uniquely credentialed. The spec forbids candidate/production cache sharing and production alias/name/IP reuse (§11 non-goals).

### Steps

- [ ] **C9.1** Write `tests/candidate_topology.test.ts` failing tests that parse `candidate/docker-compose.candidate.yaml` and assert: all `bonob`/`navidrome` images are digest-pinned (no `:latest`); networks are `internal: true` and none is a production network name; volumes are named/disposable (no host path under `/tmp/navidrome` or production path); `BNB_SECRET` placeholder is unique (not `changeme`); `BNB_SUBSONIC_CACHE_DIR` is a disposable path. Run → expect **fail** (file absent).
- [ ] **C9.2** Create `candidate/docker-compose.candidate.yaml`, `candidate/env.candidate.example`, `candidate/media-fixture/` (candidate-owned synthetic metadata), and `candidate/init-smoke-account.sh` that creates a non-admin `bonob-smoke-*` account. Run → expect **pass**.
- [ ] **C9.3** Add the credential-handling assertions to `candidate/README.md`: root-owned/root-readable credential file; open with `O_NOFOLLOW`; `fstat` the descriptor and require regular file owned by root with mode `0600`; record that account disable/password rotation is distinct from Bonob token expiry and process-local `bat`/link-code invalidation (spec §6, §8). Run → expect **pass**.
- [ ] **C9.4** Add a failing test asserting the candidate sentinel value is unique per run (a generated opaque value) and appears in candidate env. Run → expect **fail** then after wiring **pass**.
- [ ] **C9.5** Full exact-master artifact gate; confirm candidate never references a production alias/secret/credential. Record digest. Commit `feat(c9): disposable candidate topology`.

---

## Task C10 — Default-deny egress and negative production reachability

**Goal:** Candidate, resolver, and egress-proxy policies default-deny all production aliases/names/IPs/CIDRs/routes and unapproved destinations; only exact candidate dependencies and immutable test services are allowlisted; negative direct/proxied tests cover production hostname, backend alias, IPv4/IPv6, CIDR route, alternate port, external DNS, proxy bypass, and DNS-rebind; sentinels appear only at candidate (spec §7.1 ¶3; criterion 11).

**Files:**
- new `candidate/egress-default-deny.conf` — proxy/network policy.
- new `candidate/negatives.test.ts` — the negative reachability matrix.
- new `candidate/origin_validator.ts` — exact-origin validator incl. `getAppLink.regUrl`.

**Interfaces/signatures (exact):**

```ts
// candidate/origin_validator.ts
export interface OriginPolicy {
  canonicalOrigin: URL;   // scheme/host/port exact
}
export type OriginVerdict =
  | { ok: true; rewritten: URL }             // transport base, path+query preserved
  | { ok: false; reason: "BAD_SCHEME" | "BAD_HOST" | "BAD_PORT" | "USERINFO" | "FRAGMENT" };
export function validateAndRewrite(candidateUrl: string, policy: OriginPolicy, transportBase: URL): OriginVerdict;
export function validateBonobGeneratedUrl(url: string, policy: OriginPolicy, transportBase: URL): OriginVerdict; // covers getAppLink.regUrl, login, report, SOAP, art, stream
```

**Why:** The harness rewrites every Bonob-generated URL (including `regUrl` built at `src/smapi.ts:233`) to the transport base, so a single validator must reject userinfo/fragments and require an exact scheme/host/port match to the canonical origin, then preserve path+query. The egress default-deny prevents candidate Bonob from reaching production Navidrome, and DNS-rebind answers must be rejected (mirroring `pinnedSafeExternalLookup` at `src/subsonic.ts:886` for art).

### Steps

- [ ] **C10.1** Write `candidate/negatives.test.ts` failing tests:
  - `validateAndRewrite` accepts the canonical origin and rejects a different host (`BAD_HOST`), wrong scheme (`BAD_SCHEME`), wrong port (`BAD_PORT`), userinfo (`USERINFO`), and an unexpected fragment (`FRAGMENT`); a valid URL rewrites only the origin and preserves path+query.
  - `validateBonobGeneratedUrl` applied to a sample `getAppLink.regUrl` (built like `src/smapi.ts:233`) passes for the canonical origin and fails for a tampered host.
  - Egress negatives: candidate Bonob cannot resolve/reach a production hostname, a production backend alias, an IPv4/IPv6 in a production CIDR, an alternate port, an external DNS name, a proxy-bypass address, or a DNS-rebind answer (simulate with a controlled resolver stub). Each returns a denial and the test records hashed evidence.
  Run → expect **fail**.
- [ ] **C10.2** Implement `candidate/origin_validator.ts` and `candidate/egress-default-deny.conf`. Run → expect **pass**.
- [ ] **C10.3** Add a sentinel-leak test: send a request carrying the unique candidate sentinel through the candidate proxy; assert the sentinel appears in candidate logs and would NOT appear in a (stubbed) production proxy/counter for the same interval. Run → expect **pass**.
- [ ] **C10.4** Confirm the edge proxy still resolves its Bonob upstream only to production (read-only assertion over the production-side resolver config, no production mutation). Run → expect **pass**.
- [ ] **C10.5** Full exact-master artifact gate; record hashed egress/network/DNS evidence. Record digest. Commit `feat(c10): default-deny egress and negative reachability`.

---

## Task C11 — Safe browser-link harness

**Goal:** `scripts/bonob-e2e-sweep.ts` authenticates through Bonob's real browser-link flow (`getAppLink` → `/login` with the smoke account → `getDeviceAuthToken`), retains tokens in process memory only, traverses read-only SMAPI sections serially with bounded request/run timeouts, persists no token, emits aggregate-only output, and attributes/redacts a forced 429 (spec §6; criterion 13). Mutation mode requires an explicit flag and operates only on a new `bonob-smoke-` playlist in disposable candidate state.

**Files:**
- new `scripts/bonob-e2e-sweep.ts`.
- new `scripts/lib/credential_reader.ts` — root-owned, no-follow, `fstat`-checked credential read.
- new `scripts/lib/url_origin.ts` — re-exports `validateBonobGeneratedUrl` (from C10).
- new `tests/harness.test.ts` — unit tests for the pure helpers (no live calls).

**Interfaces/signatures (exact):**

```ts
// scripts/bonob-e2e-sweep.ts
export interface SweepResult {
  sections: Array<{ section: string; count: number; statusClass: string; ms: number }>;
  forced429?: { attributed: boolean; redacted: boolean };
  pass: boolean;
}
export async function runSweep(opts: {
  canonicalOrigin: URL;
  transportBase: URL;
  readCredential: () => Promise<{ username: string; password: string }>; // root-only, no-follow
  mutate?: boolean;
  requestTimeoutMs: number;
  runTimeoutMs: number;
  sentinel: string;
}): Promise<SweepResult>;
// The harness MUST: never print username/password/linkCode/token/URL/body/metadata;
// rewrite every URL through validateBonobGeneratedUrl; carry the sentinel on every request;
// abort cleanly on auth failure, malformed XML, unexpected origin, rate limit, transport failure, deadline.
```

**Why:** There is currently no `scripts/` harness; the only auth path is the live `src/app.ts`. The spec replaces any persisted-token-file contract with a process-memory-only, aggregate-only sweep. The smoke identity must be a dedicated non-admin account created only in candidate Navidrome (C9).

### Steps

- [ ] **C11.1** Write `tests/harness.test.ts` failing tests for pure helpers: `readCredential` rejects a symlinked credential file (no-follow + `fstat`), a non-root-owned file, and a mode more permissive than `0600`; `SweepResult` serialization contains no token/username/password/url/body (regex scan). Run → expect **fail**.
- [ ] **C11.2** Implement `scripts/lib/credential_reader.ts` using `fs.openSync(path, 'r')` with `O_NOFOLLOW`, `fs.fstatSync`, owner/mode checks. Run → expect **pass**.
- [ ] **C11.3** Implement `scripts/bonob-e2e-sweep.ts`: call `getAppLink` (SOAP at `src/smapi.ts:226`), validate/rewrite `regUrl` via `validateBonobGeneratedUrl`, POST the link code to `/login`, call `getDeviceAuthToken`, keep the SMAPI token in a closure variable (never logged/persisted), traverse read-only sections serially. Run `npx ts-node scripts/bonob-e2e-sweep.ts --help` → expect a usage banner (no network). Run `npx jest tests/harness.test.ts` → expect **pass**.
- [ ] **C11.4** Add a forced-429 attribution test (mock the SOAP client to return 429 once): assert `SweepResult.forced429.attributed === true` and the emitted log line matches the `redactedCompletion` shape from C8 (six fields only). Run → expect **fail** then after wiring **pass**.
- [ ] **C11.5** Add mutation-mode guard test: without `--mutate`, no playlist mutation occurs; with `--mutate`, only a new `bonob-smoke-` playlist is created/verified/deleted in disposable candidate state, even on failure. Run → expect **pass**.
- [ ] **C11.6** Full exact-master artifact gate; confirm harness emits aggregate-only output and persists no token. Record digest. Commit `feat(c11): safe browser-link harness`.

---

## Task C12 — Cold-cache and snapshot-cache runs

**Goal:** Two candidate runs are required: (1) cold cache — an empty release-specific directory verifies first-use behavior, bounded failures, and index creation; (2) snapshot cache — a versioned candidate-owned fixture verifies schema compatibility, restart loading, and background refresh (spec §7.1 list; criterion 12). Candidate writes go only to a per-run disposable copy; source fixture hashes remain identical.

**Files:**
- new `candidate/fixtures/cache-snapshot/` — candidate-owned versioned fixture (envelopes from C4/C5).
- new `candidate/run_cold_cache.sh` and `candidate/run_snapshot_cache.sh`.
- new `tests/cache_runs.test.ts` — asserts fixture ownership/mode/count/bytes/hashes before and after.

**Interfaces/signatures (exact):**

```bash
# candidate/run_cold_cache.sh
# 1. create empty per-run dir
# 2. start candidate bonob with BNB_SUBSONIC_CACHE_DIR=<per-run>
# 3. assert first browse creates an index, failures are bounded
# 4. record file count/bytes/hashes; teardown
# exit 0 only on success

# candidate/run_snapshot_cache.sh
# 1. copy candidate/fixtures/cache-snapshot to per-run dir (source unchanged)
# 2. record source fixture hashes BEFORE
# 3. start candidate bonob; assert schema load + restart reload + refresh-in-progress false
# 4. record per-run hashes AFTER; assert source fixture hashes identical BEFORE==AFTER
```

**Why:** `SwrCache` seeds from the store on construction (`src/swr_cache.ts:69`) only when `ttlMs > 0`; a cold dir exercises the `coldFetch` path (`src/swr_cache.ts:168`), and a snapshot exercises `seed` (`src/swr_cache.ts:75`) plus the envelope/semantic validators from C4/C5. The spec requires that candidate validation never reads, copies, or mounts the production cache.

### Steps

- [ ] **C12.1** Write `tests/cache_runs.test.ts` failing tests: after a snapshot run, the source fixture directory's per-file sha256 and tree hash equal the before-values; the per-run copy differs (written to); file count/bytes are recorded; ownership/mode of the fixture is root or the candidate uid with no group/other write. Run → expect **fail**.
- [ ] **C12.2** Create `candidate/fixtures/cache-snapshot/` with valid envelopes (produced by `wrapEnvelope`) for `artists`/`albumPage`/`albumIndex`, plus one deliberately invalid envelope to prove it is skipped (retained for diagnosis, triggers cold rebuild, never silently accepted). Run → expect **pass** for the structural assertions.
- [ ] **C12.3** Implement `run_cold_cache.sh` and `run_snapshot_cache.sh`; assert cold run creates an index and snapshot run loads schema and restart-reloads. Run both against the candidate topology (C9) → expect exit 0.
- [ ] **C12.4** Add a test that the deliberately-invalid envelope is retained for diagnosis and triggers an explicit cold rebuild (not silently overwritten) — mirrors spec §7.1 "An invalid record is retained for diagnosis and triggers an explicit safe cold rebuild". Run → expect **pass**.
- [ ] **C12.5** Full exact-master artifact gate; record cold/snapshot evidence. Record digest. Commit `feat(c12): cold and snapshot cache runs`.

---

## Task C13 — Objective two-hour / 1,000-cycle soak

**Goal:** A minimum two-hour automated soak with at least 1,000 mixed open/play/range/seek/stop/disconnect stream lifecycle cycles; RSS/active handles/sockets sampled every 10s; 30-min warmup (warm baseline = median of final 5 min); final load = median of final 5 min of the 2h/1,000-cycle load; 5-min cooldown (post-cooldown median over final 2 min); thresholds: final-load RSS growth ≤ 64 MiB over warm baseline; post-cooldown handles/sockets within 10% of warm baseline (≤2 absolute when baseline is 0); 99.5% success; zero incorrect status/content-type/content-length/range/body-hash; browse/search p95 ≤ 2s p99 ≤ 4.25s; stream HEAD/range/TTFB p95 ≤ 2s p99 ≤ 4s; zero unhandled rejection/crash/corruption (spec §5.2 ¶4; criterion 15). All auth/429/5xx outcomes are evaluated only by the §9 table (criterion 16).

**Files:**
- new `scripts/bonob-soak.ts` — the soak driver.
- new `scripts/lib/metrics.ts` — RSS/handle/socket sampler + percentile.
- new `scripts/lib/decision_table.ts` — machine-evaluated §9 table (criterion 16).
- new `tests/soak_helpers.test.ts` — pure unit tests for samplers/percentiles/decision table.

**Interfaces/signatures (exact):**

```ts
// scripts/lib/metrics.ts
export interface Sample { atMs: number; rssBytes: number; activeHandles: number; sockets: number; }
export function sample(): Sample;                                   // every 10s
export function median(values: number[]): number;
export function percentile(sortedAsc: number[], p: number): number; // p95/p99
export interface SoakThresholds {
  rssGrowthMaxBytes: number;       // 64 * 1024 * 1024
  handleSocketTolerancePct: number;// 10
  handleSocketAbsoluteWhenZero: number; // 2
  successRateMin: number;          // 0.995
  browseP95Ms: number; browseP99Ms: number;   // 2000 / 4250
  streamP95Ms: number; streamP99Ms: number;   // 2000 / 4000
}
export function evaluateSoak(samples: Sample[], results: CycleResult[], thresholds: SoakThresholds): SoakVerdict;

// scripts/lib/decision_table.ts
export type DecisionRow = {
  signal: "expected_negative" | "functional_failure" | "isolated_background" | "unexpected_burst" | "secret_crash" | "lower_severity";
  decision: "count_separately" | "release_blocker" | "attribute_investigate" | "nonwaivable_blocker" | "record_disposition";
};
export function evaluateDecision(events: AuthEvent[], windowMs: number): DecisionVerdict; // implements §9 incl. 5-in-60s burst
```

**Why:** There is no soak today; the thresholds are objective and must be machine-checked so a run is not judged subjectively. The §9 table is the sole auth/429/5xx policy (criterion 16) and must be evaluated the same way for candidate, soak, and production evidence.

### Steps

- [ ] **C13.1** Write `tests/soak_helpers.test.ts` failing tests: `median([1,2,3])===2`; `percentile([...],95)` on a known array equals the expected value; `evaluateSoak` returns fail when RSS growth exceeds 64MiB, when post-cooldown handles exceed 10% of a nonzero warm baseline, and when success rate < 99.5%; `evaluateDecision` flags a 5-in-60s burst as `release_blocker` and a 1–4 window as `attribute_investigate`. Run → expect **fail**.
- [ ] **C13.2** Implement `scripts/lib/metrics.ts` and `scripts/lib/decision_table.ts`. Run → expect **pass**.
- [ ] **C13.3** Implement `scripts/bonob-soak.ts`: 30-min warmup → 2h/1,000-cycle load (open/play/range/seek/stop/disconnect) → 5-min cooldown; sample every 10s; classify every cycle result; emit aggregate-only output with warm/final/post-cooldown medians and the verdict. Run `npx ts-node scripts/bonob-soak.ts --dry-run` → expect a plan/verdict structure (no full 2h run in unit tests). Run `npx jest tests/soak_helpers.test.ts` → expect **pass**.
- [ ] **C13.4** Add cycle-correctness unit tests: a cycle returning wrong status/content-type/content-length/range/body-hash is counted as a failure and never consumes the success budget; expected negative/cancellation cases are counted separately with their exact expected status/body (spec §5.2 ¶4, §9 row 1). Run → expect **pass**.
- [ ] **C13.5** Run the full soak against the candidate topology (C9) as a manual/evidence step (not in the unit suite); record the verdict JSON and the §9 decision evaluation. Confirm zero unhandled rejection/crash/corruption. Run → expect PASS against thresholds.
- [ ] **C13.6** Full exact-master artifact gate; record the soak evidence digest. Commit `feat(c13): objective two-hour soak`.

---

## 4. Cross-cutting gates (every task)

Each task's final checkbox runs the Plan B exact-master artifact gate, in this order, against the exact current `master` after the task's commit:

1. `npm run build` (tsc, `tsconfig.json`)
2. `npm test` (jest, `jest.config.js`)
3. `npm audit --omit=dev` (zero unapproved high/critical; spec §5.1)
4. `docker build .` (the `Dockerfile`; deterministic context from Plan B)
5. image smoke: `/`, `/about`, healthcheck (`Dockerfile` HEALTHCHECK)
6. candidate tests (C9 topology): cold/snapshot where applicable, safe sweep, shutdown, redaction
7. digest verification: tag matches `^sha-[0-9a-f]{40}$`, OCI revision label equals the commit, anonymous pull fails, authorized candidate pull succeeds (Plan B publisher invariants)

Evidence from an earlier code SHA is never reused to promote a later one (spec §4; criterion 8). Plan C's graceful-shutdown and attribution/redaction gates (C6, C8) are prerequisites for every post-convergence production promotion (spec §1.1 last paragraph; criterion 14).

## 5. Risks and assumptions

- **Assumption:** Plan B's exact-master candidate digest and its publisher environment exist before C1 starts; this plan does not implement the supply boundary.
- **Assumption:** `danger-full-access` transport is used only because of the proven Windows effective-read-only mismatch; mutation is limited to this plan file by prompt authority, and the parent verifies all paths/hashes.
- **Risk:** Express 5 (`express@^5.2.1` per `package.json`) changes some middleware/listener semantics; the factory extraction (C1) and shutdown wiring (C6) must be validated against the real `http.Server` returned by `app.listen`, not a mock.
- **Risk:** `soap` library (`src/smapi.ts:4`) owns the SOAP request lifecycle; registering active requests (C2) must not alter the SOAP response shape — C2/C6 tests assert golden SMAPI responses are unchanged.
- **Risk:** The soak (C13) is long-running (≥2h); the unit suite covers the samplers/decision table, and the full run is an evidence step recorded against the candidate digest, not a jest test.
- **Risk:** Changing `fileStore` to envelopes (C4/C5) changes the on-disk format; a migration path for any pre-existing cache is out of scope for Plan C (candidate uses disposable fixtures; production cache handling is Plan E's restore rehearsal).

## 6. Out of scope (spec §11)

- Protocol behavior changes (Plan D), module extraction (Plan F), production promotion (Plan E).
- Dependency major upgrades bundled with any of the above.
- Live Sonos S2 physical acceptance — separately approved, post-promotion, read-only (Plan E).
- Sharing a writable cache between production and candidate.
