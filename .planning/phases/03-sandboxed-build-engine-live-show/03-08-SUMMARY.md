---
phase: 03-sandboxed-build-engine-live-show
plan: 08
subsystem: ui
tags: [preview, obs-browser-source, express, iframe, dev-server-probe, loopback, isolation]

# Dependency graph
requires:
  - phase: 03-01
    provides: shared loopback host-allowlist + separate-localhost-surface posture (overlay/console precedent)
  - phase: 03-02
    provides: DevServerProbe interface (src/orchestrator/types.ts) — the reachability seam
provides:
  - App-under-construction preview surface (PRES-03) — a THIRD isolated localhost surface
  - src/preview/server.ts — read-only, no-ws Express server serving the preview page + GET /api/reachable
  - src/preview/preview-manager.ts — fail-closed DevServerProbe over an injectable TCP probe seam
  - src/preview/public/{preview.html,preview.css,preview.js} — iframe + double-buffered 5s auto-refresh + reachability chrome
affects: [main.ts-composition-root, preview-wiring, obs-scene-setup]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Third localhost surface reuses shared isLoopbackHostHeader (console + overlay + preview never drift)"
    - "Injected TCP-probe seam (DevServerProbe) — tests fake reachability, never open a socket"
    - "Double-buffered iframe swap for flash-free cross-origin auto-refresh"
    - "Local-only reachability state machine (zero orchestrator input, D3-12 isolation)"

key-files:
  created:
    - src/preview/server.ts
    - src/preview/server.test.ts
    - src/preview/preview-manager.ts
    - src/preview/preview-manager.test.ts
    - src/preview/public/preview.html
    - src/preview/public/preview.css
    - src/preview/public/preview.js
  modified: []

key-decisions:
  - "Preview server has NO WebSocketServer at all (D3-12) — reachability is a thin GET /api/reachable proxy over the injected DevServerProbe, not a push channel"
  - "preview-manager takes an injectable `connect` TCP-probe seam so tests never touch the network; the real openTcpConnection fails closed (resolve false, never throw)"
  - "Placeholder state is chosen from LOCAL reachability history only (starting-up before first contact, between-builds after) — the FAILED copy is defined but not auto-selected, because distinguishing a crash would require orchestrator state the preview is forbidden to hold"
  - "express.static serves preview.html at '/' via the index option so a bare-origin OBS Browser Source works"

patterns-established:
  - "New public/ surface auto-covered by tests/invariants/dom-safety.test.ts with zero test-file changes"
  - "Fail-closed reachability: probe error → false → calm STANDING BY, never a 500 or error page on stream"

requirements-completed: [PRES-03]

# Metrics
duration: 22min
completed: 2026-07-10
---

# Phase 3 Plan 08: App-Under-Construction Preview Surface Summary

**A strictly-isolated THIRD localhost surface (PRES-03) that frames the sandboxed dev server in a double-buffered auto-refreshing iframe, holding zero orchestrator connection and reading unreachable as a calm amber "STANDING BY" — never a browser error page, never red.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-07-10T00:26:00Z
- **Completed:** 2026-07-10T00:33:00Z
- **Tasks:** 2
- **Files modified:** 7 created

## Accomplishments
- `src/preview/server.ts`: read-only, no-ws Express server — loopback Host-allowlist first middleware (403 on non-loopback), explicit 127.0.0.1 bind, `express.static(preview.html)`, and a single thin `GET /api/reachable` that proxies the injected `DevServerProbe` returning only `{ reachable, url }` (no orchestrator state, no chat text).
- `src/preview/preview-manager.ts`: fail-closed `DevServerProbe` implementation over an injectable TCP-probe seam; fixed `PREVIEW_DEV_SERVER_PORT` (default 5555 per SANDBOX-SETUP.md), stateless across a distro teardown+relaunch, and a `resolvePreviewDevServerPort` env helper that always falls back to the documented default.
- `src/preview/public/*`: 48px slate status bar (`APP UNDER CONSTRUCTION` + green LIVE / amber STANDING BY dot), a full-viewport dark iframe framing the dev-server URL only, double-buffered 5s auto-refresh while LIVE, and a centered calm placeholder while unreachable — all textContent-only, no ws, no orchestrator connection, no chat-derived text.

## Task Commits

Each task was committed atomically:

1. **Task 1: preview/server.ts (read-only, no-ws) + preview-manager.ts (DevServerProbe)** — `722219f` (feat)
2. **Task 2: preview/public/* — iframe + auto-refresh + reachability chrome** — `f6943d2` (feat)

_Note: preview.html shipped with Task 1 because the server's static-serve test needs the page it serves; preview.css/preview.js shipped with Task 2._

## Files Created/Modified
- `src/preview/server.ts` - Read-only, no-ws preview server; loopback allowlist, 127.0.0.1 bind, `/api/reachable` probe proxy
- `src/preview/server.test.ts` - Fake-probe/ephemeral-port tests: static page, probe proxy, fail-closed, 403 rebound, no mutation routes, no-ws source scan
- `src/preview/preview-manager.ts` - Fail-closed `DevServerProbe` over an injectable TCP probe; fixed dev-server port + env resolver
- `src/preview/preview-manager.test.ts` - Injected-probe tests: pass-through, fail-closed, port/timeout plumbing, URL exposure, stateless re-probe
- `src/preview/public/preview.html` - Preview page shell: status bar, double-buffer frames, calm placeholder
- `src/preview/public/preview.css` - Slate chrome, dark app frame (no white flash), green/amber dot, never red
- `src/preview/public/preview.js` - Reachability poll (~2s), dev-server-URL-only iframe, double-buffered 5s refresh, local-only calm-state machine

## Decisions Made
- **No WebSocketServer on the preview server (D3-12):** the overlay's ws push channel is deliberately absent. Reachability is a request/response `/api/reachable` proxy over the `DevServerProbe`, keeping the surface strictly isolated.
- **Injectable TCP-probe seam:** `createPreviewManager({ connect })` lets vitest fake reachability deterministically; the real `openTcpConnection` opens a `node:net` socket to `127.0.0.1:<port>` and fails closed on every error/timeout path.
- **Local-only placeholder selection:** with reachability as the only allowed input, the surface shows "Setting the stage…" before first contact and "Between builds" afterward. "Reworking this one" (FAILED) copy exists but is not auto-triggered, because a crash-vs-gap distinction would require forbidden orchestrator state.
- **preview.html seeded with default copy:** the `<h1>` carries the starting-up copy in markup (satisfies a11y lint + gives a no-JS fallback); preview.js overrides it live.

## Deviations from Plan

None — plan executed exactly as written. The preview.html file (listed under Task 2's files) shipped in the Task 1 commit because the server's "serves the static preview page" test asserts a 200 for the page the server serves; grouping the shell page with the server it serves keeps each commit's tests green. This is a commit-grouping choice, not a scope change — all seven planned files landed with their planned content.

## Issues Encountered
- **Self-referential source scan matched a doc comment:** the "no WebSocketServer" assertion initially matched the literal word in `server.ts`'s own comment. Reworded the comment ("opens no ws push channel") and made the test strip comments before matching — the invariant now checks code, not prose.
- **Empty `<h1>` a11y lint:** biome's `useHeadingContent` flagged the JS-populated empty heading; seeded it with the default starting-up copy (also a no-JS fallback).
- **Unused `el()` helper:** copied verbatim per the plan but unused (the page's nodes already exist in markup, so `setText` suffices); removed it to keep lint clean while preserving the same textContent-only discipline.

## User Setup Required
None — no external service configuration required. `PREVIEW_DEV_SERVER_PORT` is optional and defaults to 5555 (SANDBOX-SETUP.md). Wiring `startPreviewServer` into `main.ts` and pointing an OBS Browser Source at the preview origin is composition-root work for a later wiring plan.

## Next Phase Readiness
- Preview surface is complete and isolated; ready to be composed into `main.ts` alongside `startOverlayServer`/`startConsoleServer`, constructing the real `createPreviewManager()` (with `openTcpConnection`) in the entrypoint branch per the DI convention.
- Builds entirely against injected fakes — no real WSL2/dev server needed for tests, so it is unaffected by the pending Wave-0 sandbox verdict.
- Full suite: 412 passed + 6 todo (394 baseline + 18 new preview tests). Typecheck and biome clean.

## Self-Check: PASSED

All 7 planned source files exist on disk; both task commits (`722219f`, `f6943d2`) are present in git history.

---
*Phase: 03-sandboxed-build-engine-live-show*
*Completed: 2026-07-10*
