---
phase: quick-260716-fdl
plan: 01
subsystem: state-machine / overlay / narration
tags: [auto-cycle, vote-waits-for-build, overlay-banner, env-knob]
requires: [quick-t5k auto-cycle scheduler, quick-rs3 chaosModePick hook, quick-l2a early close]
provides:
  - AutoCycleScheduler "waiting" park state (voteWaitsForBuild REQUIRED dep, default ON via main.ts)
  - VOTE_WAITS_FOR_BUILD strict-string env knob (exact "false" restores pipelining)
  - OverlayState.voteWaiting bare-boolean wire field + BUILDING-gated waiting banner
  - WindowNarrator.waitingForBuild pinned chat beat (one per park)
affects: [src/state-machine/auto-cycle.ts, src/main.ts, src/overlay/server.ts, src/overlay/public/overlay.js, src/ingestion/narration.ts, src/operator-console/server.ts]
tech-stack:
  added: []
  patterns: [strict-string env idiom (AUTO_ROUND_ENABLED), T-04-13 wire narrowing, one-beat-per-park (#queueFullNarrated mirror), shared-funnel extraction (#attemptRoundStart)]
key-files:
  created: []
  modified:
    - src/state-machine/auto-cycle.ts
    - src/state-machine/auto-cycle.test.ts
    - src/main.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/overlay/server.ts
    - src/overlay/server.test.ts
    - src/overlay/public/overlay.js
    - src/overlay/overlay-copy.test.ts
    - src/operator-console/server.ts
    - .env.example
    - src/ingestion/twitch-chat.test.ts (Rule-3 fake-narrator fallout)
    - tests/e2e/recovery.e2e.test.ts (Rule-3 fake-narrator fallout)
decisions:
  - "Wait keyed off machine.mode === BUILD_IN_PROGRESS only — decision-pending freezes inherit the right park semantics for free (no build-session plumbing)"
  - "chaosModePick consult runs BEFORE the wait gate inside the shared #attemptRoundStart — chaos vote-skip picks keep firing mid-build"
  - "Wait cleared BEFORE #attemptRoundStart in #resumeFromWait (re-entrancy guard: the chaos/solo arms call #maybeBegin)"
  - "#park (halt) keeps the wait — halt-recover resumes the owed vote; toggle-off clears it — the owed vote dies with the pause"
metrics:
  duration: ~20 minutes
  completed: 2026-07-16
  tests: 1233 passing (baseline 1214 + 19 new)
  commits: 6
---

# Quick Task 260716-fdl: Vote Rounds Wait for Builds — Summary

**One-liner:** Auto-cycle scheduler now parks in a timer-free "waiting" state when a suggest phase ends mid-build (default ON via new `VOTE_WAITS_FOR_BUILD` strict-string knob) and opens the parked vote against the warm pool on the first BUILD_IN_PROGRESS→IDLE transition — with a BUILDING-gated overlay banner and one pinned chat beat per park.

## What Was Built

### Task 1 — Scheduler park state + resume funnel (`afee504` RED, `6623b31` GREEN)
- `AutoCycleDeps.voteWaitsForBuild` is REQUIRED (enabledAtBoot precedent — no class default can betray the production default); `AutoCycleNarrator.waitingForBuild()` added; `AutoCycleSnapshot.phase` widened to `"suggest" | "waiting" | null` (`phaseEndsAtMs` stays null while waiting — no deadline exists).
- The vote-attempt tail of `#onPhaseEnd` extracted into `#attemptRoundStart()` (chaosModePick consult → wait gate → startRound with the solo/restart arms) so phase end and wait-resume run the byte-identical funnel; eligibility extracted into one shared `#isEligible()` predicate.
- Resume routing: `#maybeBegin` redirects to `#resumeFromWait()` while parked, so every existing poke (STATE_CHANGED, ROUND_CLOSED, `start()`, WINDOW_CLOSED/REVOKED) funnels correctly with zero handler changes. The wait clears BEFORE `#attemptRoundStart` (re-entrancy guard).
- `#park()` (halt) keeps the wait (halt-recover resumes the owed vote); `toggle()` off clears it (owed vote dies with the pause). One `waitingForBuild` beat per park (`#waitNarrated`, the `#queueFullNarrated` mirror).
- 12-case matrix added: default park, terminal/veto un-park, pipelining=false byte-compat, early-close park, HALT-frozen wait + recover, toggle semantics, chaos bypass mid-build, window/queue-full resume interplay, ROUND_CLOSED while waiting, one-beat-per-park, zero-timer deadlock proof (`vi.getTimerCount() === 0` while waiting). Harness default is `false` with a loud comment — every pre-fdl pipelining test passes unmodified.

### Task 2 — Composition + narration + env knob + wire field (`241f1bc` RED, `cf3a410` GREEN)
- `main.ts`: `const voteWaitsForBuild = (process.env.VOTE_WAITS_FOR_BUILD ?? "").trim() !== "false";` (the exact AUTO_ROUND_ENABLED idiom); passed into scheduler deps + `narrate.waitingForBuild` late-binding; boot log carries the knob.
- `narration.ts`: `waitingForBuild()` POSTS the pinned line `"Build in progress — the vote opens the moment it's done. Keep the !suggest ideas coming."` (buildQueueFull precedent — NOT an anti-spam no-op; at most once per build).
- `overlay/server.ts`: `OverlayAutoCycleSource` widened; `OverlayState.voteWaiting` bare boolean narrowed from `ac.phase === "waiting"` (suggestPhase T-04-13 idiom — no deadline, no enabled flag, no richer field; test-asserted).
- `operator-console/server.ts`: `ConsoleAutoCycleSource` + `ConsoleState.autoCycle` phase widened (type-only; console.js's `=== "suggest"` ternary fails safe to "Auto-cycle: on").
- `.env.example`: `VOTE_WAITS_FOR_BUILD=` documented next to AUTO_ROUND_ENABLED/VOTE_QUEUE_MAX (default ON, strict string, VOTE_QUEUE_MAX still governs pipelining mode).

### Task 3 — Overlay waiting banner + copy pins (`25c1ca9` RED, `f02dbe9` GREEN)
- `overlay.js` `renderPhaseBanner`: ONE new branch between the VOTE NOW and suggest-countdown branches — `latest?.voteWaiting && !sp && latest?.pill === "BUILDING"`. Same two-row structure (`phase-toprow`/`phase-title`/`phase-hint`, no new CSS), NO countdown element. The BUILDING-pill guard suppresses the banner during HALT (ON HOLD) and paid/chaos windows. Fixed copy only, textContent via `el()`.
- `overlay-copy.test.ts`: exact-string pins for title/hint, gating pins (voteWaiting + BUILDING pill before the title, VOTE NOW > waiting > suggestions ordering), existing suggest-banner/T4 pins asserted undisturbed.
- The 1s tick gate needed no change (the waiting banner has no countdown; it re-renders on server pushes).

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run` (full suite) | 1233/1233 pass (baseline 1214 + 19 new) |
| `npx vitest run src/state-machine/auto-cycle.test.ts` | 43/43 (31 pre-existing unmodified + 12 new) |
| `npx tsc --noEmit` | clean |
| `npx biome check src` | exit 0 (3 pre-existing warnings in untouched `overlay.css` only) |
| Invariant suites (`tests/invariants/*`) | untouched, green in full run |

## LOCKED Invariants Held

- **halt/HALTED freeze semantics unchanged**: `#park()` and the HALT_TRIGGERED handler are structurally untouched; the wait survives a halt (matrix-asserted: nothing fires while HALTED, recover resumes the owed vote).
- **chaos + free-reign paths unaffected**: asserted, not modified — chaosModePick runs before the wait gate (mid-build picks keep firing, matrix test); paid-window direct queueing bypasses the scheduler entirely (window-interplay tests); zero diffs in `src/chaos/`, control-window, gate, or queue code.
- **pipelining mode ("false") byte-compatible**: harness defaults `voteWaitsForBuild: false`, so all pre-fdl scheduler tests prove today's behavior unmodified; explicit pipelining-restored test added.
- **All 1214 baseline tests pass unmodified** (no existing assertion changed; only harness deps + fake narrators gained the new no-op member).

## Deviations from Plan

**1. [Rule 3 - Blocking] Fake narrators needed the new required interface member**
- **Found during:** Task 2 (tsc)
- **Issue:** `WindowNarrator.waitingForBuild` is required, so the fake narrators in `src/ingestion/twitch-chat.test.ts` and `tests/e2e/recovery.e2e.test.ts` (files outside the plan list) failed to compile.
- **Fix:** Added `waitingForBuild` no-op mocks to both fakes (mechanical, zero behavior change).
- **Commit:** `cf3a410`

**2. [Rule 3 - Blocking] ConsoleState.autoCycle wire type also needed widening**
- **Found during:** Task 2 (tsc, operator-console/server.ts L367)
- **Issue:** The plan named only the `ConsoleAutoCycleSource` seam (L133), but `ConsoleState.autoCycle` re-projects `{enabled, phase}` and needed the same type-only widening.
- **Fix:** Widened to `"suggest" | "waiting" | null` with a doc comment. console.js untouched (fails safe by design).
- **Commit:** `cf3a410`

**3. [Process] tsc intentionally red between Task 1 GREEN and Task 2 GREEN**
- The plan's design uses required-dep enforcement (`main.ts` missing `voteWaitsForBuild`) as the proof the knob gets wired; Task 1's verify is scoped vitest only and Task 2's verify is where tsc goes clean. Executed back-to-back to minimize the window; noted in the Task 1 GREEN commit message.

**4. [Rule 1 - Trivial] Biome format fix on the new snapshot ternary**
- One-line reformat in `auto-cycle.ts`, committed with Task 3 (`f02dbe9`).

## Known Stubs

None — all surfaces are wired end-to-end (env knob → scheduler → wire → banner → chat beat).

## Threat Flags

None beyond the plan's register. T-fdl-01 (bare boolean, narrowed), T-fdl-02 (event-driven resume, zero new timers — source-scan + `vi.getTimerCount()` asserted), T-fdl-03 (fixed pinned copy) all mitigated as planned; zero new dependencies (T-fdl-SC).

## ⚠️ LIVE-DEPLOY FLAG

**`src/overlay/public/overlay.js` is a CLIENT file cached by OBS CEF.** On live deploy:
1. Restart the app (server picks up the scheduler/wire changes), AND
2. Refresh the OBS browser sources — `npm run obs -- refresh` (per the OBS control tool memory) — or the waiting banner will not appear.

## Self-Check: PASSED

- All 11 planned files + 2 Rule-3 files modified and committed ✓
- Commits afee504, 6623b31, 241f1bc, cf3a410, 25c1ca9, f02dbe9 all present on `worktree-agent-a756d5e63fc638c9f` ✓
- must_haves artifacts: `auto-cycle.ts` contains `waitingForBuild` ✓; `overlay.js` contains `vote opens when it` ✓; `.env.example` contains `VOTE_WAITS_FOR_BUILD` ✓
- key_links: `main.ts` contains `VOTE_WAITS_FOR_BUILD` (strict-string idiom) ✓; `overlay/server.ts` contains `voteWaiting` narrowed from `ac.phase === "waiting"` ✓
