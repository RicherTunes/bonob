# RicherTunes bonob private-fork convergence design

**Status:** Awaiting user review

**Date:** 2026-07-23

**Repository:** `RicherTunes/bonob`

## 1. Purpose and decision

RicherTunes will develop, release, and operate its own bonob fork until the changes have accumulated enough live Sonos evidence to be proposed upstream. During this period, `RicherTunes/bonob:master` is the production-candidate branch and the VPS runs only RicherTunes-built artifacts. No change is submitted upstream merely because it passes local tests; upstream proposals are a later, separately reviewed activity.

The work will converge in small, reversible releases:

1. make the current fork safe to publish under RicherTunes;
2. converge the proven 48 functional commits and this approved design onto `master`;
3. rebaseline dependencies and release/security controls;
4. improve runtime reliability and observability;
5. improve protocol correctness;
6. extract large modules only after behavior is protected by contract and live tests.

Every promoted artifact is built from a known commit, tested against the live topology without sharing production state, and deployed by immutable digest. A passing loopback sidecar is necessary evidence, but it is not evidence that public Sonos S2 traffic works.

### 1.1 Plan decomposition

This umbrella program is implemented in order as separately reviewed, testable plans and releases:

| Plan | Entry dependency | Deliverable | Required exit evidence |
|---|---|---|---|
| **A — Repository convergence** | User and architect approve this design; repository publication is frozen | Fail-closed repository safety, reviewed workflow integration, and `master` fast-forward | Freeze record; local build/test/audit; workflow diff review; ancestry checks; safe validation workflow passes with publication still locked |
| **B — Supply chain** | Plan A complete | Dependency/release security and private amd64 GHCR publication; **no VPS deployment** | Zero unapproved high/critical audit or image findings; immutable private tag/digest; anonymous pull fails; authorized VPS pull succeeds |
| **C — Runtime testability** | Plan B supplies a candidate digest | Safe live harness, 429 attribution/redaction, graceful shutdown, runtime diagnostics, and lifecycle soak | Cold/snapshot harness passes; forced 429 is safely attributed; shutdown/restart tests and defined soak thresholds pass |
| **D — Protocol correctness** | Plan C complete | Evidence-gated protocol fixes, each isolated behind a fixture or live reproduction | Per-fix red/green tests, raw protocol evidence, candidate sweep, and adversarial review; no production promotion |
| **E — Production validation** | Plans A–D complete and the intended Plan D candidate passes its gates | Mandatory restore rehearsal, approved VPS promotion/rollback, and physical Sonos acceptance | Verified backup/restore evidence, public and physical gates, physical playback soak, and initial observation window pass |
| **F — Maintainability** | Field-stability threshold met after Plan E | Behavior-preserving module extraction | Unchanged golden contracts, full tests/sweep, candidate evidence, and a new field-stability cycle before further extraction |

No plan may bundle a dependency major upgrade, protocol behavior change, module refactor, and live promotion together.

Plan C's graceful-shutdown and attribution/redaction gates are prerequisites for every post-convergence production promotion, including every protocol release produced by Plan D.

## 2. Current source and live baseline

### 2.1 Source baseline

- RicherTunes `master` is upstream bonob `v0.12.0` at `68a73b9`.
- The functional stack is exactly 48 linear commits after `68a73b9` and ends at `4db3d75`.
- The documentation-only commit that adds this specification follows `4db3d75`; therefore the branch is 49 commits ahead of `master` before safety work begins. The design does not depend on that documentation commit's hash.
- The stack contains the S2 authentication fixes, large-library browse/index work, XML sanitization, artwork and SSRF hardening, token scoping, cache persistence, timeout/retry behavior, and supporting tests already exercised on the VPS.
- Existing CI is unsafe for this fork: its publishing job targets `simojenki/bonob` on Docker Hub and GHCR. This must be corrected before `master` moves.
- Old feature and experiment branches are not an integration queue. Superseded branches are omitted. A dependency branch, including an Axios bump, is re-evaluated against the converged lockfile and current audit output rather than blindly cherry-picked.

### 2.2 Production topology

The supported topology is:

```text
Sonos S2 cloud/controller
  -> https://sonos.alexricher.com:443
  -> public-nginx container
  -> bonob:4534 on external Docker network dmz
  -> navidrome:4533 on dmz
  -> persistent Navidrome data and read-only music mounts
```

Operational details:

- The host also binds Bonob on `127.0.0.1:4534`.
- Bonob compose file: `/opt/homelab/docker/bonob/docker-compose.yml`.
- Current image: `richertunes:albums-4db3d75`.
- `BNB_URL=https://sonos.alexricher.com`.
- Sonos S2 is configured manually through the Sonos Developer Portal with OAuth. S1 discovery and auto-registration are disabled.
- `public-nginx` terminates CA-validated TLS, sends HSTS, does not put Authelia in the Sonos machine-to-machine path, applies `40r/s` with burst `80`, and sends its access log to CrowdSec.
- Bonob runs as `nobody` with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a 512 MiB memory limit, a 0.5 CPU limit, and a healthy container status.
- Bonob's cache bind is `/opt/homelab/docker/bonob/cache:/cache`; the host directory is mode `0700`, owned by uid/gid `65534`, and the persistent album index is under `/cache/index`.
- Navidrome is `0.62.0`. Its persistent data is `/srv/navidrome/data`; `/srv/music` and the HiRes library mount are read-only and backed by NFS over WireGuard.
- `BNB_SECRET` and other credentials live only in gitignored, owner- or root-readable environment/credential files. Values are never written to source, manifests, command lines, logs, or test reports.

### 2.3 Evidence and known gaps

The current live instance is healthy. Both `/` and `/about` have been verified, and the public TLS path is reachable. The Bonob cache contains 206 files totaling 51,284,718 bytes, including the persistent album index.

The previous 189-section SMAPI sweep cannot currently be repeated: `/root/bonob-e2e-token.json` is absent and the old script exits with `FileNotFoundError` before making a request. This is a harness failure, not evidence of either a Bonob regression or success. A recent burst of HTTP 429 responses is also real but unattributed because current logs do not identify the upstream integration that returned the status.

These two gaps—safe repeatable authentication and redacted upstream attribution—are repaired before heavy live testing.

## 3. Branch convergence and repository ownership

### 3.1 Fail-closed repository freeze

Before any safety-work commit is pushed, an owner must disable GitHub Actions for the RicherTunes fork and remove or revoke its Docker Hub publication secrets, tokens, and namespace authority. The freeze record captures the time, actor, repository Actions state, Actions default permissions, publication-environment state, and names—not values—of removed credentials. No tag, package, or image may be published while frozen.

With Actions disabled, the reviewed safety workflow is locally verified, pushed, and integrated. Before Actions is re-enabled, `master` is inspected to prove that every active image target is RicherTunes GHCR, no Docker Hub login/push remains, and untrusted events cannot publish. Actions is then re-enabled with read-only repository defaults and a protected `ghcr-publication` environment requiring explicit reviewer approval. A non-publishing validation workflow must pass on the integrated `master` before the protected publication environment can be authorized. Freeze, integration, re-enable, validation, and later publication evidence are retained in the Plan A release record.

### 3.2 Mandatory pre-convergence safety commit

The first implementation commit is made on `perf/artist-list-cache`, before `master` is advanced. It must:

- remove all active publishing to `simojenki/*` and all Docker Hub login/push behavior;
- publish only `ghcr.io/richertunes/bonob`;
- limit the initial image to `linux/amd64`;
- separate pull-request validation from trusted-branch publication so pull requests receive no registry credentials and cannot publish;
- grant the workflow only the minimum permissions required for checkout, attestations if enabled, and GHCR package publication;
- pin third-party GitHub Actions to reviewed full commit SHAs;
- use deterministic dependency installation from the committed lockfile;
- run type compilation, the complete test suite, production dependency audit, container build, and a non-secret container smoke check before publication;
- correct active RicherTunes repository/image metadata and remove examples that use a predictable `BNB_SECRET`;
- emit OCI source, revision, and creation labels that bind an image to its exact commit.

The safety commit is reviewed and all local gates pass on `perf/artist-list-cache`. Only then is `master` fast-forwarded with `--ff-only`. No squash, merge commit, rebase, or force-push is used, preserving the reviewed linear history. Plan A ends only after the non-publishing validation workflow passes on the safe integrated `master`; image publication remains locked for Plan B.

### 3.3 Dependency rebaseline

After convergence, dependencies are assessed from the new `master` rather than from stale Dependabot branches:

1. capture `npm audit` and `npm audit --omit=dev` results;
2. classify runtime versus development-only exposure;
3. update direct dependencies and the lockfile in the smallest compatible groups;
4. rerun compile, tests, production audit, image build, and smoke checks after each group;
5. require zero high/critical findings in the production dependency audit and container-image scan.

No audit finding is hidden by blanket suppression, and no major update is bundled with unrelated behavior changes. A high/critical exception is permitted only with user and architect approval before publication; the release record must name the advisory or image component, reachability evidence, compensating control, accountable owner, and explicit expiration date.

## 4. Private release lane

The sole initial artifact is a private amd64 GHCR image:

```text
ghcr.io/richertunes/bonob:sha-<40 lowercase hex>
ghcr.io/richertunes/bonob@sha256:<manifest-digest>
```

The tag must match `^sha-[0-9a-f]{40}$`. The publication workflow uses a concurrency lock keyed by publication ref with `cancel-in-progress: false`, queries GHCR before push, and refuses to overwrite the tag if it already exists with a different digest. After push it verifies the registry digest against the locally computed digest and the OCI revision against the source commit. The digest is authoritative. `latest`, floating environment tags, Docker Hub publication, and multi-architecture manifests remain disabled.

The secret-free release manifest records the tested commit and image digest; test/build result; dependency-audit and image-scan policies; audit/scanner tool names and versions; vulnerability-database identity and timestamp; scan start timestamp; and cryptographic hashes of the raw reports.

The GHCR package remains private. An unauthenticated pull must fail, while the VPS authenticates with a root-readable credential having package-read access only and must pull successfully. It verifies that the OCI revision label equals the intended commit and refuses deployment on a digest or revision mismatch. The locally built `richertunes:albums-4db3d75` image and its current configuration remain available until the new release has completed its observation window.

## 5. Implementation tracks

Each track is delivered as small branches from current RicherTunes `master`, with tests added before behavior changes and an independent review before merge.

### 5.1 Repository and release security

Plan A contains only the fail-closed freeze, pre-convergence safety workflow, and `master` fast-forward. Plan B begins after Plan A evidence is approved and implements the dependency rebaseline, private GHCR lane, action pinning, least-privilege publication environment, secret-safe examples, container scanning, and reproducible release metadata. Plan B publishes a candidate but does not deploy it.

CI must fail closed: a failed test, compilation, audit policy, scan, image build, or smoke check prevents publication. The production dependency audit and container-image scan must each report zero high/critical findings unless the pre-publication exception process in §3.3 is approved. Development-only advisories are still reported and either upgraded or explicitly risk-reviewed; their classification is not used to erase them from visibility.

### 5.2 Runtime reliability and observability

Graceful shutdown is required before the first new production promotion. On `SIGTERM` or `SIGINT`, Bonob must:

1. become unready and stop accepting new work;
2. stop starting cache refreshes and upstream retries;
3. allow active SOAP requests and streams to drain for a configured bounded interval;
4. destroy remaining streams and close the HTTP server when the interval expires;
5. flush or close cache writers without corrupting the last valid persisted index;
6. exit nonzero when shutdown cannot complete cleanly.

The compose stop grace period must exceed Bonob's drain interval. Tests cover a normal request, a long stream, forced expiry, signal idempotence, and restart loading of the existing cache.

Outbound request logging gains a generated correlation ID and a fixed integration label such as `navidrome`, `deezer`, `lastfm`, or `proxy`. Completion logs contain only integration, status, latency, retry attempt, outcome class, and correlation ID. URLs, query strings, authorization, cookies, headers, usernames, tokens, track/album/artist metadata, and response bodies are prohibited. Redaction tests exercise both success and failure paths, including 429, timeout, DNS, TLS, and malformed-response errors.

Internal diagnostics report cache schema/load status, file/entry counts, last successful refresh, refresh-in-progress state, upstream timing aggregates, active requests, and active streams. They expose no library metadata or credentials and are available only through loopback or a protected operator path, never the public Sonos vhost.

Plan C also implements a minimum two-hour automated soak containing at least 1,000 mixed open/play/range/seek/stop/disconnect stream lifecycle cycles. RSS, active handles, and sockets are sampled every 10 seconds. After a 30-minute warmup, the warm baseline is the median of its final five minutes; the final load value is the median of the final five minutes of the two-hour/1,000-cycle load; and a five-minute cooldown ends with a post-cooldown median over its final two minutes. Final-load RSS growth over the warm baseline must be at most 64 MiB. Post-cooldown handles and sockets must each be within 10% of their warm baseline; when a baseline is zero, the corresponding absolute post-cooldown count must be at most two and every remaining handle/socket individually explained. There must be zero unhandled rejection, crash, or cache corruption.

### 5.3 Protocol correctness

Protocol fixes are evidence-driven:

- **Issue #297, playlist editing:** reproduce and fix the verified metadata error. Playlist `mediaCollection` elements that are valid mutation targets advertise `readOnly="false"` and `userContent="true"` on the correct collection, while non-mutable containers remain read-only. Raw SOAP fixtures and a disposable live playlist prove add/remove behavior without touching personal playlists.
- **Issue #284, separate-file artwork:** do not infer a Bonob defect from the report. First add a fixture matching Navidrome's response for external `cover.jpg` artwork and reproduce the complete `/art` request, content type, body, and cache behavior. A code change is allowed only if the fixture fails at the Bonob boundary; otherwise the finding becomes a Navidrome or deployment diagnostic.
- **Issue #229, stream `HEAD`:** the current code already handles `HEAD` without sending a body or reporting now-playing. Preserve it with regression tests for authentication, status, content headers, and range behavior; do not reimplement it.
- **Issue #214, SOAP version:** assert the raw HTTP response bytes and content type for representative faults. Object-level deserialization is insufficient because it can hide SOAP 1.1 versus 1.2 envelope differences. Any change must retain Sonos fault codes and pass both raw fixtures and physical S2 authentication/error tests.
- **Issues #246, #254, and #255, deployment/connectivity:** treat these first as documentation and diagnostics. The S2 guide must distinguish public HTTPS ingress, Developer Portal registration, proxy/rate-limit behavior, advertised versus reachable URLs, and IPv4/IPv6 reachability. No speculative network workaround enters runtime code without a reproduction.
- **Issue #164, suspected TCP/memory leak:** use Plan C's lifecycle soak to establish a repeatable baseline before changing lifecycle code. A fix requires before/after results against every defined soak threshold.

The track also covers playlist metadata, artwork fallbacks, SOAP faults, stream `HEAD` and ranges, search, favourites, and retry safety. Mutations are never automatically retried.

### 5.4 Behavior-preserving module extraction

Large `smapi.ts` and `subsonic.ts` extractions begin only after field stability: seven continuous days on the same production digest, at least three distinct physical Sonos sessions, zero rollback, zero open release blocker, and zero unattributed production error. The work separates protocol serialization, authentication, browse/query orchestration, caching, upstream transport, and streaming behind existing interfaces. Golden SOAP/HTTP fixtures, the full unit suite, the safe sweep, and physical acceptance must remain unchanged. Refactoring is never combined with a protocol feature or dependency major update.

## 6. Safe live-test harness

The replacement harness is version-controlled as `scripts/bonob-e2e-sweep.ts`. It authenticates through Bonob's real browser-link flow:

1. call `getAppLink`;
2. submit the link code to `/login` using the dedicated Navidrome smoke account;
3. call `getDeviceAuthToken`;
4. retain the resulting tokens in process memory only;
5. traverse the configured read-only SMAPI sections serially with bounded request and run timeouts.

The smoke identity is a dedicated, uniquely credentialed, non-admin Navidrome account. It is separate from the production Sonos integration account and every personal account, cannot access their playlists or favourites, and may mutate only data it created with the test prefix. Before the harness is accepted, operators must demonstrate and record account disable/revoke, password rotation, credential-file replacement, and successful re-authentication without affecting production Sonos or personal sessions.

Credentials come from an already-open file descriptor (`--credentials-fd`) or an owner-only file (`--credentials-file`, mode `0600` or stricter). The preferred VPS invocation opens a root-owned file under `/run/credentials` on a numbered descriptor; no less restrictive transport is accepted. Usernames, passwords, link codes, tokens, full URLs, response bodies, and media metadata are never printed, persisted, placed in arguments, or included in exceptions. The legacy `/root/bonob-e2e-token.json` contract is removed.

The default run is serial, bounded, read-only, and aggregate-only. It reports section counts, status classes, timings, failures by opaque test case, and a final pass/fail result. Mutation mode requires an explicit flag and operates only on a newly created playlist with a unique `bonob-smoke-` prefix; it verifies before/after state and deletes the disposable playlist even on failure. It never edits or deletes a pre-existing playlist.

The harness accepts two distinct URL concepts:

- **canonical origin:** `https://sonos.alexricher.com`, which the candidate uses to generate Sonos-facing SOAP, artwork, and stream URLs;
- **transport base:** the loopback address of the candidate.

For a candidate run, the harness rewrites only URLs whose origin exactly equals the canonical origin to the candidate transport base, preserving path and query. It rejects any other generated origin. This ensures SOAP, artwork, and stream requests remain owned by the same candidate process instead of accidentally returning to production. The rewrite proves application behavior only; it deliberately bypasses public DNS, TLS, nginx, CrowdSec, and the Sonos cloud.

A sweep is not started while an index refresh is in progress. The harness aborts cleanly on auth failure, malformed XML, unexpected origin, rate limiting, transport failure, or its global deadline and leaves production untouched.

## 7. Candidate validation and promotion

### 7.1 Isolated candidate

Each candidate runs on a new loopback port and Docker project name, using the exact GHCR digest intended for production. It joins only the networks needed to reach Navidrome. It never mounts the production Bonob cache read-write.

Two candidate runs are required:

1. **cold cache:** an empty release-specific directory verifies first-use behavior, bounded failures, and index creation;
2. **snapshot cache:** a validated disposable copy of the production cache verifies schema compatibility, restart loading, and background refresh behavior.

The snapshot is copied while writers are quiescent or through a cache-consistent mechanism, ownership/mode are corrected on the copy, and file count/bytes/checksum are recorded. Candidate writes go only to the copy. A corrupt or incompatible copy must produce an actionable error and a safe cold rebuild; it must not damage or silently replace the source snapshot.

### 7.2 Separate evidence gates

Promotion requires all three layers:

1. **Synthetic candidate gate:** compile, unit/chaos/contract tests, cold-cache run, snapshot-cache run, safe SMAPI sweep, artwork and stream `HEAD`/range checks, graceful-shutdown test, restart, and redaction verification.
2. **Public production gate after promotion:** CA/TLS validation, nginx configuration test, `/` and `/about`, OAuth/login/SMAPI routes, public safe sweep, rate-limit/CrowdSec sanity, upstream attribution, and restart recovery.
3. **Physical Sonos S2 gate:** browse root and large album buckets, artists and bios, search, artwork, start playback, seek, stop, replay, favourites, playlists including disposable add/remove, queued-media behavior, and post-restart cache persistence on the actual LAN speakers/controller. It includes at least two continuous hours of physical playback soak.

No sidecar result is described as S2 end-to-end success. Physical acceptance is recorded by the operator after the public promotion.

The initial promoted digest remains under observation for at least 24 continuous hours and at least three distinct physical Sonos sessions. The window passes only with no container restart or unhealthy event, no new unexplained authentication, 429, or 5xx burst, and no release-blocking regression.

An unexpected burst is at least five authentication failures, 429s, or 5xx responses for the same integration/outcome within any 60-second window. A release-blocking regression is any secret exposure, data-integrity issue, crash/unhealthy/restart event, failure of a supported browse/search/art/playback/playlist path, or that numeric unexpected burst. A lower-severity nonfunctional issue requires a recorded user and architect disposition before promotion or observation can pass.

## 8. Deployment, backup, maintenance, and rollback

Bonob stream and artwork access tokens are process-local. Recreating the container can invalidate URLs already queued by Sonos even when `BNB_SECRET` is unchanged. Initial promotions therefore use a short announced maintenance window. Playback is stopped first, and users re-browse/requeue after promotion. Graceful shutdown prevents abrupt in-flight termination but does not make old queued URLs portable to the new process.

Before any production container recreation:

- identify the exact current image ID/digest and confirm it is locally present or pullable;
- save the effective compose configuration and the actual nginx file, with hashes;
- save the proxy target, container inspection, Docker networks, resource limits, security settings, and health configuration;
- back up the secret-compatible environment/credential files without printing values, and record root-only fingerprints so the rollback uses the same `BNB_SECRET`;
- capture cache schema, file count, byte count, ownership/mode, and a consistent cache snapshot;
- run and verify the VPS backup, recording the successful backup/snapshot identifier;
- validate that the backup contains the saved nginx file, container inspection, Docker network/resource/security/health settings, available previous image, compose configuration, secret-compatible environment/credentials, and cache snapshot;
- perform a mandatory isolated restore rehearsal: restore disposable copies of the saved compose, environment, and cache state; start the previous image in a non-production project/loopback binding; verify health, `/`, `/about`, cache schema/count/checksum integrity, and clean stop; record the commands and results. A dry run is insufficient, and the rehearsal must pass;
- confirm the previous public health and current physical Sonos baseline.

Production container recreation is a separately announced risky deployment gate. It requires explicit user approval after the exact candidate digest, evidence summary, maintenance impact, verified VPS backup, and rollback command have been presented. Approval of this design does not authorize a future container recreation.

Promotion changes only the Bonob image reference to the tested digest unless a separately reviewed configuration change is essential. It does not rotate `BNB_SECRET`, change proxy policy, migrate Navidrome, or mutate the production cache in the same step. After graceful stop and recreation, the public and physical gates run immediately.

On any failed post-promotion gate, unexpected 401/429/5xx increase, cache incompatibility, stream regression, or Sonos failure:

1. stop new test traffic;
2. restore the previous digest and its secret-compatible compose configuration;
3. restore the previous cache state if the new process changed it incompatibly;
4. recreate Bonob, verify `/`, `/about`, SMAPI, cache load, and a physical browse/play;
5. preserve redacted candidate logs and the failed release manifest for diagnosis.

Rollback does not alter Navidrome, nginx, DNS, Sonos Developer Portal registration, or the music library unless evidence identifies one of them as the actual fault. If a secret appears in any output, testing stops, the output is quarantined, and the affected credential is rotated before work resumes.

## 9. Error-handling and release accountability

- Pre-promotion failures leave the current production container untouched.
- Automation stops on the first failed command and never silently substitutes a tag, cache, credential source, endpoint, or architecture.
- Timeouts have explicit error classes; expected degradation paths remain distinguishable from auth, mutation, and data-integrity failures.
- Retry policy is bounded and limited to demonstrably safe read operations. HTTP 4xx responses and mutations are not retried.
- A failed cache load preserves the last valid file and either serves stale data or performs a deliberate cold rebuild; partial writes use atomic replacement.
- Any unexplained 429, memory growth, socket growth, malformed SOAP, or cross-process URL is a release blocker until attributed or explicitly rolled back.
- Every implementation slice receives adversarial review. The lead agent owns scope, integration decisions, evidence quality, release manifests, and the final completion claim.

## 10. Delegation governance

Bounded implementation and focused test/documentation work go to the cheapest capable worker: Luna when available, otherwise an explicitly disclosed light GLM worker. GLM-5.2 with the 1M context window is reserved for repository-wide or history-heavy tasks that require that context. Terra handles complex protocol, security, runtime, and deployment investigation or review. The lead agent does not outsource release judgment: it performs adversarial integration review, checks evidence freshness, prevents scope drift, and remains accountable for a clean deliverable.

Model output is never treated as verification. Each change requires executable tests or live evidence, a clean diff review, and an independent architectural/adversarial sign-off before it can be described as complete.

## 11. Non-goals

- Publishing images or packages under `simojenki/*`.
- Publishing to Docker Hub, publishing `latest`, or building non-amd64 images during private testing.
- Opening or updating upstream pull requests as part of convergence.
- Merging stale experimental branches wholesale.
- Replacing Navidrome, altering the music library/NFS topology, or changing Sonos Developer Portal identity.
- Zero-interruption or blue/green Sonos token continuity; the initial design uses a maintenance window.
- Sharing a writable cache between production and a candidate.
- Load-testing public ingress aggressively or bypassing CrowdSec/rate limits.
- Broad SMAPI/Subsonic rewrites before contract and field stability.
- Treating issue reports as confirmed Bonob bugs without a fixture or live reproduction.

## 12. Acceptance criteria

Every criterion below is required. A criterion may be marked not applicable only when its reason and scope are recorded and both the user and architect approve that exception before execution begins.

1. The user and architect approve this design before Plan A implementation.
2. Before safety work is pushed, GitHub Actions is disabled, Docker Hub secrets/authority are removed or revoked, freeze evidence is recorded, and no tag/package/image is published during the freeze.
3. The reviewed safety workflow passes locally while frozen; safe `master` contains only RicherTunes GHCR targets; Actions is re-enabled with read-only defaults and protected `ghcr-publication`; and a non-publishing validation workflow passes before publication is authorized.
4. Before safety work, the branch is proven 49 commits ahead of `68a73b9`: 48 functional commits ending at `4db3d75` plus the documentation-only commit that added this path. `master` then fast-forwards without rewritten history through `4db3d75`, the commit returned by `git log --diff-filter=A --format=%H -- docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, and the safety commit. `git merge-base --is-ancestor 4db3d75 master` and the same check for the discovered specification commit both succeed.
5. Active workflows, package metadata, and release documentation contain no `simojenki/*` publication target, Docker Hub push, predictable secret, or floating production image.
6. Compilation, the full test suite, deterministic install, amd64 image build, and smoke start pass. Production dependency audit and image scan each contain zero high/critical findings, or every exception names the advisory/image component, reachability evidence, compensating control, owner, and expiration and has prior user and architect approval. The manifest records audit/scanner names and versions, vulnerability-database identity/timestamp, scan start, policies, and raw-report hashes.
7. GHCR visibility is private; the tag matches `sha-<40 lowercase hex>`/`^sha-[0-9a-f]{40}$`; publication is concurrency-locked per ref with cancellation disabled; a conflicting tag is refused; and post-push registry digest and OCI revision equal the local digest and source commit. Anonymous pull fails, authorized VPS pull succeeds, and deployment input is the authoritative digest.
8. The smoke account is uniquely credentialed and non-admin, separate from production Sonos and personal accounts, unable to access their playlists/favourites, restricted to test-owned mutation data, and transported only through a root-only FD/file. Disable/revoke, rotate, replace, and re-authenticate are demonstrated without affecting other sessions.
9. The safe harness persists no token, emits aggregate-only output, rejects unexpected origins, and passes against both cold and disposable snapshot caches without production writes.
10. Candidate SOAP, artwork, and stream URLs return to the candidate through exact-origin rewrite; no candidate test accidentally exercises the production process.
11. Logs attribute a forced upstream 429 to integration and correlation ID while redaction tests prove secrets, URLs/query strings, headers, tokens, and media metadata are absent.
12. Graceful shutdown drains or bounds active work, closes streams, preserves a valid cache, and restarts within the Docker grace period. Plan C shutdown and attribution/redaction evidence exists before every post-convergence production promotion, including protocol releases.
13. The automated lifecycle soak runs for at least two hours and 1,000 mixed stream cycles with 10-second samples. Its warm baseline is the median of the final five minutes after 30-minute warmup; final load is the final-five-minute median; post-cooldown is the final-two-minute median after five-minute cooldown. RSS growth is at most 64 MiB; post-cooldown handles/sockets are within 10% of baseline, or at most two and individually explained when baseline is zero; and unhandled rejections, crashes, and cache corruption are zero.
14. Issue #297 has raw SOAP tests and successful disposable-playlist mutation evidence; #284 is fixture-classified; #229 remains regression-covered; #214 is asserted as raw SOAP; #246/#254/#255 have corrected deployment diagnostics; and #164 meets the defined soak thresholds.
15. The verified backup contains the saved nginx file, container inspection, Docker network/resource/security/health settings, available previous image, compose, secret-compatible environment/credentials, and cache. Mandatory isolated restore/start/health/cache-integrity rehearsal with disposable copies passes.
16. The user explicitly approves the separately announced container-recreation gate after reviewing the exact digest, candidate evidence, maintenance impact, verified backup, and rehearsed rollback.
17. The promoted digest passes public TLS/routes and the safe sweep, then physical Sonos browse, search, art, playback, seek, favourites, disposable playlist mutation, requeue, restart/cache persistence, and at least two continuous hours of physical playback soak.
18. The initial promoted digest completes at least 24 continuous observation hours and three distinct physical Sonos sessions with no restart/unhealthy event or release blocker. A burst is at least five same-integration/outcome auth failures, 429s, or 5xx responses in 60 seconds. Any secret/data-integrity issue, crash/unhealthy/restart, supported browse/search/art/playback/playlist failure, or numeric burst blocks release; every lower-severity nonfunctional issue has recorded user and architect disposition.
19. Any failed gate restores the prior image/configuration/cache state and re-establishes public and physical health before further development.
20. Before Plan F, the same production digest completes seven continuous days with at least three distinct physical Sonos sessions, zero rollback, zero open release blocker, and zero unattributed production error.
21. An independent adversarial/architectural review approves the final branch and fresh evidence set, with no pending release blocker or unexplained live behavior.
