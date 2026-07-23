# Plan F — Post-stability behavior-preserving module extraction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the large SMAPI, Subsonic, cache, transport, and streaming modules behind their existing interfaces without changing any observable behavior.

**Architecture:** The plan is hard-blocked until the same Plan-E production digest has seven continuous stable days. Once open, each one-boundary slice first adds an import/facade plus invariant test, then moves code verbatim behind a backward-compatible facade, proves the frozen golden corpus unchanged, and generates a fresh candidate artifact. No extraction shares a commit with a behavior, dependency, or deployment change.

**Tech Stack:** TypeScript 5.9, Jest 30, existing `src/smapi.ts`, `src/subsonic.ts`, `src/swr_cache.ts`, `src/swr_cache_file_store.ts`, Plan-C safe candidate sweep and Plan-B artifact lane.

## Global Constraints

- “Large `smapi.ts` and `subsonic.ts` extractions begin only after field stability: seven continuous days on the same production digest, at least three distinct physical Sonos sessions, zero rollback, zero open release blocker, and zero unattributed production error” (spec §5.4).
- “Golden SOAP/HTTP fixtures, the full unit suite, the safe sweep, and physical acceptance must remain unchanged” (spec §5.4).
- “Refactoring is never combined with a protocol feature or dependency major update” (spec §5.4).
- The extraction separates “protocol serialization, authentication, browse/query orchestration, caching, upstream transport, and streaming behind existing interfaces” (spec §5.4).
- Each code-changing slice starts from exact current `master` and has a new build/audit/scan/smoke/candidate-tested digest; evidence is never reused across code SHAs (criterion 8).
- Before further extraction, the resulting digest must complete a new seven-day field-stability cycle (spec §1.1 and §5.4).

---

**Hard blocker:** No source/test/facade file may be created or modified until F.0 evidence passes. If its test fails, report Plan F as blocked and stop; do not prepare an extraction branch, run a candidate build, or make an extraction commit.

**Golden/evidence interfaces:**

```ts
type FieldStabilityEvidence = {
  digest: string; startedAt: string; endedAt: string; continuousDays: number;
  physicalSessions: Array<{ startedAt: string; afterRestart: boolean }>;
  rollbackCount: number; openBlockerCount: number; unattributedProductionErrorCount: number;
};
type ExtractionEvidence = {
  slice: string; sourceSha: string; candidateDigest: string;
  goldenTreeSha256: string; fullSuiteExit: 0; safeSweepExit: 0; reviewReference: string;
};
```

`digest` and `candidateDigest` match `^sha256:[0-9a-f]{64}$`; `sourceSha` matches `git rev-parse HEAD`. The golden tree hash is generated from a sorted `sha256sum` listing of `tests/fixtures`, `tests/smapi.test.ts`, and `tests/server.test.ts`; it is immutable after F.0.

### Task F.0: Verify field stability and freeze the golden corpus

**Files:**
- Create: `docs/superpowers/evidence/2026-07-23-plan-f-field-stability.json`
- Create: `docs/superpowers/evidence/2026-07-23-plan-f-golden-tree.sha256`
- Create: `tests/plan_f_entry_gate.test.ts`
- Create: `tests/plan_f_golden_tree.test.ts`

**Interfaces:**
- Consumes Plan-E record `gates.observation24h` and same-digest physical evidence.
- Produces a passing `FieldStabilityEvidence` and immutable golden-tree hash.

- [ ] **Step 1: Write the failing seven-day gate.** Assert `continuousDays >= 7`, three sessions, one `afterRestart`, and all three counters equal `0`. Run `npx jest tests/plan_f_entry_gate.test.ts --runInBand`. Expected: FAIL because the evidence file is absent or fails the threshold.

- [ ] **Step 2: Stop unless genuine evidence exists.** Populate the JSON only from Plan-E observation/physical evidence for one digest. A missing timestamp, digest mismatch, discontinuity, or nonzero counter leaves the test failing and hard-blocks the entire plan.

- [ ] **Step 3: Write the failing golden-tree test.** Add a test that regenerates the sorted hash listing and expects byte equality with `2026-07-23-plan-f-golden-tree.sha256`. Run `npx jest tests/plan_f_golden_tree.test.ts --runInBand`. Expected: FAIL because the baseline is absent.

- [ ] **Step 4: Freeze the baseline and verify.** Generate the listing from the named paths, commit it unchanged, then run `npx jest tests/plan_f_entry_gate.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`. Expected: PASS.

- [ ] **Step 5: Commit.** Run `git add docs/superpowers/evidence/2026-07-23-plan-f-* tests/plan_f_entry_gate.test.ts tests/plan_f_golden_tree.test.ts && git commit -m "test(plan-f): gate extraction on seven-day field stability"`.

### Task F.1: Extract Subsonic serialization

**Files:**
- Create: `src/subsonic/serialization.ts`
- Modify: `src/subsonic.ts:271-551`
- Create: `tests/subsonic_serialization_facade.test.ts`
- Create: `docs/superpowers/evidence/plan-f/f1-serialization.json`

**Interfaces:**
- Produces `GetGenresResponse`, `GetAlbumResponse`, `GetPlaylistResponse`, `GetPlaylistsResponse`, `GetSimilarSongsResponse`, `GetTopSongsResponse`, `GetInternetRadioStationsResponse`, `GetSongResponse`, `GetStarredResponse`, `PingResponse`, `Search3Response`, `OpenSubsonicExtension`, `isError`, `coverArtURN`, `artistImageURN`, `asTrackSummary`, `asTrack`, `asAlbumSummary`, `asGenre`, `maybeAsGenre`, and `asYear` from both `./src/subsonic/serialization` and the existing `./src/subsonic` facade.

- [ ] **Step 1: Write red facade/mapping tests.** Import `coverArtURN`, `asTrackSummary`, and `isError` from both paths; assert identity-equivalent results for a fixture track and an error response. Run `npx jest tests/subsonic_serialization_facade.test.ts --runInBand`. Expected: FAIL because `src/subsonic/serialization.ts` is absent.

- [ ] **Step 2: Move exact definitions.** Move only the listed response types/mappers verbatim to `src/subsonic/serialization.ts`; replace their original definitions with named re-exports in `src/subsonic.ts`. Do not change mapper logic or call sites.

- [ ] **Step 3: Run green and artifact gates.** Run `npx jest tests/subsonic_serialization_facade.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`; run the Plan-C safe sweep; record a new `ExtractionEvidence` JSON. Expected: all exits `0`.

- [ ] **Step 4: Commit.** Run `git add src/subsonic.ts src/subsonic/serialization.ts tests/subsonic_serialization_facade.test.ts docs/superpowers/evidence/plan-f/f1-serialization.json && git commit -m "refactor(plan-f): extract subsonic serialization facade"`.

### Task F.2: Extract Subsonic authentication and upstream transport

**Files:**
- Create: `src/subsonic/auth.ts`
- Create: `src/subsonic/transport.ts`
- Modify: `src/subsonic.ts:41-60,210,600-677,1026-1029,1048-1718`
- Create: `tests/subsonic_auth_facade.test.ts`
- Create: `tests/subsonic_transport_invariant.test.ts`
- Create: `docs/superpowers/evidence/plan-f/f2-auth-transport.json`

**Interfaces:**
- `auth.ts` produces `t(password: string, salt: string): string`, `t_and_s(password: string): { t: string; s: string }`, `asToken(credentials: Credentials): string`, and `parseToken(token: string): Credentials`.
- `transport.ts` produces `isRetryableSubsonicError(error: unknown): boolean`, `SUBSONIC_HTTP_TIMEOUT_MS`, `USER_AGENT`, and the client transport used by `Subsonic`.
- Existing `src/subsonic.ts` continues to re-export all named members.

- [ ] **Step 1: Write red tests.** Assert both auth paths import from new/old modules, and assert a 404/mutation is not retryable while a network error and 503 read are retryable. Run `npx jest tests/subsonic_auth_facade.test.ts tests/subsonic_transport_invariant.test.ts --runInBand`. Expected: FAIL because both new modules are absent.

- [ ] **Step 2: Move auth definitions without token-format change.** Move exact helpers/types to `auth.ts`, re-export them, and preserve the existing token test vectors in `tests/subsonic_token.test.ts`.

- [ ] **Step 3: Move transport definitions without retry-policy change.** Move headers, timeout, URL parameter utility, client data, and retry predicate into `transport.ts`; adapt `Subsonic` only to call the exported transport. Keep mutations on `getJSON`, reads on `getJSONWithRetry`, and never retry HTTP 4xx.

- [ ] **Step 4: Run green/artifact gates and commit.** Run `npx jest tests/subsonic_auth_facade.test.ts tests/subsonic_transport_invariant.test.ts tests/subsonic_token.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`; safe-sweep and record f2 evidence; commit `refactor(plan-f): extract subsonic auth and transport facades`.

### Task F.3: Extract artwork/SSRF and cache interfaces

**Files:**
- Create: `src/subsonic/image_fetch.ts`
- Create: `src/cache/swr.ts`
- Create: `src/cache/file_store.ts`
- Modify: `src/subsonic.ts:70,191-204,828-936`
- Modify: `src/swr_cache.ts`
- Modify: `src/swr_cache_file_store.ts`
- Create: `tests/subsonic_image_fetch_facade.test.ts`
- Create: `tests/cache_facade.test.ts`
- Create: `docs/superpowers/evidence/plan-f/f3-image-cache.json`

**Interfaces:**
- `image_fetch.ts` produces `isSafeExternalImageUrl`, `isValidImage`, `pinnedSafeExternalLookup`, `resolvedExternalHostIsSafe`, and `ImageFetcher`; `src/subsonic.ts` re-exports them.
- `cache/swr.ts` produces `SwrCacheStore` and `SwrCache`; `cache/file_store.ts` produces `fileStore`; old paths remain re-export facades.

- [ ] **Step 1: Write red import and SSRF/cache tests.** Import every named interface from new and old paths; assert loopback/private/link-local/non-HTTPS artwork URLs are rejected and a persisted cache round-trip remains unchanged. Run `npx jest tests/subsonic_image_fetch_facade.test.ts tests/cache_facade.test.ts --runInBand`. Expected: FAIL because the new paths are absent.

- [ ] **Step 2: Move image code verbatim.** Move the named image/SSRF definitions to `image_fetch.ts`, retain DNS pinning/redirect behavior and existing facade exports; make no allowlist, resolver, MIME, or cache-header change.

- [ ] **Step 3: Move cache types/classes verbatim.** Move `SwrCacheStore`/`SwrCache` and `fileStore` to the named cache files; preserve all existing exports and Plan-C quiesce/envelope behavior.

- [ ] **Step 4: Run green/artifact gates and commit.** Run `npx jest tests/subsonic_image_fetch_facade.test.ts tests/cache_facade.test.ts tests/swr_cache.test.ts tests/swr_cache_file_store.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`; safe-sweep and record f3 evidence; commit `refactor(plan-f): extract artwork safety and cache facades`.

### Task F.4: Extract SMAPI presentation and authentication helpers

**Files:**
- Create: `src/smapi/presentation.ts`
- Create: `src/smapi/auth_helpers.ts`
- Modify: `src/smapi.ts:78-186,293-505`
- Create: `tests/smapi_presentation_facade.test.ts`
- Create: `tests/smapi_auth_helpers_facade.test.ts`
- Create: `docs/superpowers/evidence/plan-f/f4-smapi.json`

**Interfaces:**
- `presentation.ts` produces `ratingAsInt`, `ratingFromInt`, `getMetadataResult`, `searchResult`, `coverArtURI`, `iconArtURI`, `album`, `track`, `artist`, `splitId`, and `withSplitId`.
- `auth_helpers.ts` produces `LoginToken`, `Credentials`, `SoapyHeaders`, and `findLoginToken`.
- `bindSmapiSoapServiceToExpress` stays the default export of `src/smapi.ts`; old named imports remain valid.

- [ ] **Step 1: Write red facade and raw-contract tests.** Import `getMetadataResult` and `findLoginToken` from new and old paths; assert the same metadata and token results, then run the Plan-D raw SOAP fixture tests. Run `npx jest tests/smapi_presentation_facade.test.ts tests/smapi_auth_helpers_facade.test.ts tests/smapi.test.ts -t "#214|#297" --runInBand`. Expected: FAIL because both modules are absent.

- [ ] **Step 2: Move presentation helpers.** Transfer exactly the named pure mapping types/functions into `presentation.ts` and re-export them from `smapi.ts`; do not change serialized fields, SOAP faults, URLs, or XML sanitization.

- [ ] **Step 3: Move authentication helpers.** Transfer exactly the named token/header helpers into `auth_helpers.ts`, re-export them, and retain `bindSmapiSoapServiceToExpress` orchestration in `smapi.ts`.

- [ ] **Step 4: Run green/artifact gates and commit.** Run `npx jest tests/smapi_presentation_facade.test.ts tests/smapi_auth_helpers_facade.test.ts tests/smapi.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`; safe-sweep and record f4 evidence; commit `refactor(plan-f): extract smapi presentation and auth helper facades`.

### Task F.5: Extract browse/query orchestration and streaming adapter

**Files:**
- Create: `src/subsonic/orchestration.ts`
- Create: `src/subsonic/streaming.ts`
- Modify: `src/subsonic.ts:1048-1718`
- Create: `tests/subsonic_orchestration_facade.test.ts`
- Create: `tests/subsonic_streaming_facade.test.ts`
- Create: `docs/superpowers/evidence/plan-f/f5-orchestration-streaming.json`

**Interfaces:**
- `orchestration.ts` produces the browse/query operations used by `Subsonic`: artists, albums, tracks, search, genres, favourites, playlists, radio, and OpenSubsonic extensions.
- `streaming.ts` produces the existing stream operation returning `{ status: number; headers: Record<string, string>; stream: NodeJS.ReadableStream }`.
- `Subsonic` public methods and all existing import paths remain unchanged.

- [ ] **Step 1: Write red delegation/invariant tests.** Assert `Subsonic` delegates read methods to orchestration, playlist create/delete/update issue exactly one request after a transient failure, and stream preserves status/headers/body shape. Run `npx jest tests/subsonic_orchestration_facade.test.ts tests/subsonic_streaming_facade.test.ts --runInBand`. Expected: FAIL because modules/delegates are absent.

- [ ] **Step 2: Extract reads and mutations.** Move browse/query methods into an injected orchestration dependency; preserve every input/output type, keep reads on bounded retry, and keep create/delete/update non-retried.

- [ ] **Step 3: Extract stream adapter.** Move only stream request/response shaping into `streaming.ts`; preserve HEAD/range behavior, token authorization, now-playing rules, and downstream close cleanup.

- [ ] **Step 4: Run green/artifact gates and commit.** Run `npx jest tests/subsonic_orchestration_facade.test.ts tests/subsonic_streaming_facade.test.ts tests/server.test.ts -t "HEAD" tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`; safe-sweep and record f5 evidence; commit `refactor(plan-f): extract subsonic orchestration and streaming adapters`.

### Task F.6: Final proof and new field-stability cycle

**Files:**
- Create: `docs/superpowers/evidence/plan-f/closeout.json`
- Create: `tests/plan_f_closeout.test.ts`
- Create: `docs/superpowers/evidence/2026-07-23-plan-f-next-stability.md`

**Interfaces:**
- Consumes all five `ExtractionEvidence` records and the F.0 golden hash.
- Produces closeout with all slice evidence, unchanged hash, a final exact-master candidate digest, and a statement that further extraction is blocked pending a new seven-day cycle.

- [ ] **Step 1: Write the failing closeout test.** Require f1–f5 evidence, one current source SHA/digest relationship per slice, exact golden-tree hash equality, full-suite/safe-sweep zero exits, and review references. Run `npx jest tests/plan_f_closeout.test.ts --runInBand`. Expected: FAIL because closeout is absent.

- [ ] **Step 2: Produce final candidate proof.** From exact current `master`, run `npm run build`, `npx jest --runInBand`, and the Plan-C safe sweep; record the real final digest and all review references. Do not promote it in this plan.

- [ ] **Step 3: Start, but do not satisfy, the next stability requirement.** Record the final digest and a zero-day start in `2026-07-23-plan-f-next-stability.md`; state that no further extraction may start until a new seven-day same-digest evidence record passes the F.0 gate.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/plan_f_closeout.test.ts tests/plan_f_golden_tree.test.ts --runInBand && npx jest --runInBand`. Expected: PASS. Commit `docs(plan-f): close extraction evidence and require new stability cycle`.

## Exit checks

- [ ] F.0 passed before any source extraction; otherwise Plan F remains hard-blocked.
- [ ] Serialization, authentication, transport, artwork/SSRF, caching, SMAPI presentation/auth, browse/query orchestration, and streaming are separated behind backward-compatible interfaces.
- [ ] Golden corpus, raw SOAP/HTTP contracts, full suite, and safe sweep remain unchanged and green for every slice.
- [ ] No slice contains a dependency upgrade, protocol behavior change, or production promotion.
- [ ] The final digest has a new required seven-day stability cycle before further extraction.
