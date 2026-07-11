---
phase: quick
plan: 260710-v4e
subsystem: overlay
tags: [obs, websocket, broadcast-surface, candidate-pool, build-queue]
dependency_graph:
  requires:
    - src/overlay/server.ts (existing read-only overlay server, CR-02 Host allowlist)
    - src/queue/pool.ts (CandidatePool, COMP-01 approved-only invariant)
  provides:
    - GET /queue what's-coming page on the existing overlay server (port shared, no new surface)
    - OverlayState.pool + OverlayState.queue display-only wire projections
    - POOL_CHANGED event (shared/events.ts) with CandidatePool emit semantics
  affects:
    - src/main.ts composition root (pool + queueDisplayMax wiring, boot log line)
tech_stack:
  added: []
  patterns:
    - OverlayPoolSource structural seam (mirrors OverlayQueueSource + OverlayBuildSource.on)
    - Explicit wire narrowing in buildOverlayState (controlWindow re-projection idiom)
    - textContent-only el()/truncate client rendering (T-02-19)
key_files:
  created:
    - src/overlay/public/queue.html
    - src/overlay/public/queue.css
    - src/overlay/public/queue.js
  modified:
    - src/shared/events.ts
    - src/queue/pool.ts
    - src/overlay/server.ts
    - src/main.ts
    - src/overlay/server.test.ts
    - src/queue/pool.test.ts
decisions:
  - "res.sendFile uses {root: publicDir} instead of an absolute join — send()'s dotfile policy 404s absolute paths containing dot-directory segments (e.g. a .claude worktree checkout), and root containment is the stronger posture anyway"
  - "One POOL_CHANGED emit at the end of add() covers both the add and any eviction it caused — listeners re-read list()"
  - "remove() emits only when the id was present (Map.delete boolean) — no phantom pushes"
metrics:
  duration: ~11 minutes
  completed: 2026-07-11
  tasks: 3/3
  tests: 733 passed (existing 724 + 9 new; suite grew t5k->v4e)
---

# Quick 260710-v4e: Dedicated What's-Coming Overlay Page Summary

**One-liner:** GET /queue on the existing overlay server serves a second OBS browser-source page showing the approved suggestion pool ({text, username} display-only projection) and the full 10-deep FIFO build queue, pushed live via a new POOL_CHANGED event from CandidatePool.

## What Was Built

- **POOL_CHANGED event** (`src/shared/events.ts`): emitted by `CandidatePool` (now an `EventEmitter`) once at the end of `add()` (covers eviction too) and on `remove()` of a present id only. Pool stays passive storage — the event is a read-only change notification.
- **Overlay projections** (`src/overlay/server.ts`): `OverlayState.pool` = explicit map to `{text, username}` (never GateResult/rationale/category/decision/addedAtMs — the narrowing exemplar), `OverlayState.queue` = first `queueDisplayMax` (10, tied to VOTE_QUEUE_MAX) task texts FIFO. `OverlayPoolSource` seam + `NULL_POOL_SOURCE` default. `POOL_CHANGED → pushState()` immediate, never the tally debounce.
- **GET /queue route**: serves `queue.html` behind the app-level CR-02 Host allowlist; GET-only (mutation-method 404 posture untouched).
- **Client page** (`queue.html/css/js`): two Dominant backing panels (SUGGESTION POOL / UP NEXT with position badges), textContent-only rendering with 80/24-char truncation, quiet placeholder empty states, reconnect-with-backoff ws client, push-driven only (no timers).
- **Composition** (`src/main.ts`): `pool` + `queueDisplayMax: voteQueueMax` wired into `startOverlayServer`; "what's-coming page at http://127.0.0.1:%d/queue" boot log line.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 8e5d258 | feat: pool+queue projections, /queue route, POOL_CHANGED wiring |
| 2 | 50c89b2 | feat: what's-coming client page (queue.html/css/js) |
| 3 | 62fdaef | test: projection-security/push/ordering/route tests + sendFile dotfile fix |

## Verification (final gate)

- `npx vitest run` — **733/733 passed** (62 files; all pre-existing tests intact)
- `npx tsc --noEmit` — clean
- `npx biome check .` — clean (135 files)
- Task 2 grep gate: zero `innerHTML` in queue.js

Security criteria test-asserted:
- Pool wire fields exactly `["text","username"]`; sentinels `rationale` / `classifier-rationale-sentinel` / `weapons` / `addedAtMs` / `decision` absent from `JSON.stringify(state.pool) + JSON.stringify(state.queue)` (T-v4e-01)
- Approved-only by construction: `add()` throws for `rejected` AND `held-for-review` (T-v4e-02)
- Rebound-Host GET /queue → 403 (T-v4e-04); POST/PUT/DELETE/PATCH /queue → 404 (T-v4e-05)
- `queue` capped at 10 FIFO while `nextUp` stays capped at 3 (main overlay strip unchanged)
- RoundSnapshot residual deliberately NOT widened — new-fields-only JSON assertions per plan

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] GET /queue 404'd because send()'s dotfile policy rejects absolute paths containing dot-directory segments**
- **Found during:** Task 3 (the new route test failed with 404)
- **Issue:** `res.sendFile(path.join(publicDir, "queue.html"))` passes the whole absolute path to `send`, which applies its `dotfiles: "ignore"` policy to every path segment. Any checkout under a dot-directory (this worktree lives under `.claude/`) makes every segment check fail → NotFoundError/404.
- **Fix:** `res.sendFile("queue.html", { root: publicDir })` — only the relative part is policy-checked, and root containment is the stronger `send()` posture. `node:path` import removed (no longer needed).
- **Files modified:** src/overlay/server.ts
- **Commit:** 62fdaef

**2. [Rule 3 - Blocking, environment-only] 4 pre-existing files had stale CRLF working copies in the fresh worktree, failing `biome check .`**
- **Found during:** Task 3 full gate
- **Issue:** `src/audit/db.ts`, `src/compliance/categories.ts`, and both `src/compliance/fixtures/*.fixtures.ts` were `w/crlf` on disk despite `i/lf` index blobs and `.gitattributes eol=lf` (worktree checkout artifact). Biome formatter flagged them; main repo copies are `w/lf` and clean.
- **Fix:** Converted the 4 working copies CRLF→LF (Node one-liner). **Zero content change** — `git diff` empty after `update-index --refresh`; nothing committed for these files.
- **Files modified:** none in git terms (working-tree normalization only)
- **Commit:** n/a

## Self-Check: PASSED

- src/overlay/public/queue.html — FOUND
- src/overlay/public/queue.css — FOUND
- src/overlay/public/queue.js — FOUND
- Commits 8e5d258, 50c89b2, 62fdaef — FOUND in git log
- Zero innerHTML in queue.js — VERIFIED
