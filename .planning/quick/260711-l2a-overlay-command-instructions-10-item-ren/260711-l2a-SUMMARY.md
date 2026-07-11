---
phase: quick-260711-l2a
plan: 01
subsystem: ui
tags: [overlay, obs, auto-cycle, round, command-parser, vitest, tsx]

# Dependency graph
requires:
  - phase: quick-260710-t5k
    provides: AutoCycleScheduler cadence (#onPhaseEnd timer-expiry path, eligibility re-check, HALT parking)
  - phase: quick-260710-v4e
    provides: /queue what's-coming page + OverlayPoolSource seam + POOL_CHANGED push
provides:
  - 30s default voting round (ROUND_DURATION_SECONDS knob unchanged)
  - roundMaxOptions() draw-cap knob (ROUND_MAX_OPTIONS, default 5) replacing the hardcoded slice(0, 3)
  - "!vote 1-5 parsing (regex [1-5] + zod max(5); recordVote stays the live authoritative bound)"
  - pool-full early close of the suggest phase via AutoCycleScheduler #maybeEarlyClose -> #onPhaseEnd (EARLY_CLOSE_POOL_SIZE knob, default 5)
  - POOL_MAX_SIZE default 50 -> 5 (pool cap aligns with vote options per user amendment)
  - compressed voteHint ("type !vote 1-N" above 3 options) + vote-panel-compact CSS above 5 rows
  - /queue page shows up to 10 pool + 10 queued items legibly in a ~460x1080 full-height source
  - scripts/overlay-harness.ts dev visual harness (real startOverlayServer, fake max-state sources, --mode=vote|suggest on 127.0.0.1:4999)
affects: [overlay, auto-cycle, round, command-parser, stream-night-dry-run]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Early close funnels through #onPhaseEnd — never startRound directly (same-code-path rule; halt/eligibility re-checks apply unmodified)"
    - "Named knobs kept separate even when defaults align (POOL_MAX_SIZE / EARLY_CLOSE_POOL_SIZE / ROUND_MAX_OPTIONS all default 5)"
    - "Dev harness composes the REAL server with fake sources — no parallel render path to drift"

key-files:
  created:
    - scripts/overlay-harness.ts
  modified:
    - src/state-machine/round.ts
    - src/state-machine/round.test.ts
    - src/state-machine/auto-cycle.ts
    - src/state-machine/auto-cycle.test.ts
    - src/ingestion/command-parser.ts
    - src/ingestion/command-parser.test.ts
    - src/main.ts
    - src/overlay/public/overlay.js
    - src/overlay/public/overlay.css
    - src/overlay/public/queue.js
    - src/overlay/public/queue.css
    - .env.example

key-decisions:
  - "USER AMENDMENT 1 (mid-task): vote-option cap is 5, not 10 — ROUND_MAX_OPTIONS default 5; parser accepts !vote 1-5"
  - "USER AMENDMENT 2 (mid-task): suggestion-pool cap is 5, not 10 — POOL_MAX_SIZE default 50 -> 5; early-close threshold 5"
  - "Early-close threshold is its own named knob (EARLY_CLOSE_POOL_SIZE) so pool cap / early close / draw count can diverge later"
  - "Math.max(cap, 2) floor in #maybeEarlyClose prevents an earlyCloseSize=1 misconfig from looping early-close -> pool-too-small restart forever (D2-04 minimum)"
  - "vote-panel-compact CSS kept for >5 candidates as robustness for a raised ROUND_MAX_OPTIONS; /queue keeps 10-item rendering robust with honest +N-more past that"

patterns-established:
  - "Pool-full early close: POOL_CHANGED handler guarded by active-phase + size>=max(cap,2), then #clearTimer + #onPhaseEnd — the exact timer-expiry method"

requirements-completed: [QUICK-260711-L2A]

# Metrics
duration: 15min
completed: 2026-07-11
---

# Quick 260711-l2a: Overlay Command Instructions + Round-Flow Polish Summary

**30s default vote rounds drawing up to 5 options with !vote 1-5 parsing, pool-full (5) early close of the suggest phase through the exact timer-expiry path, compacted overlay//queue rendering for the max state, and a dev harness serving the real overlay pages with injected max-state fakes**

## Performance

- **Duration:** ~15 min (first commit 21:22Z, last 21:33Z)
- **Started:** 2026-07-11T21:19:00Z
- **Completed:** 2026-07-11T21:33:57Z
- **Tasks:** 3/3
- **Files modified:** 13 (12 modified + 1 created)

## Accomplishments

- Round cadence is now 40s suggest / 30s vote by default; rounds draw up to 5 candidates (ROUND_MAX_OPTIONS) instead of the hardcoded 3, and chat can `!vote 1`..`!vote 5`
- The suggest phase ends the MOMENT the pool hits EARLY_CLOSE_POOL_SIZE (5) — routed exclusively through `#onPhaseEnd`, so halt parking, queue-full/window/chaos/mode eligibility, and the pool-too-small restart are provably unchanged (6 new scheduler tests; no-pool back-compat proven by all pre-existing tests running without the dep)
- Overlay banners verified against the parser's real command set; vote hint compresses to "type !vote 1–N" above 3 options; /queue shows up to 10 pool + 10 queued items with nothing clipped in a ~460x1080 full-height source
- 870 tests green (baseline 845 + 25 new/updated), tsc + biome clean

## Task Commits

Each task was committed atomically (TDD tasks have test + feat commits):

1. **Task 1: 30s default, 5-option draw cap, !vote 1-5, env docs** — `e2ae713` (test, RED) + `339bfe4` (feat, GREEN)
2. **Task 2: Pool-full early close via #onPhaseEnd** — `6032ced` (test, RED) + `0b900aa` (feat, GREEN)
3. **Task 3: Overlay legibility, banner copy check, dev harness** — `6cb82fa` (feat)

## TDD Gate Compliance

Both TDD tasks followed RED → GREEN with verified failing runs first (Task 1: 13 failing; Task 2: 3 failing). No refactor commits needed.

## Files Created/Modified

- `src/state-machine/round.ts` — DEFAULT_ROUND_DURATION_SECONDS 60→30; new exported `roundMaxOptions()` (env ROUND_MAX_OPTIONS, integer-floored, default 5); draw uses it
- `src/ingestion/command-parser.ts` — vote regex `[1-3]`→`[1-5]`, zod `.max(5)`, comment explaining recordVote as the live bound (D2-15)
- `src/state-machine/auto-cycle.ts` — optional `pool` sliver + `earlyCloseSize` dep; `#maybeEarlyClose()` on POOL_CHANGED and at `#beginSuggestPhase` end; module doc updated with the early-close safety rule
- `src/main.ts` — DEFAULT_POOL_MAX_SIZE 50→5; DEFAULT_EARLY_CLOSE_POOL_SIZE 5; wires `pool.list().length` + EARLY_CLOSE_POOL_SIZE into the scheduler
- `src/overlay/public/overlay.js` — voteHint range form above 3; `vote-panel-compact` toggle above 5 candidates
- `src/overlay/public/overlay.css` — `.vote-panel-compact` overrides (rows gap 8, title 20px, badge 28px, track 8px) — nothing under 20px, no new colors, 440px width kept
- `src/overlay/public/queue.js` — POOL_SHOW/QUEUE_SHOW → 10 with honest "+N more" past that
- `src/overlay/public/queue.css` — page-compact paddings/line-heights (10+10 worst case ≈1056px); header comment documents the recommended ~460x1080 OBS source (was 440x420)
- `scripts/overlay-harness.ts` — NEW dev-only harness: real `startOverlayServer` on 127.0.0.1:4999, `--mode=vote` (5-option open round, unique leader, 30s left) / `--mode=suggest` (full pool of 5 incl. null-username case, 40s phase), 10 queued builds in both; all strings fixed harness-authored copy
- `.env.example` — ROUND_DURATION_SECONDS=30 (stale 40/20 comment rewritten), ROUND_MAX_OPTIONS=5, EARLY_CLOSE_POOL_SIZE=5, POOL_MAX_SIZE=5

## Banner Copy Verification (Task 3 part 1)

Checked `command-parser.ts` against every broadcast surface string: the parser's complete command set is `!suggest <text>` and `!vote <n>` — nothing else. The SUGGESTIONS OPEN hint ("type !suggest — new idea or a tweak to what's on screen") matches the free-text suggest contract; the VOTE NOW hint derives from the LIVE candidate count via `voteHint()` so it always matches what `recordVote` will accept. A repo-wide grep of `src/overlay/public/` found no other command references. No mismatches — nothing else changed.

## Decisions Made

- Early-close threshold implemented as its own env knob `EARLY_CLOSE_POOL_SIZE` (per amendment 1's "keep them as two named knobs"), defaulting equal to POOL_MAX_SIZE and ROUND_MAX_OPTIONS
- `#maybeEarlyClose` floors the trigger at `Math.max(cap, 2)` — an `earlyCloseSize=1` misconfig would otherwise loop early-close → pool-too-small restart → early-close forever
- `/queue` keeps 10-item rendering (robust for raised knobs) even though the default pool cap is now 5; acceptance target per amendment 2 is 5 pool items

## Deviations from Plan

### User-Directed Changes (authorized mid-execution)

**1. Vote-option cap 10 → 5 (user requirement change, relayed by orchestrator)**
- ROUND_MAX_OPTIONS default is 5 (plan said 10); parser accepts `!vote 1-5` (plan said 1-10); vote panel only needs 5 legible rows (compact CSS kept for >5 robustness); harness exercises 5 options
- Early-close threshold split into a SEPARATE knob from the draw cap (plan had them unified via `roundMaxOptions()`)

**2. Suggestion-pool cap → 5 (second user requirement change)**
- POOL_MAX_SIZE default 50 → 5 in main.ts and .env.example; EARLY_CLOSE_POOL_SIZE default 5 (the first amendment had it at 10)
- Pool cap / early-close / draw cap all default to 5 but remain three named knobs

### Auto-fixed Issues

**1. [Rule 1 - Bug] 30s-default ripple through timing-sensitive round tests**
- **Found during:** Task 1 (RED)
- **Issue:** ~10 existing tests encoded the 60s duration indirectly (freeze-at-21s remainder 40_000, resume deadlines 540_000/140_000, "ends at 61000" comments); plan only mentioned the default-duration expectations
- **Fix:** Updated all derived timing assertions to the 30s math (10_000 remainder, 510_000/110_000 deadlines); restore-test clock moved 30_000→15_000 so "still live" keeps real margin
- **Files modified:** src/state-machine/round.test.ts
- **Committed in:** e2ae713

**2. [Rule 1 - Bug] Draw-cap ripple in the initiator-audit test**
- **Found during:** Task 1 (GREEN)
- **Issue:** With the cap at 5, round 1 drains all 4 pooled candidates, leaving round 2 below the D2-04 minimum
- **Fix:** Repool a second candidate before the second round
- **Files modified:** src/state-machine/round.test.ts
- **Committed in:** 339bfe4

**3. [Rule 2 - Missing critical] Infinite-loop guard on a misconfigured early-close size**
- **Found during:** Task 2 (implementation review before GREEN)
- **Issue:** `EARLY_CLOSE_POOL_SIZE=1` + 1 pooled item would recurse forever: early close → startRound throws pool-too-small → restart phase → immediate early close → …
- **Fix:** `pool.size() < Math.max(cap, 2)` guard (D2-04 floor) breaks the cycle structurally
- **Files modified:** src/state-machine/auto-cycle.ts
- **Committed in:** 0b900aa

---

**Total deviations:** 2 user-directed requirement changes + 3 auto-fixed (2 bug ripples, 1 missing guard)
**Impact on plan:** Amendments narrowed the vote-panel scope (5 options instead of 10) and re-capped the pool; all auto-fixes were correctness-required. No scope creep.

## Issues Encountered

- Worktree had no `node_modules` — ran `npm install` before testing (expected per constraints)
- Harness smoke test initially hit EADDRINUSE on 4999 from the prior mode's server — killed the stale process; both modes then verified live via `/api/state` (vote: 5 candidates, tallies 4/7/12/2/0, VOTING OPEN; suggest: pool of 5 with one null username, suggestPhase set, STANDBY)

## Known Stubs

None — all new paths are wired end-to-end (early close to the real scheduler funnel, knobs to main.ts composition, harness to the real server). The harness's fake sources are deliberate dev fixtures, not production stubs.

## User Setup Required

Local `.env` (untracked, never committed) was updated in the main checkout per the plan: `ROUND_DURATION_SECONDS=30` and `POOL_MAX_SIZE=5` (both previously pinned at the old defaults and would have overridden the new ones). `ROUND_MAX_OPTIONS` / `EARLY_CLOSE_POOL_SIZE` are not pinned — code defaults (5/5) apply. Verified `.env` never appeared in `git status`.

## Human Visual Check (pending — Task 3 human-check)

Run and eyeball at 1920x1080:
1. `npx tsx scripts/overlay-harness.ts --mode=vote` → http://127.0.0.1:4999 — 5 vote rows legible lower-left, no banner collision, banner reads "VOTE NOW — type !vote 1–5"
2. `npx tsx scripts/overlay-harness.ts --mode=suggest` → banner reads "SUGGESTIONS OPEN — type !suggest …"; http://127.0.0.1:4999/queue (OBS source ~460x1080) — all 5 pool suggestions with usernames and all 10 queued builds visible, nothing cut off

## Next Phase Readiness

- Live cadence never idles on a full pool; all knobs documented in .env.example
- The Phase 5 dry run can use the harness for OBS scene sizing before going live

---
*Phase: quick-260711-l2a*
*Completed: 2026-07-11*

## Self-Check: PASSED

All 8 claimed files exist; all 5 task commits (e2ae713, 339bfe4, 6032ced, 0b900aa, 6cb82fa) present in git log; artifact patterns verified (POOL_CHANGED in auto-cycle.ts, ROUND_MAX_OPTIONS/roundMaxOptions in round.ts, voteHint in overlay.js); `.env` absent from git status. 870 tests / tsc / biome all green.
