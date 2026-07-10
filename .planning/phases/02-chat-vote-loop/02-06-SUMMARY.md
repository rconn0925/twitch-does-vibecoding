---
phase: 02-chat-vote-loop
plan: 06
subsystem: testing
tags: [e2e, crash-recovery, eventsub-reconcile, operations-runbook, checkpoint]

# Dependency graph
requires:
  - phase: 02-chat-vote-loop
    plan: 04
    provides: chatSource/chatSink CreateAppOptions seams, startTwitchChat, narrator UI-SPEC copy, reconcile, intake limits
  - phase: 02-chat-vote-loop
    plan: 05
    provides: overlay server (AppHandle.overlay, full-state-on-connect ws), overlayPort=0 default in createApp
  - phase: 02-chat-vote-loop
    plan: 03
    provides: console round route, enqueueWinner funnel, restore-before-listen ordering
  - phase: 01-compliance-gate-kill-switch
    provides: createApp harness precedent (tests/e2e/console-flows.e2e.test.ts), /api/halt, /api/audit, CATEGORY_META
provides:
  - "tests/e2e/round-flow.e2e.test.ts: the phase's core loop as ONE executable spec — suggest → gate filter → round open → votes/revote → winner → queue via funnel → narration, over createApp with all seams faked (zero network)"
  - "tests/e2e/recovery.e2e.test.ts: failure modes as executable specs on file-backed SQLite — crash-restart mid-round, expired-during-downtime, halt-freeze across restart, disconnect/ready ledger reconciliation, INFRA-02 log-line contract"
  - "docs/OPERATIONS.md §6 Twitch chat integration: app registration, two-scope OAuth bootstrap via /auth/start, re-auth, rate budget doctrine, gap-loss limitation, crash-recovery behavior"
affects: [phase-05-dry-run]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Ordered-scenario e2e: one describe with sequential its sharing a single app — each phase-loop step is a named, individually-reported assertion block"
    - "Downtime simulation by direct SQLite mutation between createApp sessions (UPDATE rounds SET ends_at_ms) — no clock mocking, no src seams needed"
    - "Reconciliation proven by observable effect: mutate round_votes mid-gap, assert the /api/state tally re-syncs — never just 'the function was called'"

key-files:
  created:
    - tests/e2e/round-flow.e2e.test.ts
    - tests/e2e/recovery.e2e.test.ts
    - .planning/phases/02-chat-vote-loop/deferred-items.md
  modified:
    - docs/OPERATIONS.md

key-decisions:
  - "INFRA-02 log-line contract asserted at the startTwitchChat seam with an injected capturing logger (createApp's internal pino is not injectable); the SAME disconnect/ready cycle is separately proven through createApp by its observable effects (console pill + ledger re-sync)"
  - "The narrator's fixed 3s feedback-coalesce window is the test's only real wait — coalesceMs is not exposed through createApp and this plan is src-frozen, so the no-src-edits acceptance criterion outranked the ~2s timer guidance for that single wait"
  - "Pre-existing biome 2.5.3 lint failures (overlay.js useOptionalChain + CRLF checkout artifacts) logged to deferred-items.md, NOT fixed — scope boundary + machine-checked zero-src constraint"

# Metrics
duration: ~12min
completed: 2026-07-10
---

# Phase 2 Plan 06: End-to-End Proof, Failure-Mode Specs & Operator Runbook Summary

**The whole chat-vote loop is now one executable spec (suggest → filter → vote/revote → winner → funnel → narration, all seams faked) plus four failure-mode specs on file-backed SQLite proving no acknowledged vote survives-or-dies by luck — crash restore, expired-downtime close, halt-freeze remainder, and a real ledger-vs-memory reconcile — with the operator's Twitch setup/re-auth/rate-budget/gap-loss runbook appended to OPERATIONS.md; only the live-channel smoke test remains, returned as a deferrable human checkpoint.**

## What Was Built

### Task 1 — Full-loop e2e (`ab0ea80`)
`tests/e2e/round-flow.e2e.test.ts` (297 lines, 6 ordered tests, one shared app, `:memory:` db, ephemeral ports, zero network):

1. Three viewers `!suggest` distinct ideas through the REAL listener → intake → funnel → async classification → all three pooled (classifier called exactly 3 times)
2. A "banword" suggestion is rejected (category `harassment`) — the captured chat feedback contains the viewer-safe `CATEGORY_META` label ("Harassment") and **no sent message anywhere contains the suggestion text**; the same viewer's immediate retry dies at the synchronous intake cooldown and the classifier count stays at 4 (D2-11 pre-classification proof, T-01-11 closed and now regression-guarded)
3. `POST /api/round/start` → 200; the round-open narration matches the UI-SPEC template (`Voting is OPEN — !vote 1, 2 or 3: [1] … [2] … [3] … — 60s on the clock.`); drawn candidates leave the pool
4. Four voters incl. one revote (erin moves 1→2) and one invalid `!vote 9` (silently ignored) → tally `[1,2,0]`, totalVotes 3 — one vote per user with override applied
5. Overlay ws first message carries the full open-round state: pill `VOTING OPEN`, status open, exact tally (PRES-01 integration touch)
6. Force-close via `app.round.closeRound()` → winner (option 2, 2 votes) appears in the console `/api/state` queue **via the funnel**, both losers repooled, round null + mode IDLE, close narration byte-equals the winner template, and `round_opened`/`round_closed` audit rows each exist exactly once

### Task 2 — Failure-mode e2e + operator docs (`829e3a0`, `c9ed4c9`)
`tests/e2e/recovery.e2e.test.ts` (380 lines, 5 tests, file-backed SQLite in temp dirs — durability is the point):

- **Crash-restart mid-round:** life 1 opens a round and records 3 vote events (one revote → tally `[2,0]`); process closes WITHOUT closing the round; life 2 on the same db file restores the identical `roundId`, identical tally, and the identical persisted `endsAtMs` (still in the future); one more vote in life 2, then close → the winner is option 1 by 2–1, decided by life-1 votes — **no acknowledged vote silently lost** (success criterion 5, D2-14)
- **Expired-during-downtime:** the persisted deadline is pushed into the past between sessions; `restore()` closes the round before the console serves a single request and the winner still enqueues through `enqueueWinner`, with a `round_closed` audit row
- **Halt-freeze across restart:** `POST /api/halt` mid-round persists `frozen_remaining_ms` (asserted in the db, not just memory); the restart restores the round frozen with the **exact same** `remainingMs`, votes intact, mode IDLE — waiting for triage, never auto-resuming (D2-16 + D2-14)
- **Disconnect/reconcile:** socket disconnect flips the console pill; a vote row is injected directly into `round_votes` during the gap (memory provably stale at 1); socket ready triggers reconcile → divergence detected → tally re-syncs from the ledger to `[1,1]`; a fresh chat vote then lands normally (the reconciled round is live, not a zombie)
- **INFRA-02 log-line contract:** at the `startTwitchChat` seam with an injected capturing logger — `warn: "EventSub socket disconnected — twurple will auto-reconnect"`, `info: "EventSub socket (re)connected and ready"`, and `reconcile()` runs exactly once, on ready only

`docs/OPERATIONS.md` gained **§6 Twitch Chat Integration** (appended, existing sections untouched): app registration at dev.twitch.tv/console with the `http://localhost:4900/auth/callback` redirect and the three env vars; one-visit OAuth at `http://127.0.0.1:4900/auth/start` with exactly `user:read:chat` + `user:write:chat`; token persistence at `TWITCH_TOKEN_PATH` and the re-auth path for "Twitch login expired"; the ~15 msgs/30s budget under the "chat gets transitions, overlay gets state" doctrine; the honest T-02-24 limitation — votes typed during a genuine EventSub gap are unrecoverable by design (no replay exists), acknowledged votes never lost — plus the compromised-round manual remedy; and automatic mid-round crash recovery.

## Verification

- `npx vitest run tests/e2e/round-flow.e2e.test.ts` — 6/6
- `npx vitest run tests/e2e/recovery.e2e.test.ts` — 5/5 (reconcile divergence log observed: ledger `{1:1,2:1}` vs memory `{1:1,2:0}` → re-sync)
- `npm test` — **360/360 passing** (349 baseline preserved + 11 new); all three invariant scans green
- `npm run typecheck` clean
- `grep -c "auth/start" docs/OPERATIONS.md` → 2
- `git diff --name-only 0bf9008..HEAD -- src/` → **empty** (the plan's machine-checked zero-src constraint holds; the 02-04/02-05 seams were sufficient by contract)

## Deviations from Plan

### Minor implementation choices (within plan discretion)

- **Log-line capture at the listener seam, not through createApp:** createApp constructs its own pino internally (no logger seam exists, and this plan cannot add one). The plan offered "capturing logger or pino stream"; the exact wording contract is asserted by calling `startTwitchChat` directly with an injected capturing logger, while the identical disconnect/ready cycle is ALSO exercised through createApp and asserted by observable effects (console pill transitions + ledger re-sync).
- **One ~3s real wait for feedback narration:** the narrator's coalesce window is a fixed production constant (3000ms) not exposed through `CreateAppOptions`; the round-flow test waits once for the flush. The plan's "no real timers longer than ~2s" guidance yields to its harder acceptance criterion ("this plan touches no file under src/"). Round duration is never waited out — the close is forced via `closeRound()` as instructed.
- **Overlay ws asserted mid-round (between votes and close):** the plan lists the overlay check last, but `RoundManager` nulls its round after close, so a post-close first-message would carry `round: null` rather than "the open-or-closed round state". Connecting during the open round asserts the meaningful full-state payload.

### Out-of-scope discoveries (logged, not fixed)

- `npm run lint` fails at base on pre-existing files: two biome 2.5.3 `useOptionalChain` hits in `src/overlay/public/overlay.js` and recurring CRLF checkout artifacts on 5 files (content-identical, `git diff` empty). Logged to `.planning/phases/02-chat-vote-loop/deferred-items.md` per the scope boundary; this plan's verify gates (vitest, typecheck, grep) are all green.

## Pending Live Verification (Task 3 — deferred to checkpoint)

The plan's Task 3 — one-time live OAuth bootstrap and a real-channel smoke round — is a `checkpoint:human-verify` gate requiring the streamer's Twitch app credentials, a browser consent screen, and a second human typing in chat. **It has NOT been performed.** Everything automatable is automated and green under injected fakes that travel the identical createApp composition path production uses; the runbook for the human steps is OPERATIONS.md §6.1–6.2. Per the plan's resume-signal, the streamer may approve after running it, or explicitly defer to before the Phase 5 dry run (deferral to be recorded in STATE.md by the orchestrator).

## Known Stubs

None in this plan's artifacts. The only unproven surface is the live-Twitch leg itself (real EventSub socket, real Helix sends, real OAuth) — tracked above as the pending checkpoint, not a code stub.

## Threat Flags

None — no new code surface was created (tests + docs only). Plan threat register dispositions: **T-02-23 mitigated** (recovery.e2e.test.ts proves acknowledged votes survive restart and reconciliation re-syncs from the ledger; round_closed audit rows carry the final tally); **T-02-24 accepted and documented** (OPERATIONS.md §6.5 states the gap-loss limitation honestly with the manual re-run remedy); **T-02-25 mitigation shipped** (OPERATIONS.md §6.2 and the checkpoint steps both warn to log into the broadcaster account before `/auth/start`).

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| `ab0ea80` | test | full-loop e2e — suggest, filter, vote, winner, queue, narration over injected fakes |
| `829e3a0` | test | failure-mode e2e — crash restart, expired downtime, halt freeze, disconnect reconcile |
| `c9ed4c9` | docs | Twitch chat integration runbook + deferred lint items |

## Self-Check: PASSED

All 4 claimed files exist on disk; all 3 commits verified in git log; full suite 360/360 green at HEAD; `git diff --name-only` vs base contains zero `src/` paths.
