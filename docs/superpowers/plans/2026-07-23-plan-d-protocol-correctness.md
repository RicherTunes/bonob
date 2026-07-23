# Plan D — Protocol correctness implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct only protocol behavior proven defective at the Bonob boundary, while preserving the validated Plan-C runtime controls and never promoting to production.

**Architecture:** Each issue is an independent exact-`master` slice. A raw fixture or disposable-candidate reproduction first proves the contract, focused red/green tests protect it, and the slice then receives a new build/audit/scan/smoke/candidate digest and adversarial review. Diagnostics are an acceptable outcome when the fixture passes without a Bonob defect.

**Tech Stack:** TypeScript 5.9, Jest 30, Express, `soap`, `supertest`, Node `crypto`, Docker/OCI evidence supplied by Plans B–C.

## Global Constraints

- “Protocol fixes are evidence-driven” (spec §5.3).
- “A code change is allowed only if the fixture fails at the Bonob boundary; otherwise the finding becomes a Navidrome or deployment diagnostic” (spec §5.3, #284).
- “Mutations are never automatically retried” (spec §5.3).
- “Every code-changing Plan C/D slice starts from exact current `master` and produces a new build/audit/scan/smoke/candidate-tested digest; evidence is never reused across code SHAs” (criterion 8).
- “Candidate … joins no production network, mounts no production state, and has no direct external route” (spec §7.1).
- “Every implementation slice receives adversarial review” (spec §9).
- Plan C graceful-shutdown and attribution/redaction gates precede every protocol release; Plan D performs no production promotion (spec §1.1).

---

**Entry gate:** Plan C is complete and its evidence identifies the current `master` candidate. Before every slice run `git fetch origin master` and require `git rev-parse HEAD` to equal `git rev-parse origin/master`; otherwise stop without testing or building.

**Shared persisted evidence contract:** create one JSON record per slice at `docs/superpowers/evidence/plan-d/`: `d1-297.json`, `d2-284.json`, `d3-229.json`, `d4-214.json`, `d5-connectivity.json`, and `d6-regression-matrix.json`. Each has exactly:

```ts
type ProtocolSliceEvidence = {
  slice: string; sourceSha: string; fixtureSha256: Record<string, string>;
  focusedTestCommand: string; focusedTestExit: number; fullTestExit: number;
  candidateRunId: string; imageDigest: string; reviewReference: string;
  outcome: "fixed" | "confirmed" | "diagnostic";
};
```

`sourceSha` must match `git rev-parse HEAD`; `imageDigest` must match `^sha256:[0-9a-f]{64}$`; a missing field fails the slice. The Plan-B pipeline is invoked by its existing exact-master dispatcher, not recreated in this plan.

### Task D.0: Fixture, hash, and evidence enforcement

**Files:**
- Create: `tests/fixtures/protocol/manifest.json`
- Create: `tests/protocol_fixture_manifest.test.ts`
- Create: `docs/superpowers/evidence/plan-d/.gitkeep`

**Interfaces:**
- Produces `ProtocolFixtureManifest = { version: 1; fixtures: Record<string, { sha256: string; source: string; capturedAt: string }> }`.
- Consumed by all D.1–D.6 tests and evidence records.

- [ ] **Step 1: Write the failing manifest test.**

```ts
import { createHash, readFileSync } from "crypto";
import manifest from "./fixtures/protocol/manifest.json";

test("every protocol fixture has its recorded sha256", () => {
  expect(Object.keys(manifest.fixtures).length).toBeGreaterThan(0);
  for (const [file, metadata] of Object.entries(manifest.fixtures)) {
    const body = readFileSync(`tests/fixtures/protocol/${file}`);
    expect(createHash("sha256").update(body).digest("hex")).toBe(metadata.sha256);
  }
});
```

- [ ] **Step 2: Run the red test.** Run `npx jest tests/protocol_fixture_manifest.test.ts --runInBand`. Expected: FAIL because `tests/fixtures/protocol/manifest.json` does not exist.

- [ ] **Step 3: Add the minimal manifest and first contract fixture.** Create `tests/fixtures/protocol/issue-297-contract.json` containing the root `playlists` and individual-playlist attributes stated in D.1. Create `manifest.json` with that filename, its official Add-playlists URL, version `v1.0`, capture time, and the actual SHA-256 emitted by `node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('tests/fixtures/protocol/issue-297-contract.json')).digest('hex'))"`; do not use a hand-written digest.

- [ ] **Step 4: Run the green test and compiler.** Run `npx jest tests/protocol_fixture_manifest.test.ts --runInBand && npm run build`. Expected: PASS and TypeScript exits `0`.

- [ ] **Step 5: Commit.** Run `git add tests/fixtures/protocol/manifest.json tests/protocol_fixture_manifest.test.ts docs/superpowers/evidence/plan-d/.gitkeep && git commit -m "test(plan-d): enforce protocol fixture manifest"`.

### Task D.1: Issue #297 playlist-editing contract

**Files:**
- Create: `tests/fixtures/protocol/issue-297-add-playlists.json`
- Modify: `tests/fixtures/protocol/manifest.json`
- Modify: `tests/smapi.test.ts`
- Modify: `src/smapi.ts:334-350,938-946`
- Create: `docs/superpowers/evidence/plan-d/d1-297.json`

**Interfaces:**
- Consumes `getMetadataResult(result: Partial<getMetadataResult>): GetMetadataResponse` from `src/smapi.ts`.
- Produces root item `{ id: "playlists", itemType: "playlist", readOnly: false, attributes: { userContent: true } }` and individual playlist items with `itemType: "playlist"`, `readOnly: false`, `attributes.userContent: false`.

- [ ] **Step 1: Capture contract evidence before code.** Re-fetch `https://docs.sonos.com/docs/add-playlists`; compare its SHA-256 to `256125a2672051417c675ea471b22215bebb16031f6e35710e63b2090e016997` and version `v1.0`. Store only URL, version, capture time, and SHA in `issue-297-add-playlists.json`; update the manifest hash. If comparison differs, record `outcome: "diagnostic"`, request contract re-review, and stop this task.

- [ ] **Step 2: Write the failing focused test.** Add a `describe("#297 playlist editing attributes")` in `tests/smapi.test.ts` that makes the existing in-process SOAP `getMetadata` root and playlist calls, then asserts the two exact objects in **Interfaces**. Run `npx jest tests/smapi.test.ts -t "#297 playlist editing attributes" --runInBand`. Expected: FAIL; current root is `"collection"` and the individual playlist has `userContent: true`.

- [ ] **Step 3: Make the minimal implementation.** In `src/smapi.ts`, alter only the root `id: "playlists"` metadata object and the `playlist(...)` mapper: set root `itemType: "playlist"`, `readOnly: false`, and `attributes.userContent: true`; set individual `readOnly: false` and `attributes.userContent: false`. Do not alter create/delete handlers or retry calls.

- [ ] **Step 4: Run green tests.** Run `npx jest tests/smapi.test.ts -t "#297 playlist editing attributes" --runInBand && npx jest tests/protocol_fixture_manifest.test.ts --runInBand && npx jest --runInBand`. Expected: all PASS.

- [ ] **Step 5: Candidate mutation and artifact evidence.** Use the Plan-C disposable candidate harness only: create `bonob-smoke-297`, add one fixture track, remove it, delete it in `finally`; assert zero matching sentinel in production evidence. Dispatch the existing Plan-B exact-master pipeline, validate its new digest with `node -e "process.exit(/^sha256:[0-9a-f]{64}$/.test(process.argv[1])?0:1)" "$env:PLAN_D_DIGEST"`, then write `d1-297.json` matching `ProtocolSliceEvidence`.

- [ ] **Step 6: Commit.** Run `git add src/smapi.ts tests/smapi.test.ts tests/fixtures/protocol docs/superpowers/evidence/plan-d/d1-297.json && git commit -m "fix(plan-d): correct Sonos playlist editing metadata"`.

### Task D.2: Issue #284 separate-file artwork boundary triage

**Files:**
- Create: `tests/fixtures/protocol/issue-284-cover.jpg`
- Create: `tests/fixtures/protocol/issue-284-navidrome-response.json`
- Modify: `tests/fixtures/protocol/manifest.json`
- Modify: `tests/server.test.ts`
- Conditionally modify: `src/server.ts:653-729` or `src/subsonic.ts:436-438`
- Create: `docs/superpowers/evidence/plan-d/d2-284.json`

**Interfaces:**
- Consumes `MusicLibrary.coverArt(urn: BUrn, size: number): Promise<CoverArt | undefined>` and `/art/:burn/size/:size` in `src/server.ts`.
- Produces either `200 image/jpeg` whose body equals `issue-284-cover.jpg`, or a `diagnostic` evidence outcome with no runtime edit.

- [ ] **Step 1: Write the failing boundary test.** In `tests/server.test.ts`, add `describe("#284 separate-file artwork")`; mock the library to return the fixture bytes and `contentType: "image/jpeg"`, issue a scoped-token GET, and assert status `200`, exact bytes, `content-type: image/jpeg`, and `X-Content-Type-Options: nosniff`. Run `npx jest tests/server.test.ts -t "#284 separate-file artwork" --runInBand`. Expected: FAIL until fixture and assertion are wired.

- [ ] **Step 2: Add fixture hashes and run red/green classification.** Add both fixtures to the manifest and run the focused test. If it passes with unchanged runtime code, write `d2-284.json` with `outcome: "diagnostic"`; do not edit `src/` and commit the fixture/test/evidence. If it fails at the Bonob boundary, continue.

- [ ] **Step 3: Implement only a proven Bonob fix.** Change only the branch proved by the failing assertion in `src/server.ts:653-729` or `src/subsonic.ts:436-438`; retain image MIME validation and the existing scoped-token check. Add the assertion that demonstrates the regression no longer occurs.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/server.test.ts -t "#284 separate-file artwork" --runInBand && npx jest --runInBand`; create a new exact-master candidate digest and `d2-284.json`; then commit either `docs(plan-d): record #284 boundary diagnostic` or `fix(plan-d): serve proven separate-file artwork` according to the recorded outcome.

### Task D.3: Issue #229 HEAD and range regression lock

**Files:**
- Modify: `tests/server.test.ts:935-1015`
- Conditionally modify: `src/server.ts:448-575`
- Create: `docs/superpowers/evidence/plan-d/d3-229.json`

**Interfaces:**
- Consumes `HEAD /stream/:burn` and range handling in `src/server.ts`.
- Produces a `HEAD` response with authenticated status and range/content headers, no response body, and no `musicLibrary.nowPlaying` call.

- [ ] **Step 1: Write the failing regression test.** Extend `describe("HEAD requests")` with a `206` range mock, expect `content-range` and `content-length`, spy on `musicLibrary.nowPlaying`, and expect an empty body and `not.toHaveBeenCalled()`. Run `npx jest tests/server.test.ts -t "HEAD requests" --runInBand`. Expected: FAIL until the new case is present.

- [ ] **Step 2: Confirm or minimally fix.** If the test passes with no runtime edit, record `outcome: "confirmed"`. Otherwise change only the proven `HEAD` branch in `src/server.ts:448-575`; do not change GET behavior, authentication, range calculation, or retries.

- [ ] **Step 3: Verify artifact and commit.** Run `npx jest tests/server.test.ts -t "HEAD requests" --runInBand && npx jest --runInBand`, create a fresh exact-master digest and `d3-229.json`, obtain adversarial review, then commit `test(plan-d): lock stream HEAD and range behavior`.

### Task D.4: Issue #214 raw SOAP fault contract

**Files:**
- Create: `tests/fixtures/protocol/issue-214-faults.json`
- Modify: `tests/fixtures/protocol/manifest.json`
- Modify: `tests/smapi.test.ts`
- Conditionally modify: `src/smapi.ts:515-1590` or `src/smapi_auth.ts:33-88`
- Create: `docs/superpowers/evidence/plan-d/d4-214.json`

**Interfaces:**
- Consumes the SOAP 1.1 binding in `src/Sonoswsdl-1.19.6-20231024.wsdl` and `bindSmapiSoapServiceToExpress(...)`.
- Produces raw fault responses whose content type, SOAP 1.1 envelope namespace, `faultcode`, and `faultstring` equal the fixture for LoginUnauthorized, LoginUnsupported, and TokenRefreshRequired.

- [ ] **Step 1: Add the failing raw-response test.** Through the existing `soap` plus `tests/supersoap.ts` in-process transport, invoke each failing call and compare the raw response body and `content-type` to `issue-214-faults.json`; assert `http://schemas.xmlsoap.org/soap/envelope/` and each exact fault value. Run `npx jest tests/smapi.test.ts -t "#214 raw SOAP faults" --runInBand`. Expected: FAIL before the fixtures/assertions exist.

- [ ] **Step 2: Capture immutable fixtures.** Record the raw response byte SHA-256 and expected header values in the JSON fixture and manifest; do not normalize XML for the byte comparison.

- [ ] **Step 3: Confirm or minimally correct.** If raw output already matches, record `outcome: "confirmed"`. Only on a failed raw assertion alter the SOAP binding/fault-emission code named in **Files**; retain all fault codes and strings.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/smapi.test.ts -t "#214 raw SOAP faults" --runInBand && npx jest --runInBand`; record a new digest and `d4-214.json`, obtain adversarial review, and commit `test(plan-d): lock raw SOAP fault contract` or the focused `fix(plan-d)` equivalent.

### Task D.5: Issues #246/#254/#255 diagnostics guide

**Files:**
- Create: `docs/sonos-s2-setup.md`
- Create: `tests/sonos_s2_guide.test.ts`
- Create: `docs/superpowers/evidence/plan-d/d5-connectivity.json`

**Interfaces:**
- Produces five exact headings: `## Public HTTPS ingress`, `## Developer Portal registration`, `## Proxy and rate-limit behavior`, `## Advertised versus reachable URLs`, and `## IPv4/IPv6 reachability`.
- The guide names only generic diagnostics; it contains no hostnames, addresses, service names, credential locations, or topology identifiers.

- [ ] **Step 1: Write the failing structure/redaction test.** Read the guide and assert all five headings exist; assert it does not match `/(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}|BNB_SECRET|\/home\/|C:\\Users\\/`. Run `npx jest tests/sonos_s2_guide.test.ts --runInBand`. Expected: FAIL because the guide is absent.

- [ ] **Step 2: Add the minimal guide.** For every heading, describe what an operator records, the read-only diagnostic, and the boundary between public ingress and internal configuration; state that runtime network workarounds require a reproducible Bonob-boundary failure.

- [ ] **Step 3: Verify and commit.** Run `npx jest tests/sonos_s2_guide.test.ts --runInBand && npx jest --runInBand`; record a fresh digest and `d5-connectivity.json` with `outcome: "diagnostic"`, obtain review, and commit `docs(plan-d): add S2 connectivity diagnostics guide`.

### Task D.6: Cross-protocol regression matrix and lifecycle-leak evidence

**Files:**
- Modify: `tests/subsonic.test.ts:261-280`
- Modify: `tests/smapi.test.ts`
- Modify: `tests/server.test.ts:935-1015`
- Create: `tests/plan_d_lifecycle_baseline.test.ts`
- Create: `docs/superpowers/evidence/plan-d/d6-regression-matrix.json`

**Interfaces:**
- Consumes `isRetryableSubsonicError(error: unknown): boolean`, SMAPI search/favourites handlers, stream `HEAD`/range behavior, and the Plan-C lifecycle soak evidence.
- Produces a matrix proving search/favourites responses retain their existing SOAP contract, HTTP 4xx and mutations are not retried, and Issue #164 is either a Plan-C-baselined diagnostic or a separately planned lifecycle fix with before/after threshold evidence.

- [ ] **Step 1: Write the failing matrix test.** Add a retry case in `tests/subsonic.test.ts` for a mutation request that observes exactly one transport call after a transient failure; add search/favourites cases in `tests/smapi.test.ts` that compare their raw SOAP result fixtures; add `plan_d_lifecycle_baseline.test.ts` that requires Plan-C soak evidence to include duration/cycles/RSS/handle/socket/rejection/crash/cache fields. Run `npx jest tests/subsonic.test.ts tests/smapi.test.ts tests/plan_d_lifecycle_baseline.test.ts --runInBand`. Expected: FAIL until every new assertion and baseline fixture exists.

- [ ] **Step 2: Confirm the #164 decision.** If the Plan-C evidence meets every declared threshold, record `outcome: "diagnostic"` and make no lifecycle code change. If it does not, stop Plan D and create a separately reviewed lifecycle slice with complete before/after threshold evidence; do not hide it in a protocol or refactor commit.

- [ ] **Step 3: Make only focused fixes, if proven.** A red retry/search/favourites/HEAD assertion may change only the implementation named by that assertion. Preserve HTTP 4xx and mutations as non-retried and preserve raw SOAP fixture bytes.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/subsonic.test.ts tests/smapi.test.ts tests/server.test.ts tests/plan_d_lifecycle_baseline.test.ts --runInBand && npx jest --runInBand`; record new digest/review in `d6-regression-matrix.json`; commit `test(plan-d): lock retry search favourites and lifecycle matrix`.

### Task D.7: Candidate release closeout

**Files:**
- Create: `docs/superpowers/evidence/plan-d/closeout.json`

**Interfaces:**
- Consumes `ProtocolSliceEvidence` records D.1–D.6.
- Produces `PlanDCloseout = { sourceSha: string; sliceEvidence: string[]; candidateDigest: string; candidateSweepExit: 0; adversarialReview: string; productionPromotion: false }`.

- [ ] **Step 1: Write the failing closeout validator.** Add `tests/plan_d_closeout.test.ts` that requires `productionPromotion === false`, validates every referenced evidence file, and requires its `sourceSha` to equal the closeout SHA. Run `npx jest tests/plan_d_closeout.test.ts --runInBand`. Expected: FAIL because closeout evidence is absent.

- [ ] **Step 2: Implement the closeout record.** Generate it only after the latest exact-master build/audit/scan/smoke/candidate sweep exits `0`; record the real candidate digest and adversarial-review reference. Do not dispatch any production action.

- [ ] **Step 3: Verify and commit.** Run `npx jest tests/plan_d_closeout.test.ts --runInBand && npx jest --runInBand`; then commit `docs(plan-d): close protocol candidate evidence without promotion`.

## Exit checks

- [ ] Every evidence record validates and is bound to its own exact source SHA/digest.
- [ ] #297 locks the specified raw attributes and uses only disposable candidate playlist mutation.
- [ ] #284 is either a demonstrated Bonob fix or a recorded Navidrome/deployment diagnostic.
- [ ] #229, #214, #246/#254/#255, artwork, retry safety, search, favourites, and ranges have focused contract coverage; mutations remain non-retried.
- [ ] Candidate sweep and fresh adversarial review pass; no production promotion occurred.
