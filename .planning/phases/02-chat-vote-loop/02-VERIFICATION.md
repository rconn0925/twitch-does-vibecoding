---
phase: 02-chat-vote-loop
verified: 2026-07-09T21:10:00Z
status: human_needed
score: 33/33 automated must-haves verified
overrides_applied: 0
deferred:
  - truth: "CHAT-05 clauses 'build progress' and 'build failures' narrated in chat"
    addressed_in: "Phase 3"
    evidence: "Phase 3 goal: 'The winning suggestion gets researched, planned, and built by the agent pipeline inside an isolated sandbox — and viewers watch the whole process live'. No builds exist before Phase 3; the Narrator seam (src/ingestion/narration.ts) is the extension point."
  - truth: "INFRA-01 clause 'channel points' over EventSub"
    addressed_in: "Phase 4"
    evidence: "Phase 4 goal: 'Money buys guaranteed, time-boxed control…'; docs/OPERATIONS.md §6.2 states verbatim 'channel-points scopes come later, in Phase 4'."
human_verification:
  - test: "Live Twitch smoke test (plan 02-06 Task 3 checkpoint, explicitly deferred at execution): follow docs/OPERATIONS.md §6.1–6.2 (register app, fill .env, npm run dev, /auth/start, restart), then run PLAN 02-06 Task 3 steps 4–8 on the real channel — !suggest from a second account, cooldown @-reply, Start Round, !vote 1 then !vote 2 revote, round expiry, winner narration + task in queue; optionally kill networking ~30s mid-round and confirm disconnect/(re)connect log lines and a correct round"
    expected: "OAuth token persists across a restart; the full suggest→filter→vote→winner→queue loop runs on the real channel with narration inside the rate budget; the tally shows exactly one vote that moved on the revote"
    why_human: "The entire automated proof runs against injected twurple fakes (by design — zero network in vitest). Only a human with the broadcaster account can prove the real EventSub subscription, Helix sendChatMessage, scope grants, and token refresh work against live Twitch."
  - test: "OBS browser-source check of the overlay: add http://127.0.0.1:4901 as a 1920x1080 browser source, run a round, watch the tally bars/countdown, switch scenes away and back mid-round"
    expected: "Vote panel, leader highlight, m:ss countdown, queue strip, and state pill render per 02-UI-SPEC.md; a scene switch reloads the page and the overlay reconstructs full state from the first ws message; a halt shows an amber ON HOLD pill (never the word HALTED, never red, no error text ever)"
    why_human: "Layout, motion, and OBS-CEF reload behavior are visual; grep proves the code paths (full-state-on-connect, pill mapping, reconnect backoff) but not what renders on stream."
  - test: "Phase 1 carried HUMAN-UAT items (01-HUMAN-UAT.md, still pending): physical panic-hotkey focus-independence test, live Sonnet gate:eval with ANTHROPIC_API_KEY, browser console run-through"
    expected: "As specified in .planning/phases/01-compliance-gate-kill-switch/01-HUMAN-UAT.md"
    why_human: "Carried forward from Phase 1 verification — OS-level hotkey hook, metered live-model evaluation, and visual console fidelity are not automatable."
---

# Phase 2: Chat Vote Loop — Verification Report

**Phase Goal:** Chat can suggest, vote in timed rounds, and see the winner queued — live on the overlay, with every suggestion routing through the Phase 1 gate
**Mode:** mvp — ROADMAP goal is not in User Story format (`gsd-sdk query user-story.validate` → false). Following the Phase 1 verifier precedent, the goal was reframed as a user story and validated (→ true): «As a Twitch viewer, I want to suggest ideas with !suggest and vote in timed rounds with !vote and see the winning idea announced and queued live on the overlay, so that chat genuinely controls what gets built without any suggestion bypassing the compliance gate.» Recommend running `/gsd mvp-phase` for future phases so the roadmap carries proper User Story goals.
**Verified:** 2026-07-09
**Status:** human_needed (all automated must-haves verified; live-Twitch, OBS-visual, and carried Phase 1 items require a human)
**Re-verification:** No — initial verification

## User Flow Coverage (MVP mode)

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Viewer types `!suggest <idea>` | Idea enters the pool or viewer gets category-level @-reply | src/ingestion/twitch-chat.ts:88-131 (zod-validated dispatch → intake → submitCandidate, the unmodified Phase 1 funnel); src/main.ts:307-330 classifyThenNotify → CATEGORY_META label only; e2e round-flow tests (1)-(3) | ✓ |
| Spam/duplicate suggestion | Quiet coalesced notice, zero classifier calls | src/ingestion/suggest-intake.ts (sync cooldown/max-1-pooled/duplicate checks BEFORE classification, closes T-01-11); e2e test (2)+(3) asserts no second classifier call | ✓ |
| Streamer clicks Start Round | Timed round opens over ≤3 pool candidates | src/operator-console/server.ts POST /api/round/start → RoundManager.startRound (round.ts:211-306); e2e test (4) | ✓ |
| Chat votes `!vote 1/2/3`, revote overrides | One vote per viewer keyed by numeric chatterId; revote overwrites | round.ts:183-189 native upsert `ON CONFLICT(round_id, twitch_user_id) DO UPDATE`; recordVote write-through-first (round.ts:316-348); e2e test (5) | ✓ |
| Tally + timer live on overlay | OBS browser source shows debounced tally + client-side countdown | src/overlay/server.ts (read-only, full-state-on-connect, 300ms VOTE_RECORDED debounce); overlay.js tally bars + 1s countdown tick + reconnect backoff; e2e test (8) | ✓ (render fidelity → human item 2) |
| Round closes → winner announced + queued | Winner narrated in chat, lands in build queue via the gate | narration.ts roundClosed (WR-02 honest disposition); src/pipeline/round.ts enqueueWinner (sole new funnel entry, allowlisted in single-funnel invariant at line 185); e2e test (6)+(7) | ✓ |
| Connection dies mid-round | Resubscribe, reconcile, no acknowledged vote lost | main.ts:335-379 reconcile (ledger-vs-memory diff → restore); twitch-chat.ts onUserSocketReady → reconcile; recovery e2e (4 failure-mode specs on file-backed SQLite) | ✓ |
| Outcome: chat controls what gets built, gate never bypassed | Every path to the queue passes the gate | Single-funnel invariant suite green with round.ts allowlisted same-commit; enqueueWinner refuses while HALTED and re-classifies stale approvals (D2-05) | ✓ (live-channel proof → human item 1) |

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `!suggest <idea>` → pool or category-level rejection feedback in chat | ✓ VERIFIED | twitch-chat.ts dispatch → suggest-intake → submitCandidate; classifyThenNotify sends viewer-safe CATEGORY_META label only (never suggestion text/rationale, T-02-17); fail-closed outage line throttled 1/30s (WR-03); e2e round-flow (1)-(3) pass in my own run |
| 2 | `!vote 1/2/3` timed rounds, one vote/viewer, revote overrides, tally+timer on overlay | ✓ VERIFIED | SQLite upsert keyed (round_id, twitch_user_id); write-through before ack (D2-14); 60s default timer (ROUND_DURATION_SECONDS); overlay ws full-state + 300ms debounce + client countdown; e2e (5)+(8) |
| 3 | Winner announced in chat and lands in build queue via the compliance gate | ✓ VERIFIED | enqueueWinner: toQueuedTask(candidate, ORIGINAL stored GateResult) + taskQueue.enqueue; HALTED refusal repools (WR-01); stale approval → resubmit through full gate (D2-05); narration only claims "Queued for the build" when actually queued (WR-02); e2e (6)+(7) |
| 4 | Bot narrates open/close/winner within rate budget; high-frequency state → overlay only | ✓ VERIFIED | Narrator interface has NO tally-shaped input (structural, not conventional); sole sender is p-queue (15/30s strict, 85% headroom under verified 100/30s); chat-sender sole-caller invariant scan green; feedback bursts coalesce into ≤500-char packed messages |
| 5 | Mid-round connection kill recovers cleanly — resubscribe, reconcile, nothing silently lost | ✓ VERIFIED | recovery.e2e.test.ts on FILE-BACKED SQLite: crash-restart reproduces exact tally + counts votes from both process lives; expired-during-downtime closes + still enqueues via funnel; frozen round across restart discarded with audit semantics (CR-01); disconnect/ready re-syncs from ledger (proven by mutating the ledger mid-gap); gap-vote loss documented honestly in OPERATIONS.md §6.5 |

**Score:** 5/5 roadmap success criteria verified (automated evidence); 28/28 plan-frontmatter truths verified across the 6 plans — 33/33 total.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | CHAT-05 "build progress, build failures" narration | Phase 3 | Phase 3 goal: agent pipeline builds the winner "and viewers watch the whole process live"; no builds exist in Phase 2 |
| 2 | INFRA-01 "channel points" EventSub subscription | Phase 4 | Phase 4 paid-influence goal; OPERATIONS.md §6.2: "channel-points scopes come later, in Phase 4" |

### Required Artifacts

All 24 artifacts across 6 plans pass `gsd-sdk query verify.artifacts` (exists + substantive: min_lines, contains, exports all satisfied). Wiring and data flow verified by direct reading:

| Artifact | Provides | Status |
|----------|----------|--------|
| `src/state-machine/round.ts` (671 lines) | RoundManager: open/vote/close/freeze/restore, upsert votes, tiebreak, zero-vote repool | ✓ VERIFIED, wired in main.ts:206 |
| `src/pipeline/round.ts` | enqueueWinner — the ONE new funnel entry (HALTED refusal + D2-05 staleness) | ✓ VERIFIED, injected main.ts:211, allowlisted single-funnel.test.ts:185 |
| `src/ingestion/command-parser.ts` / `chat-sender.ts` / `twitch-auth.ts` | Parse, rate-budgeted sole sender, persisted refreshing auth (token values never logged) | ✓ VERIFIED, wired main.ts:277-283 + entrypoint adapters |
| `src/ingestion/twitch-chat.ts` / `suggest-intake.ts` / `narration.ts` | EventSub dispatch, pre-classification limits, UI-SPEC narration + coalescing | ✓ VERIFIED, composed inside createApp (main.ts:272-405) — fakes and prod take the identical path |
| `src/overlay/server.ts` / `overlay/public/overlay.js` | Separate read-only 127.0.0.1 surface; full-state ws + debounce; textContent-only client | ✓ VERIFIED, wired main.ts:432 |
| `tests/invariants/{single-funnel,chat-sender,dom-safety}.test.ts` | Machine-checked invariants | ✓ VERIFIED, green in this run |
| `tests/e2e/{round-flow,recovery}.e2e.test.ts` | SC 1-4 loop spec + SC 5 failure-mode specs | ✓ VERIFIED, green in this run |
| `docs/OPERATIONS.md` §6 | Twitch setup/re-auth/rate-budget/gap-loss/crash-recovery runbook | ✓ VERIFIED, matches code (see CR-03 note) |

### Key Link Verification

`gsd-sdk query verify.key-links`: 17/19 verified mechanically. Both misses were tool false-negatives, resolved by hand:

| From | To | Status | Details |
|------|----|--------|---------|
| round.ts | schema.sql round_votes | ✓ WIRED | `ON CONFLICT(round_id, twitch_user_id) DO UPDATE` at round.ts:186 — pattern spans lines, verb's single-line grep missed it |
| narration.ts | chat-sender.ts | ✓ WIRED | `deps.sender.send(` at 7 call sites — verb reported "Invalid regex pattern" for `\.send\(` |
| All other 17 links | — | ✓ WIRED | Verified by verb + confirmed during code reading |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Real Data | Status |
|----------|--------------|--------|-----------|--------|
| overlay.js vote panel | `latest.round` (ws push) | overlay/server.ts buildOverlayState → round.snapshot() → SQLite-restored/live tally | Yes | ✓ FLOWING |
| overlay.js queue strip | `latest.nextUp` | taskQueue.list() (real queue, fed only via gate funnel) | Yes | ✓ FLOWING |
| Chat narration | RoundSnapshot on ROUND_OPENED/CLOSED | RoundManager emits event's own snapshot (closed-round snapshot carried explicitly since snapshot() nulls after close) | Yes | ✓ FLOWING |
| Console round panel | ConsoleState.round | Same RoundManager; e2e console-flows (20 tests) green | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full suite (incl. 4 invariant scans, 2 new e2e files) | `npx vitest run` | 34 files, 378/378 passed, exit 0 (run by verifier, not trusted from SUMMARY) | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Lint | `npx biome check .` | exit 0 (2 infos) — IN-01 lint debt from deferred-items.md confirmed cleared by 8bb5da7 | ✓ PASS |
| Review-fix commits exist | `git log e54c874..8bb5da7` | All 10 present: CR-01..03, WR-01..06, IN-01 | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist in this repository and none are declared in any Phase 2 PLAN/SUMMARY. Step skipped: SKIPPED (no probes declared or conventional).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CHAT-01 | 02-04 | `!suggest <idea>` submission | ✓ SATISFIED | twitch-chat.ts → intake → submitCandidate; e2e (1) |
| CHAT-02 | 02-03 | Timed rounds, numbered options, duration on overlay | ✓ SATISFIED | RoundManager timer + options 1-3; overlay countdown; e2e (4) |
| CHAT-03 | 02-01 | One vote per viewer; revote overrides | ✓ SATISFIED | Native upsert; e2e (5) |
| CHAT-04 | 02-03 | Winner announced, becomes next build task | ✓ SATISFIED | narration.roundClosed + enqueueWinner; e2e (6)+(7) |
| CHAT-05 | 02-04 | Bot narrates state transitions | ✓ SATISFIED (phase scope) | Round open/close/winner verbatim UI-SPEC copy; build progress/failure clauses deferred → Phase 3 (see Deferred) |
| COMP-03 | 02-04 | Category-level rejection feedback | ✓ SATISFIED | CATEGORY_META viewer-safe labels only; e2e (2) |
| INFRA-01 | 02-02 | EventSub WS + persisted auto-refreshing tokens | ✓ SATISFIED (phase scope) | RefreshingAuthProvider + atomic token-file persistence (WR-06) + onRefresh re-persist; channel-points clause deferred → Phase 4; live proof → human item 1 |
| INFRA-02 | 02-06 | Disconnect detect/reconcile + rate budgeting | ✓ SATISFIED | reconcile on every ready; log-line contract asserted; p-queue budget; recovery e2e |
| PRES-01 | 02-05 | Overlay shows live vote tally | ✓ SATISFIED | Overlay server+client; e2e (8); visual fidelity → human item 2 |

No orphaned requirements: REQUIREMENTS.md maps exactly these 9 IDs to Phase 2, and all 9 appear in plan frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/shared/types.ts | 43 | `TODO(01-02)` — GateCategory never narrowed to the categories.ts union | ℹ️ Info | Pre-existing Phase 1 debt (introduced in commit bb4807b, before this phase); references formal follow-up (plan 01-02) and is already tracked in STATE.md Pending Todos. Type-looseness only; not a Phase 2 gap |
| .planning/STATE.md | 73 | Pending todo "[Phase 2] Per-user rate limiting on suggestion intake (T-01-11)" still open | ℹ️ Info | Now closed by src/ingestion/suggest-intake.ts — stale bookkeeping, orchestrator should clear it |
| .planning/STATE.md | — | 02-06 Task 3 live-smoke deferral not yet recorded as a pending todo (plan's resume-signal promised STATE.md logging) | ℹ️ Info | Deferral is captured in 02-06-SUMMARY and surfaced here as human item 1; STATE.md update is bookkeeping for the orchestrator |

No blockers. No stubs, no empty implementations, no hardcoded empty props, no unreferenced debt markers in any file this phase modified.

### Judgment Calls Reviewed (per orchestrator request)

**CR-01 (boot-discard of restored frozen rounds):** Consistent with Phase 1 D-04 triage semantics. `discardRestoredFrozen()` (round.ts:550) delegates to the same `#discard()` used by HALTED→IDLE triage: row → 'discarded', candidates repool, ROUND_CLOSED emitted, votes retained in round_votes (D-02: nothing deleted). Rationale is sound — halt context isn't persisted, so no triage view exists after restart; without the discard, `startRound()`'s new round-active guard (round.ts:216) would deadlock the show. Narrator deliberately stays silent on discarded rounds (narration.ts:115). Covered by recovery e2e test 3.

**CR-03 (bootstrap restart vs restart-free re-auth):** OPERATIONS.md §6.2/§6.3 matches the code exactly. `completeAuthorization` registers on the `liveProvider` when one exists (twitch-auth.ts:120-125, `addUserForToken` replaces token data in place → restart-free re-auth), and main.ts:581/586 returns `chatLive: true/false`, which drives the two honest callback pages in server.ts:362-364 ("chat is reconnecting" vs "now RESTART the app"). Unit test proves the fresh token lands on the live provider, not a throwaway.

### Human Verification Required

#### 1. Live Twitch smoke test (deferred 02-06 Task 3 checkpoint)

**Test:** OPERATIONS.md §6.1-6.2 setup + PLAN 02-06 Task 3 steps 4-8 on the real channel (suggest from second account, cooldown reply, Start Round, revote, expiry, winner queued; optional 30s network kill mid-round).
**Expected:** Full loop works live; token survives restart; revote shows one moved vote; disconnect/reconnect logged with the round intact.
**Why human:** All automated proof uses injected twurple fakes; real EventSub/Helix/scopes/refresh need the broadcaster account.

#### 2. OBS browser-source overlay check

**Test:** Add the overlay as a 1920x1080 browser source, run a round, switch scenes mid-round.
**Expected:** UI-SPEC rendering; scene-switch reload reconstructs full state; halt shows amber ON HOLD, never error text.
**Why human:** Visual/motion/CEF-reload behavior.

#### 3. Phase 1 carried HUMAN-UAT items

**Test:** Per 01-HUMAN-UAT.md — physical panic-hotkey focus-independence, live Sonnet `gate:eval`, console browser run-through.
**Expected:** As specified there.
**Why human:** Carried unresolved from Phase 1; OS-level, metered-API, and visual checks.

### Gaps Summary

No gaps. Every automated must-have — 5 roadmap success criteria, 28 plan-frontmatter truths, 24 artifacts, 19 key links, 9 requirements — is verified against the actual codebase, with the test suite (378/378), typecheck, and lint re-run independently by the verifier. Two requirement clauses (build-narration, channel points) are deferred to Phases 3/4 with explicit roadmap evidence. What remains is inherently human: the live-Twitch smoke round, the OBS visual check, and the Phase 1 UAT carryovers.

---

_Verified: 2026-07-09T21:10:00Z_
_Verifier: Claude (gsd-verifier)_
