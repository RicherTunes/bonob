# Plan E — Production validation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate one proven Plan-D immutable candidate through rehearsed rollback, separately approved promotion, read-only public/physical acceptance, and a 24-hour observation window.

**Architecture:** Repository work first creates a secret-free evidence schema and validators. A separate user authorization is a hard prerequisite to every operator/live task; after the verified backup and isolated restore rehearsal, a second explicit user approval authorizes only container recreation. Post-promotion checks are read-only and any blocker follows the pre-recorded rollback path.

**Tech Stack:** TypeScript/Jest evidence validators, Docker Compose and OCI/Docker inspection executed only by the approved operator, Plan-C candidate harness and diagnostics, Sonos S2 physical acceptance matrix.

## Global Constraints

- “Production container recreation is a separately announced risky deployment gate. It requires explicit user approval after the exact candidate digest, evidence summary, maintenance impact, verified VPS backup, and rollback command have been presented. Approval of this design does not authorize a future container recreation” (spec §8).
- “Promotion changes only the Bonob image reference to the tested digest” and does not rotate `BNB_SECRET`, change proxy policy, migrate Navidrome, or mutate the production cache (spec §8).
- “A dry run is insufficient, and the rehearsal must pass” (spec §8).
- Public and physical production gates are strictly read-only (spec §7.2).
- A failed post-promotion gate restores the previous digest, secret-compatible compose, and hashed cache snapshot unless recorded equality proves every required cache property is identical (spec §8).
- The §9 decision table is the sole auth/429/5xx release policy; a five-in-60-second same integration/outcome burst is a blocker (spec §9).
- The initial digest requires 24 continuous hours with no §9 blocker; Plan F requires seven continuous days on the same digest, three distinct physical sessions, zero rollback, zero blocker, and zero unattributed production error (criteria 21 and 23).

---

**Non-negotiable authorization rule:** This plan does not grant approval. Before E.1, the operator must receive and record a separate user authorization for backup/rehearsal only. Before E.3, the operator must receive and record the separate §8 user approval for container recreation. Do not treat a plan checkbox, a prior design approval, or an agent message as either authorization. This document never runs a live command itself.

**Persisted evidence contract:** all public records contain only hashes, identifiers, commands with paths replaced by operator-inventory keys, and pass/fail outcomes; raw inventories, credentials, host identifiers, and restore media remain root-readable outside Git.

```ts
type PlanEEvidence = {
  candidate: { sourceSha: string; digest: string; tag: string; revision: string };
  authorization: { backupRehearsalRef?: string; recreationRef?: string };
  backup: Record<string, { sha256: string; present: boolean }>;
  rehearsal: { commandRecordHash: string; checkpoints: Record<string, boolean> };
  promotion?: { beforeDigest: string; afterDigest: string; changedFields: ["bonob.image"] };
  gates: { publicReadOnly?: boolean; physicalReadOnly?: boolean; observation24h?: boolean };
  rollback?: { performed: boolean; cacheEqualityProofHash?: string; restoredSnapshotHash?: string };
};
```

`digest` must satisfy `^sha256:[0-9a-f]{64}$`, `tag` must satisfy `^sha-[0-9a-f]{40}$`, and `revision` must equal `sourceSha`. A missing/invalid field is a hard failure.

### Task E.0: Prepare and validate the non-live release record

**Files:**
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `tests/plan_e_evidence.test.ts`
- Modify: `docs/superpowers/plans/2026-07-23-plan-e-production-validation.md`

**Interfaces:**
- Consumes Plan-D `closeout.json` and its exact candidate digest.
- Produces a `PlanEEvidence` record with no `promotion` field and no claimed authorization.

- [ ] **Step 1: Write the failing evidence validator.**

```ts
import { readFileSync } from "fs";
const record = JSON.parse(readFileSync("docs/superpowers/evidence/2026-07-23-plan-e-record.json", "utf8"));
test("Plan E record starts unapproved and validates candidate identity", () => {
  expect(record.authorization.backupRehearsalRef).toBeUndefined();
  expect(record.authorization.recreationRef).toBeUndefined();
  expect(record.promotion).toBeUndefined();
  expect(record.candidate.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(record.candidate.tag).toMatch(/^sha-[0-9a-f]{40}$/);
  expect(record.candidate.revision).toBe(record.candidate.sourceSha);
});
```

- [ ] **Step 2: Run the red test.** Run `npx jest tests/plan_e_evidence.test.ts --runInBand`. Expected: FAIL because the record is absent.

- [ ] **Step 3: Add the minimal record from Plan D.** Copy the actual `sourceSha`, immutable digest, SHA tag, and OCI revision from Plan-D closeout evidence; initialize empty `backup`, `rehearsal.checkpoints`, and `gates`. Do not add approval references or execute an operator command.

- [ ] **Step 4: Run green validation and commit.** Run `npx jest tests/plan_e_evidence.test.ts --runInBand && npm run build`. Expected: PASS and exit `0`. Commit with `git add docs/superpowers/evidence/2026-07-23-plan-e-record.json tests/plan_e_evidence.test.ts docs/superpowers/plans/2026-07-23-plan-e-production-validation.md && git commit -m "docs(plan-e): prepare unapproved production-validation record"`.

### Task E.0.2: Separate user authorization for backup and restore rehearsal

**Files:**
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-authorization.md`

**Interfaces:**
- Consumes the validated E.0 candidate identity.
- Produces `authorization.backupRehearsalRef`, which authorizes only E.1–E.2 and explicitly does not authorize promotion.

- [ ] **Step 1: Present the non-live request.** Present the exact candidate digest, proposed backup/rehearsal scope, maintenance impact statement, and the fact that no container recreation is authorized. Do not run backup, copy, pull, restore, or VPS command before the user responds.

- [ ] **Step 2: Stop at the gate.** If a separate user response is not recorded, leave `backupRehearsalRef` absent and stop. Expected state: E.1–E.7 are blocked.

- [ ] **Step 3: Record only an explicit authorization.** On an explicit user response, record its reference and permitted scope in `2026-07-23-plan-e-authorization.md`, set `backupRehearsalRef`, and retain `recreationRef` as absent.

- [ ] **Step 4: Validate and commit.** Run `npx jest tests/plan_e_evidence.test.ts --runInBand`. Expected: PASS after adding a test that permits backup authorization but requires `recreationRef` to be undefined. Commit `docs(plan-e): record separate backup and rehearsal authorization`.

### Task E.1: Operator backup with reproducible, secret-safe evidence

**Files:**
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-backup.md`
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `tests/plan_e_backup_evidence.test.ts`

**Interfaces:**
- Consumes an E.0.2 authorization reference and the operator inventory keys `CURRENT_IMAGE`, `COMPOSE`, `PROXY`, `CREDENTIALS`, and `CACHE`.
- Produces hashed evidence for image, compose, proxy, inspection, networks, resource/security/health settings, secret-compatible credential fingerprint, and writer-quiesced cache snapshot.

- [ ] **Step 1: Write the failing completeness test.** Assert that `record.backup` contains non-empty SHA-256 hashes and `present: true` for `image`, `compose`, `proxy`, `inspection`, `networks`, `resourcesSecurityHealth`, `credentialsFingerprint`, `cacheSnapshot`, and `backupVerification`. Run `npx jest tests/plan_e_backup_evidence.test.ts --runInBand`. Expected: FAIL because E.0 has no backup fields.

- [ ] **Step 2: Record exact operator commands without secret values.** In the root-only operator record, declare validated variables first: `candidateDigest` matches the digest regex; `priorDigest` is nonempty and differs from it; each inventory path is an existing root-owned regular file or directory. Hash saved copies with `sha256sum`; record only hashes/inventory keys in the public Markdown and JSON. Never print credential contents.

- [ ] **Step 3: Run the authorized backup and verify containment.** Only after E.0.2 authorization, retain the current image archive or immutable digest, effective compose/proxy/configuration, inspection/network/resource/security/health data, credential fingerprint, writer-quiesced cache snapshot, and a verified VPS backup. Verify the backup contains every listed artifact before setting every `present` value true.

- [ ] **Step 4: Run green validation and commit.** Run `npx jest tests/plan_e_backup_evidence.test.ts --runInBand && npx jest tests/plan_e_evidence.test.ts --runInBand`. Expected: PASS. Commit secret-free evidence with `git commit -m "docs(plan-e): record verified rollback backup evidence"`.

### Task E.2: Mandatory isolated restore rehearsal

**Files:**
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-restore-rehearsal.md`
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `tests/plan_e_rehearsal_evidence.test.ts`

**Interfaces:**
- Consumes E.1 snapshot hashes and the prior image identity.
- Produces true checkpoints for `proxyConfig`, `health`, `root`, `about`, `authentication`, `smapi`, `artwork`, `byteRange`, `streamPlayback`, `cacheIntegrity`, and `cleanStop`, executed on disposable copies and a loopback-only non-production Compose project.

- [ ] **Step 1: Write the failing checkpoint test.** Assert all eleven named checkpoints equal `true` and `record.promotion` is absent. Run `npx jest tests/plan_e_rehearsal_evidence.test.ts --runInBand`. Expected: FAIL because the rehearsal has not run.

- [ ] **Step 2: Persist a complete, replayable sequence.** The root-only record must validate disposable target paths before copying, restore only copies of saved proxy/compose/environment/cache state, load the checksummed prior archive or verify the prior immutable digest, bind the rehearsal project to loopback, test proxy syntax, start the prior image, execute all eleven checks, and stop it cleanly. Hash the command record into `rehearsal.commandRecordHash`; public evidence exposes only the hash and checkpoint outcomes.

- [ ] **Step 3: Execute only under E.0.2 authorization.** A dry run is a failure. Run the sequence on disposable copies; any failed checkpoint blocks E.3 and requires a fresh successful rehearsal after correction.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/plan_e_rehearsal_evidence.test.ts --runInBand && npx jest tests/plan_e_backup_evidence.test.ts --runInBand`. Expected: PASS. Commit `docs(plan-e): record passed isolated restore rehearsal`.

### Task E.2.4: Separate §8 approval for container recreation

**Files:**
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-authorization.md`

**Interfaces:**
- Consumes passed E.1/E.2 evidence, candidate digest, maintenance impact, and root-only rollback command-record hash.
- Produces `authorization.recreationRef`; no other field grants promotion authority.

- [ ] **Step 1: Present required approval material.** Present the exact candidate digest, Plan-D evidence summary, playback/re-browse maintenance impact, verified backup outcome, passed restore-rehearsal outcome, and rollback command-record hash.

- [ ] **Step 2: Stop unless the user separately approves recreation.** Without a new explicit user response, retain no `recreationRef`; E.3–E.7 are blocked. Approval for E.0.2 does not satisfy this task.

- [ ] **Step 3: Record explicit approval and validate.** Record the response reference, timestamp, and scope “recreate Bonob with the named digest only.” Extend `tests/plan_e_evidence.test.ts` to require all backup/rehearsal validators pass before a recreation reference is accepted. Run `npx jest tests/plan_e_evidence.test.ts tests/plan_e_backup_evidence.test.ts tests/plan_e_rehearsal_evidence.test.ts --runInBand`. Expected: PASS.

- [ ] **Step 4: Commit.** Run `git add docs/superpowers/evidence/2026-07-23-plan-e-* tests/plan_e_* && git commit -m "docs(plan-e): record separate approved container recreation gate"`.

### Task E.3: Single-reference promotion and read-only public gate

**Files:**
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-public-gate.md`
- Create: `tests/plan_e_promotion_evidence.test.ts`

**Interfaces:**
- Consumes `candidate.digest`, matching OCI revision, `authorization.recreationRef`, and the pre-promotion snapshot.
- Produces `promotion.changedFields` exactly equal to `["bonob.image"]` and `gates.publicReadOnly: true` only after the post-promotion checks pass.

- [ ] **Step 1: Write the failing promotion evidence test.** Assert a recreation reference exists, `beforeDigest !== afterDigest`, `afterDigest === candidate.digest`, changed fields equal exactly `["bonob.image"]`, and public gate evidence declares no mutations. Run `npx jest tests/plan_e_promotion_evidence.test.ts --runInBand`. Expected: FAIL before promotion evidence exists.

- [ ] **Step 2: Validate variables before the approved action.** In the root-only command record, reject a candidate digest that fails its regex; inspect the image label and reject if OCI revision differs from `candidate.sourceSha`; compare effective configuration before/after and reject any changed field other than Bonob image. Do not substitute a tag for the digest.

- [ ] **Step 3: Execute the separately approved recreation.** During the announced maintenance window, graceful-stop Bonob within the Plan-C drain limit, recreate only with the validated digest, and stop on any command failure. Then run only CA/TLS, proxy, `/`, `/about`, OAuth/login/SMAPI routes, read-only sweep, rate-limit/intrusion sanity, attribution, and restart recovery checks. Record §9 decisions; do not mutate playlists, favourites, cache, media, or accounts.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/plan_e_promotion_evidence.test.ts --runInBand`. Expected: PASS only if the single-reference and read-only conditions hold. On any §9 blocker, do not mark the test green; execute E.5. Commit `docs(plan-e): record single-reference promotion and read-only public gate`.

### Task E.4: Read-only physical S2 acceptance and observation

**Files:**
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-physical-matrix.json`
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `tests/plan_e_physical_evidence.test.ts`

**Interfaces:**
- Consumes the promoted digest and public-gate success.
- Produces three sessions separated by at least 30 minutes (one after a controlled restart), a two-hour read-only playback soak, fixture/controller/speaker version matrix, and `gates.physicalReadOnly: true`.

- [ ] **Step 1: Write the failing physical-evidence test.** Require every case to contain steps, expected/actual result, start/end time, latency, redacted evidence hash, digest, Navidrome version, speaker firmware, controller version, and media fixture version/hash/codec/bit-depth/sample-rate. Require three sessions, one `afterRestart`, duration at least 7,200 seconds, no dropout at least one second outside pause/seek, and start/seek at most ten seconds. Run `npx jest tests/plan_e_physical_evidence.test.ts --runInBand`. Expected: FAIL before the matrix exists.

- [ ] **Step 2: Execute the operator matrix read-only.** Browse root/large buckets/artists/bios/search/artwork, start/seek/stop/replay, read-only favourites/playlists, queued-media behavior, and post-restart cache persistence; run the two-hour soak. Do not create, delete, add, remove, modify, or repair production state.

- [ ] **Step 3: Observe for 24 continuous hours.** Machine-evaluate all signals using only §9. A container restart/unhealthy event, unexplained auth/429/5xx burst, or release-blocking regression fails the window and invokes E.5; lower-severity issues require recorded user+architect disposition before pass.

- [ ] **Step 4: Verify and commit.** Run `npx jest tests/plan_e_physical_evidence.test.ts --runInBand && npx jest tests/plan_e_* --runInBand`. Expected: PASS only after the 24-hour window has `gates.observation24h: true`. Commit `docs(plan-e): record physical S2 acceptance and 24-hour observation`.

### Task E.5: Mandatory rollback on any post-promotion failure

**Files:**
- Modify: `docs/superpowers/evidence/2026-07-23-plan-e-record.json`
- Create: `docs/superpowers/evidence/2026-07-23-plan-e-rollback.md`
- Create: `tests/plan_e_rollback_evidence.test.ts`

**Interfaces:**
- Consumes the E.1 prior digest, compose, secret-compatible environment fingerprint, and cache snapshot.
- Produces either `rollback.performed: true` with restored snapshot hash, or a cache-equality proof hash showing file/tree hashes, envelope/schema validation, ownership, and mode all exactly equal before skipping the copy.

- [ ] **Step 1: Write the failing rollback validator.** Assert a failed-gate record has `performed === true`, the prior digest is restored, and contains either `restoredSnapshotHash` or `cacheEqualityProofHash`; reject a record that supplies both neither. Run `npx jest tests/plan_e_rollback_evidence.test.ts --runInBand`. Expected: FAIL because no rollback evidence exists.

- [ ] **Step 2: On a blocker, execute only the recorded rollback sequence.** Stop new test traffic; restore prior digest and secret-compatible compose; restore the cache snapshot unless every equality property is proven; recreate; verify `/`, `/about`, SMAPI, cache load, and physical browse/play; preserve redacted logs/manifests. Do not alter Navidrome, proxy, DNS, Developer Portal registration, or music library without evidence.

- [ ] **Step 3: Verify and commit.** Run `npx jest tests/plan_e_rollback_evidence.test.ts --runInBand`. Expected: PASS only after exact prior state is recorded. Commit `docs(plan-e): record exact rollback after failed production gate`.

## Exit checks

- [ ] Plan A–D candidate evidence is exact-SHA/digest bound; no code-SHA evidence is reused.
- [ ] No live activity occurred before E.0.2 separate authorization; no recreation occurred before E.2.4 separate §8 approval.
- [ ] Verified backup and actual isolated restore rehearsal passed.
- [ ] Promotion changed exactly one image reference, every public/physical activity was read-only, and rollback is executable/proven.
- [ ] Physical matrix, two-hour soak, and 24-hour observation pass §9; Plan F remains blocked pending its seven-day same-digest threshold.
