# Plan A — Repository convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail-closed-freeze the RicherTunes/bonob fork, revoke every publication writer/credential, integrate a non-publishing exact-SHA validation workflow, fast-forward `master` linearly, and validate only the exact integrated SHA — with no publication in this plan.

**Architecture:** A human operator performs an out-of-band fail-closed GitHub freeze (Actions disabled, every GHCR/Docker Hub writer and automation credential inventoried and revoked) and records a freeze record outside the repo. On `perf/artist-list-cache`, a single safety commit removes all `simojenki/*` and Docker Hub publication, points every future image target at `ghcr.io/richertunes/bonob`, splits read-only PR validation from trusted publication, pins Actions by SHA, and adds a master-only manual `workflow_dispatch` validator that binds `master`, the event SHA, checked-out `HEAD`, and the executing workflow blob. After local gates pass, `master` is advanced with `--ff-only` and the validator runs once against the exact integrated SHA.

**Tech Stack:** GitHub Actions (workflow YAML, `actions/checkout@<sha>`), Git linear history (`--ff-only`), `git log`/`git rev-parse` for SHA/blob ancestry checks, Jest for the redaction-gate test, Node 22 / TypeScript.

---

## Program metadata

**Plan:** A — Repository convergence
**Program:** RicherTunes bonob private-fork convergence (spec `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, §3.1, §3.2, §2.4, §5.1).
**Entry dependency (spec §1.1 row A):** user and architect approve this design; `DESIGN_SHA` recorded.
**Exit evidence (spec §1.1 row A, criteria 2, 3, 24):** freeze/inventory record retained; local gates green; ancestry checks pass; manually dispatched non-publishing validation bound to the exact integrated SHA passes; publication remains disabled (no GHCR/Docker Hub writer exists for this plan).

## Baseline facts (verified against this worktree)

Run `git rev-parse HEAD` at start. It MUST equal the value below; if it does not, stop and report `needs_parent`.

- `DESIGN_SHA = 3d45ad2ca26fd1ec3d8f8b52a11aa7f6b13b3634` (last commit touching the spec path; `git log -1 --format=%H -- docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`).
- Spec file blob hash = `94ea0ef7273db8b4b021ac70eda20c25d58bb55d` (`git hash-object docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`).
- Upstream base `68a73b9c0fbcc789ec97a255f93c16068f26b385`; the worktree HEAD is an ancestor-clean descendant.
- Production image was built from `4db3d75c5a8683bb7badcf12515cc7895271bc89` (spec §2.2). `4db3d75` is an ancestor of HEAD.
- Branch `perf/artist-list-cache` exists locally and on `origin`.

## Nonwaivable invariants every step obeys

- **No publication in Plan A.** No step creates a GHCR/Docker Hub writer, no step pushes an image, no step grants `packages:write`. Plan B alone creates the protected `ghcr-publication` environment (spec §3.1 last paragraph).
- **Fail-closed.** Any failed test, compile, audit, scan, build, smoke, ancestry, or exact-SHA/blob check aborts the plan and leaves `master` untouched. Automation never substitutes a tag, ref, SHA, or credential (spec §9).
- **Linear history.** `master` is advanced only with `git merge --ff-only`. No squash, merge commit, rebase, or force-push (spec §3.2).
- **Exact-SHA binding.** The validator binds the requested SHA to remote `master`, `GITHUB_SHA`, and checked-out `HEAD`, and hashes both the workflow blob stored at the requested SHA and the executing workflow blob (spec §3.1).
- **Read-only workflow.** Plan A workflow permissions are `contents: read` (and `actions: read` only where needed), `persist-credentials: false`; PR runs receive no registry credentials (spec §3.2).
- **Redaction gate (spec §2.4, criterion 24).** Every public file change in this plan passes the full-file + diff redaction/secret scan defined in Task A.2 before commit.

---

## Files created or modified by this plan

- **Create:** `.github/workflows/validate-master.yml` — master-only manual `workflow_dispatch` non-publishing validator (exact-SHA + workflow-blob binding).
- **Create:** `.github/workflows/redaction-policy.json` — versioned deny-list for the public redaction gate.
- **Create:** `tools/redact.mjs` — full-file + diff redaction scanner (Node ESM, no deps).
- **Create:** `tests/redaction.test.ts` — Jest test for the redaction scanner (real failing test -> green).
- **Create:** `docs/superpowers/plans/freeze-record.md` — template for the operator freeze record (names, never values).
- **Modify:** `.github/workflows/ci.yml` — remove all `simojenki/*` and Docker Hub login/push; make PR jobs read-only and credential-free; reserve GHCR write for Plan B.
- **Modify:** `Dockerfile` — set `org.opencontainers.image.source` to `https://github.com/RicherTunes/bonob`, remove `COPY .git ./.git`, read revision from a generated `.gitinfo`-replacement (no `.git`).
- **Modify:** `.dockerignore` — add `.git`, `.git/credentials`, `.env*`, operator inventories, `build`, `.glm-plan-prompt.md`.
- **Modify:** `package.json` — `repository` -> `https://github.com/RicherTunes/bonob`.
- **Modify:** `README.md` — replace `docker.io/simojenki/bonob`, `ghcr.io/simojenki/bonob`, `simojenki/bonob:latest` with RicherTunes guidance; reject `latest` and predictable `BNB_SECRET`.
- **Modify:** `docs/sonos-s1-setup.md` — replace `simojenki/bonob` references with RicherTunes image guidance.
- **Modify:** `etc/docker-compose.yaml` — replace `simojenki/bonob:latest` with `ghcr.io/richertunes/bonob:sha-<40hex>` guidance and a non-predictable `BNB_SECRET` note.

> **Out-of-band (operator, not a code step):** disabling GitHub Actions, revoking writers/credentials, and producing the freeze record are manual GitHub/web actions outside this repository. They are Task A.1 prerequisites and are recorded in `docs/superpowers/plans/freeze-record.md`; this plan edits no GitHub setting programmatically.

---

## Task A.0 — Confirm the exact design baseline before any work

**Files:**
- Read-only: `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, git history.

- [ ] **A.0.1 — Verify HEAD, DESIGN_SHA ancestry, and the spec blob hash.**

Run:
```bash
git rev-parse HEAD
git log -1 --format=%H -- docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md
git hash-object docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md
git merge-base --is-ancestor 4db3d75 HEAD ; echo "exit=$?"
git merge-base --is-ancestor 68a73b9 HEAD ; echo "exit=$?"
```
Expected: HEAD == `3d45ad2ca26fd1ec3d8f8b52a11aa7f6b13b3634`; DESIGN_SHA line prints the same SHA; spec blob hash `94ea0ef7273db8b4b021ac70eda20c25d58bb55d`; both `merge-base --is-ancestor` exit `0`.

- [ ] **A.0.2 — Confirm the branch and switch to `perf/artist-list-cache`.**

Run:
```bash
git rev-parse --abbrev-ref HEAD
git checkout perf/artist-list-cache
git merge-base --is-ancestor 3d45ad2 HEAD ; echo "exit=$?"
```
Expected: on `perf/artist-list-cache`; `3d45ad2` is an ancestor (exit `0`). If the branch has diverged, stop — report `needs_parent`.

- [ ] **A.0.3 — Create the freeze-record template (documentation only).**

Create `docs/superpowers/plans/freeze-record.md` with the structure the operator fills out-of-band (names only, never values):
```markdown
# Publication freeze record (Plan A)

- **Frozen at (UTC):** <operator fills, e.g. 2026-07-23T20:00:00Z>
- **Actor (GitHub handle):** <operator fills>
- **Actions state:** disabled for RicherTunes/bonob
- **Queued/running jobs:** drained; none active
- **Writers/admins revoked (names, not values):**
  - GHCR package `ghcr.io/richertunes/bonob` writers/admins: <list or "none">
  - Docker Hub namespace authority: revoked
  - Repository, org, team, inherited package perms: <exports referenced, not embedded>
  - Actions/environment secrets: <names>
  - PATs: <names>
  - Deploy keys: <names>
  - GitHub Apps / OIDC trust / external bots: <names>
- **Actions defaults after re-enable:** read-only (`contents: read`); package write unavailable
- **Evidence retained at:** <private operator location outside the repo>
```
Atomic commit: `git add docs/superpowers/plans/freeze-record.md && git commit -m "docs(plan-a): add publication freeze record template"`.

**Definition of done for A.0:** baseline matches exactly; on `perf/artist-list-cache`; freeze template committed.

---


## Task A.1 — Operator fail-closed freeze (out-of-band prerequisite gate)

**Files:** none in-repo; the operator updates `docs/superpowers/plans/freeze-record.md` from the GitHub web UI / `gh` CLI by reference only.

- [ ] **A.1.1 — Operator disables Actions and drains jobs.**

The owner cancels queued jobs, lets running jobs drain, verifies no job remains active, and disables GitHub Actions for the RicherTunes fork (spec §3.1). No tag/package/image may publish while frozen. Record time/actor in the freeze record.

- [ ] **A.1.2 — Operator inventories and revokes every writer/credential.**

Inventory and remove: GHCR package writers/admins; Docker Hub namespace authority; repository/organization/team/inherited permissions; Actions and environment secrets; PATs; deploy keys; GitHub Apps; OIDC trust; external bots (spec §3.1). Capture permission exports and Actions defaults by reference, not by value.

- [ ] **A.1.3 — Code-side gate that proves no writer exists in the frozen tree.**

This is the in-repo proof the freeze is reflected by the code. Write the failing check first:
```bash
# BEFORE: ci.yml still contains simojenki + Docker Hub login -> grep finds matches
grep -nE 'simojenki|DOCKERHUB|docker\.io|login-action|build-push-action' .github/workflows/ci.yml
```
Expected before Task A.3: multiple matches (e.g. `simojenki/bonob`, `Login to DockerHub`, `Push image`). After A.3 this prints nothing. This gate cannot pass until the publication code is removed in A.3.

> **Note:** Task A.1 itself makes no in-repo change; it is the human gate whose completion is attested by filling `freeze-record.md`. The code-level enforcement happens in A.3 and is what makes the frozen tree publish-incapable.

**Definition of done for A.1:** operator attests freeze in `freeze-record.md`; A.1.3 grep still shows the pre-removal matches (proving the code change is still required).

---

## Task A.2 — Public redaction gate (spec §2.4, criterion 24)

Goal: a versioned full-file + diff redaction scanner with a real failing Jest test, so every later public file change in this plan (and all future plans) can pass through it before commit.

**Files:**
- Create: `.github/workflows/redaction-policy.json`
- Create: `tools/redact.mjs`
- Test: `tests/redaction.test.ts`

- [ ] **A.2.1 — Write the versioned deny policy.**

Create `.github/workflows/redaction-policy.json`:
```json
{
  "version": "1.0.0",
  "description": "Public redaction deny policy for RicherTunes/bonob (spec §2.4)",
  "deny": [
    { "id": "operator-hostname", "pattern": "bonob\\.example\\.com|music\\.example\\.com" },
    { "id": "ipv4-private", "pattern": "\\b(?:10|192\\.168|172\\.(?:1[6-9]|2[0-9]|3[0-1]))\\.[0-9]+\\.[0-9]+\\b" },
    { "id": "ipv4-loopback", "pattern": "\\b127\\.0\\.0\\.1\\b" },
    { "id": "aws-metadata", "pattern": "169\\.254\\.169\\.254" },
    { "id": "secret-value-placeholder", "pattern": "BNB_SECRET\\s*[:=]\\s*[\"']?[A-Za-z0-9]{8,}" },
    { "id": "container-network-name", "pattern": "\\b(prod|production)-(ingress|service|backend)\\b" },
    { "id": "vps-path", "pattern": "/(opt|srv|etc)/bonob" },
    { "id": "credential-file-path", "pattern": "\\.(env|git/credentials)\\b" }
  ]
}
```

- [ ] **A.2.2 — Write the redaction scanner (no deps, Node ESM).**

Create `tools/redact.mjs`:
```javascript
import { readFileSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export function loadPolicy(policyPath = join(repoRoot, ".github/workflows/redaction-policy.json")) {
  return JSON.parse(readFileSync(policyPath, "utf8"));
}

// Returns { ok: boolean, findings: [{ id, path, line }] }. Scans the given files.
export function scanFiles(policy, files) {
  const findings = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      for (const rule of policy.deny) {
        if (new RegExp(rule.pattern).test(lineText)) {
          findings.push({ id: rule.id, path: rel, line: idx + 1 });
        }
      }
    });
  }
  return { ok: findings.length === 0, findings };
}

// Diff mode: scans only changed/added lines vs baseRef.
export function scanDiff(policy, baseRef) {
  const names = execSync(`git diff --diff-filter=AM --name-only ${baseRef}`, { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean);
  const findings = [];
  for (const rel of names) {
    const patch = execSync(`git diff ${baseRef} -- "${rel}"`, { cwd: repoRoot, encoding: "utf8" });
    patch.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")).forEach((lineText, idx) => {
      for (const rule of policy.deny) {
        if (new RegExp(rule.pattern).test(lineText.slice(1))) {
          findings.push({ id: rule.id, path: rel, line: idx + 1 });
        }
      }
    });
  }
  return { ok: findings.length === 0, findings };
}
```

- [ ] **A.2.3 — Write the failing Jest test.**

Create `tests/redaction.test.ts`:
```typescript
import { loadPolicy, scanFiles } from "../tools/redact.mjs";
import { join } from "path";

describe("public redaction gate (spec §2.4)", () => {
  const policy = loadPolicy();

  it("flags a fake file containing a private IPv4 address", () => {
    const fake = join(__dirname, "fixtures", "redaction-sample.txt");
    const result = scanFiles(policy, [fake]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.id)).toContain("ipv4-private");
  });

  it("the committed deny policy is non-empty and versioned", () => {
    expect(policy.version).toBe("1.0.0");
    expect(policy.deny.length).toBeGreaterThan(0);
    for (const rule of policy.deny) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.pattern).toBe("string");
      expect(() => new RegExp(rule.pattern)).not.toThrow();
    }
  });
});
```
Create the fixture it needs to fail/pass:
```bash
mkdir -p tests/fixtures
printf 'host is at 192.168.1.5 and secret BNB_SECRET=supersecret1234\n' > tests/fixtures/redaction-sample.txt
```

- [ ] **A.2.4 — Run the test and watch it fail.**

If the test is committed before `tools/redact.mjs`:
```bash
npx jest tests/redaction.test.ts
```
Expected: `FAIL ... Cannot find module '../tools/redact.mjs'`. (If tool+test ship together the *assertion* fails on the flagged sample until the fixture exists. Either red state is acceptable; the green state is what matters next.)

- [ ] **A.2.5 — Confirm the green state.**

Run:
```bash
npx jest tests/redaction.test.ts
```
Expected: `PASS`, 2 tests pass. The flagged fixture proves detection works; the policy is versioned.

- [ ] **A.2.6 — Record the redaction baseline (spec §2.4, criterion 24).**

Run, and paste the output into the plan's evidence section (not into a public file unless scanned):
```bash
git hash-object .github/workflows/redaction-policy.json
git rev-parse HEAD
```
Expected: a policy blob hash and the current commit SHA. These are the `policy_hash` and `baseline_commit` recorded in the attestation; later public changes bind full-file + diff to them.

- [ ] **A.2.7 — Commit.**

```bash
git add .github/workflows/redaction-policy.json tools/redact.mjs tests/redaction.test.ts tests/fixtures/redaction-sample.txt
git commit -m "feat(plan-a): versioned public redaction gate + failing-now-passing test"
```

**Definition of done for A.2:** scanner + policy committed; Jest green; policy/baseline hashes recorded.

---


## Task A.3 — Remove all publication capability from CI (spec §3.2)

Goal: `ci.yml` can no longer publish anywhere; PR jobs are credential-free; `simojenki/*` and Docker Hub are gone; GHCR write is reserved for Plan B.

**Files:**
- Modify: `.github/workflows/ci.yml` (current `push_to_registry` job at `.github/workflows/ci.yml:24-73`).
- Modify: `Dockerfile` (`COPY .git ./.git` at `Dockerfile:26`; `simojenki` labels at `Dockerfile:35-37`).
- Modify: `.dockerignore`.
- Modify: `package.json:5-6`.

- [ ] **A.3.1 — Replace the publishing CI with read-only validation.**

Rewrite `.github/workflows/ci.yml` so the second job only *builds* (never pushes) and PRs get no credentials. The full new file:
```yaml
name: ci

on:
  push:
    branches:
      - 'master'
  pull_request:
    branches:
      - 'master'

permissions:
  contents: read

jobs:

  build_and_test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out the repo (no credential persistence)
        uses: actions/checkout@<PINNED_SHA>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<PINNED_SHA>
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm audit --omit=dev

  build_image_no_push:
    name: Build container image (no publication in Plan A)
    needs: build_and_test
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Check out the repo (no credential persistence)
        uses: actions/checkout@<PINNED_SHA>
        with:
          persist-credentials: false
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@<PINNED_SHA>
      - name: Build image only (push disabled)
        uses: docker/build-push-action@<PINNED_SHA>
        with:
          context: .
          platforms: linux/amd64
          push: false
          load: true
```
`<PINNED_SHA>` is replaced in A.3.4 with the exact reviewed full commit SHA of each action (fetched by the operator from the action's release tags; this plan does not fetch them — see A.3.4). Until pinned, the grep below still matches the placeholder and the step is not done.

- [ ] **A.3.2 — Remove Docker Hub login/push, QEMU multi-arch, and `simojenki` metadata.**

The rewrite above already drops `docker/login-action` for both registries, the `simojenki/bonob` and `ghcr.io/simojenki/bonob` `images:`, the `linux/arm/v7,linux/arm64` platforms, and the `push: github.event_name != 'pull_request'` logic.

- [ ] **A.3.3 — Prove publication code is gone (the gate).**

Run:
```bash
grep -nE 'simojenki|DOCKERHUB|docker\.io|login-action|build-push-action.*push|ghcr\.io/simojenki' .github/workflows/ci.yml
```
Expected: **no matches** (exit code 1 from grep). Before the change this printed the matches from A.1.3.

- [ ] **A.3.4 — Pin Actions by exact SHA (replace placeholders).**

For each `<PINNED_SHA>` in `ci.yml`, the operator fills the reviewed full 40-char commit SHA of: `actions/checkout`, `actions/setup-node`, `docker/setup-buildx-action`, `docker/build-push-action` (spec §3.2: "pin third-party GitHub Actions to reviewed full commit SHAs"). Example final form:
```yaml
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
```
Gate (no placeholder remains):
```bash
grep -nE '<PINNED_SHA>|@v[0-9]|@master|@main' .github/workflows/ci.yml
```
Expected: **no matches**. (Floating tags and the literal placeholder are both forbidden.)

- [ ] **A.3.5 — Fix the Dockerfile `.git` copy and source label.**

In `Dockerfile`:
- Delete the line `COPY .git ./.git` (`Dockerfile:26`). The `.git` directory must never enter the context (spec §3.2).
- Change `LABEL maintainer="simojenki"` and `org.opencontainers.image.source="https://github.com/simojenki/bonob"` (`Dockerfile:35-36`) to:
```dockerfile
LABEL   org.opencontainers.image.source="https://github.com/RicherTunes/bonob" \
        org.opencontainers.image.description="bonob SONOS SMAPI implementation (RicherTunes fork)" \
        org.opencontainers.image.licenses="GPL-3.0-only"
```
The revision label is produced by Plan B's generated `.gitinfo`-replacement; Plan A only removes the unsafe `.git` copy and fixes the source URL. (Plan B adds `org.opencontainers.image.revision` bound to the exact SHA.)

Gate:
```bash
grep -nE 'COPY \.git|simojenki|github\.com/simojenki' Dockerfile
```
Expected: **no matches**.

- [ ] **A.3.6 — Harden `.dockerignore`.**

Append the prohibited paths to `.dockerignore` (current file excludes only `.devcontainer .github .yarn/cache .yarn/install-state.gz build node_modules`):
```text
.git
.git/credentials
.env
.env.*
*.pem
*.key
.glm-plan-prompt.md
docs/superpowers/plans/freeze-record.md
.claude
```
Gate (each prohibited path present):
```bash
grep -nE '^\.(git|env|git/credentials)|freeze-record' .dockerignore
```
Expected: matches for `.git`, `.env*`, `.git/credentials`, and `freeze-record`.

- [ ] **A.3.7 — Fix `package.json` repository metadata.**

Change `package.json:5-6`:
```json
  "repository": "https://github.com/RicherTunes/bonob",
  "author": "RicherTunes",
```
Gate:
```bash
grep -nE 'simojenki' package.json
```
Expected: **no matches**.

- [ ] **A.3.8 — Run local gates before commit.**

Run:
```bash
npm ci
npm run build
npm test
npm audit --omit=dev
```
Expected: build succeeds; full Jest suite passes; `npm audit --omit=dev` runs (Plan A does **not** require zero high/critical yet — that is Plan B §3.3; Plan A only requires the audit to execute without crashing so CI is fail-closed-capable).

- [ ] **A.3.9 — Run the redaction gate over this commit's diff (spec §2.4).**

Run:
```bash
node -e "import('./tools/redact.mjs').then(m=>{const p=m.loadPolicy();const r=m.scanDiff(p,'HEAD~1');console.log(JSON.stringify(r));process.exit(r.ok?0:1)})"
```
Expected: `{"ok":true,"findings":[]}` and exit `0`. If a finding appears (e.g. a stray `192.168.x.x` in an example), remediate privately and rescan before committing.

- [ ] **A.3.10 — Commit (atomic).**

```bash
git add .github/workflows/ci.yml Dockerfile .dockerignore package.json
git commit -m "fix(plan-a): remove all publication, pin actions, drop .git from image context"
```

**Definition of done for A.3:** CI is publish-incapable; Actions pinned by SHA; `.git` excluded; metadata corrected; local gates + redaction gate green.

---


## Task A.4 — Correct public docs and examples (spec §3.2)

Goal: active docs/templates reject `simojenki/*`, Docker Hub, `latest`, and predictable `BNB_SECRET`.

**Files:**
- Modify: `README.md` (`docker.io/simojenki/bonob` at `README.md:34`; `ghcr.io/simojenki/bonob` at `README.md:36`; `simojenki/bonob:latest` at `README.md:41,237`).
- Modify: `docs/sonos-s1-setup.md` (`simojenki/bonob` at lines 15, 31, 55, 66, 75).
- Modify: `etc/docker-compose.yaml` (`simojenki/bonob:latest` at line 19; predictable `BNB_SECRET: changeme`).

- [ ] **A.4.1 — Replace `README.md` image references.**

Replace the "Running bonob" block (`README.md:30-44`) so it reads:
```markdown
## Running bonob

bonob is published by RicherTunes as a private OCI image to the GitHub Container Registry.

> The public Docker Hub image `simojenki/bonob` and the `latest` tag are **not** supported by the RicherTunes fork. Always pull a pinned digest, for example `ghcr.io/richertunes/bonob@sha256:<manifest-digest>` or `ghcr.io/richertunes/bonob:sha-<40 lowercase hex>`.

```bash
docker run ghcr.io/richertunes/bonob:sha-<40 lowercase hex>
```

tag | description
--- | ---
sha-<40 hex> | Immutable build from an exact commit (supported). `latest` and floating tags are not published.
```

- [ ] **A.4.2 — Replace `docs/sonos-s1-setup.md` image references.**

Replace every `simojenki/bonob` occurrence with `ghcr.io/richertunes/bonob:sha-<40 lowercase hex>` and add a one-line note near the first occurrence: `# Do not use simojenki/bonob or the latest tag; pull a pinned RicherTunes digest.`

- [ ] **A.4.3 — Replace the compose example `BNB_SECRET`.**

In `etc/docker-compose.yaml`, change line 19 image to `ghcr.io/richertunes/bonob:sha-<40 lowercase hex>` and replace the predictable secret:
```yaml
  bonob:
    image: ghcr.io/richertunes/bonob:sha-<40 lowercase hex>
    # ...
    environment:
      BNB_SECRET: ${BNB_SECRET}  # long random value from a gitignored root-readable file; never "changeme"
```

- [ ] **A.4.4 — Gates.**

Run:
```bash
grep -rnE 'simojenki|docker\.io/simojenki|BNB_SECRET: changeme|bonob:latest' README.md docs/sonos-s1-setup.md etc/docker-compose.yaml
```
Expected: **no matches**. Then the redaction gate:
```bash
node -e "import('./tools/redact.mjs').then(m=>{const p=m.loadPolicy();const r=m.scanDiff(p,'HEAD~1');console.log(JSON.stringify(r));process.exit(r.ok?0:1)})"
```
Expected: `{"ok":true,"findings":[]}`.

- [ ] **A.4.5 — Commit (atomic).**

```bash
git add README.md docs/sonos-s1-setup.md etc/docker-compose.yaml
git commit -m "docs(plan-a): reject simojenki/dockerhub/latest and predictable secrets"
```

**Definition of done for A.4:** no public doc references the old namespace, Docker Hub, `latest`, or `changeme`; redaction gate green.

---

## Task A.5 — Add the non-publishing exact-SHA validator workflow (spec §3.1)

Goal: a master-only manual `workflow_dispatch` that proves event/ref/SHA, requested SHA, checked-out HEAD, and the executing workflow blob all agree — and that publication stays impossible.

**Files:**
- Create: `.github/workflows/validate-master.yml`

- [ ] **A.5.1 — Write the validator workflow.**

Create `.github/workflows/validate-master.yml`:
```yaml
name: validate-master

on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Full lowercase 40-hex commit SHA to validate (must == remote master)"
        required: true
        type: string

permissions:
  contents: read

jobs:
  validate-exact-master:
    name: Validate exact integrated master (no publication)
    runs-on: ubuntu-latest
    permissions:
      contents: read
    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' }}
    steps:
      - name: Fail if the requested SHA is not 40 lowercase hex
        run: |
          echo "::notice::requested sha=${{ inputs.sha }}"
          echo '${{ inputs.sha }}' | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::sha must be 40 lowercase hex"; exit 1; }

      - name: Require requested SHA == event GITHUB_SHA == remote master
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          REMOTE_MASTER=$(gh api repos/${{ github.repository }}/git/refs/heads/master --jq '.object.sha')
          echo "requested=${{ inputs.sha }} event_sha=${{ github.sha }} remote_master=${REMOTE_MASTER}"
          test "${{ inputs.sha }}" = "${{ github.sha }}" || { echo "::error::requested != GITHUB_SHA"; exit 1; }
          test "${{ inputs.sha }}" = "${REMOTE_MASTER}" || { echo "::error::requested != remote master"; exit 1; }

      - name: Checkout exactly the requested SHA (no credential persistence)
        uses: actions/checkout@<PINNED_SHA>
        with:
          ref: ${{ inputs.sha }}
          persist-credentials: false

      - name: Require checked-out HEAD == requested SHA
        run: |
          set -euo pipefail
          HEAD_SHA=$(git rev-parse HEAD)
          echo "checked_out_head=${HEAD_SHA}"
          test "${HEAD_SHA}" = "${{ inputs.sha }}" || { echo "::error::HEAD != requested SHA"; exit 1; }

      - name: Bind the executing workflow blob to the requested-SHA workflow blob
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          STORED=$(git rev-parse HEAD:.github/workflows/validate-master.yml)
          STORED_BLOB=$(git cat-file -p "${STORED}" | sha256sum | cut -d' ' -f1)
          EXEC_BLOB=$(gh api repos/${{ github.repository }}/contents/.github/workflows/validate-master.yml?ref=${{ github.sha }} --jq '.content' | base64 -d | sha256sum | cut -d' ' -f1)
          echo "stored_blob=${STORED_BLOB} exec_blob=${EXEC_BLOB}"
          test "${STORED_BLOB}" = "${EXEC_BLOB}" || { echo "::error::workflow blob mismatch"; exit 1; }
          echo "workflow_blob_sha256=${STORED_BLOB}" >> "$GITHUB_STEP_SUMMARY"

      - name: Run the local gates on the exact SHA (no publication)
        uses: actions/setup-node@<PINNED_SHA>
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm audit --omit=dev
      - name: Build image only (push never available here)
        uses: docker/build-push-action@<PINNED_SHA>
        with:
          context: .
          platforms: linux/amd64
          push: false
          load: true
```
Replace each `<PINNED_SHA>` with the exact reviewed commit SHA (same SHAs chosen in A.3.4). Gate (no placeholder, no push:true, no login):
```bash
grep -nE '<PINNED_SHA>|push: true|login-action|packages: write' .github/workflows/validate-master.yml
```
Expected: **no matches**.

- [ ] **A.5.2 — Add a workflow-syntax self-check (failing test -> green).**

Because Plan A cannot run GitHub Actions from this worktree, add a local structural test that fails first and then passes. Create `tests/validate_master_workflow.test.ts`:
```typescript
import { readFileSync } from "fs";
import { join } from "path";

const wf = readFileSync(join(__dirname, "..", ".github", "workflows", "validate-master.yml"), "utf8");

describe("validate-master workflow (spec §3.1)", () => {
  it("is manual master-only dispatch, not push/pr triggered", () => {
    expect(wf).toMatch(/on:\n  workflow_dispatch:/);
  });
  it("requires event_name == workflow_dispatch and ref == master", () => {
    expect(wf).toContain("github.event_name == 'workflow_dispatch'");
    expect(wf).toContain("github.ref == 'refs/heads/master'");
  });
  it("binds requested SHA, GITHUB_SHA, remote master, and checked-out HEAD", () => {
    expect(wf).toContain('test "${{ inputs.sha }}" = "${{ github.sha }}"');
    expect(wf).toContain("REMOTE_MASTER=");
    expect(wf).toContain('test "${HEAD_SHA}" = "${{ inputs.sha }}"');
  });
  it("binds the executing workflow blob to the stored blob", () => {
    expect(wf).toContain("STORED_BLOB");
    expect(wf).toContain("EXEC_BLOB");
    expect(wf).toContain('test "${STORED_BLOB}" = "${EXEC_BLOB}"');
  });
  it("never publishes and never grants packages:write", () => {
    expect(wf).not.toMatch(/packages:\s*write/);
    expect(wf).not.toMatch(/push:\s*true/);
    expect(wf).not.toMatch(/login-action/);
    expect(wf).toContain("persist-credentials: false");
  });
});
```

- [ ] **A.5.3 — Run the test and watch it fail.**

If you commit the test before the workflow file:
```bash
npx jest tests/validate_master_workflow.test.ts
```
Expected: `FAIL ... ENOENT: no such file ... validate-master.yml`. (If you commit both together the assertions fail until the exact strings exist.)

- [ ] **A.5.4 — Confirm green.**

Run:
```bash
npx jest tests/validate_master_workflow.test.ts
```
Expected: `PASS`, 5 tests.

- [ ] **A.5.5 — Redaction gate + commit.**

Run the redaction gate over the diff (A.3.9 command); expect `{"ok":true,"findings":[]}`. Then:
```bash
git add .github/workflows/validate-master.yml tests/validate_master_workflow.test.ts
git commit -m "feat(plan-a): non-publishing exact-SHA master validator + workflow-blob binding"
```

**Definition of done for A.5:** validator workflow + structural test committed; never publishes; binds all four identities.

---


## Task A.6 — Fast-forward `master` linearly (spec §3.2)

Goal: with all gates green on `perf/artist-list-cache`, advance `master` with `--ff-only` — no squash, merge commit, rebase, or force.

**Files:** none (git operation).

- [ ] **A.6.1 — Re-run the complete local gate set on the branch.**

Run:
```bash
npm ci && npm run build && npm test && npm audit --omit=dev
```
Expected: all pass. If any fails, do **not** advance `master`; fix on the branch first.

- [ ] **A.6.2 — Verify linear reachability before the fast-forward.**

Run:
```bash
git fetch origin
git log --oneline origin/master..perf/artist-list-cache
git merge-base --is-ancestor origin/master perf/artist-list-cache ; echo "exit=$?"
```
Expected: a clean linear list of the safety commits; `merge-base --is-ancestor` exits `0` (the branch is strictly ahead of `master`, so `--ff-only` is possible).

- [ ] **A.6.3 — Fast-forward only.**

Run:
```bash
git checkout master
git merge --ff-only perf/artist-list-cache
git rev-parse master
```
Expected: `master` advanced to the exact branch tip; the printed SHA is the new integrated SHA. If `git merge --ff-only` refuses (branch diverged), **stop** and report `needs_parent` — do not force, rebase, or squash.

- [ ] **A.6.4 — Record the integrated SHA and ancestry proof.**

Run:
```bash
INTEGRATED=$(git rev-parse master)
echo "integrated=${INTEGRATED}"
git merge-base --is-ancestor 3d45ad2 "${INTEGRATED}" ; echo "design_ancestor=$?"
git merge-base --is-ancestor 4db3d75 "${INTEGRATED}" ; echo "prod_ancestor=$?"
git log --oneline --graph origin/master..master
```
Expected: the integrated SHA; `DESIGN_SHA` (`3d45ad2`) and production commit (`4db3d75`) are both ancestors (exit `0`); the graph is a straight line (no merge commits).

**Definition of done for A.6:** `master` fast-forwarded linearly; integrated SHA recorded; ancestry proven.

---

## Task A.7 — Dispatch the non-publishing validator on the exact integrated SHA (spec §3.1)

Goal: Plan A closes only after the validator proves the exact integrated `master` SHA. This dispatch happens after the operator re-enables Actions with read-only defaults (spec §3.1).

**Files:** none (manual dispatch + evidence capture).

- [ ] **A.7.1 — Operator re-enables Actions read-only.**

The operator re-enables GitHub Actions with repository defaults `contents: read`; package write remains unavailable (spec §3.1). Recorded in `freeze-record.md`.

- [ ] **A.7.2 — Dispatch the validator against the integrated SHA.**

Run (operator, with `gh`):
```bash
INTEGRATED=$(git rev-parse master)
gh workflow run validate-master.yml --ref master -f sha="${INTEGRATED}"
gh run watch
gh run view --log | grep -E 'workflow_blob_sha256|requested=|stored_blob='
```
Expected: run reaches `success`; the summary prints `workflow_blob_sha256=<64 hex>` and the requested/event/remote/HEAD SHAs are all equal.

- [ ] **A.7.3 — Negative-case coverage (spec §3.1).**

Spec §3.1 requires negatives that reject: branch, tag, alternate ref, event-SHA, checked-out-HEAD, requested-SHA, and executing-workflow-blob mismatches. These are exercised by the workflow's `test` assertions above (each mismatch aborts with a distinct `::error::`). Capture one evidence run per negative class by dispatching with each malformed input and recording the exact `::error::` line and non-zero exit:
  - wrong event/ref -> `if:` fails the job (skipped, not run) -> proves master-only.
  - requested != `GITHUB_SHA` -> `::error::requested != GITHUB_SHA`.
  - requested != remote master -> `::error::requested != remote master`.
  - checked-out HEAD != requested -> `::error::HEAD != requested SHA`.
  - blob mismatch -> `::error::workflow blob mismatch`.
  - non-40-hex input -> `::error::sha must be 40 lowercase hex`.

Expected: every negative case fails closed; none publishes; none advances `master`.

- [ ] **A.7.4 — Confirm publication remains disabled.**

Run:
```bash
grep -rnE 'packages:\s*write|push:\s*true|login-action|simojenki|DOCKERHUB' .github/workflows/
```
Expected: **no matches**. (Plan B alone introduces the protected `ghcr-publication` environment with a narrowly scoped writer.)

- [ ] **A.7.5 — Record the redaction attestation for this plan.**

Using A.2 hashes, record (in the private freeze record, or a public attestation holding only hashes): `policy_hash`, `baseline_commit`, this plan's final `master` SHA, full-file scan result (`ok=true`), diff result (`ok=true`). Attestation contains **no** matched values (spec §2.4).

**Definition of done for A.7:** validator green on the exact integrated SHA; all negative cases fail closed; publication still impossible; redaction attestation recorded.

---

## Plan A exit checklist (spec §1.1 row A, criteria 2, 3, 24)

- [ ] Freeze record retained; Actions disabled, every writer/credential revoked before push (criterion 2).
- [ ] No GHCR/Docker Hub writer exists in this plan; `ci.yml` is publish-incapable; PRs credential-free (criterion 2).
- [ ] Workflow is read-only with `persist-credentials: false`; Actions pinned by SHA (criterion 3, §3.2).
- [ ] `validate-master` is master-only `workflow_dispatch`; binds requested SHA == `GITHUB_SHA` == remote master == checked-out HEAD == executing workflow blob (criterion 3).
- [ ] Negative cases reject branch/tag/ref/event-SHA/HEAD/requested-SHA/blob mismatches (criterion 3).
- [ ] `master` advanced with `--ff-only`; `DESIGN_SHA` and `4db3d75` are ancestors; no squash/rebase/force (§3.2).
- [ ] Redaction policy version/hash and clean baseline recorded; full-file + diff gates pass; attestation holds only hashes (criterion 24).
- [ ] No publication, no VPS deployment, no upstream PR in this plan (non-goals §11).

## Adversarial-review focus for Plan A (report to Codex)

- Any residual `simojenki`, Docker Hub, `latest`, `DOCKERHUB_*`, or `packages: write` anywhere under `.github/`, `Dockerfile`, or docs.
- Any `<PINNED_SHA>` placeholder left in `ci.yml` or `validate-master.yml`, or any floating action tag (`@v*`, `@main`).
- `COPY .git` or any `.git`/credential/operator path still reachable by the Docker build.
- A `validate-master` job that can publish, login, or run on push/PR.
- `master` advanced by anything other than `--ff-only`, or `DESIGN_SHA` not an ancestor of the integrated SHA.
- Redaction gate missing, unversioned, or an attestation that embeds matched secret values.

## Coverage map: spec §12 acceptance -> Plan A task

| Criterion (spec §12) | Plan A task(s) |
|---|---|
| 2 (freeze, revoke writers/credentials, no publish) | A.1, A.3, A.7.4 |
| 3 (read-only workflow, exact SHA/ref/HEAD + executing-workflow-blob binding, negatives) | A.3.1, A.5, A.7.2, A.7.3 |
| 24 (redaction policy version/hash, baseline, full-file + diff gates, hash-only attestation) | A.2, A.3.9, A.4.4, A.7.5 |
| Non-goals §11 (no Docker Hub, no `latest`, no non-amd64, no upstream PR) | A.3, A.4 |
