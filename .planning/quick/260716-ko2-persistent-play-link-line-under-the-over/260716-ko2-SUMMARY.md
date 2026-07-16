---
phase: quick-260716-ko2
plan: 01
subsystem: overlay
tags: [overlay, play-link, phase-banner, wire-narrowing, github-pages]

requires:
  - phase: quick-260716-g8p
    provides: galleryPlayUrl/DEFAULT_GALLERY_OWNER consolidated URL helpers, the transient `playable` done-beat seam and its raw-bytes narrowing test idiom
  - phase: quick-260711-hak
    provides: durable project_repos generation→repo_name routing table (schema.sql)
provides:
  - "OverlayState.playUrl: string | null — a CLOSED wire field carrying the ACTIVE generation's persistent public play URL"
  - "OverlayPlayUrlSource pull seam (current(): string | null, NO subscription) + NULL_PLAY_URL_SOURCE default on OverlayServerDeps"
  - "main.ts pull source: prepared project_repos SELECT for workspace.generation() composed through galleryPlayUrl(galleryOwner, repo_name), try/catch fail-closed"
  - "phase-banner `▶ PLAY IT: <host>/<slug>/` sub-line in ALL live phases; banner shows the line alone in content-less phases; ON HOLD suppressed"
  - ".phase-play small monospace accent style — never ellipsized; .phase-banner:has(.phase-play) lifts the 900px cap while mounted"
affects: [overlay, stream-night-dry-run, any future phase-banner work]

tech-stack:
  added: []
  patterns:
    - "PULL-based overlay source (current() read inside buildOverlayState per push/connect) — freshness with zero new event plumbing, vs the push seams (playable/chaosMode)"

key-files:
  created: []
  modified:
    - src/overlay/server.ts
    - src/main.ts
    - src/overlay/public/overlay.js
    - src/overlay/public/overlay.css
    - src/overlay/server.test.ts
    - src/overlay/overlay-copy.test.ts
    - tests/e2e/build-flow.e2e.test.ts

key-decisions:
  - "playUrl is PULL-based (recomputed in buildOverlayState on every push/connect) — project switch/swap/rotation flips the URL on the next state push with ZERO new events (plan decision 4)"
  - "typeof pu === 'string' fail-closed narrowing: a misbehaving/rich source can never put routing/donor detail on the broadcast wire (T-ko2-01)"
  - "URL never ellipsized on screen: .phase-play carries no overflow/ellipsis; .phase-banner:has(.phase-play) removes the 900px max-width while the line is mounted so the 80-char slug stays fully legible at 1080p (plan decision 2)"
  - "ON HOLD gate client-side (latest.pill !== 'ON HOLD') — never new UI in HALTED (plan decision 3)"
  - "New prepared statement overlayPlayRepoStmt adjacent to the overlay wiring: the announce path's identical playableRepoStmt lives inside the build-engine composition block and is NOT in scope at the deps object (plan anticipated this fallback)"

patterns-established:
  - "OverlayPlayUrlSource: pull-based overlay seam — use when freshness can ride the existing push cadence instead of adding events"

requirements-completed: [QUICK-260716-KO2]

duration: ~12min
completed: 2026-07-16
---

# Quick Task 260716-ko2: Persistent Play-Link Line Under the Phase Banner Summary

**Persistent `▶ PLAY IT: twitchvibecodes.github.io/<repo>/` sub-line under the phase-banner timer in every live phase, pull-recomputed per push from the durable project_repos row via galleryPlayUrl — no hardcoding, zero new events, never ellipsized.**

## LIVE-DEPLOY FLAG (g8p precedent)

`overlay.js` / `overlay.css` are OBS CEF-cached client files. Deploying requires:
1. **App restart** (server picks up main.ts/server.ts changes)
2. **`npm run obs -- refresh`** (each overlay browser source re-fetches the cached client JS/CSS)

After that, the VOIDFARER URL (generation 6 row `a-space-simulation-where-we-fly-around-the-galaxy-exploring-beautiful-planets-st` already in project_repos) appears on the first state push with no further action — "set it now" is satisfied by the dynamic lookup.

## Performance

- **Duration:** ~12 min
- **Tasks:** 2/2 (TDD RED → GREEN)
- **Files modified:** 7

## Accomplishments

- **Wire (src/overlay/server.ts):** `OverlayState.playUrl: string | null` closed field with a doc comment distinguishing it from the transient g8p `playable` done-beat link; `export interface OverlayPlayUrlSource { current(): string | null }` (PULL-based, deliberately no subscription); `NULL_PLAY_URL_SOURCE` default; `playUrl: typeof pu === "string" ? pu : null` fail-closed narrowing inside `buildOverlayState`.
- **Source (src/main.ts):** `overlayPlayRepoStmt` (prepared `SELECT repo_name FROM project_repos WHERE generation = @generation`) + a `playUrl.current()` closure reading `workspace.generation()` and composing through the EXISTING `galleryPlayUrl(galleryOwner, …)` helper — no URL-construction duplication (quick-1ki/g8p doctrine). `db.open` guard + try/catch → null (line silently absent on any error).
- **Client (src/overlay/public/overlay.js):** `renderPhaseBanner` restructured from three early-returns to an if/else-if fall-through with `hasPhaseContent`; every branch's rendering unchanged (all exact-string copy pins hold). Shared tail appends `el("div", "phase-play", `▶ PLAY IT: ${playUrl.replace("https://", "")}`)` — textContent-only, scheme dropped for display, path whole. `phaseBanner.hidden = !hasPhaseContent && playUrl === null` — the banner shows the play line ALONE during FREE REIGN / CHAOS / standby / winner-beat gaps; silent absence when null. ON HOLD never renders the line. Done-beat `PLAY IT → ` path byte-untouched.
- **Style (src/overlay/public/overlay.css):** `.phase-play` 14px ui-monospace accent single line, NO overflow/ellipsis; `.phase-banner:has(.phase-play) { max-width: none }` lets the banner grow so the 80-char slug never clips.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | RED — failing tests (wire trio + freshness, copy pins, e2e persistent matrix) | `208c458` |
| 2 | GREEN — playUrl field + source + banner sub-line + CSS | `fedd947` |

## Test Coverage Added (7 tests)

- server.test.ts: null default (closed field present on HTTP + ws), VOIDFARER 80-char slug pass-through + `^https://twitchvibecodes\.github\.io/[a-z0-9-]+/$` shape, fail-closed narrowing of a misbehaving rich source (raw-bytes forbidden keys `repoRowSecret`/`donorAmount`/`leak-me` absent), per-push freshness (closure flip → next ROUND_OPENED push carries the new URL, zero dedicated events).
- overlay-copy.test.ts: `▶ PLAY IT: ` exactly once, index-ordered after the suggest-hint pin (phase-banner territory), done-beat `PLAY IT → ` pin intact; `phase-play` class + `replace("https://", "")` scheme-strip pins.
- build-flow.e2e.test.ts: playUrl carries the active generation's galleryPlayUrl on the FIRST state read (no done beat needed) and persists after build/announce; null with no project_repos row.

## Deviations from Plan

None - plan executed exactly as written. The plan's anticipated scope-fallback applied: `playableRepoStmt` is declared inside the build-engine composition block and is NOT in scope at the overlay deps object, so an identical statement (`overlayPlayRepoStmt`) was prepared adjacent to the wiring — exactly the fallback the plan prescribed.

## Verification

- Full suite: **1296 passed** (baseline 1289 + 7 new), 0 failed
- `npx tsc --noEmit` clean
- `npx biome check src`: 3 warnings, all pre-existing overlay.css deferrals (lines 56/58/173 — before the insertion point); nothing new introduced
- Invariant suites (dom-safety, single-funnel) green — the new client line is el()/textContent-only
- g8p `playable` path byte-untouched; all g8p/fdl/ur2 exact-string copy pins still pass

## Behavior Matrix (proven)

| State | Result |
|-------|--------|
| Repo row exists, any live phase | `▶ PLAY IT: twitchvibecodes.github.io/<slug>/` under the timer |
| No phase content (FREE REIGN/CHAOS/standby) + row exists | banner shows the play line alone |
| No project_repos row for active generation | no line, no empty shell (banner hidden as before) |
| HALTED (ON HOLD pill) | no play line — never new UI in HALTED |
| Project switch/swap/rotation | URL flips on the next state push (pull recomputation) |
| Misbehaving rich source | playUrl null; forbidden bytes absent from the wire |

## Known Stubs

None — the line is fully wired from the durable DB routing to the screen.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary schema changes beyond the plan's `<threat_model>` (T-ko2-01/02 mitigated as planned; T-ko2-03 accepted per-push indexed SELECT).

## Self-Check: PASSED

- src/overlay/server.ts, src/main.ts, src/overlay/public/overlay.js, src/overlay/public/overlay.css — all modified and committed
- Commits `208c458` (test) and `fedd947` (feat) exist on `worktree-agent-a5ae83fa0641acfb6`
- TDD gate sequence: test(...) commit precedes feat(...) commit
