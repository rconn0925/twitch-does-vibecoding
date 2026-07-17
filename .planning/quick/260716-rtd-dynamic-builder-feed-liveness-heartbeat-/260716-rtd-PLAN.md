---
phase: quick-260716-rtd
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/builder-terminal.ts
  - tests/scripts/builder-terminal.test.ts
  - docs/OPERATIONS.md
autonomous: true
requirements: [QUICK-260716-RTD]

must_haves:
  truths:
    - "During an active build, when no feed output has rendered for ≥10s, THE AI terminal shows a single dim status line: 'the AI is thinking — 2m 40s in…' that updates in place (no scroll spam) and includes a files ticker once files exist"
    - "The status line vanishes the instant real feed output resumes, and never appears when the last feed line is a terminal state (done caption / stage-warn) or while disconnected/idle"
    - "A large screened burst (e.g. a 16KB diff) finishes rendering within seconds, not minutes — typing debt is bounded ≤ ~10s for any backlog"
    - "Zero new wire bytes: the /builder wire, feed kinds, build-session, and server are byte-identical; the liveness line is composed entirely client-side"
    - "Nothing red, no error text, ANSI-strip discipline unchanged (T-ly4-01/02 wording stays binding)"
  artifacts:
    - path: "scripts/builder-terminal.ts"
      provides: "Pure liveness helpers (formatElapsed, isBuildInFlight, fileStatsFromFeed, thinkingStatusLine), burst-drain pacing, status-line lifecycle in the CLI shell"
      exports: ["formatElapsed", "isBuildInFlight", "fileStatsFromFeed", "thinkingStatusLine", "THINKING_QUIET_MS", "BURST_DRAIN_CHARS", "paceCharsPerTick"]
    - path: "tests/scripts/builder-terminal.test.ts"
      provides: "Unit coverage for all new pure helpers + updated pacing bounds + done-caption sync test"
      contains: "isBuildInFlight"
  key_links:
    - from: "scripts/builder-terminal.ts statusTick"
      to: "isBuildInFlight / thinkingStatusLine"
      via: "1s interval in the CLI shell"
      pattern: "thinkingStatusLine\\("
    - from: "tests/scripts/builder-terminal.test.ts"
      to: "src/overlay/builder-feed.ts STAGE_LINES done caption"
      via: "createBuilderFeed().stage('done') caption-sync test"
      pattern: "createBuilderFeed"
---

<objective>
Make THE AI terminal visibly ALIVE during a build: a client-side "thinking" heartbeat with elapsed time + a compact files ticker during quiet gaps, and burst-proof typewriter pacing so the display never trails minutes behind reality.

Purpose: Live incident 2026-07-16 — an 8+ minute first thinking pass produced zero SDK messages, and the terminal sat on "● Writing the code" the whole time. Viewers (and Ross) could not tell a healthy long think from a hang.

Output: Modified `scripts/builder-terminal.ts` (pure helpers + CLI status-line lifecycle + pacing), updated `tests/scripts/builder-terminal.test.ts`, one-bullet OPERATIONS §10 note. NO changes to src/ or the wire.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@scripts/builder-terminal.ts
@tests/scripts/builder-terminal.test.ts
@src/overlay/builder-feed.ts   (READ-ONLY — for the done caption + kind vocabulary; do NOT modify)
@.planning/quick/260711-nhv-high-fidelity-screened-builder-feed/260711-nhv-SUMMARY.md

<interfaces>
Facts the executor needs (verified against the codebase 2026-07-16 — do NOT re-derive):

From scripts/builder-terminal.ts (the ONLY runtime file to modify):
- `FeedLine { kind: string; text: string }`; closed 7-kind render map in `renderLine`
- `paceCharsPerTick(backlogChars) = Math.max(7, Math.ceil(backlogChars / 200))` at line ~155 — pure, exported, tick is 50ms
- CLI shell (`main()`): append-only output; every completed rendered line is written as `${rendered}\n`; cursor HIDDEN (`ESC[?25l`); `drainTick()` on a 50ms interval writes from `backlog` (chunked, SGR-atomic); `paintIdle`/`paintAll` do full `CLEAR_SCREEN` repaints; on socket close writes ONE dim "· waiting for overlay server…" line and sets `needsRepaint = true`
- `diffFeed(prev, next)` → `{reset, appended}`: reset fires on new-build title, ring drop, or reconnect replay
- Style constants available: `DIM`, `RESET`, `ESC`; sanitizer `sanitizeWireText`; caps `LINE_MAX=120`, `DIFF_MAX=16_000`

From src/overlay/builder-feed.ts (READ-ONLY):
- `STAGE_LINES` is module-PRIVATE. Done caption is `{ kind: "stage", text: "Live on screen now" }`; failed/refused are kind `stage-warn`. Reach it in tests via `createBuilderFeed().stage("done")` then `list()`
- Activity lines are exactly `"Writing <path>"` or `"Editing <path>"` (server-composed, fixed verbs)
- `createBuilderFeed`, `DEFAULT_MAX_LINES=300` are exported from `src/overlay/builder-feed.js`

Verified: Read tool calls ALREADY render — `file_path` is in build-session's `primaryArg` key list, so `Read(src/x.ts)` arrives as kind `tool-call`. No wire work is needed for file visibility; only the ticker is missing.
</interfaces>
</context>

<compliance_rails>
LOCKED — violating any of these fails the task:
- NO changes to src/orchestrator/**, src/overlay/**, src/main.ts, src/audit/**, src/ingestion/** (concurrent task 260716-rll owns src/main.ts, src/audit/record.ts, src/ingestion/narration.ts — hard no-touch). Screening order ["screen","feed"] and the screened-superset test are untouched by construction because the wire is untouched.
- NO new feed kind, NO includePartialMessages, NO new wire bytes. The status line is terminal-local: composed from elapsed time, local counters, and re-display of ALREADY-SCREENED, already-displayed activity-line paths (sanitized again via sanitizeWireText before styling).
- Amber-never-red: the status line uses DIM only. No error wording — copy must read calm ("the AI is thinking…"), never implying failure.
- The status line must NEVER enter `lastFeed`, the backlog, or any wire-facing structure — it is repainted in place (`\r` + `ESC[2K`) and cleared before any real output writes, so the append-only frame is never dirtied (no needsRepaint churn).
</compliance_rails>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Pure liveness helpers + burst-drain pacing (RED → GREEN)</name>
  <files>scripts/builder-terminal.ts, tests/scripts/builder-terminal.test.ts</files>
  <behavior>
    New exported pure functions (all in scripts/builder-terminal.ts, below the existing pure section, above the CLI shell):

    1. `formatElapsed(ms: number): string` — "40s" under 60s; "2m 40s" under 1h; "1h 5m" beyond. Negative/NaN → "0s".

    2. `isBuildInFlight(lastLine: FeedLine | undefined): boolean` — fail-closed in-progress predicate on the LAST feed line only:
       - `undefined` (empty feed / idle) → false
       - kind "stage-warn" → false (Regrouping…/Skipping this one end the show for this build)
       - kind "stage" with text === "Live on screen now" (the done caption) → false
       - kinds "title", "stage" (any other caption), "activity", "reasoning", "tool-call", "diff" → true
       - any unknown kind → false (fail closed)
       Tests MUST include a caption-sync test: import `createBuilderFeed` from `../../src/overlay/builder-feed.js`, drive `stage("done")` / `stage("building")` / `stage("failed")` on a real feed instance, and assert isBuildInFlight is false/true/false on the resulting `list()` lines — so if the server caption copy ever changes, this test breaks instead of the predicate silently rotting.

    3. `fileStatsFromFeed(feed: readonly FeedLine[]): { written: number; edited: number; lastPath: string | null }` — recomputed wholesale from the current feed (≤300 lines, cheap; naturally correct across reset diffs and ring drops). Parses ONLY kind "activity" lines with the exact prefixes "Writing " / "Editing "; counts DISTINCT paths per verb; `lastPath` = path of the last activity line (null when none). Non-activity lines and malformed activity text contribute nothing.

    4. `thinkingStatusLine(quietMs: number, stats: {written, edited, lastPath}): string | null` — null when `quietMs < THINKING_QUIET_MS` (export const = 10_000). Otherwise ONE dim styled line, no trailing newline:
       `· the AI is thinking — {formatElapsed(quietMs)} in…` and, when written+edited > 0, append ` · files: {written} written` (+ `, {edited} edited` when edited > 0) + ` · last: {lastPath}` when lastPath ≠ null.
       lastPath passes through `sanitizeWireText` before composition; the total PLAIN text (pre-styling) is truncated to LINE_MAX with the existing `truncate` pattern. Style: DIM open + RESET close only. Tests assert: null under 10s; contains no red SGR codes (reuse RED_CODES pattern); contains no ESC bytes originating from a hostile lastPath; ≤ LINE_MAX plain chars.

    5. Pacing rework (same exported `paceCharsPerTick`, new spec): export const `BURST_DRAIN_CHARS = 8_000`; `paceCharsPerTick(backlog)` returns `backlog` when `backlog >= BURST_DRAIN_CHARS` (instant full drain of huge bursts), else `Math.max(7, Math.ceil(backlog / 40))` (≈2s decay constant vs the old 10s). UPDATE the three existing paceCharsPerTick tests to the new bounds (floor now holds for backlog ≤ 280; growth is ceil/40; monotonicity still holds across the 8000 jump). ADD a drain-bound test: simulate `while (B > 0) { B -= paceCharsPerTick(B); ticks++ }` from B = 16_000 and from B = 7_999, asserting `ticks * 50ms ≤ 10_000ms` in both cases (the "seconds not minutes" guarantee).
  </behavior>
  <action>
    TDD gate (repo convention): FIRST commit the failing tests — `test(quick-260716-rtd): failing tests for liveness helpers + burst-drain pacing` — run `npx vitest run tests/scripts/builder-terminal.test.ts` and confirm the new tests fail (existing suite otherwise green). THEN implement the four helpers + pacing change in scripts/builder-terminal.ts and commit green — `feat(quick-260716-rtd): liveness helpers + burst-drain typewriter pacing`. Keep the existing "no control characters in source patterns" discipline in the test file (use \uXXXX escapes). Do not touch renderLine's kind vocabulary or sanitizeWireText.
  </action>
  <verify>
    <automated>npx vitest run tests/scripts/builder-terminal.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>All new helpers exported and covered (incl. the createBuilderFeed caption-sync test); updated pacing tests pin the ≤10s drain bound; two atomic commits (RED then GREEN); src/ untouched by `git diff --name-only`.</done>
</task>

<task type="auto">
  <name>Task 2: CLI status-line lifecycle wiring + header/runbook note</name>
  <files>scripts/builder-terminal.ts, docs/OPERATIONS.md</files>
  <action>
    Wire the helpers into `main()` (the thin I/O shell — per repo convention it is not unit-tested; all logic worth testing landed in Task 1):

    1. State: `connected = false`; `lastRenderActivityAt = Date.now()` (refreshed whenever handleMessage produces a reset repaint OR appends ≥1 rendered line); `statusActive = false`; `stats` recomputed via `fileStatsFromFeed(feed)` inside handleMessage on every accepted push.
    2. `clearStatus()`: if statusActive → write `\r${ESC}[2K`, set statusActive = false. Call it FIRST in: paintAll/paintIdle, drainTick when backlog.length > 0 (before the first write of that tick), and the socket 'close' handler (before the waiting line).
    3. `statusTick()` on its own 1000ms interval: if `!connected || backlog.length > 0 || !isBuildInFlight(lastFeed[lastFeed.length - 1])` → clearStatus() and return. Else compute `line = thinkingStatusLine(Date.now() - lastRenderActivityAt, stats)`; null → clearStatus(); else write `\r${ESC}[2K${line}` (NO trailing newline — in-place repaint; safe because the backlog is empty so the cursor sits at column 0 after a completed `\n`, and the cursor is already hidden). Do NOT set needsRepaint — the line is fully self-erasing.
    4. Socket handlers: `open` → connected = true (existing attempts/waitingShown reset stays); `close` → connected = false + clearStatus() before the existing waiting line.
    5. Update the file header comment: document the ephemeral client-side liveness line (never enters the wire/feed/backlog; DIM only; repaint-in-place; T-ly4-01/02 wording stays binding) and the new pacing bound (typing debt ≤ ~10s worst case, bursts ≥ 8K chars blit instantly).
    6. docs/OPERATIONS.md §10: one bullet — during a build, ≥10s of quiet shows a dim in-place "the AI is thinking — Xm Ys in…" line with a files ticker; it self-erases when output resumes; long thinking passes (many minutes) are healthy and now visibly alive.

    Commit: `feat(quick-260716-rtd): thinking status line + files ticker in THE AI terminal` (docs may ride along or be a separate docs commit — executor's call).

    Deploy note for the SUMMARY (do not perform here): builder-terminal is a live real-terminal process — changes take effect on next launch of THE AI window per the startup ritual memory; no OBS browser-source refresh applies to this window (window capture, not CEF).
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>Full suite green at (or above) the dispatch baseline; tsc and biome clean; `git diff --name-only` across the whole task touches ONLY scripts/builder-terminal.ts, tests/scripts/builder-terminal.test.ts, docs/OPERATIONS.md; status line provably absent from wire-facing structures (it is written directly to stdout, never pushed to backlog/lastFeed).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| /builder wire → terminal | Already-screened server-composed lines; still treated as untrusted bytes for terminal-restyle purposes (T-ly4-01) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-rtd-01 | Tampering | thinkingStatusLine lastPath | mitigate | lastPath re-passes sanitizeWireText before styling; plain-text LINE_MAX truncation; DIM-only styling (no red, ever) |
| T-rtd-02 | Info Disclosure | status line content | accept | Composed solely from elapsed time, local counters, and paths already displayed on the same screened surface — no new information class reaches the broadcast |
| T-rtd-03 | DoS | burst full-drain (≥8K chars blit) | accept | Bounded by DIFF_MAX=16K per line + ring 300; a one-shot 16K stdout write is trivial for a real terminal |
| T-rtd-04 | Spoofing | in-flight predicate vs server captions | mitigate | Caption-sync test drives a REAL createBuilderFeed instance so caption drift breaks CI instead of silently mis-showing/hiding the thinking line |
</threat_model>

<verification>
- `npx vitest run` — full suite green at/above dispatch baseline (~1303 + concurrent rll additions); no existing test modified except the three paceCharsPerTick bound tests explicitly re-pinned in Task 1.
- `npx tsc --noEmit` and `npx biome check .` clean.
- `git diff --name-only <base>..HEAD` → exactly scripts/builder-terminal.ts, tests/scripts/builder-terminal.test.ts, docs/OPERATIONS.md. src/overlay/server.ts, src/orchestrator/build-session.ts, src/overlay/builder-feed.ts byte-identical (screened-superset + screening-order tests untouched and green by construction).
- Grep gates: `grep -c "includePartialMessages" scripts/builder-terminal.ts` → 0; `grep -c "heartbeat" src/overlay/builder-feed.ts` → 0 (no wire kind sneaked in).
</verification>

<success_criteria>
- A viewer watching THE AI window during a multi-minute thinking pass sees, within ~10s of quiet, a calm dim line with live-updating elapsed time (and a files ticker once files exist) — and can distinguish a healthy think from a hang without any new wire surface.
- Read/Write/Edit activity continues to stream exactly as today; the ticker summarizes it client-side.
- A 16KB screened diff burst is fully on screen within seconds of arrival.
- All hard compliance rails intact: closed kinds, screen-before-feed, amber-never-red, ANSI-strip, ring/backstop bounds, idle + reconnect behavior unchanged.
</success_criteria>

<output>
Create `.planning/quick/260716-rtd-dynamic-builder-feed-liveness-heartbeat-/260716-rtd-SUMMARY.md` when done.
</output>
