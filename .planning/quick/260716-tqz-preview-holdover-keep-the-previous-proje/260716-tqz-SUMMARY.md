---
phase: quick-260716-tqz
plan: 01
subsystem: preview / dev-server supervision
tags: [preview, dev-server, obs, holdover, reroot, playUrl]
requires: [quick-260711-t8k (reroot seam), quick-260716-k3x (mkdir+cd launch payload), quick-260716-t1n (finalize ordering discipline)]
provides:
  - previewHoldoverGeneration state + rerootPreviewNow clearing helper (src/main.ts)
  - deferred done-time reroot riding the onBuildDone hook
  - holdover-aware overlay playUrl (previewHoldoverGeneration ?? workspace.generation())
affects: [overlay playUrl value selection (no wire shape change)]
tech-stack:
  added: []
  patterns: [late-bound seam + clearing-helper discharge, gated-runner e2e (per-build deferred)]
key-files:
  created: []
  modified:
    - src/main.ts
    - tests/e2e/preview-reroot.e2e.test.ts
    - src/orchestrator/sandbox-process.test.ts
decisions:
  - "Failed/aborted/skipped project-switch builds NEVER reroot — previous project stays on screen until a later successful done or an explicit operator action"
  - "Halt mid-switch-build keeps the holdover (finalizeAborted/skipTask never call onBuildDone) — intended, matches the failed-path decision"
  - "Unscaffolded save-and-close discharges a stranded holdover (wipe-intent-after-rotation edge) — the default screen IS the point"
metrics:
  duration: ~12 min
  completed: 2026-07-17T03:45Z
  tests: 1386 passing (+5 over the 1381 baseline)
  commits: 2 (RED 13d511a, GREEN e152185)
---

# Quick Task 260716-tqz: Preview Holdover Summary

**One-liner:** During a project-switch build the OBS LIVE BUILD preview keeps serving the PREVIOUS generation's directory (and the overlay playUrl keeps the previous project's link) until the new build finalizes `done` — the deferred reroot rides the onBuildDone hook; failed/skipped/aborted switch builds never reroot.

## What Was Built

Live incident 2026-07-16 ~20:2x (gen-8): `shipThenRotate` fired `reRootPreview()` at rotation time, so viewers stared at an empty directory listing / STANDING BY card for the entire multi-minute build. Ross's verbatim ask: "when building a new project. i want the previous project to be visable on stream until the new project completes its build."

### Task 1 — RED (commit `13d511a`)
- `gatedRunner()` in tests/e2e/preview-reroot.e2e.test.ts: per-build deferred between the write batch and the result message (`releaseNext("success" | "failed")`, outcome queue for sequential builds) — holds a build mid-flight deterministically.
- New dedicated describe "preview HOLDOVER e2e (quick-260716-tqz)" with a fresh app:
  - **HOLDOVER CORE:** gen 1 active + seeded repo row → project-switch vote → mid-flight asserts rotation happened (gen 2), NO reroot (starts unchanged), playUrl = gen-1 URL; release → done → exactly ONE stop+start pair at `/home/builder/projects/app-2`, playUrl flips.
  - **FAILED path:** failed switch build (2× `releaseNext("failed")` through the D3-09 auto-retry into the frozen decision) → no reroot, playUrl stays previous; skip via `app.orchestrator.skipTask` also never reroots.
  - **RECOVERY:** the next successful done (suggest tweak on gen 3) discharges — one reroot at app-3, playUrl re-derives from the active generation. Mid-flight the holdover still governs even with the gen-3 row seeded.
  - **Holdover-absent pin:** a plain done suggest build re-roots nothing.
- sandbox-process.test.ts: explicit `startsWith("mkdir -p <dir> && cd <dir> && ")` pin on the launch payload (the dir-exists guarantee every reroot path leans on).
- RED failed for the right reason: HOLDOVER CORE tripped on "reroot observed at rotation time" (starts 1→2 mid-flight); later tests cascade-blocked behind the still-gated build. All 42 untouched pins stayed green.

### Task 2 — GREEN (commit `e152185`)
All changes in src/main.ts only:
1. `previewHoldoverGeneration: number | null` + `rerootPreviewNow()` clearing helper next to the `reRootPreview` seam (~line 465).
2. `shipThenRotate` confirmed-ship branch: `previewHoldoverGeneration = generation` (the pre-rotation const) replaces the rotation-time `reRootPreview()`.
3. `onBuildDone`: holdover discharge inserted BEFORE the `if (!galleryPublisher) return;` early-return — flag check + fire-and-forget void call only (t1n discipline held: build-session's own try/catch wraps the hook; supervisor `reroot()` serializes and never rejects).
4. Immediate paths → `rerootPreviewNow()`: console new-project wrapper, swap activation, save-and-close scaffolded branch; PLUS the unscaffolded-skip branch discharges a stranded holdover (wipe-intent-after-rotation edge from rll).
5. playUrl lookup generation: `previewHoldoverGeneration ?? workspace.generation()` — value selection only, fail-closed try/catch and no-row → null unchanged.
6. Boot reroot untouched; halt/abort paths keep the holdover by design.

## Verification

- Full suite **1386 passing** (baseline 1381 + 4 e2e holdover tests + 1 sandbox pin); zero pre-existing test edits outside preview-reroot/sandbox-process test files.
- `tsc --noEmit` clean; `biome check` clean on all three touched files (the only repo-wide biome complaints are pre-existing overlay.css lint items in an untouched file).
- **LOCKED rails held:**
  - `src/preview/*` byte-identical (`git diff HEAD --stat -- src/preview/` empty; D3-12).
  - Only shipThenRotate's confirmed-ship branch defers; boot/console/swap/save-and-close reroot immediately (existing pins green as-is).
  - onBuildDone discharge sits before the galleryPublisher early-return.
  - t1n ordering: nothing synchronous/throwing rides finalize's IDLE transition.
  - rll grep-gate: exactly 1 `buildSession.startBuild(` call site (save-and-close e2e suite green).
- **Grep gates:** `grep -c "reRootPreview()" src/main.ts` = 2 (the clearing helper body + the onBuildDone discharge — the only intended direct call sites); `previewHoldoverGeneration ?? workspace.generation()` present at the playUrl source.

## Deviations from Plan

**1. [Structural] Holdover matrix lives in a NEW dedicated describe instead of literally rewriting the old PROJECT-SWITCH test in place**
- **Found during:** Task 1
- **Issue:** The plan said the holdover-core test "rewrites" the existing project-switch test, but that test shares one sequential app with the swap test, whose `project_repos` inserts (generation is PRIMARY KEY) would collide with the holdover seeding — and the plan simultaneously required the swap/boot/console/fail-open tests untouched.
- **Fix:** Full gated matrix in a fresh-app describe; the old test kept byte-identical in body but retitled/commented as a deliberately TIMING-AGNOSTIC end-state pin (it passes both pre- and post-fix — the timing is pinned by the new describe).
- **Files modified:** tests/e2e/preview-reroot.e2e.test.ts
- **Commit:** 13d511a

No other deviations — implementation followed the plan's six GREEN steps exactly.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary schema changes. T-tqz-01/02/03 mitigations applied as planned (playUrl still sources only durable post-gate `project_repos` rows fail-closed; the discharge is a try/catch-wrapped fire-and-forget; every operator path clears the holdover via `rerootPreviewNow`).

## Self-Check: PASSED

- FOUND: src/main.ts (previewHoldoverGeneration, rerootPreviewNow, onBuildDone discharge, holdover-aware playUrl)
- FOUND: tests/e2e/preview-reroot.e2e.test.ts (gatedRunner + HOLDOVER describe, 4 tests)
- FOUND: src/orchestrator/sandbox-process.test.ts (quick-tqz mkdir+cd head pin)
- FOUND commit: 13d511a (test — RED)
- FOUND commit: e152185 (feat — GREEN)
