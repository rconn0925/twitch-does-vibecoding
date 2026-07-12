---
phase: quick-260711-rs3-chaos-mode
verified: 2026-07-11T21:02:00Z
status: human_needed
score: 8/8 must-haves verified
overrides_applied: 0
human_verification:
  - test: "npx tsx scripts/overlay-harness.ts — confirm badge priority FREE REIGN > CHAOS MODE > DEMOCRATIC, white (slate-50) dot, ticking m:ss countdown"
    expected: "CHAOS MODE badge renders with a white dot (never violet/red), m:ss countdown ticks client-side, FREE REIGN outranks it, expiry collapses silently to DEMOCRATIC"
    why_human: "Visual appearance in the OBS browser source cannot be verified by grep/tests; the wire, DOM-class logic, and CSS values are code-verified — only the rendered look needs eyes. Plan Task 3 marks this OPTIONAL and batches it to the end-of-phase gate per standing directive."
---

# Quick Task 260711-rs3: Chaos Mode — Verification Report

**Goal:** Chaos Mode — !chaos unique-chatter activation (default 3, env-tunable), timed vote-skip window with democratic reversion; random already-gated pool pick through the SAME q5n winner path; payment↔chance decoupling absolute; FREE REIGN > CHAOS > DEMOCRATIC; HALT clears chaos; audit rows; in-memory only; #maybeBegin re-entrancy fix with unit + e2e pins.
**Verified:** 2026-07-11 (goal-backward, against merged master at 8fe20fe; base 7cbbca3)
**Status:** human_needed (all 8 automated truths VERIFIED; one optional visual pass remains)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Unique-chatter activation (default 3, env CHAOS_ACTIVATION_VOTES), timed window (env CHAOS_MODE_DURATION_SECONDS, default 300s), dupes never double-count, tally resets on activation AND expiry, expiry auto-reverts | ✓ VERIFIED | `src/chaos/mode.ts` (Set dedupe L71, tally reset L78/L101, unref'd timer L114-126); env knobs `src/main.ts` L397-403 (defaults 3/300); unit suite `src/chaos/mode.test.ts`; e2e §1 (dupe silent, 1/3 + 2/3 beats only, expiry → chaos_expired row + normal vote round afterwards) — ran green |
| 2 | Vote round SKIPPED while active; one random pooled candidate routed through the SAME q5n winner path (enqueueWinner → onWinnerQueued → drainVoteQueue kind router); ship-gating held | ✓ VERIFIED | `src/main.ts` L788-807 (enqueueWinner + onWinnerQueued, zero new routing); e2e §4: chaos-picked project-switch with failing publisher → generation UNCHANGED + failed gallery_publish row; chaos-picked revert → revert_outcome row, never reaches the agent runner — ran green |
| 3 | Exactly ONE begin beat + ONE chaos_pick row per window — synchronous STATE_CHANGED re-entrancy absorbed (#maybeBegin, never #beginSuggestPhase) | ✓ VERIFIED | `src/state-machine/auto-cycle.ts` L307-311 — the hook's follow-up begin is `this.#maybeBegin(...)` guarded by L205; `#beginSuggestPhase` is unreachable from the hook. Unit pin `auto-cycle.test.ts` L443-472 fires a REAL StreamModeMachine.transition() inside the stub (genuine synchronous STATE_CHANGED mid-hook), asserts 1 beat/1 timer/1 further phase end. E2e pin L283-290 asserts {open: 2, still: 0} beats + 1 chaos_pick row with a real synchronous BUILD_IN_PROGRESS entry — ran green |
| 4 | Payment↔chance decoupling absolute: allowlist chat\|operator at the pick site; mode.ts passes the paid-chaos source scan | ✓ VERIFIED | `src/main.ts` L779-781 — ALLOWLIST `source === "chat" \|\| source === "operator"` (no payment token near the chaos path); `tests/invariants/paid-chaos-separation.test.ts` globs `src/chaos/**` so mode.ts is auto-governed (non-empty-set guard L59) — invariant suite ran green, zero allowlist edits (`git diff 7cbbca3..HEAD -- tests/invariants/` empty); e2e: donation-only pool behaves as empty; rng FORCED at the paid index picks the allowlisted neighbor |
| 5 | FREE REIGN outranks CHAOS: pick hook sits BEHIND the scheduler eligibility check | ✓ VERIFIED | `auto-cycle.ts` — hook at L307 runs after the `isControlWindowLive()` check at L280; unit test L418-429 (hook NOT consulted with a live window); e2e §3: no pick during a live window, pick fires after revoke — ran green |
| 6 | HALT clears chaos (tally AND window); no pick while HALTED; recovery democratic; in-memory only | ✓ VERIFIED | `src/main.ts` L437 `chaosMode.clear()` in the HALT_TRIGGERED handler; `chaosVote` HALTED guard L756; pick-closure HALTED guard L774; `mode.ts` clear() fires NO onExpired (halt ≠ expiry, L98-103); in-memory-only documented mode.ts L12-13; e2e §3 proves fresh 1/3 tally after recovery (both window AND tally died) — ran green |
| 7 | Overlay wire chaosMode:{endsAtMs}\|null (server-composed, narrowed); slate-50 badge, FREE REIGN > CHAOS > DEMOCRATIC priority, client-ticked m:ss | ✓ VERIFIED | `src/overlay/server.ts` L135 (wire field), L224-238 (source seam + NULL source), L420 (explicit re-narrowing), L543-545 (CHAOS_MODE_CHANGED immediate push, not debounced); `overlay.js` renderBanner L176-209 (cw branch first → chaos with `endsAtMs > Date.now()` → democratic; class hygiene) + 1s tick L538-540; `overlay.css` L165-171 `#f8fafc` dot/label; server.test.ts covers null/narrowing/push. Rendered look = the one human item |
| 8 | All five narration beats server-composed, no gambling words (luck/odds/roll/gamble), no money words (money/tip/donation/points/pay) | ✓ VERIFIED | `src/ingestion/narration.ts` L451-475 — five fixed templates verbatim per plan, titles via truncateTitle only; `narration.test.ts` L462-529 verbatim-pins all five AND scans ALL chaos strings (old + new) against MONEY + GAMBLING regexes — ran green |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/chaos/mode.ts` | ChaosModeController, min 60 lines | ✓ VERIFIED | 139 lines; tally/threshold/unref'd timer/clear()/snapshot()/dispose()/CHAOS_MODE_CHANGED emitter; zero payment tokens |
| `src/chaos/mode.test.ts` | threshold/dupe/reset/expiry/clear units with injected now() | ✓ VERIFIED | Fake-timer suite incl. CHAOS_MODE_CHANGED emission on activate/expire/clear |
| `tests/e2e/chaos-vote-skip.e2e.test.ts` | activation → pick → routing → expiry → halt proofs + re-entrancy pin | ✓ VERIFIED | 595 lines, 12 tests, 4 describe blocks covering every behavior bullet — all passing |
| `src/ingestion/command-parser.ts` | strict no-arg !chaos | ✓ VERIFIED | `/^!chaos$/i` L114, trailing text → null, zod ChaosCommand, RevertCommand idiom |
| `src/overlay/server.ts` | chaosMode wire + source seam + push | ✓ VERIFIED | See truth 7 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| twitch-chat.ts | main.ts chaosVote closure | TwitchChatDeps.chaosVote seam | ✓ WIRED | Dispatch at twitch-chat.ts L131-134 (before suggest/build/revert path, no intake.check); wired into deps at main.ts L1124 |
| auto-cycle.ts #onPhaseEnd | main.ts chaosModePick closure | AutoCycleDeps.chaosModePick after eligibility; #maybeBegin follow-up | ✓ WIRED | auto-cycle.ts L307-311; handed at main.ts L858; #maybeBegin only |
| main.ts chaosModePick | round.ts enqueueWinner | SAME winner funnel, then onWinnerQueued → drainVoteQueue | ✓ WIRED | main.ts L788-807; provenance-ACK comment present (INFO 1) |
| chaos/mode.ts | overlay server pushState | CHAOS_MODE_CHANGED through OverlayChaosModeSource | ✓ WIRED | mode.ts L136 emit → main.ts L1666-1668 seam → server.ts L543 pushState |

### Spot-Check: The Three Auto-Fixed Deviations

| # | Deviation | Verdict |
| - | --------- | ------- |
| 1 | Scheduler-stall poke: `controlWindow.on(WINDOW_CLOSED\|WINDOW_REVOKED, () => autoCycle.start())` (main.ts L887-888) | ✓ SOUND — `start()` is exactly `#maybeBegin("fresh")`, which opens with the same "already in a phase" guard (L205) plus the FULL eligibility re-check, i.e. the same #maybeBegin-class idempotency that absorbs the re-entrancy; a double-begin is structurally impossible. Composition-root only; control-window.ts untouched; root cause logged in deferred-items.md |
| 2 | Controller construction order (before the HALT_TRIGGERED handler, main.ts L387-437) | ✓ SOUND — fixes a real TDZ on the boot-restore force-HALT path; narration/audit callbacks close over the late-bound `windowNarrator` let, so early construction changes no behavior; chaosVote/chaosModePick closures remain in the plan-specified position (L747+) |
| 3 | recovery.e2e fake Narrator widening | ✓ SOUND — diff is exactly five no-op method additions (type-completeness after the Narrator interface widened); no assertion touched |

### Untouched-File Contract

`git diff --stat 7cbbca3..HEAD -- src/state-machine/halt.ts src/chaos/selector.ts src/pipeline/chaos.ts` → **empty** (byte-identical to pre-task state). `tests/invariants/` also zero-diff (no allowlist edits).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Chaos units + auto-cycle (incl. re-entrancy pin) + ALL invariants + chaos e2e | `npx vitest run src/chaos/mode.test.ts src/state-machine/auto-cycle.test.ts tests/invariants/ tests/e2e/chaos-vote-skip.e2e.test.ts` | 9 files, **105/105 passed** | ✓ PASS |
| Full suite | previously re-run post-merge by orchestrator | 1035/1035 | ✓ PASS (per task briefing) |

### Anti-Patterns Found

None. Added lines across the whole task diff (21 files, +1754) contain no TBD/FIXME/XXX/HACK/PLACEHOLDER markers and no stub language. No empty implementations; every seam is consumed end-to-end.

### Human Verification Required

#### 1. Overlay badge visual pass (OPTIONAL — plan Task 3 human-check, batched to end-of-phase per standing directive)

**Test:** `npx tsx scripts/overlay-harness.ts`
**Expected:** Badge priority FREE REIGN > CHAOS MODE > DEMOCRATIC; slate-50 white dot (never violet/red); ticking m:ss countdown; silent collapse to DEMOCRATIC on expiry.
**Why human:** Rendered appearance inside the OBS browser source is not grep-verifiable. All underlying logic (wire narrowing, branch priority, class hygiene, CSS values, 1s tick) is code- and test-verified.

### Gaps Summary

No gaps. All eight must-have truths verified against the live tree with direct code evidence and a green targeted test run (105/105, including every invariant suite). The re-entrancy fix is exactly the mandated #maybeBegin path with genuine synchronous-STATE_CHANGED pins at both unit and e2e level; the payment↔chance allowlist and source scan hold structurally; the three auto-fixed deviations are sound and weaken no invariant; halt.ts/selector.ts/pipeline chaos.ts are byte-identical to base. The single deferred-items.md entry (theoretical "empty"×early-close recursion) is correctly analyzed as unreachable today with a documented trigger condition and remedy.

---

_Verified: 2026-07-11T21:02:00Z_
_Verifier: Claude (gsd-verifier)_
