---
phase: quick-260711-0iu
plan: 01
subsystem: orchestrator
tags: [straight-to-build, prompt-boundary, persistent-workspace, operator-console, overlay, sand-04, comp-02]
requires:
  - "260711-0ms classifier retune (CLASSIFIER_SYSTEM_PROMPT already tweak-aware; left byte-for-byte untouched here)"
provides:
  - "Straight-to-build pipeline: dequeue → COMP-02 pre-build re-screen(suggestion text) → single sandboxed Fable build turn (no research/plan/host agent turns)"
  - "Two-mode SAND-04 prompt boundary: BUILD_SYSTEM_PROMPT_SCAFFOLD / BUILD_SYSTEM_PROMPT_CONTINUE, buildBuildPrompt(taskText, mode) with <task_description source=\"chat\"> framing"
  - "Persistent workspace: SQLite-backed WorkspaceView (generation rotation, scaffolded flag), Options.cwd → SpawnOptions.cwd threading into the WSL2 distro"
  - "Streamer-only POST /api/workspace/new-project (CSRF-inherited, 409 build-active/halted, workspace_reset audited) + console New Project button"
  - "Single-step overlay Build stepper with legacy stage tolerance; tweak-inviting overlay + narration copy"
affects: [build pipeline latency (~90s dead air removed), overlay build panel, operator console, audit schema (additive workspace_state)]
tech-stack:
  added: []
  patterns:
    - "Rotation-not-deletion workspace archiving (generation increment; zero destructive commands)"
    - "Structural model policy: AgentRunSpec has no model field — the pipeline cannot request an override"
key-files:
  created:
    - src/orchestrator/workspace.ts
    - src/orchestrator/workspace.test.ts
  modified:
    - src/orchestrator/build-session.ts
    - src/orchestrator/prompt-boundary.ts
    - src/orchestrator/sdk-runner.ts
    - src/orchestrator/types.ts
    - src/audit/schema.sql
    - src/audit/record.ts
    - src/operator-console/server.ts
    - src/operator-console/public/console.js
    - src/operator-console/public/index.html
    - src/main.ts
    - src/ingestion/narration.ts
    - src/overlay/public/overlay.js
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/prompt-boundary.test.ts
    - src/operator-console/server.test.ts
    - src/ingestion/narration.test.ts
    - src/audit/record.test.ts
    - tests/invariants/prompt-injection-boundary.test.ts
    - tests/e2e/build-flow.e2e.test.ts
    - tests/e2e/auto-cycle.e2e.test.ts
    - tests/e2e/build-failure.e2e.test.ts
    - tests/e2e/build-history.e2e.test.ts
    - tests/e2e/chaos-mode.e2e.test.ts
    - tests/e2e/paid-window-loop.e2e.test.ts
decisions:
  - "Model policy made STRUCTURAL: the only Sonnet pipeline consumer (research turn) is deleted and AgentRunSpec drops the model field entirely — build inherits the Fable session default; the Sonnet classifier gate (D-1 exception) is a separate, untouched surface"
  - "COMP-02 keeps its exact two-point shape: screenBuildPlan now receives the winning SUGGESTION text (planText parameter name kept; src/compliance/** and comp02.ts zero-diff); screenOutputBatch untouched"
  - "Post-screen abortedNow() guard added: a veto landing during the pre-build screen await never spawns a build turn (finalizeAborted, no stage done)"
  - "scaffolded flips ONLY on a done finalize — a failed/refused/vetoed first build leaves the next attempt in scaffold mode"
  - "DEFAULT_TURN_TIMEOUT_MS unchanged (per-turn bound; pipeline ceiling drops ~15min → ~5min)"
  - "retryBuild re-runs the build from the suggestion text WITHOUT re-screening (same semantics as the old approved-plan retry); p.planText === null branch kept as defensive dead code"
metrics:
  duration: "~35 minutes"
  completed: "2026-07-11"
  tasks: 4
  gate: "784 tests / 64 files green, tsc clean, biome clean"
---

# Quick Task 260711-0iu: Straight-to-Build + Prompt Semantics Summary

Vote winners now go straight from dequeue through the COMP-02 pre-build re-screen (input = the raw suggestion text) into ONE sandboxed Fable build turn inside a persistent per-generation workspace — research/plan turns deleted, SAND-04 held in both scaffold and continue prompt modes, and a CSRF-guarded, audited "New project" console action rotates the workspace.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Straight-to-build pipeline core + two-mode prompt boundary + workspace threading (incl. e2e `agent === "research"` narrowings — planned sequencing choice, see Deviations) | a2b0bb6 | build-session.ts, prompt-boundary.ts, sdk-runner.ts, types.ts + 9 test files |
| 2 | Workspace state module + "New project" console action + wiring | 46abf46 | workspace.ts, schema.sql, record.ts, server.ts, console.js, index.html, main.ts |
| 3 | Overlay stepper collapse + tweak-inviting copy | ba271d6 | overlay.js, narration.ts |
| 4 | Test suite: workspace/new-project/record/narration tests + full gate | cc1458f | workspace.test.ts (new), server.test.ts, record.test.ts, narration.test.ts + format pass |

## Verification Results

**Gate results per task:**
- Task 1: verify greps PASS (`0` research/plan emitStage/prompt refs in build-session.ts; `planText: task.text` present; `workspaceDir` in sdk-runner.ts; `BUILD_SYSTEM_PROMPT_CONTINUE` present). tsc intentionally red at this point on exactly one error (main.ts missing workspace wiring — resolved by Task 2, per plan).
- Task 2: `npx tsc --noEmit` clean + `workspace_state` in schema.sql + `new-project` in server.ts + `createWorkspaceState` in main.ts — PASS.
- Task 3: `node --check overlay.js` + single `{ key:` entry + `researching: 0` + tweak copy in overlay.js and narration.ts — PASS.
- Task 4 (full gate): **`npx vitest run` → 784 passed (64 files); `npx tsc --noEmit` clean; `npx biome check .` clean.**

**Plan verification checklist:**
- `git diff --stat <base> -- src/compliance/` → **zero diff**.
- `git diff --stat <base> -- src/orchestrator/sandbox-process.ts sandbox-process.test.ts` → **zero diff** (debug-session ownership respected).
- halt.ts, builder-feed.ts, src/shared/types.ts (PipelineStage union + BuildNarrator) → **zero diff**.
- `grep -rn 'emitStage(task, "researching")\|emitStage(task, "planning")' src/` → nothing.
- `grep -rn 'agent === "research"' tests/` → nothing (all six e2e fakes narrowed).
- CLASSIFIER_SYSTEM_PROMPT: extracted const **byte-identical** between base (6c5885c) and HEAD (diff of the awk-extracted region is empty; zero CLASSIFIER lines appear in the prompt-boundary.ts diff).

**Binding confirmations requested by the orchestrator:**
- (a) **screenBuildPlan fail-closed paths tested:** build-session.test.ts "COMP-02 pre-build suggestion re-screen (D3-06)" describe — approved → exactly ONE runner spec (agent "build", no `model` key, sandbox present, `workspaceDir === "/home/builder/projects/app-1"`, suggestion delimited in `<task_description source="chat">`); rejected → `stages === ["refused"]`, `comp02Rejected` narrated, rejected comp02 audit row, **runner calls length 0**; held → `buildHeld` narrated, `onHeldForReview(task, task.text)`, terminal refused, **runner calls length 0**.
- (b) **SAND-04 invariant sweep green in BOTH modes:** tests/invariants/prompt-injection-boundary.test.ts runs the FULL ADVERSARIAL_FIXTURES sweep against `buildBuildPrompt` for scaffold AND continue — system-prompt invariance (byte-identical to the fixed const) plus outsideFrame containment retained from the deleted research block. Source-scan halves (SDK confinement + INTERPOLATED_SYSTEM_PROMPT guard) green with the two new constants.
- (c) **Workspace rotation + route tests green:** workspace.test.ts (boot row gen 1/unscaffolded, dir() shape, markBuilt flip, newProject increment+reset, close/reopen crash durability, resume-without-reset) and server.test.ts new-project describe (200 + generation 2 + workspace_reset audit row from IDLE; 409 build-active and 409 halted with **no rotation**; 400 strict-empty body; 503 unwired; 403 forged Origin with newProject never called).
- (d) **sandbox-process.ts and src/compliance/** zero-diff vs base** — verified via `git diff --stat` above.

**Pre-verified STOP gate (SDK cwd handoff):** re-ran the plan's verification anyway. `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` declares `Options.cwd?: string` and `SpawnOptions.cwd?: string`; sdk.mjs's transport destructures `cwd:o` from its options and constructs `{command:ia,args:sa,cwd:o,env:c,signal:…}` passed to `this.options.spawnClaudeCodeProcess(Fu)`. No surprise — no STOP needed.

## Deviations from Plan

**1. [Planned sequencing choice — NOT a deviation per scope_note/orchestrator constraint] Task 1's commit includes the mechanical e2e narrowings + type-driven test updates.** The `AgentRunSpec.agent` narrowing makes every `spec.agent === "research"` comparison a TS2367 error and the required `workspace` dep breaks direct `BuildSessionDeps` constructors, so all 9 affected test files (six e2e + build-session.test.ts + prompt-boundary.test.ts + the invariant suite) landed in the same pass as the type change — exactly as the plan's scope_note directed ("tsc stays red until all are gone"). Task 2's tsc gate then passed on the first run.

**2. [Rule 3 - environment] Worktree had no node_modules; base drift.** Ran `npm ci` (lockfile-only restore, zero new packages) so the gates could run; the worktree HEAD also wasn't based on the required commit — hard-reset to 6c5885c per the dispatch instructions before any work.

No other deviations — src changes executed as written.

## Follow-ups (plan-mandated records)

- **Classifier tweak-prompt follow-up (amendment E):** src/compliance/** and CLASSIFIER_SYSTEM_PROMPT were untouched here. Note: quick task 260711-0ms already retuned the classifier to be tweak-aware ("make the background red" framing, scope-neutrality). The remaining follow-up is a **`gate:eval` re-run against live tweak-style prompts** in the straight-to-build context to confirm the retune holds now that suggestions feed the build directly — schedule as its own quick task before/at the Phase 5 dry run.
- **Phase 5 dry-run expectation (real WSL2 cwd handoff — fakes cannot prove it):** verify on the streaming PC that (1) the first winner's build lands in `/home/builder/projects/app-1` inside the distro, (2) a second winner CONTINUES the same app-1 project (tweak visibly applies to the running app on :5555), and (3) console "New project" rotates to `app-2` (app-1 left on disk untouched). If the cwd handoff ever regresses after an SDK bump, builds fall back to `~` — they still persist, generations just stop separating; STOP and surface rather than editing sandbox-process.ts.

## Self-Check: PASSED

- src/orchestrator/workspace.ts — FOUND
- src/orchestrator/workspace.test.ts — FOUND
- Commits a2b0bb6, 46abf46, ba271d6, cc1458f — FOUND in `git log`
- Full gate re-verified green after the final commit
