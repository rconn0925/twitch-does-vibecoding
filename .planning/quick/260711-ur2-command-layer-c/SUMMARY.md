---
phase: quick-260711-ur2
plan: command-layer-c
status: complete
type: execute
mode: quick
completed: 2026-07-11
requirements: [command-layer-c]
tasks_completed: 6
tasks_total: 6
commits:
  - 25242d3 feat(quick-ur2): /commands static OBS page + route + parser sync grep-gate
  - c8b2222 feat(quick-ur2): widen pool+queue wire projection to carry kind
  - c50b476 feat(quick-ur2): kind chips on vote rows + /queue pool/queue rows
  - b6760a6 fix(quick-ur2): shorten suggestions phase-hint to fit one line at 1080p
  - b5e9d8b feat(quick-ur2): FREE REIGN banner usage hint (control-window only)
  - f4ba3d6 docs(quick-ur2): document /commands OBS browser source (OPERATIONS §12)
files_created:
  - src/overlay/public/commands.html
  - src/overlay/public/commands.css
  - src/overlay/commands-page.test.ts
  - src/overlay/kind-chip.test.ts
  - src/overlay/overlay-copy.test.ts
files_modified:
  - src/overlay/server.ts
  - src/overlay/server.test.ts
  - src/overlay/public/overlay.js
  - src/overlay/public/overlay.css
  - src/overlay/public/queue.js
  - src/overlay/public/queue.css
  - scripts/overlay-harness.ts
  - docs/OPERATIONS.md
---

# Phase quick-260711-ur2 Plan command-layer-c: Command Layer C Summary

The on-screen command surfaces for the overlay: a static `/commands` reference
card, candidate KIND chips (NEW/TWEAK/SWAP/REVERT) on vote rows and both `/queue`
lists, a one-line phase-hint fix, and a FREE REIGN usage hint — all pure display
work that widens the public wire by exactly ONE closed enum field (`kind`).

## Hard invariant held

The only new wire field is `kind: CandidateKind` (`"suggestion" | "project-switch"
| "revert" | "swap"`). Chip labels are composed client-side from a fixed
`KIND_CHIP` lookup; the enum string is the only thing on the wire. No chat-derived
text, gate rationale/category/decision, amount, or message rides any touched
field. The pool/queue defence-in-depth narrowing tests were extended to cover
`kind` (rich sources leak no extra keys; `kind` is one of the four enum values).

## Task-by-task

- **T1 — /commands static page + route + grep-gate.** New `commands.html` (pure
  static, zero `<script>`, links `/overlay.css` then `/commands.css`) listing only
  parser-recognized tokens across VOTE and INSTANT groups; `commands.css` reuses
  the overlay `:root` tokens (no new accent, never red). Added the
  `app.get("/commands", ...)` route mirroring `/queue`/`/builder`. `commands-page.test.ts`
  is a drift-proof grep-gate: (a) every RECOGNIZED token parses non-null, (b) page
  tokens subset of RECOGNIZED (fail-closed; a `(?<!<)![a-z]+` scan skips `<!doctype>`),
  (c) every primary command appears, plus a zero-`<script>` assertion. `server.test.ts`
  gained a `/commands` serve+403 test mirroring the `/queue` standalone pattern and
  `/commands` in the mutation-404 iteration.
- **T2 — widen pool+queue projection (the risky one).** `OverlayState.pool` to
  `{text,username,kind}`, `queue` to `{text,kind}[]`; `OverlayPoolSource`/
  `OverlayQueueSource` widened to carry `CandidateKind`; `buildOverlayState`
  projects `kind` (closed enum) only, `nextUp` stays `string[]`. `queue.js`
  `renderQueue` updated to read `item.text` from the new object IN THE SAME
  commit so `/queue` stayed green. Extended `server.test.ts`: pool/queue key
  assertions include `kind`, a new queue narrowing test proves a rich queue source
  leaks no vote provenance, FIFO test updated to object shape. No `src/main.ts`
  edit — the real pool/taskQueue already satisfy the widened interfaces.
- **T3 — kind chips.** `KIND_CHIP` lookup inlined in `overlay.js` and `queue.js`;
  chips render on vote rows, `/queue` POOL rows, and `/queue` QUEUE rows; unknown/
  missing kind yields no chip (fail closed). `.kind-chip` (overlay.css) + `.wc-chip`
  (queue.css) use Secondary bg / muted text only. `kind-chip.test.ts` covers the
  lookup, the skip rule, cross-file map drift, and a chip-CSS red/accent guard.
- **T4 — phase-hint truncation fix (PRIMARY option).** Shortened the suggestions
  hint to `type !suggest — an idea or a tweak` so it fits one line in the 900px
  banner at 24px; `overlay-copy.test.ts` pins the exact string and asserts the old
  copy is gone. `narration.ts` untouched.
- **T5 — FREE REIGN usage hint.** `renderBanner` appends
  `!build or !suggest — straight to the queue` in the control-window branch only
  (DEMOCRATIC/CHAOS branches early-return before it); `.banner-hint` muted, no
  amount/message copy. Test pins it once and asserts its position after the
  early-returning branches (FREE-REIGN-only scoping).
- **T6 — docs.** OPERATIONS.md section 12 documents the `/commands` URL, loopback
  posture, static/no-wire-dependency nature, drift-guard note, and suggested
  full-frame vs side-rail placement.

## Deviations from Plan

**1. [Rule 3 — Blocking] `scripts/overlay-harness.ts` fake sources needed `kind`.**
- **Found during:** T2 (typecheck after widening the interfaces).
- **Issue:** The dev-only visual harness constructs fake pool/queue sources with
  the old shape; widening `OverlayPoolSource`/`OverlayQueueSource` broke
  `tsc --noEmit` (a file outside `src/overlay/` but a direct consumer of the
  changed interfaces).
- **Fix:** Added `kind` to the harness's fake pool/queue items, cycling the four
  `CandidateKind` values so the harness now also exercises every chip variant for
  manual visual checks. It is a fixture consumer (same category as the test fakes),
  not a production surface — the scope fence's intent (parser/gate/router/
  RoundSnapshot/narration untouched) is preserved.
- **Files modified:** `scripts/overlay-harness.ts`
- **Commit:** c8b2222

No other deviations — the plan executed as written. No authentication gates.

## Test / build results

- `npx vitest run src/overlay/` — 59 passed (5 files: server.test.ts 36,
  builder-feed.test.ts 13, commands-page.test.ts 4, kind-chip.test.ts 4,
  overlay-copy.test.ts 2).
- `npx tsc --noEmit` — clean (exit 0).

## Known Stubs

None. All surfaces are wired to real data or fixed server-authored copy.

## Self-Check: PASSED

- Created files present: commands.html, commands.css, commands-page.test.ts,
  kind-chip.test.ts, overlay-copy.test.ts — all verified on disk.
- All six commits verified in git log (25242d3, c8b2222, c50b476, b6760a6,
  b5e9d8b, f4ba3d6).
