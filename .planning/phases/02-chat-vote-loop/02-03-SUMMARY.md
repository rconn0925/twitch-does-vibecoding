---
phase: 02-chat-vote-loop
plan: 03
subsystem: pipeline
tags: [typescript, single-funnel, voting-rounds, operator-console, crash-restore, tdd]

# Dependency graph
requires:
  - phase: 02-chat-vote-loop
    plan: 01
    provides: RoundManager (startRound/recordVote/closeRound/restore, three-arg enqueueWinner callback with persisted pooled_at_ms), RoundStartError, RoundSnapshot, ROUND_OPENED/ROUND_CLOSED/VOTE_RECORDED
  - phase: 01-compliance-gate-kill-switch
    provides: toQueuedTask (sole brand constructor), TaskQueue, submitCandidate, CandidatePool.ApprovedCandidate, single-funnel invariant suite, console server + CSRF middleware
provides:
  - "src/pipeline/round.ts enqueueWinner — the ONE new sanctioned funnel entry: toQueuedTask + enqueue for round winners, with the D2-05 staleness branch (stale approvals re-enter submitCandidate)"
  - "single-funnel check (d) allowlist extended to exactly gate.ts + submit.ts + round.ts, in the same commit as round.ts"
  - "POST /api/round/start (CSRF-covered, strict empty-body zod, RoundStartError -> terse 409 with reason)"
  - "ConsoleState.round: RoundSnapshot | null in GET /api/state and every ws push"
  - "console round panel: Start Round accent button, UI-SPEC disabled reasons/empty states verbatim, client-side 1s countdown from endsAtMs, HALTED freeze line"
  - "main.ts: RoundManager constructed + restore() BEFORE startConsoleServer; AppHandle.round exported for 02-04/02-05/e2e"
affects: [02-04, 02-05, 02-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Funnel-entry module split by trust state: submit.ts = NEW unclassified candidates, round.ts = ALREADY-approved pool promotions — invariant allowlist enumerates both by exact filename"
    - "Staleness input flows persisted-value-only: round_candidates.pooled_at_ms -> RoundManager callback arg -> ApprovedCandidate.addedAtMs -> Date.now() comparison in enqueueWinner"
    - "Client-side countdown from server endsAtMs, resynced on every ws push — the server never streams timer frames"
    - "Console round pushes stay synchronous per-event (operator frequency); the 300ms debounce is the overlay's concern (02-05)"

key-files:
  created:
    - src/pipeline/round.ts
    - src/pipeline/round.test.ts
  modified:
    - tests/invariants/single-funnel.test.ts
    - src/operator-console/server.ts
    - src/operator-console/public/index.html
    - src/operator-console/public/console.css
    - src/operator-console/public/console.js
    - src/main.ts
    - tests/e2e/console-flows.e2e.test.ts
    - src/ingestion/command-parser.test.ts

key-decisions:
  - "Executed Task 3 (main.ts wiring) before Task 2: ConsoleServerDeps.round is a required dep, so server.ts and main.ts must change in compile-compatible order — every commit stays typecheck-green"
  - "409 failures on Start Round render the server's terse RoundStartError message rather than duplicating UI-SPEC strings (keeps the exact-copy greps at exactly 1 occurrence each)"
  - "winnerStalenessMs() kept module-private — enqueueWinner is the file's single exported function per the plan"

# Metrics
duration: ~25min active (split across a session-limit continuation)
completed: 2026-07-09
---

# Phase 2 Plan 03: Winner Funnel + Console Round Control Summary

**Round winners now reach the build queue exclusively through src/pipeline/round.ts's enqueueWinner (invariant-sanctioned in the same commit), and the streamer can start, watch, and freeze-triage rounds from the console with exact UI-SPEC copy and restore-before-listen crash recovery.**

## What Was Built

### Task 1 — enqueueWinner funnel entry (TDD: `117d9e3` RED → `d274286` GREEN)
- `src/pipeline/round.ts`: single exported function `enqueueWinner(deps, approved)` — (1) HALTED → refuse `{ queued: false, reason: "halted" }` (belt-and-suspenders; RoundManager never closes while HALTED but the funnel is independently safe); (2) `Date.now() - approved.addedAtMs > staleAfterMs` (default from `WINNER_STALENESS_MINUTES`, 360) → `deps.resubmit(candidate)` for full re-classification, `{ queued: false, reason: "stale-reclassified" }` (D2-05); (3) otherwise `toQueuedTask(candidate, ORIGINAL stored result)` + `taskQueue.enqueue` → `{ queued: true }`
- Zero `as QueuedTask` casts; no synthetic approved literal; queued text is the pooled candidate's text byte-identical (unit-tested with unicode-heavy input)
- `tests/invariants/single-funnel.test.ts` check (d) allowlist extended to exactly `{gate.ts, submit.ts, round.ts}` **in the same commit** — extended by filename, never weakened; checks (a)/(b)/(c)/(e) untouched

### Task 3 — main.ts wiring (`a583b2b`, executed before Task 2 — see Deviations)
- RoundManager constructed after pool/taskQueue with the injected wrapper `(candidate, result, pooledAtMs) => enqueueWinner({...}, { candidate, result, addedAtMs: pooledAtMs })` — the persisted `round_candidates.pooled_at_ms` becomes the staleness input, making D2-05 live in production
- `resubmit` closes over the same `gateDeps` classify the dev-submit path uses — stale winners re-run the full gate
- `round.restore()` runs immediately after construction and **before** `startConsoleServer` (D2-14 ordering)
- `AppHandle.round` exported (plans 02-04/02-05 and the e2e suite consume it)
- Teardown: RoundManager exposes no stop()/dispose(); its close timer is unref'd (02-01 requirement), so `close()` needs no change — noted per plan instruction

### Task 2 — console round control (`5b409ec`)
- `POST /api/round/start`: strict `z.object({}).strict()` body, `deps.round.startRound()` in try/catch, `RoundStartError` → 409 `{ error, reason: "not-idle" | "pool-too-small" }`, never a stack trace; inherits the uniform Origin+Content-Type CSRF middleware (registered on the same app)
- `ConsoleState.round: RoundSnapshot | null` in `buildState()`; `pushState()` subscribed to ROUND_OPENED/ROUND_CLOSED/VOTE_RECORDED (synchronous per-event — operator frequency, not overlay frequency)
- Round panel (textContent-only via `el()`, zero innerHTML): UI-SPEC copy verbatim — "No round running" / "Candidate pool is empty" empty states, all three disabled reasons ("Need at least 2 approved candidates…", "Round in progress — {m:ss} left.", "Rounds can only start from Standby…"), "Round open — {m:ss} left" heading with numbered candidates + live counts
- Countdown computed client-side from `endsAtMs` on a 1s `setInterval`, resynced on every ws push; `tabular-nums` so digits don't jitter
- HALTED triage renders the D2-16 freeze line from `round.remainingMs`/`round.totalVotes`
- Start Round is the one new accent control (44px min target, single click, no modal)

### Extra — round crash-restore e2e (`97d8b10`, authorized by Task 3's acceptance criteria)
- `tests/e2e/console-flows.e2e.test.ts`: file-backed db, open round + one vote, close app, reopen — the first `GET /api/state` already shows the open round with the correct tally and live remaining time

## Verification

- `npm test`: **280/280 passing** (274 baseline + 5 enqueueWinner units + 1 restore e2e); single-funnel suite green WITH round.ts in the tree
- `npm run typecheck` and `npm run lint` clean at every commit
- `grep -c "as QueuedTask" src/pipeline/round.ts` → 0; `grep -c "src/pipeline/round.ts" tests/invariants/single-funnel.test.ts` → 1
- `grep -c "innerHTML" src/operator-console/public/console.js` → 0; "Need at least 2 approved candidates" and "Round frozen at" each appear exactly once
- `grep -n "restore()" src/main.ts` → line 157, before `startConsoleServer(`; `grep -c "addedAtMs: pooledAtMs" src/main.ts` → 1

## TDD Gate Compliance

Task 1 followed RED→GREEN: `test(02-03)` commit `117d9e3` precedes `feat(02-03)` commit `d274286`; the RED run was observed failing (module absent) before implementation. Tasks 2/3 are wiring/UI tasks (not `tdd="true"`) and are covered by the full suite + the restore e2e.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 3 executed before Task 2 (compile-order dependency)**
- **Found during:** Task 2 planning
- **Issue:** Task 2 adds `round: RoundManager` as a REQUIRED `ConsoleServerDeps` field, which breaks `main.ts` compilation until Task 3's wiring exists — but every commit must be typecheck-green
- **Fix:** Committed Task 3's main.ts wiring first (compiles standalone; console not yet consuming `round`), then Task 2's server/UI changes plus the one-line `round` pass-through in main.ts
- **Files modified:** src/main.ts (split across `a583b2b` and `5b409ec`)
- **Commits:** `a583b2b`, `5b409ec`

**2. [Rule 3 - Blocking] Pre-existing biome `useTemplate` error blocked the lint gate**
- **Found during:** Task 2 verification
- **Issue:** `src/ingestion/command-parser.test.ts:78` (wave-1 code) used string concatenation in a fuzz fixture; `npm run lint` exits 1 (earlier verify runs had masked lint's exit code behind a pipe)
- **Fix:** Converted to a template literal — byte-identical test input
- **Files modified:** src/ingestion/command-parser.test.ts
- **Commit:** `d782dd9`

**3. [Rule 3 - Blocking] CRLF worktree checkout artifacts (recurring from waves 1/2)**
- **Found during:** Task 1 verification
- **Issue:** Working-tree copies of 5 pre-existing files (audit/db.ts, compliance/categories.ts + fixtures, state-machine/stream-mode.ts) had CRLF endings from worktree creation, failing biome's format check
- **Fix:** Normalized working-tree endings; committed blobs were already LF, so no content change was committed
- **Commit:** none (no index change)

## Known Stubs

None. The round panel renders live data end-to-end (pool → Start Round → countdown → close → winner in the console queue list). `/api/dev/submit` remains the interim suggestion source by design until plan 02-04 wires chat ingestion.

## Notes for Downstream Plans

- **Mode after crash restore (flag for 02-04/02-06):** `RoundManager.restore()` rebuilds the round but does NOT transition the fresh `StreamModeMachine` out of IDLE. The console displays the restored round correctly and the timer/close path works (closeRound tolerates IDLE), but `recordVote()` requires mode === VOTING_ROUND — chat votes on a restored round will be refused until mode restoration is wired. 02-04 (vote ingestion) or 02-06 (recovery e2e) should decide where the machine-mode restore belongs; changing 02-01's module was out of this plan's scope.
- RoundManager has no `stop()`/`dispose()`; its close timer is unref'd, so process shutdown is clean without teardown changes.

## Threat Flags

None — all new surface is registered in the plan's threat model and mitigated as specified: T-02-09 (allowlist-by-name in the same commit, byte-identical winner text), T-02-10 (persisted pooled_at_ms staleness input), T-02-11 (inherited CSRF + strict empty body + terse 409), T-02-12 (IDLE-guarded startRound on the localhost-only console).

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| `117d9e3` | test (RED) | failing enqueueWinner funnel tests |
| `d274286` | feat (GREEN) | enqueueWinner + single-funnel allowlist extension (same commit) |
| `a583b2b` | feat | RoundManager wired into createApp, restore-before-listen, AppHandle.round |
| `5b409ec` | feat | console Start Round route + round panel + HALTED freeze line |
| `d782dd9` | style | pre-existing useTemplate lint fix in parser fuzz fixture |
| `97d8b10` | test | e2e round crash-restore (D2-14) |

## Self-Check: PASSED

All 10 claimed files exist on disk; all 6 commits verified in git log; working tree clean apart from this SUMMARY; full suite 280/280 green at HEAD.
