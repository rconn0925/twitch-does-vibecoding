---
phase: 03-sandboxed-build-engine-live-show
plan: 07
subsystem: overlay
tags: [overlay, obs, build-panel, pipeline-stepper, textContent, full-state-on-connect, vitest]

# Dependency graph
requires:
  - phase: 03-sandboxed-build-engine-live-show
    plan: 02
    provides: "PipelineStage vocabulary + BuildStatusView type (shared/types.ts)"
  - phase: 02-chat-vote-loop
    plan: 05
    provides: "read-only overlay server (full-state-on-connect + diff), overlay.js el() textContent helper, PILL_BY_MODE, WINNER_BEAT_MS winner-beat pattern"
provides:
  - "OverlayState.buildStatus field pushed on connect and on every change (PRES-02/04)"
  - "OverlayBuildSource seam (snapshot + BUILD_STAGE_CHANGED) the orchestrator feeds (03-06)"
  - "BUILD_STAGE_CHANGED event constant exported from overlay/server.ts"
  - "Build-status panel in overlay.js/overlay.css: NOW BUILDING header, task title, Research->Plan->Build stepper, stage caption, 8s BUILT IT beat"
affects: [03-06-orchestrator]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Immediate (non-debounced) state-diff push for low-frequency build-stage transitions — mirrors ROUND_OPENED/ROUND_CLOSED"
    - "Optional injected seam with a NULL_BUILD_SOURCE default so the composition root wires the overlay before the build engine exists"
    - "Client-side done beat (reuses WINNER_BEAT_MS) holds the terminal render for 8s after the server nulls the state"
    - "Build panel DOM created in JS (createElement + el()/textContent) — no index.html edit, no innerHTML"

key-files:
  created: []
  modified:
    - src/overlay/server.ts
    - src/overlay/server.test.ts
    - src/overlay/public/overlay.js
    - src/overlay/public/overlay.css

key-decisions:
  - "BUILD_STAGE_CHANGED declared in overlay/server.ts (not shared/events.ts) to stay inside the plan's file boundary; 03-06 imports it from the overlay contract"
  - "build dep made OPTIONAL with a NULL_BUILD_SOURCE default so main.ts compiles unchanged (out of this plan's file scope) until 03-06 wires the real source"
  - "failed/refused freeze the stepper at a client-remembered lastActiveStage since BuildStatusView carries no step for terminal stages"
  - "done stage renders ONLY through the 8s beat; a static done buildStatus collapses the panel (prevents a pinned-open BUILT IT)"

requirements-completed: [PRES-02, PRES-04]

# Metrics
duration: ~6min
completed: 2026-07-10
---

# Phase 3 Plan 07: Overlay Build-Status Panel Summary

**Extended the read-only OBS overlay so viewers watch the build live: added `OverlayState.buildStatus` + the `OverlayBuildSource` seam with immediate stage-diff pushes (server), and a NOW BUILDING panel — chat-voted task title (textContent-only, 80-char truncated), a Research → Plan → Build stepper, a fixed stage caption, and an 8-second BUILT IT done beat — all broadcast-safe (no red, no error text) with the pill unchanged at BUILDING.**

## Performance
- **Duration:** ~6 min
- **Started:** 2026-07-10T06:24Z
- **Completed:** 2026-07-10T06:30Z
- **Tasks:** 2 (both `type=auto`)
- **Files modified:** 4

## Accomplishments
- **Task 1 (server):** Added `buildStatus: BuildStatusView | null` to `OverlayState`; added the `OverlayBuildSource` seam (`snapshot()` + `BUILD_STAGE_CHANGED` subscription); `buildOverlayState()` now carries the build snapshot on `GET /api/state` and every ws push. Build-stage transitions push **immediately** (like `ROUND_OPENED`/`ROUND_CLOSED`), never through the 300ms tally debounce. `PILL_BY_MODE` untouched — the pill stays `BUILDING` across the whole pipeline. Surface remains read-only (no new mutation route).
- **Task 2 (client):** Build panel renderer in `overlay.js` + `overlay.css` per UI-SPEC — header `NOW BUILDING`/`BUILT IT`, task title via `el()`/`textContent` truncated to 80 chars, three-step stepper with completed(green)/active(accent)/upcoming(secondary) badges driven by `buildStatus.stage`, and the fixed orchestrator-authored stage captions. `done` runs an 8s beat (reusing the `WINNER_BEAT_MS` pattern) then collapses; `failed`/`refused` freeze the stepper with an amber caption — no red, no error text, no "failed"/"error" word on stream. Build and vote panels share the lower-left slot and never co-render.
- **Tests:** 3 new server tests (buildStatus null when idle; carried on HTTP + connect push; immediate non-debounced stage push including `done`). Full suite **397 passed + 6 todo** (baseline 394 + 6 preserved); typecheck + biome clean on all four files. `dom-safety` invariant auto-covers the new build-panel code path (no innerHTML/insertAdjacentHTML/document.write/eval).

## Task Commits
1. **Task 1: OverlayState.buildStatus + OverlayBuildSource seam + immediate push** — `3b8de68` (feat)
2. **Task 2: build-status panel + pipeline stepper (overlay.js/css)** — `d382d50` (feat)

## Files Created/Modified
- `src/overlay/server.ts` (modified) — `buildStatus` field, `OverlayBuildSource` seam + `NULL_BUILD_SOURCE` default, `BUILD_STAGE_CHANGED` export, immediate build-stage push wiring.
- `src/overlay/server.test.ts` (modified) — `makeFakeBuild` helper + `build` in the `start()` harness; 3 new build-status assertions.
- `src/overlay/public/overlay.js` (modified) — build panel element (created in JS), done-beat/lastActiveStage state, `renderBuildPanel`/`buildPanelActive`/`effectiveStepIndex`, `handleState`/`renderAll`/`renderVotePanel` wiring.
- `src/overlay/public/overlay.css` (modified) — `.build-panel` + stepper styles reusing the vote-panel anchor (lower-left 48px, 560px), 300ms `background-color` transition on the active badge, amber (never red) terminal caption.

## Decisions Made
- **`BUILD_STAGE_CHANGED` in `overlay/server.ts`:** kept the plan within its declared 4-file boundary (no `shared/events.ts` edit, avoiding a conflict surface with sibling Wave-2 executors). 03-06 imports the constant from the overlay contract.
- **Optional `build` dep + `NULL_BUILD_SOURCE`:** `main.ts` (line 449, outside this plan's file scope) calls `startOverlayServer` without a build source. Making `build` optional with a no-op default keeps the composition root compiling unchanged until 03-06 wires the real orchestrator source — the panel simply stays absent (`buildStatus === null`).
- **Client-remembered `lastActiveStage`:** `failed`/`refused` carry no pipeline step, so the client freezes the stepper at the last researching/planning/building step it saw (UI-SPEC "freeze at current step").
- **`done` only via the beat:** a static `done` buildStatus collapses the panel; the 8s BUILT IT render is driven entirely by the client-held `doneBeat`, so the panel can't stay pinned open if the server is slow to null the state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `build` dep made optional to keep main.ts compiling**
- **Found during:** Task 1 (typecheck)
- **Issue:** Adding a required `build` field to `OverlayServerDeps` broke `src/main.ts` (`startOverlayServer` call, line 449) — a file outside this plan's `files_modified` and shared with sibling Wave-2 executors.
- **Fix:** Made `build?: OverlayBuildSource` optional with a module-level `NULL_BUILD_SOURCE` (no build active, no stage events). Composition root compiles unchanged; 03-06 will pass the real source.
- **Files modified:** src/overlay/server.ts
- **Commit:** `3b8de68`

**2. [Rule 3 - Blocking] biome format on the new test object literal**
- **Found during:** Post-Task-2 lint pass
- **Issue:** biome wanted the `makeFakeBuild({ taskId, title, stage })` call multi-lined.
- **Fix:** `biome check --write` on the four changed files only; logic unchanged.
- **Files modified:** src/overlay/server.test.ts
- **Commit:** `d382d50`

---

**Total deviations:** 2 auto-fixed (both blocking). No scope creep; `index.html` and `main.ts` untouched.

## Known Stubs
None. The build panel wires directly to `OverlayState.buildStatus`; there is no live orchestrator source yet, but that is by design — `NULL_BUILD_SOURCE` renders the panel absent until 03-06 feeds a real `OverlayBuildSource` (documented above, not a stub that blocks this plan's goal).

## Issues Encountered
- **Pre-existing repo lint (out of scope):** CRLF "Formatter would have printed" errors on untouched Phase 1 files persist (already logged in `deferred-items.md` by 03-02). All four 03-07 files pass biome.

## Self-Check: PASSED
- Modified files exist: `src/overlay/server.ts`, `src/overlay/server.test.ts`, `src/overlay/public/overlay.js`, `src/overlay/public/overlay.css` — all FOUND.
- Task commits exist: `3b8de68`, `d382d50` — both FOUND.
- Full suite: `397 passed + 6 todo` (36 files); typecheck clean; biome clean on all four changed files; `dom-safety` invariant green (covers overlay.js).
- `PILL_BY_MODE` unchanged; no mutation route added; `STATE.md`/`ROADMAP.md` untouched.

---
*Phase: 03-sandboxed-build-engine-live-show*
*Completed: 2026-07-10*
