---
phase: quick-260711-nhv
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/overlay/builder-feed.ts
  - src/overlay/builder-feed.test.ts
  - src/orchestrator/build-session.ts
  - src/orchestrator/build-session.test.ts
  - src/orchestrator/index.ts
  - src/orchestrator/classifier-runner.ts
  - scripts/builder-terminal.ts
  - tests/scripts/builder-terminal.test.ts
  - docs/OPERATIONS.md
autonomous: true
requirements: [QUICK-NHV-01]

must_haves:
  truths:
    - "The /builder wire carries the build agent's reasoning prose, real tool-call lines (tool name + primary arg), and full-fidelity file diffs — not just the 5 fixed captions"
    - "No reasoning/tool-call/diff text ever reaches the feed unless the message it came from passed screenOutputBatch (COMP-02 approval precedes the sink call by control flow — a rejected batch contributes zero wire bytes)"
    - "Every displayed tool-call arg appeared verbatim in the text classify() screened — both extractors draw primary args from ONE shared primaryArg helper, so screened text is a strict superset of displayed args"
    - "Zero SDK types cross into builder-feed.ts or builder-terminal.ts — build-session.ts still narrows everything to display shapes first"
    - "buildStarted() still clears the ring; a halted build's feed just stops (no clear-on-terminal-stage, no false BUILT IT)"
    - "The terminal viewer renders the richer kinds at a typing pace so the OBS capture reads like a live Claude terminal (~5-15s behind real time), and unknown kinds still render nothing"
    - "comp02.ts is byte-identical — the single-funnel classify() contract is untouched"
  artifacts:
    - path: "src/overlay/builder-feed.ts"
      provides: "Widened closed line vocabulary (title|stage|stage-warn|activity|reasoning|tool-call|diff), ApprovedContentItem display union, contentApproved() sink, ring raised to 300, updated quick-x7d threat-register header"
      contains: "contentApproved"
    - path: "src/orchestrator/build-session.ts"
      provides: "extractScreenableText + extractApprovedContent narrowers at the containment boundary, both fed by a single shared primaryArg helper; widened in-flight screen trigger; sink call still strictly after the proceed guard"
      exports: ["extractScreenableText", "extractApprovedContent"]
    - path: "src/orchestrator/index.ts"
      provides: "Barrel re-export updated to extractScreenableText (no dangling extractWriteEditText re-export)"
      contains: "extractScreenableText"
    - path: "scripts/builder-terminal.ts"
      provides: "Renderers for reasoning/tool-call/diff + paced typewriter output"
      exports: ["paceCharsPerTick"]
    - path: "docs/OPERATIONS.md"
      provides: "§10 updated: --suppressApplicationTitle in the wt launch line, richer-feed description, expected ~5-15s screening lag documented as normal"
      contains: "--suppressApplicationTitle"
  key_links:
    - from: "src/orchestrator/build-session.ts"
      to: "src/overlay/builder-feed.ts"
      via: "builderFeed.contentApproved(extractApprovedContent(message)) placed strictly AFTER the `!screen.proceed → break` guard in consumeTurn (T-x7d-01 structural gate)"
      pattern: "contentApproved\\(extractApprovedContent"
    - from: "src/orchestrator/build-session.ts"
      to: "src/orchestrator/comp02.ts"
      via: "screenOutputBatch (unchanged single-funnel call — the ONLY screening entry point for in-flight content)"
      pattern: "screenOutputBatch\\(deps\\.comp02"
    - from: "src/orchestrator/index.ts"
      to: "src/orchestrator/build-session.ts"
      via: "barrel re-export renamed alongside extractWriteEditText → extractScreenableText"
      pattern: "extractScreenableText"
    - from: "scripts/builder-terminal.ts"
      to: "src/overlay/server.ts"
      via: "ws client of OverlayState.builderFeed (server's {kind,text} re-projection unchanged)"
      pattern: "builderFeed"
---

<objective>
Widen the screened /builder wire (quick-x7d's 5-kind fixed-caption projection) so it carries Claude's real build-session output — assistant reasoning prose, real tool-call lines (tool + primary arg), and full-fidelity file diffs — and teach the terminal viewer to render the new kinds at a typing pace, so the OBS "THE AI" window capture reads like a literal live Claude Code terminal running ~5-15s behind real time.

Purpose: the current feed is 5 canned captions + 200-char snippets — it looks like a status widget, not an AI building software. The show's centerpiece scene needs the real thing, WITHOUT weakening any of the quick-x7d / COMP-02 safety posture.

Output: widened builder-feed wire + build-session narrowing, richer paced terminal renderer, updated threat-register notes and §10 runbook, extended pure-core test suites.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/overlay/builder-feed.ts
@src/overlay/builder-feed.test.ts
@src/orchestrator/build-session.ts
@src/orchestrator/build-session.test.ts
@src/orchestrator/comp02.ts
@src/orchestrator/index.ts
@scripts/builder-terminal.ts
@tests/scripts/builder-terminal.test.ts
@docs/OPERATIONS.md

<interfaces>
<!-- Key contracts already in the codebase. Executor uses these directly. -->

From src/overlay/builder-feed.ts (CURRENT — being widened):
```typescript
export interface BuilderFeedLine { kind: "title"|"stage"|"stage-warn"|"activity"|"snippet"; text: string; }
export interface ApprovedBatchDisplay { verb: "Writing"|"Editing"; path: string; text: string; }
export interface BuilderFeedSink {
  buildStarted(title: string): void;   // clears the ring
  stage(stage: PipelineStage): void;   // fixed caption table only
  batchApproved(displays: ApprovedBatchDisplay[]): void;  // ← replaced by contentApproved()
}
export const DEFAULT_MAX_LINES = 50;   // → raise to 300
export const TITLE_MAX = 80;           // unchanged
export const SNIPPET_MAX_CHARS = 200;  // ← retired with the snippet kind
```

From src/orchestrator/build-session.ts (the SDK-shape containment boundary):
```typescript
const WRITE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export function extractAssistantText(message: unknown): string | null;      // keep
export function extractWriteEditText(message: unknown): string | null;      // → widen into extractScreenableText
export function extractApprovedBatchDisplays(message: unknown): ApprovedBatchDisplay[]; // → widen into extractApprovedContent
// consumeTurn(): the in-flight screen — batch = extractWriteEditText(message);
//   if batch → await screenOutputBatch(deps.comp02, {taskId, outputText}) →
//   recordComp02Decision → !screen.proceed ? (outcome="compliance-rejected"; break)
//   : deps.builderFeed?.batchApproved(extractApprovedBatchDisplays(message))  ← the T-x7d-01 structural gate
```

From src/orchestrator/index.ts (barrel — re-export MUST follow the rename or tsc fails):
```typescript
export {
  type BuildSession, type BuildSessionDeps, createBuildSession,
  extractAssistantText,
  extractWriteEditText,   // ← line 18: rename to extractScreenableText in the same commit
} from "./build-session.js";
```

From src/orchestrator/comp02.ts (DO NOT TOUCH — single-funnel contract):
```typescript
export function screenOutputBatch(deps: Comp02Deps, args: { taskId: string; outputText: string }): Promise<Comp02Outcome>;
```

From src/overlay/server.ts (NO CHANGE NEEDED — already narrows any richer source):
```typescript
builderFeed: feedSource.list().map((l) => ({ kind: l.kind, text: l.text }))  // T-x7d-04 re-projection
```

From scripts/builder-terminal.ts (pure core, tested):
```typescript
export function sanitizeWireText(text: string): string;         // ESC/C0/C1 strip BEFORE styling
export function renderLine(line: unknown): string | null;       // closed render map, null = fail closed
export function diffFeed(prev, next): { reset: boolean; appended: FeedLine[] };
export function backoffDelay(attempts: number): number;
```
</interfaces>
</context>

<design_decisions>
Locked decisions the executor implements without re-deriving (all trace to the task description + binding safety invariants):

1. **Wire vocabulary** becomes the closed 7-kind union `"title" | "stage" | "stage-warn" | "activity" | "reasoning" | "tool-call" | "diff"`. The `snippet` kind is RETIRED (superseded by `diff`); remove `capSnippet`, `SNIPPET_MAX_CHARS`, `SNIPPET_MAX_LINES`. `text` stays server-composed from screened data only. The /builder BROWSER page (src/overlay/public/builder.js) is deliberately NOT updated — it fails closed on the new kinds (renders title/stage/activity only). That is an accepted consequence: the "THE AI" scene captures the terminal viewer per OPERATIONS §10. Note this in the summary; do not touch builder.js.
2. **Display union (feed-side, replaces ApprovedBatchDisplay):**
   ```
   ApprovedContentItem =
     | { type: "reasoning"; text: string }
     | { type: "tool-call"; tool: string; arg: string }
     | { type: "file-change"; verb: "Writing" | "Editing"; path: string; text: string }
   ```
   Defined in builder-feed.ts (feed-side, never SDK-side). `batchApproved()` is replaced by `contentApproved(items: ApprovedContentItem[])`.
3. **Feed composition** (server-composed text, one BUILDER_FEED_CHANGED emit per contentApproved call, no emit on empty items):
   - reasoning → `{ kind: "reasoning", text }` capped at `CONTENT_MAX_CHARS`
   - tool-call → `{ kind: "tool-call", text: `${tool}(${arg-truncated-to-TOOL_ARG_MAX})` }` (arg may be "" → `${tool}()`)
   - file-change → `{ kind: "activity", text: `${verb} ${path}` }` followed by (only when text non-empty) `{ kind: "diff", text }` capped at `CONTENT_MAX_CHARS`
   - New constants: `DEFAULT_MAX_LINES = 300` (invariant 5: 200-500), `CONTENT_MAX_CHARS = 16_000` (a MEMORY backstop per T-x7d-07, not a display cap — full screened batches below it pass byte-for-byte), `TOOL_ARG_MAX = 160`.
4. **Screening widens, control flow does not change.** In build-session.ts consumeTurn, the in-flight trigger becomes: `screenText = extractScreenableText(message)` (assistant text blocks + every tool_use's name + primary arg + full Write/Edit content incl. WR-02 notebook keys and ALL `edits[].new_string`, not just the first). Primary args come from the SAME shared `primaryArg(input)` helper used by extractApprovedContent (decision 5) — this is the subset guarantee: any byte the feed can display as a tool-call arg was, by construction, part of the screened text. If non-null → the SAME `screenOutputBatch` call at the SAME place → reject still breaks to `compliance-rejected` (existing abort/narration path, unchanged) → approve → `deps.builderFeed?.contentApproved(extractApprovedContent(message))` strictly after the guard. Consequence (accepted by design): reasoning-only messages are now screened too, so a non-compliant reasoning batch aborts the build exactly like a non-compliant Write batch, and per-message classify() latency is what puts the terminal ~5-15s behind real time. Rename `extractWriteEditText` → `extractScreenableText` (update its tests, the barrel re-export in src/orchestrator/index.ts line 18, and the doc-comment reference in src/orchestrator/classifier-runner.ts line ~59).
5. **extractApprovedContent(message): ApprovedContentItem[]** (build-session.ts — the containment boundary): text blocks → reasoning items; tool_use blocks in WRITE_EDIT_TOOLS → file-change items (verb Write→"Writing", others→"Editing"; full text = content | new_string | new_source | ALL edits' new_string joined with "\n"; skip blocks with no string path — fail closed); every OTHER tool_use block → tool-call item `{ tool: block.name, arg }` where `arg = primaryArg(block.input)` — a single module-private helper `primaryArg(input: unknown): string` returning the first string value among input keys `command, file_path, path, pattern, url, prompt, description, query`, else "" (never a JSON dump of input). primaryArg is the ONLY primary-arg extraction in the module and is called by BOTH extractScreenableText and extractApprovedContent — no duplicated key lists. Raw SDK STRUCTURE (tool_use/input/block keys) still never crosses — tool NAMES now cross deliberately, as screened display data (update the T-x7d-02 header note accordingly).
6. **Unchanged semantics re-asserted, not redesigned:** buildStarted() clear-on-start + 80-char title; stage() fixed caption table + fail-closed unknown; no clear-on-terminal-stage / no abort method; server.ts wire re-projection untouched; comp02.ts untouched.
7. **Terminal typing pace:** appended rendered lines feed a character backlog drained on a ~50ms interval; exported pure `paceCharsPerTick(backlogChars: number): number` = `Math.max(7, Math.ceil(backlogChars / 200))` (≈140 chars/s baseline, accelerating with backlog so effective lag stays bounded ≈≤10s of typing debt on top of screening latency). A `reset` diff (new title / reconnect replay) flushes the backlog and repaints immediately. Keep the CLI shell thin; all new logic that can be pure MUST be exported + tested.
</design_decisions>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Widen the screened wire + containment boundary (builder-feed + build-session)</name>
  <files>src/overlay/builder-feed.ts, src/overlay/builder-feed.test.ts, src/orchestrator/build-session.ts, src/orchestrator/build-session.test.ts, src/orchestrator/index.ts, src/orchestrator/classifier-runner.ts</files>
  <behavior>
    builder-feed.test.ts (extend existing patterns):
    - contentApproved([reasoning, tool-call, file-change]) appends, in order: reasoning line, "Bash(npm install)"-style tool-call line, "Writing path" activity line + full diff line; ONE emit per call; empty items → no append, no emit.
    - diff text >200 chars and >3 lines passes through UNCUT below CONTENT_MAX_CHARS; text above CONTENT_MAX_CHARS is hard-capped with a trailing ellipsis (T-x7d-07 backstop).
    - Ring bound is 300: 310 appends keep the newest 300, oldest evicted.
    - Closed-kind test updated to the 7-kind set; "snippet" no longer producible by any sink method.
    - buildStarted still clears to exactly one title line (T-x7d-05); stage table + fail-closed unknown-stage tests unchanged and still green.
    build-session.test.ts (extend the quick-x7d describe block):
    - (a) STRUCTURAL GATE extended: a COMP-02-rejected message contributes ZERO wire bytes — now ALSO for a reasoning-only assistant message (text "FORBIDDEN-REASONING" with classify rejecting `-output` ids: serialized feed contains neither the reasoning text nor any tool arg; build aborts down the existing compliance-rejected path with the amber "Skipping this one" caption).
    - (b) approved Write batch lands "Writing <path>" + a FULL diff line (use >200-char content to prove the old snippet cap is gone).
    - (c) reworked vocabulary test: raw SDK tokens `tool_use`, `input`, `file_path`, `new_string` still never reach the wire; Write/Edit-family still render fixed verbs (MultiEdit → "Editing styles.css"); a non-write tool_use (e.g. name "Bash", input.command "npm install") lands as tool-call text "Bash(npm install)".
    - (d) abort/clear-on-next-build test unchanged and still green.
    - NEW screening-order test: with an instrumented fake comp02 that records call order, assert classify resolves BEFORE the feed receives the message's content (e.g. fake classify pushes "screen" to an order array; a wrapped feed pushes "feed" — order must be ["screen","feed"]); and a reasoning-only message DOES trigger exactly one `-output` screen.
    - NEW screened-superset test (T-nhv-07): with an instrumented fake comp02 that captures every `outputText` it screens, run a mixed message (reasoning + Bash tool_use + Write tool_use) through consumeTurn and assert every `contentApproved` item's displayable bytes appear verbatim in the captured screened text — each tool-call `arg`, each tool name, each reasoning text, each file-change path + text. Proves displayed content ⊆ classify() input (the shared primaryArg binding).
  </behavior>
  <action>
    In src/overlay/builder-feed.ts: widen BuilderFeedLine.kind to the 7-kind union; define ApprovedContentItem (design decision 2); replace batchApproved with contentApproved per decision 3; retire snippet/capSnippet/SNIPPET_* constants; set DEFAULT_MAX_LINES=300, add CONTENT_MAX_CHARS=16_000 and TOOL_ARG_MAX=160; keep buildStarted/stage/list/on and TITLE_MAX exactly as-is. REWRITE the header threat-register comment: T-x7d-01 wording unchanged in substance (every sink call still post-screening by control flow — now covering reasoning/tool-call/diff too); T-x7d-02 updated — vocabulary is a CLOSED 7-kind set, tool NAMES now cross as screened display data narrowed by build-session (raw SDK shapes/input keys still never cross); T-x7d-05 unchanged; T-x7d-07 updated — ring 300 + CONTENT_MAX_CHARS per-line memory backstop.

    In src/orchestrator/build-session.ts: add a single module-private `primaryArg(input: unknown): string` helper (decision 5's key-priority list) — it is the ONLY place the primary-arg key list exists, and BOTH extractors below call it (T-nhv-07: guarantees screened text ⊇ displayed args by construction, not by parallel-maintained lists). Rename extractWriteEditText → extractScreenableText and widen it per decision 4 (assistant text blocks + tool names + primaryArg(input) for every tool_use + full write/edit content; keep the WR-02 notebook_path/new_source handling and the edits[] loop); replace extractApprovedBatchDisplays with extractApprovedContent per decision 5 (tool-call arg = primaryArg(block.input)); in consumeTurn, keep the screening block EXACTLY where it is — only the trigger variable and the post-guard sink call change (screenOutputBatch call, recordComp02Decision, and the `!screen.proceed → break` remain byte-level identical in structure). Preserve and extend the T-x7d-01 STRUCTURAL GATE comment. Update the BuilderFeedSink import type and the deps.builderFeed doc comment. Do NOT touch comp02.ts, screenBuildPlan, translate(), the watchdog, or any finalize path.

    In src/orchestrator/index.ts: update the barrel re-export on line 18 from `extractWriteEditText` to `extractScreenableText` (rename-only; keep the SDK-free static import graph doctrine comment as-is).

    In src/orchestrator/classifier-runner.ts: update the line-59 doc comment's `extractWriteEditText` reference to `extractScreenableText` and adjust its parenthetical to match the widened output (screenable text: reasoning + tool names/args + file content). Doc-comment-only change — no behavior edits in this file.

    Update both test files per the behavior list, adjusting existing assertions that pinned the old 5-kind set / 50-line ring / 200-char snippet cap / batchApproved name. Existing writeBatch-script tests keep passing because write batches still produce exactly one screen per message.
  </action>
  <verify>
    <automated>npx vitest run src/overlay/builder-feed.test.ts src/orchestrator/build-session.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>7-kind closed wire live; reasoning/tool-call/diff flow only via the post-guard contentApproved call; rejected batches (including reasoning-only) contribute zero wire bytes; displayed args proven ⊆ screened text via the shared primaryArg helper + superset test; barrel re-export and classifier-runner doc comment follow the rename (no dangling extractWriteEditText anywhere — `grep -r extractWriteEditText src/` returns nothing); ring 300 bounded; comp02.ts untouched (git diff shows no change to src/orchestrator/comp02.ts); all builder-feed + build-session tests green; tsc clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Terminal renderer — new kinds + typewriter pacing</name>
  <files>scripts/builder-terminal.ts, tests/scripts/builder-terminal.test.ts</files>
  <behavior>
    tests/scripts/builder-terminal.test.ts (extend existing describe blocks):
    - renderLine handles the 7-kind set: "reasoning" renders as plain sanitized prose (no bullet); "tool-call" renders with the ⏺ marker and distinct styling from "activity"; "diff" renders the gutter block like the old snippet but WITHOUT the 200-char truncation (a 5000-char input survives past 200 chars; a >16_000-char input is backstop-capped); "snippet" now returns null (retired kind → fail closed like any unknown).
    - Distinct-styled-string test updated to the 7 kinds; no-red (D2-18) and sanitize-before-style tests extended to reasoning/tool-call/diff (smuggled ESC/[31m/[2J never survives in any kind).
    - Unknown/malformed shapes still return null.
    - paceCharsPerTick: returns 7 for backlog ≤ 1400; grows ceil(backlog/200) beyond; monotonically non-decreasing; e.g. paceCharsPerTick(20_000) === 100 — bounded catch-up so lag can't grow without bound.
    - diffFeed and backoffDelay tests unchanged and still green.
  </behavior>
  <action>
    In scripts/builder-terminal.ts: extend the renderLine closed map per the behavior list (reuse sanitizeWireText-before-styling and truncate; add a DIFF_MAX = 16_000 backstop mirroring the server's CONTENT_MAX_CHARS; remove the "snippet" case and SNIPPET_MAX; keep LINE_MAX=120 for single-line kinds — title/stage/stage-warn/activity/tool-call; reasoning and diff are multi-line and use the DIFF_MAX backstop only). Export paceCharsPerTick per design decision 7. Rework the CLI shell's output path: appended lines render to styled strings, join into a pending character backlog, and a ~50ms setInterval writes paceCharsPerTick(backlog.length) characters per tick (write whole ANSI escape sequences atomically — never split an ESC sequence mid-emission; simplest correct approach: backlog is an array of small chunks where each chunk is either a complete SGR sequence or plain characters, and the pacer counts only plain characters against the budget). On a reset diff: clear the backlog, CLEAR_SCREEN, paint the full feed instantly (a fresh build starts near-empty; like-live behavior resumes from there). Keep the idle/standing-by, reconnect/backoff, waiting-status, and cursor handling exactly as-is. Update the header comment: the wire is now the 7-kind screened vocabulary and the viewer intentionally trails real time ~5-15s (COMP-02 screening latency + typing pace); T-ly4-01/T-ly4-02 wording stays binding.
  </action>
  <verify>
    <automated>npx vitest run tests/scripts/builder-terminal.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>Terminal renders all 7 kinds claude-code-style at a typing pace with bounded catch-up; unknown + retired kinds render nothing; ANSI-injection and no-red guarantees proven for the new kinds; pure core fully covered; tsc clean.</done>
</task>

<task type="auto">
  <name>Task 3: Runbook + threat-register docs, full-suite sweep</name>
  <files>docs/OPERATIONS.md</files>
  <action>
    Update docs/OPERATIONS.md §10: (1) the launch line becomes `wt -w vibecoding-ai --title "THE AI" --suppressApplicationTitle -d C:\Users\ross\Projects\twitch-does-vibecoding npm run builder:terminal` and the bullet under it explains --suppressApplicationTitle keeps npm/tsx from overwriting the tab title OBS matches on; (2) replace the "Content is identical to /builder" paragraph: the feed now carries the build agent's screened reasoning, tool calls, and full file diffs — every batch still passes the SAME COMP-02 single-funnel screen before it reaches the wire, and the viewer intentionally runs ~5-15s behind real time (screening latency + typing pace) — this lag is normal, not a stall; (3) add a note that the /builder BROWSER page renders only the legacy kinds now (fails closed on the new ones) and the terminal viewer is the canonical "THE AI" capture. Then run the FULL verification sweep to prove no regression outside the touched seams (server.ts re-projection, main.ts wiring, invariant suites).
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>§10 documents the new launch line, richer feed, and expected lag; full suite (>=916 tests: prior 893 + new), tsc, and biome all green; git diff confirms src/orchestrator/comp02.ts and src/overlay/public/builder.js untouched.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| build agent → /builder wire | Agent-generated text (reasoning, tool args, file content) crosses to a broadcast surface — untrusted until COMP-02-approved |
| SDK message shapes → display modules | build-session.ts is the declared containment boundary; builder-feed.ts / builder-terminal.ts must stay SDK-free |
| wire text → OBS-captured terminal | Screened but agent-authored bytes are written to a live terminal (ANSI injection surface) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-nhv-01 | Information Disclosure | consumeTurn feed tap | mitigate | contentApproved() sits strictly after the `!screen.proceed → break` guard — rejected/unscreened content unreachable by control flow (extends T-x7d-01); test (a) asserts zero wire bytes incl. reasoning-only rejection |
| T-nhv-02 | Tampering | builder-feed line vocabulary | mitigate | Closed 7-kind union, server-composed text only; tool names cross deliberately as narrowed display data, raw SDK shapes/keys never do (updated T-x7d-02 header + test (c)) |
| T-nhv-03 | Elevation of Privilege | terminal renderer (ANSI injection) | mitigate | sanitizeWireText (ESC/C0/C1 strip) applied before styling on all 7 kinds incl. multi-KB diffs; injection tests extended (T-ly4-01) |
| T-nhv-04 | Denial of Service | feed ring / terminal backlog | mitigate | Ring 300 + CONTENT_MAX_CHARS=16000 per-line backstop (T-x7d-07); paceCharsPerTick backlog-proportional catch-up bounds terminal lag |
| T-nhv-05 | Repudiation | widened screening cadence | accept | Every screen still writes a recordComp02Decision audit row (unchanged call); more rows per build is a cost, not a gap |
| T-nhv-06 | Spoofing | stale next-build lines | mitigate | buildStarted() clear-on-start unchanged; no clear-on-terminal-stage; halted feed just stops (T-x7d-05 tests kept green) |
| T-nhv-07 | Information Disclosure | extractor drift (screened vs displayed) | mitigate | Single shared primaryArg(input) helper is the only primary-arg extraction, called by BOTH extractScreenableText and extractApprovedContent; screened-superset test asserts every displayed tool-call arg/name/reasoning/diff byte appeared verbatim in the fake comp02's captured outputText |
| T-nhv-SC | Tampering | npm/pip installs | accept | Zero new dependencies in this plan (hand-rolled ANSI + node:timers only) |
</threat_model>

<verification>
- `npx vitest run` — full suite green (builder-feed, build-session incl. invariants/single-funnel suites, builder-terminal, server).
- `npx tsc --noEmit` and `npx biome check .` clean.
- `git diff --stat` touches ONLY the 9 files in files_modified; `src/orchestrator/comp02.ts`, `src/overlay/server.ts`, `src/overlay/public/builder.js` unchanged.
- `grep -r extractWriteEditText src/ scripts/` returns nothing — the rename is complete across code, barrel, and doc comments.
- Grep proof of the structural gate: in build-session.ts the `contentApproved(` call appears once, inside the `if (!screen.proceed)`-guarded block's fall-through (after the break), mirroring today's shape.
</verification>

<success_criteria>
- The /builder wire carries reasoning, tool-call, and full-diff lines composed only from COMP-02-approved batches; a rejected batch (any content type) contributes zero wire bytes and aborts down the existing narrated path.
- Displayed tool-call args are provably a subset of screened text: one shared primaryArg helper feeds both extractors, and the superset test locks it in.
- builder-feed.ts and builder-terminal.ts contain zero SDK type imports/shapes; all narrowing stays in build-session.ts.
- Ring bounded at 300 lines with a 16K per-line backstop; buildStarted still clears; halted feeds freeze.
- Terminal viewer types the richer feed like a live Claude session with bounded lag; unknown kinds render nothing; no red, no ANSI passthrough.
- OPERATIONS §10 launch line includes --suppressApplicationTitle; lag documented as expected behavior.
- Full suite + tsc + biome green.
</success_criteria>

<output>
Create `.planning/quick/260711-nhv-high-fidelity-screened-builder-feed/260711-nhv-SUMMARY.md` when done.
</output>
