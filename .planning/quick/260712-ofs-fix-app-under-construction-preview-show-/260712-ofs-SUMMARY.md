---
phase: quick-260712-ofs
plan: 01
subsystem: preview
tags: [preview, broadcast-safety, d3-12, fail-closed]
requires:
  - "src/orchestrator/types.ts DevServerProbe seam"
  - "src/preview/preview-manager.ts createPreviewManager"
  - "src/preview/server.ts /api/reachable handler"
provides:
  - "DevServerProbe.appReady() optional content-aware readiness check"
  - "PreviewManager.appReady() + injectable HttpBodyProbe (fetchDevServerBody)"
  - "/api/reachable prefers appReady() with reachable() fallback"
affects:
  - "OBS app-under-construction preview source (127.0.0.1:4902)"
tech-stack:
  added: []
  patterns:
    - "Injected HTTP-body seam mirroring the existing TcpConnectProbe DI pattern"
    - "Bounded (~8KB) + AbortSignal.timeout body read; fail-closed on every path"
key-files:
  created: []
  modified:
    - src/orchestrator/types.ts
    - src/preview/preview-manager.ts
    - src/preview/preview-manager.test.ts
    - src/preview/server.ts
    - src/preview/server.test.ts
decisions:
  - "New appReady() seam is content-aware; reachable() left byte-for-byte TCP-only so the dev-server-supervisor consumer is unaffected"
  - "/api/reachable uses appReady() when present, falls back to reachable() so TCP-only fakes/console path still work"
metrics:
  tasks: 2
  files: 5
  completed: "2026-07-12"
---

# Quick Task 260712-ofs: App-Under-Construction Preview Content-Aware Readiness Summary

Made the OBS preview surface's `/api/reachable` content-aware via a new fail-closed `appReady()` seam so a python `http.server` "Directory listing for /" boot page renders the calm STANDING BY card instead of a bogus "LIVE" frame — while the supervisor's pure TCP `reachable()` stays untouched.

## What Changed

**Task 1 — content-aware `appReady()` seam on PreviewManager**
- `src/orchestrator/types.ts`: added optional `appReady?(): Promise<boolean>` to `DevServerProbe`, documented as the content-aware preview-only check; `reachable()` stays required and TCP-only.
- `src/preview/preview-manager.ts`: added `HttpBodyProbe` type + real `fetchDevServerBody(url, timeoutMs)` (global `fetch`, `AbortSignal.timeout`, bounded ~8KB prefix read then stream cancel, throws on non-200 / network error / timeout). Added `httpGet?` option (defaults to `fetchDevServerBody`) and `appReady()` on the returned object: `false` when the body matches a directory-listing title regex (case/whitespace-tolerant) or on any `httpGet` rejection; `reachable()` left exactly as-is.

**Task 2 — `/api/reachable` uses `appReady()` with `reachable()` fallback**
- `src/preview/server.ts`: the handler now binds `probe.appReady` when present, else `probe.reachable`, inside the existing try/catch. Catch still yields `{ reachable:false }` at HTTP 200; body remains exactly `{ reachable, url }`. No `express.json()`, no mutation route, no listen-host change.

## Verification Results

- `npx vitest run src/preview/preview-manager.test.ts src/preview/server.test.ts` — PASS (29/29; 13 new cases)
- `npm test` (full suite) — PASS (1176/1176, 79 files) — confirms no regression in `reachable()`'s other consumers
- `npm run typecheck` (`tsc --noEmit`) — PASS (clean)
- `npx biome check` on the 5 touched files — PASS (clean)
- Manual invariant: `src/preview/dev-server-supervisor.ts` (`probeReachable()`) and `src/main.ts:2016` (`.reachable()`) are byte-for-byte unchanged — TCP process-up semantics preserved (D3-12 isolation held; surface still exposes only `{ reachable, url }`).

## TDD Gate Compliance

Both tasks followed RED → GREEN: a failing `test(...)` commit precedes each `feat(...)` commit.

## Deviations from Plan

None - plan executed exactly as written.

## Commits

- `613f70c` test(quick-260712-ofs): add failing appReady() content-aware readiness cases (RED, Task 1)
- `b0a677a` feat(quick-260712-ofs): content-aware appReady() seam on PreviewManager (GREEN, Task 1)
- `9c22eb2` test(quick-260712-ofs): /api/reachable prefers appReady() with reachable() fallback (RED, Task 2)
- `227aa67` feat(quick-260712-ofs): /api/reachable uses appReady() with reachable() fallback (GREEN, Task 2)

## Self-Check: PASSED

- Files: all 5 modified files present on disk.
- Commits: 613f70c, b0a677a, 9c22eb2, 227aa67 all present in `git log`.
