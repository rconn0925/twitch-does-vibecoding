# Phase 4: Paid Influence & Chaos Mode - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning (research pass required first — see D-01)

> **Mode: --auto** — no user present; Claude selected recommended defaults grounded in ROADMAP.md, CLAUDE.md, and prior-phase decisions. Mirroring how Phase 3's discuss deliberately did NOT auto-lock the unvalidated sandbox mechanism, the **donation-platform choice (D-01) is recorded as a recommendation, NOT locked** — the roadmap flags it for a research pass (`/gsd:plan-phase --research-phase 4`). Review CONTEXT.md and override before planning if desired.

<domain>
## Phase Boundary

This phase adds **alternative influence paths** on top of the existing suggest → filter → vote → build loop, WITHOUT ever creating a compliance bypass or attaching chance to payment:

1. **Paid free-reign windows (PAID-01/03/04)** — a donation via an external platform (never Twitch Bits) grants the donor a time-boxed, streamer-revocable "free reign" window whose duration is proportional to the amount (with caps + cooldowns). Instructions issued during the window are the donor's to choose (they bypass the *vote*), but every one still passes the identical compliance gate (COMP-01..04) and stays streamer-vetoable. The amount→duration mapping and every window open/close/revoke is logged.
2. **Channel-points micro-windows (PAID-02)** — a native Twitch EventSub channel-points redemption grants a smaller-scale, shorter direct-influence window using the same window/gate/veto machinery, on a different (non-monetary) trigger.
3. **Chaos mode (CHAOS-01/02)** — a streamer toggle that swaps the *selection strategy* from a vote to a uniform-random pick from the already-filtered suggestion pool. It is a STRICTLY separate mechanic from paid control: no chance element is ever attached to payment (sweepstakes-law separation), enforced in the architecture, not by convention.

**In scope:** the donation/redemption event ingestion, the control-window state machine (open/duration/cap/cooldown/revoke), routing paid instructions through the *existing* single funnel + gate + veto, the chaos-mode selection strategy, overlay/audit surfacing of active windows and chaos state, and a machine-checkable paid↔chaos separation invariant.

**Out of scope (belongs elsewhere / deferred):** the compliance gate itself (Phase 1 — reused), the vote loop and EventSub plumbing (Phase 2 — reused/extended), the sandboxed build engine (Phase 3 — reused), persistent cross-stream changelog (Phase 5), and the end-to-end dry run (Phase 5). No new build capability — this phase only changes *how a task is selected and who is allowed to select it*, never what the builder can do.
</domain>

<decisions>
## Implementation Decisions

### Donation platform & event ingestion (RESEARCH-FLAGGED — recommendation, not locked)
- **D-01 (OPEN / spike):** **Recommended default = StreamElements** (cloud-only realtime websocket via `socket.io-client` against `realtime.streamelements.com`, JWT-authenticated; `tip` events), per CLAUDE.md — it needs no desktop client competing for CPU/RAM on the streaming machine, unlike Streamlabs. **This is NOT auto-locked.** The roadmap mandates a research pass to (a) re-verify StreamElements vs Streamlabs current state, (b) re-verify the verbatim Bits/Channel-Points AUP text, and (c) settle chargeback/refund handling. The planner MUST run `--research-phase 4` before locking. Bits as a paid-influence trigger is **rejected outright** (Bits AUP risk — CLAUDE.md "What NOT to Use"); donations flow only through the external platform.
- **D-02:** Channel-points trigger = native Twitch EventSub `channel.channel_points_custom_reward_redemption.add` (broadcaster-scoped — the broadcaster token from Phase 2 already covers it). No new auth surface beyond what Phase 2 established; if a bot-token split is ever needed it stays deferred (CLAUDE.md single-broadcaster-token default).

### Control-window model (PAID-01/03/04, PAID-02)
- **D-03:** A single **ControlWindow** state machine backs BOTH donation windows and channel-points windows (same open → active → expiry/revoke lifecycle, same gate + veto routing); they differ only in trigger and in their (configurable) duration/cap constants. Do not build two parallel mechanisms.
- **D-04:** Amount→duration mapping is **linear with a floor and a hard cap** (e.g. a per-unit rate, a minimum window, and a maximum window length), plus a **per-donor cooldown** — exact constants are streamer-tunable config (Claude's discretion / research-informed), but the SHAPE (linear-capped + cooldown) is locked. Caps + cooldowns exist specifically so a large donation cannot monopolise the show or create an unbounded window.
- **D-05:** **One active control window at a time** (no stacking), mirroring the build concurrency-1 discipline. Precedence: an active paid window > chaos mode > the normal vote loop. A redemption/donation arriving while a window is active is queued behind the cooldown or dropped-with-feedback (never silently) — narration + audit, per the never-silent doctrine carried from Phases 2/3.
- **D-06:** During a window, a donor instruction becomes a queued task through the **SAME single funnel** (gate.ts `classify()` → the one `as QueuedTask`) used by the vote path — paid control gets *guaranteed selection*, never a gate exemption (PAID-03). The single-funnel invariant must remain green; no new enqueue path. Windows are time-boxed and **streamer-revocable at any moment** (reuse the Phase 1 veto/HALTED machinery); expiry or revoke reverts to the normal loop. Durable state (active window, cooldown timers, amount→duration log) persists in better-sqlite3 so a mid-stream crash cannot lose or silently extend a paid window.

### Chaos mode & the paid↔chaos separation (CHAOS-01/02)
- **D-07:** Chaos mode is a **streamer toggle** that replaces the vote with a **uniform-random pick from the already-filtered pool** (the pool is still fully gate-filtered — chaos changes selection, never compliance). On toggle-off, revert to the vote loop.
- **D-08 (LOCKED, machine-enforced):** Chaos (random) and paid control (guaranteed) **share no code path that attaches chance to payment** (CHAOS-02 / success-criterion 5). Enforce this as a **machine-checkable invariant** in the spirit of the single-funnel/secrets-isolation source scans: the paid-window module imports/refers to no RNG, and the chaos/random-selection module subscribes to no donation/redemption/payment event. This is verified in the architecture by a test, not left to convention.

### Model policy & agent work
- **D-09:** This phase is predominantly **orchestration + state machines + event ingestion** — minimal agent/LLM work. The Sonnet-research / Fable-build split (CLAUDE.md) is unchanged and largely dormant here; the build agent is reused as-is from Phase 3 once a paid/chaos-selected task is queued.

### Dependency posture on the deferred Phase 3 gate
- **D-10:** Phase 4 is built against the SAME injected-fakes discipline as Phase 3 — it does not require the Phase 3 Wave 0 WSL2 go/no-go to be closed to be developed and tested. Paid/chaos live at the selection/gate/window layer and touch no part of the sandbox adapter, so a later Wave 0 NO-GO (→ Docker path) does not ripple into this phase. (The human-gated Wave 0 + Phase 4's own live gates — donation-platform account/OAuth, a real tip + redemption smoke test — are batched for the end.)

### Claude's Discretion
- Exact amount→duration constants, cap values, and cooldown lengths (D-04) — streamer-tunable config, research-informed.
- The precise ControlWindow schema and overlay presentation of an active window (donor handle, countdown, chaos indicator) — subject to the Phase 3 UI-SPEC discipline (no red on broadcast, textContent-only, coarse public surface).
- Transient-vs-terminal handling of donation-event socket drops (reuse the twurple/EventSub reconnect discipline from Phase 2).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 4: Paid Influence & Chaos Mode" — goal, 6 requirements, 5 success criteria, and the research flag
- `.planning/REQUIREMENTS.md` — PAID-01/02/03/04, CHAOS-01/02 verbatim text
- `CLAUDE.md` — StreamElements vs Streamlabs guidance + `socket.io-client` realtime pattern; "What NOT to Use" (Bits AUP, PubSub retired); single-broadcaster-token default; model policy

### Reused subsystems (read the closest analog before building on it)
- `.planning/phases/01-compliance-gate-kill-switch/01-*-SUMMARY.md` + `src/compliance/gate.ts`, `src/kill-switch/abort.ts` — the single funnel (`classify()` → one `as QueuedTask`), CSRF policy, and the veto/HALTED machinery paid windows MUST route through
- `.planning/phases/02-chat-vote-loop/02-*-SUMMARY.md` + the round/vote loop and twurple EventSub setup — chaos mode swaps this selection strategy; channel-points redemptions extend this EventSub surface
- `.planning/phases/03-sandboxed-build-engine-live-show/03-SECURITY.md` + `03-06-SUMMARY.md` — the build-session the queued paid/chaos task feeds; the never-silent/audit discipline and the machine-enforced-invariant pattern (single-funnel, secrets-isolation source scans) to mirror for the D-08 paid↔chaos separation test

### External docs to (re-)verify during the research pass (D-01)
- StreamElements realtime websocket API docs (`tip` event; JWT auth) — see CLAUDE.md Sources
- Twitch EventSub `channel.channel_points_custom_reward_redemption.add` (broadcaster-scoped) — see CLAUDE.md Sources
- Twitch Bits AUP + Channel Points guidelines — verbatim re-verification (MEDIUM confidence per roadmap)
- Chargeback/refund handling for donations (open research question — determine whether a refunded/charged-back donation must retroactively close/annul a window)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/compliance/gate.ts` `classify()` + the single funnel — paid instructions and chaos-selected tasks enter the queue through THIS, unchanged (PAID-03 guarantee lives here).
- `src/kill-switch/abort.ts` / HALTED machine — free-reign windows are revocable and vetoable by reusing this; no new abort pathway.
- Phase 2 twurple EventSub listener — extend with the channel-points redemption subscription; add a StreamElements `socket.io-client` source alongside it (recommended).
- `better-sqlite3` durable state (queue, tallies, active windows in Phase 3) — the ControlWindow + cooldown + amount→duration ledger persists here to survive a mid-stream crash.
- Phase 3 overlay build panel + audit ledger — surface the active window (donor/countdown) and chaos indicator; record window lifecycle events.

### Established Patterns
- **Single-funnel invariant** (machine-enforced source scan) — the model for D-08's paid↔chaos separation test.
- **Never-silent doctrine** (Phases 2/3) — dropped/queued donations, window open/close, revocation, and chaos picks are all narrated + audited, never silent.
- **Full-state-on-connect + diffs** overlay pattern — active-window/chaos state reconstructs on OBS reconnect.
- **Injected-fakes testing** (Phase 3) — donation/redemption events and the socket sources are faked in tests; no real platform/network in vitest.

### Integration Points
- Donation/redemption event → ControlWindow state machine → (guaranteed) single funnel → gate → build queue.
- Chaos toggle → random-pick selection strategy → single funnel → gate → build queue (RNG confined here, provably absent from the paid path).
- Streamer console: toggle chaos, revoke active window; overlay: active-window countdown + chaos indicator.

</code_context>

<specifics>
## Specific Ideas

- The project's hard compliance requirement is at its sharpest here: money must buy *guaranteed, time-boxed control*, NEVER a compliance exemption, and payment must never be coupled to chance. Both guarantees are locked as machine-checkable invariants (D-06 single funnel, D-08 paid↔chaos separation) rather than left to reviewer vigilance.
- Bits are deliberately excluded as a paid trigger (AUP risk) — donations flow only through the external platform.

</specifics>

<deferred>
## Deferred Ideas

- **Chargeback/refund reconciliation depth** — logging the amount→duration mapping is in scope (PAID-04); complex retroactive annulment of a window on a later chargeback is a research question (D-01) and, unless research deems it compliance-critical, a hardening item beyond the MVP slice.
- **Tiered donation perks / multi-window queueing / donor leaderboards** — new capabilities, not this phase.
- **Bot-account token split** for a separate paid-window rate limit / badge — deferred (CLAUDE.md single-broadcaster-token default) unless a concrete need appears.
- **Persistent cross-stream changelog of paid/chaos builds** — Phase 5 (HIST-01).

### Reviewed Todos (not folded)
- None from the pending-todos list matched Phase 4 scope (the open todos are Phase 3 Wave 0 / UAT and Phase-1/2 residuals).

</deferred>

---

*Phase: 4-Paid Influence & Chaos Mode*
*Context gathered: 2026-07-10*
