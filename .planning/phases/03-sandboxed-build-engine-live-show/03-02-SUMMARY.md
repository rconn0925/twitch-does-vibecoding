---
phase: 03-sandboxed-build-engine-live-show
plan: 02
subsystem: infra
tags: [claude-agent-sdk, orchestrator, pipeline-stage, audit, vitest, dependency-injection]

# Dependency graph
requires:
  - phase: 01-compliance-gate-kill-switch
    provides: "classify() single-funnel gate, AbortRegistry, audit ledger (record.ts/schema.sql), shared/types vocabulary"
  - phase: 02-chat-vote-loop
    provides: "createApp injected-fake composition root, TaskQueue, overlay full-state-on-connect + PILL_BY_MODE translation precedent"
provides:
  - "PipelineStage public status vocabulary + BuildStatusView (BUILD-02, PRES-04)"
  - "src/orchestrator/types.ts: AgentRunner, SandboxAdapter, DevServerProbe, BuildSessionDeps injected seams"
  - "progress-events.translate(): pure fail-closed SDK-stream → PipelineStage layer (raw SDK types contained)"
  - "Six Phase 3 append-only audit record fns (pipeline_stage/comp02_decision/build_refused/build_retry/build_skip/sandbox_teardown)"
  - "Failing/pending happy-path e2e (MVP e2e-first) driving 03-04/03-06/03-09"
  - "@anthropic-ai/claude-agent-sdk@0.3.206 pinned exact"
affects: [03-04-comp02, 03-05-sandbox-process, 03-06-orchestrator, 03-07-overlay-build-panel, 03-08-preview, 03-09-failure-veto]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/claude-agent-sdk@0.3.206 (exact pin)"]
  patterns:
    - "Fixed translation table (PILL_BY_MODE analog) as the sole raw-SDK-shape inspector"
    - "translate() accepts unknown → structural narrowing → no SDK type in public signature (containment)"
    - "Injected structural interfaces (KeyEventSource/OverlayModeSource analog) for WSL2/query()/network seams"
    - "MVP e2e-first: it.todo scaffold encoding the target slice, never an accidental green"

key-files:
  created:
    - src/orchestrator/types.ts
    - src/orchestrator/progress-events.ts
    - src/orchestrator/progress-events.test.ts
    - tests/e2e/build-flow.e2e.test.ts
  modified:
    - package.json
    - src/shared/types.ts
    - src/audit/record.ts
    - src/audit/schema.sql

key-decisions:
  - "translate() parameter typed `unknown` (not an SDK union) so no raw SDK type appears in the layer's public signature — strongest containment of the pre-1.0 SDK surface"
  - "Added CandidateSource \"orchestrator\" (03-RESEARCH.md Open Q2) for a clearer COMP-02 audit trail vs reusing \"operator\""
  - "AgentMessage aliases the SDK union but stays confined to src/orchestrator/; e2e fixtures use plain objects (no SDK import in non-orchestrator files)"
  - "Shipped all six Phase 3 audit record fns now (not just recordPipelineStage) so 03-04/03-06/03-09 receive concrete write helpers"

patterns-established:
  - "PipelineStage vocabulary is the only thing that crosses out of the orchestrator (PILL_BY_MODE discipline extended to the SDK message stream)"
  - "Refusal precedence: model-refusal subtypes map to `refused` before the generic result→failed branch (D3-08)"

requirements-completed: [BUILD-02]

# Metrics
duration: ~35min
completed: 2026-07-10
---

# Phase 3 Plan 02: Interface-First Build-Engine Foundation Summary

**Installed the Agent SDK (0.3.206 exact), defined the PipelineStage status vocabulary + injected AgentRunner/SandboxAdapter/DevServerProbe/BuildSessionDeps seams, shipped the pure fail-closed SDK→PipelineStage translation layer (BUILD-02) plus six append-only pipeline audit record functions, and authored the failing MVP happy-path e2e that drives the rest of the phase.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-10T00:07Z
- **Completed:** 2026-07-10T00:15Z
- **Tasks:** 3 (Task 2 via TDD RED→GREEN)
- **Files modified:** 10 (4 created source/test, 1 created doc, 4 modified, +package-lock)

## Accomplishments
- `@anthropic-ai/claude-agent-sdk@0.3.206` pinned exact per CLAUDE.md pre-1.0 guidance; dockerode deliberately NOT installed (fallback-only).
- Extended the shared vocabulary: `"orchestrator"` CandidateSource, `PipelineStage` (queued/researching/planning/building/done/failed/refused), `BuildStatusView`.
- `src/orchestrator/types.ts` — the phase's DI blueprint: `AgentRunner`/`AgentRunSpec`/`AgentMessage`, `SandboxAdapter`, `DevServerProbe`, `BuildMachineView`, `Comp02Screen`, `PromptBoundary`, `ProgressSink`, `BuildSessionDeps`. Raw SDK types confined to `src/orchestrator/`.
- `progress-events.translate()` — pure, fail-closed, single inspector of raw SDK message/hook shapes → PipelineStage; refusal→refused before failed; unknown→null; never throws. 12 unit tests.
- Six Phase 3 audit record functions added to `record.ts` (schema comment-only extension — no new columns; `audit_log` has no CHECK constraints).
- `tests/e2e/build-flow.e2e.test.ts` — MVP e2e-first: encodes research→plan→comp02→build→done→IDLE; slice steps are `it.todo` (visible, not accidental green) until 03-04/03-06/03-09.
- Full suite: **394 passed + 6 todo** across 36 files (baseline 380 preserved); typecheck clean.

## Task Commits

1. **Task 1: Install Agent SDK + shared vocabulary + injected interfaces** - `f3b8c16` (feat)
2. **Task 2 (TDD RED): failing spec for translate + recordPipelineStage** - `8520b0c` (test)
3. **Task 2 (TDD GREEN): translation layer + pipeline audit fns** - `cd1dbe5` (feat)
4. **Task 3: failing/pending happy-path e2e (MVP e2e-first)** - `cb04f7f` (test)
5. **Lint follow-up: biome import-sort/format + deferred-items log** - `9448d45` (style)

## Files Created/Modified
- `src/orchestrator/types.ts` (created) - Injected structural seams for the whole phase; SDK-type containment boundary.
- `src/orchestrator/progress-events.ts` (created) - Pure `translate()` SDK-stream → PipelineStage (PILL_BY_MODE analog).
- `src/orchestrator/progress-events.test.ts` (created) - 12 translate cases + recordPipelineStage row assertion.
- `tests/e2e/build-flow.e2e.test.ts` (created) - Failing/pending happy-path slice; boots createApp injected-fake harness.
- `src/shared/types.ts` (modified) - `"orchestrator"` source, `PipelineStage`, `BuildStatusView`.
- `src/audit/record.ts` (modified) - 6 pipeline record fns (source "orchestrator", one row each, D3-13).
- `src/audit/schema.sql` (modified) - Comment-only event_type/source vocabulary extension.
- `package.json` / `package-lock.json` (modified) - SDK dependency pin.

## Decisions Made
- **translate(unknown):** typed the parameter `unknown` rather than an SDK union so no raw SDK type leaks into the layer's public signature — maximally contains the volatile pre-1.0 SDK surface while still fail-closed.
- **New `"orchestrator"` CandidateSource:** cleaner post-stream audit trail than overloading `"operator"` (03-RESEARCH.md Open Question 2, operationalized here).
- **Shipped all six audit record fns now:** downstream plans (03-04/03-06/03-09) get concrete write helpers, not a scavenger hunt — matches the interface-first objective.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] biome import-sort + format on new orchestrator files**
- **Found during:** Post-Task-3 lint pass
- **Issue:** biome required `@anthropic-ai/claude-agent-sdk` sorted ahead of `better-sqlite3`/`pino`, and multiline formatting on the refusal set / wrapped assertions — `npm run lint` failed on the 3 new orchestrator files.
- **Fix:** `biome check --write` on the changed files only; logic unchanged.
- **Files modified:** src/orchestrator/types.ts, progress-events.ts, progress-events.test.ts
- **Verification:** `biome check` clean on all 7 changed source files; typecheck + affected tests re-run green.
- **Committed in:** `9448d45`

---

**Total deviations:** 1 auto-fixed (1 blocking-lint). No scope creep.
**Impact on plan:** Formatting-only; all logic exactly as planned.

## Issues Encountered
- **Pre-existing repo lint failures (out of scope):** `npm run lint` reports 5 "Formatter would have printed" (CRLF) errors on untouched Phase 1 files (`src/audit/db.ts`, `src/compliance/categories.ts`, two fixture files, `src/state-machine/stream-mode.ts`). All 03-02 files pass biome. Logged to `deferred-items.md`; not fixed (SCOPE BOUNDARY — unrelated files).

## User Setup Required
None for this plan. Real WSL2 execution remains gated by the Wave 0 human-verification checkpoint (`SANDBOX-SETUP.md`, plan 03-01, still PENDING) — this plan builds entirely against injected fakes and does not require a real distro.

## Next Phase Readiness
- Concrete contracts delivered: 03-04 (COMP-02) implements `Comp02Screen`; 03-05 implements `SandboxAdapter`; 03-06 implements `AgentRunner`/`BuildSessionDeps` and consumes `translate()` + the audit record fns; 03-07 renders `BuildStatusView`; 03-08 implements `DevServerProbe`.
- The failing `build-flow.e2e.test.ts` is the executable definition-of-done the phase drives toward; its `it.todo` names map 1:1 to the plans that turn them green.
- Invariants preserved: single-funnel (SDK string differs from classifier's `@anthropic-ai/sdk`), dom-safety, chat-sender, secrets — full 380-test baseline intact.

## Self-Check: PASSED

- Created files exist: `src/orchestrator/types.ts`, `progress-events.ts`, `progress-events.test.ts`, `tests/e2e/build-flow.e2e.test.ts`, `deferred-items.md` — all FOUND.
- Task commits exist: `f3b8c16`, `8520b0c`, `cd1dbe5`, `cb04f7f`, `9448d45` — all FOUND.
- SDK pinned exact `@anthropic-ai/claude-agent-sdk@0.3.206`; dockerode NOT installed.
- `npm run typecheck` clean; `npm test` = 394 passed + 6 todo (36 files); plan verify grep passes.

---
*Phase: 03-sandboxed-build-engine-live-show*
*Completed: 2026-07-10*
