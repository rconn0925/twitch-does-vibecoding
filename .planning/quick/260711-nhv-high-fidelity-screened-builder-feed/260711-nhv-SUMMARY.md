---
phase: quick-260711-nhv
plan: 01
subsystem: overlay-builder-feed
tags: [builder-feed, comp02, terminal-viewer, obs, screening]
requires:
  - quick-260711-x7d (screened /builder feed projection)
  - quick-260711-ly4 (AI-scene terminal viewer CLI)
provides:
  - Widened 7-kind screened /builder wire (reasoning, tool-call, full-fidelity diff)
  - contentApproved() sink + ApprovedContentItem display union
  - Shared primaryArg helper (screened-superset guarantee, T-nhv-07)
  - Terminal typewriter pacing (paceCharsPerTick + atomic-SGR backlog)
affects:
  - src/overlay/builder-feed.ts
  - src/orchestrator/build-session.ts
  - scripts/builder-terminal.ts
tech-stack:
  added: []
  patterns:
    - "Single shared narrower helper feeding both screen-side and display-side extractors (subset-by-construction)"
    - "Chunked ANSI backlog pacer: escape sequences atomic + budget-free, plain chars metered"
key-files:
  created: []
  modified:
    - src/overlay/builder-feed.ts
    - src/overlay/builder-feed.test.ts
    - src/orchestrator/build-session.ts
    - src/orchestrator/build-session.test.ts
    - src/orchestrator/index.ts
    - src/orchestrator/classifier-runner.ts
    - scripts/builder-terminal.ts
    - tests/scripts/builder-terminal.test.ts
    - docs/OPERATIONS.md
decisions:
  - "Wire vocabulary is a closed 7-kind union; snippet kind retired (superseded by diff)"
  - "Reasoning-only messages are now COMP-02-screened too — a non-compliant reasoning batch aborts the build like a non-compliant Write batch"
  - "/builder BROWSER page deliberately NOT updated — fails closed on new kinds; terminal viewer is the canonical THE AI capture"
  - "CONTENT_MAX_CHARS=16000 is a memory backstop, not a display cap; ring raised 50→300"
metrics:
  duration: ~15 min
  completed: 2026-07-11
  tests: 917 (prior 893, +24)
---

# Quick Task 260711-nhv: High-Fidelity Screened Builder Feed Summary

**One-liner:** The /builder wire now carries the build agent's real screened output — reasoning prose, "Bash(npm install)"-style tool calls, and full-fidelity file diffs — behind the unchanged COMP-02 single-funnel gate, and the terminal viewer types it out claude-code-style ~5-15s behind real time.

## What Was Built

### Task 1 — Widened screened wire + containment boundary
- `src/overlay/builder-feed.ts`: closed 7-kind union (`title|stage|stage-warn|activity|reasoning|tool-call|diff`); `ApprovedContentItem` display union (feed-side, SDK-free); `contentApproved()` replaces `batchApproved()`; `DEFAULT_MAX_LINES=300`, `CONTENT_MAX_CHARS=16_000` (memory backstop with trailing ellipsis), `TOOL_ARG_MAX=160`; `snippet`/`capSnippet`/`SNIPPET_*` retired; header threat register rewritten (T-x7d-01/-02/-05/-07 updated per plan).
- `src/orchestrator/build-session.ts`: single module-private `primaryArg(input)` helper — the ONLY primary-arg key list (`command,file_path,path,pattern,url,prompt,description,query`), called by BOTH extractors (T-nhv-07 subset-by-construction); `extractWriteEditText` renamed+widened to `extractScreenableText` (assistant text + every tool_use name + primaryArg + full Write/Edit content incl. WR-02 notebook keys and ALL `edits[].new_string`); `extractApprovedBatchDisplays` replaced by `extractApprovedContent`; the consumeTurn screening block is structurally identical — only the trigger variable and the post-guard sink call changed; `contentApproved(extractApprovedContent(...))` appears exactly once, strictly AFTER the `!screen.proceed → break` guard.
- `src/orchestrator/index.ts` barrel re-export and `src/orchestrator/classifier-runner.ts` doc comment follow the rename (`grep -r extractWriteEditText src/ scripts/` → nothing).

### Task 2 — Terminal renderer + typewriter pacing
- `scripts/builder-terminal.ts`: renderLine handles all 7 kinds — reasoning as plain sanitized prose (no bullet), tool-call with a green ⏺ marker (distinct from dim activity, never red), diff as the full-fidelity gutter block with `DIFF_MAX=16_000` backstop; `snippet` returns null (retired → fail closed); exported `paceCharsPerTick` (`max(7, ceil(backlog/200))`) and `splitAnsiChunks` (atomic SGR emission); CLI output path drains a chunked backlog on a ~50ms tick, escape sequences never split, reset diffs flush the backlog and repaint instantly; header updated to the 7-kind wire + intentional ~5-15s lag (T-ly4-01/-02 wording kept binding).

### Task 3 — Runbook + full sweep
- `docs/OPERATIONS.md` §10: launch line now includes `--suppressApplicationTitle`; richer-feed description (screened reasoning/tool-calls/diffs, same COMP-02 single funnel); ~5-15s lag documented as normal; note that the /builder browser page renders only legacy kinds and the terminal viewer is the canonical "THE AI" capture.

## Verification

- `npx vitest run` — **917 passed** (prior 893; +24 new incl. 6 direct extractor unit tests added to clear the ≥916 floor with real coverage: WR-02 notebook keys, ALL-edits joining, fail-closed pathless-Write skip).
- `npx tsc --noEmit` clean; `npx biome check .` clean.
- `git diff` vs plan base touches ONLY the 9 files in `files_modified`; `src/orchestrator/comp02.ts`, `src/overlay/server.ts`, `src/overlay/public/builder.js` byte-identical.
- Structural gate grep: `contentApproved(extractApprovedContent` appears exactly once, post-guard.
- New key tests: reasoning-only rejection contributes zero wire bytes (a2); screening-order `["screen","feed"]`; T-nhv-07 screened-superset (every displayed byte ⊆ captured classify() input); 310→300 ring; 16K backstop; ANSI-injection/no-red across all 7 terminal kinds; paceCharsPerTick bounds.

## Six Binding Invariants — Status

1. **Fail-closed screening order** — HELD: sink call strictly after the proceed guard; screening-order test proves classify resolves before the feed sees content.
2. **SDK containment** — HELD: builder-feed.ts and builder-terminal.ts import zero SDK types; all narrowing in build-session.ts.
3. **Closed vocabulary** — HELD: 7-kind union, server-composed text only; raw SDK tokens test-asserted absent from the wire.
4. **Clear-on-start** — HELD: buildStarted() clear + T-x7d-05 tests unchanged and green; no clear-on-terminal-stage.
5. **Bounded ring** — HELD: 300 lines (within the 200-500 bound) + CONTENT_MAX_CHARS per-line backstop.
6. **comp02.ts untouched** — HELD: git diff shows no change.

## Deviations from Plan

None functional. Two notes:
- **[minor] +6 extractor unit tests beyond the behavior list** — direct tests on `extractScreenableText`/`extractApprovedContent` (WR-02 keys, ALL-edits joining, fail-closed skip) added during Task 3 to clear the plan's ≥916-test done criterion with substantive coverage rather than padding.
- **Tooling note:** control-character escape sequences in the terminal test source were repaired via a scratchpad script (raw ESC/C0/C1 bytes replaced with `\uXXXX` source escapes, matching the original file's "no control characters in source patterns" discipline). Zero raw control bytes remain in the test source.

## Accepted Consequences (per plan design decisions)

- The /builder BROWSER page (`src/overlay/public/builder.js`) was deliberately NOT updated — it fails closed on the new kinds (renders title/stage/activity only). The "THE AI" scene captures the terminal viewer per OPERATIONS §10.
- Reasoning-only messages are now screened, so per-message classify() latency puts the terminal ~5-15s behind real time — documented in §10 as normal.
- More COMP-02 audit rows per build (every screened message writes a recordComp02Decision row) — a cost, not a gap (T-nhv-05 accept).

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes beyond the plan's declared `<threat_model>` surface.

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| d3bb6fc | test | RED: failing tests for the widened 7-kind screened builder feed |
| 6756492 | feat | GREEN: widen the screened /builder wire (feed + build-session + barrel + doc comment) |
| 45c8112 | test | RED: failing tests for 7-kind terminal renderer + typewriter pacing |
| ecc1317 | feat | GREEN: 7-kind terminal renderer + typewriter pacing |
| 610158c | test | Direct extractor unit tests + biome format |
| 1982865 | docs | OPERATIONS §10 — richer feed, --suppressApplicationTitle, expected lag |

## TDD Gate Compliance

Both TDD tasks followed RED→GREEN with committed gates: d3bb6fc→6756492 (Task 1), 45c8112→ecc1317 (Task 2). No refactor commits needed.

## Self-Check: PASSED

All 9 modified files present; all 6 commits found in git log; artifact contains-strings verified (contentApproved, extractScreenableText barrel re-export, --suppressApplicationTitle, paceCharsPerTick).
