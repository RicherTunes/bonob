# RicherTunes bonob private-fork convergence design

**Status:** Awaiting re-review

**Date:** 2026-07-23

**Repository:** `RicherTunes/bonob`

## 1. Purpose and decision

RicherTunes will develop, release, and operate its own bonob fork until the changes have accumulated enough live Sonos evidence to be proposed upstream. During this period, `RicherTunes/bonob:master` is the production-candidate branch and the VPS runs only RicherTunes-built artifacts. No change is submitted upstream merely because it passes local tests; upstream proposals are a later, separately reviewed activity.

The work will converge in small, reversible releases:

1. make the current fork safe to publish under RicherTunes;
2. converge the proven 48 pre-spec commits and this reviewed design onto `master`;
3. rebaseline dependencies and release/security controls;
4. improve runtime reliability and observability;
5. improve protocol correctness;
6. extract large modules only after behavior is protected by contract and live tests.

Every promoted artifact is built from a known commit, tested against the live topology without sharing production state, and deployed by immutable digest. A passing loopback sidecar is necessary evidence, but it is not evidence that public Sonos S2 traffic works.

### 1.1 Plan decomposition

This umbrella program is implemented in order as separately reviewed, testable plans and releases:

| Plan | Entry dependency | Deliverable | Required exit evidence |
|---|---|---|---|
| **A — Repository convergence** | User and architect approve this design | Freeze and revoke all publication authority; integrate the non-publishing safety workflow; fast-forward `master`; validate only the exact integrated SHA | Freeze/inventory record; local gates; ancestry checks; manually dispatched non-publishing validation bound to the exact integrated SHA; publication remains disabled |
| **B — Supply chain** | Plan A complete and approved | Dependency/release security; build-once provenance; private amd64 GHCR publication; **no VPS deployment** | Exact manifest is tested/scanned/pushed unchanged; zero unapproved high/critical findings; immutable private tag/digest; anonymous pull fails; authorized VPS pull succeeds |
| **C — Runtime testability** | Plan B supplies an exact-master candidate digest | Lifecycle coordinator and cancellation/registry seams first, then safe harness, attribution/redaction, graceful shutdown, cache diagnostics, and lifecycle soak | Every code slice has a new exact-master artifact/gate set; cold/snapshot harness, network sentinel, forced 429, shutdown/restart, and defined soak thresholds pass |
| **D — Protocol correctness** | Plan C complete | Evidence-gated protocol fixes, each isolated behind a fixture or live reproduction | Every code slice has a new exact-master artifact/gate set; per-fix red/green tests, raw protocol evidence, candidate sweep, and adversarial review; no production promotion |
| **E — Production validation** | Plans A–D complete and the intended Plan D candidate passes its gates | Mandatory restore rehearsal, approved VPS promotion/rollback, and physical Sonos acceptance | Verified backup/restore evidence, public and physical gates, physical playback soak, and initial observation window pass |
| **F — Maintainability** | Field-stability threshold met after Plan E | Behavior-preserving module extraction | Unchanged golden contracts, full tests/sweep, candidate evidence, and a new field-stability cycle before further extraction |

No plan may bundle a dependency major upgrade, protocol behavior change, module refactor, and live promotion together.

Plan C's graceful-shutdown and attribution/redaction gates are prerequisites for every post-convergence production promotion, including every protocol release produced by Plan D.

## 2. Current source and live baseline

### 2.1 Source baseline

- RicherTunes `master` is upstream bonob `v0.12.0` at `68a73b9`.
- The pre-spec stack is exactly 48 linear commits after `68a73b9` and ends at `4db3d75`.
- The design history then contains `af60e93` and its non-amending correction `5a83fb4`; immediately before the amendment containing this text, the branch is exactly 50 commits ahead of `68a73b9`.
- Counts are historical context, not the safety gate. After adversarial approval, Plan A discovers `DESIGN_SHA` with `git log -1 --format=%H -- docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, records that exact SHA and file hash in the approval, and requires it to be an ancestor of both the safety commit and final `master`. Any later modification of this path invalidates the approval and requires another adversarial review before safety work.
- The stack contains the S2 authentication fixes, large-library browse/index work, XML sanitization, artwork and SSRF hardening, token scoping, cache persistence, timeout/retry behavior, and supporting tests already exercised on the VPS.
- Existing CI is unsafe for this fork: its publishing job targets `simojenki/bonob` on Docker Hub and GHCR. This must be corrected before `master` moves.
- Old feature and experiment branches are not an integration queue. Superseded branches are omitted. A dependency branch, including an Axios bump, is re-evaluated against the converged lockfile and current audit output rather than blindly cherry-picked.

### 2.2 Production topology

The supported topology is:

```text
Sonos S2 cloud/controller
  -> private CA-validated HTTPS origin on TCP/443
  -> edge reverse-proxy container
  -> production Bonob on an isolated ingress network
  -> Navidrome on a private service network
  -> persistent Navidrome data and read-only music mounts
```

Operational details:

- The host exposes Bonob only through a loopback bind and the edge proxy.
- The current deployment was built from source commit `4db3d75`.
- The configured public Bonob origin, compose path, bind ports, service/container names, network names, and host paths are retained only in a root-readable operator inventory outside this public repository.
- Sonos S2 is configured manually through the Sonos Developer Portal with OAuth. S1 discovery and auto-registration are disabled.
- The edge proxy terminates CA-validated TLS, sends HSTS, leaves the required Sonos machine-to-machine paths free of interactive authentication, applies a bounded rate limit, and emits security access logs.
- Bonob runs as an unprivileged identity with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, bounded CPU/memory, and a health check; exact runtime values remain in the private operator inventory.
- Bonob's persistent cache bind is mode `0700` and owned by the unprivileged runtime identity; its exact path is private operator data.
- Navidrome is `0.62.0`; its data is persistent and its media mounts are read-only. Backend storage and tunnel details are private operator data.
- `BNB_SECRET` and other credentials live only in gitignored, owner- or root-readable environment/credential files. Values are never written to source, manifests, command lines, logs, or test reports.

### 2.3 Evidence and known gaps

The current live instance is healthy. Both `/` and `/about` have been verified, the public TLS path is reachable, and a persistent album index is present. Exact hostnames, IPs, service identifiers, host/VPS paths, certificate details, cache counts/hashes, and credential locations belong in the root-readable operator inventory, not this public specification.

The previous 189-section SMAPI sweep cannot currently be repeated because its external persisted-token file is absent and the old script exits with `FileNotFoundError` before making a request. This is a harness failure, not evidence of either a Bonob regression or success. A recent burst of HTTP 429 responses is also real but unattributed because current logs do not identify the upstream integration that returned the status.

These two gaps—safe repeatable authentication and redacted upstream attribution—are repaired before heavy live testing.

### 2.4 Public redaction gate

Every change to this public specification or public evidence runs a nonwaivable full-file and diff-aware redaction/secret scan before commit or publication. The versioned deny policy rejects exact hostnames, IP addresses, service/container/network names, host/VPS paths, credential locations or values, and other topology identifiers. Operator inventories and raw evidence remain outside the repository. The public attestation records only content/diff/policy hashes and pass/fail outcome; it never records matched values. A finding fails the gate and is remediated privately before rescanning.

## 3. Branch convergence and repository ownership

### 3.1 Fail-closed repository freeze

Before any safety-work commit is pushed, an owner must cancel queued jobs, cancel or allow running jobs to drain, verify that no job remains active, and disable GitHub Actions for the RicherTunes fork. The owner inventories and removes every GHCR and Docker Hub writer/admin path, including repository, package, organization, team, and inherited permissions; Actions/environment secrets; PATs; deploy keys; GitHub Apps; OIDC trust; external bots; and other automation credentials. Docker Hub namespace authority is revoked. The freeze record captures time, actor, job state, repository/organization/package permission exports, Actions defaults, environments, integrations, and credential names—not values. No tag, package, or image may be published while frozen.

With Actions disabled, Plan A locally verifies, pushes, and integrates only the safety/validation workflow. Before Actions is re-enabled, `master` is inspected to prove that every future image target is RicherTunes GHCR, no Docker Hub login/push remains, and untrusted events cannot publish. Actions is then re-enabled with read-only repository defaults; package write remains unavailable. A non-publishing `workflow_dispatch` accepts one full lowercase commit SHA, verifies it equals the integrated `master` head, checks out that SHA, and fails if checked-out `HEAD` differs. The exact-SHA validation must pass before Plan A can close. Plan B alone creates the protected `ghcr-publication` environment, grants its narrowly scoped writer, and authorizes publication. Freeze, integration, exact-SHA validation, and later Plan B publication evidence are retained separately.

### 3.2 Mandatory pre-convergence safety commit

The first implementation commit is made on `perf/artist-list-cache`, before `master` is advanced. It must:

- remove all active publishing to `simojenki/*` and all Docker Hub login/push behavior;
- set `ghcr.io/richertunes/bonob` as the only future publication destination without publishing in Plan A;
- limit the initial image to `linux/amd64`;
- separate pull-request validation from trusted-branch publication so pull requests receive no registry credentials and cannot publish;
- keep Plan A workflow permissions read-only and reserve GHCR package write for Plan B's protected environment;
- pin third-party GitHub Actions to reviewed full commit SHAs;
- configure checkout with `persist-credentials: false`, accept revision only from the validated exact-SHA input, and verify `HEAD` before any build;
- exclude `.git`, `.git/credentials`, `.env*`, credential/secret files, operator inventories, and build outputs from the Docker build context;
- use deterministic dependency installation from the committed lockfile;
- run type compilation, the complete test suite, production dependency audit, container build, and a non-secret container smoke check before publication;
- correct active RicherTunes repository/image metadata; make active templates/operator documentation reject `simojenki/*`, Docker Hub, `latest`, and predictable `BNB_SECRET` examples;
- emit OCI source, revision, and creation labels that bind an image to its exact commit.

The Docker input is not the repository root. A version-controlled closed allowlist generates a deterministic context from the clean exact-SHA checkout and fails on any required but unlisted file. It emits a sorted listing of normalized relative path, mode, size, and content hash plus a deterministic archive hash. A local prohibited-path and secret scan of that generated context must pass before any remote builder, registry, or cache is contacted; failures produce no remote access. The builder receives only the scanned archive. `.git`, `.git/credentials`, operator files, credentials, and any non-allowlisted path cannot enter the context.

The safety commit is reviewed and all local gates pass on `perf/artist-list-cache`. Only then is `master` fast-forwarded with `--ff-only`. No squash, merge commit, rebase, or force-push is used, preserving the reviewed linear history. Plan A ends only after the non-publishing dispatch validates the exact integrated `master` SHA; every registry writer remains revoked until Plan B establishes the protected publisher.

### 3.3 Dependency rebaseline

After convergence, dependencies are assessed from the new `master` rather than from stale Dependabot branches:

1. capture `npm audit` and `npm audit --omit=dev` results;
2. classify runtime versus development-only exposure;
3. update direct dependencies and the lockfile in the smallest compatible groups;
4. rerun compile, tests, production audit, image build, and smoke checks after each group;
5. require zero high/critical findings in the production dependency audit and container-image scan.

No audit finding is hidden by blanket suppression, and no major update is bundled with unrelated behavior changes. A high/critical exception is permitted only with user and architect approval before publication; the release record must name the advisory or image component, reachability evidence, compensating control, accountable owner, approval reference, and explicit expiration date. The workflow enforces those fields through a versioned exception allowlist keyed to exact advisory/component identity and fails on missing, unmatched, broadened, or expired entries.

## 4. Private release lane

The sole initial artifact is a private amd64 GHCR image:

```text
ghcr.io/richertunes/bonob:sha-<40 lowercase hex>
ghcr.io/richertunes/bonob@sha256:<manifest-digest>
```

Plan B builds exactly once from the validated `master` SHA into a checksummed OCI layout/archive. Source tests run from that checkout; image smoke tests, SBOM generation, and image scans run against that exact manifest. The workflow pushes the same retained bytes without rebuilding, then verifies the registry manifest digest and OCI revision against the local artifact and source SHA. Dockerfile base images are pinned by digest. Blanket or nondeterministic `apt upgrade` is prohibited; any OS package install uses a recorded snapshot/index identity and pinned package versions.

The Plan B publisher accepts only a full SHA that equals the remote `master` ref at dispatch. It re-fetches and requires `master == requested SHA` immediately before protected-environment publication and again after registry digest/revision verification. A pre-push mismatch aborts without publication. A post-push mismatch fails and quarantines the artifact from deployment pending a fresh exact-master run and recorded disposition.

Build caches are private, trusted-branch-only, scoped by destination SHA and build-definition/lockfile hashes, and never restored from or written by an untrusted pull request. Secrets never enter build arguments, environment, layers, cache mounts, metadata, or intermediate stages. Exported caches and intermediates are treated as sensitive artifacts, access-controlled, retained for a bounded period, and included in secret/provenance scanning before reuse.

The tag must match `^sha-[0-9a-f]{40}$`. The publication workflow has a concurrency lock keyed by the full destination repository plus SHA tag, with `cancel-in-progress: false`. Plan B removes every other registry writer before granting one protected-environment publisher. A first run refuses a conflicting existing tag. A rerun with an existing tag adopts it only when the retained local/release-manifest digest and OCI revision match; it verifies the registry object without rebuilding or pushing. After a new push, it performs the same verification. The digest is authoritative. `latest`, floating environment tags, Docker Hub publication, and multi-architecture manifests remain disabled.

The secret-free release manifest records the tested commit and image digest; test/build result; dependency-audit and image-scan policies; audit/scanner tool names and versions; vulnerability-database identity and timestamp; scan start timestamp; and cryptographic hashes of the raw reports.

The GHCR package remains private. An unauthenticated pull must fail, while the VPS authenticates with a root-readable credential having package-read access only and must pull successfully. It verifies that the OCI revision label equals the intended commit and refuses deployment on a digest or revision mismatch. A checksummed archive of the pre-convergence image built from `4db3d75`, or its proven immutable pullable digest, and its current configuration remain available until the new release has completed its observation window.

Every code-changing slice in Plans C and D starts from the exact current `master`, repeats deterministic build, source tests, production audit, exact-manifest scan, image smoke, isolated candidate tests, and digest verification, and produces a new immutable digest. Evidence from an earlier code SHA cannot promote a later one.

## 5. Implementation tracks

Each track is delivered as small branches from current RicherTunes `master`, with tests added before behavior changes and an independent review before merge.

### 5.1 Repository and release security

Plan A contains only the fail-closed freeze, pre-convergence safety workflow, and `master` fast-forward. Plan B begins after Plan A evidence is approved and implements the dependency rebaseline, private GHCR lane, action pinning, least-privilege publication environment, secret-safe examples, container scanning, and reproducible release metadata. Plan B publishes a candidate but does not deploy it.

CI must fail closed: a failed test, compilation, audit policy, scan, image build, or smoke check prevents publication. The production dependency audit and container-image scan must each report zero high/critical findings unless the pre-publication exception process in §3.3 is approved. Development-only advisories are still reported and either upgraded or explicitly risk-reviewed; their classification is not used to erase them from visibility.

### 5.2 Runtime reliability and observability

Plan C begins with a behavior-preserving application factory and lifecycle coordinator. The factory constructs the HTTP app without binding a listener; the coordinator owns listener start/stop, a shared cancellation signal, cache refresh/writer quiescence, and explicit registries for active requests, streams, sockets, and background tasks. All outbound work and cache refresh paths observe the shared cancellation signal. Shutdown, harness, and soak evidence is invalid until these ownership seams and registry invariants have focused tests.

Graceful shutdown is required before the first new production promotion. On `SIGTERM` or `SIGINT`, Bonob must:

1. become unready and stop accepting new work;
2. broadcast cancellation and stop starting cache refreshes, background work, and upstream retries;
3. quiesce cache writers and allow registered SOAP requests and streams to drain for a configured bounded interval;
4. destroy registered streams/sockets and close the HTTP server when the interval expires;
5. close cache writers without corrupting the last valid persisted index;
6. exit nonzero when shutdown cannot complete cleanly.

The compose stop grace period must exceed Bonob's drain interval. Tests cover a normal request, a long stream, forced expiry, signal idempotence, and restart loading of the existing cache.

Outbound request logging gains a generated correlation ID and a fixed integration label such as `navidrome`, `deezer`, `lastfm`, or `proxy`. Completion logs contain only integration, status, latency, retry attempt, outcome class, and correlation ID. URLs, query strings, authorization, cookies, headers, usernames, tokens, track/album/artist metadata, and response bodies are prohibited. Redaction tests exercise both success and failure paths, including 429, timeout, DNS, TLS, and malformed-response errors.

Internal diagnostics report cache schema/load status, file/entry counts, last successful refresh, refresh-in-progress state, upstream timing aggregates, active requests, and active streams. They expose no library metadata or credentials and are available only through loopback or a protected operator path, never the public Sonos vhost.

Plan C also implements a minimum two-hour automated soak containing at least 1,000 mixed open/play/range/seek/stop/disconnect stream lifecycle cycles. RSS, active handles, and sockets are sampled every 10 seconds. After a 30-minute warmup, the warm baseline is the median of its final five minutes; the final load value is the median of the final five minutes of the two-hour/1,000-cycle load; and a five-minute cooldown ends with a post-cooldown median over its final two minutes. Final-load RSS growth over the warm baseline must be at most 64 MiB. Post-cooldown handles and sockets must each be within 10% of their warm baseline; when a baseline is zero, the corresponding absolute post-cooldown count must be at most two and every remaining handle/socket individually explained. There must be zero unhandled rejection, crash, or cache corruption.

The soak must complete at least 99.5% of expected-success cycles successfully and have zero incorrect status, content type, content length/range, or sampled body-byte/hash result. Expected negative/cancellation cases are separately identified and must return their exact expected status/body behavior. After warmup, browse/search latency must be p95 at most 2 seconds and p99 at most 4.25 seconds; stream `HEAD`, range, and time-to-first-byte latency must be p95 at most 2 seconds and p99 at most 4 seconds. Post-cooldown RSS must be no more than 64 MiB above the warm baseline. All auth/429/5xx outcomes are evaluated only by the single decision table in §9.

### 5.3 Protocol correctness

Protocol fixes are evidence-driven:

- **Issue #297, playlist editing:** reproduce and fix the verified metadata error against the cited official Sonos contract. The root collection has `id="playlists"`, `itemType="playlist"`, `readOnly="false"`, and `userContent="true"`. Each individual editable playlist has `itemType="playlist"`, `readOnly="false"`, and `userContent="false"`. Raw SOAP fixtures lock those exact attributes and a test-owned disposable playlist proves add/remove behavior without touching personal playlists.
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

The smoke identity is a dedicated, uniquely credentialed, non-admin Navidrome account. It is separate from the production Sonos integration account and every personal account, cannot access their playlists or favourites, and may mutate only data it created with the test prefix. Before the harness is accepted, operators must demonstrate and record account disable, password rotation, root-only credential replacement, and successful re-authentication without affecting production Sonos or personal sessions. The record distinguishes account disable/password rotation from Bonob token expiry and process-local token invalidation; it never claims that a Navidrome password change synchronously revokes every already issued Bonob token.

Credentials come only from a root-owned, root-readable file or an already-open root-controlled descriptor. File mode opens use no-follow semantics, then `fstat` the opened descriptor and reject anything that is not a regular file owned by root with no group/other permission; descriptor mode performs the same `fstat` checks before reading. This closes path-swap and symlink races. Usernames, passwords, link codes, tokens, full URLs, response bodies, and media metadata are never printed, persisted, placed in arguments, or included in exceptions. The legacy persisted-token-file contract is removed.

The default run is serial, bounded, read-only, and aggregate-only. It reports section counts, status classes, timings, failures by opaque test case, and a final pass/fail result. Mutation mode requires an explicit flag and operates only on a newly created playlist with a unique `bonob-smoke-` prefix; it verifies before/after state and deletes the disposable playlist even on failure. It never edits or deletes a pre-existing playlist.

The harness accepts two distinct URL concepts:

- **canonical origin:** the private public-origin value supplied from the operator inventory, which the candidate uses to generate Sonos-facing URLs;
- **transport base:** the loopback address of the candidate.

For a candidate run, a single URL validator inspects every Bonob-generated URL, including `getAppLink.regUrl`, login/OAuth, report, SOAP, artwork, and stream URLs. It requires an exact scheme/host/port match to the canonical origin, rejects userinfo and unexpected fragments, then rewrites only that origin to the candidate transport base while preserving path and query. Every harness request carries a unique candidate sentinel/correlation value. Candidate evidence must show all expected sentinels in candidate logs and zero sentinels in production proxy/Bonob logs and counters for the same interval. This proves zero candidate test requests reached production. The rewrite proves application behavior only; it deliberately bypasses public ingress controls and the Sonos cloud.

A sweep is not started while an index refresh is in progress. The harness aborts cleanly on auth failure, malformed XML, unexpected origin, rate limiting, transport failure, or its global deadline and leaves production untouched.

## 7. Candidate validation and promotion

### 7.1 Isolated candidate

Each candidate runs on a new loopback port and Docker project name, using the exact GHCR digest intended for production. It uses unique aliases on an internal dedicated network, does not join production networks, and has no direct external route. Enforceable network policy permits egress only to a dedicated proxy/resolver; that proxy allowlists exact approved schemes/hosts/ports, denies the production public-origin DNS names and resolved IPv4/IPv6 addresses with higher priority, and denies every unapproved destination. Negative tests must fail for production hostname, resolved production IP, direct IPv4/IPv6, alternate port, unapproved host, external DNS, and proxy-bypass attempts before the harness can run. Hashed network-policy/DNS/test evidence proves the candidate aliases resolve only candidate endpoints and the edge proxy still resolves its Bonob upstream only to production. The candidate never mounts the production cache read-write.

Two candidate runs are required:

1. **cold cache:** an empty release-specific directory verifies first-use behavior, bounded failures, and index creation;
2. **snapshot cache:** a validated disposable copy of the production cache verifies schema compatibility, restart loading, and background refresh behavior.

Persisted cache records use a versioned envelope containing record kind, schema version, producer commit/version, creation time, payload length, payload hash, and payload. Load first validates envelope shape/version/size/hash, then a record-kind semantic validator checks types, unique stable IDs, bounds, referenced ranges, bucket completeness/disjointness, and configured container limits. Diagnostics expose accepted schema/producer/hash and rejected reason codes without media data. An invalid record is retained for diagnosis and triggers an explicit safe cold rebuild; it is never silently accepted or overwritten.

The production source snapshot is copied only after cache-writer quiescence. Ownership/mode, envelope validation, file count/bytes, and per-file plus tree hashes are recorded before the copy. Candidate writes go only to the disposable copy. The production source snapshot hashes are captured again after every candidate run and must exactly match the before values.

### 7.2 Separate evidence gates

Promotion requires all three layers:

1. **Synthetic candidate gate:** compile, unit/chaos/contract tests, cold-cache run, snapshot-cache run, safe SMAPI sweep, artwork and stream `HEAD`/range checks, graceful-shutdown test, restart, and redaction verification.
2. **Public production gate after promotion:** CA/TLS validation, nginx configuration test, `/` and `/about`, OAuth/login/SMAPI routes, public safe sweep, rate-limit/CrowdSec sanity, upstream attribution, and restart recovery.
3. **Physical Sonos S2 gate:** browse root and large album buckets, artists and bios, search, artwork, start playback, seek, stop, replay, favourites, playlists including disposable add/remove, queued-media behavior, and post-restart cache persistence on the actual LAN speakers/controller. It includes at least two continuous hours of physical playback soak.

No sidecar result is described as S2 end-to-end success. Physical acceptance is recorded by the operator after the public promotion.

The retained physical matrix records candidate digest, Navidrome version, speaker model and firmware, controller hardware/OS/app version, and version/hash plus codec/bit-depth/sample-rate of each test media fixture. For every case it records exact steps, expected and actual result, start/end time, latency, and redacted evidence/log hashes. Playback permits zero unexpected stop or rebuffer/audio dropout of at least one second outside an intentional pause/seek; start and seek must produce audio within 10 seconds. A distinct session begins with a controller cold launch and fresh service browse, is separated from another session by at least 30 minutes, and at least one required session occurs after a controlled Bonob restart.

The initial promoted digest remains under observation for at least 24 continuous hours and at least three distinct physical Sonos sessions. The window passes only with no container restart or unhealthy event, no new unexplained authentication, 429, or 5xx burst, and no release-blocking regression.

The §9 decision table defines auth/429/5xx handling and release blockers for candidate, production, observation, and soak evidence.

## 8. Deployment, backup, maintenance, and rollback

Bonob's in-memory API-token map authorizes the `bat` values embedded in artwork and stream URLs, so those URLs are invalid after process restart even when `BNB_SECRET` is unchanged; link codes are also process-local. By contrast, SMAPI auth tokens and signed external/deezer artwork burns can survive restart until expiry when the same secret is retained. Rotating `BNB_SECRET` invalidates secret-signed material; changing a Navidrome password does not synchronously revoke already issued Bonob tokens. Initial promotions therefore use a short announced maintenance window: playback stops and users re-browse/requeue afterward.

Before any production container recreation:

- retain either a checksummed image archive or a proven immutable pullable digest for the exact current image;
- save the effective compose configuration and the actual nginx file, with hashes;
- save the proxy target, container inspection, Docker networks, resource limits, security settings, and health configuration;
- back up the secret-compatible environment/credential files without printing values, and record root-only fingerprints so the rollback uses the same `BNB_SECRET`;
- capture cache envelope/schema, semantic-validation result, file count/bytes, ownership/mode, per-file/tree hashes, and a writer-quiesced snapshot;
- run and verify the VPS backup, recording the successful backup/snapshot identifier;
- validate that the backup contains the saved proxy configuration, container inspection, Docker network/resource/security/health settings, checksummed image archive or immutable pullable digest, compose configuration, secret-compatible environment/credentials, and hashed cache snapshot;
- perform a mandatory isolated restore rehearsal using a recorded exact command sequence: restore disposable copies of the saved proxy/compose/environment/cache state; load the exact checksummed image archive or pull and verify the immutable digest; run the proxy configuration test; start the previous image in a non-production project/loopback binding; verify secret compatibility, health, `/`, `/about`, authentication, SMAPI, artwork, byte-range headers/body, stream playback, cache semantic/hash integrity, and clean stop. A dry run is insufficient, and the rehearsal must pass;
- confirm the previous public health and current physical Sonos baseline.

Production container recreation is a separately announced risky deployment gate. It requires explicit user approval after the exact candidate digest, evidence summary, maintenance impact, verified VPS backup, and rollback command have been presented. Approval of this design does not authorize a future container recreation.

Promotion changes only the Bonob image reference to the tested digest unless a separately reviewed configuration change is essential. It does not rotate `BNB_SECRET`, change proxy policy, migrate Navidrome, or mutate the production cache in the same step. After graceful stop and recreation, the public and physical gates run immediately.

On any failed post-promotion gate, unexpected 401/429/5xx increase, cache incompatibility, stream regression, or Sonos failure:

1. stop new test traffic;
2. restore the previous digest and its secret-compatible compose configuration;
3. restore the hashed prior cache snapshot. This copy may be skipped only when a recorded pre-rollback equality proof shows that every current file and tree hash, envelope/schema result, ownership, and mode exactly equals the saved prior snapshot; any mismatch, missing value, unreadable file, or validation failure requires restoration;
4. recreate Bonob, verify `/`, `/about`, SMAPI, cache load, and a physical browse/play;
5. preserve redacted candidate logs and the failed release manifest for diagnosis.

Rollback does not alter Navidrome, nginx, DNS, Sonos Developer Portal registration, or the music library unless evidence identifies one of them as the actual fault. If a secret appears in any output, testing stops, the output is quarantined, and the affected credential is rotated before work resumes.

## 9. Error-handling and release accountability

The following is the sole auth/429/5xx and release-blocker policy:

| Signal | Objective threshold | Required decision |
|---|---|---|
| Expected negative test | Correlation ID identifies the case and exact expected status/body | Count separately; never consume the success budget or trigger retry |
| Supported functional path or valid smoke-account auth failure | Any incorrect browse/search/art/playback/playlist response, body/range result, or auth failure | Release blocker; stop the gate and diagnose or roll back |
| Isolated background auth failure, 429, or 5xx | 1–4 for the same integration/outcome in a rolling 60-second window | Attribute and investigate; retry only an idempotent read under policy; promotion/observation needs resolution or recorded user+architect disposition |
| Unexpected burst | At least 5 auth failures, 429s, or 5xx responses for the same integration/outcome in any rolling 60-second window | Release blocker; stop candidate traffic or roll back production |
| Secret/data-integrity issue or crash/unhealthy/restart | Any occurrence | Nonwaivable release blocker; quarantine evidence and rotate/restore as appropriate |
| Lower-severity nonfunctional regression | Any occurrence | Record impact, owner, and user+architect disposition before a gate can pass |

- Pre-promotion failures leave the current production container untouched.
- Automation stops on the first failed command and never silently substitutes a tag, cache, credential source, endpoint, or architecture.
- Timeouts have explicit error classes; expected degradation paths remain distinguishable from auth, mutation, and data-integrity failures.
- Retry policy is bounded and limited to demonstrably safe read operations. HTTP 4xx responses and mutations are not retried.
- A failed cache load preserves the last valid file and either serves stale data or performs a deliberate cold rebuild; partial writes use atomic replacement.
- Memory/socket threshold failure, malformed SOAP, or any cross-process candidate URL is a release blocker.
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

Every criterion below is required. Repository freeze/credential revocation, CI/build-context credential containment, exact-artifact provenance/audit/scan, registry writer/immutability/privacy, root-only smoke credentials, lifecycle/shutdown, candidate-production isolation/sentinel, cache integrity, public redaction, error/soak thresholds, verified backup/restore, explicit deployment approval, and rollback are core safety gates and cannot be waived or marked not applicable. A non-core criterion may be marked not applicable only when its reason and scope are recorded and both the user and architect approve before execution.

1. The user and architect approve this design before Plan A implementation.
2. Before safety work is pushed, every queued/running job is cancelled or drained, Actions is disabled, all direct/inherited GHCR/Docker Hub writer/admin permissions and automation credentials are inventoried and revoked, freeze evidence is retained, and no artifact is published.
3. Plan A has read-only permissions, `persist-credentials: false`, and a non-publishing `workflow_dispatch` that proves its full-SHA input equals integrated `master` and checked-out `HEAD`. Active templates/operator docs reject `simojenki/*`, Docker Hub, `latest`, and predictable secrets. Plan A passes before Plan B creates a protected publisher.
4. Historical lineage before this amendment is proven 50 commits ahead of `68a73b9`: 48 pre-spec commits through `4db3d75`, then `af60e93` and `5a83fb4`. After final approval, the latest commit touching this specification path is recorded as `DESIGN_SHA` with its file hash; it must equal the approval record and be an ancestor of both the safety commit and `master`. Any later path change invalidates approval, making omission impossible.
5. A deterministic closed allowlist generates a sorted, hashed Docker context from exact `master`; a local secret/prohibited-path scan passes before any remote builder/cache/registry access, and the scanned archive contains no `.git`, credentials, operator file, or unlisted path. Plan B then pins bases by digest, performs no nondeterministic OS upgrade, builds one OCI artifact, runs source and exact-manifest gates, and pushes the same bytes. Private caches/intermediates satisfy credential, scope, provenance, scan, and retention policy.
6. Audit and image scan report zero high/critical findings or the machine-enforced exact-identity allowlist contains every required field, unexpired user+architect approval, and no broader match. The manifest records tool/database identities, versions/timestamps, policies, raw-report hashes, source SHA, and artifact digest.
7. Plan B removes every other writer. Its requested SHA equals remote `master` at dispatch, immediately before push, and after verification; mismatch aborts or quarantines. Publication concurrency is keyed by destination repository plus SHA tag with cancellation disabled; conflicting tags fail; matching reruns adopt and verify without rebuild; post-push digest/revision match local/source. The package is private, anonymous pull fails, authorized read-only VPS pull succeeds, and digest is authoritative.
8. Every code-changing Plan C/D slice starts from exact current `master` and produces a new build/audit/scan/smoke/candidate-tested digest; evidence is never reused across code SHAs.
9. The smoke account and test data are isolated as specified. Credential file/FD is root-owned and root-readable only; no-follow open plus post-open `fstat` rejects symlink, non-regular, non-root, or group/world-accessible input; disable/rotate/replace/re-authenticate behavior is demonstrated with accurate token-revocation wording.
10. Plan C first supplies the app factory/lifecycle coordinator, shared cancellation, cache quiescence, and active request/stream/socket/background registries with invariant tests.
11. Default-deny candidate network policy permits only the allowlisting egress proxy/resolver and explicitly denies production origin names/IPs and unapproved destinations. Negative hostname/direct-IP/IPv4/IPv6/port/DNS/proxy-bypass tests pass; edge proxy resolution still targets production only. Every generated Bonob URL, including `getAppLink.regUrl`, passes exact-origin validation/rewrite; candidate sentinels all appear at candidate and zero appear at production.
12. Cache files pass versioned envelope and record-kind semantic validation/diagnostics. Writer-quiesced production source per-file/tree hashes are identical before and after cold/snapshot candidate runs.
13. The harness persists no token, emits aggregate-only output, passes cold and disposable snapshot tests, attributes/redacts a forced 429, and never writes production state.
14. Graceful shutdown broadcasts cancellation, quiesces cache, drains/bounds registries, preserves valid cache, and restarts within the Docker grace period. Plan C evidence precedes every post-convergence promotion.
15. The automated soak meets duration/cycle/sampling windows; at least 99.5% expected-success cycles pass with zero response/body/range correctness error; defined p95/p99 latencies pass; final-load and post-cooldown RSS are within 64 MiB; handle/socket cooldown thresholds pass; and unhandled rejection/crash/cache corruption is zero.
16. The §9 decision table is machine-evaluated for candidate/soak/production evidence, including the five-in-60-second burst rule and dispositions for lower-severity nonfunctional issues.
17. Issue #297 raw SOAP proves the exact root and individual-playlist attributes in §5.3 against the official Sonos contract and disposable mutation passes; #284 is fixture-classified; #229 remains regression-covered; #214 is raw-SOAP asserted; #246/#254/#255 have corrected diagnostics; #164 meets soak thresholds.
18. Backup validation includes proxy configuration, container/network/resource/security/health inspection, compose, root-only secret-compatible state, validated cache hashes, and a checksummed image archive or proven pullable digest. The recorded exact command sequence restores disposable state, loads the exact artifact, passes proxy config test, auth, SMAPI, artwork, range/body, stream playback, cache integrity, and clean stop. Every actual rollback restores the hashed prior cache snapshot unless a pre-rollback proof shows exact per-file/tree hash, schema, ownership, and mode equality; any missing/mismatch restores.
19. The user explicitly approves the separately announced container recreation after reviewing exact digest, evidence, maintenance impact, verified backup, and rehearsed rollback.
20. Physical evidence retains the full speaker/controller/firmware/media matrix, steps/results/timestamps/log hashes, zero prohibited dropout/abort, start/seek latency, two-hour playback soak, and three distinctly defined sessions including one after restart.
21. The initial digest completes 24 continuous hours without a §9 blocker; every lower-severity issue has disposition. Any failed gate restores the exact prior artifact/configuration and applies the criterion-18 cache rule before re-establishing public and physical health.
22. Restart/rotation tests prove process-local `bat`/link-code invalidation, same-secret SMAPI/burn continuity until expiry, and secret-rotation invalidation without overstating password-change revocation.
23. Before Plan F, the same digest completes seven continuous days, at least three distinct physical sessions, zero rollback, zero blocker, and zero unattributed production error.
24. Full-file and diff-aware redaction gates pass for this specification and every public evidence update; public attestations retain only content/diff/policy hashes and outcome, with zero exact host/IP/service/network/path/credential/topology identifier.
25. An independent adversarial/architectural re-review approves the final branch and fresh evidence set.
