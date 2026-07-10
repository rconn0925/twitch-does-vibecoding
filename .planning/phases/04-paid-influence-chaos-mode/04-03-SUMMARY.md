---
phase: 04-paid-influence-chaos-mode
plan: 03
subsystem: state-machine
tags: [control-window, fsm, better-sqlite3, crash-safety, paid-influence, donation, channel-points]

# Dependency graph
requires:
  - phase: 04-01 (Wave 1 foundation)
    provides: control_windows schema + recordWindow* audit helpers + ControlWindowSnapshot/WindowTrigger/WindowStatus types + WINDOW_* events
  - phase: 01 (state machine)
    provides: StreamModeMachine (FREE_REIGN_WINDOW/IDLE transitions, HALT_TRIGGERED/STATE_CHANGED), RoundManager crash-safe FSM template
provides:
  - ControlWindow FSM (open/active/expiry/revoke) backing both donation + channel-points windows (D-03)
  - amountToDurationSeconds linear+floor+cap duration mapping + env config loaders (D-04)
  - per-donor cooldown guard + one-active-window guard with typed ControlWindowError (D-05)
  - absolute-endsAtMs crash-safe persistence + restore() re-arming REMAINING time only (D-06/PAID-04)
  - injected submitDuringWindow funnel seam (no gate/queue/RNG imports — paid side of D-08)
affects: [04-04 overlay control-window source, 04-05 console revoke route, 04-06 paid-window funnel + single-funnel invariant wiring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ControlWindow FSM mirrors RoundManager: absolute endsAtMs timer, armTimer/clearTimer with unref, HALT freeze + STATE_CHANGED resume/discard, crash-safe restore()"
    - "Injected funnel seam (SubmitDuringWindow type) — the FSM never imports gate/queue/RNG"
    - "Pure config-driven duration mapping with parse-env-or-default discipline (mirrors roundDurationMs)"

key-files:
  created:
    - src/control-window/duration.ts
    - src/control-window/duration.test.ts
    - src/control-window/persistence.ts
    - src/control-window/persistence.test.ts
    - src/control-window/control-window.ts
    - src/control-window/control-window.test.ts
  modified: []

key-decisions:
  - "Guard order in open() is window-active → not-idle → cooldown (mirrors RoundManager.startRound; an active window puts the machine in FREE_REIGN_WINDOW so window-active must be checked before the not-idle mode gate) — the plan prose listed not-idle first, but the behavior tests require a second trigger during an active window to throw window-active"
  - "Halt-recovery discard closes the window with status='revoked' (the control_windows enum is active|expired|revoked — there is no 'discarded' value as there is for rounds); recorded via recordWindowRevoked"
  - "donorDisplayName is not persisted (no schema column); restore() falls back to donor_identifier for the console projection"
  - "amountOrCost is the major unit for the mapping/label (donations in dollars, redemptions in points) so amountToDurationSeconds(5, donationCfg) == 60s per the plan behavior"

patterns-established:
  - "ControlWindow FSM: absolute-timestamp expiry + halt-freeze/resume/discard symmetry with RoundManager"
  - "amountToDurationSeconds: NaN→floor, negative→floor, +Infinity→cap (never NaN, never unbounded)"

requirements-completed: [PAID-01, PAID-02, PAID-04]

# Metrics
duration: 24min
completed: 2026-07-10
---

# Phase 4 Plan 03: ControlWindow FSM Summary

**A single crash-safe, streamer-revocable ControlWindow state machine backing both donation and channel-points windows — linear+capped duration with per-donor cooldown, one-at-a-time with typed never-silent denials, absolute-endsAtMs restore that re-arms only the remaining time, and an injected funnel seam that keeps the gate/queue/RNG out of the paid path.**

## Performance

- **Duration:** ~24 min
- **Completed:** 2026-07-10
- **Tasks:** 3
- **Files modified:** 6 (all created)

## Accomplishments
- `amountToDurationSeconds` pure linear+floor+cap mapping (T-04-07: a large donation can never buy an unbounded window) with hostile-input safety (NaN/negative→floor, +Infinity→cap) and env-driven donation/redemption/cooldown config loaders.
- `control_windows` persistence (insert/read-active/close) on the shared db handle, storing an ABSOLUTE `ends_at_ms` as the single source of truth (never recomputed on read).
- `ControlWindow` FSM mirroring `RoundManager`: open→active→expiry|revoke lifecycle, one-at-a-time + per-donor cooldown guards with a typed `ControlWindowError` and `window_denied` audit rows (never silent, D-05), HALT freeze + IDLE-recovery discard, and a `restore()` that re-arms for exactly the remaining time (D-06/T-04-08 crash-safety linchpin).
- Structural D-08 separation: `control-window.ts` imports no gate, no task-queue, and no RNG — donor instructions cross to the queue ONLY through the injected `submitDuringWindow` funnel (T-04-09).

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1 (RED): duration + persistence failing tests** - `42c7c31` (test)
2. **Task 1 (GREEN): duration mapping + control_windows persistence** - `d1ca21a` (feat)
3. **Task 2: ControlWindow FSM** - `5e9e7f4` (feat)
4. **Task 3: ControlWindow FSM tests** - `a7bbdde` (test)

## Files Created/Modified
- `src/control-window/duration.ts` - Pure `amountToDurationSeconds` + `loadDonationDurationConfig`/`loadRedemptionDurationConfig`/`cooldownMs` env loaders.
- `src/control-window/duration.test.ts` - Floor/cap/linear + hostile-input + parse-or-default coverage.
- `src/control-window/persistence.ts` - `insertWindow`/`readActiveWindow`/`closeWindow` over the shared db; absolute `ends_at_ms`.
- `src/control-window/persistence.test.ts` - CRUD round-trip, most-recent-active read-back, expired/revoked close.
- `src/control-window/control-window.ts` - The ControlWindow FSM class, `ControlWindowError`, `SubmitDuringWindow` type.
- `src/control-window/control-window.test.ts` - Lifecycle, denials (window-active/cooldown/not-idle), expiry, revoke, halt freeze/discard/resume, funnel injection, crash-restore (re-arm==remaining).

## Decisions Made
- **Guard order window-active → not-idle → cooldown.** An active window sits in FREE_REIGN_WINDOW, so checking not-idle first would mis-report a second trigger as "not-idle" instead of "window-active". Mirrors `RoundManager.startRound` (round-active before not-idle) and satisfies the plan's behavior test.
- **Halt-discard status = 'revoked'.** The `control_windows` status enum has no 'discarded' value (unlike `rounds`), so a halt-recovery IDLE discard closes as revoked and audits via `recordWindowRevoked`.
- **Added a resume path (HALTED→FREE_REIGN_WINDOW).** For full RoundManager symmetry, halt recovery to FREE_REIGN_WINDOW re-arms from the absolute deadline (expires immediately if it passed during the halt). The plan only required the IDLE-discard branch; resume is additive and tested.
- **donorDisplayName not persisted** — restore falls back to `donor_identifier` (schema has no display-name column).

## Deviations from Plan

None requiring the deviation rules — no bugs, missing-critical, or blocking issues arose. The guard-order and halt-discard-status choices above are interpretation decisions where the plan prose and the plan's own behavior tests / schema constrained the implementation; they are documented under Decisions Made rather than as auto-fixes.

## Issues Encountered
- The worktree had no `node_modules`; ran `npm install` (249 packages, prebuilt better-sqlite3 binary resolved cleanly on Node/Windows) before executing.
- During GREEN for Task 1, `amountToDurationSeconds` initially collapsed all non-finite inputs to the floor; refined to distinguish +Infinity (→cap) from NaN/negative (→floor) so an absurdly large amount honestly clamps to the cap. Fixed before the feat commit.

## Verification
- `npx vitest run` — full suite green: **578 passed** (550 Wave-1 baseline + 28 new: 12 duration/persistence + 16 FSM).
- `npx tsc --noEmit` — clean.
- `npx biome check src/control-window` — clean (6 files).
- Forbidden-token scan of `control-window.ts` — no `Math.random`/`randomInt`/`randomUUID`/`crypto.random`, no gate/task-queue import, no `toQueuedTask`/`.enqueue(` (the 04-06 D-08 separation scan will stay clean).

## Next Phase Readiness
- Ready for Wave 3 (04-06): wire the real `src/pipeline/paid-window.ts` funnel into the injected `submitDuringWindow` seam and add it to the `single-funnel.test.ts` allowlist; add the RNG-free source scan over `src/control-window/**`.
- Ready for 04-04 (overlay `OverlayControlWindowSource`) and 04-05 (console revoke route) to consume `ControlWindow.snapshot()` / `revoke()` — both are disjoint Wave-2 files owned by sibling executors.

## Self-Check: PASSED

All 6 source/test files and the SUMMARY exist on disk; all 4 task commits (`42c7c31`, `d1ca21a`, `5e9e7f4`, `a7bbdde`) are present in git history.

---
*Phase: 04-paid-influence-chaos-mode*
*Completed: 2026-07-10*
