# Phase 5: Build History & Stream Night Dry Run - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.
> **Mode: --auto** — no user present; Claude selected recommended defaults grounded in ROADMAP.md, CLAUDE.md, and shipped Phase 1–4 patterns.

**Date:** 2026-07-10
**Phase:** 05-build-history-stream-night-dry-run
**Areas discussed:** Changelog data/persistence, Presentation surface, Compliance of an audience-facing history, Stream-night dry-run gate

---

## Changelog data source (D-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Derive from the existing durable ledger (view/query; add a build_history record only if lossy) | No parallel source of truth; reuses Phase 1–4 audit/build state | ✓ (auto) |
| New standalone history store | Duplicates the ledger; risk of divergence from the record-of-truth | |

---

## Presentation surface (D-04)

| Option | Description | Selected |
|--------|-------------|----------|
| New read-only served page (overlay/preview/console pattern), loopback, coarse projection | Reuses the shipped served-surface + dom-safety discipline; safe to screen-share | ✓ (auto) |
| Reuse the overlay | Would conflict with the live broadcast overlay's real-time role | |

---

## Compliance of an audience-facing history (D-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Show ONLY gate-approved suggestions + honest outcomes; never pre-gate/banned text; textContent-only | Prevents re-broadcasting disallowed content on a public page; XSS-safe | ✓ (auto) |
| Show all suggestions incl. rejected | Would re-broadcast content the gate exists to keep off-stream — rejected | |

---

## Stream-night dry run (D-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Documented runbook/checklist (autonomous:false) consolidating the deferred human gates into one end-to-end rehearsal | Matches the 04-08 live-gate pattern; the dry run IS the human acceptance of success criteria 2/3/4 | ✓ (auto) |
| Attempt to automate the dry run | The dry run's whole point is a real test-channel rehearsal — not automatable | |

---

## Claude's Discretion

build_history schema vs. view-over-ledger (research-informed); pagination/scroll-cap size; stream-night session-key derivation; changelog styling within the shipped design tokens + dom-safety discipline.

## Deferred Ideas

- Screenshots/thumbnails of built apps (v2 — capture pipeline)
- Public/remote changelog hosting beyond localhost (v2)
- Cross-project history / analytics / leaderboards (v2)
