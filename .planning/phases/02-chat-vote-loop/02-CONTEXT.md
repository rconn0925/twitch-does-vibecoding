# Phase 2: Chat Vote Loop - Context

**Gathered:** 2026-07-09 (auto mode — recommended defaults selected; audit trail in 02-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

Chat can suggest, vote in timed rounds, and see the winner queued — live on the overlay, with every suggestion routing through the Phase 1 gate. Deliverables:

1. **Twitch ingestion** — EventSub over WebSocket (twurple), `!suggest <idea>` and `!vote N` command parsing, persisted auto-refreshing tokens (INFRA-01), disconnect detection + resubscribe + state reconciliation (INFRA-02).
2. **Voting rounds** — timed rounds over the pre-screened candidate pool; one vote per viewer, revote overrides (CHAT-02/03); winner announced and enqueued via the Phase 1 gate funnel (CHAT-04).
3. **Chat feedback** — category-level rejection feedback (COMP-03), bot narration of round open/close/winner within rate-limit budget (CHAT-05).
4. **Public overlay** — OBS browser-source overlay with live tally + round timer (PRES-01), separate from the operator console.

Not in this phase: build engine/sandbox (Phase 3), paid influence and chaos mode (Phase 4), channel-points redemptions (Phase 4), build-progress narration beyond stubs (Phase 3 wires real build events).

Requirements: CHAT-01..05, COMP-03, INFRA-01, INFRA-02, PRES-01. Roadmap mode: **mvp** — plan as a vertical slice; planner should honor SPIDR-style thinnest-path-first.

</domain>

<decisions>
## Implementation Decisions

### Voting round mechanics
- **D2-01:** Rounds are **streamer-triggered from the operator console** (a "Start round" action), not auto-scheduled. Live-reliability constraint: the streamer controls show pacing; auto-scheduling can come later if it proves tedious.
- **D2-02:** Each round presents **3 candidates** (matches `!vote 1/2/3`), drawn from the pre-screened candidate pool. Default **60-second** rounds; duration configurable via env/config and visible on the overlay (CHAT-02).
- **D2-03:** **Ties break by announced random pick** — the bot says it was a tiebreak ("Coin flip says…"). Simple, honest, showable. No sudden-death rounds in v1.
- **D2-04:** If the pool has fewer than 3 candidates, a round can run with 2; with 0–1 the console disables round start and shows why. Rounds never stall on escalated items (Phase 1 D-06 carries forward: held items miss the round and re-enter the pool if approved).
- **D2-05:** The winner enqueues via the existing gate funnel (already-classified pool items go pool → queue through the single funnel; no reclassification needed at win time unless the item aged past a staleness bound — Claude's discretion on the bound).

### Chat feedback & rate-limit budget
- **D2-06:** Rejection feedback is a **public @-reply one-liner** with the category and the D-13 suggest-trim variant where applicable ("too big for a live build — try a smaller version"). No whispers (extra scopes, unreliable delivery). Held items get the D-08 "held for streamer review" message.
- **D2-07:** **Rate budget rule: chat gets transitions, overlay gets state** (per success criterion 4). Bot messages are limited to: round open (with candidates), round close + winner, rejection/held feedback, and errors. Live tallies/timers NEVER go to chat. Feedback messages coalesce under burst (e.g., batch multiple rejections into one message when they queue up within a few seconds).
- **D2-08:** Outbound chat messages go through a **single rate-limit-aware sender queue** (token-bucket budgeting per Twitch Helix limits) — no direct sendChatMessage calls scattered around.

### Twitch auth & account model
- **D2-09:** **Single broadcaster token** (no separate bot account) — per CLAUDE.md stack guidance: bot badge/separate rate limit is cosmetic for v1's single channel. twurple `RefreshingAuthProvider` with tokens persisted (SQLite table or token file — Claude's discretion) so restarts don't require re-auth (INFRA-01).
- **D2-10:** OAuth bootstrap is a **one-time local flow**: Express route on the existing localhost surface handles the authorization-code callback; docs cover scope list and re-auth. Scopes: minimum needed for chat read/write via EventSub + Helix sendChatMessage (channel points scopes deferred to Phase 4).

### Suggestion intake policy
- **D2-11:** **Per-user intake limits, enforced BEFORE classification** (this closes Phase 1's accepted risk T-01-11 — Sonnet-call flood): per-user cooldown between suggestions (default ~60s) and max 1 pending (unclassified or pooled) suggestion per user. Over-limit attempts get a quiet @-reply cooldown notice (coalesced).
- **D2-12:** **Exact-duplicate rejection** against the current pool (normalized-text match) with feedback; near-duplicate/semantic dedup is out of scope for v1.
- **D2-13:** Pool is bounded (e.g., ~50 candidates, oldest-drop with audit row). Suggestions do not persist across stream sessions — pool starts clean each night (mirrors Phase 1 D-07 review-queue expiry posture).

### Vote integrity & crash recovery
- **D2-14:** Votes tally **in-memory with SQLite write-through** (append votes to a round ledger table). On crash/reconnect mid-round: state machine restores the round from SQLite, EventSub resubscribes, tally reconciles from the ledger — no votes silently lost (success criterion 5).
- **D2-15:** One vote per viewer per round keyed by Twitch user ID; a revote **overwrites** the previous vote (CHAT-03). Votes for invalid options are ignored (no feedback — chat noise).
- **D2-16:** A halt (Phase 1 kill switch) during a round **freezes the round** per D-02 semantics; recovery triage decides resume-round vs discard-round. Round timer state must be part of what HALTED freezes and the console shows.

### Overlay
- **D2-17:** Overlay is a **separate localhost HTTP+ws surface from the operator console** (per ARCHITECTURE.md: public overlay never exposes operator controls). Read-only.
- **D2-18:** Overlay shows: current round (numbered candidates, live tally bars, countdown timer), a "next up" queue strip, and an unobtrusive state pill (IDLE/VOTING/BUILDING/HALTED — HALTED display stays honest but non-alarming on stream). Full-state-on-connect + incremental diffs (per stack doc; OBS browser sources reload on scene switches).
- **D2-19:** Visual design follows the phase UI-SPEC if `/gsd:ui-phase 2` runs (`UI hint: yes` in roadmap); otherwise function-over-form dark theme legible at 1080p stream scale.

### Claude's Discretion
- twurple wiring details (EventSub subscription set, keepalive handling), exact token-bucket numbers for the sender queue, staleness bound for pool items (D2-05), SQLite schema for rounds/votes/tokens, overlay layout specifics, suggestion normalization for dedup (reuse the prefilter's normalize()), how the console "Start round" action composes with existing stream-mode transitions.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Platform rules & compliance
- `.planning/research/COMPLIANCE.md` §2 — platform rules for bot behavior (rate limits, incentive mechanics constraints); §1 taxonomy drives the feedback categories chat sees (COMP-03).
- `.planning/phases/01-compliance-gate-kill-switch/01-CONTEXT.md` — Phase 1 decisions that bind this phase: D-06 (escalated items miss the round), D-08 (three-state decision vocabulary → chat-facing wording), D-10/D-11 (async classification, reject-with-retry on classifier failure), D-13/D-14 (feasibility suggest-trim feedback), D-15 (change-project instruction type — see Deferred).

### Architecture & stack (locked)
- `CLAUDE.md` Technology Stack — twurple ^8.1.x (auth/api/eventsub-ws, lockstep versions), single-broadcaster-token default, EventSub-not-IRC, ws-not-Socket.IO for the overlay, full-state-on-connect + diffs pattern, StreamElements deferred (Phase 4).
- `.planning/research/ARCHITECTURE.md` — public overlay is a separate surface from the operator console; state machine boundaries.
- `.planning/research/PITFALLS.md` — EventSub reconnect/keepalive pitfalls, rate-limit pitfalls.
- `.planning/research/STACK.md` — stack rationale.

### Phase 1 contracts this phase consumes
- `src/pipeline/submit.ts` — `submitCandidate()` is the ONLY intake path (single-funnel invariant); Twitch `!suggest` handler must call this, never the classifier/pool/queue directly.
- `src/state-machine/stream-mode.ts` — VOTING_ROUND state exists; round lifecycle must use these transitions (HALT priority preserved).
- `src/queue/pool.ts`, `src/queue/task-queue.ts` — pre-screened pool and brand-typed queue.
- `src/audit/record.ts`, `src/audit/schema.sql` — append-only audit ledger; new event types (round lifecycle, votes summary, pool drops) follow its patterns.
- `tests/invariants/single-funnel.test.ts` — the machine-checked invariant new code must not break.
- `.planning/phases/01-compliance-gate-kill-switch/01-SECURITY.md` — T-01-11 (intake rate limiting) is CLOSED-as-accepted pending this phase's D2-11.

### Requirements
- `.planning/REQUIREMENTS.md` — CHAT-01..05, COMP-03, INFRA-01, INFRA-02, PRES-01 verbatim.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `submitCandidate()` (src/pipeline/submit.ts): complete intake pipeline with HALTED refusal + audit — the `!suggest` handler is a thin adapter onto it.
- `normalize()` (src/compliance/prefilter.ts): unicode/whitespace/hyphen normalization — reuse for duplicate detection (D2-12).
- Operator console server + views (src/operator-console/): "Start round" action and round status slot into the existing console; CSRF middleware pattern applies to new mutation routes.
- Audit ledger (src/audit/): established record + purge patterns for new event types.
- e2e patterns (tests/e2e/): supertest-style console flows and process fixtures to model EventSub reconnect tests on.

### Established Patterns
- zod validation at every untrusted boundary (EventSub payloads are untrusted input — validate before parsing commands).
- Fail-closed posture everywhere; injected dependencies (classifier client) — the Twitch client should be injected the same way for testability.
- textContent-only DOM rule extends to the overlay (chat-derived candidate text renders on stream — same XSS rule, arguably more important since it's broadcast).
- Conventional commits `feat(02-XX):`, TDD RED→GREEN where behavior-adding.

### Integration Points
- `src/main.ts`: wires console + hotkey; Twitch listener + overlay server join the same lifecycle (and must die cleanly on halt/shutdown).
- `src/state-machine/stream-mode.ts`: round start/close transitions.
- `src/queue/pool.ts` → round candidate selection; winner → task-queue via gate funnel.

</code_context>

<specifics>
## Specific Ideas

- Rate budget doctrine (from roadmap success criterion 4): "high-frequency state goes to the overlay, not chat" — treat as a design law, not a tuning knob.
- Overlay must survive OBS scene-switch reloads invisibly (full state on connect).
- Bot narration tone: show-aware and terse — round open/close/winner reads like a game show beat, not log output (final copy is Claude's discretion).

</specifics>

<deferred>
## Deferred Ideas

- **Change-project consensus vote** (Phase 1 D-15 said the chat-wide consensus mechanic "lands in Phase 2", but Phase 2's roadmap requirements/success criteria do not include it) — flagged as a roadmap conflict for the user: either add it to a later phase explicitly or fold into Phase 2 scope deliberately. NOT auto-added (scope guardrail). The gate vocabulary + state machine already recognize the event type, so nothing rearchitects either way.
- Separate bot account with `user:bot`/`channel:bot` scopes — revisit if bot badge or rate-limit headroom matters after real streams.
- Semantic/near-duplicate suggestion dedup.
- Auto-scheduled rounds (cadence timer) if manual round-start proves tedious.
- Channel-points redemption intake — Phase 4 per roadmap.

</deferred>

---

*Phase: 02-chat-vote-loop*
*Context gathered: 2026-07-09*
