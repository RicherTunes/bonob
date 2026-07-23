# Plan B — Supply chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebaseline dependencies, establish a deterministic closed Docker context with a pre-remote secret scan, run a no-secret build/test/scan job that produces build-once exact OCI bytes, and publish them through a protected artifact-only publisher to a private amd64 GHCR package — with **no VPS deployment** in this plan.

**Architecture:** Two jobs form a hard supply boundary (spec §4). Job 1 (build/test/scan) has read-only repository permissions, no registry/production secret, no `packages:write`; it consumes a version-controlled closed context generated from the validated `master` SHA, pre-scans it locally for secrets/prohibited paths, builds exactly once into an OCI archive, and emits checksummed OCI/SBOM/attestations as immutable workflow artifacts under pinned IDs. Job 2 (publisher) receives `packages:write` only after protected-environment approval and artifact-read; it downloads the pinned artifacts, verifies every archive/SBOM/attestation/hash, and pushes the already-built bytes — performing no checkout, no source code execution, no build, no cache restore. The image is private amd64 only; the tag matches `^sha-[0-9a-f]{40}$`; an unauthenticated pull must fail and an authorized VPS pull must succeed (verification only, not deployment).

**Tech Stack:** GitHub Actions (protected `ghcr-publication` environment, immutable full-SHA action references), Docker Buildx (`--output type=oci` archive), `npm audit`/`npm ci` lockfile-deterministic install, Trivy/Grype image scan, `cosign`/SBOM attestations, GHCR private package, Node 22 / TypeScript.

## Global Constraints

- **Plan-A prerequisite (design §1.1, row B):** Plan A complete and approved is required before Plan B begins; it supplies the exact-master candidate and leaves no writer enabled.
- **Closed context (design §12.5):** The deterministic allowlist covers every Dockerfile `COPY` and runtime output, replaces Git metadata with a minimal validated revision file, and emits sorted listing/archive hashes. Local secret/prohibited-path scanning passes before any remote access; no `.git`, credential, operator, or unlisted file is present.
- **Build evidence (design §12.6):** The no-secret read-only build/test/scan job creates the exact checksummed OCI/SBOM/attestations under pinned artifact IDs. Audit/scan policy, exact-identity exception allowlist, tool/database identities, timestamps, report hashes, source SHA, and artifact digest pass.
- **Publisher boundary (design §12.7):** Only after approval does a distinct publisher receive artifact-read plus narrowly scoped `packages:write`. It verifies pinned artifacts and executes no checkout, repository code, scripts/install/build/cache—only pinned verify/push tooling. Every other writer is removed; `master` equality at dispatch/pre-push/completion, destination-tag locking, rerun adoption, privacy/pull, digest/revision, and quarantine tests pass.
- **No deployment (design §1.1, row B; §11):** Plan B verifies a pull only; it never recreates a production container or promotes to production.
- **Independent review (design §12.25):** An independent adversarial/architectural re-review approves the final branch and fresh evidence set.

## Required Task Cadence

Every numbered task below is executed as a 2–5 minute action: first run its stated red command and record the expected non-zero exit, then make exactly the stated change, run the stated green command and require exit `0`, run the Plan-A redaction gate, and create the task's stated atomic commit. For an out-of-band or git-only gate, the red command is its rejected-precondition command and the green evidence is recorded in the adjacent evidence-file commit; never create an empty commit merely to satisfy this cadence.

---

## Program metadata

**Plan:** B — Supply chain
**Program:** RicherTunes bonob private-fork convergence (spec `docs/superpowers/specs/2026-07-23-private-fork-convergence-design.md`, §3.3, §4, §5.1).
**Entry dependency (spec §1.1 row B):** Plan A complete and approved (freeze integrated on `master`; `validate-master` green on the exact integrated SHA; no writer exists yet).
**Exit evidence (spec §1.1 row B, criteria 5, 6, 7):** exact manifest tested/scanned/pushed unchanged; zero unapproved high/critical findings; immutable private tag/digest; anonymous pull fails; authorized VPS pull succeeds; **no VPS deployment**.

## Baseline facts (verified against this worktree)

- `DESIGN_SHA = 3d45ad2ca26fd1ec3d8f8b52a11aa7f6b13b3634`; spec blob hash `94ea0ef7273db8b4b021ac70eda20c25d58bb55d`.
- Plan A delivers the integrated `master` SHA. Plan B begins by capturing that exact SHA as `B_MASTER` (Task B.0). Every artifact in this plan binds to `B_MASTER`.
- Dockerfile `COPY` sources that the closed allowlist must enumerate (`Dockerfile:19,23,24,25,26,57,58,59,60,61,62`): `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.json`, `jest.config.js`, `register.js`, `src/`, `typings/`, `.git` (removed by Plan A), `web/`, `src/Sonoswsdl-1.19.6-20231024.wsdl`. Plan A removed `COPY .git ./.git`; the allowlist must not re-add it.
- `package.json` dependency install is `npm ci` from `package-lock.json` (deterministic). `npm run gitinfo` writes `.gitinfo` via `git describe --tags` (spec §3.2 requires replacing Git metadata with a generated minimal revision file).
- Target registry: `ghcr.io/richertunes/bonob`; tag form is `sha-` followed by the validated 40-lowercase-hex source SHA; digest form is the validated 64-lowercase-hex SHA-256 digest emitted in the release manifest (spec §4).

## Nonwaivable invariants every step obeys

- **Two-job boundary (spec §4).** Build/test/scan is read-only with no `packages:write` and no secret; the publisher receives `packages:write` only after protected-environment approval and does not execute repository code.
- **Build once, push exact bytes.** The publisher pushes the archive Job 1 built; it never rebuilds (spec §4).
- **Closed context + pre-remote scan.** The Docker input is a generated deterministic allowlist, not the repo root; a local secret/prohibited-path scan passes before any remote builder/registry/cache is contacted (spec §3.2, criterion 5).
- **No secret in the build.** Secrets never enter build arguments, env, layers, cache mounts, metadata, or intermediate stages (spec §4). Job 1 has no secret; Job 2 has registry creds only.
- **Fail-closed audit/scan (spec §3.3, §5.1).** Zero unapproved high/critical findings; exceptions need a versioned exact-identity allowlist with advisory/component, reachability, owner, approval reference, expiration (criterion 6).
- **Tag/digest/immutability (spec §4).** Tag matches `^sha-[0-9a-f]{40}$`; concurrency lock keyed by `repo+tag`, `cancel-in-progress: false`; first run refuses a conflicting existing tag; rerun adopts only on matching local/release digest + OCI revision; `latest`/floating/Docker Hub/multi-arch disabled.
- **Private package (spec §4).** GHCR package stays private; unauthenticated pull fails; authorized VPS pull succeeds and verifies OCI revision == intended commit.
- **No VPS deployment (spec §1.1 row B, §11).** This plan verifies a pull only; it never recreates a production container or promotes to production.
- **Redaction gate.** Every public file change passes the Plan-A full-file + diff redaction/secret scan before commit.

---

## Files created or modified by this plan

- **Create:** `tools/context-allowlist.json` — version-controlled closed-context manifest (one entry per required path with expected mode/role).
- **Create:** `tools/build_context.mjs` — generator: from a clean exact-SHA checkout, materializes a deterministic context dir, emits sorted listing (path, mode, size, sha256) + archive hash; fails on any required-but-unlisted file; replaces `.git`-derived metadata with a minimal `.gitinfo`-replacement.
- **Create:** `tools/scan_context.mjs` — local prohibited-path + secret scan of the generated context; must pass before any remote access.
- **Create:** `.github/workflows/exception-allowlist.json` — versioned audit/scan exception list keyed to exact advisory/component identity (initially empty).
- **Create:** `tools/node-base-lock.json` — reviewed immutable Node base-image manifest digest used by Task B.4.
- **Create:** `docs/superpowers/evidence/plan-b-input.json` — immutable Plan-A master input record consumed by every local Plan-B command.
- **Create:** `.github/workflows/build-test-scan.yml` — Job 1: read-only, no secret, no `packages:write`; build once -> OCI archive + SBOM + attestations + hash manifest under pinned artifact IDs.
- **Create:** `.github/workflows/publish-ghcr.yml` — Job 2: protected `ghcr-publication` environment; artifact-read + narrowly scoped `packages:write`; verify-then-push only.
- **Create:** `tests/build_context.test.ts` — Jest test for the context generator (allowlist exhaustiveness, deterministic hash, `.git` exclusion).
- **Create:** `tests/exception_allowlist.test.ts` — Jest test that the exception allowlist schema is valid and every entry has the required fields + unexpired date.
- **Modify:** `Dockerfile` — accept the generated revision file instead of `git describe` over `.git`; emit OCI source/revision/creation labels bound to the exact commit.
- **Modify:** `package.json` — replace `gitinfo` script (`git describe --tags > .gitinfo`) with reading from the generated revision file (no `.git` dependency at build time).

> **Out-of-band (operator, not a code step):** creating the protected `ghcr-publication` environment, granting the narrowly scoped writer, and rotating the VPS pull token are GitHub/web/VPS actions outside this repo. They are documented in Task B.6; this plan edits no GitHub setting programmatically.

---

## Task B.0 — Capture the exact Plan-A integrated master

**Files:**
- Create: `docs/superpowers/evidence/plan-b-input.json`.

- [ ] **B.0.1 — Verify Plan A is integrated and the validator passed.**

Run:
```bash
git fetch origin
git checkout master
git rev-parse master
git merge-base --is-ancestor 3d45ad2 master ; echo "design_ancestor=$?"
grep -rnE 'packages:\s*write|push:\s*true|login-action|simojenki|DOCKERHUB' .github/workflows/ || true
```
Expected: `master` at the Plan-A integrated SHA; `DESIGN_SHA` is an ancestor (exit `0`); the grep returns **nothing** (Plan A left no writer). If Plan A's `validate-master` evidence is missing, stop — Plan B's entry dependency (spec §1.1) is unmet.

- [ ] **B.0.2 — Record `B_MASTER` and start a Plan B branch.**

Run:
```bash
B_MASTER=$(git rev-parse master)
printf '%s' "${B_MASTER}" | grep -Eq '^[0-9a-f]{40}$' || { echo "master is not a full lowercase SHA" >&2; exit 1; }
mkdir -p docs/superpowers/evidence
printf '{\n  "schema": "plan-b-input/v1",\n  "sourceSha": "%s"\n}\n' "${B_MASTER}" > docs/superpowers/evidence/plan-b-input.json
test "$(node -p "require('./docs/superpowers/evidence/plan-b-input.json').sourceSha")" = "${B_MASTER}"
echo "B_MASTER=${B_MASTER}"
git checkout -b supply-chain/b
git merge-base --is-ancestor "${B_MASTER}" HEAD ; echo "bmaster_ancestor=$?"
```
Expected: `B_MASTER` printed; the JSON record has schema `plan-b-input/v1` and the same SHA; branch `supply-chain/b` created; the recorded SHA is an ancestor (exit `0`). Every artifact in later tasks reads this record rather than accepting an operator-supplied SHA.

- [ ] **B.0.3 — Commit the immutable Plan-B input record.**

```bash
git add docs/superpowers/evidence/plan-b-input.json
git commit -m "docs(plan-b): record exact Plan-A master input"
```

**Definition of done for B.0:** Plan A integrated and writer-free; `B_MASTER` is persisted in the committed input record; Plan B branch started.

---

## Task B.1 — Deterministic closed context generator + allowlist (spec §3.2, criterion 5)

Goal: the Docker input is a generated deterministic directory, not the repo root; the generator fails on any required-but-unlisted file and never copies `.git`.

**Files:**
- Create: `tools/context-allowlist.json`
- Create: `tools/build_context.mjs`
- Test: `tests/build_context.test.ts`

- [ ] **B.1.1 — Write the closed-context allowlist.**

Create `tools/context-allowlist.json`. Each entry is a required Dockerfile `COPY` source or expected build-stage/runtime output; `.git` and credentials are deliberately absent:
```json
{
  "version": "1.0.0",
  "description": "Deterministic closed Docker context allowlist (spec §3.2)",
  "entries": [
    { "path": "package.json", "mode": "644", "role": "build+runtime" },
    { "path": "package-lock.json", "mode": "644", "role": "build+runtime" },
    { "path": ".npmrc", "mode": "644", "role": "build" },
    { "path": "tsconfig.json", "mode": "644", "role": "build" },
    { "path": "jest.config.js", "mode": "644", "role": "build" },
    { "path": "register.js", "mode": "644", "role": "build" },
    { "path": "src", "mode": "755", "role": "build+runtime", "recursive": true },
    { "path": "typings", "mode": "755", "role": "build", "recursive": true },
    { "path": "web", "mode": "755", "role": "runtime", "recursive": true },
    { "path": "src/Sonoswsdl-1.19.6-20231024.wsdl", "mode": "644", "role": "runtime" }
  ],
  "prohibited": [
    ".git",
    ".git/credentials",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "docs/superpowers/plans/freeze-record.md",
    ".glm-plan-prompt.md",
    ".claude"
  ]
}
```

- [ ] **B.1.2 — Write the generator (no deps, Node ESM).**

Create `tools/build_context.mjs`:
```javascript
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export function loadAllowlist(p = join(__dirname, "context-allowlist.json")) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Generate contextDir from repoRoot using the allowlist. Returns a sorted
// manifest of { path, mode, size, sha256 } plus an archive hash. Throws if a
// required file is missing or a prohibited path would be included.
export function generate(allowlist, contextDir, { revision } = {}) {
  mkdirSync(contextDir, { recursive: true });
  const manifest = [];
  for (const e of allowlist.entries) {
    const src = join(repoRoot, e.path);
    if (!existsSync(src)) throw new Error(`required-but-missing: ${e.path}`);
    const dest = join(contextDir, e.path);
    if (statSync(src).isDirectory()) {
      for (const f of walk(src)) {
        const rel = relative(repoRoot, f);
        mkdirSync(join(contextDir, dirname(rel)), { recursive: true });
        copyFileSync(f, join(contextDir, rel));
        manifest.push(entryFor(f, rel));
      }
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      manifest.push(entryFor(src, e.path));
    }
  }
  // Reject any prohibited path that slipped in.
  const got = new Set(manifest.map((m) => m.path));
  for (const p of allowlist.prohibited) {
    for (const g of got) if (g === p || g.startsWith(p.replace(/\.\*/, ""))) {
      throw new Error(`prohibited-in-context: ${g}`);
    }
  }
  // Minimal validated revision file (replaces git describe over .git).
  const rev = { commit: revision?.commit ?? "unknown", describe: revision?.describe ?? "unknown", source: "generated" };
  writeFileSync(join(contextDir, ".gitinfo"), `${rev.describe}\n`);
  writeFileSync(join(contextDir, ".revision.json"), JSON.stringify(rev, null, 2) + "\n");
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const archiveHash = createHash("sha256").update(manifest.map((m) => `${m.path}\0${m.mode}\0${m.size}\0${m.sha256}`).join("\n")).digest("hex");
  return { manifest, archiveHash, revision: rev };
}

function entryFor(abs, rel) {
  const st = statSync(abs);
  const mode = (st.mode & 0o777).toString(8);
  return { path: rel.replace(/\\/g, "/"), mode, size: st.size, sha256: sha256File(abs) };
}
```

- [ ] **B.1.3 — Write the failing Jest test.**

Create `tests/build_context.test.ts`:
```typescript
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllowlist, generate } from "../tools/build_context.mjs";

describe("closed Docker context generator (spec §3.2, criterion 5)", () => {
  const allowlist = loadAllowlist();

  it("every allowlist entry exists in the repo", () => {
    expect(allowlist.entries.length).toBeGreaterThan(0);
    const ctx = mkdtempSync(join(tmpdir(), "bctx-"));
    expect(() => generate(allowlist, ctx)).not.toThrow();
  });

  it("produces a deterministic sorted manifest and archive hash", () => {
    const a = mkdtempSync(join(tmpdir(), "bctx-a-"));
    const b = mkdtempSync(join(tmpdir(), "bctx-b-"));
    const ra = generate(allowlist, a);
    const rb = generate(allowlist, b);
    expect(ra.archiveHash).toBe(rb.archiveHash);
    expect(ra.manifest.map((m) => m.path)).toEqual([...ra.manifest.map((m) => m.path)].sort());
  });

  it("never copies .git, .git/credentials, or .env", () => {
    const ctx = mkdtempSync(join(tmpdir(), "bctx-neg-"));
    const { manifest } = generate(allowlist, ctx);
    const paths = manifest.map((m) => m.path);
    expect(paths).not.toContain(".git");
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".env"))).toBe(false);
  });
});
```

- [ ] **B.1.4 — Run the test and watch it fail.**

If the test is committed before `tools/build_context.mjs`:
```bash
npx jest tests/build_context.test.ts
```
Expected: `FAIL ... Cannot find module '../tools/build_context.mjs'`.

- [ ] **B.1.5 — Confirm green.**

Run:
```bash
npx jest tests/build_context.test.ts
```
Expected: `PASS`, 3 tests.

- [ ] **B.1.6 — Commit.**

```bash
git add tools/context-allowlist.json tools/build_context.mjs tests/build_context.test.ts
git commit -m "feat(plan-b): deterministic closed Docker context generator + allowlist"
```

**Definition of done for B.1:** generator + allowlist committed; deterministic hash proven; `.git`/credentials excluded by test.

---


## Task B.2 — Local pre-remote secret/prohibited-path scan (spec §3.2)

Goal: the generated context is scanned locally and must pass before any remote builder/registry/cache is contacted. A finding produces no remote access.

**Files:**
- Create: `tools/scan_context.mjs`
- Test: `tests/scan_context.test.ts` (extends coverage; also reuses Plan-A `redaction-policy.json`).

- [ ] **B.2.1 — Write the context scanner.**

Create `tools/scan_context.mjs`. It scans a directory tree against the closed-context prohibited list and the Plan-A redaction deny patterns; returns `{ ok, findings }`:
```javascript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./redact.mjs";
import { loadAllowlist } from "./build_context.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Scan a generated context dir. ok === true only when there are zero findings.
export function scanContext(contextDir) {
  const policy = loadPolicy();
  const allowlist = loadAllowlist();
  const findings = [];
  for (const f of walk(contextDir)) {
    const rel = relative(contextDir, f).replace(/\\/g, "/");
    // prohibited exact/prefix names
    for (const p of allowlist.prohibited) {
      const prefix = p.replace(/\.\*/, "");
      if (rel === p || rel.startsWith(prefix)) findings.push({ id: "prohibited-path", path: rel });
    }
    // secret/topology patterns from the redaction policy
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
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
```

- [ ] **B.2.2 — Write the failing Jest test.**

Create `tests/scan_context.test.ts`:
```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate } from "../tools/build_context.mjs";
import { loadAllowlist } from "../tools/build_context.mjs";
import { scanContext } from "../tools/scan_context.mjs";

describe("pre-remote context scan (spec §3.2)", () => {
  it("a clean generated context passes", () => {
    const ctx = mkdtempSync(join(tmpdir(), "bctx-clean-"));
    generate(loadAllowlist(), ctx);
    const r = scanContext(ctx);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("flags a planted secret file before any remote access", () => {
    const ctx = mkdtempSync(join(tmpdir(), "bctx-secret-"));
    generate(loadAllowlist(), ctx);
    mkdirSync(join(ctx, "config"), { recursive: true });
    writeFileSync(join(ctx, "config", "creds.env"), "BNB_SECRET=supersecret1234\n");
    const r = scanContext(ctx);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("credential-file-path");
  });

  it("flags a planted .git directory", () => {
    const ctx = mkdtempSync(join(tmpdir(), "bctx-git-"));
    generate(loadAllowlist(), ctx);
    mkdirSync(join(ctx, ".git"), { recursive: true });
    writeFileSync(join(ctx, ".git", "config"), "[remote]\n");
    const r = scanContext(ctx);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("prohibited-path");
  });
});
```

- [ ] **B.2.3 — Run the test and watch it fail (scanner not committed yet).**

Run:
```bash
npx jest tests/scan_context.test.ts
```
Expected: `FAIL ... Cannot find module '../tools/scan_context.mjs'`.

- [ ] **B.2.4 — Confirm green.**

Run:
```bash
npx jest tests/scan_context.test.ts
```
Expected: `PASS`, 3 tests.

- [ ] **B.2.5 — Commit.**

```bash
git add tools/scan_context.mjs tests/scan_context.test.ts
git commit -m "feat(plan-b): pre-remote secret/prohibited-path scan of generated context"
```

**Definition of done for B.2:** local scanner committed; clean context passes; planted `.git`/secret/credential fail before remote access.

---

## Task B.3 — Dependency rebaseline (spec §3.3, criterion 6)

Goal: from the new `master`, capture audit results, classify runtime vs dev-only, update in smallest compatible groups, and require zero high/critical in the production audit unless an approved exception exists.

**Files:**
- Create: `.github/workflows/exception-allowlist.json`
- Test: `tests/exception_allowlist.test.ts`
- Modify: `package.json` + `package-lock.json` (smallest compatible dependency groups).

- [ ] **B.3.1 — Capture the audit baseline.**

Run:
```bash
npm audit --omit=dev --json > /tmp/audit-prod.json || true
npm audit --json > /tmp/audit-all.json || true
node -e "const a=require('/tmp/audit-prod.json');console.log(JSON.stringify(a.metadata?.vulnerabilities||{}))"
```
Expected: a JSON object of severity counts (e.g. `{"low":N,"moderate":N,"high":N,"critical":N}`). Record the production numbers as the rebaseline baseline.

- [ ] **B.3.2 — Write the (initially empty) exception allowlist.**

Create `.github/workflows/exception-allowlist.json`:
```json
{
  "version": "1.0.0",
  "description": "Audit/scan exception allowlist (spec §3.3, criterion 6). Keyed to exact advisory/component identity.",
  "exceptions": []
}
```

- [ ] **B.3.3 — Write the failing Jest test for the exception schema.**

Create `tests/exception_allowlist.test.ts`:
```typescript
import { readFileSync } from "fs";
import { join } from "path";

interface ExceptionEntry {
  advisory: string;
  component: string;
  version: string;
  reachability: string;
  compensatingControl: string;
  owner: string;
  approvalReference: string;
  expires: string;
}

function load(): { version: string; exceptions: ExceptionEntry[] } {
  return JSON.parse(readFileSync(join(__dirname, "..", ".github", "workflows", "exception-allowlist.json"), "utf8"));
}

describe("audit/scan exception allowlist (spec §3.3, criterion 6)", () => {
  it("is versioned", () => {
    expect(load().version).toBe("1.0.0");
  });

  it("every entry has all required fields and an unexpired date", () => {
    const now = new Date("2026-07-23T00:00:00Z").getTime();
    for (const e of load().exceptions) {
      expect(e.advisory).toMatch(/^(GHSA|CVE)-[0-9A-Za-z-]+$/);
      expect(typeof e.component).toBe("string");
      expect(typeof e.version).toBe("string");
      expect(e.reachability.length).toBeGreaterThan(0);
      expect(e.compensatingControl.length).toBeGreaterThan(0);
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.approvalReference.length).toBeGreaterThan(0);
      expect(new Date(e.expires).getTime()).toBeGreaterThan(now);
    }
  });
});
```

- [ ] **B.3.4 — Run the test and watch it fail (allowlist not committed yet).**

Run:
```bash
npx jest tests/exception_allowlist.test.ts
```
Expected: `FAIL ... ENOENT: no such file ... exception-allowlist.json`.

- [ ] **B.3.5 — Confirm green (allowlist exists, empty exceptions pass).**

Run:
```bash
npx jest tests/exception_allowlist.test.ts
```
Expected: `PASS`, 2 tests.

- [ ] **B.3.6 — Update direct dependencies in smallest compatible groups.**

Update runtime minors and development-tool minors as two independent, atomic groups; the commands below make no major-version change and do not use an operator-selected package or version:
```bash
set -euo pipefail
npx npm-check-updates --target minor --dep prod --filter '/^(axios|dayjs|eta|express|fp-ts|jsonwebtoken|morgan|sharp|soap|underscore|winston)$/' --upgrade
npm install --package-lock-only --ignore-scripts
npm ci
npm run build
npm test
npm audit --omit=dev
```
Then run the separate development-tool group:
```bash
set -euo pipefail
npx npm-check-updates --target minor --dep dev --filter '/^(@swc\/core|@swc\/jest|@types\/jest|jest|nodemon|npm-check-updates|supertest|ts-node|typescript)$/' --upgrade
npm install --package-lock-only --ignore-scripts
npm ci
npm run build
npm test
npm audit --omit=dev
```
Expected after each group: build + tests pass; production audit (`--omit=dev`) high/critical == 0 **unless** an entry was added to `exception-allowlist.json` (with all required fields + future expiry). No major update is bundled with unrelated behavior changes (spec §1.1).

- [ ] **B.3.7 — Commit each group atomically.**

```bash
git add package.json package-lock.json .github/workflows/exception-allowlist.json tests/exception_allowlist.test.ts
git commit -m "fix(plan-b): rebaseline runtime dependency minors"
```
After the development-tool command passes its redaction gate, commit it separately:
```bash
git add package.json package-lock.json
git commit -m "build(plan-b): rebaseline development-tool dependency minors"
```

**Definition of done for B.3:** production audit reports zero unapproved high/critical; exception allowlist schema enforced by test; every group committed atomically.

---


## Task B.4 — Dockerfile: digest-pinned base, generated revision, OCI labels (spec §3.2, §4)

Goal: the Dockerfile uses digest-pinned bases, no `apt upgrade` blanket, reads the generated revision file (no `.git`), and emits OCI source/revision/creation labels bound to the exact commit.

**Files:**
- Modify: `Dockerfile` (current `FROM node:22-bookworm-slim` at `Dockerfile:1` and `:50`; `apt-get -y upgrade` at `:9` and `:53`; `RUN npm run gitinfo` at `:28`).

- [ ] **B.4.1 — Pin the base images by the reviewed manifest digest.**

Resolve and record the canonical manifest digest before editing; the command fails if the registry output is not a SHA-256 digest. This plan records the reviewed result `sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` from `node:22-bookworm-slim`:
```bash
set -euo pipefail
NODE_BASE_DIGEST="$(docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}')"
printf '%s' "${NODE_BASE_DIGEST}" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo "invalid Node manifest digest" >&2; exit 1; }
test "${NODE_BASE_DIGEST}" = "sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3" || { echo "reviewed Node manifest moved; stop for re-review" >&2; exit 1; }
printf '{\n  "image": "node:22-bookworm-slim",\n  "manifestDigest": "%s"\n}\n' "${NODE_BASE_DIGEST}" > tools/node-base-lock.json
```
Create `tools/node-base-lock.json` exactly as produced above, then use the recorded digest in both stages:
```dockerfile
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
...
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
```
Gate:
```bash
grep -nE 'FROM node:22-bookworm-slim$' Dockerfile
```
Expected: **no matches** (only digest-pinned `FROM` lines remain).

- [ ] **B.4.2 — Remove blanket `apt-get upgrade`.**

Delete the `apt-get -y upgrade` lines in both stages (`Dockerfile:8`, `Dockerfile:49` in the current worktree). Pin APT to the exact Debian snapshot recorded here, then install the existing package set without a blanket upgrade (spec §4):
```dockerfile
RUN printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260723T000000Z bookworm main' > /etc/apt/sources.list && \
    rm -f /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get -y install --no-install-recommends \
        libvips-dev \
        python3 \
        make \
        git \
        g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
```
Record the Debian snapshot/index identity (e.g. a `deb822` snapshot timestamp) in the release manifest (Task B.5). Gate:
```bash
grep -nE 'apt-get -y upgrade' Dockerfile
```
Expected: **no matches**.

- [ ] **B.4.3 — Read revision from the generated file (no `.git`).**

Replace `RUN npm run gitinfo && \` (`Dockerfile:28`) and the build stage's reliance on `git describe` over `.git`. Plan A already removed `COPY .git ./.git`. The context generator writes `.gitinfo` + `.revision.json` (Task B.1.2), so the build reads them:
```dockerfile
COPY .gitinfo .revision.json ./
RUN npm run build && \
    npm prune --omit=dev
```
And update `package.json` `gitinfo` (Task B.4.4) so it no longer shells out to `git`.

- [ ] **B.4.4 — Update `package.json` `gitinfo`.**

Change the `gitinfo` script so it is a no-op when `.gitinfo` already exists (the context generator provides it); it must not require `.git`:
```json
    "gitinfo": "test -s .gitinfo || echo v?? > .gitinfo"
```
Gate:
```bash
grep -n '"gitinfo": "git describe' package.json
```
Expected: **no matches**.

- [ ] **B.4.5 — Validate the recorded base lock and add OCI labels.**

Validate the persisted lock before the build, then add OCI labels bound to build arguments supplied by the validated source SHA and its commit time:
```bash
set -euo pipefail
test "$(node -p "require('./tools/node-base-lock.json').manifestDigest")" = "sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
```
```dockerfile
ARG OCI_REVISION
ARG OCI_CREATED
LABEL   org.opencontainers.image.source="https://github.com/RicherTunes/bonob" \
        org.opencontainers.image.revision="${OCI_REVISION}" \
        org.opencontainers.image.created="${OCI_CREATED}" \
        org.opencontainers.image.description="bonob SONOS SMAPI implementation (RicherTunes fork)" \
        org.opencontainers.image.licenses="GPL-3.0-only"
```
Gates:
```bash
rg -n '\\x3c[A-Z_][A-Z0-9_]*>|github\.com/simojenki' Dockerfile
grep -nE 'org.opencontainers.image.(revision|created|source)' Dockerfile
```
Expected: first grep **no matches**; second grep shows `revision`, `created`, and `source` labels.

- [ ] **B.4.6 — Local build gate using the generated context.**

Read the persisted input record, generate the context, scan it, and build from the directory (not the repo root):
```bash
B_MASTER="$(node -p "require('./docs/superpowers/evidence/plan-b-input.json').sourceSha")"
printf '%s' "${B_MASTER}" | grep -Eq '^[0-9a-f]{40}$' || { echo "invalid recorded source SHA" >&2; exit 1; }
export B_MASTER
node -e "import('./tools/build_context.mjs').then(m=>{const a=m.loadAllowlist();m.generate(a,'./build-context',{revision:{commit:process.env.B_MASTER,describe:'v0.0.0'}})})"
node -e "import('./tools/scan_context.mjs').then(m=>{const r=m.scanContext('./build-context');console.log(JSON.stringify(r));process.exit(r.ok?0:1)})"
OCI_CREATED="$(git show -s --format=%cI "${B_MASTER}")"
printf '%s' "${OCI_CREATED}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$' || { echo "invalid commit timestamp" >&2; exit 1; }
docker buildx build --platform linux/amd64 --load -f Dockerfile --build-arg "OCI_REVISION=${B_MASTER}" --build-arg "OCI_CREATED=${OCI_CREATED}" ./build-context
```
Expected: scan `{"ok":true,"findings":[]}`; image builds with the OCI revision label present.

- [ ] **B.4.7 — Commit.**

```bash
git add Dockerfile package.json tools/node-base-lock.json
git commit -m "fix(plan-b): digest-pinned base, no apt upgrade, generated revision + OCI labels"
```

**Definition of done for B.4:** bases digest-pinned; no blanket upgrade; revision from generated file; OCI labels bound to commit; builds from the scanned closed context.

---

## Task B.5 — No-secret build/test/scan job (Job 1) (spec §4, criterion 6)

Goal: a read-only workflow that builds exactly once into an OCI archive, tests/scans that exact manifest, and emits checksummed OCI/SBOM/attestations + a hash manifest under pinned artifact IDs. No registry/production secret, no `packages:write`.

**Files:**
- Create: `.github/workflows/build-test-scan.yml`

- [ ] **B.5.1 — Write Job 1.**

Create `.github/workflows/build-test-scan.yml`:
```yaml
name: build-test-scan

on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Full lowercase 40-hex master SHA to build"
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: bts-${{ github.repository }}-${{ inputs.sha }}
  cancel-in-progress: false

jobs:
  build_test_scan:
    name: Build once / test / scan (no secret, no packages:write)
    runs-on: ubuntu-latest
    permissions:
      contents: read
    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' }}
    steps:
      - name: Require 40-hex SHA == event == remote master
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          echo '${{ inputs.sha }}' | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::sha must be 40 lowercase hex"; exit 1; }
          test "${{ inputs.sha }}" = "${{ github.sha }}" || { echo "::error::requested != GITHUB_SHA"; exit 1; }
          REMOTE=$(gh api repos/${{ github.repository }}/git/refs/heads/master --jq '.object.sha')
          test "${{ inputs.sha }}" = "${REMOTE}" || { echo "::error::requested != remote master"; exit 1; }

      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ inputs.sha }}
          persist-credentials: false

      - name: Checked-out HEAD == requested SHA
        run: test "$(git rev-parse HEAD)" = "${{ inputs.sha }}"

      - name: Record validated OCI creation time from the requested commit
        run: |
          set -euo pipefail
          OCI_CREATED="$(git show -s --format=%cI "${{ inputs.sha }}")"
          printf '%s' "${OCI_CREATED}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$' || { echo "invalid commit timestamp" >&2; exit 1; }
          echo "OCI_CREATED=${OCI_CREATED}" >> "$GITHUB_ENV"

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22

      - name: Deterministic install + tests + production audit
        run: |
          npm ci
          npm run build
          npm test
          npm audit --omit=dev --audit-level=high

      - name: Generate + pre-scan closed context (no remote access yet)
        run: |
          node -e "import('./tools/build_context.mjs').then(m=>{const a=m.loadAllowlist();m.generate(a,'./build-context',{revision:{commit:'${{ inputs.sha }}',describe:'${{ inputs.sha }}'}})})"
          node -e "import('./tools/scan_context.mjs').then(m=>{const r=m.scanContext('./build-context');console.log(JSON.stringify(r));process.exit(r.ok?0:1)})"
          tar --sort=name --owner=0 --group=0 --numeric-owner -cf context.tar -C build-context .

      - name: Build exactly once into an OCI archive
        uses: docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435 # v3.11.1
      - uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0
        with:
          context: ./build-context
          file: ./Dockerfile
          platforms: linux/amd64
          push: false
          load: true
          tags: bonob:${{ inputs.sha }}
          build-args: |
            OCI_REVISION=${{ inputs.sha }}
            OCI_CREATED=${{ env.OCI_CREATED }}
          outputs: type=oci,dest=image.oci
      - name: Archive + digest manifest
        run: |
          sha256sum image.oci context.tar > hashes.txt
          docker image inspect bonob:${{ inputs.sha }} --format '{{json .RootFS.Layers}}' > layers.json
          cat hashes.txt

      - name: Image scan (zero unapproved high/critical)
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          input: image.oci
          severity: HIGH,CRITICAL
          exit-code: '1'
          ignore-unfixed: true

      - name: SBOM + attestation
        uses: anchore/sbom-action@f8bdd1d8ac5e901a77a92f111440fdb1b593736b # v0.20.6
        with:
          path: image.oci
          artifact-name: sbom.spdx.json
          upload: true

      - name: Upload immutable artifacts under pinned identity
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: oci-build-${{ inputs.sha }}
          path: |
            image.oci
            context.tar
            hashes.txt
            layers.json
          retention-days: 30
```
Verify each inline immutable action commit against the canonical release tag before commit. The following complete gate validates the remotely resolved ID and fails on drift; it never accepts a substituted identifier:
```bash
set -euo pipefail
verify_action() { repository="$1"; tag="$2"; expected="$3"; actual="$(git ls-remote "https://github.com/${repository}.git" "refs/tags/${tag}" | awk 'NR==1 { print $1 }')"; printf '%s' "${actual}" | grep -Eq '^[0-9a-f]{40}$' || { echo "unresolvable action tag: ${repository}@${tag}" >&2; exit 1; }; test "${actual}" = "${expected}" || { echo "action lock mismatch: ${repository}@${tag}" >&2; exit 1; }; }
verify_action actions/checkout v4.2.2 11bd71901bbe5b1630ceea73d27597364c9af683
verify_action actions/setup-node v4.4.0 49933ea5288caeca8642d1e84afbd3f7d6820020
verify_action docker/setup-buildx-action v3.11.1 e468171a9de216ec08956ac3ada2f0791b6bd435
verify_action docker/build-push-action v6.18.0 263435318d21b8e681c14492fe198d362a7d2c83
verify_action aquasecurity/trivy-action v0.36.0 ed142fd0673e97e23eac54620cfb913e5ce36c25
verify_action anchore/sbom-action v0.20.6 f8bdd1d8ac5e901a77a92f111440fdb1b593736b
verify_action actions/upload-artifact v4.6.2 ea165f8d65b6e75b540449e92b4886f43607fa02
```
Then run the structural gate:
```bash
rg -n '@(v[0-9]|main|master)|\\x3c[A-Z_][A-Z0-9_]*>|packages:\s*write|secrets\.(DOCKERHUB|GHCR|BNB)|push:\s*true' .github/workflows/build-test-scan.yml
```
Expected: **no matches** (no placeholder, no secret reference, no push, no packages:write).

- [ ] **B.5.2 — Structural test for Job 1.**

Create `tests/build_test_scan_workflow.test.ts`:
```typescript
import { readFileSync } from "fs";
import { join } from "path";

const wf = readFileSync(join(__dirname, "..", ".github", "workflows", "build-test-scan.yml"), "utf8");

describe("build-test-scan workflow (spec §4, criterion 6)", () => {
  it("is master-only manual dispatch", () => {
    expect(wf).toMatch(/on:\n  workflow_dispatch:/);
    expect(wf).toContain("github.event_name == 'workflow_dispatch'");
    expect(wf).toContain("github.ref == 'refs/heads/master'");
  });
  it("is read-only with no packages:write and no registry secret", () => {
    expect(wf).not.toMatch(/packages:\s*write/);
    expect(wf).not.toMatch(/secrets\.(DOCKERHUB|GHCR_PAT|BNB)/);
    expect(wf).toContain("persist-credentials: false");
  });
  it("pre-scans the closed context before any remote builder", () => {
    expect(wf).toContain("scanContext('./build-context')");
    expect(wf).toContain("process.exit(r.ok?0:1)");
  });
  it("builds once to an OCI archive and never pushes", () => {
    expect(wf).toContain("outputs: type=oci,dest=image.oci");
    expect(wf).toContain("push: false");
  });
  it("scans and fails on unapproved high/critical", () => {
    expect(wf).toContain("severity: HIGH,CRITICAL");
    expect(wf).toContain("exit-code: '1'");
  });
  it("emits checksummed artifacts under a pinned identity", () => {
    expect(wf).toContain("sha256sum image.oci");
    expect(wf).toContain("name: oci-build-${{ inputs.sha }}");
  });
});
```

- [ ] **B.5.3 — Run failing, then green.**

Run:
```bash
npx jest tests/build_test_scan_workflow.test.ts
```
Expected (before workflow exists): `FAIL ... ENOENT`. After: `PASS`, 6 tests.

- [ ] **B.5.4 — Commit.**

```bash
git add .github/workflows/build-test-scan.yml tests/build_test_scan_workflow.test.ts
git commit -m "feat(plan-b): no-secret build/test/scan job, build-once OCI archive"
```

**Definition of done for B.5:** Job 1 committed; read-only; pre-scans context; builds once to OCI; scans fail-closed; checksummed artifacts pinned by SHA.

---


## Task B.6 — Protected artifact-only publisher (Job 2) (spec §4, criterion 7)

Goal: after protected-environment approval, a publisher with artifact-read + narrowly scoped `packages:write` downloads the pinned artifacts, verifies every hash/SBOM/attestation, and pushes the already-built bytes. No checkout, no source code execution, no build, no cache restore.

**Files:**
- Create: `.github/workflows/publish-ghcr.yml`

- [ ] **B.6.1 — Operator creates the protected environment (out-of-band).**

The operator creates the `ghcr-publication` environment with required reviewers and grants one narrowly scoped PAT/token with `packages:write` for `ghcr.io/richertunes/bonob` only (spec §4). Plan B removes every other registry writer before granting this one. Recorded in the Plan-A freeze record update.

- [ ] **B.6.2 — Write Job 2.**

Create `.github/workflows/publish-ghcr.yml`:
```yaml
name: publish-ghcr

on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Full lowercase 40-hex master SHA whose pinned build artifact is published"
        required: true
        type: string
      run_id:
        description: "The exact build-test-scan run ID that produced the artifact"
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: publish-${{ github.repository }}-sha-${{ inputs.sha }}
  cancel-in-progress: false

jobs:
  publish:
    name: Verify pinned artifact and push exact bytes
    runs-on: ubuntu-latest
    environment: ghcr-publication
    permissions:
      contents: read
      packages: write
    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' }}
    steps:
      - name: Require 40-hex SHA == remote master at dispatch
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          echo '${{ inputs.sha }}' | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::sha must be 40 lowercase hex"; exit 1; }
          REMOTE=$(gh api repos/${{ github.repository }}/git/refs/heads/master --jq '.object.sha')
          test "${{ inputs.sha }}" = "${REMOTE}" || { echo "::error::requested != remote master at dispatch"; exit 1; }

      - name: Download ONLY the pinned build artifact (no checkout, no source)
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: oci-build-${{ inputs.sha }}
          run-id: ${{ inputs.run_id }}
          path: artifact

      - name: Verify hashes before any push
        run: |
          set -euo pipefail
          cd artifact
          sha256sum -c hashes.txt
          test -s image.oci && test -s context.tar && test -s layers.json

      - name: Re-require master == requested SHA immediately before push
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          REMOTE=$(gh api repos/${{ github.repository }}/git/refs/heads/master --jq '.object.sha')
          echo "pre_push_remote=${REMOTE}"
          test "${{ inputs.sha }}" = "${REMOTE}" || { echo "::error::master moved pre-push; abort without publication"; exit 1; }

      - name: Load the exact archive (no rebuild) and tag the validated source SHA
        run: |
          set -euo pipefail
          TAG="ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}"
          echo '${{ inputs.sha }}' | grep -Eq '^[0-9a-f]{40}$'
          echo "$TAG" | grep -Eq '^ghcr\.io/richertunes/bonob:sha-[0-9a-f]{40}$'
          docker load -i artifact/image.oci
          docker tag bonob:${{ inputs.sha }} "$TAG"

      - name: Login + push (narrowly scoped packages:write only)
        uses: docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772 # v3.4.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GHCR_PUBLISH_TOKEN }}
      - run: docker push "ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}"

      - name: Verify digest + OCI revision, then re-require master == requested SHA
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          DIGEST=$(docker inspect "ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')
          echo "digest=${DIGEST}"
          REVISION=$(docker inspect "ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
          echo "revision=${REVISION}"
          test "${REVISION}" = "${{ inputs.sha }}" || { echo "::error::OCI revision mismatch; quarantine"; exit 1; }
          REMOTE=$(gh api repos/${{ github.repository }}/git/refs/heads/master --jq '.object.sha')
          echo "post_push_remote=${REMOTE}"
          test "${{ inputs.sha }}" = "${REMOTE}" || { echo "::error::master moved post-push; quarantine"; exit 1; }
          echo "ghcr_digest=${DIGEST}" >> "$GITHUB_STEP_SUMMARY"
```
Verify the two inline immutable action commits before commit. This complete gate validates the remotely resolved ID and fails on drift:
```bash
set -euo pipefail
verify_action() { repository="$1"; tag="$2"; expected="$3"; actual="$(git ls-remote "https://github.com/${repository}.git" "refs/tags/${tag}" | awk 'NR==1 { print $1 }')"; printf '%s' "${actual}" | grep -Eq '^[0-9a-f]{40}$' || { echo "unresolvable action tag: ${repository}@${tag}" >&2; exit 1; }; test "${actual}" = "${expected}" || { echo "action lock mismatch: ${repository}@${tag}" >&2; exit 1; }; }
verify_action actions/download-artifact v4.3.0 d3f86a106a0bac45b974a628896c90dbdf5c8093
verify_action docker/login-action v3.4.0 74a5d142397b4f367a81961eba4e8cd7edddf772
```
Then run the structural gates:
```bash
rg -n '@(v[0-9]|main|master)|\\x3c[A-Z_][A-Z0-9_]*>|actions/checkout|npm ci|npm run build|build-push-action|cache-from|cache-to' .github/workflows/publish-ghcr.yml
```
Expected: **no matches** (no checkout, no install/build, no buildx, no cache).

- [ ] **B.6.3 — Structural test for Job 2 (no checkout/build, verify-then-push).**

Create `tests/publish_ghcr_workflow.test.ts`:
```typescript
import { readFileSync } from "fs";
import { join } from "path";

const wf = readFileSync(join(__dirname, "..", ".github", "workflows", "publish-ghcr.yml"), "utf8");

describe("publish-ghcr workflow (spec §4, criterion 7)", () => {
  it("uses the protected ghcr-publication environment", () => {
    expect(wf).toContain("environment: ghcr-publication");
  });
  it("never checks out source and never builds", () => {
    expect(wf).not.toMatch(/uses: actions\/checkout/);
    expect(wf).not.toMatch(/npm (ci|run build|install)/);
    expect(wf).not.toMatch(/build-push-action/);
    expect(wf).not.toMatch(/cache-(from|to)/);
  });
  it("downloads only the pinned run/artifact and verifies hashes", () => {
    expect(wf).toContain("name: oci-build-${{ inputs.sha }}");
    expect(wf).toContain("run-id: ${{ inputs.run_id }}");
    expect(wf).toContain("sha256sum -c hashes.txt");
  });
  it("requires master == requested SHA at dispatch, pre-push, and post-push", () => {
    expect(wf).toContain("requested != remote master at dispatch");
    expect(wf).toContain("master moved pre-push");
    expect(wf).toContain("master moved post-push");
  });
  it("tags the validated 40-hex source SHA and verifies OCI revision == requested SHA", () => {
    expect(wf).toContain("sha-[0-9a-f]{40}");
    expect(wf).toContain("org.opencontainers.image.revision");
    expect(wf).toContain("OCI revision mismatch; quarantine");
  });
});
```

- [ ] **B.6.4 — Run failing, then green.**

Run:
```bash
npx jest tests/publish_ghcr_workflow.test.ts
```
Expected (before workflow exists): `FAIL ... ENOENT`. After: `PASS`, 5 tests.

- [ ] **B.6.5 — Commit.**

```bash
git add .github/workflows/publish-ghcr.yml tests/publish_ghcr_workflow.test.ts
git commit -m "feat(plan-b): protected artifact-only publisher, verify-then-push exact bytes"
```

**Definition of done for B.6:** Job 2 committed; protected environment; no checkout/build; pinned-artifact verification; master equality at dispatch/pre-push/post-push; OCI revision verified.

---

## Task B.7 — Writer/tag/rerun/digest controls + privacy/pull (spec §4, criterion 7)

Goal: enforce the immutability, rerun, and privacy rules: concurrency lock, existing-tag handling, rerun adoption, private package, anonymous-pull-fails / authorized-pull-succeeds (verification only, no deployment).

**Files:**
- Modify: `.github/workflows/publish-ghcr.yml` (rerun/existing-tag handling added in B.7.1).
- Operator: package privacy + VPS pull token (out-of-band, B.7.4).

- [ ] **B.7.1 — Add existing-tag / rerun handling to the publisher.**

Insert before the push step (B.6.2 `docker push`) a guard that (a) a first run refuses a conflicting existing tag, and (b) a rerun adopts the tag only when the retained digest + OCI revision match:
```yaml
      - name: Existing-tag / rerun policy
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          TAG="ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}"
          if docker manifest inspect "$TAG" >/dev/null 2>&1; then
            EXISTING_DIGEST=$(docker buildx imagetools inspect "$TAG" --format '{{.Manifest.Digest}}' 2>/dev/null || true)
            LOCAL_DIGEST=$(docker inspect bonob:${{ inputs.sha }} --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//' || true)
            echo "existing=${EXISTING_DIGEST} local=${LOCAL_DIGEST}"
            if [ -z "${EXISTING_DIGEST}" ] || [ "${EXISTING_DIGEST}" != "${LOCAL_DIGEST}" ]; then
              echo "::error::conflicting existing tag; first run refuses; rerun adopts only on digest match"
              exit 1
            fi
            echo "::notice::rerun adopting existing identical tag; no push needed"
            echo "adopted=true" >> "$GITHUB_ENV"
          fi
      - name: Push only when not adopted
        if: ${{ env.adopted != 'true' }}
        run: docker push "ghcr.io/richertunes/bonob:sha-${{ inputs.sha }}"
```
Gate:
```bash
grep -nE 'cancel-in-progress: false|sha-\$\{\{ inputs.sha \}\}|adopted' .github/workflows/publish-ghcr.yml
```
Expected: matches for the concurrency group (B.6.2 `cancel-in-progress: false`), the tag pattern, and the adoption logic.

- [ ] **B.7.2 — Structural test for tag/rerun/immutability.**

Extend `tests/publish_ghcr_workflow.test.ts` with:
```typescript
  it("enforces concurrency lock and rerun adoption only on digest match", () => {
    expect(wf).toContain("group: publish-${{ github.repository }}-sha-${{ inputs.sha }}");
    expect(wf).toContain("cancel-in-progress: false");
    expect(wf).toContain("conflicting existing tag");
    expect(wf).toContain("rerun adopting existing identical tag");
  });
  it("disables latest, floating, Docker Hub, and multi-arch", () => {
    expect(wf).not.toMatch(/:latest\b/);
    expect(wf).not.toMatch(/docker\.io\/richtertunes/);
    expect(wf).not.toMatch(/platforms:.*arm/);
  });
```
Run:
```bash
npx jest tests/publish_ghcr_workflow.test.ts
```
Expected: `PASS`, 7 tests.

- [ ] **B.7.3 — Commit.**

```bash
git add .github/workflows/publish-ghcr.yml tests/publish_ghcr_workflow.test.ts
git commit -m "feat(plan-b): tag/rerun/digest immutability + privacy/tag controls"
```

- [ ] **B.7.4 — Operator: keep the package private + create the VPS pull token (out-of-band).**

The operator sets the GHCR package visibility to **private** and creates a root-readable VPS credential with `packages:read` only (spec §4). This is a GitHub/web + VPS action, recorded in the freeze record. This plan edits no setting programmatically.

- [ ] **B.7.5 — Verify privacy + pull (no deployment).**

On the VPS (verification only — do **not** recreate the production container):
```bash
# Anonymous pull must FAIL:
docker pull ghcr.io/richertunes/bonob:sha-${B_MASTER} 2>&1 | grep -E 'denied|unauthorized|forbidden' && echo "ANON_FAIL=ok" || echo "ANON_FAIL=FAIL"
# Authorized pull must SUCCEED and verify OCI revision:
docker login ghcr.io -u richertunes-vps --password-stdin < /root/.ghcr-pull.token
docker pull ghcr.io/richertunes/bonob:sha-${B_MASTER}
docker inspect ghcr.io/richertunes/bonob:sha-${B_MASTER} --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' | grep -Eq "^${B_MASTER}$" && echo "REV_OK=ok" || echo "REV_OK=FAIL"
docker logout ghcr.io
```
Expected: `ANON_FAIL=ok`; authorized pull succeeds; `REV_OK=ok` (OCI revision == `B_MASTER`). No production container is recreated (spec §1.1 row B, §11).

**Definition of done for B.7:** concurrency lock + rerun adoption enforced; package private; anonymous pull denied; authorized pull succeeds with correct revision; no deployment.

---

## Plan B exit checklist (spec §1.1 row B, criteria 5, 6, 7)

- [ ] Deterministic allowlist covers every Dockerfile `COPY` and runtime output; `.git` replaced by a minimal revision file; sorted listing/archive hashes emitted (criterion 5).
- [ ] Local secret/prohibited-path scan of the generated context passes before any remote access; no `.git`, credential, operator, or unlisted file present (criterion 5).
- [ ] No-secret build/test/scan job produces exact checksummed OCI/SBOM/attestations under pinned IDs; zero unapproved high/critical; audit/scan policy, tool/db identity, timestamps, report hashes, source SHA, digest pass (criterion 6).
- [ ] Publisher receives artifact-read + narrowly scoped `packages:write` only after approval; executes no checkout/source/build/cache; master equality at dispatch/pre-push/completion; tag locking, rerun adoption, privacy/pull, digest/revision, quarantine pass (criterion 7).
- [ ] Tag matches `^sha-[0-9a-f]{40}$`; concurrency lock `cancel-in-progress: false`; `latest`/floating/Docker Hub/multi-arch disabled.
- [ ] GHCR package private; unauthenticated pull fails; authorized VPS pull succeeds with OCI revision == intended commit; **no VPS deployment**.
- [ ] Every change passed the Plan-A redaction gate before commit.

## Adversarial-review focus for Plan B (report to Codex)

- Any non-immutable action reference in `build-test-scan.yml` or `publish-ghcr.yml`, including a floating tag (`@v*`, `@main`, or `@master`).
- Any secret/credential reference in Job 1, or any `packages: write` outside the `ghcr-publication` environment in Job 2.
- Any checkout/install/build/cache step in the publisher (it must push exact bytes only).
- Any path where the Docker build receives the repo root instead of the scanned closed context.
- A `latest`/floating/Docker Hub/multi-arch target anywhere; a missing concurrency lock or `cancel-in-progress: true`.
- A rerun that pushes (rather than adopts) on an existing tag, or accepts a digest mismatch.
- A privacy gap: package left public, anonymous pull succeeding, or a VPS deployment disguised as a "pull".

## Coverage map: spec §12 acceptance -> Plan B task

| Criterion (spec §12) | Plan B task(s) |
|---|---|
| 5 (deterministic allowlist, minimal revision file, listing/archive hashes, pre-remote scan, no `.git`/credential/operator/unlisted) | B.1, B.2, B.4 |
| 6 (no-secret read-only build/test/scan job, checksummed OCI/SBOM/attestations, audit/scan policy, tool identities, timestamps, hashes, digest) | B.3, B.5, B.4 |
| 7 (protected publisher, no checkout/build, artifact verification, writer removal, master equality dispatch/pre-push/completion, tag/rerun/digest/privacy/quarantine) | B.6, B.7 |
| Non-goals §11 (no Docker Hub, no `latest`, no non-amd64, no VPS deployment) | B.4, B.6, B.7.5 |

## Interface/type-consistency map

| Producer | Exact value contract | Consumer | Enforcement |
|---|---|---|---|
| B.0 | `docs/superpowers/evidence/plan-b-input.json.sourceSha`: lowercase 40-hex `master` commit | B.4 local build and B.7 pull verification | `git rev-parse`, JSON equality check, ancestry check, and 40-hex workflow input validation |
| B.4.1 | `tools/node-base-lock.json.manifestDigest`: `sha256:` plus 64 lowercase hex | both Dockerfile `FROM` statements | lock-file equality check before build |
| B.1 | generated `.revision.json.commit` and `.gitinfo`: exactly `B_MASTER`; sorted context listing/archive hashes | B.4 Docker build and B.5 artifact manifest | generator tests and pre-remote scan |
| B.5 | `inputs.sha`, checked-out `HEAD`, remote `master`, OCI revision, artifact name, and `OCI_CREATED`: validated exact source SHA / ISO-8601 commit time | B.6 artifact download and label verification | workflow equality checks, hash manifest, and structural Jest test |
| B.6/B.7 | GHCR tag: `sha-` plus the exact 40-hex source SHA; OCI digest: `sha256:` plus 64 lowercase hex | protected publisher and privacy/pull verifier | tag regex, `sha256sum -c`, master checks at dispatch/pre-push/post-push, and OCI revision comparison |
