---
phase: 05-build-history-stream-night-dry-run
reviewed: 2026-07-10T00:00:00Z
depth: deep
files_reviewed: 12
files_reviewed_list:
  - src/history/server.ts
  - src/history/public/history.js
  - src/history/public/history.html
  - src/history/public/history.css
  - src/audit/record.ts
  - src/audit/schema.sql
  - src/orchestrator/build-session.ts
  - src/main.ts
  - src/shared/types.ts
  - src/history/server.test.ts
  - tests/e2e/build-history.e2e.test.ts
  - src/orchestrator/build-session.test.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-07-10T00:00:00Z
**Depth:** deep
**Files Reviewed:** 12
**Status:** issues_found → **RESOLVED** (all 4 warnings + IN-01, IN-03 fixed; IN-02, IN-04 accepted as documented D-08 deferrals)

## Resolution (2026-07-10)

All four warnings and two of the info items were fixed; 663 tests pass, tsc + biome clean.

- **WR-01** — added a dedicated `MAX_NIGHTS_PER_PAGE` constant; the nights-per-page `.max()` bound no longer piggybacks on the per-night entry cap. `?limit=51` still 400s (value preserved, meaning decoupled).
- **WR-02** — `before` now validates calendar validity via `isValidNightKey` (exact round-trip), so `2026-13-45` / `2026-00-00` / `2026-02-30` return 400 instead of silently rolling over. New test locks this.
- **WR-03** — client `RESULT`/`CHIP` lookups no longer fall back to the celebratory value; an unrecognized result/provenance renders a muted `result-unknown` / `chip-unknown` ("Unknown" / "BUILD"), never a green "Built" or a "VOTE" chip. Server still whitelists both, so this is defense-in-depth.
- **WR-04** — `hasOlder` is now `nightOrder.length > limit || capHit`; a single night larger than `ROW_CAP` no longer strands older nights behind a vanished "Load older" control.
- **IN-01** — `buildId` dropped from the wire entirely (was dead on the client and weakly disclosed the lifetime build count). Exact-keys tests updated to the four-field shape.
- **IN-03** — `coarsenProvenance` is now whitelist-only: `vote`/`chaos` pass through, everything else → `paid`; no unexpected DB string is ever echoed to the audience wire.
- **IN-02, IN-04** — accepted for v1: both are consequences of the deferred D-08 review-queue routing and are explicit/audited, not silent. Revisit when D-08 lands.

## Summary

The build-history changelog surface (HIST-01) is small, disciplined, and genuinely well-tested. I verified each of the phase's stated compliance/privacy invariants against the actual code and the actual tests, tracing call chains across `main.ts` → `build-session.ts` → `record.ts` → `history/server.ts`:

- **D-03 (no disallowed text reaches the public page): HOLDS by construction.** `build_history.title` is written ONLY by `recordBuildHistory`, which grep confirms has exactly one call site — `finalize()` at `build-session.ts:380` — operating on a branded `QueuedTask` with `title: task.text`. `finalizeAborted()` writes zero history rows (verified in source and non-vacuously asserted by both the unit test `build-session.test.ts:1022` and the e2e `build-history.e2e.test.ts:305`). No `UPDATE`/`DELETE` path against `build_history` exists at the application layer (append-only).
- **Coarse public projection: HOLDS.** `/api/history` serializes exactly `{buildId, title, provenance, result, timeLabel}`; `coarsenProvenance` collapses `donation|channel_points → paid` server-side inside `buildHistoryPage`. The e2e asserts against the **raw serialized bytes** (`raw.not.toContain("donation")`, forbidden field-name list, and `Object.keys(entry).sort()` equals exactly the five fields) — these are non-vacuous.
- **XSS: HOLDS.** `history.js` renders every text node via `el()`/`textContent`; grep confirms no `innerHTML`/`insertAdjacentHTML`/`document.write` sink. Title is `textContent` + truncated to 100 chars.
- **Read-only + loopback: HOLDS.** `isLoopbackHostHeader` is the first middleware (403), listen host pinned to `127.0.0.1`, no `express.json`, no mutating routes, no `ws` — faithfully copied from `preview/server.ts` and asserted by source-scan + behavioral tests.
- **Provenance wiring: HOLDS.** `currentProvenance` is a single slot set at `runPipeline` start (not `startBuild`), safe under concurrency-1; retry preserves the original value; per-driver provenance is threaded explicitly in `main.ts` and covered by non-vacuous per-value unit tests.

No BLOCKER-class defect was found. The findings below are real quality/robustness defects and one screen-share-honesty risk that the phase explicitly asked to be flagged.

## Warnings

### WR-01: `limit` page-size cap reuses the wrong constant (`MAX_ENTRIES_PER_NIGHT`)

**File:** `src/history/server.ts:99`
**Issue:** The `ChangelogQuerySchema.limit` field is documented as "a bounded nights-per-page limit" and defaults to `DEFAULT_NIGHTS_PER_PAGE` (10), but its `.max(...)` bound is `MAX_ENTRIES_PER_NIGHT` (50) — a semantically unrelated constant (the per-night entry cap). This is a coupling bug: if `MAX_ENTRIES_PER_NIGHT` is ever tuned (say to 20), the maximum *nights per page* silently changes with it, and vice-versa. The test at `server.test.ts:287` (`?limit=51` → 400) locks in the value `50` but not its meaning, so the mismatch is invisible to the suite.
**Fix:** Introduce a dedicated constant and use it for the bound:
```ts
/** Defensive upper bound on nights requested per page. */
const MAX_NIGHTS_PER_PAGE = 50;
// ...
limit: z.coerce.number().int().min(1).max(MAX_NIGHTS_PER_PAGE).default(DEFAULT_NIGHTS_PER_PAGE),
```

### WR-02: `before` cursor regex accepts semantically invalid dates → silent rollover instead of 400

**File:** `src/history/server.ts:100-103` (validation), `122-125` (`startOfNightMs`)
**Issue:** The cursor is validated only by shape (`/^\d{4}-\d{2}-\d{2}$/`), so values like `?before=2026-13-45` or `?before=2026-00-00` pass validation. `startOfNightMs` then does `new Date(2026, 12, 45)`, which JavaScript silently rolls over into a valid-but-wrong timestamp (Feb 14, 2027 in that example). The result is a nonsensical page rather than the `400` the malformed-cursor test (`server.test.ts:295`) implies is the contract for bad cursors. Impact is bounded (read-only surface, `ROW_CAP`-limited), so this is robustness, not security — but it is an input-validation gap on a screen-shared surface.
**Fix:** Validate the parsed calendar date, e.g. re-derive the key and compare:
```ts
function parseNightKey(key: string): number | null {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
  // reject rolled-over dates (e.g. month 13, day 45)
  if (dt.getFullYear() !== y || dt.getMonth() !== (m ?? 1) - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}
```
Return `400` when the cursor is present but does not round-trip.

### WR-03: Client result/provenance lookups fall back to the *celebratory* value on unknown input

**File:** `src/history/public/history.js:54,60`
**Issue:** `const result = RESULT[entry.result] ?? RESULT.built;` and `const chip = CHIP[entry.provenance] ?? CHIP.vote;`. If a `result` value ever falls outside `built|refused|failed` (data drift, a future stage word, a corrupt row), the row renders as a green **"Built"** success badge — the exact "a build that shows as built when it failed" screen-share embarrassment the phase brief calls out. Today the server-side `mapStageToResult` only emits the three known values so the fallback is unreachable in practice, but choosing the most-positive outcome as the default is the worst failure mode for an audience-facing page.
**Fix:** Default to a neutral, non-celebratory rendering (and log/skip), never to `built`:
```ts
const result = RESULT[entry.result];
if (!result) continue; // or render a neutral "—" badge; never imply success
```

### WR-04: A single stream-night exceeding `ROW_CAP` strands older nights behind `hasOlder:false`

**File:** `src/history/server.ts:154-193` (`buildHistoryPage`), `91` (`ROW_CAP`)
**Issue:** `listBuildHistory` is fetched with `LIMIT ROW_CAP` (2000) and then bucketed by night. If one night contains more than 2000 rows, page one fetches 2000 rows all belonging to that single newest night, so `nightOrder.length === 1`. Then `hasOlder = (1 > limit) || (capHit && 1 >= limit)` evaluates to `false`, and the client's "Load older nights" control never appears — **older nights become unreachable via the cursor.** Additionally `entryCountLabel`/`overflowCount` are computed from the fetched bucket length, so both are understated (they report 2000/1950 rather than the true totals). A single streamer will never produce 2000 builds in one night, so this is an extreme edge, but the row-cap interacts incorrectly with the night-grouping rather than degrading gracefully.
**Fix:** Either compute the true per-night count with a `SELECT COUNT(*)` (so labels stay honest), or make `hasOlder` account for a saturated cap even when `nightOrder.length < limit` (e.g. `capHit && rows.length >= ROW_CAP` unconditionally implies more may exist), and page by row-cursor within an over-large night rather than dropping to `false`.

## Info

### IN-01: `buildId` is serialized to the wire but never rendered, and leaks the sequential row id

**File:** `src/history/server.ts:174` (`buildId: String(row.id)`), `src/history/public/history.js:51-67` (`renderEntry`)
**Issue:** `renderEntry` never reads `entry.buildId`, so it is dead on the client. It is also the raw autoincrement `build_history.id`, which weakly discloses the total lifetime build count/ordering to any viewer of the JSON. Low impact, but it is a field on an audience-facing wire that serves no rendering purpose.
**Fix:** Drop `buildId` from `HistoryEntry` if nothing consumes it, or keep it only if a client feature needs a stable key (in which case document that the sequential id is intentionally exposed).

### IN-02: A COMP-02 *held-for-review* build is persisted and shown publicly as "Refused"

**File:** `src/orchestrator/build-session.ts:801-814`, `src/history/public/history.js:45`
**Issue:** When COMP-02 *holds* a plan for streamer review, `finalize(task, "refused", ...)` writes a `build_history` row with `result: "refused"`, which the public page renders as "Refused". "Held" is not the same as "refused"; and because D-08 review-queue routing is still deferred (`main.ts:912`), a plan the streamer later approves would produce a *second* history row on eventual build, leaving a permanent "Refused" entry for something that was merely escalated. No compliance leak (the title is gate-approved text), so this is a fidelity/honesty nuance, not a defect.
**Fix:** Acceptable for v1 given the deferral; revisit when D-08 routing lands so a held-then-approved build isn't permanently mislabeled and double-counted.

### IN-03: `coarsenProvenance` passes unknown DB provenance through verbatim to the wire

**File:** `src/history/server.ts:107-110`
**Issue:** `if (donation||channel_points) return "paid"; return provenance;` casts any other DB string straight to `PublicProvenance`. `build_history.provenance` has no SQL `CHECK` constraint (`schema.sql:143`), so a future/errant writer bypassing `recordBuildHistory` could surface a raw value on the public wire (client then falls back to `CHIP.vote`). Only `recordBuildHistory` writes typed `BuildProvenance` today, so this is defense-in-depth.
**Fix:** Whitelist explicitly: return `"vote" | "chaos"` only for those exact values, else `"paid"` (or a neutral) — never echo an unexpected string.

### IN-04: Deferred D-08 review-routing TODO present in a reviewed file

**File:** `src/main.ts:910-916`
**Issue:** `onHeldForReview` currently logs an audited warning instead of re-queuing held plans (`TODO(D-08)`). This is a known, documented Phase-3 deferral (not introduced by Phase 5), surfaced here because `main.ts` is in scope. The behavior is explicit and never silent (narrated + audited), so it is not a stub masquerading as complete.
**Fix:** None required for this phase; tracked under D-08.

---

_Reviewed: 2026-07-10T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
