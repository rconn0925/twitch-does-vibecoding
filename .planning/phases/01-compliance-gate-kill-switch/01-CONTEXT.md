# Phase 1: Compliance Gate & Kill Switch - Context

**Gathered:** 2026-07-08
**Status:** Ready for planning

<domain>
## Phase Boundary

The safety spine, built and adversarially tested before any real chat input exists. Three deliverables:

1. **The single compliance chokepoint** — every candidate instruction (from any current or future path: suggestion, vote, channel points, donation window, chaos mode) is normalized to one candidate shape and passes through exactly one gate function before it can become a queued task. Regex/keyword pre-filter + LLM classifier implementing the 13-category taxonomy from `.planning/research/COMPLIANCE.md`, plus a scope/feasibility dimension (see D-13/D-14). No other enqueue path can exist — verified by code review.
2. **The stream-mode state machine** — `IDLE / VOTING_ROUND / BUILD_IN_PROGRESS / FREE_REIGN_WINDOW / CHAOS_MODE / HALTED`, with operator veto as a highest-priority transition from any state.
3. **The operator veto/kill switch** — global hotkey + localhost operator console, with full audit logging of every filter decision and veto.

Not in this phase: Twitch ingestion (Phase 2), chat feedback delivery (COMP-03, Phase 2), the second-pass build-plan screen (COMP-02, Phase 3), agents/sandbox (Phase 3), paid mechanics (Phase 4).

Requirements: COMP-01, COMP-04, COMP-05.

</domain>

<decisions>
## Implementation Decisions

### Kill-switch ergonomics
- **D-01:** Both reach mechanisms: a **global Windows hotkey** (works regardless of which app has focus) as the panic button, plus the **operator console page** for granular actions (veto a specific queued task, force state transitions). 
- **D-02:** The panic hotkey **freezes everything**: transition to HALTED — abort any in-progress work, pause voting/queue, stop accepting input. Nothing is deleted; triage happens from the console.
- **D-03:** Hotkey requires a **double-tap within ~2 seconds** to trigger (accidental-press protection). No other confirmation friction.
- **D-04:** Recovery is **triage then choose**: HALTED shows what was frozen (in-flight task, queue, round state); the streamer explicitly picks resume / discard-offending-task-and-resume / reset to IDLE. Nothing auto-resumes.

### Escalation flow (uncertain classifications)
- **D-05:** Escalated items land in a **console approval queue** — a dedicated "needs review" section with approve/reject per item. No active interruption (no sound/toast); checked between rounds.
- **D-06:** An item that escalates during an active round **misses that round and re-enters the candidate pool** if approved later. Rounds never stall waiting on streamer review.
- **D-07:** Unreviewed escalations **expire at end of stream session** (or after a few hours), logged as `expired-unreviewed` in the audit trail. Review queue starts clean each stream night.
- **D-08:** Gate emits an **honest three-state decision vocabulary**: `approved` / `rejected(category)` / `held-for-review`. Viewers (via Phase 2 chat feedback) will see "held for streamer review" — transparency is part of the show's trust story.

### Classifier model & failure behavior
- **D-09:** The gate classifier runs on **Sonnet** (per-suggestion runtime call; balance of adversarial robustness, latency, cost). This extends the project model policy: Sonnet = research *and* runtime classification; Fable = planning/building.
- **D-10:** Checks run **on submission, asynchronously** — each suggestion is classified immediately in the background; rounds always start from a pre-screened pool.
- **D-11:** On classifier API failure (after retries): **reject with "try again"** feedback — the viewer is told to resubmit shortly. Failed-to-classify items are NEVER held or passed through; fail-open is off the table. (User explicitly chose this over degrading to a manual-review mode.)
- **D-12:** Threshold posture is **lean reject**: uncertain items are rejected with a category; only the explicit gray-zone taxonomy rows (simulated gambling, borderline IP, misinformation/satire — per COMPLIANCE.md's "streamer judgment" list) escalate to the review queue. Minimize live review load.

### Scope/feasibility screening (user-raised requirement)
- **D-13:** The gate screens a **feasibility/scope dimension alongside the 13 content categories**: suggestions that are compliant but too long/expensive/boring to build live (e.g., "research every chess position") are **rejected with suggest-trim feedback** — "too big for a live build, try a smaller version", optionally naming a trimmed variant.
- **D-14:** The feasibility yardstick assumes the **one-big-ongoing-project format**: the stream builds one project; suggestions are judged as *increments* to the current project ("buildable as one demoable step"), not as whole apps.
- **D-15:** **"Change project" is a special instruction type**, distinct from a normal suggestion. Two future paths can trigger it: chat-wide consensus vote (mechanic lands in Phase 2) and a sufficiently large donation granting one user the switch (mechanic lands in Phase 4). Phase 1's job: the gate's classification vocabulary and the state machine must recognize a project-switch event type so Phases 2/4 don't need to rearchitect.

### Audit log
- **D-16:** Each record stores the **full picture: suggestion text, Twitch username, decision, category, classifier rationale, timestamps**. Identity is needed for repeat-offender tracking; retention limits keep it within Twitch Developer Agreement expectations.
- **D-17:** Retention is **90 days rolling** with an auto-purge job.
- **D-18:** Vetoes/halts capture **optional one-tap reason tags** (e.g., ToS risk / boring / too big / gut feeling / other) — tappable or skippable, zero mid-incident friction; tags feed post-stream filter tuning.

### Claude's Discretion
- **Audit review surface:** user said "you decide" on console audit page vs raw structured logs. Recommendation: since the console already exists in this phase (UI hint: yes) and D-05/D-18 already put review workflows in it, a simple filterable audit page is the natural fit — but Claude may scope it to structured logs + minimal page if console work balloons.
- Hotkey implementation tech (global hook library vs alternative), console page layout/aesthetics (streamer-only, function over form), SQLite schema, exact retry/timeout budgets for classifier calls, adversarial fixture-suite composition.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Compliance rules (drives the gate's classifier)
- `.planning/research/COMPLIANCE.md` — the 13-category filter taxonomy (§1) with per-category block/escalate actions and example rejections; platform rules for bot behavior (§2); Anthropic Usage Policy layer (§4); the "streamer judgment is the backstop" list. This file IS the gate's rule set.

### Architecture & sequencing
- `.planning/research/SUMMARY.md` — single-funnel invariant, state-machine states, two-pass filter design, phase sequencing rationale, and research flags (adversarial test suite design is research-adjacent for this phase).
- `.planning/research/ARCHITECTURE.md` — component boundaries (compliance gate as isolated testable chokepoint; state machine never talks to Claude directly; operator console as separate localhost server from the public overlay).
- `.planning/research/PITFALLS.md` — pitfall list this phase must design against: filter as single point of trust, prompt injection via suggestion text, kill switch built as an afterthought.

### Stack (locked)
- `.planning/research/STACK.md` and `CLAUDE.md` (Technology Stack section) — Node 24 + TypeScript 6, `better-sqlite3`, Express 5 + `ws`, `zod` at every untrusted boundary, `pino` logging, vitest, Biome.

### Project frame
- `.planning/PROJECT.md` — hard compliance requirement, model policy, live-reliability constraint.
- `.planning/REQUIREMENTS.md` — COMP-01, COMP-04, COMP-05 verbatim.

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield — no source code exists yet (repo contains only `CLAUDE.md` and `.planning/`). This phase establishes the foundational patterns everything else builds on:

### Patterns this phase establishes
- `shared/types.ts` / `shared/events.ts` — the normalized candidate shape (`SuggestionCandidate` → gate → `QueuedTask`) and event vocabulary, per ARCHITECTURE.md's suggested structure. Include a project-switch event type (D-15).
- The compliance gate as a standalone, unit-testable module — fixture suite spans all 13 taxonomy categories + feasibility + adversarial cases (paraphrase, obfuscation, encoding tricks, prompt-injection strings).
- The state machine as the single source of truth for "what can chat currently do."

### Integration points (future phases plug into this)
- Phase 2 (Twitch ingestion) feeds normalized candidates INTO the gate; delivers the gate's three-state decisions as chat feedback.
- Phase 3 (build engine) consumes `QueuedTask`s and re-uses the gate for the second pass; the veto's abort semantics must be able to kill an agent session.
- Phases 2/4 implement the project-switch mechanics against the event type defined here.

</code_context>

<specifics>
## Specific Ideas

- **"Research every chess position" is the user's canonical oversized-task example** — the feasibility check exists specifically to keep token-burning, viewer-boring tasks out of the queue.
- **One big ongoing project is the intended show format** — not many small throwaway builds per night. Feasibility judgments, and eventually the overlay/preview, should assume an evolving single codebase.
- The double-tap-to-confirm hotkey choice signals the user weights accidental-halt prevention over the absolute fastest halt — but the halt must still resolve within seconds once triggered (success criterion 3).
- The user consistently chose low-interruption options (no attention pings, lean-reject, optional reason tags): the operator console is a between-rounds surface, not an alarm system.

</specifics>

<deferred>
## Deferred Ideas

- **Project-switch by chat consensus vote** — when "everyone in chat" wants to change projects, a vote mechanic should allow it. Belongs in Phase 2 (Chat Vote Loop). Phase 1 only defines the event type.
- **Project-switch purchasable by large donation** — one user changing the project via a big-enough donation. Belongs in Phase 4 (Paid Influence). Same gate, same veto, per PAID-03.

</deferred>

---

*Phase: 1-Compliance Gate & Kill Switch*
*Context gathered: 2026-07-08*
