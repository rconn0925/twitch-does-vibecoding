---
phase: quick-260716-g8p
plan: 01
subsystem: orchestrator / overlay / narration
tags: [suggester-attribution, playable-link, github-pages, provenance-chip, wire-narrowing]
requires: [quick-1ki Pages enablement + gallery URLs, quick-hak per-project publisher, T-04-13 coarse window projection, quick-x7d done-beat client]
provides:
  - BuildStatusView.suggestedBy (display-only, server-nulled for paid provenance) + activated source field
  - buildStatus wire narrowed to exactly {taskId, title, stage, source, suggestedBy}
  - galleryPlayUrl/galleryIndexUrl shared helpers (the single URL-construction point)
  - GalleryPublisher.awaitPagesBuilt optional bounded (~90s) Pages-readiness poll (never rejects)
  - Narrator.buildPlayable(url, ready) — two pinned chat copy variants
  - OverlayState.playable:{url}|null + PLAYABLE_CHANGED seam + done-beat PLAY IT line
affects: [src/shared/types.ts, src/orchestrator/build-session.ts, src/orchestrator/gallery-publisher.ts, src/ingestion/narration.ts, src/overlay/server.ts, src/overlay/public/overlay.js, src/main.ts]
tech-stack:
  added: []
  patterns: [T-v4e-01/controlWindow explicit re-projection, T-hak-03 never-reject announce machinery, GalleryExec arg-array seam (GH_TOKEN env-only), late-bound windowNarrator idiom, FREE_REIGN_HINT index-ordering copy pins]
key-files:
  created: []
  modified:
    - src/shared/types.ts
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/gallery-publisher.ts
    - src/orchestrator/gallery-publisher.test.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/overlay/server.ts
    - src/overlay/server.test.ts
    - src/overlay/public/overlay.js
    - src/overlay/public/overlay.css
    - src/overlay/overlay-copy.test.ts
    - src/main.ts
    - tests/e2e/build-flow.e2e.test.ts
    - src/ingestion/twitch-chat.test.ts (Rule-3 fake-narrator fallout)
    - tests/e2e/recovery.e2e.test.ts (Rule-3 fake-narrator fallout)
decisions:
  - "suggestedBy is server-nulled at the emitStage COMPOSITION point (paid = donation|channel_points), then defence-in-depth re-narrowed in buildOverlayState — two independent layers keep the donor identity off the wire"
  - "awaitPagesBuilt lives OFF the publisher's serialization chain (read-only gh api) — proven by an e2e-style test where a hung publishNow never blocks the poll"
  - "announcePlayable fires ONLY from onBuildDone on published|no-changes; shipThenRotate/swap final-snapshot publishes deliberately do NOT announce (they ship the OUTGOING project; !current/!apps cover those links)"
  - "PLAY IT renders on the done beat only; a FIRST publish (~40-60s Pages lag) misses the 8s beat by design — chat carries the honest '(going live in ~1 min)' link instead"
  - "Overlay push guarded by machine.mode !== BUILD_IN_PROGRESS (the STATE_CHANGED clear wins the race); the chat beat posts either way"
metrics:
  duration: ~35 minutes
  completed: 2026-07-16
  tests: 1262 passing (baseline 1233 + 29 new)
  commits: 5
---

# Quick Task 260716-g8p: NOW BUILDING Attribution + Playable Play-Link — Summary

**One-liner:** Vote/chaos builds now show "suggested by @username" under NOW BUILDING (paid builds keep the coarse FREE REIGN chip with NO name), and a confirmed gallery publish posts the playable `https://<owner>.github.io/<repo>/` link to chat (bounded ~90s Pages-build poll, honest timeout phrasing) plus a done-beat PLAY IT line on the overlay.

## What Was Built

### Task 1 — Suggester attribution (`9a1bd0d` RED, `3a0ec9d` GREEN)
- `BuildStatusView` gains `suggestedBy?: string | null` (doc: display-only, already public on the pool wire, server-nulled for paid provenance so T-04-13 never widens — T-g8p-01).
- `build-session.ts emitStage` composes `source: currentProvenance` (ACTIVATES the dormant Phase-4 provenance-chip field) + `suggestedBy: paid ? null : task.twitchUsername`. Provenance is threaded explicitly per T-05-03; a streamer retry preserves it — no ordering hazard.
- `overlay/server.ts buildOverlayState` stops passing `build.snapshot()` through whole: explicit re-projection to EXACTLY the five display keys (the controlWindow idiom); legacy sources without the fields narrow cleanly (`suggestedBy ?? null`, undefined `source` dropped by JSON → client `?? "vote"` fallback).
- `overlay.js renderBuildPanel`: `suggested by @<name>` line after the title — el()/textContent-only, 24-char truncation (DONOR_NAME_MAX), fail-closed on missing/null/empty; renders in the live panel AND the 8s BUILT IT beat. `.build-suggester` muted style (never red).
- Tests: 5-case provenance matrix on push+snapshot surfaces; rich-build-source raw-bytes narrowing (gateRationale/donorAmount forbidden); paid-view null pin; `suggested by @` copy pin index-ordered after the NOW BUILDING header.

### Task 2 — Pages poll + URL helpers + buildPlayable beat (`81055b1` RED, `f9b5993` GREEN)
- `galleryPlayUrl(owner, repoName)` / `galleryIndexUrl(owner)` exported next to DEFAULT_GALLERY_OWNER — the single URL-construction point; inputs are config owner + post-gate sanitizeRepoName slug only.
- `GalleryPublisher.awaitPagesBuilt?(repoName)` (OPTIONAL — every existing fake stays type-valid; absent ⇒ announce immediately): loops `gh api repos/<owner>/<repo>/pages/builds/latest --jq .status` through the SAME GalleryExec seam (arg arrays, GH_TOKEN env-only — T-g8p-03), 404-tolerant (pre-first-build), resolves "built" or "timeout" off the injected clock — the METHOD never rejects (T-hak-03) and never touches the mirror or the serialization chain (hung-publish concurrency test).
- New injectable seams: `sleep` (default unref'd setTimeout), `pagesPollIntervalMs` (5s), `pagesPollTimeoutMs` (90s).
- `Narrator.buildPlayable(url, ready)`: `Play it now: <url>` / `Play it: <url> (going live in ~1 min)` — one send each, exact-string pinned, copy-separation safe.

### Task 3 — Wire the announce end-to-end (`b1763a6`)
- `overlay/server.ts`: `PLAYABLE_CHANGED` + `OverlayPlayableSource` + `NULL_PLAYABLE_SOURCE` + optional `deps.playable`; `OverlayState.playable:{url}|null` narrowed to exactly {url} (chaosMode idiom); immediate push subscription (never the tally debounce).
- `main.ts`: ONE `galleryOwner` const hoisted to createApp scope; the chat block's `infoOwner`/`playUrlOf`/`infoApps` re-pointed to the shared helpers (info-command output byte-identical — existing tests are the regression gate). Playable holder + EventEmitter cleared on `machine.on(STATE_CHANGED)` → BUILD_IN_PROGRESS (stale link never rides into the next build's beat). `announcePlayable(generation, taskId)` inside the build block: `db.open` guard → prepared `SELECT repo_name FROM project_repos WHERE generation = @generation` (the ONLY repo-name source; no row = EMPTY-01 skip, silent) → `awaitPagesBuilt` gate (absent ⇒ "built") → set holder + emit (BUILD_IN_PROGRESS race guard) → `windowNarrator?.buildPlayable`. Fired fire-and-forget from `onBuildDone`'s `.then` ONLY when `result.status === "published" || "no-changes"` — a failed publish never announces; full try/catch that only `logger.error`s (finalize provably undelayed, T-hak-03/T-g8p-04).
- `overlay.js`: done-beat-only `PLAY IT → <url>` line (`beatActive && latest?.playable?.url`), el()/textContent-only; `.build-play` accent style.
- Tests: playable default-null / rich-source raw-bytes narrowing / PLAYABLE_CHANGED immediate-push; `PLAY IT → ` copy pinned once, index-ordered after the "BUILT IT" done-beat header with the exact gate substring; e2e announce matrix in build-flow (built → exactly one "Play it now:" send + overlay {url}; timeout → honest variant; failed → zero sends + null playable; absent poll method → immediate announce; no project_repos row → silent skip).

## Verification Results

| Check | Result |
|-------|--------|
| `npx vitest run` (full suite) | 1262/1262 pass (baseline 1233 + 29 new) |
| `npx tsc --noEmit` | clean |
| `npx biome check src` | 0 errors (3 pre-existing warnings in untouched overlay.css sections only) |
| Invariant suites (single-funnel, dom-safety, secrets-isolation) | untouched, green in full run |
| Narrowing proofs | buildStatus = exactly {taskId,title,stage,source,suggestedBy}; playable = exactly {url}; raw-bytes forbidden-key assertions extended |
| Copy pins | `suggested by @`, `PLAY IT → `, `Play it now: `, `Play it: ` + `(going live in ~1 min)` all exact-string pinned |

## LOCKED Invariants Held

- **T-hak-03 (announce never touches finalize):** announcePlayable is fire-and-forget AFTER publishNow resolved, owns its errors, and awaitPagesBuilt never rejects + hard-times-out ~90s off the serialization chain (hung-publish test); e2e asserts failed publish → zero announce.
- **GalleryExec seam only:** the poll is `gh` + arg array, GH_TOKEN on env only, token asserted absent from every argv element.
- **textContent-only client rendering:** both new lines go through `el()`; dom-safety invariant suite green.
- **suggestedBy server-nulled for donation/channel_points:** composed null at emitStage AND re-narrowed in buildOverlayState; donor identity never on the wire (build-session matrix + paid-view wire test).
- **Display-fields-only narrowing with raw-bytes-absent tests:** both new/changed projections carry rich-source forbidden-key assertions on the serialized state.

## Deviations from Plan

**1. [Rule 3 - Blocking] Narrator fakes outside the plan's file list needed the new interface member**
- **Found during:** Task 2 (tsc)
- **Issue:** `Narrator.buildPlayable` is required on the interface, so the fake narrators in `src/ingestion/twitch-chat.test.ts` and `tests/e2e/recovery.e2e.test.ts` failed to compile; the structural interface pin in `narration.test.ts` (Object.keys sort) also needed the new key.
- **Fix:** Added `buildPlayable` no-op mocks + the sorted-key entry (mechanical, zero behavior change — the exact quick-fdl precedent).
- **Commit:** `f9b5993`

**2. [Rule 1 - Trivial] Biome format on the widened overlay/server import in main.ts**
- One import reflowed to multi-line before the Task 3 commit (`b1763a6`).

## Known Stubs

None — attribution and play-link are wired end-to-end (provenance → wire → panel; publish-confirm → poll → chat + overlay).

## Threat Flags

None beyond the plan's register. T-g8p-01 (suggestedBy coarse projection), T-g8p-02 (textContent + truncation + server-composed URL), T-g8p-03 (exec seam), T-g8p-04 (fire-and-forget + bounded poll) all mitigated as planned; T-g8p-05/SC accepted as written; zero new dependencies.

## ⚠️ LIVE-DEPLOY FLAG

**`overlay.js`/`overlay.css` are CLIENT files cached by OBS CEF.** On live deploy:
1. Restart the app (server picks up the wire/announce changes), AND
2. Refresh the OBS browser sources — `npm run obs -- refresh` — or the suggester/PLAY IT lines will not appear.
Also note quick-1ki's pending live check still applies: the PAT must carry Pages-API permission for `awaitPagesBuilt`/`ensurePagesEnabled` to see real Pages builds.

## Self-Check: PASSED

- Commits 9a1bd0d, 3a0ec9d, 81055b1, f9b5993, b1763a6 all present on `worktree-agent-a13e1eabffbd84a7b` ✓
- must_haves artifacts: `gallery-publisher.ts` exports `galleryPlayUrl`/`galleryIndexUrl` + contains `awaitPagesBuilt` ✓; `narration.ts` contains `buildPlayable` ✓; `overlay/server.ts` contains `PLAYABLE_CHANGED` ✓; `overlay.js` contains `build-suggester` ✓
- key_links: `build-session.ts emitStage` composes `suggestedBy` (paid → null) ✓; `main.ts` onBuildDone `.then` fires `buildPlayable` via fire-and-forget announce ✓; `main.ts` contains the prepared `SELECT repo_name FROM project_repos WHERE generation` ✓
- Full gates at completion: 1262/1262 vitest, tsc clean, biome 0 errors ✓
