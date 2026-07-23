# Plan C — Runtime testability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Bonob runtime-testable and safely observable in a disposable, isolated candidate topology while preserving protocol behavior and producing a newly tested immutable exact-`master` artifact for every code-changing slice.

**Architecture:** Extract application construction from listener ownership, then make a lifecycle coordinator own readiness, cancellation, active-work registries, cache quiescence, and bounded shutdown. Build the candidate harness and cache/soak evidence only on those tested seams; all candidate inputs are runtime-validated from a secret-free Plan-B release manifest plus root-controlled environment/credential files, never embedded in tracked compose files or commands.

**Tech Stack:** Node.js 22, TypeScript, Express 5, Jest 30, Supertest, Axios, Docker Compose, Docker Buildx OCI archives, SHA-256 manifests, shell scripts with `set -euo pipefail`.

## Global Constraints

Every artifact is built from a known commit and tested first in an isolated disposable topology with no production dependency or state. Live topology evidence is gathered only through separately approved post-promotion public/physical gates. Deployment uses an immutable digest, and isolated success is never described as Sonos S2 end-to-end proof.

No plan may bundle a dependency major upgrade, protocol behavior change, module refactor, and live promotion together.

Every code-changing slice in Plans C and D starts from the exact current `master`, repeats deterministic build, source tests, production audit, exact-manifest scan, image smoke, isolated candidate tests, and digest verification, and produces a new immutable digest. Evidence from an earlier code SHA cannot promote a later one.

CI must fail closed: a failed test, compilation, audit policy, scan, image build, or smoke check prevents publication. The production dependency audit and container-image scan must each report zero high/critical findings unless the pre-publication exception process in §3.3 is approved. Development-only advisories are still reported and either upgraded or explicitly risk-reviewed; their classification is not used to erase them from visibility.

`BNB_SECRET` and other credentials live only in gitignored, owner- or root-readable environment/credential files. Values are never written to source, manifests, command lines, logs, or test reports.

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
  attachHttp(server: import("http").Server): void; // C6 wires the listener
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
- [ ] **C1.3** Write `tests/app_factory.test.ts` failing test: set `process.env.BNB_URL = "https://bonob-test.invalid"`, call `readConfig()`, and assert `createApp(readConfig())` returns an Express app without calling its spied `listen`; assert `/about` returns `200` through `supertest(app)`. Restore `process.env` in `afterEach`. Run `npx jest tests/app_factory.test.ts --runInBand`; expected: FAIL with module `../src/app_factory` not found.
- [ ] **C1.4** Implement `src/app_factory.ts`: move the construction logic currently inline in `src/app.ts:20`–`src/app.ts:165` into `createApp`, threading the existing `server(...)` call (`src/server.ts:166`) and the existing `ServerOpts` (`src/server.ts:103`). Do NOT bind a listener. Run `npx jest tests/app_factory.test.ts` → expect **pass**.
- [ ] **C1.5** Edit `src/app.ts` to call `createApp(config)` and then bind the listener (`app.listen(config.port, ...)`) exactly as today at `src/app.ts:169`. Assert the existing `tests/smapi.test.ts`, `tests/server.test.ts` still pass: `npx jest tests/smapi.test.ts tests/server.test.ts` → expect **pass**.
- [ ] **C1.6** Commit `git add src/app.ts src/app_factory.ts src/lifecycle.ts tests/app_factory.test.ts tests/lifecycle.test.ts && git commit -m "feat(c1): app factory and lifecycle coordinator"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record the digest in its secret-free evidence manifest.

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

// additions to LifecycleCoordinator made in C2
readonly cancellation: CancellationToken;
readonly requests: RequestRegistry;
readonly streams: StreamRegistry;
readonly sockets: SocketRegistry;
readonly background: BackgroundTaskRegistry;
```

**Why:** There is currently no place that tracks the in-flight SOAP request at `src/smapi.ts` (handlers `getMetadata`/`search` etc.), the stream opened at `src/server.ts:478`–`src/server.ts:487`, or background work like `sonosSystem.register(...)` at `src/app.ts:174` and cache refreshes. Shutdown cannot drain what it cannot see.

### Steps

- [ ] **C2.1** Write `tests/cancellation.test.ts` failing test: `cancellationSource()` produces a token where `cancelled` is false; after `cancel("shutdown")`, all `onCancel` callbacks fire exactly once, and `throwIfCancelled()` throws `CancellationError` with `reason === "shutdown"`. Run `npx jest tests/cancellation.test.ts --runInBand`; expected: FAIL with module `../src/cancellation` not found.
- [ ] **C2.2** Implement `src/cancellation.ts`. Run `npx jest tests/cancellation.test.ts --runInBand`; expected: PASS.
- [ ] **C2.3** Write `tests/registries.test.ts` failing tests: `RequestRegistry` — registering returns `{done}`, `activeCount()` is 1 then 0 after `done()`; `drain(50)` on an already-empty registry resolves `{drained:true, remaining:0}`; a never-done request makes `drain(50)` resolve `{drained:false, remaining:1}`. `StreamRegistry` — `register({destroy})` then `drain(50)` calls `destroy()` and resolves `{drained:true, remaining:0}`. Run `npx jest tests/registries.test.ts --runInBand`; expected: FAIL with module `../src/registries` not found.
- [ ] **C2.4** Implement `src/registries.ts`. Run `npx jest tests/registries.test.ts --runInBand`; expected: PASS.
- [ ] **C2.5** Edit `src/lifecycle.ts` to construct a `cancellationSource` and the four registries; expose `lifecycle.cancellation: CancellationToken`, `lifecycle.requests/streams/sockets/background` registries; in `shutdown()` call `cancel("shutdown")` then `Promise.all` of the four `drain(drainIntervalMs)`. Update `tests/lifecycle.test.ts` to assert cancellation is broadcast and drains return within the interval. Run: `npx jest tests/lifecycle.test.ts tests/cancellation.test.ts tests/registries.test.ts` → expect **pass**.
- [ ] **C2.6** Commit `git add src/cancellation.ts src/registries.ts src/lifecycle.ts tests/cancellation.test.ts tests/registries.test.ts tests/lifecycle.test.ts && git commit -m "feat(c2): shared cancellation and active registries"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record its digest.

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

// addition to LifecycleCoordinator made in C3
registerCache(cache: Pick<SwrCache, "link" | "quiesce" | "close">): () => void;
```

**Why:** `SwrCache.get` at `src/swr_cache.ts:133` starts background refreshes via `this.refresh` at `src/swr_cache.ts:195` that call `this.persist` at `src/swr_cache.ts:94`, which writes through `fileStore.save` at `src/swr_cache_file_store.ts:75` (temp + rename). A refresh aborted mid-write by `process.exit(0)` at `src/app.ts:194` can leave a torn file; `load()` at `src/swr_cache_file_store.ts:54` skips corrupt JSON but a half-renamed file can still be observed.

### Steps

- [ ] **C3.1** Write `tests/swr_cache_quiesce.test.ts` failing tests using `FixedClock` and `deferredFetcher` (pattern from `tests/swr_cache.test.ts:5`): (a) after `quiesce()`, a stale `get` serves the stale value and does NOT start a refresh (fetch call count stays at the prior value); (b) `link(token)` then `cancel("shutdown")` makes a subsequent stale `get` serve stale without starting a refresh; (c) `close()` is idempotent and after it a `get` rejects (no new fetch started). Run `npx jest tests/swr_cache_quiesce.test.ts --runInBand`; expected: FAIL because `SwrCache.quiesce` is undefined.
- [ ] **C3.2** Implement `quiesce`/`link`/`close` in `src/swr_cache.ts`: add a `quiesced`/`closed` flag checked at the top of `get`/`warm`/`refresh`; when linked token cancels, set the quiesced flag via `token.onCancel`. Run `npx jest tests/swr_cache_quiesce.test.ts` → expect **pass**.
- [ ] **C3.3** Write a failing test in `tests/swr_cache_file_store.test.ts`: a store with a `close()` that tracks a flushed flag; `SwrCache.close()` calls `store.close?.()`. Run `npx jest tests/swr_cache_file_store.test.ts --runInBand`; expected: FAIL because `close` is not invoked.
- [ ] **C3.4** Add optional `close()` to the `SwrCacheStore` interface and a best-effort flush in `fileStore`. Wire `SwrCache.close()` to invoke `store.close?.()`. Run `npx jest tests/swr_cache_file_store.test.ts --runInBand`; expected: PASS.
- [ ] **C3.5** Edit `src/lifecycle.ts` `shutdown()` to call `quiesce()` on all linked caches at shutdown-begin, await the drain interval, then `close()` them at shutdown-end. Update `tests/lifecycle.test.ts`. Run: `npx jest tests/swr_cache_quiesce.test.ts tests/swr_cache_file_store.test.ts tests/lifecycle.test.ts` → expect **pass**.
- [ ] **C3.6** Commit `git add src/swr_cache.ts src/swr_cache_file_store.ts src/lifecycle.ts tests/swr_cache_quiesce.test.ts tests/swr_cache_file_store.test.ts tests/lifecycle.test.ts && git commit -m "feat(c3): cache quiescence and writer close"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record its digest.

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

- [ ] **C4.1** Write `tests/cache_envelope.test.ts` failing tests: `wrapEnvelope("albumPage", {x:1}, "abc")` sets `payloadHash` to the sha256 of the JSON payload, `payloadLength` to its byte length, `ENVELOPE_VERSION`; `parseEnvelope(envelope, {maxBytes: 1048576})` returns `{ok:true}`; `parseEnvelope({...envelope, payloadHash:"deadbeef"}, {maxBytes:1048576})` returns `{ok:false, reason:"BAD_HASH"}`; a missing field returns `{ok:false, reason:"BAD_SHAPE"}`; an envelope with a higher version returns `{ok:false, reason:"FUTURE_VERSION"}`. Run `npx jest tests/cache_envelope.test.ts --runInBand`; expected: FAIL with module `../src/cache_envelope` not found.
- [ ] **C4.2** Implement `src/cache_envelope.ts`. Run `npx jest tests/cache_envelope.test.ts --runInBand`; expected: PASS.
- [ ] **C4.3** Add failing tests to `tests/swr_cache_file_store.test.ts`: a `save` then fresh `load` round-trips an envelope (assert `loaded[0].value` is the unwrapped payload and the on-disk file contains `schemaVersion`/`payloadHash`); a file with a wrong `payloadHash` is skipped on `load` (not silently accepted). Run `npx jest tests/swr_cache_file_store.test.ts --runInBand`; expected: FAIL because the file is not envelope-wrapped.
- [ ] **C4.4** Edit `src/swr_cache_file_store.ts` so `save` writes `{ key, at, value: wrapEnvelope(...) }` and `load` runs `parseEnvelope` and skips anything `!ok`. Run `npx jest tests/swr_cache_file_store.test.ts --runInBand`; expected: PASS.
- [ ] **C4.5** Regression: `npx jest tests/swr_cache.test.ts tests/swr_cache_file_store.test.ts tests/cache_envelope.test.ts` → expect **pass**.
- [ ] **C4.6** Commit `git add src/cache_envelope.ts src/swr_cache_file_store.ts tests/cache_envelope.test.ts tests/swr_cache_file_store.test.ts && git commit -m "feat(c4): versioned cache envelope"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record its digest.

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

- [ ] **C5.1** Write `tests/cache_validators.test.ts` failing tests per kind: `artists` rejects a duplicate id; `albumPage` accepts a valid page; `albumIndex` rejects overlapping buckets (`[{offset:0,count:5},{offset:3,count:2}]`) and a bucket referencing beyond `items.length`; `albumIndex` rejects `total` exceeding `maxContainerTotal`. Run `npx jest tests/cache_validators.test.ts --runInBand`; expected: FAIL with module `../src/cache_validators` not found.
- [ ] **C5.2** Implement `src/cache_validators.ts` using `AlbumIndexBucket`/`AlbumIndex` from `src/album_index.ts`. Run `npx jest tests/cache_validators.test.ts --runInBand`; expected: PASS.
- [ ] **C5.3** Wire `fileStore.load` to call `validateRecord(kind, payload, { maxContainerTotal: DEFAULT_SONOS_MAX_CONTAINER_TOTAL })` after `parseEnvelope` and skip records returning `!ok`. Add a failing test that a semantically-invalid persisted record is skipped; run `npx jest tests/cache_validators.test.ts tests/swr_cache_file_store.test.ts --runInBand`; expected: FAIL before wiring and PASS after wiring.
- [ ] **C5.4** Regression: `npx jest tests/cache_validators.test.ts tests/swr_cache_file_store.test.ts tests/album_index.test.ts` → expect **pass**.
- [ ] **C5.5** Commit `git add src/cache_validators.ts src/swr_cache_file_store.ts tests/cache_validators.test.ts tests/swr_cache_file_store.test.ts && git commit -m "feat(c5): semantic cache validators"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record its digest.

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
  Run `npx jest tests/graceful_shutdown.test.ts --runInBand`; expected: FAIL because `runGracefulShutdown` is not exported.
- [ ] **C6.2** Implement `runGracefulShutdown` and wire `LifecycleCoordinator.shutdown()` to call it when an `httpServer` is registered (`lifecycle.attachHttp(server)`). In `src/app.ts`, capture `const httpServer = app.listen(...)` and call `runGracefulShutdown(lifecycle, httpServer).then(({clean}) => process.exit(clean?0:1))` from both `SIGTERM` and `SIGINT` handlers. Run `npx jest tests/graceful_shutdown.test.ts --runInBand`; expected: PASS.
- [ ] **C6.3** Add restart-cache test: build a cache with `fileStore` over a temp dir, write a valid envelope, construct a fresh app via `createApp`, assert the persisted entry loads and is served (no cold rebuild). Run `npx jest tests/graceful_shutdown.test.ts --runInBand`; expected: PASS.
- [ ] **C6.4** Edit `etc/docker-compose.yaml`: set `bonob.stop_grace_period` to a value strictly greater than `BNB_SHUTDOWN_DRAIN_MS` (e.g. `90s` for a `60s` drain). Add a test/doc note that the gate verifies `stop_grace_period > drainIntervalMs`. Run `npx jest tests/graceful_shutdown.test.ts` → expect **pass**.
- [ ] **C6.5** Commit `git add src/app.ts src/lifecycle.ts etc/docker-compose.yaml tests/graceful_shutdown.test.ts && git commit -m "feat(c6): graceful shutdown"`; then execute the exact Plan-B artifact gate in §4, additionally asserting clean `SIGTERM` stop within the configured grace interval, and record its digest.

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

- [ ] **C7.1** Write `tests/diagnostics.test.ts` failing tests: `buildDiagnostics` with stubbed deps returns a snapshot whose `cache.entryCount` equals the stub, `activeRequests`/`activeStreams` equal the registry counts, and the JSON contains no field named like `secret`/`token`/`password`/`username` and no media `title`/`artist`/`album` (assert with a regex scan over `JSON.stringify`). `isLoopbackOrOperator` returns true for `127.0.0.1`/`::1` and false for a public IP without a matching operator token. Run `npx jest tests/diagnostics.test.ts --runInBand`; expected: FAIL with module `../src/diagnostics` not found.
- [ ] **C7.2** Implement `src/diagnostics.ts`. Run `npx jest tests/diagnostics.test.ts --runInBand`; expected: PASS.
- [ ] **C7.3** Add failing test: a `supertest` request to `/internal/diagnostics` from a non-loopback remote IP without the operator token returns `404` (route hidden), and from loopback returns `200` with the snapshot and `Cache-Control: no-store`. Run `npx jest tests/diagnostics.test.ts --runInBand`; expected: FAIL before the route exists.
- [ ] **C7.4** Edit `src/server.ts` to add the guarded route using `isLoopbackOrOperator`; edit `src/app_factory.ts` to pass the real registries + cache status into `buildDiagnostics`. Run `npx jest tests/diagnostics.test.ts --runInBand`; expected: PASS.
- [ ] **C7.5** Add a redaction scan test: feed a snapshot with a fake `token` field (should never exist) and assert the public serializer omits it; this guards against future fields leaking. Run `npx jest tests/diagnostics.test.ts --runInBand`; expected: PASS.
- [ ] **C7.6** Commit `git add src/diagnostics.ts src/server.ts src/app_factory.ts tests/diagnostics.test.ts && git commit -m "feat(c7): protected diagnostics"`; then execute the exact Plan-B artifact gate in §4 with the resulting `HEAD` and record its digest.

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
  Run `npx jest tests/outbound_log.test.ts --runInBand`; expected: FAIL with module `../src/outbound_log` not found.
- [ ] **C8.2** Implement `src/outbound_log.ts` using axios request/response interceptors; compute `latencyMs` from request/start timestamp; derive `outcome` from `classifyOutcome`. Run `npx jest tests/outbound_log.test.ts --runInBand`; expected: PASS.
- [ ] **C8.3** Add failing tests for failure paths: simulate a timeout, a DNS failure, a TLS error, and a malformed JSON response through `withOutboundLogging` and assert each emits the right `outcome` and contains no URL/credential/body. Run `npx jest tests/outbound_log.test.ts --runInBand`; expected: FAIL before those paths are wired and PASS after wiring.
- [ ] **C8.4** Edit `src/subsonic.ts` to route `get`/`post`/image fetchers through a module-level axios instance wrapped by `withOutboundLogging(..., "navidrome"|"deezer"|"proxy", ...)`; pass the lifecycle cancellation token so in-flight requests observe shutdown. Add a forced-429 test against the `Subsonic` class (mock axios) asserting the sink receives `outcome:"client_4xx", status:429`. Run `npx jest tests/outbound_log.test.ts tests/subsonic.test.ts --runInBand`; expected: PASS.
- [ ] **C8.5** Assert the public request log (`redactAccessTokenFromUrl` at `src/server.ts:127`) continues to mask `bat` and that no new outbound log emits a raw URL. Run: `npx jest tests/outbound_log.test.ts tests/server.test.ts` → expect **pass**.
- [ ] **C8.6** Commit `git add src/outbound_log.ts src/subsonic.ts tests/outbound_log.test.ts && git commit -m "feat(c8): outbound attribution and redaction"`; then execute the exact Plan-B artifact gate in §4, including the redaction test, and record its digest.

---

## Task C9 — Fully disposable candidate topology

**Goal:** Each candidate stack contains candidate Bonob + disposable candidate Navidrome (or immutable equivalent) with unique candidate credentials, candidate-owned metadata/data/media, and a per-run cache directory; it joins no production network and mounts no production state (spec §6, §7.1; criteria 9, 11). Root-only credential no-follow/open/`fstat` checks pass with accurate token-revocation wording.

**Files:**
- new `candidate/docker-compose.candidate.yaml` — candidate stack with unique aliases on an internal network.
- new `candidate/env.candidate.example` — unique candidate creds (no production values).
- new `candidate/init-smoke-account.sh` — creates the dedicated non-admin smoke account in candidate Navidrome.
- new `candidate/start-run.sh` — validates runtime inputs, creates a unique run manifest/env file, and starts only the isolated project.
- new `candidate/README.md` — topology, sentinel, and credential-handling rules.
- new `tests/candidate_topology.test.ts` — static/structural assertions over the compose file.

**Interfaces/signatures (exact):**

```yaml
# candidate/docker-compose.candidate.yaml — values come only from the validated,
# gitignored per-run env file written by candidate/start-run.sh.
services:
  navidrome-candidate:
    image: ${CANDIDATE_NAVIDROME_IMAGE:?CANDIDATE_NAVIDROME_IMAGE is required}
    networks: [candidate_net]
    volumes:
      - candidate-navidrome-data:/data                # named disposable volume
      - ./media-fixture:/music:ro                     # candidate-owned read-only fixture
  bonob-candidate:
    image: ${CANDIDATE_BONOB_IMAGE:?CANDIDATE_BONOB_IMAGE is required}
    environment:
      BNB_URL: ${CANDIDATE_CANONICAL_ORIGIN:?CANDIDATE_CANONICAL_ORIGIN is required}
      BNB_SUBSONIC_URL: http://navidrome-candidate:4533
      BNB_SUBSONIC_CACHE_DIR: /cache
      BNB_SECRET: ${CANDIDATE_BONOB_SECRET:?CANDIDATE_BONOB_SECRET is required}
      BNB_CANDIDATE_SENTINEL: ${CANDIDATE_SENTINEL:?CANDIDATE_SENTINEL is required}
    networks: [candidate_net]
    ports:
      - "127.0.0.1::4534"
    volumes:
      - ${CANDIDATE_CACHE_DIR:?CANDIDATE_CACHE_DIR is required}:/cache
networks:
  candidate_net:
    internal: true                                    # no default external route
volumes:
  candidate-navidrome-data:
```

```bash
# candidate/start-run.sh
#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PLAN_B_ARTIFACT_DIR:?set to the downloaded Plan-B OCI artifact directory}"
: "${CANDIDATE_BONOB_IMAGE:?set to the Plan-B immutable ghcr image digest}"
: "${CANDIDATE_CANONICAL_ORIGIN:?set from the root-controlled operator environment}"
: "${CANDIDATE_NAVIDROME_IMAGE:?set to the reviewed immutable Navidrome image reference}"
test -f "${PLAN_B_ARTIFACT_DIR}/hashes.txt"
test -f "${PLAN_B_ARTIFACT_DIR}/image.oci"
grep -Eq '^[0-9a-f]{64}[[:space:]]+image\.oci$' "${PLAN_B_ARTIFACT_DIR}/hashes.txt" || { echo 'Plan-B image.oci hash missing' >&2; exit 1; }
case "${CANDIDATE_BONOB_IMAGE}" in ghcr.io/richertunes/bonob@sha256:*) ;; *) echo 'Bonob image must be the private immutable Plan-B digest' >&2; exit 1;; esac
case "${CANDIDATE_NAVIDROME_IMAGE}" in *@sha256:*) ;; *) echo 'Navidrome image must be digest-pinned' >&2; exit 1;; esac
case "${CANDIDATE_CANONICAL_ORIGIN}" in https://*) ;; *) echo 'canonical origin must use https' >&2; exit 1;; esac
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 16)"
RUN_DIR="candidate/runs/${RUN_ID}"
mkdir -p "${RUN_DIR}/cache"
CANDIDATE_CACHE_DIR="$(cd "${RUN_DIR}/cache" && pwd)"
CANDIDATE_BONOB_SECRET="$(openssl rand -hex 32)"
CANDIDATE_SENTINEL="candidate-${RUN_ID}-$(openssl rand -hex 16)"
export RUN_ID CANDIDATE_CACHE_DIR CANDIDATE_BONOB_IMAGE CANDIDATE_NAVIDROME_IMAGE CANDIDATE_CANONICAL_ORIGIN CANDIDATE_BONOB_SECRET CANDIDATE_SENTINEL
printf 'CANDIDATE_BONOB_IMAGE=%s\nCANDIDATE_NAVIDROME_IMAGE=%s\nCANDIDATE_CANONICAL_ORIGIN=%s\nCANDIDATE_BONOB_SECRET=%s\nCANDIDATE_SENTINEL=%s\nCANDIDATE_CACHE_DIR=%s\n' "${CANDIDATE_BONOB_IMAGE}" "${CANDIDATE_NAVIDROME_IMAGE}" "${CANDIDATE_CANONICAL_ORIGIN}" "${CANDIDATE_BONOB_SECRET}" "${CANDIDATE_SENTINEL}" "${CANDIDATE_CACHE_DIR}" > "${RUN_DIR}/compose.env"
chmod 600 "${RUN_DIR}/compose.env"
printf '%s\n' "${CANDIDATE_BONOB_SECRET}" > "${RUN_DIR}/credential"
chmod 600 "${RUN_DIR}/credential"
node -e 'const fs=require("node:fs"); const p=process.argv[1]; const o={runId:process.env.RUN_ID,commit:require("child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),bonobImage:process.env.CANDIDATE_BONOB_IMAGE,navidromeImage:process.env.CANDIDATE_NAVIDROME_IMAGE,canonicalOrigin:process.env.CANDIDATE_CANONICAL_ORIGIN,cacheDir:process.env.CANDIDATE_CACHE_DIR}; fs.writeFileSync(`${p}/manifest.json`,JSON.stringify(o,null,2)+"\n",{mode:0o600});' "${RUN_DIR}"
docker compose --project-name "bonob-candidate-${RUN_ID}" --env-file "${RUN_DIR}/compose.env" -f candidate/docker-compose.candidate.yaml up --detach --wait
node -e 'const fs=require("node:fs"); const cp=require("node:child_process"); const p=process.argv[1]; const project=process.argv[2]; const args=["compose","--project-name",project,"--env-file",p+"/compose.env","-f","candidate/docker-compose.candidate.yaml","port","bonob-candidate","4534"]; const port=cp.execFileSync("docker",args,{encoding:"utf8"}).trim(); const m=JSON.parse(fs.readFileSync(p+"/manifest.json","utf8")); m.transportBase="http://"+port; fs.writeFileSync(p+"/manifest.json",JSON.stringify(m,null,2)+"\n",{mode:0o600});' "${RUN_DIR}" "bonob-candidate-${RUN_ID}"
printf '%s\n' "${RUN_DIR}"
```

**Why:** The existing `etc/docker-compose.yaml` uses `simojenki/bonob:latest`, `:latest` Navidrome, host bind-mounts (`/tmp/navidrome/...`), and `BNB_SECRET: changeme` — none of which is disposable, isolated, or uniquely credentialed. The spec forbids candidate/production cache sharing and production alias/name/IP reuse (§11 non-goals).

### Steps

- [ ] **C9.1** Write `tests/candidate_topology.test.ts` before creating candidate files. Parse the compose YAML as text and assert it contains the four `:?… is required` guards above, `internal: true`, named volumes, `:ro` media, and contains neither `:latest` nor `changeme`. Run `npx jest tests/candidate_topology.test.ts --runInBand`; expected: FAIL because `candidate/docker-compose.candidate.yaml` does not exist.
- [ ] **C9.2** Create the compose file exactly as shown, a names-only `candidate/env.candidate.example` listing `PLAN_B_ARTIFACT_DIR`, `CANDIDATE_BONOB_IMAGE`, `CANDIDATE_CANONICAL_ORIGIN`, and `CANDIDATE_NAVIDROME_IMAGE`, candidate-owned synthetic `candidate/media-fixture/`, and `candidate/init-smoke-account.sh` that rejects a non-`bonob-smoke-` username. Run `npx jest tests/candidate_topology.test.ts --runInBand`; expected: PASS.
- [ ] **C9.3** Write a failing Jest test that invokes `candidate/start-run.sh` with a temporary artifact directory missing `hashes.txt` and expects nonzero exit without creating `candidate/runs/`. Run `npx jest tests/candidate_topology.test.ts --runInBand`; expected: FAIL because the launcher is absent.
- [ ] **C9.4** Add `candidate/start-run.sh` exactly as shown and extend the test to supply a fake `hashes.txt`/`image.oci` plus a stubbed `docker` executable. Assert one `manifest.json` is mode `0600`, contains the current commit and immutable image references, has no secret or sentinel fields, and a second invocation produces a different run directory. Run `npx jest tests/candidate_topology.test.ts --runInBand`; expected: PASS. Add the root-owned/no-follow/`fstat` credential contract and the distinct account-rotation/token-invalidating wording to `candidate/README.md`.
- [ ] **C9.5** Commit the task: `git add candidate tests/candidate_topology.test.ts && git commit -m "feat(c9): disposable candidate topology"`. Then run the exact Plan-B artifact gate in §4 with this commit SHA and the candidate topology test; expected: all commands pass and the resulting immutable digest is recorded in that slice's secret-free evidence manifest.

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
  Run `npx jest candidate/negatives.test.ts --runInBand`; expected: FAIL with module `./origin_validator` not found.
- [ ] **C10.2** Implement `candidate/origin_validator.ts` and `candidate/egress-default-deny.conf`. Run `npx jest candidate/negatives.test.ts --runInBand`; expected: PASS.
- [ ] **C10.3** Add a sentinel-leak test: send a request carrying the unique candidate sentinel through the candidate proxy; assert the sentinel appears in candidate logs and would NOT appear in a stubbed production proxy/counter for the same interval. Run `npx jest candidate/negatives.test.ts --runInBand`; expected: PASS.
- [ ] **C10.4** Confirm the edge proxy still resolves its Bonob upstream only to production by checking the candidate evidence only: its generated resolver fixture must contain no production upstream entry, while the independently supplied production-side resolver attestation hash is recorded. Run `npx jest candidate/negatives.test.ts --runInBand`; expected: PASS. Do not inspect or access production configuration from this plan.
- [ ] **C10.5** Commit `git add candidate/egress-default-deny.conf candidate/negatives.test.ts candidate/origin_validator.ts && git commit -m "feat(c10): default-deny egress and negative reachability"`; then execute the exact Plan-B artifact gate in §4, preserving only hashed egress/network/DNS evidence, and record its digest.

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

- [ ] **C11.1** Write `tests/harness.test.ts` failing tests for pure helpers: `readCredential` rejects a symlinked credential file (no-follow + `fstat`), a non-root-owned file, and a mode more permissive than `0600`; `SweepResult` serialization contains no token/username/password/url/body (regex scan). Run `npx jest tests/harness.test.ts --runInBand`; expected: FAIL with module `../scripts/lib/credential_reader` not found.
- [ ] **C11.2** Implement `scripts/lib/credential_reader.ts` using `fs.openSync(path, 'r')` with `O_NOFOLLOW`, `fs.fstatSync`, owner/mode checks. Run `npx jest tests/harness.test.ts --runInBand`; expected: PASS.
- [ ] **C11.3** Implement `scripts/bonob-e2e-sweep.ts`: call `getAppLink` (SOAP at `src/smapi.ts:226`), validate/rewrite `regUrl` via `validateBonobGeneratedUrl`, POST the link code to `/login`, call `getDeviceAuthToken`, keep the SMAPI token in a closure variable (never logged/persisted), traverse read-only sections serially. Run `npx ts-node scripts/bonob-e2e-sweep.ts --help` → expect a usage banner (no network). Run `npx jest tests/harness.test.ts` → expect **pass**.
- [ ] **C11.4** Add a forced-429 attribution test (mock the SOAP client to return 429 once): assert `SweepResult.forced429.attributed === true` and the emitted log line matches the `redactedCompletion` shape from C8 (six fields only). Run `npx jest tests/harness.test.ts --runInBand`; expected: FAIL before attribution wiring and PASS after wiring.
- [ ] **C11.5** Add mutation-mode guard test: without `--mutate`, no playlist mutation occurs; with `--mutate`, only a new `bonob-smoke-` playlist is created/verified/deleted in disposable candidate state, even on failure. Run `npx jest tests/harness.test.ts --runInBand`; expected: PASS.
- [ ] **C11.6** Commit `git add scripts/bonob-e2e-sweep.ts scripts/lib/credential_reader.ts scripts/lib/url_origin.ts tests/harness.test.ts && git commit -m "feat(c11): safe browser-link harness"`; then execute the exact Plan-B artifact gate in §4, including aggregate-only sweep output and the no-token persistence scan, and record its digest.

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
#!/usr/bin/env bash
set -euo pipefail
: "${CANDIDATE_RUN_DIR:?set to the path emitted by candidate/start-run.sh}"
: "${CANDIDATE_BASE_URL:?set to the loopback candidate transport base}"
cache_dir="${CANDIDATE_RUN_DIR}/cache-cold"
evidence_dir="${CANDIDATE_RUN_DIR}/evidence"
mkdir -p "${cache_dir}" "${evidence_dir}"
test -z "$(find "${cache_dir}" -mindepth 1 -print -quit)"
docker compose --project-name "$(basename "${CANDIDATE_RUN_DIR}")" --env-file "${CANDIDATE_RUN_DIR}/compose.env" -f candidate/docker-compose.candidate.yaml exec -T bonob-candidate sh -ceu "test -d /cache"
curl --fail --silent --show-error --max-time 20 "${CANDIDATE_BASE_URL}/about" >/dev/null
curl --fail --silent --show-error --max-time 60 "${CANDIDATE_BASE_URL}/smapi" >/dev/null
find "${cache_dir}" -type f -printf '%P\t%s\n' | LC_ALL=C sort > "${evidence_dir}/cold-cache-files.tsv"
test -s "${evidence_dir}/cold-cache-files.tsv"
sha256sum "${cache_dir}"/* > "${evidence_dir}/cold-cache-sha256.txt"

# candidate/run_snapshot_cache.sh
#!/usr/bin/env bash
set -euo pipefail
: "${CANDIDATE_RUN_DIR:?set to the path emitted by candidate/start-run.sh}"
: "${CANDIDATE_BASE_URL:?set to the loopback candidate transport base}"
source_dir="candidate/fixtures/cache-snapshot"
run_dir="${CANDIDATE_RUN_DIR}/cache-snapshot"
evidence_dir="${CANDIDATE_RUN_DIR}/evidence"
mkdir -p "${evidence_dir}"
find "${source_dir}" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "${evidence_dir}/snapshot-source-before.sha256"
cp -a "${source_dir}" "${run_dir}"
docker compose --project-name "$(basename "${CANDIDATE_RUN_DIR}")" --env-file "${CANDIDATE_RUN_DIR}/compose.env" -f candidate/docker-compose.candidate.yaml restart bonob-candidate
curl --fail --silent --show-error --max-time 20 "${CANDIDATE_BASE_URL}/internal/diagnostics" > "${evidence_dir}/snapshot-diagnostics.json"
node -e 'const d=require(process.argv[1]); if (d.cache.loadStatus === "empty" || d.cache.refreshInProgress) process.exit(1)' "${evidence_dir}/snapshot-diagnostics.json"
find "${source_dir}" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "${evidence_dir}/snapshot-source-after.sha256"
cmp --silent "${evidence_dir}/snapshot-source-before.sha256" "${evidence_dir}/snapshot-source-after.sha256"
find "${run_dir}" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > "${evidence_dir}/snapshot-run.sha256"
test -s "${evidence_dir}/snapshot-run.sha256"
```

**Why:** `SwrCache` seeds from the store on construction (`src/swr_cache.ts:69`) only when `ttlMs > 0`; a cold dir exercises the `coldFetch` path (`src/swr_cache.ts:168`), and a snapshot exercises `seed` (`src/swr_cache.ts:75`) plus the envelope/semantic validators from C4/C5. The spec requires that candidate validation never reads, copies, or mounts the production cache.

### Steps

- [ ] **C12.1** Write `tests/cache_runs.test.ts` first. With a temporary source fixture and run directory, require before/after per-file SHA-256 lists to match, require the run copy's hash list to exist, and reject a source fixture mode writable by group or other. Run `npx jest tests/cache_runs.test.ts --runInBand`; expected: FAIL because the scripts and fixture do not exist.
- [ ] **C12.2** Create `candidate/fixtures/cache-snapshot/` containing C4/C5-valid `artists`, `albumPage`, and `albumIndex` envelopes plus one named invalid envelope retained for diagnosis. Add tests that the invalid file survives and causes an explicit cold rebuild reason, rather than an overwrite. Run `npx jest tests/cache_runs.test.ts --runInBand`; expected: PASS for structural tests.
- [ ] **C12.3** Implement both scripts exactly as shown. Start a candidate run with `candidate/start-run.sh`; export its printed directory as `CANDIDATE_RUN_DIR`, then set `CANDIDATE_BASE_URL="$(node -p "require('./' + process.env.CANDIDATE_RUN_DIR + '/manifest.json').transportBase")"`. Run `candidate/run_cold_cache.sh` and `candidate/run_snapshot_cache.sh`; expected: exit `0`, nonempty evidence hash lists, immutable fixture before/after hashes, and diagnostics with a nonempty cache load status and no refresh in progress.
- [ ] **C12.4** Commit the task: `git add candidate/fixtures/cache-snapshot candidate/run_cold_cache.sh candidate/run_snapshot_cache.sh tests/cache_runs.test.ts && git commit -m "feat(c12): cold and snapshot cache runs"`. Then run the exact Plan-B artifact gate in §4 with this commit SHA, including both cache-run scripts; expected: all commands pass and the secret-free evidence manifest records the resulting immutable digest.

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

- [ ] **C13.1** Write `tests/soak_helpers.test.ts` failing tests: `median([1,2,3])===2`; `percentile([...],95)` on a known array equals the expected value; `evaluateSoak` returns fail when RSS growth exceeds 64MiB, when post-cooldown handles exceed 10% of a nonzero warm baseline, and when success rate < 99.5%; `evaluateDecision` flags a 5-in-60s burst as `release_blocker` and a 1–4 window as `attribute_investigate`. Run `npx jest tests/soak_helpers.test.ts --runInBand`; expected: FAIL with module `../scripts/lib/metrics` not found.
- [ ] **C13.2** Implement `scripts/lib/metrics.ts` and `scripts/lib/decision_table.ts`. Run `npx jest tests/soak_helpers.test.ts --runInBand`; expected: PASS.
- [ ] **C13.3** Implement `scripts/bonob-soak.ts`: 30-min warmup → 2h/1,000-cycle load (open/play/range/seek/stop/disconnect) → 5-min cooldown; sample every 10s; classify every cycle result; emit aggregate-only output with warm/final/post-cooldown medians and the verdict. Run `npx ts-node scripts/bonob-soak.ts --dry-run` → expect a plan/verdict structure (no full 2h run in unit tests). Run `npx jest tests/soak_helpers.test.ts` → expect **pass**.
- [ ] **C13.4** Add cycle-correctness unit tests: a cycle returning wrong status/content-type/content-length/range/body-hash is counted as a failure and never consumes the success budget; expected negative/cancellation cases are counted separately with their exact expected status/body (spec §5.2 ¶4, §9 row 1). Run `npx jest tests/soak_helpers.test.ts --runInBand`; expected: PASS.
- [ ] **C13.5** Run the full soak against the candidate topology (C9) as an evidence step, not part of the unit suite: `npx ts-node scripts/bonob-soak.ts --candidate-run "$CANDIDATE_RUN_DIR" --duration-ms 7200000 --minimum-cycles 1000 --warmup-ms 1800000 --cooldown-ms 300000 --sample-ms 10000 > "$CANDIDATE_RUN_DIR/evidence/soak-verdict.json"`. Expected: exit `0`, a passing verdict JSON, and zero unhandled rejection, crash, or cache corruption.
- [ ] **C13.6** Commit `git add scripts/bonob-soak.ts scripts/lib/metrics.ts scripts/lib/decision_table.ts tests/soak_helpers.test.ts && git commit -m "feat(c13): objective two-hour soak"`; then execute the exact Plan-B artifact gate in §4 with the recorded soak verdict and record its digest.

---

## 4. Cross-cutting gates (every task)

After its atomic commit is fast-forwarded to `master`, every task executes this exact Plan-B artifact gate. Inputs are discovered at execution time and fail closed; the command never prints a credential, canonical origin, sentinel, or production identifier. `PLAN_B_ARTIFACT_DIR` is the downloaded immutable build/test/scan artifact from Plan B, and the four `CANDIDATE_*` inputs are the root-controlled values validated by `candidate/start-run.sh` in C9.

```bash
set -euo pipefail
: "${PLAN_B_ARTIFACT_DIR:?set to Plan-B downloaded artifacts}"
: "${CANDIDATE_BONOB_IMAGE:?set to the private immutable Plan-B image digest}"
: "${CANDIDATE_CANONICAL_ORIGIN:?set from root-controlled operator environment}"
: "${CANDIDATE_NAVIDROME_IMAGE:?set to reviewed immutable Navidrome digest}"
SLICE_SHA="$(git rev-parse HEAD)"
git fetch origin master
test "${SLICE_SHA}" = "$(git rev-parse origin/master)"
test -f "${PLAN_B_ARTIFACT_DIR}/image.oci"
test -f "${PLAN_B_ARTIFACT_DIR}/hashes.txt"
grep -Eq '^[0-9a-f]{64}[[:space:]]+image\.oci$' "${PLAN_B_ARTIFACT_DIR}/hashes.txt"
npm ci
npm run build
npm test
npm audit --omit=dev --audit-level=high
rm -rf build-context
node -e "import('./tools/build_context.mjs').then(m=>m.generate(m.loadAllowlist(),'./build-context',{revision:{commit:process.argv[1],describe:process.argv[1]}}))" "${SLICE_SHA}"
node -e "import('./tools/scan_context.mjs').then(m=>{const r=m.scanContext('./build-context'); process.exit(r.ok ? 0 : 1)})"
docker buildx build --platform linux/amd64 --load --build-arg "OCI_REVISION=${SLICE_SHA}" --tag "bonob:${SLICE_SHA}" --file Dockerfile ./build-context
SMOKE_SECRET="$(openssl rand -hex 32)"
SMOKE_ID="$(docker run --detach --rm --publish 127.0.0.1::4534 --env BNB_URL=https://bonob-smoke.invalid --env BNB_SECRET="${SMOKE_SECRET}" --env BNB_SUBSONIC_URL=http://127.0.0.1:9 "bonob:${SLICE_SHA}")"
unset SMOKE_SECRET
SMOKE_PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "4534/tcp") 0).HostPort}}' "${SMOKE_ID}")"
trap 'docker stop "${SMOKE_ID}" >/dev/null 2>&1 || true' EXIT
curl --fail --silent --show-error --max-time 20 "http://127.0.0.1:${SMOKE_PORT}/"
curl --fail --silent --show-error --max-time 20 "http://127.0.0.1:${SMOKE_PORT}/about"
docker stop "${SMOKE_ID}" >/dev/null
trap - EXIT
RUN_DIR="$(candidate/start-run.sh)"
export CANDIDATE_RUN_DIR="${RUN_DIR}"
export CANDIDATE_BASE_URL="http://127.0.0.1:4534"
npx jest --runInBand
candidate/run_cold_cache.sh
candidate/run_snapshot_cache.sh
npx ts-node scripts/bonob-e2e-sweep.ts --candidate-run "${CANDIDATE_RUN_DIR}"
docker compose --project-name "$(basename "${CANDIDATE_RUN_DIR}")" -f candidate/docker-compose.candidate.yaml down --volumes --remove-orphans
gh workflow run build-test-scan.yml --ref master -f "sha=${SLICE_SHA}"
```

Expected: each local command exits `0`; the trusted Plan-B run records an OCI image whose tag is `sha-${SLICE_SHA}`, whose OCI revision label equals `SLICE_SHA`, and whose image/archive/scan hashes are new for this slice. The release-manifest verification then proves anonymous pull fails and the authorized candidate pull succeeds. Persist only the commit, immutable digest, artifact IDs, tool/report hashes, and pass/fail values in the secret-free evidence manifest.

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
