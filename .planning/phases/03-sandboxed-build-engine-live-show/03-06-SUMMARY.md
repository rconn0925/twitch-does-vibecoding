---
phase: 03-sandboxed-build-engine-live-show
plan: 06
subsystem: orchestrator
tags: [BUILD-01, COMP-02, orchestrator, build-session, p-queue, composition-root, in-flight-rescreen, D3-07]

# Dependency graph
requires:
  - phase: 03-02
    provides: "AgentRunner/SandboxAdapter/DevServerProbe/BuildMachineView/ProgressSink seams, translate(), pipeline audit record fns"
  - phase: 03-03
    provides: "buildResearchPrompt/buildBuildPrompt (SAND-04 zero-interpolation prompts)"
  - phase: 03-04
    provides: "screenBuildPlan/screenOutputBatch + Comp02Deps (COMP-02 pre-write + in-flight re-screen)"
  - phase: 03-05
    provides: "createSandboxAdapter (spawn/terminate) + buildSandboxOptions; AbortRegistry.registerSandboxTeardown"
  - phase: 03-07
    provides: "OverlayBuildSource seam + BUILD_STAGE_CHANGED (overlay build panel)"
  - phase: 03-08
    provides: "startPreviewServer + createPreviewManager (DevServerProbe)"
provides:
  - "src/orchestrator/build-session.ts createBuildSession — per-task pipeline: BUILD_IN_PROGRESS → research(Sonnet) → plan(Fable) → COMP-02 pre-write → build(Fable, sandboxed) [+ in-flight COMP-02] → done → IDLE"
  - "in-flight COMP-02 (D3-07): each Write/Edit output batch re-screened via screenOutputBatch; a rejected batch aborts (abort + sandbox teardown) down the narrated compliance-failure path"
  - "src/orchestrator/sdk-runner.ts createSdkAgentRunner — the real query()-backed AgentRunner (entrypoint-only, dynamically imported)"
  - "createApp composition of the orchestrator + overlay build push + preview surface + winner→build trigger; AppHandle.orchestrator/preview + close() teardown"
affects: [03-09-failure-veto]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "p-queue concurrency-1 serializes builds (D3-04)"
    - "Winner→build trigger transitions VOTING_ROUND→BUILD_IN_PROGRESS synchronously inside the enqueueWinner wrapper (IDLE→BUILD_IN_PROGRESS is illegal by design), so closeRound's own IDLE step is skipped — no state-machine table change"
    - "The build session IS the OverlayBuildSource (snapshot + BUILD_STAGE_CHANGED); ProgressSink stays presentational"
    - "Real query()/SDK confined to src/orchestrator/sdk-runner.ts, dynamically imported behind the guarded entrypoint (armPanicHotkey/buildTwitchAdapters doctrine)"

key-files:
  created:
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/index.ts
    - src/orchestrator/sdk-runner.ts
  modified:
    - src/orchestrator/types.ts
    - src/main.ts
    - tests/e2e/build-flow.e2e.test.ts

decisions:
  - "build-session defines its OWN BuildSessionDeps consuming the FUNCTIONAL comp02 module (Comp02Deps/{classify} + screenBuildPlan/screenOutputBatch) rather than the types.ts Comp02Screen seam — 03-04 explicitly punted this reconciliation to 03-06; the functional module carries screenOutputBatch (the in-flight half), which Comp02Screen lacks"
  - "The Fable plan turn runs agent:\"build\" with model undefined, host-side (no sandbox), with an orchestrator-authored PLAN_SYSTEM_PROMPT (AgentRunSpec has no 'plan' agent type; prompt-boundary ships no buildPlanPrompt — both are cross-plan seam files out of this plan's file scope)"
  - "Pipeline stages emitted EXPLICITLY (emitStage); translate() used only to detect per-turn done/failed/refused within each stream"
  - "recordPipelineStage co-located in the orchestrator (always fires, D3-13) rather than in the injected ProgressSink; the sink stays presentational (narration/observer)"
  - "COMP-02 held → onHeldForReview hook + refused stage (review-queue insertion + narration polish deferred to 03-09)"

requirements-completed: [BUILD-01, COMP-02]

# Metrics
duration: ~31min
completed: 2026-07-10
---

# Phase 3 Plan 06: Build-Session Orchestrator Summary

**The vertical-slice core (BUILD-01): `createBuildSession` drives one gate-approved QueuedTask through the full pipeline — BUILD_IN_PROGRESS → Sonnet research → Fable plan → COMP-02 pre-write re-screen → Fable sandboxed build (with in-flight COMP-02 output re-screening) → done → IDLE — one build at a time (p-queue concurrency-1), fail-closed/never-throw, DEQUEUE-only, composed into createApp with injected fakes and driven live by the round winner; the real SDK/WSL adapter loads only behind the guarded entrypoint.**

## Performance
- **Duration:** ~31 min
- **Started:** 2026-07-10T06:35Z
- **Completed:** 2026-07-10T07:07Z
- **Tasks:** 2 (`type=auto`)
- **Files:** 7 (4 created, 3 modified)

## Accomplishments

### Task 1 — build-session.ts (BUILD-01 + in-flight COMP-02)
- `createBuildSession(deps)` owns the per-task lifecycle constructed from all-injected deps. A `PQueue({ concurrency: 1 })` serializes builds (D3-04).
- Pipeline: `enterBuildMode` (idempotent BUILD_IN_PROGRESS) → **researching** (`agentRunner.run` agent:"research" model:"sonnet", host-side) → **planning** (agent:"build" model:undefined = Fable, host-side, orchestrator-authored `PLAN_SYSTEM_PROMPT`) → **COMP-02 pre-write** `screenBuildPlan` → **building** (agent:"build" model:undefined, `sandbox`+`spawnClaudeCodeProcess` = the sandboxed turn) → **done** → IDLE.
- **In-flight COMP-02 (D3-07):** while consuming the build stream, each Write/Edit tool-use output batch (`extractWriteEditText`) is re-screened via `screenOutputBatch`; a `proceed:false` batch ABORTS the build — `abortController.abort()` + `sandboxAdapter.terminate()` + `recordSandboxTeardown` — and finalizes down the SAME narrated compliance-failure path (`refused`), never reaching `done`.
- **Fail-closed / never-throw (T-03-22):** every agent failure, model refusal, in-flight rejection, or thrown error resolves to a `failed`/`refused` stage + a clean BUILD_IN_PROGRESS→IDLE exit; `startBuild` never rejects. DEQUEUE-only: `taskQueue.list()/remove()` only — grep gate = 0, single-funnel invariant green.
- The session is the `OverlayBuildSource` (`snapshot()` + `BUILD_STAGE_CHANGED`); `close()` aborts in-flight + unregisters.
- 13 unit tests: happy path + audit rows, COMP-02 rejected/held, in-flight re-screen invocation + rejected-abort, refusal→refused, failure→failed, thrown-error→failed, HALTED refusal, concurrency-1 serialization, broken-sandbox (throwing terminate) still finalizes to IDLE, source-discipline scan.

### Task 2 — createApp composition + real SDK runner + e2e green
- `createApp` composes the orchestrator when `agentRunner`+`sandboxAdapter` are injected (fakes in tests, real adapters from the entrypoint — identical path). The overlay receives the session as its `build` source; the **preview server** starts as a third isolated surface (PRES-03).
- **Winner→build trigger:** the `enqueueWinner` wrapper, on `queued:true`, synchronously transitions VOTING_ROUND→BUILD_IN_PROGRESS (legal source state; IDLE→BUILD_IN_PROGRESS is illegal by design and asserted in stream-mode.test.ts) then starts the pipeline — so `closeRound`'s own `if VOTING_ROUND → IDLE` step is skipped and **no state-machine table change was needed**.
- `AppHandle.close()` tears down the orchestrator (abort + unregister) and preview **before** `db.close()`.
- **Entrypoint** `buildOrchestratorAdapters`: guarded dynamic import builds the real `createSdkAgentRunner()` (query() wrapper) + `createSandboxAdapter` + preview probe; a broken SDK/WSL degrades to a LOUD log and console + overlay + vote loop keep running (T-03-23). `query()` lives only in `src/orchestrator/sdk-runner.ts` (confinement invariant green); `main.ts` never imports the SDK string.
- `tests/e2e/build-flow.e2e.test.ts`: the 6 `it.todo`s are GREEN (BUILD_IN_PROGRESS entry, researching→planning stages, COMP-02 pre-write approve BEFORE any build write, building→done→IDLE, overlay `/api/state` reflects the live stage, refused build never silent) plus a dedicated refusal scenario.

## Task Commits
1. **Task 1: build-session orchestrator — full pipeline + in-flight COMP-02** — `bef03e1` (feat)
2. **Task 2: compose orchestrator in createApp + real SDK runner; e2e green** — `f7d713c` (feat)

## Deviations from Plan

### Auto-fixed / adaptation (Rule 3 — blocking seam reconciliation)
1. **[Rule 3] build-session consumes the FUNCTIONAL comp02 module, not the `Comp02Screen` seam.** `types.ts › Comp02Screen.screenPlan` returns a raw GateResult and has NO `screenOutputBatch` (the in-flight half). The plan's own `<action>`/`<interfaces>` instruct using `screenBuildPlan`/`screenOutputBatch(comp02Deps, …)`; 03-04's SUMMARY explicitly deferred this reconciliation to 03-06. build-session defines its own `BuildSessionDeps` with `comp02: Comp02Deps` (`{ classify }`). No functional impact — same single-funnel classify() call.
2. **[Rule 3] Fable plan turn realized as `agent:"build"` model:undefined, host-side, with an orchestrator-authored `PLAN_SYSTEM_PROMPT`.** `AgentRunSpec.agent` is only `"research"|"build"` and prompt-boundary ships no `buildPlanPrompt` (both are seam files outside this plan's file scope). The plan turn is a genuine Fable (model undefined) turn producing the plan text; the `planning` stage is emitted explicitly. SAND-04 discipline preserved (fixed system prompt, task/research text delimited as data).
3. **[Rule 3] Widened `BuildMachineView.setActiveTask(taskId: string | null, …)`** (was `string`) so the orchestrator can CLEAR the active task on build end — matches the real `StreamModeMachine.setActiveTask` signature. types.ts seam, one-line widening.
4. **[Rule 2] `recordPipelineStage` co-located in the orchestrator** (always fires per D3-13) rather than delegated to the injected ProgressSink (which the plan named). The sink stays purely presentational (narration/observer); audit fires regardless of the injected sink.

### Deferred (owned by 03-09, per plan note)
- Chat stage narration (narrator lacks build-stage methods) and full COMP-02 held → console review-queue insertion are stubbed to a logged `onHeldForReview` hook; retry/skip narration polish is 03-09's scope (the plan explicitly scopes those there).

## Known Stubs
- `onHeldForReview` in createApp logs the held decision (review-queue insertion deferred to 03-09). Not goal-blocking: the held path still ends cleanly at IDLE and is audited via `comp02_decision`.
- The ProgressSink in createApp logs stage transitions (chat narration deferred to 03-09). The overlay build panel is fully wired live; only chat narration of build stages is deferred.

## Verification
- `npx vitest run src/orchestrator/build-session.test.ts` — 13 passed.
- `npx vitest run tests/e2e/build-flow.e2e.test.ts` — 9 passed (6 former todos green + refusal scenario).
- `npx vitest run tests/invariants/` — single-funnel + prompt-injection-boundary (SDK confinement) + secrets-isolation green.
- Full suite: **503 passed, 0 todo** (baseline 484 pass + 6 todo → todos green + new tests).
- `npx tsc --noEmit` clean; `npx biome check` clean on all changed files.
- Grep gate `grep -v '^\s*//' src/orchestrator/build-session.ts | grep -c '\.enqueue(\|toQueuedTask\|submitCandidate'` = **0**.
- No real WSL2 / query() / network in any test — injected fakes only; the real SDK/WSL adapter loads only in the guarded entrypoint.

## Self-Check: PASSED
- Created files exist: build-session.ts, build-session.test.ts, index.ts, sdk-runner.ts — all FOUND.
- Task commits exist: `bef03e1`, `f7d713c` — both FOUND.
- STATE.md / ROADMAP.md untouched (per orchestrator instruction).

---
*Phase: 03-sandboxed-build-engine-live-show*
*Completed: 2026-07-10*
