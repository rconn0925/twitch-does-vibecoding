# Phase 3: Sandboxed Build Engine & Live Show - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.
> **Mode: --auto** — no user present; Claude selected recommended defaults. The sandbox mechanism (D3-01) was deliberately NOT auto-locked because the roadmap flags it as unvalidated and mandates a spike. Review CONTEXT.md and override before planning if desired.

**Date:** 2026-07-10
**Phase:** 03-sandboxed-build-engine-live-show
**Areas discussed:** Sandbox mechanism, Agent orchestration & model policy, Second compliance pass, Failure/refusal/veto, Live-show surfaces

---

## Sandbox mechanism (D3-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Defer to spike | Roadmap flags WSL2-vs-Docker as unvalidated; require a PoC before locking | ✓ (auto) |
| Lock WSL2 now | Risk: filesystem/secret isolation guarantees unproven on this host | |
| Lock Docker now | Risk: extra process on an already-loaded streaming machine, untested | |

**Auto-selection rationale:** The roadmap explicitly mandates `/gsd:plan-phase --research-phase 3`. Auto-locking a mechanism would defeat the flagged spike. CONTEXT records a *recommendation to test first* (WSL2), not a lock.

---

## Agent orchestration & model policy

| Option | Description | Selected |
|--------|-------------|----------|
| In-process Agent SDK query() | Hook/abort granularity for veto + ToS filter; CLAUDE.md mandate | ✓ (auto) |
| CLI subprocess per turn | CLAUDE.md "What NOT to Use" — no in-process abort | |

**Auto-selection rationale:** CLAUDE.md locks this. Sonnet research / Fable build model split carried from project policy.

---

## Second compliance pass (COMP-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Re-screen plan through the SAME gate | Second call to the single funnel, invariant preserved | ✓ (auto) |
| New dedicated build-plan gate | Duplicates the funnel; breaks single-funnel invariant | |

---

## Failure / refusal / veto

| Option | Description | Selected |
|--------|-------------|----------|
| Refusals + failures as narrated events, veto aborts session | Never silent; Phase 1 abort path reused | ✓ (auto) |
| Silent retry / log-only | Violates BUILD-03 no-dead-air | |

---

## Live-show surfaces

| Option | Description | Selected |
|--------|-------------|----------|
| Extend overlay + separate app-under-construction view | PRES-02/03/04; dev server exposed alone (SAND-02) | ✓ (auto) |
| Single combined surface | Would leak orchestrator/host into the public view | |

---

## Claude's Discretion

COMP-02 in-flight re-screen cadence, transient-vs-terminal retry classification, pipeline-stage granularity, dev-server framework assumptions, orchestrator↔sandbox IPC (spike-informed), build-state schema, workspace persistence-vs-reset.

## Deferred Ideas

- Concurrent builds (locked to one-at-a-time)
- Persistent cross-session project state (planning-time decision)
- Paid/chaos build control (Phase 4)
- End-to-end dry run (Phase 5)
- Change-project consensus vote (unresolved roadmap conflict, carried from Phase 1/2)
