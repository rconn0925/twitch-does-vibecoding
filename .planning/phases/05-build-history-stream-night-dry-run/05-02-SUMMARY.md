---
phase: 05-build-history-stream-night-dry-run
plan: 02
subsystem: ui
tags: [express, zod, changelog, textContent, dom-safety, pagination, loopback, obs]

# Dependency graph
requires:
  - phase: 05-01
    provides: "build_history table + listBuildHistory (reverse-chrono, bounded limit + beforeMs cursor) + BuildHistoryRow, and recordBuildHistory written from finalize()"
  - phase: 03 (preview surface)
    provides: "src/preview/server.ts — the read-only loopback served-surface pattern (isLoopbackHostHeader 403 guard, express.static, no ws, no express.json) copied wholesale"
  - phase: 04 (overlay provenance chip)
    provides: "overlay.js el()/truncate() dom-safety helpers + the .provenance-chip vocabulary (VOTE / FREE REIGN / CHAOS PICK) reused here"
provides:
  - "A fourth read-only localhost surface: GET /history (page) + GET /api/history (paginated JSON), loopback-bound, no ws, no mutating routes"
  - "Coarse public projection of build_history: { buildId, title, provenance(vote|paid|chaos), result, timeLabel } grouped into stream-nights — donation|channel_points coarsened to 'paid' at the server boundary; donor/amount/trigger/rationale/category dropped"
  - "The audience-facing changelog page (history.html/css/js): textContent-only render, provenance chips, result badges (no red), empty + non-red error states, Load-older-nights pagination"
  - "startHistoryServer wired into main.ts as a separate served surface with AppHandle.close() teardown"
affects: [dry-run, stream-night, HIST-01, future-history-features]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Served-surface COPY pattern: a new read-only loopback surface is a copy of preview/server.ts (403 host guard first, express.static, 127.0.0.1 listen, close() = closeAllConnections + server.close) with exactly one validated GET route"
    - "Coarse-projection-at-the-wire: the 4-value DB provenance collapses to a 3-value public vocabulary at the server boundary; the response type carries only the fields the audience may see; an e2e asserts the absence of dropped fields in the serialized bytes"
    - "Derived-on-read night grouping: stream-nights are local-calendar-day buckets of created_at_ms computed on read (no session/day column), 10 nights/page over a generous listBuildHistory row cap"

key-files:
  created:
    - "src/history/server.ts — loopback read-only Express surface + GET /api/history (coarsen + night-group + paginate)"
    - "src/history/server.test.ts — 15 behavior cases against a seeded in-memory db"
    - "src/history/public/history.html — static shell + single <script src>"
    - "src/history/public/history.css — reused console type scale + dark palette + Phase-4 tokens; no new colors, no red"
    - "src/history/public/history.js — textContent-only render, chips/badges/states, Load-older pagination"
    - "tests/e2e/build-history.e2e.test.ts — finalize()→persist→render vertical slice + pagination"
  modified:
    - "src/main.ts — startHistoryServer composition (own port, HISTORY_PORT default 4903) + close-chain teardown + AppHandle.history"

key-decisions:
  - "buildId is the string form of the build_history row id — a stable, non-sensitive handle carrying no donor/task detail"
  - "hasOlder = (distinct nights fetched > page limit) OR (row cap saturated AND nights >= limit) — a bounded, D-04-acceptable heuristic for v1"
  - "History server starts unconditionally (pure read-over-db), unlike the preview surface which is gated on the orchestrator — safe to start in tests against the in-memory db"
  - "chip background uses --dominant (not --secondary) because the chip sits on a Secondary-colored entry row — needed contrast without introducing a new token"

patterns-established:
  - "Read-only served-surface copy of preview/server.ts for any future audience-facing localhost page"
  - "Coarse-projection wire type + serialized-bytes absence assertion for any surface crossing a trust boundary"

requirements-completed: [HIST-01]

# Metrics
duration: ~35min
completed: 2026-07-10
---

# Phase 5 Plan 02: Served Build-History Changelog Summary

**A fourth read-only loopback surface — GET /history + GET /api/history — that renders the durable build_history ledger as a night-grouped, screen-shareable public changelog, coarsening 4-value provenance to vote|paid|chaos and dropping every donor/financial/trigger detail at the wire boundary, with a textContent-only, no-red page.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-10T07:32:00Z
- **Completed:** 2026-07-10T07:41:00Z
- **Tasks:** 3
- **Files created:** 6 · **Files modified:** 1

## Accomplishments
- Read-only, loopback-bound history server copied from preview/server.ts: `isLoopbackHostHeader` 403 guard as first middleware, `express.static`, 127.0.0.1 listen, no `express.json()`, no POST/PUT/DELETE/PATCH, no WebSocket — read-only by construction (D-04, T-05-07).
- One validated `GET /api/history`: night-grouped (local-day buckets, reverse-chrono), 10-nights-per-page with `hasOlder` + `?before=` cursor, 50-entry/night defensive cap + overflow, zod-bounded query → 400.
- Coarse public projection (T-05-05): the wire carries only `{ buildId, title, provenance(vote|paid|chaos), result, timeLabel }` plus server-formatted `nightKey/nightLabel/entryCountLabel`; `donation|channel_points` collapse to `paid`; donor identity, amount, trigger-type, rationale, category, task id, and raw timestamps are never selected in.
- The changelog page: textContent-only render (dom-safety invariant green), 100-char title truncation, provenance chips (VOTE / FREE REIGN violet / CHAOS PICK), result badges (Built green / Refused, Failed amber — never red), empty state, a calm non-red error card, and Load-older-nights pagination. Both non-blocking UI-checker flags addressed (declared focal point; non-red error box).
- `startHistoryServer` wired into `main.ts` as a separate surface (HISTORY_PORT default 4903), torn down in the existing `AppHandle.close()` chain before `db.close()`.
- End-to-end vertical slice: real `createBuildSession.startBuild → finalize()` persists a build_history row that renders on `/api/history` with correct night bucket, coarsened provenance, and honest result; a `finalizeAborted` build writes zero rows and never appears; the serialized wire leaks none of the dropped fields; pagination proven over multi-day seeded rows.

## Task Commits

Each task was committed atomically:

1. **Task 1: read-only /history server + main.ts wiring** - `494b05f` (feat)
2. **Task 2: changelog page html/css/js** - `7e7e485` (feat)
3. **Task 3: end-to-end vertical-slice test** - `bb38c6c` (test)

**Plan metadata:** committed separately (docs: complete plan — this SUMMARY + deferred-items).

## Files Created/Modified
- `src/history/server.ts` - Loopback read-only Express surface; GET /api/history coarsens provenance, buckets into stream-nights, paginates (10/page).
- `src/history/server.test.ts` - 15 behavior cases (grouping, coarsening, no-leak, pagination, overflow cap, 400s, 403 host guard, no-ws/no-json source scan).
- `src/history/public/history.html` - Static shell + single `<script src>`, no inline JS; focal point + XSS-safety noted in-source.
- `src/history/public/history.css` - Console type scale + dark palette + Phase-4 tokens; zero new colors, no red; accent reserved for Load-older button; non-red error card.
- `src/history/public/history.js` - textContent-only render via el()/truncate(); chips, badges, states, pagination; zero innerHTML.
- `tests/e2e/build-history.e2e.test.ts` - finalize()→persist→render slice across all provenances/results + abort-absence + no-leak + pagination.
- `src/main.ts` - `startHistoryServer` composition, `AppHandle.history`, close-chain teardown, `historyPort`/HISTORY_PORT.

## Decisions Made
- `buildId` = string form of the row id (stable, non-sensitive; carries no donor/task detail).
- `hasOlder` uses a bounded heuristic (distinct nights > limit, or a saturated row cap) — D-04-acceptable for a single-streamer v1.
- History server starts unconditionally (pure read-over-db), unlike the orchestrator-gated preview surface — safe in tests against the in-memory db.
- Chip background uses `--dominant` for contrast against the `--secondary` entry row (no new token).

## Deviations from Plan

None - plan executed exactly as written. All three tasks landed as specified; no Rule 1-4 deviations were required.

## Issues Encountered
- Two initial test failures were false-positive substring leaks: test titles ("donor pick", "donation window build") literally contained the words the no-leak assertion forbids. Fixed by using neutral titles and asserting against actual leak indicators (DB provenance values, server-side field names, task ids) rather than generic English words that can legitimately appear in a chat-derived title. The server projection itself was correct throughout.

## Deferred Issues
- Project-wide `biome check src tests scripts` reports 4 pre-existing CRLF line-ending formatter errors in files NOT touched by this plan (`src/audit/db.ts`, `src/compliance/categories.ts`, and two `src/compliance/fixtures/*.ts`). All 05-02 files pass `biome check` cleanly. Logged to `deferred-items.md`; left as-is per the scope boundary (only auto-fix issues directly caused by the current task).

## User Setup Required
None - no external service configuration required. The history surface is a pure read-over-db localhost page; open `http://127.0.0.1:$HISTORY_PORT/history` (default 4903) in a browser tab or OBS browser source.

## Verification
- `src/history/server.test.ts` (15), `tests/invariants/dom-safety.test.ts` (4), `tests/e2e/build-history.e2e.test.ts` (2) all green.
- Full suite: **662 passed** (645 baseline + 15 server + 2 e2e). `tsc --noEmit` clean. `biome check` clean on all 05-02 files.

## Next Phase Readiness
- HIST-01's browsable-page half is complete: the audience-facing changelog is live on localhost, read-only, loopback-bound, screen-shareable, injection-safe, and honest. Ready for the stream-night dry-run.
- No blockers introduced. Pre-existing CRLF formatter noise is tracked in deferred-items.md.

## Self-Check: PASSED

All created files verified present on disk; all three task commits (494b05f, 7e7e485, bb38c6c) verified in git history.

---
*Phase: 05-build-history-stream-night-dry-run*
*Completed: 2026-07-10*
