---
phase: quick-260711-rs3-chaos-mode
plan: 01
subsystem: chat-commands / show-modes
tags: [chaos-mode, vote-skip, chat-activation, overlay, compliance-separation]
requires:
  - quick-260711-q5n (kind router in drainVoteQueue, enqueueWinner funnel)
  - quick-260710-t5k (AutoCycleScheduler #onPhaseEnd)
  - quick-260711-l2a (pool-full early close — used to trigger phase ends deterministically in e2e)
provides:
  - "!chaos command (strict no-arg) + ChaosModeController (unique-user tally, timed window)"
  - "vote-skip pick hook in the auto-cycle routing through the UNCHANGED q5n kind router"
  - "overlay chaosMode:{endsAtMs}|null wire field + CHAOS MODE badge (slate-50 dot, m:ss tick)"
  - "chaos_activated / chaos_pick(+kind) / chaos_expired audit rows"
affects:
  - any future work on AutoCycleScheduler phase-end semantics (chaosModePick hook now sits after the eligibility gate)
  - overlay wire consumers (new chaosMode field on OverlayState)
tech-stack:
  added: []
  patterns:
    - "allowlist source filter (chat|operator) so no payment token appears near the chaos path"
    - "two-call-site doctrine: kind-filter only when the consumer is the raw build agent"
    - "#maybeBegin-only follow-up begins at the pick hook (synchronous STATE_CHANGED re-entrancy absorption)"
key-files:
  created:
    - src/chaos/mode.ts
    - src/chaos/mode.test.ts
    - tests/e2e/chaos-vote-skip.e2e.test.ts
  modified:
    - src/ingestion/command-parser.ts (+ test)
    - src/ingestion/twitch-chat.ts (+ test)
    - src/ingestion/narration.ts (+ test)
    - src/shared/events.ts
    - src/audit/record.ts (+ test), src/audit/schema.sql (comment only)
    - src/state-machine/auto-cycle.ts (+ test)
    - src/main.ts
    - src/overlay/server.ts (+ test), src/overlay/public/overlay.js, src/overlay/public/overlay.css
    - tests/e2e/recovery.e2e.test.ts (fake Narrator widened)
decisions:
  - "ChaosModeController state is in-memory only — crash mid-chaos reboots democratic (documented in code)"
  - "empty eligible pool at a chaos phase end → restart/stillCollecting beat (checker INFO 2)"
  - "chaos-picked winners carry build_history provenance 'vote' BY DESIGN (same-winner-rail); true origin = chaos_pick row (checker INFO 1, ack comment at call site)"
metrics:
  duration: ~55 min
  completed: 2026-07-11
  tests: 1035 passing (was 1032 baseline at plan time listed 986+; +49 new across 3 tasks)
---

# Quick Task 260711-rs3: Chaos Mode Summary

**CHAOS_ACTIVATION_VOTES unique !chaos chatters flip a CHAOS_MODE_DURATION_SECONDS vote-skip window: suggest windows run unchanged, but at close one random already-gated chat/operator pool candidate rides the SAME enqueueWinner → drainVoteQueue kind-router rail a voted winner rides — with a slate-50 CHAOS MODE overlay badge, compliant narration, and full audit rows.**

## Tasks

| Task | Name | Commits (RED test / GREEN feat) |
| ---- | ---- | ------------------------------- |
| 1 | !chaos parser + ChaosModeController + dispatch seam + audit + narration | d2b8cdc / 1c25e19 |
| 2 | Composition root: activation wiring, vote-skip via kind router, HALT clears | b03d034 / a54085c |
| 3 | Overlay chaosMode wire + CHAOS MODE badge | 243b429 / e4d1fc1 |

## Binding invariants — verified

- **Single funnel untouched**: picks enter ONLY via `enqueueWinner`; `tests/invariants/single-funnel.test.ts` green with ZERO allowlist edits (`git diff 7cbbca3..HEAD -- tests/invariants/` empty).
- **Payment↔chance decoupling**: `src/chaos/mode.ts` contains zero payment tokens (paid-chaos-separation scan green, mode.ts in the governed set); the paid-source filter is an ALLOWLIST (`source === "chat" || source === "operator"`) in main.ts; e2e proves a donation-source candidate is never picked even with rng forced at its index.
- **halt.ts / selector.ts / pipeline/chaos.ts zero diffs** (`git diff --stat` empty vs base).
- **Server-composed strings only**: five new narration beats are fixed templates; titles pass truncateTitle; MONEY + GAMBLING copy-separation scans green over ALL chaos strings (old + new).
- **FREE REIGN > CHAOS**: the pick hook runs after `isControlWindowLive()`; e2e proves no pick fires during a live window and chaos resumes after revoke.
- **q5n router rules hold**: e2e proves a chaos-picked project-switch with a failing publisher does NOT rotate (generation unchanged, amber narration, failed gallery_publish row) and a chaos-picked revert runs the revert path (revert_outcome + build_history 'reverted').
- **Re-entrancy pin (checker BLOCKER)**: `#maybeBegin` (never `#beginSuggestPhase`) at the hook; unit test with a stub firing STATE_CHANGED mid-hook proves ONE begin beat + ONE timer + one phase end per suggestPhaseMs; e2e pins exactly 2 begin beats and 1 chaos_pick row across the picked window.
- **Randomness injectable** (`opts.chaosRng` reused); **no new dependencies**.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Scheduler stalled after control-window revoke (pre-existing latent bug)**
- **Found during:** Task 2 e2e (FREE REIGN precedence test — "chaos resumes after the window" never resumed)
- **Issue:** `ControlWindow.revoke()`/`#expire()` transition FREE_REIGN_WINDOW→IDLE BEFORE nulling `#window`; the scheduler's synchronous STATE_CHANGED resume check still saw a live window (a revoked window keeps a future endsAtMs) and stayed parked indefinitely.
- **Fix:** composition-root only — `controlWindow.on(WINDOW_CLOSED|WINDOW_REVOKED, () => autoCycle.start())` (start() is an idempotent eligibility-gated poke). control-window.ts untouched (out of scope); root-cause reorder noted in deferred-items.md.
- **Files modified:** src/main.ts
- **Commit:** a54085c

**2. [Rule 3 - Blocking] HALT handler TDZ on boot-restore**
- **Found during:** Task 2 full-suite run (recovery e2e: "Cannot access 'chaosMode' before initialization")
- **Issue:** the boot-restore path force-transitions to HALTED DURING createApp composition; the HALT_TRIGGERED handler ran `chaosMode.clear()` before the const initialized.
- **Fix:** ChaosModeController is now constructed immediately above the HALT handler registration (its narration callbacks close over the late-bound windowNarrator, so early construction is safe); the chaosVote/chaosModePick closures stay in the plan-specified position.
- **Files modified:** src/main.ts
- **Commit:** a54085c

**3. [Rule 3 - Blocking] Pre-existing Narrator fake needed the five new beats**
- **Found during:** Task 2 tsc (interface widening ripple)
- **Fix:** added the five no-op methods to tests/e2e/recovery.e2e.test.ts's inline fake Narrator (file not in plan's files_modified — mechanical type-completeness only).
- **Commit:** a54085c

### Deferred (documented, not fixed)

- **Theoretical sync recursion** ("empty" chaos outcome × pool-full early close with a ≥cap all-paid pool) — unreachable in production today (no path pools paid-source candidates); logged in `deferred-items.md` with the trigger condition and remedies.

## TDD Gate Compliance

All three tasks ran strict RED→GREEN: test commits (d2b8cdc, b03d034, 243b429) each verified failing before their feat commits (1c25e19, a54085c, e4d1fc1). No refactor commits needed.

## Verification

- `npm test`: **1035 passed / 0 failed** (71 files) — includes the new 14 controller units, 5 hook units + re-entrancy pin, 12 e2e, 3 overlay-wire tests, extended parser/dispatch/audit/narration coverage.
- `npx tsc --noEmit` clean; `npx biome check src` clean (3 pre-existing CSS warnings only, untouched files).
- Invariant suite 55/55 green, zero allowlist edits.
- Zero diffs: halt.ts, chaos/selector.ts, pipeline/chaos.ts.

## Known Stubs

None — no placeholder values, no unwired UI. The overlay badge is fully wired server→wire→client.

## Human follow-up (optional, batched)

- Visual pass: `npx tsx scripts/overlay-harness.ts` — confirm badge priority FREE REIGN > CHAOS MODE > DEMOCRATIC, white dot, ticking m:ss countdown (plan Task 3 human-check; batched to the end-of-phase gate batch per standing directive).

## Self-Check: PASSED

- src/chaos/mode.ts — FOUND
- src/chaos/mode.test.ts — FOUND
- tests/e2e/chaos-vote-skip.e2e.test.ts — FOUND
- Commits d2b8cdc, 1c25e19, b03d034, a54085c, 243b429, e4d1fc1 — FOUND in git log
