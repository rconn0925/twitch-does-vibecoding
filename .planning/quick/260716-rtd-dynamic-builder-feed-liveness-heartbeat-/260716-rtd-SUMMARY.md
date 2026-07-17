---
phase: quick-260716-rtd
plan: 01
subsystem: overlay-terminal
tags: [builder-terminal, liveness, typewriter-pacing, obs, client-side-only]
requires: []
provides:
  - "Client-side thinking heartbeat in THE AI terminal (elapsed time + files ticker) during quiet gaps ≥10s"
  - "Burst-proof typewriter pacing: typing debt bounded ≤ ~10s; bursts ≥8K chars blit instantly"
affects: []
tech-stack:
  added: []
  patterns:
    - "Ephemeral in-place status row (\\r + ESC[2K, no trailing newline) that never enters wire-facing structures"
    - "Caption-sync test drives a REAL createBuilderFeed instance so server caption drift breaks CI"
key-files:
  created: []
  modified:
    - scripts/builder-terminal.ts
    - tests/scripts/builder-terminal.test.ts
    - docs/OPERATIONS.md
key-decisions:
  - "isBuildInFlight fails closed: undefined/stage-warn/done-caption/unknown kinds all → false; only the closed in-flight kinds → true"
  - "fileStatsFromFeed recomputes wholesale from the ≤300-line feed on every accepted push — naturally correct across reset diffs and ring drops, no incremental state to rot"
  - "paceCharsPerTick: ceil(backlog/40) decay (~2s constant) below BURST_DRAIN_CHARS=8000, full one-tick blit at/above — proven ≤10s drain from both 16000 and 7999 by simulation test"
  - "Status line lifecycle: clearStatus() FIRST in paintAll/paintIdle/drainTick(backlog>0)/socket-close — the line is fully self-erasing, needsRepaint never touched"
metrics:
  duration: ~7 min
  completed: 2026-07-17T02:15:00Z
  tasks: 2
  tests: "1326 passed (+23 over 1303 dispatch baseline; 24 new/re-pinned in builder-terminal.test.ts)"
---

# Quick Task 260716-rtd: Dynamic Builder-Feed Liveness Heartbeat Summary

**One-liner:** Client-side "the AI is thinking — 2m 40s in…" heartbeat with a files ticker in THE AI terminal during ≥10s quiet gaps, plus burst-drain typewriter pacing (≥8K chars blit instantly, debt ≤ ~10s) — zero new wire bytes, src/ byte-identical.

## What Was Built

### Task 1 — Pure liveness helpers + burst-drain pacing (TDD)

New exported pure functions in `scripts/builder-terminal.ts`:

- `formatElapsed(ms)` — "40s" / "2m 40s" / "1h 5m" buckets; negative/NaN clamp to "0s".
- `isBuildInFlight(lastLine)` — fail-closed in-progress predicate on the LAST feed line: false for undefined, `stage-warn`, the done caption ("Live on screen now"), and any unknown kind; true for title/other stage/activity/reasoning/tool-call/diff. Pinned by a **caption-sync test** that drives a real `createBuilderFeed()` instance through `stage("done"/"building"/"failed")` — server caption drift breaks CI instead of silently rotting the predicate (T-rtd-04).
- `fileStatsFromFeed(feed)` — distinct "Writing "/"Editing " path counts + lastPath, recomputed wholesale (≤300 lines); malformed/mimicking lines contribute nothing.
- `thinkingStatusLine(quietMs, stats)` — null under `THINKING_QUIET_MS` (10s); otherwise ONE dim line, calm copy, files ticker only when files exist, `lastPath` re-passes `sanitizeWireText` (T-rtd-01), plain text truncated to LINE_MAX, DIM open + RESET close only (exactly 2 ESC bytes, test-pinned).
- Pacing rework: `BURST_DRAIN_CHARS = 8_000`; `paceCharsPerTick` returns the whole backlog at/above it (instant blit), else `max(7, ceil(backlog/40))` (~2s decay vs the old 10s). Drain-bound simulation test proves ≤10s ticks from both 16 000 and 7 999 chars.

### Task 2 — CLI status-line lifecycle wiring + docs

- `main()` state: `connected` / `lastRenderActivityAt` (refreshed on reset repaints and rendered appends) / `statusActive` / `stats` (recomputed in `handleMessage` on every accepted push).
- `clearStatus()` writes `\r ESC[2K` only when a status row is live; called FIRST in `paintAll`/`paintIdle`, in `drainTick` when backlog > 0, and in the socket `close` handler before the waiting line — the heartbeat is fully self-erasing and never sets `needsRepaint`.
- `statusTick()` on a 1s interval: bails to `clearStatus()` unless connected + backlog empty + `isBuildInFlight(last)`; otherwise repaints `\r ESC[2K <line>` in place with no trailing newline.
- Header comment documents the liveness doctrine (never enters wire/feed/backlog; DIM only; T-ly4-01/02 wording binding) and the new ≤ ~10s typing-debt bound.
- `docs/OPERATIONS.md` §10: heartbeat bullet — long thinking passes are healthy and now visibly alive; plus the burst-blit note in the lag paragraph.

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| 2e0161e | test | Failing tests for liveness helpers + burst-drain pacing (RED) |
| 1a1f41d | feat | Liveness helpers + burst-drain typewriter pacing (GREEN) |
| d2266b3 | feat | Thinking status line + files ticker wiring in the CLI shell + docs |

## Verification

- `npx vitest run` — **1326 passed / 0 failed** (dispatch baseline ≥1303; includes concurrent rll additions).
- `npx tsc --noEmit` clean; `npx biome check .` exit 0 (3 pre-existing warnings in `src/overlay/public/overlay.css`, untouched/out of scope).
- `git diff --name-only c4073fd..HEAD` → exactly `scripts/builder-terminal.ts`, `tests/scripts/builder-terminal.test.ts`, `docs/OPERATIONS.md`. **src/ byte-identical** (rail held; concurrent 260716-rll files untouched).
- Grep gates: `includePartialMessages` in scripts/builder-terminal.ts → 0; `heartbeat` in src/overlay/builder-feed.ts → 0.
- Compliance rails: status line is DIM-only calm copy (no red, test-pinned); composed only from elapsed time, local counters, and already-screened re-sanitized activity paths; never enters `lastFeed`/backlog/any wire structure.

## Deviations from Plan

None - plan executed exactly as written. (Biome reordered imports/formatted the new code before the Task 2 commit — cosmetic, same-file, no behavior change.)

## Known Stubs

None.

## Threat Flags

None — no new surface beyond the plan's threat model; T-rtd-01/-04 mitigations implemented and test-pinned, T-rtd-02/-03 accepted per register.

## Deploy Note (do not perform from the worktree)

`builder-terminal` is a live real-terminal process — the heartbeat + pacing take effect on the **next launch of THE AI window** per the startup ritual (wt profile line in OPERATIONS.md §10). No OBS browser-source refresh applies to this window (window capture, not CEF).

## Self-Check: PASSED

- FOUND: scripts/builder-terminal.ts (all 7 new/changed exports present)
- FOUND: tests/scripts/builder-terminal.test.ts (contains "isBuildInFlight" + createBuilderFeed caption-sync)
- FOUND: docs/OPERATIONS.md §10 heartbeat bullet
- FOUND: commits 2e0161e, 1a1f41d, d2266b3 on worktree-agent-a92d15d74e00a6873
