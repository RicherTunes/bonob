# bonob fork — Coverage & Test-Quality Program (Design / Charter)

- **Date:** 2026-08-02
- **Repo:** `C:\Users\Alexandre\.claude-perso\jobs\6b9b8f0d\tmp\bonob-fork` (branch `master`)
- **Status:** Approved — target tier (98% lines / 95% branches) and layer balance (balanced) confirmed with the lead's human.

## 1. Goal

Raise the bonob fork's test coverage and quality to a committed bar, using parallel per-module lanes in isolated git worktrees, looping until both gates hold **twice consecutively** on a clean `npm ci`. Never regress the baseline. Surface and fix real defects (failing test first, separate fix commit, reported) — never game the metric.

## 2. Verified baseline (measured 2026-08-02, clean tree, deps installed)

- **Suites:** 33/33 passed · **Tests:** 2098/2098 passed · **Snapshots:** 0 · **Time:** 12.7s · `jest` exit 0.
- **Coverage** via `npx jest --coverage` with the existing `jest.config.js` (note: test-helper files under `tests/` are included in the denominator — see §9):
  - Lines **94.18%** (2463/2615) · Branches **85.56%** (1085/1268) · Functions 89.9% · Statements 91.62%.
- **tsc:** clean (suite compiles and runs green). **Prod vulns:** 0 (re-verify with `npm audit --omit=dev` before declaring the program done).

To hit the gates from this baseline: **98% lines needs +100 lines; 95% branches needs +120 branches; 98% branches (stretch) needs +158.**

## 3. Targets (confirmed)

| Gate | Commit | Stretch | Floor-of-floor |
|---|---|---|---|
| Lines | **≥98%** | — | — |
| Branches | **≥95%** | 98% (only if mutation-killing) | 90% (pre-authorized **only** if 95% stalls 2 loops) |
| Quality | **≥92%** of new tests mutation-killing | — | — |

- "Twice consecutively on clean `npm ci`" required for DONE.
- If 95% branches stalls: **STOP and report** rather than relax silently or write vacuous tests. Do not game.

## 4. Where the missing branches live (drives the partition)

Missing branches per file, worst first (from `coverage-summary.json`):

| Module | Branches cov/total | Missing | Lines cov/total | Notes |
|---|---|---|---|---|
| `src/subsonic.ts` | 319/386 (82.6%) | **67** | 564/595 (94.8%) | SSRF/IPv6/error-class dense |
| `src/album_snapshot.ts` | 121/162 (74.7%) | **41** | 228/246 (92.7%) | on-disk format, crash/truncation |
| `src/server.ts` | 82/95 (86.3%) | 13 | 237/251 (94.4%) | routes, byte-range |
| `src/smapi.ts` | 140/153 (91.5%) | 13 | 322/340 (94.7%) | browse/search/paging |
| `src/subsonic_music_library.ts` | 39/51 (76.5%) | 12 | 136/157 (86.6%) | translation layer |
| `src/api_tokens.ts` | 13/18 (72.2%) | 5 | 28/28 (100%) | low %, small |
| `src/sonos.ts` | 28/32 (87.5%) | 4 | 64/67 (95.5%) | discovery |
| `src/swr_cache.ts` | 47/51 (92.2%) | 4 | 76/76 (100%) | LRU/backstop |
| `src/clock.ts` | 3/6 (50%) | 3 | 25/25 (100%) | tiny but lowest % |
| `src/timeout.ts` | 20/23 (87.0%) | 3 | 31/31 (100%) | |
| `src/burn.ts` | 36/39 (92.3%) | 3 | 50/52 (96.2%) | BUrn scheme |
| `src/url_builder.ts` | 16/18 (88.9%) | 2 | 33/33 (100%) | |
| `src/album_index.ts` | 38/40 (95%) | 2 | 73/73 (100%) | |
| `src/icon.ts` | 19/20 (95%) | 1 | 98/98 (100%) | |
| `src/deezer.ts` | 15/16 (93.8%) | 1 | 15/15 (100%) | |
| `src/smapi_auth.ts` | 6/7 (85.7%) | 1 | 36/37 (97.3%) | |

`subsonic.ts` + `album_snapshot.ts` hold **108 of 183 missing branches**. Lines are nearly at goal everywhere; **branches are the entire game**.

## 5. Methodology — the loop

```
measure (json-summary) -> repartition by risk-weighted uncovered branches
  -> fan out per-module lanes (isolated worktrees under D:/AI-Worktrees)
  -> lead INDEPENDENTLY verifies each lane
  -> merge to master -> remeasure
repeat until COMMIT gates (§3) hold twice.
```

Re-partition every loop from the **fresh** coverage report: drop modules at gate, move agents to whatever is furthest from it.

## 6. Lane mechanism (per "use worktrees, bring back into master")

- One git worktree per lane at `D:/AI-Worktrees/<lane>`, on branch `cov/<module>-<n>` (e.g. `cov/subsonic-1`).
- The agent works **only** in its worktree, on **only** its module's test file(s). `src` edits only for a real bug (§7).
- **Lead verifies independently before merge** (never trust a lane self-report — prior lanes reported green with their own tests red):
  1. `npx tsc --noEmit` → exit 0.
  2. Full suite green (`npx jest`).
  3. Mutation spot-check: for a sample of the lane's *new* tests, the lead reverts/mutates the covered path and confirms the test goes red. A test that stays green is rejected and not counted.
  4. Coverage delta on that module (json-summary before/after).
- **Merge:** lead merges `cov/<module>-<n>` → `master` after verification. Regular bring-back, as instructed.

## 7. Per-lane contract

- **Scope:** write only its module's tests. `src` edits **only** for a real bug.
- **Bug policy:** failing test first → fix in a **separate** commit → explicit report. Do not silently work around.
- **Prove:** `tsc --noEmit` exit 0; full suite green; per-test mutation evidence (what was broken, that the test went red); coverage delta.
- **If it cannot run npm:** still write the tests, state *"not compiled, not tested"* + what it expects to break. The lead verifies.
- **Forbidden:** weakening/deleting an existing test to go green; snapshot tests as filler; testing getters; tests written to touch lines rather than pin behaviour. **Prefer ONE mutation-killing test over ten line-touching ones.**

## 8. Test layers (balanced — no heavy new framework)

- **Unit + edge-case** — primary driver of coverage. Strengthen existing `*.test.ts`.
- **Chaos** — follow `album_index.chaos.test.ts` / `scroll.chaos.test.ts`: truncation, partial writes, concurrent fetches, LRU/backstop, OOM-ish paths.
- **Contract** — Subsonic API response shapes + SMAPI SOAP response shapes. **Shape-agnostic** (a one-element `mediaCollection` serializes as an object, not an array).
- **e2e / integration** — extend `scenarios.test.ts` + `supersoap.ts`: SMAPI→Subsonic round-trips via `supertest`, byte-range audio, image proxy, auth flows.

## 9. Verified traps (every lane receives this list)

1. `expect.objectContaining({params: <URLSearchParams>})` does **not** compare param values — it passes against different values. Use a bare object arg and assert `[...params.entries()].sort()`.
2. Under `jest.useFakeTimers()`, `setImmediate` is mocked — a `flush()` helper built on it **hangs** the test. Use microtask loops: `for (i=0;i<8;i++) await Promise.resolve()`.
3. Never `await` a promise that may never settle under fake timers (test times out at 5000ms, learning nothing). Assert call counts / state instead.
4. V8 memory tests: an array unused after its loop is GC'd (keep a live reference); `heapUsed` **excludes** TypedArray backing stores (add `arrayBuffers`).
5. SOAP serializes a one-element `mediaCollection` as an **object**, not an array. Write shape-agnostic assertions.
6. Jest discovery: `roots: ["<rootDir>/tests"]`. Ignore-patterns are regexes vs absolute paths and silently fail on Windows — keep changes inside `roots`.
7. `@swc/jest` (not ts-jest) is the transform, despite `CLAUDE.md` saying ts-jest. `jest.config.js` is the source of truth.

Plus repo rules from `CLAUDE.md`: fp-ts (`TaskEither`/`Option`/`pipe`) is pervasive; strict TS (`noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`); BUrn IDs everywhere; tests mirror `src/` filenames; `@svrooij/sonos`, `soap`, `axios`, `sharp`, `eta` are key deps.

## 10. Stop / escalate criteria

Stop and ask the human if: gains <2% across two loops; the gate requires untestable code; or the honest conclusion is that remaining uncovered lines aren't worth testing. Say so rather than gaming the number.

## 11. Risks

- **95% branches on `subsonic.ts`/`album_snapshot.ts`** is where vacuous tests tempt. Mitigation: per-test mutation evidence + lead spot-checks + prefer fewer mutation-killing tests.
- **Mutation check dominates runtime** (revert per test). Accepted — it's what makes the 92% meaningful.
- **Test-helper files** (`builders.ts`, `in_memory_music_service.ts`, `supersoap.ts`, `music_services.ts`) appear in the coverage denominator. Acknowledged; lanes are not directed at them and the measurement config is left unchanged (no goalpost moves).

## 12. Out of scope

- Changing the coverage config / goalposts (measure with the existing `jest.config.js`).
- Refactoring `src` beyond minimal, reported bug fixes.
- Dependency upgrades.
