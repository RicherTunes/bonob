# Plan D — Protocol correctness

**Plan:** D — Protocol correctness
**Program:** RicherTunes bonob private-fork convergence (spec `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, §5.3)
**Entry dependency:** Plan C complete (app factory + lifecycle coordinator + shared cancellation + registries + graceful shutdown + attribution/redaction + lifecycle soak). See spec §1.1 row "D".
**Exit evidence (spec §1.1, criterion 17):** every code slice produces a new exact-`master` build/audit/scan/smoke/candidate digest; per-fix red/green tests, raw protocol evidence, candidate sweep, and adversarial review pass; **no production promotion** in this plan.
**Scope guard (spec §1.1, §5.3):** evidence-gated protocol fixes only. No dependency change, no module refactor, no live promotion is bundled into any step here. Mutations are never automatically retried. A change is allowed **only** after a fixture or reproduction proves the defect is at the Bonob boundary; otherwise the finding becomes a Navidrome/deployment diagnostic.

---

## Invariants every step obeys

- **Exact-master slice:** each code step starts from the current RicherTunes `master` (verified `git rev-parse HEAD` before and after). Evidence from an earlier SHA never promotes a later one (spec §4, criterion 8).
- **Candidate-only mutation:** the only state a test may mutate is a disposable candidate playlist/account/cache created with the `bonob-smoke-` prefix (spec §6, §7.1). No candidate test mutates a production account, playlist, favourite, database, cache, or media.
- **Raw fixtures lock behavior:** SOAP claims are locked by raw XML/byte fixtures, not object deserialization (spec §5.3 #214, criterion 17).
- **Redaction gate:** every public file change passes the full-file + diff redaction/secret scan recorded in Plan A (spec §2.4, criterion 24).
- **Mutation safety (spec §9, §5.3):** `createPlaylist`, `deletePlaylist`, `addToContainer`, `removeFromContainer`, `createContainer` are never routed through `getJSONWithRetry`. Any step that touches retry asserts this invariant.

---

## Slice D.0 — Candidate evidence scaffold (no production code change)

Goal: establish the fixture + evidence + per-slice exact-master artifact pipeline so every later slice reuses it identically. This step changes only tests/tooling and a fixture, never runtime code.

- [ ] **D.0.1 — Create the candidate fixture directory and provenance manifest.**
  - [ ] `mkdir -p tests/fixtures/protocol` and add `tests/fixtures/protocol/PROVENANCE.md`.
  - [ ] In `PROVENANCE.md`, record for each referenced Sonos doc: the exact official URL, documentation version (e.g. `v1.0`), SHA-256 of the captured HTTPS body, and the capture time in UTC. Initial entries: the [Add playlists](https://docs.sonos.com/docs/add-playlists) reference used by D.1.
  - Failing check (proves the manifest is loadable and not empty):
    ```bash
    test -s tests/fixtures/protocol/PROVENANCE.md && grep -q "add-playlists" tests/fixtures/protocol/PROVENANCE.md
    ```
    Expected before: exit `1` (no file). Expected after: exit `0`.
  - Atomic commit: `git commit -m "docs(plan-d): add protocol fixture provenance scaffold"`.

- [ ] **D.0.2 — Add a fixture-hash test that fails when a fixture is missing or altered.**
  - [ ] Write `tests/fixtures/protocol_hash.test.ts` that reads each fixture file under `tests/fixtures/protocol/`, computes its SHA-256, and asserts it equals the hash recorded in `PROVENANCE.md`.
  - Failing test first (no fixture body yet → no hash entry → test fails on missing entry):
    ```bash
    npx jest tests/fixtures/protocol_hash.test.ts
    ```
    Expected before adding the referenced fixture: `FAIL … expected … to equal <hash>`.
  - Atomic commit: `git commit -m "test(plan-d): lock protocol fixture hashes"`.

- [ ] **D.0.3 — Produce the first exact-master artifact set for this slice (no runtime code).**
  - From the validated exact `master`, run the Plan-B build/test/scan/smoke pipeline unchanged and record the immutable digest + run/artifact IDs. (This reuses Plan B's two-job supply boundary; Plan D does not redefine it.)
  - Gate: the build/audit/scan must report zero high/critical findings (spec §3.3, criterion 5–6). A finding fails the slice.
  - Atomic commit (evidence pointer only, no secret/topology): `git commit -m "docs(plan-d): record D.0 exact-master artifact evidence"`.

**Definition of done for D.0:** scaffold exists, fixture-hash test is green, and the slice has its own exact-master artifact set. No runtime behavior changed.

---

## Slice D.1 — Issue #297: playlist `readOnly`/`userContent` correctness

Spec §5.3 #297: the root collection has `id="playlists"`, `itemType="playlist"`, `readOnly="false"`, `userContent="true"`; each individual editable playlist has `itemType="playlist"`, `readOnly="false"`, `userContent="false"`. (Note: the Sonos root container's *itemType* is what tells Sonos it is an editable playlist container; the per-item `userContent=false` means Sonos should not show "add to this playlist" UI inside an individual playlist.)

Current code (verified):
- `src/smapi.ts:938-946` — root `playlists` collection emits `itemType: "collection"` with `attributes.userContent: true`. **Missing `readOnly: false` and wrong `itemType`.**
- `src/smapi.ts:341-350` — `playlist(...)` emits `itemType: "playlist"`, `canPlay: true`, `attributes.userContent: true`. **Per-item `userContent` should be `false`; `readOnly` missing.**

- [ ] **D.1.1 — Capture and lock the raw Add-playlists contract fixture.**
  - [ ] Re-fetch the official Sonos doc per spec §5.3 #297: record URL, version `v1.0`, content SHA-256, and re-fetch comparison time in `tests/fixtures/protocol/PROVENANCE.md`. A mismatch from the recorded baseline (`256125a2672051417c675ea471b22215bebb16031f6e35710e63b2090e016997` captured `2026-07-23T19:36:00Z`) requires contract re-review and stops the slice.
  - [ ] Add `tests/fixtures/protocol/add-playlists-v1.0.xml` containing the raw SOAP attributes to assert (root + per-item). Add its hash to the manifest so D.0.2 covers it.
  - Gate command:
    ```bash
    npx jest tests/fixtures/protocol_hash.test.ts
    ```
    Expected: `PASS`. A hash mismatch fails the slice before any code change.
  - Atomic commit: `git commit -m "test(plan-d): capture add-playlists v1.0 raw SOAP fixture (#297)"`.

- [ ] **D.1.2 — Write a failing test asserting the corrected attributes.**
  - [ ] In `tests/smapi.test.ts`, extend the root-metadata assertion block (currently around lines 1296-1304 and 1401-1409) to assert, for the `id:"playlists"` root collection: `itemType === "playlist"`, `readOnly === false`, `attributes.userContent === true`.
  - [ ] Add a new `describe("playlist editing attributes (#297)")` block that fetches an individual playlist via `getMetadata` for id `playlists` and asserts each emitted `mediaCollection` item has `itemType === "playlist"`, `readOnly === false`, and `attributes.userContent === false`.
  - Failing test (current code emits `itemType:"collection"` and per-item `userContent:true`):
    ```bash
    npx jest tests/smapi.test.ts -t "#297"
    ```
    Expected before fix: `FAIL … Expected: "playlist"  Received: "collection"` (and the per-item `userContent` assertion fails).
  - Atomic commit: `git commit -m "test(plan-d): assert corrected playlist readOnly/userContent (#297)"`.

- [ ] **D.1.3 — Apply the minimal code change.**
  - [ ] `src/smapi.ts:938-946` root playlists collection: set `itemType: "collection"` → keep the container shape but add `readOnly: false` and add `itemType` per the raw fixture. (Follow exactly what the locked fixture asserts in D.1.2; do not infer.) Concretely change the object to include `readOnly: false` and `itemType: "playlist"` at the root if the fixture locks that; otherwise set the root `itemType` to whatever the fixture encodes. The fixture is authoritative.
  - [ ] `src/smapi.ts:341-350` `playlist(...)`: set `attributes.userContent` from `true` → `false` and add `readOnly: false`.
  - Verification command (the previously-failing test now passes):
    ```bash
    npx jest tests/smapi.test.ts -t "#297"
    ```
    Expected after: `PASS`.
  - Run the full suite to confirm no regression:
    ```bash
    npx jest
    ```
    Expected: all green.
  - Atomic commit: `git commit -m "fix(plan-d): correct playlist readOnly/userContent per Sonos add-playlists (#297)"`.

- [ ] **D.1.4 — Candidate-only disposable mutation evidence (spec §5.3 #297, criterion 17).**
  - [ ] Run the Plan-C safe harness in mutation mode against the disposable candidate only: create a `bonob-smoke-` playlist, add a track, remove it, delete the playlist. Assert the created/removed state and that cleanup deletes the disposable playlist even on failure. No production account/playlist/cache is touched.
  - [ ] Record candidate sentinel evidence (all expected sentinels in candidate logs; zero in production for the same interval) per spec §6.
  - Atomic commit (evidence pointer): `git commit -m "test(plan-d): candidate disposable playlist add/remove evidence (#297)"`.

- [ ] **D.1.5 — New exact-master artifact set + adversarial review for this slice.**
  - [ ] From the exact new `master`, produce a fresh build/audit/scan/smoke/candidate digest (criterion 8). Evidence from the D.0 SHA cannot be reused.
  - [ ] Adversarial review (spec §9, criterion 25): confirm no `readOnly`/`userContent` claim exceeds what the raw fixture locks; confirm zero production mutation; confirm mutation handlers are not retried.
  - Atomic commit: `git commit -m "docs(plan-d): D.1 exact-master artifact + adversarial review (#297)"`.

---

## Slice D.2 — Issue #284: separate-file (`cover.jpg`) artwork

Spec §5.3 #284: **do not infer a Bonob defect**. First add a fixture matching Navidrome's response for external `cover.jpg` and reproduce the complete `/art` request, content type, body, and cache behavior. A code change is allowed **only if the fixture fails at the Bonob boundary**; otherwise the finding becomes a Navidrome/deployment diagnostic.

Current `/art` boundary (verified): `src/server.ts:653-729` resolves the `BUrn`, validates external URL safety (`isSafeExternalImageUrl`), fetches via `externalImageResolver`/`deezerImageResolver`/`musicLibrary.coverArt`, and only serves genuine `image/*` content (else 502). `coverArt` is `undefined` → 404.

- [ ] **D.2.1 — Add a Navidrome-style `cover.jpg` fixture and reproduce the full `/art` request.**
  - [ ] Add `tests/fixtures/protocol/navidrome-cover.jpg` (a small valid JPEG) plus a captured Subsonic `getCoverArt`-style response fixture describing how Navidrome exposes a per-folder `cover.jpg`.
  - [ ] Write `tests/server.test.ts` block `describe("separate-file artwork (#284)")` that: builds the `BUrn` for a subsonic cover id resolving to the folder `cover.jpg`; calls `GET /art/<burn>/size/:size` with a valid scoped `art` token; asserts status `200`, a real `image/jpeg` content type, the expected body bytes, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, max-age=86400`.
  - Failing test first (no assertion of byte content yet / fixture not wired):
    ```bash
    npx jest tests/server.test.ts -t "#284"
    ```
    Expected before: fails on the missing fixture or the unasserted body.
  - Atomic commit: `git commit -m "test(plan-d): reproduce separate-file cover.jpg /art request (#284)"`.

- [ ] **D.2.2 — Triage at the boundary; change code only if the fixture fails at Bonob.**
  - [ ] Run D.2.1. If it passes at the Bonob boundary (status 200, real image bytes), record this as a **Navidrome/deployment diagnostic** (no runtime change) and close #284 as not-a-Bonob-bug with the fixture as evidence.
  - [ ] Only if it fails at the boundary (e.g. 404/502/wrong content type for a valid `cover.jpg`): add the minimal fix in `src/server.ts` coverArt resolution or in `src/subsonic.ts` coverArtURN handling, gated by a new assertion in D.2.1.
  - Gate (whichever branch):
    ```bash
    npx jest tests/server.test.ts -t "#284"
    ```
    Expected: `PASS`.
  - Atomic commit (diagnostic): `git commit -m "docs(plan-d): #284 diagnosed as Navidrome/deployment (no Bonob change)"` **or** (fix): `git commit -m "fix(plan-d): resolve separate-file cover.jpg at /art boundary (#284)"`.

- [ ] **D.2.3 — New exact-master artifact set + adversarial review.** (As D.1.5, scoped to artwork.) Atomic commit accordingly.

---

## Slice D.3 — Issue #229: stream `HEAD` (preserve, do not reimplement)

Spec §5.3 #229: the current code already handles `HEAD` without sending a body or reporting now-playing. **Preserve it with regression tests; do not reimplement.**

Current behavior (verified): `src/server.ts:448-575` keys body/now-playing off `req.method == "GET"` (lines 548-549, 563-564, 571-572), so `HEAD` returns status + headers with an empty body. `res.on('close')` destroys the upstream stream (line 487-489). Existing HEAD tests live at `tests/server.test.ts:935-997` (401 paths + 200 path).

- [ ] **D.3.1 — Add regression tests covering auth, status, content headers, and range behavior for HEAD.**
  - [ ] Extend `describe("HEAD requests")` in `tests/server.test.ts` with: (a) HEAD on a 206 range result asserting `content-range`/`content-length` headers present and **empty body**; (b) HEAD asserting `nowPlaying` is **not** called for HEAD (spy on `musicLibrary.nowPlaying` and assert `not.toHaveBeenCalled()`); (c) HEAD asserting the upstream `stream` is destroyed on `close`.
  - Failing test first (the range + not-called assertions are new):
    ```bash
    npx jest tests/server.test.ts -t "HEAD"
    ```
    Expected before: the new range/not-called cases fail until added; existing 401/200 cases already pass.
  - Atomic commit: `git commit -m "test(plan-d): regress stream HEAD auth/status/range/now-playing (#229)"`.

- [ ] **D.3.2 — No code change; lock behavior.** If all D.3.1 tests pass against unchanged code, record that #229 required **no runtime change** (spec: "do not reimplement it"). Only if a D.3.1 case reveals a real defect is a minimal fix permitted, gated by that case.
  - Gate:
    ```bash
    npx jest tests/server.test.ts -t "HEAD"
    ```
    Expected: `PASS`.
  - Atomic commit (lock): `git commit -m "test(plan-d): lock stream HEAD behavior, no reimplement (#229)"`.

- [ ] **D.3.3 — New exact-master artifact set + adversarial review.** Atomic commit accordingly.

---

## Slice D.4 — Issue #214: SOAP fault raw bytes and content type

Spec §5.3 #214: assert the **raw HTTP response bytes and content type** for representative faults; object-level deserialization is insufficient because it can hide SOAP 1.1 vs 1.2 envelope differences. Any change must retain Sonos fault codes and pass both raw fixtures and physical S2 tests.

Current faults (verified): `src/smapi_auth.ts:33-88` define `Client.LoginUnauthorized`, `Client.LoginUnsupported`, `Client.TokenRefreshRequired`. The WSDL (`src/Sonoswsdl-1.19.6-20231024.wsdl:18-22`) binds SOAP 1.1 (`xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"`, `targetNamespace http://www.sonos.com/Services/1.1`).

- [ ] **D.4.1 — Add raw fault fixtures (bytes + content type).**
  - [ ] Add raw captured responses under `tests/fixtures/protocol/faults/`: `loginUnauthorized.xml`, `loginUnsupported.xml`, `tokenRefreshRequired.xml`. Each fixture encodes the envelope, the exact faultcode/faultstring, and the expected `Content-Type` header value as a leading comment/metadata file.
  - [ ] Add hashes to the manifest so D.0.2 covers them.
  - Gate:
    ```bash
    npx jest tests/fixtures/protocol_hash.test.ts
    ```
    Expected: `PASS`.
  - Atomic commit: `git commit -m "test(plan-d): capture raw SOAP fault fixtures (#214)"`.

- [ ] **D.4.2 — Write a failing test asserting raw bytes + content type.**
  - [ ] In `tests/smapi.test.ts` add `describe("SOAP fault raw bytes (#214)")` that, for each fault, issues the failing SOAP call through the `soap` client + `supersoap` in-process transport and asserts: the raw response `Content-Type` equals the fixture's expected value; the raw body, parsed as XML, contains the exact `<faultcode>` (e.g. `Client.LoginUnauthorized`) and `<faultstring>`; and the envelope namespace matches the WSDL's SOAP 1.1 binding.
  - Failing test first (raw-content-type + namespace assertions are new):
    ```bash
    npx jest tests/smapi.test.ts -t "#214"
    ```
    Expected before: fails on the new raw assertions.
  - Atomic commit: `git commit -m "test(plan-d): assert raw SOAP fault bytes and content type (#214)"`.

- [ ] **D.4.3 — Apply minimal change only if a raw assertion fails; retain fault codes.**
  - [ ] If D.4.2 passes against unchanged code, record #214 as confirmed-correct with raw evidence (no runtime change). If a raw assertion fails (e.g. wrong content type / wrong envelope namespace), apply the minimal fix in the SOAP binding/fault emission path **without** altering any Sonos fault code or faultstring. Re-run D.4.2.
  - Gate:
    ```bash
    npx jest tests/smapi.test.ts -t "#214"
    ```
    Expected: `PASS`.
  - Atomic commit (evidence): `git commit -m "test(plan-d): confirm raw SOAP fault contract (#214)"` **or** (fix) `git commit -m "fix(plan-d): correct SOAP fault raw content type/envelope (#214)"`.

- [ ] **D.4.4 — New exact-master artifact set + adversarial review.** Atomic commit accordingly. (Note: physical S2 confirmation of faults is part of Plan E, not here.)

---

## Slice D.5 — Issues #246, #254, #255: deployment/connectivity (documentation + diagnostics first)

Spec §5.3 #246/#254/#255: treat these **first as documentation and diagnostics**. The S2 guide must distinguish public HTTPS ingress, Developer Portal registration, proxy/rate-limit behavior, advertised vs reachable URLs, and IPv4/IPv6 reachability. **No speculative network workaround enters runtime code without a reproduction.**

Current S2 guide (verified): `docs/sonos-s2-setup.md` covers prerequisites (HTTPS/443), Developer Portal integration fields, image-replacement rules, search, and deployment. It does **not** explicitly separate ingress vs registration vs proxy/rate-limit vs advertised-vs-reachable vs IPv4/IPv6.

- [ ] **D.5.1 — Add a failing doc-structure check.**
  - [ ] Add `tests/docs_s2_structure.test.ts` that asserts `docs/sonos-s2-setup.md` contains dedicated sections whose headings match exactly: `## Public HTTPS ingress`, `## Developer Portal registration`, `## Proxy and rate-limit behavior`, `## Advertised versus reachable URLs`, and `## IPv4/IPv6 reachability`.
  - Failing test (sections absent):
    ```bash
    npx jest tests/docs_s2_structure.test.ts
    ```
    Expected before: `FAIL` on missing headings.
  - Atomic commit: `git commit -m "test(plan-d): assert S2 guide diagnostic section structure (#246/#254/#255)"`.

- [ ] **D.5.2 — Add the diagnostic sections to `docs/sonos-s2-setup.md`.**
  - [ ] Add the five sections. Each must be **diagnostic only**: describe how to verify each concern, what to capture, and where (root-readable operator inventory) topology-specific values belong. No runtime workaround is described without a reproduction.
  - Gate:
    ```bash
    npx jest tests/docs_s2_structure.test.ts
    ```
    Expected: `PASS`.
  - Redaction gate (spec §2.4): full-file + diff scan must pass with zero topology identifiers; record content/diff/policy/baseline hashes.
  - Atomic commit: `git commit -m "docs(plan-d): S2 connectivity diagnostics for ingress/registration/proxy/URLs/IPv6 (#246/#254/#255)"`.

- [ ] **D.5.3 — Reproduction gate before any runtime change.**
  - [ ] If and only if a reproduction (raw request/response fixture demonstrating a Bonob-side defect) is produced, open a **separate** evidence-gated slice. Otherwise #246/#254/#255 remain documentation/diagnostics and no runtime code changes in Plan D.
  - Atomic commit (if reproduced): a new slice following the D.1 pattern (fixture → failing test → minimal fix → candidate evidence → exact-master artifact + adversarial review).

- [ ] **D.5.4 — New exact-master artifact set + adversarial review.** Atomic commit accordingly.

---

## Slice D.6 — Issue #164: suspected TCP/memory leak

Spec §5.3 #164: use **Plan C's lifecycle soak** to establish a repeatable baseline before changing lifecycle code. A fix requires before/after results against **every** defined soak threshold.

Soak thresholds (spec §5.2): ≥2h, ≥1,000 mixed open/play/range/seek/stop/disconnect cycles; RSS/handles/sockets sampled every 10s; warm baseline = median of final 5 min of 30-min warmup; final load = median of final 5 min of 2h load; post-cooldown = median of final 2 min of 5-min cooldown; final-load RSS growth ≤ 64 MiB over warm baseline; post-cooldown handles/sockets within 10% of warm baseline (≤2 absolute when baseline is 0, each explained); ≥99.5% success; zero incorrect status/content-type/content-length-range/body-hash; zero unhandled rejection/crash/cache corruption.

- [ ] **D.6.1 — Capture the pre-change baseline from the Plan-C soak harness.**
  - [ ] Run the Plan-C automated soak against the exact `master` candidate and record the full threshold matrix (RSS/handles/sockets medians, success %, latency p95/p99, zero-error result).
  - [ ] Write the captured numbers into `tests/fixtures/protocol/soak-baseline-D6.json` with the producing commit + digest. Add its hash to the manifest.
  - Gate:
    ```bash
    npx jest tests/fixtures/protocol_hash.test.ts
    ```
    Expected: `PASS`.
  - Atomic commit (evidence pointer): `git commit -m "docs(plan-d): capture Plan-C soak baseline for #164"`.

- [ ] **D.6.2 — Write a failing comparison test that will only pass with improved results.**
  - [ ] Write `tests/soak_regression.test.ts` that loads `soak-baseline-D6.json` and the latest run JSON, and asserts the latest run is **no worse** on every threshold (RSS growth ≤ baseline, handles/sockets within tolerance, success ≥ 99.5%, zero errors).
  - Failing until a post-change run exists and improves/maintains:
    ```bash
    npx jest tests/soak_regression.test.ts
    ```
    Expected before any lifecycle change: fails (no post-change run).
  - Atomic commit: `git commit -m "test(plan-d): soak before/after threshold comparison (#164)"`.

- [ ] **D.6.3 — Only if the baseline shows a real regression: apply a minimal lifecycle fix gated by the registries from Plan C.**
  - [ ] If the baseline is clean (within all thresholds), record #164 as not-reproduced and make **no** lifecycle change.
  - [ ] If a leak is reproduced, apply the smallest fix using Plan C's cancellation/registry seams (drain registries, destroy sockets/streams on close) — never a speculative change. Re-run the soak; D.6.2 must pass with improved numbers.
  - Gate:
    ```bash
    npx jest tests/soak_regression.test.ts
    ```
    Expected: `PASS` with no threshold worse than baseline.
  - Atomic commit (if fixed): `git commit -m "fix(plan-d): close leaked sockets/streams via lifecycle registries (#164)"` **or** (not reproduced): `git commit -m "docs(plan-d): #164 not reproduced against soak baseline"`.

- [ ] **D.6.4 — New exact-master artifact set + adversarial review.** Atomic commit accordingly.

---

## Slice D.7 — Cross-cutting: retry safety + final candidate sweep

Spec §5.3 (final paragraph) + §9: the track also covers retry safety — mutations are never automatically retried. HTTP 4xx and mutations are not retried.

Current retry policy (verified): `src/subsonic.ts:1145-1159` `getJSONWithRetry` retries reads once on transient transport failure; `createPlayList`/`deletePlayList`/`updatePlaylist` deliberately use non-retried `getJSON` (`src/subsonic.ts:1688-1715`); `isRetryableSubsonicError` (`src/subsonic.ts:207-215`) excludes 4xx and app-level errors.

- [ ] **D.7.1 — Add/extend a failing test that mutation endpoints are not retried.**
  - [ ] In `tests/subsonic_music_library.test.ts`, for `createPlaylist`, `deletePlaylist`, `addToPlaylist`, `removeFromPlaylist`: mock a transient Axios network error on the first call and assert the underlying GET/POST is invoked **exactly once** (no retry).
  - Failing test first:
    ```bash
    npx jest tests/subsonic_music_library.test.ts -t "not retried"
    ```
    Expected before: fails (assertions not present).
  - Atomic commit: `git commit -m "test(plan-d): assert mutations are never retried"`.

- [ ] **D.7.2 — Confirm no runtime change needed (or minimal fix if a mutation is found retried).**
  - [ ] If a mutation handler is found routed through `getJSONWithRetry`, route it through `getJSON`/`postJSON` and re-run D.7.1.
  - Gate:
    ```bash
    npx jest tests/subsonic_music_library.test.ts -t "not retried"
    ```
    Expected: `PASS`.
  - Atomic commit (evidence): `git commit -m "test(plan-d): confirm retry safety across mutations"` **or** (fix) `git commit -m "fix(plan-d): stop retrying a mutation endpoint"`.

- [ ] **D.7.3 — Final candidate sweep + per-slice exact-master evidence roll-up.**
  - [ ] Run the Plan-C safe SMAPI sweep (read-only, aggregate-only) against the disposable candidate for the cumulative Plan-D `master`. Confirm section counts, status classes, and the §9 decision-table evaluation (1–4 attribute/investigate; ≥5 burst is a blocker; any secret/data-integrity/crash is a nonwaivable blocker).
  - [ ] Confirm every Plan-D slice has its own exact-master artifact/digest and that **no production promotion** occurred (criterion 8, 17).
  - Atomic commit: `git commit -m "docs(plan-d): final candidate sweep + per-slice exact-master evidence roll-up"`.

---

## Plan D exit checklist (spec §1.1 row D, criterion 17)

- [ ] Each code slice (D.1–D.7) has its own fresh exact-`master` build/audit/scan/smoke/candidate digest; no evidence reused across SHAs.
- [ ] #297 evidence records official URL, version `v1.0`, captured content hash/time, re-fetch comparison, exact raw-SOAP attributes, and candidate-only disposable mutation.
- [ ] #284 reproduced at the `/art` boundary; code change only if fixture fails at Bonob, else Navidrome/deployment diagnostic.
- [ ] #229 preserved (not reimplemented) with regression tests for auth/status/content headers/range.
- [ ] #214 raw fault bytes + content type asserted; Sonos fault codes retained.
- [ ] #246/#254/#255 are documentation + diagnostics; no speculative runtime workaround without a reproduction.
- [ ] #164 gated on Plan-C soak before/after against every threshold.
- [ ] Retry safety asserted: mutations and 4xx are never retried.
- [ ] Adversarial review (criterion 25) recorded for every slice; no production promotion occurred in this plan.

## Adversarial-review focus for Plan D (report to Codex)

- Any `itemType`/`readOnly`/`userContent` change that exceeds the locked raw fixture (D.1).
- Any #284/#246/#254/#214 slice that changes runtime code without a boundary reproduction.
- Any mutation endpoint routed through a retried path (D.7).
- Any slice that reuses an earlier-SHA artifact/digest (criterion 8).
- Any candidate test that mutates non-disposable state (spec §6, §7.1).
- Any redaction-gate bypass on `docs/sonos-s2-setup.md` (D.5.2).