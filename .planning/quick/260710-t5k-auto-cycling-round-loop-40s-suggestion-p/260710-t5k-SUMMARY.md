---
phase: quick-260710-t5k
plan: 01
subsystem: state-machine / composition / console / overlay
tags: [auto-cycle, concurrent-rounds, drain-queue, vote-queue-cap, overlay-guidance]
requires: [round-manager, stream-mode-fsm, task-queue, overlay-server, console-server]
provides:
  - AutoCycleScheduler (hands-free suggest→vote→enqueue cadence)
  - drainVoteQueue (single FIFO vote-winner build starter)
  - concurrent rounds under BUILD_IN_PROGRESS (A1)
  - zero-vote first-wins (D-03)
  - VOTE_QUEUE_MAX cap (user amendment)
  - overlay suggestPhase guidance (A2)
affects: [main.ts composition, operator console, public overlay, audit vocabulary]
tech-stack:
  added: []
  patterns:
    - event-driven scheduler (one unref'd setTimeout per phase, zero polling)
    - deferred STATE_CHANGED drain (setImmediate — finalize dequeues after the IDLE transition)
key-files:
  created:
    - src/state-machine/auto-cycle.ts
    - src/state-machine/auto-cycle.test.ts
    - tests/e2e/auto-cycle.e2e.test.ts
  modified:
    - src/state-machine/round.ts
    - src/state-machine/stream-mode.ts
    - src/audit/record.ts
    - src/ingestion/narration.ts
    - src/shared/events.ts
    - src/main.ts
    - src/operator-console/server.ts
    - src/operator-console/public/console.js
    - src/operator-console/public/console.css
    - src/overlay/server.ts
    - src/overlay/public/overlay.js
    - .env.example
decisions:
  - "Checker residual note resolved: drainVoteQueue SKIPS a non-vote-origin queue head (dead-window paid instruction) to the first vote-origin task — leftover stays queued for streamer veto"
  - "Window instructions now carry their window trigger (donation/channel_points) as candidate source — makes leftovers identifiable AND the gate_decision ledger filterable by influence path"
  - "Overlay slot precedence: a LIVE concurrent round outranks the build panel in the shared lower-left slot (pill stays BUILDING); suggest guidance yields to an active build panel"
  - "VOTE_QUEUE_MAX (user amendment): scheduler defers new suggest phases at cap; manual starts exempt; winners never dropped"
metrics:
  duration: ~40 min
  completed: 2026-07-10
  tests: 724 passed (was 688 at baseline; +36 new)
---

# Quick Task 260710-t5k: Auto-Cycling Round Loop Summary

**One-liner:** Hands-free 40s-suggest → vote → enqueue → repeat cadence via an event-driven AutoCycleScheduler, with concurrent rounds during builds (A1), a single FIFO drainVoteQueue starter, zero-vote first-wins, a VOTE_QUEUE_MAX park (user amendment), and overlay suggest/vote guidance (A2).

## Task Commits

| Task | Commit(s) | What |
| ---- | --------- | ---- |
| 1 (TDD) | `f47ead8` (RED), `ad7679e` (GREEN) | Round engine: concurrent rounds, halt-recovery matrix (BLOCKER-2), zero-vote first-wins (D-03), IDLE→BUILD_IN_PROGRESS row, initiator audit, suggest-phase narration beats |
| 2 (TDD) | `f223cdd` (RED), `a65df20` (GREEN) | AutoCycleScheduler (full fake-timer matrix) + overlay `suggestPhase` projection + AUTO_CYCLE_CHANGED push |
| 3 | `035b09b` | main.ts composition (drainVoteQueue + wiring + env knobs), console toggle route/UI, .env.example, drain-trio + toggle + cap e2e |
| 4 | `34c8914` | Overlay client guidance UI (A2), concurrent-round slot precedence, full gate |

## Gate Results

| Task | Gate | Result |
| ---- | ---- | ------ |
| 1 | `npx vitest run src/state-machine/round.test.ts src/state-machine/stream-mode.test.ts` | PASS (plus full suite 701) |
| 2 | `npx vitest run src/state-machine/auto-cycle.test.ts src/overlay/server.test.ts` | PASS (plus full suite 716); `grep -c setInterval src/state-machine/auto-cycle.ts` = 0 |
| 3 | `npx vitest run && npx tsc --noEmit` | PASS (724 tests, tsc clean) |
| 4 (final) | `npx vitest run && npx tsc --noEmit && npx biome check .` | PASS (724 tests, tsc clean, biome clean) |

Kill-switch invariants: halt-parks fake-timer test + halt-during-concurrent-round × three-recovery-actions matrix green; drain-trio (iii) proves recovery never auto-starts a build. Single-funnel invariants suite green non-vacuously (55/55); zero innerHTML added anywhere.

## Deviations from Plan

### User-directed scope addition (amendment)

**VOTE_QUEUE_MAX cap.** New env knob (envPositive, default 10, documented in .env.example). At/above cap the AutoCycleScheduler defers the next suggestion phase (same park mechanism as its other defer conditions) and resumes on the first STATE_CHANGED after the queue drains. One `buildQueueFull()` narration beat per park ("Build queue full — pausing new rounds until it drains."). Manual round start is exempt; a voted winner is NEVER dropped by the cap (both e2e-proven). Cap counts vote-origin tasks only and includes a currently-building vote task (conservative off-by-one, commented in main.ts). Note: a queue drained purely by console veto wakes the scheduler on the next STATE_CHANGED/ROUND_CLOSED, not instantly (vetoes emit no machine event) — accepted, documented here.

### Auto-fixed issues

**1. [Rule 1 - Bug] Deferred the STATE_CHANGED→IDLE drain by one tick**
- **Found during:** Task 3
- **Issue:** `finalize()` in build-session.ts transitions BUILD_IN_PROGRESS→IDLE BEFORE dequeuing the finished task; a synchronous drain on STATE_CHANGED would see the finished task still at the queue head and rebuild it forever.
- **Fix:** the listener defers via `setImmediate` and re-checks `mode === "IDLE"` before draining. The completion continuation (post-`await startBuild`) is unaffected.
- **Files:** src/main.ts — **Commit:** `035b09b`

**2. [Rule 2 - Correctness] Window instructions carry the window trigger as candidate source**
- **Found during:** Task 3 (implementing the checker-note skip)
- **Issue:** `routeWindowInstruction` created candidates with `source: "chat"`, making a dead-window leftover indistinguishable from a vote winner at the queue head (the checker note's skip would be unimplementable) and leaving the gate_decision ledger unfilterable by influence path (record.ts's own doctrine).
- **Fix:** source is now the live window's trigger (`"donation" | "channel_points"` — the CandidateSource values minted for this path). `isVoteOrigin` = source `"chat" | "operator"`.
- **Files:** src/main.ts — **Commit:** `035b09b`
- **Residual:** a queued-but-never-driven chaos pick also carries source "chat" and would drain as provenance "vote"; essentially unreachable today (chaos drives its picks immediately) — accepted.

### Checker residual note — resolution (as directed)

`drainVoteQueue` finds the first **vote-origin** task (`taskQueue.list().find(isVoteOrigin)`) — a non-vote-origin head is SKIPPED in place, never built with mislabelled provenance; the streamer can veto it via the existing `/api/tasks/:id/veto`. Covered implicitly by the source-tagging above plus the drain guards; the vote-origin-skip predicate is exercised in every drain e2e (all heads are checked against `isVoteOrigin`).

### Minor notes

- **overlay.css untouched** (was in the plan's file list): the A2 suggestion variant reuses `vote-header`/`vote-title`/`vote-countdown`/`countdown-final`/`vote-hint` wholesale — no new class was needed (plan explicitly allowed this).
- **Overlay slot precedence** (plan was silent): a LIVE concurrent round takes the shared lower-left slot over the build panel (reconciliation point 2 requires the vote panel to render; the pill still reads BUILDING). During a suggest phase mid-build, the build panel keeps the slot and the suggest guidance stays absent — guidance never displaces live build progress.
- **voteHint copy** updated from "type !vote 1, 2 or 3" to the A2 form "type !vote 1 / !vote 2 / !vote 3" (client-only string).
- **4 files LF-normalized in the working tree only** (src/audit/db.ts, src/compliance/categories.ts, 2 fixtures): a worktree-checkout CRLF artifact broke `biome check .`; content was byte-identical to the index (staging produced no diff, nothing committed). Not a source change.
- **Fake narrators** in twitch-chat.test.ts / recovery.e2e.test.ts gained the three new beat methods (interface conformance).

## TDD Gate Compliance

Tasks 1 and 2 ran RED→GREEN: `test(...)` commits `f47ead8`/`f223cdd` precede `feat(...)` commits `ad7679e`/`a65df20`. RED runs verified failing (12 and 2+collect-error failures respectively) before implementation.

## Known Stubs

None. `suggestPhase: null` / `phase: null` are real states, not placeholders; no TODO/FIXME/placeholder text introduced.

## Threat Flags

None beyond the plan's register. T-t5k-01..05 all implemented as specified (CSRF-mirrored toggle route with foreign-Origin 403 test; `{endsAtMs}`-only wire narrowing with an `enabled`-never-on-wire assertion; zero polling; drain-sole-caller IDLE→BUILD edge with window/chaos/from-HALTED guards; scheduler parks on HALT_TRIGGERED). The VOTE_QUEUE_MAX amendment is DoS-mitigating (bounds winner minting). T-t5k-SC holds: zero new dependencies, npm install never ran.

## Self-Check: PASSED

- Files created exist: auto-cycle.ts, auto-cycle.test.ts, auto-cycle.e2e.test.ts — FOUND
- Commits exist: f47ead8, ad7679e, f223cdd, a65df20, 035b09b, 34c8914 — FOUND
- Final gate re-run green: 724 tests / tsc / biome
- halt.ts, forceTransition path, .env, ROADMAP.md, STATE.md untouched (verified via `git diff --name-only` against base da84f00)
