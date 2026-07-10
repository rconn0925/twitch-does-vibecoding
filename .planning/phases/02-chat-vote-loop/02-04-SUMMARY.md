---
phase: 02-chat-vote-loop
plan: 04
subsystem: ingestion
tags: [twitch, eventsub, narration, oauth, intake-limits, tdd]

# Dependency graph
requires:
  - phase: 02-chat-vote-loop
    plan: 01
    provides: RoundManager (recordVote/restore/snapshot), ROUND_OPENED/ROUND_CLOSED events, recordPoolDropped, Phase 2 env vars
  - phase: 02-chat-vote-loop
    plan: 02
    provides: parseCommand, createChatSender/ChatMessageSink, createAuthProvider/buildAuthorizeUrl/completeAuthorization
  - phase: 02-chat-vote-loop
    plan: 03
    provides: enqueueWinner funnel, console round route, restore-before-listen ordering + the restored-round mode-gap flag
  - phase: 01-compliance-gate-kill-switch
    provides: submitCandidate (the ONLY intake path), normalize(), CATEGORY_META, CandidatePool, invariant scans
provides:
  - "startTwitchChat + ChatEventSource/ChatMessageEvent seam (src/ingestion/twitch-chat.ts): !suggest/!vote dispatch, zod EventSub boundary, disconnect/ready observability + reconcile hook"
  - "createSuggestIntake (src/ingestion/suggest-intake.ts): synchronous per-chatterId cooldown + max-1-pooled + normalize() dedup, BEFORE classification (closes T-01-11)"
  - "createNarrator (src/ingestion/narration.ts): UI-SPEC copy verbatim, 60-char titles, 3s feedback coalescing into ≤500-char @-runs, sole ChatSender consumer"
  - "CandidatePool({ maxSize, onEvict }): oldest-drop eviction with audit row (D2-13)"
  - "CreateAppOptions.chatSource/chatSink/twitchAuth seams — createApp composes the FULL chat pipeline whenever a source/sink pair exists (plan 02-06's e2e needs no src edits)"
  - "GET /auth/start + GET /auth/callback with single-use 10-min state nonce (T-02-16); ConsoleState.twitch + console pill/error copy"
  - "Restored-round vote acceptance: live restored rounds re-enter VOTING_ROUND (02-03 flag closed)"
affects: [02-05, 02-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injected event-source seam (hotkey.ts KeyEventSource pattern) applied to EventSub: twitch-chat.ts never imports twurple; main.ts entrypoint adapts EventSubWsListener behind ChatEventSource via dynamic import"
    - "ApiClient.chat passed STRUCTURALLY as ChatMessageSink — the sendChatMessage token appears only in chat-sender.ts, keeping the sole-caller scan green without an arrow adapter"
    - "classify-wrapper feedback hook (classifyThenPush pattern): COMP-03 chat feedback wraps the chat-path classify binding; funnel and gate untouched"
    - "Single-slot expiring state nonce for GET OAuth routes — the state parameter does for credential-writing GETs what the Origin check does for POSTs"
    - "reconcile = ledger-vs-memory tally compare + RoundManager.restore() re-sync on divergence (D2-14)"

key-files:
  created:
    - src/ingestion/suggest-intake.ts
    - src/ingestion/suggest-intake.test.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/ingestion/twitch-chat.ts
    - src/ingestion/twitch-chat.test.ts
    - src/queue/pool.test.ts
    - tests/e2e/oauth-routes.e2e.test.ts
    - tests/e2e/chat-wiring.e2e.test.ts
  modified:
    - src/queue/pool.ts
    - src/main.ts
    - src/operator-console/server.ts
    - src/operator-console/public/index.html
    - src/operator-console/public/console.js

key-decisions:
  - "Intake cooldown starts at registerAccepted (accepted submissions only) — a refused attempt never charges the user's cooldown"
  - "pending-exists maps to the cooldown notice in chat (plan-specified); duplicate gets its own line"
  - "Fail-closed rejections (classifier-unavailable) send the UI-SPEC error line instead of a fake category label — chat never sees internal codes"
  - "Discarded rounds (halt triage) narrate nothing: no UI-SPEC template exists and D-02 forbids chat noise while recovering"
  - "createNarrator gained an optional cooldownSeconds dep — the UI-SPEC cooldown template needs its {n}; wired from INTAKE_COOLDOWN_SECONDS"
  - "OAuth nonce slot is closure-scoped per server instance (not literally module-scoped): identical single-slot semantics, no cross-instance clobbering under parallel test servers"
  - "Twitch pill reuses existing status-pill classes (green/amber/red) — console.css untouched, matching the plan's file list"

# Metrics
duration: ~19min
completed: 2026-07-10
---

# Phase 2 Plan 04: Chat Ingestion, Narration & OAuth Bootstrap Summary

**A viewer's `!suggest` now flows chat → zod boundary → synchronous per-user intake limits → the unmodified Phase 1 funnel with category-label-only feedback, `!vote` lands in the round ledger keyed by chatterId, the bot narrates rounds in exact UI-SPEC copy through the single budgeted sender, and the one-time OAuth bootstrap runs on the console with a single-use state nonce — all composed inside createApp so fakes and production share one code path.**

## What Was Built

### Task 1 — Bounded pool + pre-classification intake (TDD: `64d25b5` RED → `a6b344f` GREEN)
- `CandidatePool` constructor accepts `{ maxSize, onEvict }`: past the bound the OLDEST entry (Map insertion order) drops with exactly one `onEvict` callback; zero-arg construction unchanged (all Phase 1 call sites unaffected)
- `createSuggestIntake`: `check(chatterId, rawText)` runs (1) cooldown — `now() - lastSuggestAtMs < cooldownMs`; (2) max-1-pooled — registered candidate ids still present in `pool.list()` block, ids that left the pool free the slot automatically; (3) exact-duplicate — `normalize()` (imported from prefilter.ts, never copied) equality against every pooled text, covering zero-width and hyphen-disguised variants
- Everything keyed by chatterId; verdicts are synchronous plain objects — no Promise, no classifier import (verified by grep: `classify` count 0)

### Task 2 — EventSub listener + narration (TDD: `b225249` RED → `210e76a` GREEN)
- `narration.ts`: UI-SPEC templates verbatim — round open (`Voting is OPEN — !vote 1, 2 or 3: …s on the clock.`, "1 or 2" for two candidates), winner, `Dead heat! Coin flip says…`, zero-votes run-it-back; five feedback variants (rejected/trim/held/duplicate/cooldown); 60-char title truncation; trailing 3s coalesce window packs feedback into ≤500-char messages with overflow rolling into a second send; every send via `ChatSender.send` (`sendChatMessage` grep = 0); the Narrator interface structurally has no tally input
- `twitch-chat.ts`: injected `ChatEventSource` (KeyEventSource pattern, zero twurple imports); broadcaster id passed as BOTH `onChannelChatMessage` args (Pitfall 4); zod `safeParse` on every event before field use; whole handler try/caught — malformed payloads and downstream throws are logged, never fatal; `!vote` → `recordVote(chatterId, option)` return-ignored (D2-15); disconnect/ready logged with RESEARCH.md wording and `reconcile()` on ready

### Task 3 — OAuth routes + console Twitch indicator (`7ec41e8`)
- `GET /auth/start`: crypto-random 32-byte hex nonce in a single-slot with 10-minute expiry, 302 to `twitchAuth.authorizeUrl(nonce)`; 503 with the exact config-hint copy when unconfigured
- `GET /auth/callback`: zod-validated query; 403 unless state matches the stored unexpired nonce; nonce burned before the exchange (single use — replay and stale-nonce both proven 403 by tests); terse 400 on exchange failure; static success HTML
- `ConsoleState.twitch` (`connected`/`disconnected`/`unauthorized`) + console pill (green/amber/red via existing status-pill classes) + both UI-SPEC error blocks ("Twitch connection lost" / "Twitch login expired") rendered textContent-only
- 10 route tests against a real server with an injected fake `twitchAuth` — zero network

### Task 4 — createApp composition + entrypoint adapters (`b780922`)
- `CreateAppOptions` gains `chatSource`/`chatSink`/`twitchAuth`; when a source/sink pair exists createApp constructs sender (env budget) → narrator (`cooldownSeconds` from env) → `ROUND_OPENED`/`ROUND_CLOSED` narrator subscriptions → `startTwitchChat` → connection-status handlers, and `close()` stops the listener
- `classifyThenNotify` (COMP-03): rejected → `CATEGORY_META` label only ("trim" for feasibility), held → held notice, fail-closed → UI-SPEC error line, approved → silence; rationale and suggestion text never reach the narrator
- `reconcile`: reads the open `rounds` row and `round_votes` GROUP BY tally, compares per-option against `round.snapshot()`, logs divergence and re-syncs via `RoundManager.restore()` — no log-only stub
- Bounded pool + intake wired unconditionally: `POOL_MAX_SIZE` (default 50) with `recordPoolDropped` audit rows; `INTAKE_COOLDOWN_SECONDS` (default 60)
- isMain branch: `buildTwitchAdapters()` does guarded dynamic imports of twitch-auth/`@twurple/api`/`@twurple/eventsub-ws`, degrades loudly at each missing prerequisite (no client id/secret → no Twitch; no token → `twitchAuth` only, "authorize at /auth/start"; no broadcaster id → `twitchAuth` only), passes `ApiClient.chat` structurally as the sink; NO composition logic lives there
- `npm run dev` without Twitch env verified: starts degraded, console up, "TWITCH DISABLED" logged, nothing crashes

## Verification

- `npm test`: **335/335 passing** (280 baseline preserved + 55 new: 11 pool/intake, 29 listener/narration, 10 OAuth routes, 5 chat-wiring/restore e2e); both invariant scans (single-funnel, chat-sender sole-caller) green
- `npm run typecheck` and `npm run lint` clean
- `grep -c "chatSink" src/main.ts` → 8; `grep -cE "import .*@twurple" src/ingestion/twitch-chat.ts` → 0; no static `@twurple` import anywhere under src/ except twitch-auth.ts (02-02 scope)
- isMain block contains no `createNarrator`/`startTwitchChat` call (grep 0)
- `grep -c "innerHTML" src/operator-console/public/console.js` → 0; "Voting is OPEN" and "Dead heat! Coin flip says" each exactly 1 in narration.ts
- Zero network under vitest: source/sink/twitchAuth/classifier all injected seams

## TDD Gate Compliance

Tasks 1 and 2 followed RED→GREEN: `test(02-04)` commits `64d25b5` and `b225249` precede `feat(02-04)` commits `a6b344f` and `210e76a`; both RED runs were observed failing (bounded-pool assertions failing, intake/narration/listener modules absent) before implementation. Tasks 3/4 are route/wiring tasks (not `tdd="true"`) and shipped with their own route and e2e tests in the same commits.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Restored-round votes were refused (02-03 SUMMARY flag)**
- **Found during:** Task 4 (flag carried in from plan 02-03's "Notes for Downstream Plans")
- **Issue:** `RoundManager.restore()` rebuilds a live round but the fresh `StreamModeMachine` stays IDLE; `recordVote()` requires `VOTING_ROUND`, so every chat vote on a restored round was silently refused — the restored round was visible but dead
- **Fix:** In createApp, immediately after `restore()`: if the restored round is open, non-frozen, and the machine is IDLE, `machine.transition("VOTING_ROUND")` (the machine's existing API — round.ts/stream-mode.ts untouched). Frozen restored rounds stay put for recovery triage
- **Files modified:** src/main.ts; proven by tests/e2e/chat-wiring.e2e.test.ts ("after a crash-restart mid-round, chat votes on the restored round are accepted": session-2 mode is VOTING_ROUND and a new chat vote raises the tally to 2)
- **Commit:** `b780922`

**2. [Rule 3 - Blocking] CRLF worktree checkout artifacts (recurring from waves 1–3)**
- **Found during:** Task 1 verification (`npm run lint` format failures on files this plan never touched)
- **Issue:** Worktree creation left CRLF endings on 5 pre-existing files (audit/db.ts, compliance/categories.ts + 2 fixtures, state-machine/stream-mode.ts); committed blobs are LF
- **Fix:** Normalized working-tree endings only; `git diff` empty — zero content change, nothing committed
- **Commit:** none (no index change)

### Minor implementation choices (within plan discretion)

- `createNarrator` gained optional `cooldownSeconds` (the UI-SPEC cooldown template's `{n}`; plan's dep list omitted it) — wired from `INTAKE_COOLDOWN_SECONDS`
- OAuth nonce slot is closure-scoped per server instance rather than literally module-scoped: same single-slot/single-use semantics, avoids cross-instance clobbering when tests run several console servers in one process
- Fail-closed rejections (`classifier-unavailable`) map to the UI-SPEC error line, not a `rejected` template with a bogus label
- `roundClosed` on a discarded round says nothing (no UI-SPEC template; D-02 no-noise-while-recovering)
- Extra `docs(02-04)` commit (`5fc80fd`) documents on the console seam that `complete()` is `completeAuthorization` pre-bound in main.ts — keeps the plan's key-link greppable from server.ts

## Known Stubs

None. The chat pipeline is live end-to-end under injected fakes (suggest → gate → pool → round → vote → narration), and the production path differs only in adapter construction. The public overlay (PRES-01) is plan 02-05's scope; the live-channel proof is plan 02-06's checkpoint.

## Threat Flags

None — all new security-relevant surface was registered in the plan's threat model and each `mitigate` disposition is implemented and test-proven: T-02-13 (intake keyed by chatterId only), T-02-14 (synchronous limits before any Sonnet call + bounded pool with audited eviction), T-02-15 (zod safeParse + try/catch listener survival, fuzz-tested), T-02-16 (single-use expiring state nonce, replay/stale/missing all 403), T-02-17 (fixed templates; labels only — rationale and rejected text never sent to chat).

## User Setup Required (carried forward from 02-02)

Before plan 02-06's live checkpoint: register a Twitch app (dev.twitch.tv/console, OAuth redirect `http://localhost:4900/auth/callback`), set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_USER_ID`, then visit `http://127.0.0.1:4900/auth/start` once while the app is running. Without these the app runs degraded (console + overlay up, chat off, unauthorized pill shown).

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| `64d25b5` | test (RED) | failing bounded-pool + intake tests |
| `a6b344f` | feat (GREEN) | bounded pool + pre-classification suggest intake |
| `b225249` | test (RED) | failing listener + narration tests |
| `210e76a` | feat (GREEN) | EventSub chat listener + game-show narration |
| `7ec41e8` | feat | OAuth bootstrap routes + console Twitch indicator |
| `b780922` | feat | createApp chat composition, COMP-03 hook, reconcile, restored-round fix, isMain adapters |
| `5fc80fd` | docs | completeAuthorization binding note on the console seam |

## Self-Check: PASSED

All 15 claimed files exist on disk; all 7 commits verified in git log; full suite 335/335 green at HEAD; working tree clean apart from wave-recurring CRLF checkout artifacts with zero content diff.
