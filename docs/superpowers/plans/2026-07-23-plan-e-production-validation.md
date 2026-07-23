# Plan E — Production validation

**Plan:** E — Production validation
**Program:** RicherTunes bonob private-fork convergence (spec `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, §7, §8)
**Entry dependency (spec §1.1 row E):** Plans A–D complete **and** the intended Plan-D candidate passes its gates (per-slice exact-master artifacts + adversarial review + candidate sweep, no production promotion).
**Exit evidence (spec §1.1 row E, criteria 18–21):** verified backup/restore evidence, read-only public gate, read-only physical Sonos S2 gate (incl. ≥2h playback soak), rollback rehearsed, and the initial digest completes 24 continuous hours of observation.
**Scope guard (this plan, spec §7.2, §8):** this plan **defines and prepares** the exact, ordered, machine-checked gates for promotion. **It authorizes no live action in this document-writing turn.** Every live action (backup, restore rehearsal, container recreation, promotion, gates, rollback) is a separately approved, operator-executed step gated on explicit user approval and prior-step success. Automation stops on the first failed command and never silently substitutes a tag, cache, credential source, endpoint, or architecture (spec §9).

---

## Invariants every step obeys

- **Separate evidence layers (spec §7.2):** promotion requires all three — (1) synthetic candidate gate, (2) read-only public production gate *after* promotion, (3) physical Sonos S2 gate. No sidecar result is described as S2 end-to-end success.
- **Maintenance window (spec §8):** Bonob's in-memory API-token map invalidates `bat` values and link codes on process restart; SMAPI tokens and secret-signed artwork survive restart until expiry while the same `BNB_SECRET` is retained. Initial promotions stop playback and re-browse/requeue. Promotion changes **only** the Bonob image reference; it does **not** rotate `BNB_SECRET`, change proxy policy, migrate Navidrome, or mutate the production cache in the same step (spec §8).
- **Exact digest (spec §4, §8):** the promoted reference is the tested immutable digest `ghcr.io/richertunes/bonob@sha256:<manifest-digest>` with tag `sha-<40 hex>`. The VPS verifies the OCI revision label equals the intended commit and refuses on a digest/revision mismatch.
- **Rollback is rehearsed before promotion (spec §8, criterion 18).** On any failed gate, the prior digest + secret-compatible compose + hashed prior cache snapshot are restored.
- **Read-only public/physical gates (spec §7.2.2–7.2.3, criterion 20):** strictly read-only; no mutation of production accounts/playlists/favourites/database/cache/media.
- **Decision table is sole policy (spec §9):** 1–4 same integration/outcome in 60s → attribute/investigate, retry only an idempotent read under policy; ≥5 in 60s → release blocker; any secret/data-integrity/crash/unhealthy/restart → nonwaivable blocker.

---

## Slice E.0 — Pre-flight: approval, candidate digest, and evidence manifest (no live action)

Goal: bind the exact candidate digest and assemble the approval + evidence manifest *before* any production touch. This step produces documents/checks only.

- [ ] **E.0.1 — Record the exact candidate digest and exit evidence from Plans A–D.**
  - [ ] Create `docs/superpowers/evidence/2026-07-23-plan-e-candidate-manifest.md` recording: the exact Plan-D candidate full SHA, the `sha-<40 hex>` tag, the `sha256:<digest>`, the Plan-B build/audit/scan run/artifact IDs, the candidate sweep + adversarial-review references, and confirmation that Plans A–D exit criteria are met.
  - Gate (proves the manifest is non-empty and carries the required identity fields):
    ```bash
    grep -E 'sha-[0-9a-f]{40}|sha256:' docs/superpowers/evidence/2026-07-23-plan-e-candidate-manifest.md
    ```
    Expected: both the tag and digest are present (exit `0`).
  - Atomic commit: `git commit -m "docs(plan-e): record exact Plan-D candidate digest and exit evidence"`.

- [ ] **E.0.2 — Obtain explicit, separately-announced user approval for the risky deployment gate.**
  - Per spec §8: "Production container recreation is a separately announced risky deployment gate. It requires explicit user approval after the exact candidate digest, evidence summary, maintenance impact, verified VPS backup, and rollback command have been presented. Approval of this design does not authorize a future container recreation."
  - [ ] Present to the user: exact candidate digest (E.0.1), evidence summary, maintenance impact (playback stops; users re-browse/requeue), the verified backup plan (E.1), and the exact rollback command sequence (E.4). Record the approval reference in the manifest.
  - **No subsequent live step (E.1+) executes until this approval is recorded.** This is a hard gate.
  - Atomic commit: `git commit -m "docs(plan-e): record explicit user approval for promotion gate"`.

---

## Slice E.1 — Verified backup (operator-executed, root-only)

Spec §8 (before any production container recreation) + criterion 18. Capture and verify every restorable artifact with hashes; no secret values are printed.

- [ ] **E.1.1 — Retain the current image and configuration with hashes.**
  - [ ] Retain a checksummed image archive **or** a proven immutable pullable digest for the exact current image; record its hash.
  - [ ] Save the effective compose configuration and the actual nginx file, with hashes.
  - [ ] Save the proxy target, container inspection, Docker networks, resource limits, security settings, and health configuration.
  - Gate (each artifact present + hashed, no value printed):
    ```bash
    # operator inventory (root-readable); the public record stores only hashes/outcome
    ```
    Expected: every required artifact has a recorded hash and a pass outcome in the evidence manifest.
  - Atomic commit (hashes/outcome only): `git commit -m "docs(plan-e): retain current image/compose/proxy/security state with hashes"`.

- [ ] **E.1.2 — Back up secret-compatible environment/credentials (no values printed) and record fingerprints.**
  - [ ] Back up the secret-compatible environment/credential files without printing values; record root-only fingerprints so rollback reuses the same `BNB_SECRET` (spec §8).
  - Gate: the evidence manifest records a fingerprint + "no value printed" outcome; a secret in any output stops work and triggers rotation (spec §8).
  - Atomic commit: `git commit -m "docs(plan-e): record secret-compatible credential fingerprints (no values)"`.

- [ ] **E.1.3 — Capture cache snapshot + run + verify the VPS backup.**
  - [ ] Capture cache envelope/schema, semantic-validation result, file count/bytes, ownership/mode, per-file/tree hashes, and a writer-quiesced snapshot.
  - [ ] Run and verify the VPS backup; record the successful backup/snapshot identifier.
  - [ ] Validate the backup *contains* the saved proxy configuration, container inspection, Docker network/resource/security/health settings, checksummed image archive or immutable digest, compose configuration, secret-compatible environment/credentials, and hashed cache snapshot (spec §8/criterion 18).
  - Gate (validation checklist all pass):
    ```bash
    # evidence manifest records pass for: proxy, container, networks, resources, security,
    # health, image, compose, env/creds, cache snapshot
    ```
    Expected: all entries pass. A missing entry fails E.1.
  - Atomic commit: `git commit -m "docs(plan-e): verified VPS backup with cache snapshot (criterion 18)"`.

---

## Slice E.2 — Mandatory isolated restore rehearsal (must pass; dry run insufficient)

Spec §8 + criterion 18: perform a mandatory isolated restore rehearsal using a recorded exact command sequence. A dry run is insufficient, and the rehearsal **must pass**.

- [ ] **E.2.1 — Define the exact restore-rehearsal command sequence (recorded, replayable).**
  - [ ] Write `docs/superpowers/evidence/2026-07-23-plan-e-restore-rehearsal.md` with the exact ordered commands that: restore **disposable copies** of the saved proxy/compose/environment/cache state; load the exact checksummed image archive or pull and verify the immutable digest; run the proxy configuration test; start the previous image in a **non-production project/loopback binding**; then verify secret compatibility, health, `/`, `/about`, authentication, SMAPI, artwork, byte-range headers/body, stream playback, cache semantic/hash integrity, and a clean stop.
  - Gate (sequence is complete and ordered):
    ```bash
    grep -cE 'restore|load|verify|start|stop' docs/superpowers/evidence/2026-07-23-plan-e-restore-rehearsal.md
    ```
    Expected: each required verb present (exit `0`).
  - Atomic commit: `git commit -m "docs(plan-e): record exact isolated restore-rehearsal command sequence"`.

- [ ] **E.2.2 — Execute the rehearsal against disposable copies; it must pass.**
  - [ ] Operator executes E.2.1 against **disposable** restored copies in a non-production project/loopback binding. No production state is touched.
  - [ ] Verify every checkpoint: secret compatibility, health, `/`, `/about`, authentication, SMAPI, artwork, byte-range headers/body, stream playback, cache semantic/hash integrity, clean stop.
  - Gate (per spec §8): every checkpoint passes; a single failure stops promotion and the finding is fixed/re-run.
    ```bash
    # evidence manifest records pass for: secret-compat, health, /, /about, auth, SMAPI,
    # artwork, byte-range, stream playback, cache integrity, clean stop
    ```
    Expected: all pass.
  - Atomic commit (hashes/outcome only): `git commit -m "docs(plan-e): isolated restore rehearsal passed (criterion 18)"`.

- [ ] **E.2.3 — Confirm previous public health and current physical Sonos baseline.**
  - [ ] Record the previous public health (`/`, `/about`, TLS) and the current physical Sonos browse/play baseline as the pre-promotion reference for rollback comparison.
  - Atomic commit: `git commit -m "docs(plan-e): record pre-promotion public + physical baseline"`.

---

## Slice E.3 — Promotion (single image-reference change only; maintenance window)

Spec §8: "Promotion changes only the Bonob image reference to the tested digest unless a separately reviewed configuration change is essential. It does not rotate `BNB_SECRET`, change proxy policy, migrate Navidrome, or mutate the production cache in the same step. After graceful stop and recreation, the public and physical gates run immediately."

- [ ] **E.3.1 — Define and gate the exact single-change promotion command.**
  - [ ] In the evidence manifest, record the exact command that updates **only** the Bonob image reference to `ghcr.io/richertunes/bonob@sha256:<digest>` (tag `sha-<40 hex>`), with the VPS verifying the OCI revision label equals the intended commit and refusing on mismatch.
  - [ ] Assert the command makes **no** other change (no secret rotation, no proxy policy change, no Navidrome change, no cache mutation).
  - Gate (command is single-purpose; pre-flight equals current digest, target equals candidate digest):
    ```bash
    # pre-flight: current image digest != candidate; after: current == candidate; nothing else changes
    ```
    Expected: only the image reference differs before/after.
  - Atomic commit: `git commit -m "docs(plan-e): record single-image-reference promotion command"`.

- [ ] **E.3.2 — Execute graceful stop + recreation within the announced maintenance window.**
  - [ ] Stop playback (maintenance window), graceful-stop Bonob (Plan-C graceful shutdown must quiesce cache + drain registries within the Docker grace period), recreate with the candidate digest, then run public + physical gates **immediately** (spec §8).
  - Gate: graceful shutdown completes within the compose stop grace period; recreation uses the verified digest.
  - Atomic commit (outcome only): `git commit -m "docs(plan-e): promoted candidate digest via single-reference change"`.

---

## Slice E.4 — Read-only public production gate (after promotion)

Spec §7.2.2 + criterion 21. Strictly read-only; no mutation of production state.

- [ ] **E.4.1 — Run the read-only public gate.**
  - [ ] Execute: CA/TLS validation; proxy configuration test; `/` and `/about`; OAuth/login/SMAPI routes; a **strictly read-only** public sweep; rate-limit/intrusion-control sanity; upstream attribution; restart recovery.
  - [ ] Evaluate all auth/429/5xx outcomes **only** by the §9 decision table: 1–4 in 60s → attribute/investigate + recorded disposition; ≥5 burst → release blocker (roll back per E.6); any secret/data-integrity/crash/unhealthy/restart → nonwaivable blocker.
  - Gate (read-only sweep passes; §9 evaluation recorded):
    ```bash
    # read-only sweep: status classes, section counts, timings; zero mutation
    ```
    Expected: pass; or a §9 blocker triggers E.6 rollback.
  - Atomic commit: `git commit -m "docs(plan-e): read-only public production gate evidence"`.

---

## Slice E.5 — Physical Sonos S2 gate (read-only; operator on the LAN)

Spec §7.2.3 + §7.2 retention (criteria 20, 21). Read-only; no mutation.

- [ ] **E.5.1 — Run the read-only physical matrix.**
  - [ ] On the actual LAN speakers/controller, exercise: browse root + large album buckets, artists + bios, search, artwork, start playback, seek, stop, replay, read-only favourites/playlists, queued-media behavior, post-restart cache persistence.
  - [ ] Record the retained matrix: candidate digest, Navidrome version, speaker model + firmware, controller hardware/OS/app version, version/hash + codec/bit-depth/sample-rate of each media fixture; per case: exact steps, expected vs actual, start/end time, latency, redacted evidence/log hashes.
  - Gate (spec §7.2 retention): zero unexpected stop or rebuffer/audio dropout ≥1s outside intentional pause/seek; start and seek produce audio within 10s.
  - Atomic commit: `git commit -m "docs(plan-e): physical Sonos S2 read-only matrix evidence"`.

- [ ] **E.5.2 — Run the ≥2h physical playback soak + defined sessions.**
  - [ ] At least two continuous hours of physical playback soak, no mutation.
  - [ ] At least three distinct physical sessions, separated by ≥30 min, including at least one after a controlled Bonob restart (spec §7.2 retention, criterion 20).
  - Gate: soak + sessions pass the §9 thresholds; any blocker triggers E.6.
  - Atomic commit: `git commit -m "docs(plan-e): physical playback soak + session matrix evidence"`.

---

## Slice E.6 — Rollback (on any failed gate)

Spec §8 (rollback) + criterion 21: "Failed gates restore exact prior state under criterion 18 before public/physical health is re-established."

- [ ] **E.6.1 — Execute the exact rollback command sequence on any failed post-promotion gate.**
  - [ ] On a failed gate, unexpected 401/429/5xx increase, cache incompatibility, stream regression, or Sonos failure: (1) stop new test traffic; (2) restore the previous digest + secret-compatible compose; (3) restore the hashed prior cache snapshot — **required** unless a recorded pre-rollback equality proof shows every current file/tree hash, envelope/schema result, ownership, and mode exactly equals the saved prior snapshot (any mismatch/missing/unreadable/validation failure forces restoration); (4) recreate Bonob and verify `/`, `/about`, SMAPI, cache load, physical browse/play; (5) preserve redacted candidate logs + failed release manifest.
  - [ ] Rollback does **not** alter Navidrome, nginx, DNS, Sonos Developer Portal registration, or the music library unless evidence identifies one as the actual fault. A secret in any output stops testing, quarantines the output, and rotates the credential (spec §8).
  - Gate (exact prior state restored per criterion 18):
    ```bash
    # post-rollback: image == prior digest; cache tree hashes == saved prior; /, /about, SMAPI ok
    ```
    Expected: prior state re-established.
  - Atomic commit (outcome only): `git commit -m "docs(plan-e): executed rollback to exact prior state (criterion 18)"`.

---

## Slice E.7 — Initial 24-hour observation window

Spec §7.2 + criterion 21: the initial promoted digest remains under observation ≥24 continuous hours and ≥3 distinct physical Sonos sessions.

- [ ] **E.7.1 — Observe 24 continuous hours against §9.**
  - [ ] Monitor for: no container restart or unhealthy event; no new unexplained authentication/429/5xx burst; no release-blocking regression.
  - [ ] Evaluate every auth/429/5xx signal by the §9 table; lower-severity issues require a recorded user+architect disposition before the window can pass (criterion 21).
  - Gate (24h passes; any §9 blocker triggers E.6 then a fresh run):
    ```bash
    # observation: uptime == continuous 24h; §9 evaluation recorded; dispositions recorded
    ```
    Expected: pass; or blocker → E.6.
  - Atomic commit: `git commit -m "docs(plan-e): initial digest completed 24h observation (criterion 21)"`.

- [ ] **E.7.2 — Hand off to Plan F field-stability threshold.**
  - [ ] Record that the same digest must next complete seven continuous days, ≥3 physical sessions, zero rollback, zero blocker, zero unattributed production error before Plan F may begin (spec §5.4, criterion 23). Plan F is blocked until that threshold is met.
  - Atomic commit: `git commit -m "docs(plan-e): hand off to Plan F seven-day field-stability threshold"`.

---

## Plan E exit checklist (spec §1.1 row E, criteria 18–21)

- [ ] Verified backup proves exact proxy/container/network/resource/security/health/compose/secret/cache/image state (criterion 18).
- [ ] Isolated restore rehearsal executed (not dry-run) and passed: auth/SMAPI/art/range/stream/cache restore verified (criterion 18).
- [ ] Explicit, separately-announced user approval recorded for container recreation (criterion 19).
- [ ] Promotion changed only the Bonob image reference to the tested digest; no secret/proxy/Navidrome/cache change in the same step.
- [ ] Read-only public gate passed; §9 evaluation recorded (criterion 21).
- [ ] Read-only physical Sonos gate passed: full matrix + ≥2h soak + 3 sessions incl. one after restart (criterion 20).
- [ ] Rollback rehearsed and available; on any failed gate, exact prior state restored per criterion 18.
- [ ] Initial digest completed 24 continuous hours with no §9 blocker; lower-severity dispositions recorded (criterion 21).
- [ ] Seven-day field-stability threshold recorded as the entry gate for Plan F (criterion 23).

## Adversarial-review focus for Plan E (report to Codex)

- Any step that performs a live action **before** E.0.2 explicit approval (hard stop).
- Any promotion that changes more than the image reference (secret/proxy/Navidrome/cache) — a §8 violation.
- Any restore-rehearsal accepted as a dry run rather than a real pass (criterion 18).
- Any rollback that skips cache restoration without a recorded exact pre-rollback equality proof (criterion 18).
- Any public/physical gate that mutates production state (spec §7.2.2–7.2.3, criterion 20).
- Any auth/429/5xx signal evaluated outside the single §9 decision table (spec §9).
- Any 24h-window pass recorded despite a §9 blocker without rollback+fresh-run (criterion 21).
- Reuse of a candidate digest/artifact across a changed code SHA (criterion 8) — should already be impossible post-Plan-D but re-checked at E.0.1.