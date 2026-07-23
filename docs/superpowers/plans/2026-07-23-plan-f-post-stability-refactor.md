# Plan F — Post-stability behavior-preserving module extraction

**Plan:** F — Maintainability
**Program:** RicherTunes bonob private-fork convergence (spec `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, §5.4)
**Entry dependency (spec §1.1 row F, criterion 23):** the **same** production digest promoted in Plan E has completed **seven continuous days**, at least **three distinct physical Sonos sessions**, **zero rollback**, **zero open release blocker**, and **zero unattributed production error**. Until that field-stability threshold is met, Plan F is **blocked** and no extraction begins.
**Exit evidence (spec §1.1 row F, §5.4):** unchanged golden SOAP/HTTP fixtures, the full unit suite green, the safe SMAPI sweep green, candidate evidence green, and a **new field-stability cycle** begins before any further extraction.
**Scope guard (spec §5.4, §1.1):** behavior-preserving module extraction **only**. Refactoring is **never** combined with a protocol feature change or a dependency major update. Each slice changes only module boundaries; no public behavior, response byte, fault code, cache format, or URL shape may change. The extraction separates protocol serialization, authentication, browse/query orchestration, caching, upstream transport, and streaming **behind existing interfaces**.

---

## Invariants every step obeys

- **Golden contracts are immutable (spec §5.4):** every existing test — unit suite, golden SOAP/HTTP fixtures, the safe SMAPI sweep, and physical acceptance — must remain **unchanged and green** before and after each slice. A test is edited **only** if its import path moved with the extraction (same assertions, new path); assertions themselves never change.
- **No mixed concerns (spec §1.1, §5.4):** a refactor slice contains **no** dependency change, **no** protocol behavior change, and **no** live promotion. If a slice uncovers a real defect, it is **not** fixed here — it is filed as a new Plan-D evidence-gated slice, and the refactor proceeds around the existing behavior.
- **Exact-master + per-slice artifact (spec §4, criterion 8):** each slice starts from exact current `master` and produces its own build/audit/scan/smoke/candidate digest.
- **Move-then-verify TDD:** for each extraction, (1) add an import-path compatibility test that asserts the moved symbol is importable from its **new** location and re-exported from the **old** location, (2) move the symbol, (3) run the full suite (must stay green), (4) remove the temporary re-export only if no consumer depends on it (verified by grep), else keep it as the stable facade.
- **Single extraction per commit:** each slice is one module boundary; commits are atomic and reviewable in isolation.

---

## Slice F.0 — Re-confirm field-stability threshold + establish golden baseline (no code change)

Goal: gate the entire plan on the seven-day threshold and snapshot the golden contract set that must not change.

- [ ] **F.0.1 — Verify the seven-day field-stability threshold (hard gate; blocks all of Plan F).**
  - [ ] Confirm the Plan-E promoted digest has run ≥7 continuous days, ≥3 physical sessions, zero rollback, zero blocker, zero unattributed production error (spec criterion 23). Record digest + window in `docs/superpowers/evidence/2026-07-23-plan-f-field-stability.md`.
  - Gate:
    ```bash
    grep -E 'sha256:|seven continuous days' docs/superpowers/evidence/2026-07-23-plan-f-field-stability.md
    ```
    Expected: both present (exit `0`). If absent, **stop**: Plan F is blocked.
  - Atomic commit: `git commit -m "docs(plan-f): confirm seven-day field-stability threshold (criterion 23)"`.

- [ ] **F.0.2 — Snapshot the golden contract set (must stay byte-identical across Plan F).**
  - [ ] Record hashes of all SOAP/HTTP fixtures and the full unit-test expected outputs (where deterministic) into `docs/superpowers/evidence/2026-07-23-plan-f-golden-baseline.json`.
  - [ ] Add `tests/golden_baseline.test.ts` that asserts current fixture/test-output hashes equal the baseline. Failing until the baseline file matches current state:
    ```bash
    npx jest tests/golden_baseline.test.ts
    ```
    Expected before: fails (baseline must be generated to match). Expected after generation: `PASS`.
  - Atomic commit: `git commit -m "test(plan-f): snapshot immutable golden contract baseline"`.

---

## Slice F.1 — Extract `subsonic` protocol serialization (`src/subsonic/serialization.ts`)

Seam (verified exports to move, behavior unchanged): the pure Subsonic↔domain mappers and response/error types currently in `src/subsonic.ts`:
- types: `GetGenresResponse` (line 271), `images` (284), `song` (311), `GetAlbumResponse` (335), `GetPlaylistResponse` (341), `GetPlaylistsResponse` (353), `GetSimilarSongsResponse` (371), `GetTopSongsResponse` (375), `GetInternetRadioStationsResponse` (379), `GetSongResponse` (390), `GetStarredResponse` (394), `PingResponse` (401), `Search3Response` (408), `OpenSubsonicExtension` (416), `IdName` (431).
- mappers: `isError` (425), `coverArtURN` (436), `artistImageURN` (444), `asTrackSummary` (482), `asTrack` (517), `asAlbumSummary` (526), `asGenre` (536), `maybeAsGenre` (541), `asYear` (551).

- [ ] **F.1.1 — Add a failing import-path test.**
  - [ ] Write `tests/subsonic_serialization_imports.test.ts` asserting each moved symbol is importable from `./src/subsonic/serialization` **and** still re-exported from `./src/subsonic` (facade).
  - Failing test (new path does not exist yet):
    ```bash
    npx jest tests/subsonic_serialization_imports.test.ts
    ```
    Expected before: `FAIL … Cannot find module './src/subsonic/serialization'`.
  - Atomic commit: `git commit -m "test(plan-f): assert subsonic serialization import paths"`.

- [ ] **F.1.2 — Move the symbols; keep a re-export facade.**
  - [ ] Create `src/subsonic/serialization.ts`, move the listed types/mappers verbatim (no logic change), preserving exact names and signatures.
  - [ ] In `src/subsonic.ts`, replace the moved definitions with `export * from "./subsonic/serialization";` (or named re-exports) so every existing consumer import is unchanged.
  - Gate:
    ```bash
    npx jest tests/subsonic_serialization_imports.test.ts && npx jest
    ```
    Expected: import-path test `PASS` and full suite green; golden baseline (F.0.2) unchanged.
  - Atomic commit: `git commit -m "refactor(plan-f): extract subsonic serialization behind facade"`.

- [ ] **F.1.3 — Full suite + safe sweep + candidate evidence + exact-master artifact.**
  - [ ] Run `npx jest`, the Plan-C safe SMAPI sweep (read-only, disposable candidate), and produce a fresh exact-`master` build/audit/scan/smoke/candidate digest. Golden contracts unchanged.
  - Atomic commit: `git commit -m "test(plan-f): F.1 full suite + safe sweep + exact-master artifact"`.

---

## Slice F.2 — Extract Subsonic authentication + token handling (`src/subsonic/auth.ts`)

Seam (verified exports to move): `t` (line 57), `t_and_s` (60), `asToken` (1026), `parseToken` (1029), plus the `Credentials`/`LoginToken` types they depend on (note: `Credentials`/`LoginToken` are also referenced by `smapi.ts`; move to a shared `src/credentials.ts` only if both files need them — otherwise keep in `subsonic.ts` and re-export from `auth.ts`).

- [ ] **F.2.1 — Add a failing import-path test** (mirrors F.1.1 for `./src/subsonic/auth`). Failing first:
    ```bash
    npx jest tests/subsonic_auth_imports.test.ts
    ```
    Expected before: `FAIL` (module missing). Atomic commit: `git commit -m "test(plan-f): assert subsonic auth import paths"`.

- [ ] **F.2.2 — Move the symbols; keep facade re-export** (mirrors F.1.2; no logic change). Gate:
    ```bash
    npx jest tests/subsonic_auth_imports.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, golden baseline unchanged. Atomic commit: `git commit -m "refactor(plan-f): extract subsonic auth behind facade"`.

- [ ] **F.2.3 — Full suite + safe sweep + candidate evidence + exact-master artifact** (mirrors F.1.3). Atomic commit accordingly.

---

## Slice F.3 — Extract upstream transport + retry policy (`src/subsonic/transport.ts`)

Seam (verified exports to move): `BROWSER_HEADERS` (41), `SUBSONIC_HTTP_TIMEOUT_MS` (49), the axios default-timeout setup (51-55), `isRetryableSubsonicError` (210), `asURLSearchParams` (603), `USER_AGENT` (601), `DEFAULT_CLIENT_APPLICATION` (600), `ClientInfo` (641), `SONOS_CLIENT_INFO` (677), and the `Subsonic` class's private `get`/`post`/`getJSON`/`getJSONWithRetry`/`postJSON` HTTP primitives (refactored to call a transport module function — **no behavior change**; retry stays bounded to reads, never mutations/4xx, per spec §9).

- [ ] **F.3.1 — Add a failing import-path + retry-invariant test.**
  - [ ] Assert `isRetryableSubsonicError`, `SUBSONIC_HTTP_TIMEOUT_MS`, `USER_AGENT` importable from `./src/subsonic/transport` and re-exported from `./src/subsonic`.
  - [ ] Add `tests/subsonic_transport_invariant.test.ts` asserting the retry policy is unchanged: a real Axios 4xx rejection is **not** retryable; a network error (no response) is retryable; a 5xx is retryable; a Subsonic app-level error (valid response, `isError`) is **not** retryable (spec §9).
  - Failing first:
    ```bash
    npx jest tests/subsonic_transport_imports.test.ts tests/subsonic_transport_invariant.test.ts
    ```
    Expected before: import test `FAIL` (module missing).
  - Atomic commit: `git commit -m "test(plan-f): assert subsonic transport import paths + retry invariant"`.

- [ ] **F.3.2 — Move the symbols; redirect the `Subsonic` class HTTP primitives to the transport module; keep facade.** No retry-rule change. Gate:
    ```bash
    npx jest tests/subsonic_transport_imports.test.ts tests/subsonic_transport_invariant.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, golden baseline unchanged. Atomic commit: `git commit -m "refactor(plan-f): extract subsonic transport behind facade"`.

- [ ] **F.3.3 — Full suite + safe sweep + candidate evidence + exact-master artifact.** Atomic commit accordingly.

---

## Slice F.4 — Extract external image fetching + SSRF safety (`src/subsonic/image_fetch.ts`)

Seam (verified exports to move): `ImageFetcher` (828), `cachingImageFetcher` (830), `pinnedSafeExternalLookup` (886), `resolvedExternalHostIsSafe` (913), `axiosImageFetcher` (927), `deezerImageFetcher` (936), `isSafeExternalImageUrl` (191), `isValidImage` (204), `DODGY_IMAGE_NAME` (70). This isolates the SSRF-hardened fetch path behind its own module; **no** allowlist/redirect/lookup behavior may change.

- [ ] **F.4.1 — Add a failing import-path + SSRF-invariant test.**
  - [ ] Assert importability from `./src/subsonic/image_fetch` + facade re-export.
  - [ ] Add `tests/subsonic_image_fetch_invariant.test.ts` asserting `isSafeExternalImageUrl` still rejects private/loopback/link-local IPs and non-https where required (mirror existing assertions; do not weaken).
  - Failing first:
    ```bash
    npx jest tests/subsonic_image_fetch_imports.test.ts
    ```
    Expected before: `FAIL`. Atomic commit: `git commit -m "test(plan-f): assert image_fetch import paths + SSRF invariant"`.

- [ ] **F.4.2 — Move the symbols; keep facade.** No SSRF/redirect change. Gate:
    ```bash
    npx jest tests/subsonic_image_fetch_imports.test.ts tests/subsonic_image_fetch_invariant.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, golden baseline unchanged. Atomic commit: `git commit -m "refactor(plan-f): extract image fetch + SSRF safety behind facade"`.

- [ ] **F.4.3 — Full suite + safe sweep + candidate evidence + exact-master artifact.** Atomic commit accordingly.

---

## Slice F.5 — Extract SMAPI presentation mappers + auth-token helpers (`src/smapi/presentation.ts`, `src/smapi/auth_helpers.ts`)

Seam (verified exports to move from `src/smapi.ts`): presentation mappers — `ratingAsInt` (112), `ratingFromInt` (115), `MediaCollection` (120), `getMetadataResult` type (126) + function (160), `SearchResponse` (182) + `searchResult` (186), `ContainerType` (293), `Container` (295), `shouldScrobble` (327), `coverArtURI` (352), `iconArtURI` (367), `sonosifyMimeType` (372), `album` (387), `internetRadioStation` (401), `track` (408), `topSongMetadata` (434), `artist` (457), `splitId` (465), `withSplitId` (475); auth helpers — `SoapyHeaders` (482), `findLoginToken` (504). (Keep `bindSmapiSoapServiceToExpress` as the orchestrating default export in `smapi.ts`; it composes these.)

- [ ] **F.5.1 — Add failing import-path tests** for `./src/smapi/presentation` and `./src/smapi/auth_helpers`, both re-exported from `./src/smapi`. Failing first:
    ```bash
    npx jest tests/smapi_presentation_imports.test.ts tests/smapi_auth_helpers_imports.test.ts
    ```
    Expected before: `FAIL`. Atomic commit: `git commit -m "test(plan-f): assert smapi presentation/auth_helpers import paths"`.

- [ ] **F.5.2 — Move the symbols into the two modules; keep facade re-export from `smapi.ts`.** The SOAP binding orchestrator continues to import them. Gate:
    ```bash
    npx jest tests/smapi_presentation_imports.test.ts tests/smapi_auth_helpers_imports.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, golden baseline (incl. raw SOAP fault fixtures from Plan D) unchanged. Atomic commit: `git commit -m "refactor(plan-f): extract smapi presentation + auth_helpers behind facade"`.

- [ ] **F.5.3 — Full suite + safe sweep + candidate evidence + exact-master artifact.** Atomic commit accordingly.

---

## Slice F.6 — Extract browse/query orchestration (`src/subsonic/orchestration.ts`)

Seam: the `Subsonic` class methods that orchestrate browse/query calls (`fetchArtists`, `getAlbumList2`, `getArtistInfo2`, `getAlbum`, `getArtist`, `getSong`, `getStarred` albums/songs, `search3`, genres, years, similar/top songs, internet radio, OpenSubsonic extensions — verified call sites at `src/subsonic.ts:1194-1760`), plus the playlist CRUD methods (`createPlayList`, `deletePlayList`, `updatePlaylist`, `getPlaylists`, `getPlaylist`) and `stream`. These move into an orchestration module that the `Subsonic` class delegates to. **Behavior unchanged**: playlist mutations stay on non-retried `getJSON`; reads stay on `getJSONWithRetry`; `stream` stays a stream-response GET.

- [ ] **F.6.1 — Add failing import-path + orchestration-invariant tests.**
  - [ ] Assert the orchestration module exports the moved methods and the `Subsonic` class delegates to them.
  - [ ] Add `tests/subsonic_orchestration_invariant.test.ts` re-asserting: `createPlayList`/`deletePlayList`/`updatePlaylist` invoke the transport primitive **exactly once** (no retry) on a transient error; `getArtists`/reads may retry once; `stream` returns the same `{status, headers, stream}` shape.
  - Failing first:
    ```bash
    npx jest tests/subsonic_orchestration_imports.test.ts
    ```
    Expected before: `FAIL`. Atomic commit: `git commit -m "test(plan-f): assert orchestration import paths + invariants"`.

- [ ] **F.6.2 — Move orchestration; delegate from `Subsonic`; keep behavior.** Gate:
    ```bash
    npx jest tests/subsonic_orchestration_imports.test.ts tests/subsonic_orchestration_invariant.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, golden baseline unchanged. Atomic commit: `git commit -m "refactor(plan-f): extract subsonic browse/query/stream orchestration"`.

- [ ] **F.6.3 — Full suite + safe sweep + candidate evidence + exact-master artifact.** Atomic commit accordingly.

---

## Slice F.7 — Final consolidation, de-duplication audit, and new field-stability cycle

- [ ] **F.7.1 — Facade de-duplication audit.**
  - [ ] For each temporary re-export facade, grep consumers: if no consumer imports from the old path, the facade may be removed; otherwise it stays as the stable public surface. Do **not** force-remove a facade and break a consumer.
  - Gate:
    ```bash
    rg -n "from \"\.\./src/subsonic\"|from \"\.\./src/smapi\"" tests/ src/
    ```
    Expected: every remaining old-path import is intentional (facade kept) or migrated.
  - Atomic commit: `git commit -m "refactor(plan-f): facade de-duplication audit"`.

- [ ] **F.7.2 — Final golden-contract equality proof.**
  - [ ] Re-run `tests/golden_baseline.test.ts` (F.0.2): every hash must still equal the F.0.2 baseline. Any drift is a release blocker (behavior changed during a "behavior-preserving" plan).
  - Gate:
    ```bash
    npx jest tests/golden_baseline.test.ts && npx jest
    ```
    Expected: `PASS`, full suite green, baseline identical.
  - Atomic commit: `git commit -m "test(plan-f): final golden-contract equality proof"`.

- [ ] **F.7.3 — Start a new field-stability cycle before further extraction.**
  - [ ] Record that the post-Plan-F digest must complete a fresh seven-day field-stability cycle (criterion 23) before any **further** extraction is permitted (spec §5.4: "a new field-stability cycle before further extraction").
  - Atomic commit: `git commit -m "docs(plan-f): require new seven-day field-stability cycle before further extraction"`.

---

## Plan F exit checklist (spec §1.1 row F, §5.4)

- [ ] Seven-day field-stability threshold met before any extraction (criterion 23).
- [ ] Golden SOAP/HTTP fixtures and full unit suite unchanged and green across every slice.
- [ ] Safe SMAPI sweep green on the disposable candidate for each slice.
- [ ] Each slice produced its own exact-`master` artifact/digest (criterion 8).
- [ ] Protocol serialization, authentication, transport/retry, image fetch/SSRF, SMAPI presentation, and browse/query/stream orchestration are separated behind existing interfaces.
- [ ] No slice mixed a refactor with a dependency change, protocol behavior change, or live promotion.
- [ ] A new field-stability cycle is required before further extraction.

## Adversarial-review focus for Plan F (report to Codex)

- Any slice that changes a public behavior, response byte, fault code, cache format, or URL shape (§5.4 violation) — caught by F.0.2/F.7.2 golden drift.
- Any slice that bundles a dependency bump or protocol fix (§1.1 violation).
- Any retry-policy drift in F.3/F.6 (mutation retried, 4xx retried) — caught by the invariant tests.
- Any SSRF allowlist weakening in F.4 — caught by the SSRF-invariant test.
- Any facade removal that breaks a consumer (F.7.1).
- Any extraction begun before the seven-day threshold (F.0.1 hard gate).
- Any slice that reuses an earlier-SHA artifact/digest (criterion 8).