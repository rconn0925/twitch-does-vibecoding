# Phase 2: Chat Vote Loop - Research

**Researched:** 2026-07-09
**Domain:** Twitch EventSub/Helix chat integration (twurple 8.x), timed voting rounds with crash-recoverable state, OBS overlay push, single-funnel compliance-gate integration
**Confidence:** HIGH (twurple API surface, Twitch rate limits/scopes — verified against official docs + GitHub source) / MEDIUM (round-lifecycle and rate-limit-budget design — no direct precedent, composed from Phase 1 patterns + Phase 1 research)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Voting round mechanics**
- **D2-01:** Rounds are **streamer-triggered from the operator console** (a "Start round" action), not auto-scheduled. Live-reliability constraint: the streamer controls show pacing; auto-scheduling can come later if it proves tedious.
- **D2-02:** Each round presents **3 candidates** (matches `!vote 1/2/3`), drawn from the pre-screened candidate pool. Default **60-second** rounds; duration configurable via env/config and visible on the overlay (CHAT-02).
- **D2-03:** **Ties break by announced random pick** — the bot says it was a tiebreak ("Coin flip says…"). Simple, honest, showable. No sudden-death rounds in v1.
- **D2-04:** If the pool has fewer than 3 candidates, a round can run with 2; with 0–1 the console disables round start and shows why. Rounds never stall on escalated items (Phase 1 D-06 carries forward: held items miss the round and re-enter the pool if approved).
- **D2-05:** The winner enqueues via the existing gate funnel (already-classified pool items go pool → queue through the single funnel; no reclassification needed at win time unless the item aged past a staleness bound — Claude's discretion on the bound).

**Chat feedback & rate-limit budget**
- **D2-06:** Rejection feedback is a **public @-reply one-liner** with the category and the D-13 suggest-trim variant where applicable ("too big for a live build — try a smaller version"). No whispers (extra scopes, unreliable delivery). Held items get the D-08 "held for streamer review" message.
- **D2-07:** **Rate budget rule: chat gets transitions, overlay gets state** (per success criterion 4). Bot messages are limited to: round open (with candidates), round close + winner, rejection/held feedback, and errors. Live tallies/timers NEVER go to chat. Feedback messages coalesce under burst (e.g., batch multiple rejections into one message when they queue up within a few seconds).
- **D2-08:** Outbound chat messages go through a **single rate-limit-aware sender queue** (token-bucket budgeting per Twitch Helix limits) — no direct sendChatMessage calls scattered around.

**Twitch auth & account model**
- **D2-09:** **Single broadcaster token** (no separate bot account) — per CLAUDE.md stack guidance: bot badge/separate rate limit is cosmetic for v1's single channel. twurple `RefreshingAuthProvider` with tokens persisted (SQLite table or token file — Claude's discretion) so restarts don't require re-auth (INFRA-01).
- **D2-10:** OAuth bootstrap is a **one-time local flow**: Express route on the existing localhost surface handles the authorization-code callback; docs cover scope list and re-auth. Scopes: minimum needed for chat read/write via EventSub + Helix sendChatMessage (channel points scopes deferred to Phase 4).

**Suggestion intake policy**
- **D2-11:** **Per-user intake limits, enforced BEFORE classification** (this closes Phase 1's accepted risk T-01-11 — Sonnet-call flood): per-user cooldown between suggestions (default ~60s) and max 1 pending (unclassified or pooled) suggestion per user. Over-limit attempts get a quiet @-reply cooldown notice (coalesced).
- **D2-12:** **Exact-duplicate rejection** against the current pool (normalized-text match) with feedback; near-duplicate/semantic dedup is out of scope for v1.
- **D2-13:** Pool is bounded (e.g., ~50 candidates, oldest-drop with audit row). Suggestions do not persist across stream sessions — pool starts clean each night (mirrors Phase 1 D-07 review-queue expiry posture).

**Vote integrity & crash recovery**
- **D2-14:** Votes tally **in-memory with SQLite write-through** (append votes to a round ledger table). On crash/reconnect mid-round: state machine restores the round from SQLite, EventSub resubscribes, tally reconciles from the ledger — no votes silently lost (success criterion 5).
- **D2-15:** One vote per viewer per round keyed by Twitch user ID; a revote **overwrites** the previous vote (CHAT-03). Votes for invalid options are ignored (no feedback — chat noise).
- **D2-16:** A halt (Phase 1 kill switch) during a round **freezes the round** per D-02 semantics; recovery triage decides resume-round vs discard-round. Round timer state must be part of what HALTED freezes and the console shows.

**Overlay**
- **D2-17:** Overlay is a **separate localhost HTTP+ws surface from the operator console** (per ARCHITECTURE.md: public overlay never exposes operator controls). Read-only.
- **D2-18:** Overlay shows: current round (numbered candidates, live tally bars, countdown timer), a "next up" queue strip, and an unobtrusive state pill (IDLE/VOTING/BUILDING/HALTED — HALTED display stays honest but non-alarming on stream). Full-state-on-connect + incremental diffs (per stack doc; OBS browser sources reload on scene switches).
- **D2-19:** Visual design follows the phase UI-SPEC if `/gsd:ui-phase 2` runs (`UI hint: yes` in roadmap); otherwise function-over-form dark theme legible at 1080p stream scale.

### Claude's Discretion

twurple wiring details (EventSub subscription set, keepalive handling), exact token-bucket numbers for the sender queue, staleness bound for pool items (D2-05), SQLite schema for rounds/votes/tokens, overlay layout specifics, suggestion normalization for dedup (reuse the prefilter's normalize()), how the console "Start round" action composes with existing stream-mode transitions.

### Deferred Ideas (OUT OF SCOPE)

- **Change-project consensus vote** (Phase 1 D-15 said the chat-wide consensus mechanic "lands in Phase 2", but Phase 2's roadmap requirements/success criteria do not include it) — flagged as a roadmap conflict for the user: either add it to a later phase explicitly or fold into Phase 2 scope deliberately. NOT auto-added (scope guardrail). The gate vocabulary + state machine already recognize the event type, so nothing rearchitects either way.
- Separate bot account with `user:bot`/`channel:bot` scopes — revisit if bot badge or rate-limit headroom matters after real streams.
- Semantic/near-duplicate suggestion dedup.
- Auto-scheduled rounds (cadence timer) if manual round-start proves tedious.
- Channel-points redemption intake — Phase 4 per roadmap.

### Canonical References (from CONTEXT.md — downstream agents MUST read before planning/implementing)

- `.planning/research/COMPLIANCE.md` §2 — platform rules for bot behavior (rate limits, incentive mechanics constraints); §1 taxonomy drives the feedback categories chat sees (COMP-03).
- `.planning/phases/01-compliance-gate-kill-switch/01-CONTEXT.md` — Phase 1 decisions that bind this phase: D-06 (escalated items miss the round), D-08 (three-state decision vocabulary → chat-facing wording), D-10/D-11 (async classification, reject-with-retry on classifier failure), D-13/D-14 (feasibility suggest-trim feedback), D-15 (change-project instruction type — see Deferred).
- `CLAUDE.md` Technology Stack — twurple ^8.1.x (auth/api/eventsub-ws, lockstep versions), single-broadcaster-token default, EventSub-not-IRC, ws-not-Socket.IO for the overlay, full-state-on-connect + diffs pattern, StreamElements deferred (Phase 4).
- `.planning/research/ARCHITECTURE.md` — public overlay is a separate surface from the operator console; state machine boundaries.
- `.planning/research/PITFALLS.md` — EventSub reconnect/keepalive pitfalls, rate-limit pitfalls.
- `.planning/research/STACK.md` — stack rationale.
- `src/pipeline/submit.ts` — `submitCandidate()` is the ONLY intake path (single-funnel invariant); Twitch `!suggest` handler must call this, never the classifier/pool/queue directly.
- `src/state-machine/stream-mode.ts` — VOTING_ROUND state exists; round lifecycle must use these transitions (HALT priority preserved).
- `src/queue/pool.ts`, `src/queue/task-queue.ts` — pre-screened pool and brand-typed queue.
- `src/audit/record.ts`, `src/audit/schema.sql` — append-only audit ledger; new event types (round lifecycle, votes summary, pool drops) follow its patterns.
- `tests/invariants/single-funnel.test.ts` — the machine-checked invariant new code must not break.
- `.planning/phases/01-compliance-gate-kill-switch/01-SECURITY.md` — T-01-11 (intake rate limiting) is CLOSED-as-accepted pending this phase's D2-11.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| CHAT-01 | Viewer can submit a project/feature idea via `!suggest <idea>` in Twitch chat | Pattern 1/2 (EventSub `channel.chat.message` read path, verified field names); Code Examples (`command-parser.ts`); reuse `submitCandidate()` unmodified (Architecture Patterns, Structure Rationale) |
| CHAT-02 | Chat can vote in timed rounds with numbered options (`!vote 1/2/3`), round duration visible on overlay | Recommended Project Structure (`state-machine/round.ts`); Pitfall 3 (overlay debounce); D2-02 timer/duration config pattern (matches existing `REVIEW_TTL_HOURS` env convention, Open Question 3) |
| CHAT-03 | Each viewer gets one vote per round; a revote overrides their earlier vote | Code Examples (SQLite upsert via `ON CONFLICT DO UPDATE`); Pitfall 2 (vote must be keyed by `chatterId`, not username) |
| CHAT-04 | The winning suggestion is announced in chat and becomes the next build task | Pitfall 1 (single-funnel invariant allowlist update required); Architecture Patterns diagram (`pipeline/round.ts` funnel entry) |
| CHAT-05 | The bot narrates state transitions in chat (round open/close, winner, build progress, build failures) | Pattern 4 (rate-limited sender queue); D2-07 rate-budget doctrine reaffirmed in Anti-Patterns to Avoid |
| COMP-03 | A rejected suggestion gets category-level feedback in chat | Reuse `CATEGORY_META` viewer-safe labels from `src/compliance/categories.ts` (Structure Rationale references existing gate output already carrying category + rationale) |
| INFRA-01 | Twitch integration uses EventSub over WebSocket with persisted auto-refreshing tokens | Pattern 3 (OAuth bootstrap, `RefreshingAuthProvider`, verified `exchangeCode`/`AccessToken` shapes) |
| INFRA-02 | EventSub disconnects are detected and reconciled (resubscribe + state recheck); outbound chat respects rate-limit budgeting | Pattern 1 (twurple's built-in reconnect/resubscribe, verified from GitHub source); Pattern 4 (sender queue); Security Domain (V3 Session Management row) |
| PRES-01 | OBS browser-source overlay shows the live vote tally during rounds | Recommended Project Structure (`overlay/server.ts`, mirrors existing console ws pattern); D2-17/D2-18 full-state-on-connect pattern already implemented once in `src/operator-console/server.ts` and `console.js` (reuse, don't reinvent) |
</phase_requirements>

## Summary

Phase 2 adds three new subsystems to an existing, well-tested Phase 1 skeleton: a twurple-based Twitch ingestion adapter (EventSub WS for chat reads, Helix for chat writes), a round/vote lifecycle manager wired into the existing `StreamModeMachine`, and a second localhost WebSocket server (the public overlay) separate from the operator console. All three must integrate with code that already exists and is invariant-tested — this is the load-bearing fact for planning: **`submitCandidate()` is the only chat-facing entry point for `!suggest`, and the round-winner→queue path is a NEW funnel entry point that does not yet exist in the codebase and is not yet covered by `tests/invariants/single-funnel.test.ts`'s hardcoded allowlist.**

twurple's `EventSubWsListener`/`EventSubWsSocket` (verified directly from the `twurple/twurple` GitHub source, `packages/eventsub-ws/src/EventSubWsSocket.ts`) already implements automatic reconnection, `session_reconnect` handling, and automatic re-subscription of all active subscriptions after any disconnect (clean or unexpected) — the library satisfies most of INFRA-02's "resubscribe" clause for free. What twurple does **not** do is replay events that occurred during a gap or reconcile application-level state (votes, round status) — that reconciliation is this phase's own responsibility, and it is exactly what D2-14's SQLite write-through vote ledger is for.

The single broadcaster token (D2-09) simplifies the rate-limit and scope story considerably versus a separate bot account: sending as the broadcaster's own account automatically qualifies for the **100 messages/30s** Helix chat tier (not the 20/30s regular-account tier), and reading/writing chat needs only `user:read:chat` + `user:write:chat` scopes — `user:bot`/`channel:bot` are irrelevant because those only apply to **app access tokens**, and this project uses a **user access token** throughout.

**Primary recommendation:** Build the Twitch ingestion adapter and round manager as thin, injectable-dependency modules following the exact patterns already established in `src/pipeline/submit.ts` and `src/state-machine/stream-mode.ts` — reuse `submitCandidate()` unmodified for `!suggest`, add a new `src/state-machine/round.ts` for round lifecycle + `src/pipeline/round.ts` (new file) for the winner→`toQueuedTask()`→`enqueue()` path, and update `tests/invariants/single-funnel.test.ts`'s allowlists as a first-class planned task, not an afterthought.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Twitch chat read (`!suggest`/`!vote` parsing) | Backend (Node process, `src/ingestion/`) | — | EventSub WS is a server-to-server connection; no browser tier involved |
| Twitch chat write (round narration, rejection feedback) | Backend (rate-limited sender queue) | — | Must be centralized through one token-bucket queue per D2-08; no component may call `sendChatMessage` directly |
| Round lifecycle (open/tally/close/winner) | Backend (`src/state-machine/round.ts`) | — | Owns timers and vote tallies; must survive process restart via SQLite (D2-14) |
| Vote ledger persistence | Database (SQLite via better-sqlite3) | Backend (in-memory cache mirrors it) | D2-14: write-through, not write-behind — every vote is durable before it's acknowledged |
| Winner → build queue funnel | Backend (`src/pipeline/round.ts`, new) | — | Must go through `toQueuedTask()` (COMP-01); this is the ONE new funnel entry point this phase adds |
| OAuth bootstrap (authorization code callback) | Backend (Express route on existing console-adjacent surface) | — | One-time interactive flow; not a recurring runtime concern |
| Public overlay (tally, timer, queue strip, state pill) | Browser (OBS CEF browser source) | Backend (ws push server, separate port from operator console) | D2-17: must be a physically separate HTTP+ws surface from the operator console — never share a port/process boundary that could expose operator controls publicly |
| Operator console "Start round" action | Backend (extends `src/operator-console/server.ts`) | Browser (console.js UI) | Reuses the existing CSRF-protected mutation-route pattern; round start is a state-machine transition, not new infra |
| Suggestion normalization / dedup (D2-12) | Backend (`src/pipeline/`, reusing `normalize()`) | — | Same normalization function Phase 1 already uses for the prefilter — one canonical text-normalization path |
| Per-user intake rate limiting (D2-11) | Backend (in-memory map, closes T-01-11) | — | Must run BEFORE `submitCandidate()`/classification, not after — the whole point is avoiding wasted Sonnet calls |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@twurple/auth` | 8.1.4 [VERIFIED: npm registry] | `RefreshingAuthProvider`, `exchangeCode()` for OAuth bootstrap | Locked by CLAUDE.md; only actively-maintained TS-first library covering token refresh end-to-end |
| `@twurple/api` | 8.1.4 [VERIFIED: npm registry] | `ApiClient`, `HelixChatApi.sendChatMessage()` for the write path | Locked by CLAUDE.md; must match `@twurple/auth`/`@twurple/eventsub-ws` minor version exactly (lockstep releases) |
| `@twurple/eventsub-ws` | 8.1.4 [VERIFIED: npm registry] | `EventSubWsListener`, `onChannelChatMessage()` for the read path | Locked by CLAUDE.md; handles reconnect/resubscribe internally (see Architecture Patterns below) |
| `p-queue` | 9.3.1 [VERIFIED: npm registry] | Token-bucket-style outbound chat sender queue (D2-08) | ESM-only, `intervalCap`/`interval` options are a direct fit for Twitch's `N msgs / 30s` budget — reuses a dependency already named in `.planning/research/STACK.md` rather than hand-rolling a token bucket. Node engine requirement (`>=20`) is already satisfied by the project's Node 24 target. |

**All four packages passed `slopcheck` verification this session** (see Package Legitimacy Audit below) and their APIs were confirmed against official documentation/GitHub source, not training-data recall alone — hence `[VERIFIED]` rather than `[ASSUMED]`.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4 (already installed) | Validate EventSub chat-message payload shape before parsing `!suggest`/`!vote` | Every untrusted boundary, per existing project convention — EventSub payloads are network input, not intrinsically trusted just because they come from Twitch's SDK |
| `better-sqlite3` | ^12.11.0 (already installed) | Round/vote/token persistence tables | Already the project's durable-state store; add tables to the same `openDb()`-managed connection, not a second database file |
| `pino` | ^10 (already installed) | Structured logging for reconnect/resubscribe/round events | Existing convention; log `onUserSocketDisconnect`/`onUserSocketReady` transitions explicitly — these are the INFRA-02 observability surface |
| `ws` | ^8.21.0 (already installed) | Second WebSocket server for the public overlay (D2-17) | Reuse the exact `WebSocketServer({ server, verifyClient })` + full-state-on-connect pattern already implemented in `src/operator-console/server.ts` — do not introduce a new pattern |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `p-queue` for the sender queue | Hand-rolled token bucket (~20 lines) | Codebase already hand-rolls the state machine and kill switch for good reasons (no dependency, full control) — but `p-queue`'s `intervalCap`/`interval`/`strict` options are a closer semantic match to "N messages per 30s window" than a hand-rolled bucket would be on the first pass, and it's already a project-endorsed dependency (STACK.md), just not yet installed. Recommend `p-queue`; hand-rolling remains a fallback if its behavior under `strict: true` proves awkward in practice. |
| `@twurple/eventsub-ws`'s built-in reconnect | A hand-rolled reconnect wrapper (as PITFALLS.md originally assumed might be necessary) | Verified via source inspection that twurple already does this — do NOT build a second reconnect layer on top; it would fight the library's own `PersistentConnection` retry logic. Only add a thin reconciliation hook on `onUserSocketReady`. |

**Installation:**
```bash
npm install @twurple/auth@8.1.4 @twurple/api@8.1.4 @twurple/eventsub-ws@8.1.4 p-queue@9.3.1
```

**Version verification:** confirmed live via `npm view <pkg> version` this session (2026-07-09): `@twurple/auth@8.1.4`, `@twurple/api@8.1.4`, `@twurple/eventsub-ws@8.1.4`, `p-queue@9.3.1`. All three `@twurple/*` packages are in lockstep at 8.1.4 (CLAUDE.md's compatibility table is confirmed current).

## Package Legitimacy Audit

| Package | Registry | First Published | Source Repo | slopcheck | Disposition |
|---------|----------|------------------|--------------|-----------|-------------|
| `@twurple/api` | npm | 2021-04-14 | github.com/twurple/twurple | [OK] | Approved |
| `@twurple/auth` | npm | 2021-04-14 | github.com/twurple/twurple | [OK] | Approved |
| `@twurple/eventsub-ws` | npm | 2021-04-14 | github.com/twurple/twurple | [OK] | Approved |
| `p-queue` | npm | 2016-10-28 | github.com/sindresorhus/p-queue | [OK] | Approved |

No `postinstall` scripts found on any of the four packages (`npm view <pkg> scripts.postinstall` returned empty for all). All are pure-JS/TS, no native compilation step — this is a meaningfully lower-risk installation than `better-sqlite3`/`uiohook-napi` (already in the project, both native modules with documented Windows prebuild risk).

**Packages removed due to slopcheck `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none.

## Architecture Patterns

### System Architecture Diagram

```
Twitch chat "!suggest <idea>" / "!vote N"
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  EventSubWsListener (twurple)                                │
│  onChannelChatMessage(broadcasterId, broadcasterId, handler) │
│  — reconnect/resubscribe handled INSIDE twurple (verified)   │
└───────────────┬───────────────────────────┬──────────────────┘
                │ "!suggest ..."             │ "!vote N"
                ▼                             ▼
   ┌─────────────────────────┐   ┌─────────────────────────────┐
   │ command-parser.ts        │   │ command-parser.ts             │
   │ zod-validate raw event   │   │ zod-validate raw event        │
   └──────────┬────────────────┘   └───────────┬───────────────────┘
              │ build SuggestionCandidate        │ { chatterId, option }
              ▼                                   ▼
   ┌─────────────────────────┐   ┌─────────────────────────────┐
   │ per-user cooldown gate   │   │ round.ts: recordVote()        │
   │ (D2-11, BEFORE classify) │   │  - validate round is OPEN     │
   └──────────┬────────────────┘   │  - upsert into votes table    │
              │ (existing, unchanged)│    (write-through, D2-14/15) │
              ▼                     │  - in-memory tally update      │
   ┌─────────────────────────┐   └───────────────┬───────────────────┘
   │ submitCandidate()         │                   │ tally delta
   │ (src/pipeline/submit.ts,  │                   ▼
   │  UNCHANGED — COMP-01)     │        ┌─────────────────────────┐
   └──────────┬────────────────┘        │ overlay ws server         │
              │ approved/held/rejected  │ (separate port, D2-17)     │
              ▼                          └─────────────────────────┘
   ┌─────────────────────────┐
   │ pool.ts / review-queue.ts │  (existing, unchanged)
   └──────────┬────────────────┘
              │ operator "Start round" (console action)
              ▼
   ┌─────────────────────────────────────────────┐
   │ state-machine/round.ts                        │
   │  - draws ≤3 candidates from pool               │
   │  - IDLE → VOTING_ROUND transition               │
   │  - starts round timer, persists round row       │
   │  - on close: tie-break if needed, picks winner   │
   └───────────────┬───────────────────────────────┘
                    │ winner (already-approved candidate)
                    ▼
   ┌─────────────────────────────────────────────┐
   │ pipeline/round.ts  (NEW — funnel entry point) │
   │  toQueuedTask(candidate, approvedResult)       │
   │  taskQueue.enqueue(task)                       │
   │  — requires updating single-funnel.test.ts     │
   │    allowlists (see Pitfall: Funnel Allowlist)  │
   └───────────────┬───────────────────────────────┘
                    │
                    ▼
   ┌─────────────────────────┐        ┌─────────────────────────┐
   │ chat sender queue          │◄──────│ round open/close/winner   │
   │ (p-queue, token-bucket,    │       │ narration events           │
   │  D2-08, ONLY chat writer)  │       └─────────────────────────┘
   └──────────┬────────────────┘
              ▼
   Helix sendChatMessage (broadcaster token, 100 msgs/30s tier)
```

### Recommended Project Structure

```
src/
├── ingestion/
│   ├── twitch-auth.ts        # RefreshingAuthProvider bootstrap + persistence (INFRA-01)
│   ├── twitch-chat.ts        # EventSubWsListener wiring, onChannelChatMessage subscription
│   ├── command-parser.ts     # zod-validated !suggest/!vote parsing from EventSubChannelChatMessageEvent
│   └── chat-sender.ts        # p-queue-backed rate-limited outbound sender (D2-08), sole sendChatMessage caller
├── state-machine/
│   ├── round.ts               # NEW: round lifecycle (open/tally/close/winner), timers, tie-break
│   └── stream-mode.ts         # existing — VOTING_ROUND transitions already defined, reused as-is
├── pipeline/
│   ├── submit.ts              # existing — UNCHANGED, still the only !suggest entry point
│   └── round.ts               # NEW: winner → toQueuedTask() → taskQueue.enqueue() funnel entry
├── overlay/
│   ├── server.ts              # NEW: separate ws+http server (D2-17), mirrors operator-console/server.ts's ws pattern
│   └── public/                # overlay HTML/CSS/JS, textContent-only rendering (same XSS rule as console)
├── operator-console/
│   ├── server.ts              # extended: POST /api/round/start, GET /auth/callback (OAuth bootstrap route)
│   └── public/                # extended: "Start round" button, round status panel
└── audit/
    └── record.ts              # extended: recordRoundEvent() for round_opened/round_closed/pool_dropped event types
```

### Structure Rationale

- `ingestion/` is new this phase and mirrors `ARCHITECTURE.md`'s original recommended structure — it did not exist yet because Phase 1 had no live Twitch input.
- `pipeline/round.ts` is deliberately a **separate file** from `pipeline/submit.ts`, not an extension of it: `submit.ts` handles NEW, unclassified candidates; `round.ts` handles an ALREADY-approved pool item being promoted to a queued task with no reclassification (D2-05). Conflating them would blur two different trust states in one function.
- `overlay/` is a sibling of `operator-console/`, never nested inside it — this is the concrete implementation of D2-17's "never share a surface" rule; two separate `http.createServer()` instances on two separate ports, bound to `127.0.0.1` (overlay is actually intended to be reachable by OBS's embedded browser, which runs on the same machine, so `127.0.0.1` binding is correct and sufficient — no additional auth needed since OBS CEF is local-only by construction).

### Pattern 1: twurple EventSub WS Reconnect Is Already Handled — Don't Re-Implement It

**What:** `EventSubWsListener` wraps each user's connection in an `EventSubWsSocket`, which itself wraps a `PersistentConnection` (from `@d-fischer/connection`, a twurple-internal dependency). Verified directly from `packages/eventsub-ws/src/EventSubWsSocket.ts` (GitHub, `twurple/twurple`, main branch, fetched this session):
  - On `session_welcome` (first connect OR after an unexpected disconnect-then-reconnect): if not already mid-reconnect, it calls `.start()` on every previously-registered subscription for that user — i.e., it **re-subscribes automatically**.
  - On `session_reconnect` (Twitch-initiated): sets a flag, connects to the new `reconnect_url`, and does NOT re-run subscription `.start()` — the session carries over per Twitch's own reconnect protocol (old connection is not closed until the new one's welcome arrives).
  - On `session_keepalive`: resets an internal timer set to `keepalive_timeout_seconds * 1200` ms (20% grace beyond what Twitch specifies). If neither a keepalive nor a notification arrives within that window, `assumeExternalDisconnect()` is called, which triggers the same reconnect path as a hard socket drop.
  - Public events exposed for application code to hook: `onUserSocketConnect`, `onUserSocketReady(userId, sessionId)`, `onUserSocketDisconnect(userId, error?)`, and (inherited from `EventSubBase`) `onRevoke`.

**When to use:** Every EventSub WS integration with twurple 8.x — this is not optional behavior, it's built into the socket class and cannot be disabled short of not using the library.

**What this means for INFRA-02:** The "resubscribe" half of INFRA-02 is handled by the library. This phase's own responsibility is narrower than it might first appear:
1. Log `onUserSocketDisconnect`/`onUserSocketReady` transitions (observability — Pitfall 2 from `.planning/research/PITFALLS.md` calls this out explicitly).
2. On `onUserSocketReady` (i.e., every successful (re)connect, including the very first), run a **reconciliation check**: does the in-memory round state match what SQLite says (D2-14)? If the process crashed and restarted mid-round, `main.ts`-level startup logic (not the EventSub listener) must restore the round from the `rounds`/`votes` tables BEFORE the listener starts accepting `!vote` messages again — otherwise a vote could land against an in-memory round that doesn't match the persisted one.
3. Nothing needs to "poll for missed events" the way Phase 1's PITFALLS.md worried about for donation/points events — for chat-vote rounds specifically, a gap just means some votes during the outage are lost (acceptable, matches D2-14's framing: "no votes silently lost" refers to votes that WERE received and written to SQLite before a crash, not votes sent into a genuine connectivity gap, which Twitch never delivers to any consumer, twurple or otherwise, since EventSub has no event replay).

**Example (verified pattern from GitHub source, adapted):**
```typescript
// src/ingestion/twitch-chat.ts
listener.onUserSocketDisconnect((userId, error) => {
  logger.warn({ userId, err: error }, "EventSub socket disconnected — twurple will auto-reconnect");
});
listener.onUserSocketReady((userId, sessionId) => {
  logger.info({ userId, sessionId }, "EventSub socket (re)connected and ready");
  reconcileRoundState(); // D2-14: compare in-memory round vs SQLite rounds/votes tables
});
```

### Pattern 2: Single Broadcaster Token — Scopes and Rate Tier

**What:** Per D2-09, one Twitch user access token (the broadcaster's own account) covers both reading (`channel.chat.message` EventSub subscription) and writing (Helix `sendChatMessage`) chat.

**Scopes required** (verified against `dev.twitch.tv/docs/eventsub/eventsub-subscription-types` and the Send Chat Message API docs, both fetched this session):
- `user:read:chat` — subscribe to `channel.chat.message` as the chatting/broadcaster user (condition: `broadcaster_user_id` + `user_id`, both set to the broadcaster's own numeric ID since it's a self-subscription)
- `user:write:chat` — send messages via Helix `sendChatMessage`
- `user:bot` / `channel:bot` are **NOT required** — those scopes only matter for **app access tokens** subscribing/sending on someone else's behalf. A user access token acting as itself does not need them. (This directly simplifies D2-10's scope list versus what a separate-bot-account design would need.)

**Rate tier:** Twitch's Helix chat-send rate limit gives **100 messages/30 seconds** to broadcaster/moderator/VIP-tier accounts, versus 20/30s for a regular account (verified, `dev.twitch.tv/docs/chat/`, fetched this session — this is a more current/precise number than Phase 1's PITFALLS.md figure of "20 msgs/30s… 'known bot' 50/30s", which appears to reflect an older/IRC-era tier scheme; the current Helix-era numbers are 20/100/7500 for regular/broadcaster-mod-VIP/verified-bot). Because the broadcaster IS the sending account here, **the 100/30s tier applies automatically with zero extra setup** — no need to mod a separate bot account, no Verified Bot application. Still budget conservatively under 100/30s (D2-08's token bucket) since round-open/close/winner + coalesced rejection feedback + error messages can burst during an active raid or hype moment.

**When to use:** This exact scope list and rate assumption applies for the lifetime of the single-broadcaster-token design (D2-09). If Phase 4+ later splits to a separate bot account (deferred per CONTEXT.md), re-derive scopes and rate tier at that time — a separate bot account without mod status reverts to the 20/30s tier.

### Pattern 3: OAuth Bootstrap (Authorization Code Grant, One-Time)

**What:** A one-time interactive flow: redirect the streamer's browser to Twitch's authorize endpoint with `client_id`, `redirect_uri` (a `127.0.0.1`-based URI registered in the Twitch dev console), `response_type=code`, and the scope list above; Twitch redirects back to a local Express route with `?code=...`; exchange that code for tokens via `@twurple/auth`'s `exchangeCode()`.

**Verified `exchangeCode` signature** (from `twurple.js.org/reference/auth/functions/exchangeCode.html`, fetched this session):
```typescript
async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<AccessToken>
```

**Verified `AccessToken` interface fields** (from `twurple.js.org/reference/auth/interfaces/AccessToken.html`):
```typescript
interface AccessToken {
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  expiresIn: number | null;      // seconds from obtainmentTimestamp
  obtainmentTimestamp: number;   // epoch ms
}
```
This is exactly the field set CLAUDE.md and D2-09/D2-10 already describe — confirms the project's prior stack research was accurate here.

**Persistence via `RefreshingAuthProvider`** (verified via `twurple.js.org/docs/auth/providers/refreshing.html`):
```typescript
const authProvider = new RefreshingAuthProvider({ clientId, clientSecret });
authProvider.onRefresh(async (userId, newTokenData) => {
  // persist newTokenData (AccessToken shape above) — SQLite table (Claude's discretion, D2-09)
});
authProvider.onRefreshFailure(async (userId, error) => {
  // log loudly — a stale/dead token means the bot silently goes deaf, matches Pitfall 2
});
// Bootstrap (first run, no persisted token yet):
const tokenData = await exchangeCode(clientId, clientSecret, code, redirectUri);
await authProvider.addUserForToken(tokenData, ["chat"]);
// Subsequent runs (token already persisted):
await authProvider.addUser(broadcasterUserId, persistedTokenData, ["chat"]);
```
The `intents` array (`["chat"]` in the official example) is a twurple-internal routing label for when multiple users share one `AuthProvider`; since this project registers exactly one user (the broadcaster), its exact contents don't materially matter — any non-empty label is fine, but match the official example (`["chat"]`) for consistency with twurple's own docs.

**When to use:** Exactly once per machine setup (or whenever the refresh token is revoked/expires from prolonged inactivity). The Express route for `/auth/callback` should live on an existing localhost surface (operator console's Express app, per D2-10) — do not stand up a fourth HTTP server just for this one-time flow.

### Pattern 4: Rate-Limited Chat Sender Queue (D2-08)

**What:** A single `p-queue` instance configured with `intervalCap`/`interval` matching a conservative budget under the verified 100/30s tier, wrapping every `sendChatMessage` call. No other module calls `HelixChatApi.sendChatMessage` directly — this mirrors the existing `single-funnel.test.ts` pattern of enforcing "only one call site" via a source-scan test, and this phase should add an equivalent scan rule for the chat-sender boundary.

**Example:**
```typescript
// src/ingestion/chat-sender.ts
import PQueue from "p-queue";

const sendQueue = new PQueue({ concurrency: 1, intervalCap: 15, interval: 30_000, strict: true });
// 15/30s leaves wide margin under the verified 100/30s ceiling for bursts of
// coalesced rejection feedback (D2-06) without risking the 30-minute lockout
// documented in PITFALLS.md Pitfall 1.

export function enqueueChatMessage(broadcasterId: string, text: string): Promise<void> {
  return sendQueue.add(() => apiClient.chat.sendChatMessage(broadcasterId, text)).then(() => undefined);
}
```
**When to use:** Every outbound chat message this phase produces (round open, round close/winner, coalesced rejection/held feedback, errors) — per D2-07/D2-08, this is the ONLY writer to chat. Live tallies and timers never go through this queue; they go to the overlay ws push instead.

### Anti-Patterns to Avoid

- **Calling `toQueuedTask()` or `.enqueue()` from anywhere other than the sanctioned pipeline files:** `tests/invariants/single-funnel.test.ts` will fail the build if this phase's round-winner logic doesn't live in an allowlisted file. See Common Pitfalls below — this is the single most important integration constraint for this phase's planner to get right on the first pass.
- **Building a second reconnect/backoff layer on top of `EventSubWsListener`:** twurple already retries; layering a second retry loop around `listener.start()` risks double-reconnect races. Only hook the public events (`onUserSocketReady`, `onUserSocketDisconnect`) for logging/reconciliation, never wrap `.start()`/`.stop()` in your own retry loop.
- **Sending high-frequency vote-tally updates to chat:** D2-07 is explicit and this project's own PITFALLS.md Pitfall 1 documents the 30-minute lockout risk in detail — every vote-count change goes to the overlay ws push, never to a chat message.
- **Treating `twitchUsername` as a stable voter identity:** `SuggestionCandidate.twitchUsername` (existing Phase 1 type) is a display name, not a stable Twitch numeric ID. D2-15 explicitly requires votes be keyed by Twitch user ID (`chatterId` from `EventSubChannelChatMessageEvent`, verified field name) — the vote ledger table must use that ID, not the username string, as its uniqueness key.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| EventSub WS reconnect/keepalive | A custom reconnect-with-backoff wrapper around the raw WebSocket | `EventSubWsListener`'s built-in `PersistentConnection` retry + auto-resubscribe | Verified from source this session — twurple already does exactly this, including the `session_reconnect` handshake and keepalive-timeout-triggered reconnect. A parallel implementation would be redundant and could race with twurple's own retry state. |
| Chat message rate budgeting | A hand-rolled token bucket / sliding window | `p-queue` with `intervalCap`/`interval`/`strict` | Already project-endorsed (STACK.md); avoids reimplementing a sliding-window algorithm that's easy to get subtly wrong (fixed-interval buckets allow bursting at window boundaries — `strict: true` avoids that documented p-queue gotcha). |
| OAuth token refresh | Manual `setTimeout`-based refresh-before-expiry logic | `RefreshingAuthProvider` + `onRefresh` persistence callback | This is twurple's core value proposition per CLAUDE.md's own stack rationale — hand-rolling it defeats the reason the library was chosen. |
| Vote tallying with revote-overrides | Ad-hoc array scanning / dedup logic | SQLite `UNIQUE(round_id, twitch_user_id)` + `INSERT ... ON CONFLICT DO UPDATE` (upsert) | SQLite's native upsert is exactly "one row per (round, voter), last write wins" — matches D2-15 semantics precisely and is atomic, avoiding a read-then-write race between concurrent chat events. |

**Key insight:** This phase's biggest hand-rolling temptation is the EventSub reconnect layer, because Phase 1's own `.planning/research/PITFALLS.md` (written before this session's source-level verification) frames it as something the project must implement carefully. That framing was accurate for a hypothetical raw-WebSocket implementation; it is NOT accurate for a twurple-based implementation, where the library already closes that gap. Don't let Pitfall 2's prose from Phase 1 research drive over-engineering here — verify against the actual library before adding defensive code that duplicates what's already handled.

## Common Pitfalls

### Pitfall 1: The Single-Funnel Invariant Test Will Fail Unless This Phase Updates Its Allowlists

**What goes wrong:** `tests/invariants/single-funnel.test.ts` hardcodes: (a) exactly one `as QueuedTask` cast, in `src/compliance/gate.ts`; (d) `toQueuedTask` referenced only by `gate.ts` and `src/pipeline/submit.ts`; (b) `.enqueue(` called only from files under `src/pipeline/`. Currently, **nothing in production code calls `toQueuedTask()` or `TaskQueue.enqueue()` at all** — only test fixtures do (confirmed via grep this session). Phase 2 is the first phase to actually wire a winner→queue path, and if that logic is written as, say, a method on `StateMachine`/`round.ts` that calls `toQueuedTask()` directly, the invariant test fails the build (`toQueuedTask referenced outside the sanctioned funnel`).

**Why it happens:** The natural place to write "round closes, pick winner, enqueue it" is inside the round/state-machine logic, since that's where the winner is determined — but the invariant test was written when only `submit.ts` existed as a funnel entry point, and its allowlist is a literal `Set`, not a pattern.

**How to avoid:** Plan a task that (1) creates `src/pipeline/round.ts` as a new, narrow module whose only job is `enqueueWinner(candidate, approvedResult): QueuedTask` — calling `toQueuedTask()` and `taskQueue.enqueue()` — and (2) updates `tests/invariants/single-funnel.test.ts`'s two `Set`/allowlist literals to include `"src/pipeline/round.ts"` alongside the existing `"src/pipeline/submit.ts"`. Both edits belong in the same task/commit; the invariant test itself is meant to evolve exactly like this (its own doc comment says "Phase 2's chat ingestion... inherits the check automatically" — the intent is that new funnel entry points get explicitly added to the allowlist, not that no new entry points can ever exist).

**Warning signs:** `npm test` fails on `tests/invariants/single-funnel.test.ts` with a message naming a file outside the allowlist — this is the exact intended failure mode, not a bug to work around by weakening the test.

### Pitfall 2: Votes Must Be Keyed by Twitch User ID, Suggestion Cooldowns Have No Such Field Yet

**What goes wrong:** `SuggestionCandidate.twitchUsername: string | null` (existing Phase 1 type) is a display name. D2-15 requires vote uniqueness be keyed by Twitch user ID (immutable, unlike display names which can change or be spoofed via unicode tricks the way `prefilter.ts`'s normalize() already defends against for suggestion text). `EventSubChannelChatMessageEvent.chatterId` (verified field name) provides this for votes directly from the EventSub payload — but it is a SEPARATE data path from `SuggestionCandidate`, since votes never go through `submitCandidate()`.

**Why it happens:** It's easy to reach for `twitchUsername` for vote-dedup because it's already on the type chat ingestion is producing for `!suggest`, and to assume the same field works for `!vote`.

**How to avoid:** Design the `votes` table with `twitch_user_id TEXT NOT NULL` (from `chatterId`) as part of its uniqueness key, never `twitch_username`. Separately, D2-11's per-user suggestion cooldown MAY use `twitchUsername` (lower stakes — a cooldown gaming attempt via a changed display name is a minor annoyance, not a fairness-critical vote-integrity issue) or could also be upgraded to `chatterId` if the planner wants one consistent identity scheme across both intake paths — flagged as Claude's discretion per CONTEXT.md, not a locked requirement either way.

**Warning signs:** A revote test that changes only display name (not underlying Twitch account) incorrectly registers as a new voter instead of overriding.

### Pitfall 3: Overlay High-Frequency Push Must Be Debounced, Not Per-Vote

**What goes wrong:** If every single `!vote` chat message triggers an immediate `pushState()`-style broadcast to the overlay ws server (mirroring the operator console's current per-mutation push pattern), a close/active vote could push dozens of times per second during a hype moment. Phase 1's `ARCHITECTURE.md` Scaling Priorities section flags this exact risk ("batch tally updates on a short interval, e.g. every 250-500ms, rather than per-event") for a system that, at this project's actual scale (single channel, OBS overlay is 1-2 ws clients), is unlikely to matter for *server* load — but DOES matter for the overlay's own visual rendering (a bar-chart tally re-rendering 10x/second reads as flicker on stream, which is a presentation defect, not just a performance one).

**How to avoid:** Debounce/coalesce overlay pushes on a short fixed interval (e.g. every 250-500ms while a round is open) rather than pushing on every individual vote event — this is a design decision for `round.ts`, distinct from the console's existing synchronous per-mutation push (which is fine at console-mutation frequency, since operator actions are naturally rate-limited by human interaction speed).

**Warning signs:** Overlay vote bars visibly stutter/flicker during a close vote in manual testing.

### Pitfall 4: `channel.chat.message` Subscription Condition Needs Both `broadcaster_user_id` AND `user_id`

**What goes wrong:** The EventSub subscription condition for `channel.chat.message` requires TWO fields (`broadcaster_user_id`, `user_id`) — confirmed via `dev.twitch.tv/docs/eventsub/eventsub-subscription-types` this session. `twurple`'s `onChannelChatMessage(broadcaster, user, handler)` signature reflects this with two separate `UserIdResolvable` parameters, not one. Passing the same ID twice (broadcaster reading their own chat, single-token design) is correct for this project, but it's easy to assume only a `broadcaster` parameter is needed by analogy with other EventSub subscription types (many of which take only one ID).

**How to avoid:** Pass the broadcaster's numeric user ID as BOTH the `broadcaster` and `user` arguments to `onChannelChatMessage()` — since D2-09's single-broadcaster-token design means the "chatting user" being read is the broadcaster account itself reading its OWN channel's chat.

**Warning signs:** Subscription creation fails or the subscription silently never fires because the `user_id` field was omitted or set incorrectly.

## Code Examples

### Command parsing from a verified `EventSubChannelChatMessageEvent`

```typescript
// src/ingestion/command-parser.ts
// Field names verified: twurple.js.org/reference/eventsub-base — EventSubChannelChatMessageEvent
import { z } from "zod";

const SuggestCommand = z.object({
  kind: z.literal("suggest"),
  text: z.string().min(1).max(2000),
});
const VoteCommand = z.object({
  kind: z.literal("vote"),
  option: z.number().int().min(1).max(3),
});

export function parseCommand(messageText: string): { kind: "suggest"; text: string } | { kind: "vote"; option: number } | null {
  const suggestMatch = /^!suggest\s+(.+)$/i.exec(messageText.trim());
  if (suggestMatch?.[1]) {
    return SuggestCommand.parse({ kind: "suggest", text: suggestMatch[1] });
  }
  const voteMatch = /^!vote\s+([1-3])$/i.exec(messageText.trim());
  if (voteMatch?.[1]) {
    return VoteCommand.parse({ kind: "vote", option: Number(voteMatch[1]) });
  }
  return null; // not a recognized command — ignored, no feedback (chat noise per D2-15's "invalid options ignored" precedent)
}
```

### Vote upsert (revote overrides, D2-15) via better-sqlite3

```typescript
// src/state-machine/round.ts (excerpt)
const upsertVote = db.prepare(`
  INSERT INTO round_votes (round_id, twitch_user_id, option_index, voted_at_ms)
  VALUES (@roundId, @twitchUserId, @optionIndex, @votedAtMs)
  ON CONFLICT(round_id, twitch_user_id) DO UPDATE SET
    option_index = excluded.option_index,
    voted_at_ms = excluded.voted_at_ms
`);
// requires: CREATE UNIQUE INDEX ... ON round_votes(round_id, twitch_user_id)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Twitch chat via IRC (`tmi.js`, raw PRIVMSG) | Twitch chat via EventSub WS (read) + Helix `sendChatMessage` (write) | Twitch's own migration push (`dev.twitch.tv/docs/chat/irc-migration`, ongoing through 2026) | Already reflected correctly in CLAUDE.md and this phase's design — no action needed, just confirming currency |
| Twitch PubSub for channel points/bits | EventSub (all transports) | Retired April 2025 | Not directly this phase's concern (channel points deferred to Phase 4) but relevant if Phase 4 research reuses this phase's EventSub listener wiring |
| Hand-rolled chat rate-limit tiers assumption ("20/30s regular, 50/30s known bot") | Verified current Helix tiers: 20/30s regular, 100/30s broadcaster/mod/VIP, 7500/30s verified bot | This session's direct fetch of `dev.twitch.tv/docs/chat/` | Phase 1's PITFALLS.md numbers (50/30s "known bot" tier) reflect an older/IRC-era scheme; use this phase's verified 100/30s broadcaster-tier number for the D2-08 token-bucket budget, not Phase 1's figure |

**Deprecated/outdated:** Phase 1's `.planning/research/PITFALLS.md` Pitfall 1 cites "20 msgs/commands per 30 seconds per bot account... 'Known bot' 50/30s" — this session's direct fetch of the current official Twitch chat docs shows the current Helix-era numbers as 20 (regular) / 100 (broadcaster-mod-VIP) / 7500 (verified bot), with no distinct "known bot" tier documented at that URL. Since D2-09 uses the broadcaster's own token, the applicable tier is unambiguously the 100/30s one — use that number, not 50/30s, when sizing the D2-08 token bucket.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | `p-queue`'s `intervalCap`/`interval`/`strict: true` combination behaves as a true sliding-window rate limiter suitable for a hard external ceiling (not just an internal concurrency throttle) | Pattern 4 / Standard Stack | LOW — if `strict` mode's behavior under real Twitch-side enforcement proves looser than expected, the mitigation is trivial: lower the configured `intervalCap` further below the verified 100/30s ceiling. No architectural rework needed either way. |
| A2 | The `intents` array argument to `addUserForToken`/`addUser` has no functional consequence when only one user is ever registered on the `AuthProvider` | Pattern 3 | LOW — worst case, an incorrect intents value causes an internal twurple routing error visible immediately at first API call in local testing, not a silent live-stream failure. |
| A3 | Overlay push debouncing at 250-500ms (Pitfall 3) is an adequate interval for perceived-live tally updates on stream | Pitfall 3 | LOW — purely a UX tuning parameter; adjustable without any architecture change if it reads as laggy or still flickery during testing. |

**If this table is empty:** N/A — see above; all three assumptions are low-risk/easily-tunable, not load-bearing architectural claims.

## Open Questions (RESOLVED)

1. **Does `SuggestionCandidate` need a `twitchUserId` field added, or does per-user suggestion cooldown (D2-11) stay keyed on `twitchUsername`?**
   - What we know: votes (a separate data path, D2-15) MUST use `chatterId` (Twitch numeric user ID). Suggestions currently only carry `twitchUsername` on the existing Phase 1 type.
   - What's unclear: whether the planner wants one consistent identity scheme (extend `SuggestionCandidate` with a nullable `twitchUserId`, a type change touching Phase 1 code) or accepts the lower-stakes asymmetry (usernames for cooldown, IDs for votes).
   - Recommendation: default to NOT touching the Phase 1 type (lower blast radius — `SuggestionCandidate` is used across all Phase 1 plans per its own doc comment warning); keep cooldown keyed on `twitchUsername` for now, revisit only if display-name spoofing to dodge cooldowns becomes an observed problem.
   - **Resolution (planner):** votes AND intake state keyed by `chatterId`; `SuggestionCandidate` untouched — the stronger identity option within the granted discretion (plans 02-01/02-04, T-02-01/T-02-13).

2. **Where exactly should the OAuth `/auth/callback` Express route live — a new route on `operator-console/server.ts`, or a small standalone bootstrap script run once outside the main app?**
   - What we know: D2-10 says "Express route on the existing localhost surface." CLAUDE.md's Stack Patterns section describes this as one-time.
   - What's unclear: whether it should be a permanently-mounted route (simpler mental model, always available for re-auth) or a separate one-shot `scripts/twitch-auth-bootstrap.ts` (keeps the always-on console server's route surface smaller).
   - Recommendation: mount it as a permanent low-traffic route on the console server (`GET /auth/callback`, `GET /auth/start` to build the authorize URL) — matches the existing `scripts/gate-eval.ts` vs. main-app-route precedent inconsistently, but a permanent route means re-auth after a revoked refresh token doesn't require redeploying a script, which better serves "graceful degradation... matters more than feature count" (CLAUDE.md).
   - **Resolution (planner):** permanent `GET /auth/start` + `GET /auth/callback` routes on the console server, with single-use expiring state nonce (plan 02-04 Task 3).

3. **Exact per-user suggestion cooldown window and pool bound enforcement mechanics (D2-11/D2-13 numbers) — "default ~60s" and "~50 candidates" are approximate in CONTEXT.md.**
   - What we know: CONTEXT.md explicitly marks these as defaults/examples ("default ~60s", "e.g., ~50 candidates"), not locked numbers.
   - What's unclear: final numbers.
   - Recommendation: implement as env-configurable (matching the existing `REVIEW_TTL_HOURS`/`GATE_MAX_RETRIES` pattern in `.env.example`), defaulting to the CONTEXT.md examples — this defers the exact-number decision to runtime tuning rather than a code change, consistent with how Phase 1 handled its own TTL/retry knobs.
   - **Resolution (planner):** env-configurable knobs `INTAKE_COOLDOWN_SECONDS=60` / `POOL_MAX_SIZE=50` added to `.env.example` (plan 02-01 Task 1), consumed in plan 02-04.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| Node.js | Runtime | Yes (per `package.json` engines, already running Phase 1) | 24.x (project-pinned) | — |
| npm registry access | Installing `@twurple/*`, `p-queue` | Yes (confirmed this session via `npm view`) | — | — |
| Twitch Developer Console app registration (client ID/secret, redirect URI) | OAuth bootstrap (D2-10) | **Unconfirmed — not verifiable from this environment** | — | Blocks the OAuth bootstrap step; not a code risk, a one-time manual setup step the streamer must complete (register an app at `dev.twitch.tv/console`, add a `127.0.0.1`-based redirect URI) before Phase 2's live-integration tasks can run against real Twitch. Unit/contract tests do not need this (inject fakes, per existing `FakeClassifier`-style pattern). |

**Missing dependencies with no fallback:** none — the one manual prerequisite (Twitch app registration) has no code-level fallback but also blocks nothing except the final live-integration checkpoint, which should be a `checkpoint:human-verify` task per this project's existing conventions (Phase 1 used the same pattern for `ANTHROPIC_API_KEY`).

**Missing dependencies with fallback:** none.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|--------------------|
| V2 Authentication | Yes | Twitch OAuth (Authorization Code Grant) via `@twurple/auth`; tokens persisted via `RefreshingAuthProvider`'s `onRefresh` callback, never logged in plaintext (extend the existing `pino` logger's redaction discipline — Phase 1 has no explicit redaction config yet; flag for this phase since it's the first phase handling long-lived refresh tokens) |
| V3 Session Management | Yes (adjacent) | Round state is server-authoritative (`round.ts` + SQLite), never trusts client/overlay-reported state — matches `ARCHITECTURE.md` Anti-Pattern 3 ("Trusting Twitch's Client-Side/Third-Party Numbers Without a Server-Side State Machine") |
| V4 Access Control | Yes | Overlay server (D2-17) is read-only by construction — no mutation routes exist on that surface at all, which is a stronger control than access-checking a shared surface; the operator console's existing CSRF middleware pattern (`Origin`/`Content-Type` checks) extends unchanged to the new `POST /api/round/start` route |
| V5 Input Validation | Yes | zod validation at the EventSub payload boundary (new — this phase's first untrusted network input beyond the existing `/api/dev/submit` form); reuse `normalize()` from `prefilter.ts` for suggestion-text/dedup comparison |
| V6 Cryptography | No new surface | OAuth token exchange is TLS-handled by twurple/Twitch; no custom crypto this phase |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Vote brigading (coordinated/alt accounts pushing a low-quality winner) | Spoofing / Elevation of Privilege (of influence) | Per-user vote cap (one per round, D2-15) already closes the basic case; `.planning/research/PITFALLS.md` Pitfall 7 flags account-age/follower-status weighting as a v2-level mitigation not required for this phase — vote-source logging via the existing audit ledger (extend `recordX` helpers) gives the streamer visibility to veto a brigaded round manually, which is this phase's actual backstop |
| Suggestion-intake flood (Sonnet-call cost/DoS via `!suggest` spam) | Denial of Service | D2-11 per-user cooldown + max-1-pending, enforced BEFORE `classify()` is called — this closes the accepted-risk item T-01-11 from Phase 1's `01-SECURITY.md` |
| Twitch display-name spoofing for vote/cooldown bypass | Spoofing | Vote ledger keyed by `chatterId` (immutable numeric ID), not display name (Pitfall 2 above) |
| EventSub payload malformation / unexpected shape | Tampering | zod-validate the raw event object shape before extracting `chatterId`/`messageText` — do not trust twurple's TypeScript types alone as a runtime guarantee (types are compile-time only, per this project's own `RESEARCH.md Pattern 1 caveat` precedent already documented in `single-funnel.test.ts`) |
| Chat-derived suggestion text used as agent instructions | Elevation of Privilege | Out of this phase's scope (Phase 3's prompt-injection boundary per `.planning/research/PITFALLS.md` Pitfall 3) — but this phase must NOT weaken the existing discipline of treating suggestion text as opaque data; the winner text passed into `toQueuedTask()` must be the same normalized/validated string that passed the Phase 1 gate, not re-derived from raw chat at enqueue time |

## Sources

### Primary (HIGH confidence)
- `github.com/twurple/twurple` (main branch, `packages/eventsub-ws/src/EventSubWsSocket.ts` and `EventSubWsListener.ts`) — fetched directly this session via `gh api repos/twurple/twurple/contents/...`; reconnect/keepalive/resubscribe behavior confirmed from actual source, not docs prose
- `twurple.js.org/reference/auth/functions/exchangeCode.html`, `twurple.js.org/reference/auth/interfaces/AccessToken.html`, `twurple.js.org/reference/auth/classes/RefreshingAuthProvider.html`, `twurple.js.org/docs/auth/providers/refreshing.html` — official reference docs, fetched this session
- `twurple.js.org/reference/eventsub-base/classes/EventSubChannelChatMessageEvent.html` — official reference docs, fetched this session (field names: `chatterId`, `chatterName`, `chatterDisplayName`, `messageId`, `messageText`)
- `dev.twitch.tv/docs/eventsub/eventsub-subscription-types/` — fetched this session; `channel.chat.message` version, condition fields, scope requirements
- `dev.twitch.tv/docs/chat/` — fetched this session; current Helix chat-send rate-limit tiers (20/100/7500 per 30s)
- `dev.twitch.tv/docs/eventsub/handling-websocket-events/` — fetched this session; 300 max subs/connection, 10s subscribe window, 30s reconnect window, max 3 WS/user token, cost ceiling 10
- `npm view <pkg> version` (this session, live registry queries): `@twurple/api@8.1.4`, `@twurple/auth@8.1.4`, `@twurple/eventsub-ws@8.1.4`, `p-queue@9.3.1`
- `slopcheck install @twurple/auth @twurple/api @twurple/eventsub-ws p-queue` (this session) — all four `[OK]`
- Direct codebase reads (this session): `src/pipeline/submit.ts`, `src/state-machine/stream-mode.ts`, `src/queue/pool.ts`, `src/queue/task-queue.ts`, `src/audit/record.ts`, `src/audit/schema.sql`, `src/main.ts`, `src/operator-console/server.ts`, `src/operator-console/public/console.js`, `src/compliance/{gate,prefilter,classifier,categories}.ts`, `src/state-machine/review-queue.ts`, `src/shared/{types,events}.ts`, `tests/invariants/single-funnel.test.ts`, `.env.example`, `package.json`

### Secondary (MEDIUM confidence)
- `github.com/sindresorhus/p-queue` README (fetched via WebFetch this session) — `intervalCap`/`interval`/`strict` option semantics
- `.planning/research/{ARCHITECTURE,PITFALLS,STACK,COMPLIANCE}.md` (Phase 1 research, dated 2026-07-08) — reused for continuity where not superseded by this session's direct verification; explicitly flagged in "State of the Art" where this session's findings supersede a specific PITFALLS.md number

### Tertiary (LOW confidence)
- WebSearch summaries of `onChannelChatMessage`/`sendChatMessage` signatures where the underlying reference page returned incomplete detail (used only to triangulate before confirming against the primary sources listed above; no claim in this document rests solely on a WebSearch summary)

## Metadata

**Confidence breakdown:**
- Standard stack (twurple/p-queue versions, scopes, rate tiers): HIGH — verified via official docs, GitHub source, and live npm registry queries this session
- Architecture (funnel integration, single-funnel invariant conflict): HIGH — derived from direct reads of the actual current codebase and its own test file, not inference
- Round-lifecycle/vote-ledger design specifics (table schemas, debounce intervals): MEDIUM — no direct precedent project exists for this exact composition; design is a reasoned extension of Phase 1's established patterns (write-through SQLite, hand-rolled state machine) rather than a verified external source
- Pitfalls: HIGH for the funnel-allowlist and voter-identity pitfalls (grounded in direct codebase inspection); MEDIUM for the overlay-debounce pitfall (reasoned from Phase 1's own `ARCHITECTURE.md` scaling section, not independently re-verified this session)

**Research date:** 2026-07-09
**Valid until:** 30 days for twurple/p-queue API surface (stable, lockstep-versioned library; low churn risk); 7 days for exact Twitch rate-limit numbers if a live-integration checkpoint slips past that window (Twitch has changed these tiers before and Phase 1's own PITFALLS.md already shows evidence of one such change between its research date and this session)
