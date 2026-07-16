---
phase: quick-260716-k3x
plan: 01
subsystem: preview
tags: [obs, cef-cache, dev-server, cache-control, cache-bust, wsl2]
requires: []
provides:
  - "In-distro preview dev server sends Cache-Control: no-store on every response (document, subresources, directory listing)"
  - "preview.js frameUrl() cache-bust values globally unique across page sessions (_cb=<epoch-ms>-<counter>)"
affects: [src/orchestrator/sandbox-process.ts, src/preview/public/preview.js]
tech-stack:
  added: []
  patterns:
    - "inline python3 -c handler subclass with trailing #http.server comment keeping the cmdline end-anchored for the unchanged pkill pattern"
key-files:
  created: []
  modified:
    - src/orchestrator/sandbox-process.ts
    - src/orchestrator/sandbox-process.test.ts
    - src/orchestrator/types.ts
    - src/preview/public/preview.js
key-decisions:
  - "end_headers-only override — listing HTML/title inherited byte-for-byte so appReady()'s directory-listing regex (quick-ofs) is untouched"
  - "bind pinned explicitly to 127.0.0.1 (WR-06) — never wider than the previous default bind"
  - "Date.now()-based bust keeps ++counter as intra-session same-millisecond tiebreaker"
metrics:
  duration: "~6 min"
  completed: "2026-07-16"
  tasks: 2
  tests: "1289 passing (baseline 1287 + 2 new)"
---

# Quick Task 260716-k3x: Mid-Build Preview Refresh (Stale App Cache Fix) Summary

**Inline `python3 -c` no-store dev server + session-unique `Date.now()` cache-bust — the OBS LIVE BUILD slot can no longer serve a stale app from CEF's cache mid-build or across project switches.**

## What Was Done

Two stacked defects (confirmed live 2026-07-16: OBS framed app-5 while 127.0.0.1:5555 verifiably served app-6), two surgical fixes:

### Task 1 — Dev server sends `Cache-Control: no-store` on every response (TDD)

- `startPreviewDevServer` (src/orchestrator/sandbox-process.ts) now assembles an inline `python3 -c` SimpleHTTPRequestHandler subclass whose `end_headers()` override injects `Cache-Control: no-store` then delegates to the base class — it runs on EVERY response path (document, subresources, `list_directory`), so CEF revalidates instead of applying heuristic freshness (~10% of file age).
- The trailing `#http.server` python comment keeps the joined in-distro cmdline ending in `http.server <port>`, so `stopPreviewDevServer`'s end-anchored pkill pattern stays **byte-identical** (verified: git diff shows no hunk in that method). Transition safety is test-proven: the unchanged pattern `http\.server 5555$` matches BOTH the old `-m http.server` cmdline and the new `-c` joined-argv form — a pre-deploy server is killed by the first post-deploy reroot and can never squat port 5555.
- `bind="127.0.0.1"` passed explicitly (WR-06 loopback pinning; narrower than the previous default, never wider). Port stays argv-final via `int(sys.argv[1])`. stdlib only — zero new distro dependencies. `buildSandboxEnv`/`spawn`/`terminate` untouched (existing no-env-bytes/no-spawn tests keep enforcing it).
- New tests (RED `6d03b6b` → GREEN `c117329`): exact-string start command; anchor-tail invariant (`#http.server' 5555 >/dev/null` present, payload contains `Cache-Control`/`no-store` and ZERO single quotes — the sh-quoted string cannot be terminated early, T-k3x-01); old/new-cmdline pkill-match transition test (T-k3x-02). Both existing stop tests pass unchanged.
- **Functionally verified on host python 3.14** before implementation: empty-dir response returned `HTTP/1.0 200`, `Cache-Control: no-store`, and the inherited `<title>Directory listing for /` — appReady()'s regex compatibility confirmed live, not just by inspection.

### Task 2 — Session-unique cache-bust in preview.js

- `frameUrl()` now emits `_cb=${Date.now()}-${++cacheBust}` (commit `35986e9`). The old bare counter restarted at 0 every page session while CEF's disk cache persisted across OBS "refresh (no cache)" reloads — a fresh session's `?_cb=1`, `?_cb=2`… replayed the exact URLs a previous session cached when the OLD app was live, so the bust served the stale app from cache. `Date.now()` makes the value globally unique across sessions; the counter remains as an intra-session same-millisecond tiebreaker.
- Diff scope verified: ONLY frameUrl() + its comment block touched — no DOM writes, no wire fields, `/api/reachable` remains the page's only dynamic input, textContent-only discipline intact.
- `node --check` passes; biome clean.

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| `6d03b6b` | test | RED — failing tests for inline no-store dev server command (exact-string, anchor invariant, transition safety) |
| `c117329` | feat | GREEN — inline no-store server; stale types.ts interface doc corrected |
| `35986e9` | feat | Session-unique preview cache-bust (`_cb=<epoch-ms>-<counter>`) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stale interface doc comment in types.ts**
- **Found during:** Task 1
- **Issue:** `SandboxAdapter.startPreviewDevServer` doc comment described the retired `python3 -m http.server <port>` command — the file's comments are load-bearing project documentation and would have contradicted the new implementation.
- **Fix:** Comment updated to describe the inline `-c` no-store server and the argv-final anchor guarantee.
- **Files modified:** src/orchestrator/types.ts (comment only, zero behavior)
- **Commit:** `c117329`

No other deviations — plan executed as written.

## Verification

- `npx vitest run` — **1289 passing** (baseline 1287 + 2 net new tests), 0 failures.
- `npx tsc --noEmit` clean; `npx biome check` clean on all touched files.
- `stopPreviewDevServer` byte-identical (no diff hunk in the method; exact-string test pins `pkill -f 'http\.server 5555$' || true`).
- preview.js diff touches ONLY frameUrl() + its comment.

## Deploy Note (OBS refresh required)

Client JS is cached by CEF. After the app restart:
1. The new dev server command takes effect on the next preview-server (re)start — the app restart's boot start covers it.
2. The OBS browser source `vibe-app-preview` MUST be refreshed (`npm run obs -- refresh`, per scripts/obs.ts) before the preview.js `Date.now()` bust is live on the broadcast surface — CEF will otherwise keep running the old cached preview.js.

## Visual Verification (batched, per autonomous-chain directive)

No test seam exists for preview.js (plain browser script, not imported by any vitest file — confirmed). End-of-session visual check, batched with the pending g8p/fdl/1ki/h73 deploy:
- [ ] With the dev server serving a project, the LIVE BUILD slot tracks a mid-build file edit (app.js/style.css written by the build agent) within ~5s, no OBS interaction.
- [ ] After a project switch + OBS source refresh, the slot shows the NEW generation — never the previous app.

## Known Stubs

None.

## Threat Flags

None — no new surface beyond the plan's threat model. T-k3x-01 (single-quote-free payload) and T-k3x-02 (transition-safe pkill) are test-pinned; T-k3x-03 satisfied by the explicit 127.0.0.1 bind (narrower than before).

## Self-Check: PASSED

- src/orchestrator/sandbox-process.ts — FOUND (contains `Cache-Control`)
- src/orchestrator/sandbox-process.test.ts — FOUND (anchor-tail invariant tests present)
- src/preview/public/preview.js — FOUND (contains `Date.now()`)
- Commits 6d03b6b, c117329, 35986e9 — FOUND in git log
