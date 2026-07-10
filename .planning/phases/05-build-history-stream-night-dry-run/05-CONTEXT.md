# Phase 5: Build History & Stream Night Dry Run - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

> **Mode: --auto** — no user present; Claude selected recommended defaults grounded in ROADMAP.md, CLAUDE.md, and the shipped Phase 1–4 patterns. This is the final v1 phase; its buildable deliverable is small (the changelog page) and most of its success criteria ARE the human dry-run rehearsal. Review CONTEXT.md and override before planning if desired.

<domain>
## Phase Boundary

Phase 5 is the **v1 finish line**. It delivers exactly one piece of new software plus a human acceptance rehearsal:

1. **Build-history changelog (HIST-01 — the ONLY code deliverable):** winning/selected suggestions and their build results persist to a browsable, audience-facing changelog page ("the audience built this together") that survives process restarts AND spans multiple stream nights. It reads from the durable state already written by Phases 1–4 (audit ledger + build results + round winners + control-window ledger) and presents a read-only, reverse-chronological list grouped by stream night.

2. **Stream-night dry run (HUMAN GATE — success criteria 2/3/4):** a full end-to-end rehearsal on a low-stakes test channel that exercises every mode (suggest → filter → vote → build → live preview, plus a real small donation free-reign window and a chaos-mode round), exercises the kill switch against a GENUINELY in-progress build, and confirms from the audit log that zero unfiltered inputs reached an agent and every rejection produced chat feedback. This is not code — it is the final acceptance rehearsal, and it necessarily runs AFTER the deferred Phase 3 Wave 0 (WSL2) and Phase 4 live gates are cleared, since the dry run exercises them.

**In scope:** the changelog persistence model (grouping across stream nights) + the served, read-only changelog page + a dry-run runbook/checklist that ties together the already-deferred human gates into one rehearsal.
**Out of scope (deferred):** screenshots/thumbnails of built apps, public/remote hosting of the changelog beyond localhost, cross-project history, analytics.
</domain>

<decisions>
## Implementation Decisions

### Changelog data & persistence (HIST-01)
- **D-01:** The changelog is DERIVED from the existing durable `better-sqlite3` state — it does not introduce a parallel source of truth. A build-history record (build id, gate-APPROVED suggestion title, provenance = vote-winner|paid-window|chaos-pick, result = built|refused|failed, timestamp, stream-night/session grouping key) is persisted at build-completion time. If Phase 3/4's audit ledger already captures all of these, the changelog reads a VIEW/query over it; only add a dedicated `build_history` record if the ledger cannot reconstruct an entry losslessly (planner/research to confirm against the shipped `audit/schema.sql` + pipeline_stage rows).
- **D-02:** Cross-stream-night persistence + grouping: entries survive process restarts (already true — SQLite is durable) and are grouped by **stream night** (a session/day key). Reverse-chronological (newest night first).
- **D-03 (compliance — load-bearing):** the changelog shows ONLY gate-APPROVED suggestions and their honest build outcome. It MUST NEVER surface pre-gate or banned/rejected suggestion text (that would re-broadcast disallowed content on an audience-facing page). A `refused`/`failed` entry shows the outcome for a suggestion that had ALREADY passed the intake gate but failed/was-refused later (e.g. COMP-02 in-flight or a build error) — never raw rejected-at-intake text. Suggestion text is chat-derived UNTRUSTED → textContent-only + truncation (dom-safety invariant, the T-03-15/T-04-12 XSS discipline).

### Changelog presentation surface
- **D-04:** A new read-only page served by the existing Express server, following the shipped served-surface pattern (overlay/preview/console) — loopback-bound, full-state-on-load, no host/orchestrator internals, no donor financial detail (coarse projection discipline carried from Phases 3/4). Paginated or scroll-capped so a long history stays performant. For v1 it is localhost-served like the other surfaces (public/remote hosting deferred); it is nonetheless the "audience-facing" artifact and must be safe to screen-share.
- **D-05:** Per-entry display = suggestion title + provenance chip (vote / paid / chaos, reusing the Phase-4 provenance vocabulary) + result state + timestamp. No screenshots/thumbnails in v1.

### Stream-night dry run (human acceptance gate)
- **D-06:** The dry run is a documented RUNBOOK + checklist (like Phase 4's 04-08 live gate), not autonomous code. It consolidates the previously-deferred human gates into ONE end-to-end rehearsal on a test channel: Phase-3 Wave-0 WSL2 GO must be recorded first; Phase-4 StreamElements/redemption live binding must be set up; then a full loop is run (suggest→filter→vote→build→preview), plus a real small donation window, a chaos round, a kill-switch-against-in-progress-build test, and an audit-log review proving zero unfiltered inputs reached an agent and every rejection produced chat feedback. Mark the plan `autonomous: false`.

### Model policy & scope
- **D-07:** Minimal agent/LLM work; the Sonnet-research / Fable-build split is unchanged and largely dormant. The changelog is orchestration + a served read-only page + a persistence query.

### Claude's Discretion
- Exact `build_history` schema vs. a query-over-ledger view (research-informed against the shipped audit schema); pagination/scroll-cap size; the stream-night session-key derivation (calendar date vs. explicit session id); changelog page styling (reuse the shipped design tokens / dom-safety discipline).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 5: Build History & Stream Night Dry Run" — goal, HIST-01, 4 success criteria
- `.planning/REQUIREMENTS.md` — HIST-01 verbatim
- `CLAUDE.md` — served-surface / OBS-browser-source pattern; better-sqlite3 durability rationale; model policy

### Reused subsystems (read the closest analog before building on it)
- `src/audit/schema.sql` + `src/audit/record.ts` — the durable ledger the changelog reads from (pipeline_stage rows, round winners, control_windows); confirm whether an entry can be reconstructed losslessly or a dedicated `build_history` record is needed
- `src/preview/server.ts` + `src/overlay/server.ts` — the served read-only-surface pattern (loopback bind, full-state-on-load, textContent-only) the changelog page mirrors
- `.planning/phases/03-.../SANDBOX-SETUP.md` (Wave 0 gate) + `.planning/phases/04-.../04-08-PLAN.md` (live gate) — the deferred human gates the dry-run runbook consolidates and depends on
- `docs/OPERATIONS.md` (if present — the Phase 2 runbook) — extend with the dry-run rehearsal procedure

### External docs
- No new external integrations in this phase — the changelog is internal. (The dry run exercises the already-integrated Twitch/StreamElements surfaces.)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `better-sqlite3` durable state + `src/audit/` ledger — the changelog's source of truth; no new persistence engine.
- The served-surface trio (overlay/preview/console servers) — the changelog page reuses this Express + loopback + full-state pattern.
- Phase-4 provenance vocabulary (vote / paid / chaos) — reused for the per-entry provenance chip.
- dom-safety invariant + textContent-only discipline — auto-covers the new changelog public JS.

### Established Patterns
- Coarse public projection (Phases 3/4) — the changelog exposes no host internals, no donor financial detail.
- Never-silent + audit-as-record-of-truth — the changelog is a read VIEW of that record, and the dry run's success criterion 4 is literally an audit-log review.
- Injected-fakes testing — the changelog persistence + page are unit/e2e-tested against fake ledger data; no live channel in vitest.

### Integration Points
- Build-completion (Phase 3 done / Phase 4 paid+chaos build loop) → persist/observe a changelog entry → served changelog page.
- The dry-run runbook ties the kill switch (Phase 1), the live Twitch loop (Phase 2), the sandbox (Phase 3 Wave 0), and paid/chaos (Phase 4 live gate) into one rehearsal.

</code_context>

<specifics>
## Specific Ideas

- HIST-01's framing — "the audience built this together" — makes the changelog a celebratory, shareable artifact; keep it honest (real results, including refused/failed) but safe (never re-broadcast disallowed content, D-03).
- Phase 5 is where v1 is declared DONE = first real stream night; the dry run is the go-live rehearsal, so it deliberately runs after all earlier human gates clear.

</specifics>

<deferred>
## Deferred Ideas

- Screenshots/thumbnails of the built apps in the changelog (v2 — needs a capture pipeline).
- Public/remote hosting of the changelog beyond localhost (v2).
- Cross-project / cross-milestone history, analytics, "most-voted" leaderboards (v2).

### Reviewed Todos (not folded)
- The two big deferred human gates (Phase 3 Wave 0, Phase 4 04-08) are PRECONDITIONS the dry-run runbook depends on — folded into D-06, not deferred away.

</deferred>

---

*Phase: 5-Build History & Stream Night Dry Run*
*Context gathered: 2026-07-10*
