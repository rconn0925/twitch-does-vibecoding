---
phase: 03-sandboxed-build-engine-live-show
plan: 04
subsystem: orchestrator / compliance
tags: [COMP-02, compliance, single-funnel, orchestrator, tdd, D3-06, D3-07]
requires:
  - "src/compliance/gate.ts classify() (Phase 1 — the single funnel)"
  - "src/shared/types.ts CandidateSource 'orchestrator' (03-02)"
provides:
  - "src/orchestrator/comp02.ts screenBuildPlan() — COMP-02 pre-write plan re-screen (D3-06)"
  - "src/orchestrator/comp02.ts screenOutputBatch() — COMP-02 in-flight output re-screen (D3-07)"
  - "Comp02Deps (pre-bound classify seam) + Comp02Outcome vocabulary for 03-06 to consume"
affects:
  - "03-06 build session wires screenBuildPlan/screenOutputBatch into the pipeline"
tech-stack:
  added: []
  patterns:
    - "Direct classify() re-call (enqueueWinner precedent) — second call to the single funnel, not a new gate"
    - "Fail-closed / never-throw discipline (gate.ts / classifier.ts analog)"
    - "Single shared candidate-construction helper for both re-screen entry points"
key-files:
  created:
    - "src/orchestrator/comp02.ts"
    - "src/orchestrator/comp02.test.ts"
  modified: []
decisions:
  - "COMP-02 is a direct classify() call on the plan text — never submitCandidate/toQueuedTask/enqueue; single-funnel invariant needs no allowlist edit because classify() is already an allowed path"
  - "deps.classify is PRE-BOUND to the app gateDeps in main.ts (mirrors enqueueWinner) — not a fresh gate constructed inside comp02"
  - "candidate source is 'orchestrator' (03-RESEARCH Q2 / D3-06); plan/output text carried byte-identical, never raw chat re-fed"
  - "screenOutputBatch reuses the exact call shape with a distinct candidate id suffix (-output vs -plan) so audit rows are distinguishable"
metrics:
  duration: ~20m
  completed: 2026-07-10
  tasks: 1
  files: 2
  tests-added: 9
---

# Phase 3 Plan 04: COMP-02 Second Compliance Pass Summary

COMP-02 re-screens the build agent's OWN generated plan text (and, in-flight, its output batches) through the SAME Phase 1 gate via a direct `classify()` call — before any code is written — mapping approved→proceed, rejected→abort, held→console review, and never throwing.

## What Was Built

`src/orchestrator/comp02.ts` exports two thin functions plus their DI seam:

- **`screenBuildPlan(deps, { taskId, planText })`** (D3-06, pre-write): builds a `SuggestionCandidate` with `id: ${taskId}-plan`, `source: "orchestrator"`, `kind: "suggestion"`, `twitchUsername: null`, `text: planText`, and calls the pre-bound `deps.classify()` directly — the exact `enqueueWinner` direct-classify precedent from `src/pipeline/round.ts`.
- **`screenOutputBatch(deps, { taskId, outputText })`** (D3-07, in-flight): identical call shape with an `-output` candidate id for the orchestrator's during-execution re-screen (cadence is 03-06's call).
- **`Comp02Deps`**: carries `classify: (candidate) => Promise<GateResult>`, pre-bound to the app's shared `gateDeps` in `main.ts` — NOT a fresh gate.
- **`Comp02Outcome`**: `{ proceed: true }` | `{ proceed: false; disposition: "rejected"; category }` | `{ proceed: false; disposition: "held" }`.

Both entry points share one private `planCandidate()` helper (the REFACTOR requirement) and one `screen()` mapper. The mapper wraps `classify()` in a defensive try/catch that resolves to a fail-closed `rejected`/`classifier-unavailable` outcome — COMP-02 never throws out into the build-session loop.

## How It Preserves the Single Funnel

COMP-02 is a SECOND CALL to `classify()`, not a parallel gate. It references neither `submitCandidate` (wrong schema / fire-and-forget async), `toQueuedTask` (the branded-task constructor), nor `.enqueue(` (the pipeline-only queue write). The full `tests/invariants/single-funnel.test.ts` stays green: checks (b) `.enqueue(` only in `src/pipeline/`, (c) no Anthropic SDK import outside `src/compliance/`, and (d) `toQueuedTask` only in the sanctioned funnel files all still hold, because `comp02.ts` touches none of them. The audit row is written by `classify()` itself — COMP-02 does not re-audit.

## Tests

`src/orchestrator/comp02.test.ts` (9 tests, all passing):
- approved→`{ proceed: true }`; rejected→`{ proceed: false, disposition: "rejected", category }`; held→`{ proceed: false, disposition: "held" }`
- candidate carries `source: "orchestrator"`, `kind: "suggestion"`, `twitchUsername: null`, `id: task-42-plan`, and text byte-identical (unicode + double-space fixture guards against re-derivation)
- a throwing `classify()` still resolves to a fail-closed `rejected`/`classifier-unavailable` (never throws)
- `screenOutputBatch` mirrors the shape with a distinct `-output` id and byte-identical output text
- source scan asserting `comp02.ts` references no `submitCandidate` / `toQueuedTask` / `.enqueue(`

## Verification

- `npx vitest run src/orchestrator/comp02.test.ts` — 9 passed
- `npx vitest run` (full suite) — **403 passed + 6 todo** (394 baseline + 9 new); single-funnel invariant green
- `npx tsc --noEmit` — clean
- `npx biome check src/orchestrator/comp02.*` — clean
- Comment-stripped grep for `submitCandidate|toQueuedTask|\.enqueue(` in `comp02.ts` — count 0
- No real `query()` / WSL2 / network touched (injected fake classify only)

## Deviations from Plan

None — plan executed exactly as written.

## Note for 03-06 (wiring)

The Wave-1 seam `orchestrator/types.ts › Comp02Screen.screenPlan(): Promise<GateResult>` returns the RAW gate result, whereas this plan's `screenBuildPlan()` returns the mapped `Comp02Outcome`. These are two intentionally-distinct abstractions (raw seam vs. mapped decision). 03-06 will decide whether to adapt `screenBuildPlan` into a `Comp02Screen` or consume `Comp02Outcome` directly; this plan owned only `comp02.ts`/`comp02.test.ts` (disjoint files) and did not modify `orchestrator/types.ts`.

## Self-Check: PASSED

- src/orchestrator/comp02.ts — FOUND
- src/orchestrator/comp02.test.ts — FOUND
- commit 4cedb5c (test) — FOUND
- commit c9b15c2 (feat) — FOUND
