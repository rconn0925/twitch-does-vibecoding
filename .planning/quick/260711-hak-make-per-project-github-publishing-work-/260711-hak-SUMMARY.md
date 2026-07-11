---
phase: quick-260711-hak
plan: 01
subsystem: orchestrator / gallery-publishing
tags: [github, per-project-repo, workspace-lifecycle, secrets-isolation, BL-01, HI-01, HI-03]
requires: [workspace.ts WorkspaceView, SandboxAdapter wsl exec seam, audit/record recordGalleryPublish]
provides:
  - per-project GitHub publisher (one public repo per generation under TwitchVibecodes)
  - fail-closed distro-dir bootstrap (ensureWorkspaceDir)
  - emptiness-keyed scaffold/continue (workspaceHasFiles)
  - stall/idle build watchdog (re-armable, non-destructive)
  - ProjectRepoStore (durable generation -> repo_name routing)
  - GALLERY_GITHUB_TOKEN mechanically guarded out of the sandbox env
affects: [src/orchestrator, src/audit, src/main.ts, tests/invariants]
tech-stack:
  added: [host gh CLI for repo create/push]
  patterns: [injected exec/fs/store/clock seams, arg-array execFile only, token-on-env-only]
key-files:
  created: []
  modified:
    - src/orchestrator/types.ts
    - src/orchestrator/sandbox-process.ts
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/sandbox-process.test.ts
    - src/orchestrator/gallery-publisher.ts
    - src/orchestrator/gallery-publisher.test.ts
    - src/audit/schema.sql
    - src/main.ts
    - tests/invariants/secrets-isolation.test.ts
    - .env.example
decisions:
  - "Distro dir bootstrap/stat live on the wsl SandboxAdapter (the WSL boundary already lives there), NOT in pure-SQLite workspace.ts."
  - "HI-03 watchdog is a STALL/idle timer (re-armed on each yielded message) — no workspace reset on abort, keeping rotation non-destructive."
  - "Per-project routing keyed on generation via a durable project_repos table; repo created only after a successful gh create, then recorded."
  - "GALLERY_GITHUB_TOKEN travels ONLY on the git/gh exec env — never argv, never a persisted remote URL; origin stays a plain https URL."
metrics:
  duration: ~35m
  completed: 2026-07-11
---

# Phase quick-260711-hak Plan 01: Per-Project GitHub Publishing + BL-01/HI-01/HI-03 Summary

Made the "chat's build lands on GitHub, one public repo per project" loop work end to end and closed the three linked workspace-lifecycle bugs (BL-01 missing distro dir, HI-01 scaffold-over-debris, HI-03 watchdog killing healthy builds) — the sandboxed AI never holds GitHub credentials; the HOST publishes with a host-only PAT.

## What shipped

**Task 1 — Distro workspace lifecycle (commit `18e9a41`)**
- Added two OPTIONAL `SandboxAdapter` methods (`ensureWorkspaceDir`, `workspaceHasFiles`) so the ~8 existing test fakes compile unchanged; the concrete wsl.exe adapter implements both using the existing exec seam and the SAME distro/user config — no new env, `buildSandboxEnv` untouched.
- BL-01: `build-session` awaits `ensureWorkspaceDir(dir)` before the build turn; a rejection fails the build CLOSED (narrated deciding + `enterDecision("failed")` + `sandbox_teardown` audit rationale "…BL-01"), never spawning and never falling back to a shared dir.
- HI-01: scaffold-vs-continue rule is now `scaffolded() OR workspaceHasFiles(dir)`; a probe error resolves to `hasFiles=true` (never scaffold over possible debris). Absent-method fakes fall back to `scaffolded()`-only.
- HI-03: the per-turn watchdog became a re-armable STALL timer (a single stable `fire` closure; `armWatchdog()` re-set on each yielded message). Healthy long builds survive; a silent stream still trips → narrated failed decision; NO workspace reset on abort.

**Task 2 — Per-project publisher rewrite (commit `8d38159`)**
- `sanitizeRepoName(title, now)`: lowercase → collapse non-`[a-z0-9]` runs to single hyphens → strip → truncate ≤80 → dated `vibe-YYYYMMDD-HHMM` fallback via injected clock. A hostile title yields only `[a-z0-9-]`.
- `ProjectRepoStore` + `createProjectRepoStore(db)` (prepared statements over `project_repos`); dedup against `knownNames()`.
- Per-generation routing: first prompt → `gh repo create <owner>/<name> --public` → init mirror → `store.record` (only after a successful create); later prompts reuse the same mirror/repo.
- W1 delete-propagation: clear NON-`.git` entries in the project mirror, then copy the workspace snapshot in, then `git add -A` (never a plain cp-over-top, never rm the mirror root — `.git` preserved).
- W2: re-clone from origin when `<name>/.git` is missing (host restart / partial first publish); tolerate a `gh repo create` "already exists" collision as non-fatal.
- Token on exec env only; execFile arg-arrays only (`shell` unrepresentable at the seam); `publishNow` never throws.

**Task 3 — Persist + compose + document (commit `44e5d9e`)**
- `schema.sql`: additive `project_repos` table (generation PK → repo_name, durable so a mid-stream restart never re-creates a repo).
- `main.ts`: `buildGalleryPublisher(db, logger)` now builds the `ProjectRepoStore` from the app db INSIDE `createApp`; a test-injected fake takes precedence; without a token it stays inert. Entrypoint no longer double-builds it.
- `.env.example`: `GALLERY_GITHUB_OWNER` (default TwitchVibecodes) + `GALLERY_GITHUB_TOKEN` (host PAT, auto-disable-without-token); `GALLERY_REPO_URL` retired.

**Task 4 — Token isolation guard + full gate (commit `1704332`)**
- `secrets-isolation.test`: named `GALLERY_GITHUB_TOKEN|GH_TOKEN` in the `HOST_SECRET` guard + synthetic offenders (`env.GALLERY_GITHUB_TOKEN = cfg.token;`, `env.GH_TOKEN = …`) and a benign `gallery-mirror` clean case in the self-test.
- `sandbox-process.test`: positive assertion that the spawn argv env assignments carry no `GALLERY_GITHUB_TOKEN=`/`GH_TOKEN=` — only `PATH=` (and the SANDBOX-derived key when configured).

## Verification (gate results)

| Gate | Task 1 | Task 2 | Task 3 | Task 4 (full) |
|------|--------|--------|--------|---------------|
| vitest (scoped) | 71 pass | 23 pass | e2e 12 pass | 27 pass |
| vitest (full) | — | — | — | **845 pass** |
| tsc --noEmit | clean | (deferred to T3) | clean | clean |
| biome check | clean | clean | clean | **clean (148 files)** |

Requested confirmations:
- (a) BL-01 fail-closed test: `(BL-01) a rejecting ensureWorkspaceDir fails the build CLOSED …` — no spawn, no publish, narrated failed decision, `sandbox_teardown` row with "BL-01" rationale. ✅
- (b) token-not-in-sandbox invariant non-vacuous: source-scan self-test flags synthetic `GALLERY_GITHUB_TOKEN`/`GH_TOKEN` offenders AND passes the benign clean case; spawn-argv unit assertion proves only `PATH=` crosses. ✅
- (c) per-project routing (2 generations → 2 repos) tested: `two DIFFERENT generations create two DIFFERENT repos`. ✅
- (d) hostile-repo-name sanitization tested: `sanitizeRepoName` hostile-title test (shell metachars + unicode + 200 chars → `[a-z0-9-]`, ≤80). ✅
- (e) W1 delete-propagation handled: `non-.git entries cleared before each copy (never rm the mirror root)`. ✅
- (f) sandbox-process.ts isolation + src/compliance zero-diff: `buildSandboxEnv`/`buildSandboxOptions` bodies unchanged (only a new comment references the name); `git diff` of `src/compliance`, `halt.ts`, `kill-switch` is empty. ✅

## Deviations from Plan

None affecting behavior. Two mechanical folds:
- **[Rule 3 - Blocking] Serialization-test label extraction.** The push argv now starts with `-c` credential-helper flags, so the test's verb-extraction heuristic (`args[0] === "-C" ? args[2] : args[0]`) mislabeled the push. Fixed the test to match on a known verb set. (test-only)
- **Biome autofix normalized one pre-existing multi-line `logger.warn` (BROADCAST-SAFETY) into a single line** in `main.ts` when the import block re-sorted — formatting-only, semantically identical, required to keep `biome check .` green.

Checker robustness warnings W1/W2/W3 all folded in: W1 (delete-propagation via clear-non-.git-then-copy) and W2 (continue-path re-clone guard + gh-create collision tolerance) are implemented and tested; W3 (split-if-degraded) was unnecessary — Task 2 stayed clean as one atomic commit.

## Follow-on seams left reusable (design_seams)

Rotation (`workspace.newProject()`), ship (`publishNow(generation)`), and per-generation scaffold (keyed on `store.lookup(generation)`) remain plain functions callable from ANY path — the console route holds no exclusive claim. A future `!build`/`!suggest` winner path can rotate+ship+scaffold with the identical calls. Rotation stays non-destructive (no `app-<N>` dir is ever deleted).

## Self-Check: PASSED

- Commits `18e9a41`, `8d38159`, `44e5d9e`, `1704332` all present in `git log`.
- All modified files exist on disk and are tracked.
- Full gate (vitest 845 / tsc / biome 148) green.
