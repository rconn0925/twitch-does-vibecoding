---
phase: quick-260711-ly4
plan: 01
subsystem: overlay
tags: [cli, obs, terminal, builder-feed, ansi]
requires:
  - "src/overlay/server.ts broadcast wire (OverlayState.builderFeed)"
  - "src/overlay/builder-feed.ts closed 5-kind vocabulary (untouched)"
provides:
  - "scripts/builder-terminal.ts — claude-code-styled terminal viewer of the screened builder feed"
  - "npm run builder:terminal"
  - "docs/OPERATIONS.md §10 — Windows Terminal launch + OBS window-capture runbook"
affects: []
tech-stack:
  added: []
  patterns:
    - "hand-rolled ANSI SGR styling (no chalk, no new deps)"
    - "prefix-diff incremental terminal rendering (diffFeed)"
    - "char-code-loop control-character sanitization (no control chars in source regexes)"
key-files:
  created:
    - scripts/builder-terminal.ts
    - tests/scripts/builder-terminal.test.ts
  modified:
    - package.json
    - docs/OPERATIONS.md
decisions:
  - "sanitizeWireText is a char-code loop, not a regex — avoids biome noControlCharactersInRegex and keeps control chars out of source patterns"
  - "renderLine accepts unknown and validates shape — the wire boundary fails closed on malformed entries, not just unknown kinds"
  - "test red-assertions use toContain with built strings instead of regex literals (same biome rule)"
metrics:
  duration: "~12 min"
  completed: "2026-07-11"
  tasks: 2
  tests: "893 pass (23 new)"
---

# Quick Task 260711-ly4: AI-Scene Terminal Viewer Summary

**One-liner:** Terminal CLI (`npm run builder:terminal`) rendering the screened /builder feed claude-code-style for OBS window capture — sanitize-before-style ANSI hardening, prefix-diff incremental repaints, amber-not-red stage-warn, silent backoff reconnect.

## What Was Built

**Task 1 (TDD): scripts/builder-terminal.ts + tests + npm script**

- **RED** (a6ad8d7): 23 failing tests covering the exported pure core.
- **GREEN** (cf24640): implementation:
  - `sanitizeWireText` — strips ESC + all C0/C1 controls except `\n`, tabs → space, applied BEFORE any styling on every wire string (T-ly4-01).
  - `renderLine` — closed 5-kind style map mirroring builder.js KIND_CLASS; unknown kinds and malformed shapes → `null` (fail closed); title gets a dim-rule + bold header; stage-warn is 256-color amber `38;5;214`, never red (D2-18); activity dim-glyph line; snippet 2-space + dim gray `│` gutter per line; 120/200-char backstop caps.
  - `diffFeed` — strict prefix ⇒ append tail; identical ⇒ no-op (votes/pool pushes); anything else ⇒ reset + full repaint (new title / ring drop / reconnect replay).
  - `backoffDelay` — `Math.min(500 * 2 ** attempts, 8000)`, byte-for-byte the builder.js curve.
  - CLI shell: `ws` client on `127.0.0.1:${OVERLAY_PORT ?? 4901}` (`--port` override), reads ONLY `state.builderFeed` (validated per-entry), dim "THE AI" / "standing by…" idle state, at most ONE dim status line on disconnect then silent backoff, cursor hidden on start/restored on exit, Windows-safe `pathToFileURL` isMain guard.
  - `package.json`: `"builder:terminal": "tsx --env-file-if-exists=.env scripts/builder-terminal.ts"`.

**Task 2 (c7f7529): docs/OPERATIONS.md §10**

- Appended after §9, existing sections untouched: what it is (same screened wire), ready-to-paste `wt -w vibecoding-ai --title "THE AI" …` launch line, capture-friendly terminal profile suggestions, OBS Window Capture steps with the §1 same-elevation UIPI reminder, and reconnect/recovery notes.

## Verification

- `npx vitest run` — **893 pass / 0 fail** (23 new in tests/scripts/builder-terminal.test.ts)
- `npx tsc --noEmit` — clean
- `npx biome check src tests scripts` — clean (150 files)
- `git diff a6dad6f..HEAD --stat` — touches ONLY the 4 allowed files; **zero diffs under src/** (feed safety model untouched by construction)
- Headless smoke: 8s run with no server showed the hide-cursor + clear + dim idle paint and exactly ONE dim "· waiting for overlay server…" line across multiple backoff retries — no error text, nothing red

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| a6ad8d7 | test | failing tests for the pure core (RED) |
| cf24640 | feat | builder-terminal CLI + npm script (GREEN) |
| c7f7529 | docs | OPERATIONS.md §10 runbook |

## TDD Gate Compliance

RED gate: `test(...)` commit a6ad8d7 (tests failed — module absent). GREEN gate: `feat(...)` commit cf24640 (23/23 pass). No refactor commit needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Biome noControlCharactersInRegex on test regex literals**
- **Found during:** Task 1 verification (`npx biome check`)
- **Issue:** Red-SGR assertions written as regex literals containing `\u001b` tripped biome's recommended `lint/suspicious/noControlCharactersInRegex`
- **Fix:** Replaced regex assertions with `toContain` checks against built strings (`RED_CODES` array + `expectNoRed` helper); implementation's sanitizer was already a char-code loop for the same reason
- **Files modified:** tests/scripts/builder-terminal.test.ts
- **Commit:** cf24640 (folded into GREEN — the fix was required for the GREEN gate to pass)

No other deviations — plan executed as written.

## Known Stubs

None — the CLI is fully wired to the live overlay wire; no placeholder data paths.

## Threat Flags

None — no new security surface beyond the plan's threat model. The CLI connects loopback-only (T-ly4-04, accepted), reads only the already-public localhost broadcast (T-ly4-03, accepted), and both mitigate-disposition threats are test-asserted: T-ly4-01 (sanitize-before-style) and T-ly4-02 (render-only, closed kind map, fail closed).

## Self-Check: PASSED

- scripts/builder-terminal.ts — FOUND
- tests/scripts/builder-terminal.test.ts — FOUND
- package.json contains "builder:terminal" — FOUND
- docs/OPERATIONS.md contains "## 10." — FOUND
- Commits a6ad8d7, cf24640, c7f7529 — FOUND in git log
