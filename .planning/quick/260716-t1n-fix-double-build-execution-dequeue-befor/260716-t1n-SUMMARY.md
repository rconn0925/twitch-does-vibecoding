---
phase: quick-260716-t1n
plan: 01
subsystem: orchestrator
tags: [build-session, drain, race-condition, state-machine, auto-cycle, fdl, regression-tests]

# Dependency graph
requires:
  - phase: quick-260716-fdl
    provides: VOTE_WAITS_FOR_BUILD scheduler park/resume (the synchronous STATE_CHANGED resume that exposed the window)
  - phase: quick-260716-rll
    provides: the ONE dispatchBuild funnel in main.ts (grep-gate: exactly 1 buildSession.startBuild call site) this fix composes with
provides:
  - Dequeue-before-transition ordering invariant in ALL THREE build-session terminal paths (finalize, finalizeAborted, skipTask)
  - startedVoteHeads positive re-run guard (bounded Set, FIFO eviction) in drainVoteQueue head selection
  - 12 regression tests pinning the live double-build fingerprint (4 unit ordering-invariant + 8 e2e incl. kind matrix + history-uniqueness sweeps)
affects: [build-session, drainVoteQueue, auto-cycle consumers, any future synchronous STATE_CHANGED subscriber]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Terminal-path ordering: a task is never discoverable in the queue once its terminal record is written / the machine leaves BUILD_IN_PROGRESS — dequeue MUST precede the IDLE transition because STATE_CHANGED handlers run synchronously inside transition()"
    - "Drain commit-point stamping: drainVoteQueue marks a head as started ONLY at the moment it commits (chaos arm / after a successful BUILD_IN_PROGRESS transition), never on a refused drain"

key-files:
  created:
    - tests/e2e/double-build-regression.e2e.test.ts
  modified:
    - src/orchestrator/build-session.ts
    - src/main.ts
    - src/orchestrator/build-session.test.ts

key-decisions:
  - "Two independent layers per the debug report: ordering reorder (primary, structural) + startedVoteHeads guard (belt, defends all future synchronous drain routes incl. the latent chaosModePick arm)"
  - "onWinnerQueued deliberately NOT deferred via setImmediate — would change closeRound's intentional synchronous VOTING_ROUND->BUILD_IN_PROGRESS semantics (explicitly rejected by the report)"
  - "finalizeAborted dequeues before ANY emit (including BUILD_STAGE_CHANGED), so no subscriber of any abort-path event can ever see the aborted task queued"
  - "Guard stamped only at commit points: a refused drain (mode/window/chaos guard or transition failure) never marks the head"

patterns-established:
  - "Ordering-probe unit tests: wrap the fake machine's transition('IDLE') to assert queue/registry emptiness at the exact synchronous-emit instant"

requirements-completed: [QUICK-260716-t1n]

# Metrics
duration: ~25min
completed: 2026-07-16
---

# Quick Task 260716-t1n: Fix Double-Build Execution (dequeue before IDLE transition) Summary

**A finished build's task is now dequeued+unregistered BEFORE the BUILD->IDLE transition in all three terminal paths, plus a positive started-head guard in drainVoteQueue — the live 2026-07-16 double-build fingerprint (parked fdl vote + pool-of-1 + solo pick inside the IDLE emit) provably builds the solo winner next instead of re-executing the finished task.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-16
- **Tasks:** 2/2 (TDD: RED then GREEN)
- **Files modified:** 4

## Accomplishments

- Root cause from `.planning/debug/260716-double-build-execution.md` fixed structurally: `finalize()`, `finalizeAborted()`, and `skipTask()` all move `registry.unregister` + `taskQueue.remove` ABOVE the guarded `transition("IDLE")` — synchronous STATE_CHANGED subscribers (the fdl scheduler's `#resumeFromWait -> soloPick -> onWinnerQueued -> drainVoteQueue` chain) can no longer find the finished task at the queue head.
- Belt layer: `startedVoteHeads` (bounded Set, FIFO eviction >128) in `drainVoteQueue` — head selection is `taskQueue.list().find((t) => isVoteOrigin(t) && !startedVoteHeads.has(t.id))`, stamped only at commit points (chaos arm before `runChaosWinner`; build arms after the successful `BUILD_IN_PROGRESS` transition). Defends every future synchronous drain route, including the latent chaosModePick "picked" arm.
- 12 regression tests pin the fix: the exact live fingerprint (suggestion kind), the project-switch kind matrix (exactly ONE workspace_reset per win — each live double-run burned an extra generation), history-uniqueness sweeps (no task_id >1 result='built' row), and unit ordering invariants for all three terminal paths at the transition instant.
- RED run reproduced the live incident byte-for-byte in the logs: `done` -> solo enqueue -> re-`building` of the SAME task_id in the same millisecond window, two build_history rows, two workspace_reset rows for a project-switch win.

## Task Commits

1. **Task 1 (RED): failing regression tests for the double-build-execution window** - `7c54cbd` (test)
2. **Task 2 (GREEN): dequeue before the IDLE transition + drain started-head guard** - `9e50d61` (fix)

## Files Created/Modified

- `src/orchestrator/build-session.ts` - unregister+remove moved above the IDLE transition in finalize/finalizeAborted/skipTask; invariant documented at each path; HALTED guard and CR-01 semantics byte-preserved
- `src/main.ts` - `startedVoteHeads` bounded Set + `stampStartedHead` near drainVoteQueue; guarded head selection; commit-point stamps; no new `buildSession.startBuild` call (rll grep-gate still 1 occurrence)
- `src/orchestrator/build-session.test.ts` - new describe "dequeue-before-IDLE ordering invariant": (a) finalize done, (b) shutdown-style finalizeAborted at BUILD_IN_PROGRESS, (b2) HALTED-stays-frozen pin, (c) skipTask — all probe queue/registry at the exact transition("IDLE") instant
- `tests/e2e/double-build-regression.e2e.test.ts` - live fingerprint (suggestion) + project-switch kind matrix + workspace_reset and history-uniqueness sweeps, via the standard createApp fake harness

## Verification

- Full suite: 1381/1381 passing (baseline 1369 + 12 new), zero failures.
- LOCKED rails: `git diff --stat` across both commits touches ONLY the four files above — `src/state-machine/auto-cycle.ts`, `src/state-machine/auto-cycle.test.ts`, `tests/invariants/single-funnel.test.ts` untouched and passing.
- rll compose check: `grep -c 'buildSession.startBuild(' src/main.ts` == 1 (save-and-close GATE A green).
- `npx tsc --noEmit` clean; `npx biome check` clean on all four touched files.
- Side-effect sweep (per plan): the only other synchronous-reachable `taskQueue.list()` consumers are `isVoteQueueFull` (deliberate off-by-one now releases one emit earlier — benign) and driveWindowBuild/driveChaosBuild (id lookups, not head reads). The deferred STATE_CHANGED drain (main.ts setImmediate) still starts the NEXT queued task — pinned by Test 1's "solo winner builds next" and the pre-existing auto-cycle drain e2e suite.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — internal race-condition fix; no new external input, packages, or network surface. Both threat-register mitigations (T-t1n-01 re-execution EoP, T-t1n-02 duplicate-history repudiation) are implemented and test-pinned.

## Self-Check: PASSED

- tests/e2e/double-build-regression.e2e.test.ts: FOUND
- src/orchestrator/build-session.ts reorder (taskQueue.remove before transition("IDLE")): FOUND
- src/main.ts startedVoteHeads: FOUND
- Commit 7c54cbd: FOUND
- Commit 9e50d61: FOUND
