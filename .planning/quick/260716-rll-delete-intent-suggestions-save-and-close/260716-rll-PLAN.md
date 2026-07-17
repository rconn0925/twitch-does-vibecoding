---
phase: quick-260716-rll
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/orchestrator/destructive-intent.ts
  - src/orchestrator/destructive-intent.test.ts
  - src/ingestion/narration.ts
  - src/ingestion/narration.test.ts
  - src/audit/record.ts
  - src/audit/record.test.ts
  - src/audit/schema.sql
  - src/main.ts
  - tests/e2e/save-and-close.e2e.test.ts
autonomous: true
requirements: [QUICK-260716-RLL]

must_haves:
  truths:
    - "A gate-approved suggestion whose text asks to delete/wipe/reset the app/repo/project NEVER reaches the build agent — whether it arrives as a vote winner, a solo pick, a chaos pick, or a paid free-reign window instruction"
    - "Instead, the system saves-and-closes: the workspace rotates to a fresh generation via the EXISTING new-project rotation (repos are never deleted anywhere in src/)"
    - "Viewers see a calm chat beat ('saved to the gallery and closed') and the default overlay state: playUrl null (PLAY IT line hidden), preview STANDING BY, next auto-cycle round continues"
    - "Every save-and-close writes an audit row (event_type project_closed) — never silent"
    - "Non-destructive suggestions build exactly as before — the full 1303-test baseline stays green"
  artifacts:
    - path: "src/orchestrator/destructive-intent.ts"
      provides: "isDestructiveIntent(text): boolean — deterministic, total, never-throws matcher"
      exports: ["isDestructiveIntent"]
    - path: "src/main.ts"
      provides: "dispatchBuild wrapper (the ONE point all build dispatches converge) + saveAndCloseProject"
      contains: "dispatchBuild"
    - path: "src/ingestion/narration.ts"
      provides: "projectClosed() beat on WindowNarrator"
    - path: "src/audit/record.ts"
      provides: "recordProjectClosed (event_type project_closed)"
      exports: ["recordProjectClosed"]
    - path: "tests/e2e/save-and-close.e2e.test.ts"
      provides: "e2e proof across vote-winner/solo, free-reign window, chaos paths + structural grep gates"
  key_links:
    - from: "src/main.ts dispatchBuild"
      to: "src/orchestrator/destructive-intent.ts"
      via: "isDestructiveIntent(task.text) checked before buildSession.startBuild"
      pattern: "isDestructiveIntent"
    - from: "src/main.ts saveAndCloseProject"
      to: "workspace.newProject() + reRootPreview()"
      via: "the EXISTING console new-project rotation flow, reused verbatim"
      pattern: "workspace\\.newProject\\(\\)"
    - from: "drainVoteQueue / shipThenRotate / driveWindowBuild / driveChaosBuild"
      to: "dispatchBuild"
      via: "ALL five former buildSession.startBuild call sites route through the one wrapper"
      pattern: "await dispatchBuild\\("
---

<objective>
When a gate-approved chat suggestion whose intent is to DELETE/WIPE/RESET the app or repo is about to be handed to the build agent (vote win, solo pick, chaos pick, or paid free-reign window), intercept it and SAVE-AND-CLOSE the project instead: keep the gallery repo published (repos are never deleted), rotate the workspace to a fresh empty generation via the existing new-project flow, narrate an amber "saved & closed" beat, audit it, and let the show loop continue on the default overlay state.

Purpose: live incident 2026-07-16 ~19:41 (audit ids 885-891) — "I want you to delete the whole app" passed the gate (correctly), was solo-picked, and only an unrelated infra failure stopped the build agent from wiping the VOIDFARER workspace. User directive (verbatim): "in the future any commands to delete the repo should just save and close the project. then viewers just see the default overlay screen."

Output: destructive-intent matcher module, projectClosed narration beat, project_closed audit helper, dispatchBuild interception wrapper in main.ts, e2e + structural gates. Suite grows from the 1303 baseline; tsc + biome stay clean.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@.planning/STATE.md
@src/main.ts
@src/ingestion/narration.ts
@src/audit/record.ts
@.planning/quick/260711-q5n-chat-command-layer-a/260711-q5n-SUMMARY.md

<interfaces>
<!-- Extracted from the codebase 2026-07-16. Executor should use these directly. -->

**The five `buildSession.startBuild(` call sites in src/main.ts (ALL inside the `if (opts.agentRunner && opts.sandboxAdapter)` orchestrator block) — these are the complete set of build-dispatch points; every source converges here:**

| Line (approx) | Site | Call |
|---|---|---|
| ~1674 | shipThenRotate path (i) — unscaffolded workspace | `await buildSession.startBuild(head, "vote")` |
| ~1719 | shipThenRotate path (iii) — post-rotation build | `await buildSession.startBuild(head, "vote")` |
| ~2037 | drainVoteQueue kind-router `default` (suggestion) arm | `await buildSession.startBuild(head, "vote")` |
| ~2106 | driveWindowBuild (paid free-reign instruction) | `await buildSession.startBuild(task, windowProvenance)` |
| ~2142 | driveChaosBuild (console chaos toggle pick) | `await buildSession.startBuild(task, "chaos")` |

Note: comments at main.ts ~936 and ~992 mention `startBuild(head, "vote")` WITHOUT the `buildSession.` prefix — a grep for `buildSession.startBuild(` on non-comment lines counts only real call sites.

**Routing facts (why wrapping startBuild covers every named source):**
- Vote winners AND solo picks (zero-votes-earliest-wins) AND chat-chaos-mode picks (`chaosModePick`) all ride `enqueueWinner` → `onWinnerQueued` → `drainVoteQueue`'s kind router.
- Paid free-reign instructions ride `submitDuringWindow` → queue → `driveWindowBuild`.
- Console chaos-toggle picks ride `submitChaosPick` → queue → `driveChaosBuild`.
- Swap/revert/chaos-winner arms never call startBuild — naturally excluded (their texts are fixed/server-composed anyway).

**State-machine mechanics the interception relies on (all pre-existing):**
- All three drives transition to `BUILD_IN_PROGRESS` BEFORE the async IIFE that calls startBuild. A normal build finalizes back to IDLE; each drive's completion continuation then keys off `machine.mode === "IDLE"` (drainVoteQueue re-drains; driveWindowBuild returns to FREE_REIGN_WINDOW + drains next; driveChaosBuild returns to CHAOS_MODE + re-picks). Therefore: if saveAndCloseProject ends with a guarded `machine.transition("IDLE")`, ALL THREE continuations work unchanged — zero continuation edits.
- `machine.on(STATE_CHANGED, ...)` handler (b) at ~2068 drains the next vote winner on →IDLE via `setImmediate` (skips when prev mode was HALTED). It re-checks mode at fire time, so a window/chaos continuation that has already re-entered FREE_REIGN_WINDOW/CHAOS_MODE makes it a no-op.
- The transient done-beat link clears itself: `machine.on(STATE_CHANGED)` at ~475 nulls `playableUrl` whenever mode becomes BUILD_IN_PROGRESS — the momentary pass through BUILD_IN_PROGRESS during an intercepted dispatch clears any stale PLAY IT beat for free.
- The persistent `playUrl` overlay field is PULL-based (main.ts ~2254): recomputed per push from `workspace.generation()` → `project_repos` row → `galleryPlayUrl`; a fresh rotated generation has no row → `null` → the PLAY IT banner line hides (quick-ko2). NO overlay/server.ts or overlay.js change is needed — only an e2e assertion.

**Existing rotation flow to REUSE (console new-project, main.ts ~1494):**
```typescript
const generation = workspace.newProject();  // sync, returns new generation number
reRootPreview();                            // fire-and-forget; supervisor fail-opens
```
Also available: `workspace.scaffolded(): boolean` (used by shipThenRotate ~1673) and `workspace.generation(): number`.

**Interception precedent (runChaosWinner / runRevertWinner idiom):** remove the head from the queue FIRST via `taskQueue.remove(head.id)` — nothing else dequeues an intercepted task (startBuild's finalize normally owns the dequeue).

**Narration — WindowNarrator interface + impl in src/ingestion/narration.ts (follow the q5n beat idiom, e.g.):**
```typescript
/** The pre-rotation ship failed — staying on the current project (never a silent rotate). */
newProjectShipFailed(): void;
// impl:
newProjectShipFailed(): void {
  void deps.sender.send("Couldn't ship the current project to the gallery just now — ...");
},
```
Beats are server-composed fixed copy; failure/regroup lines are AMBER-TIER (D2-18): no ERROR/red/alarm words, no chance words, no money words (copy-separation scans).

**Audit — follow the recordRevertOutcome idiom in src/audit/record.ts:**
```typescript
export function recordRevertOutcome(
  db: Database.Database,
  args: { taskId: string; status: ...; detail: string | null; streamMode: StreamMode },
): void {
  insert(db, { createdAtMs: Date.now(), eventType: "revert_outcome", source: "operator",
    twitchUsername: null, suggestionText: null, decision: args.status, category: null,
    rationale: args.detail, streamMode: args.streamMode, taskId: args.taskId });
}
```
audit_log has no CHECK constraints — a new event_type is a schema-safe addition (comment-only schema.sql change, per the revert_outcome precedent).

**CRITICAL append-only scan (record.test.ts ~593):** `record.ts` source must NOT match `/UPDATE|DELETE/i` — anywhere, including comments and string literals. The new helper's doc comment, rationale strings, and identifiers must use "wipe-intent" / "destructive" / "close" wording — the word "delete" may never appear in record.ts. (q5n tripped this exact gate with the word "update" in a comment.)

**Single-funnel invariant (tests/invariants/single-funnel.test.ts):** scans for `DELETE FROM` (SQL — purge.ts only), `as QueuedTask` (gate.ts only), `toQueuedTask` referenced only by pipeline/{submit,round,paid-window,chaos}.ts. The new matcher module references NONE of these — the invariant stays green untouched. `taskQueue.remove(...)` is already used by runRevertWinner/runChaosWinner and is not scanned.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Destructive-intent matcher + projectClosed narration beat + project_closed audit helper</name>
  <files>src/orchestrator/destructive-intent.ts, src/orchestrator/destructive-intent.test.ts, src/ingestion/narration.ts, src/ingestion/narration.test.ts, src/audit/record.ts, src/audit/record.test.ts, src/audit/schema.sql</files>
  <behavior>
    Matcher `isDestructiveIntent(text: string): boolean` — deterministic, total, never throws, case-insensitive. MANDATED test table (RED commit first):

    Positives (→ true):
    - "I want you to delete the whole app"  (the live incident text, audit 885-891)
    - "delete the app"
    - "wipe the repo"
    - "please nuke the project"
    - "erase everything"
    - "reset the whole project"
    - "destroy the codebase"
    - "clear it all"
    - "wipe all of it"
    - "DELETE EVERYTHING" (case-insensitivity)
    - "remove the entire repository"

    Negatives (→ false; false negatives are acceptable by design, these false-positive shapes are NOT):
    - "add a reset button to the app"   (verb+noun-in-between must not bridge to a distant target)
    - "remove the app's dark mode"      (possessive target — the app is the owner, not the object)
    - "remove the red button"
    - "delete the second todo item"
    - "clear the scoreboard when the game ends"
    - "make a nuke-themed tower defense game"
    - "reset the score to zero"
    - "" (empty string)
    - the exact REVERT_REQUEST_TEXT constant from src/ingestion/command-parser.ts

    Narration: new `projectClosed(): void` beat — exact-string pinned, amber-tier, no chance/money/alarm words.
    Audit: `recordProjectClosed` inserts exactly one `project_closed` row with server-composed rationale (generation integers only, NEVER chat text); the record.ts append-only scan (`/UPDATE|DELETE/i` absent) must stay green.
  </behavior>
  <action>
    Locked design (D-1 of the task context): detection is deterministic regex/keyword matching over the APPROVED text — the Sonnet gate classifier surface (GATE_MODEL, schema, prompts, src/compliance/**) stays byte-untouched.

    1. Create `src/orchestrator/destructive-intent.ts` exporting `isDestructiveIntent(text: string): boolean`. Recommended internal shape (executor may refine as long as the mandated test table passes): verbs `delete|wipe|erase|remove|destroy|nuke|reset|clear` reach a target `app|application|repo|repository|project|codebase|workspace|everything` only across a bounded connector gap of determiners/quantifiers (`the|this|that|it|its|my|our|your|whole|entire|current|all|of`) — an arbitrary-noun gap must NOT bridge (kills "add a reset button to the app"); add a possessive negative lookahead on the target (`(?!['’]s)` — kills "remove the app's dark mode"); plus explicit phrase forms for `it all` / `all of it` (e.g. "clear it all", "wipe all of it"). Module doc comment cites the 2026-07-16 incident and states the policy: false negatives fall through to a normal build (today's behavior); false positives save-and-close (non-destructive, recoverable). No imports from pipeline/gate/queue modules — a pure text predicate.
    2. `src/ingestion/narration.ts`: add `projectClosed(): void` to the WindowNarrator interface + impl, following the newProjectShipFailed idiom. Copy (polish allowed, keep the substance + amber tone): "Project saved to the gallery and closed — fresh canvas! Keep the ideas coming." Fixed server-composed string, no dynamic tokens, no chat text. Pin the exact string in narration.test.ts like sibling beats.
    3. `src/audit/record.ts`: add `recordProjectClosed(db, { taskId, closedGeneration, freshGeneration, streamMode })` → one insert, eventType `"project_closed"`, source `"operator"`, decision `"saved-and-closed"`, suggestionText null, rationale server-composed e.g. `Chat asked to wipe the project — generation ${closedGeneration} stays published in the gallery; workspace closed and rotated to fresh generation ${freshGeneration}`. ABSOLUTE CONSTRAINT: the word "delete" (and "update") may not appear ANYWHERE in record.ts — doc comment must say "wipe-intent"/"destructive-intent", never "delete-intent". Add the record.test.ts row-shape test (recordRevertOutcome test idiom) and confirm the structural append-only scan still passes.
    4. `src/audit/schema.sql`: comment-only enumeration addition for `project_closed` (revert_outcome precedent).

    TDD: commit failing tests `test(quick-260716-rll): failing matcher + beat + audit specs for wipe-intent save-and-close`, then implementation `feat(quick-260716-rll): destructive-intent matcher, projectClosed beat, project_closed audit row`.
  </action>
  <verify>
    <automated>npx vitest run src/orchestrator/destructive-intent.test.ts src/ingestion/narration.test.ts src/audit/record.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>All mandated positive/negative matcher cases pass; projectClosed beat exact-string pinned; project_closed row test green; record.ts append-only scan green; tsc clean; two atomic commits (RED, GREEN).</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: dispatchBuild interception at the ONE convergence point + save-and-close + e2e proof + structural gates</name>
  <files>src/main.ts, tests/e2e/save-and-close.e2e.test.ts</files>
  <behavior>
    e2e (new file tests/e2e/save-and-close.e2e.test.ts, mirroring the tier1-commands.e2e.test.ts harness):
    - Test 1 (the incident shape — solo pick): a delete-intent suggestion is the ONLY pool entry, round closes, it wins → the fake agentRunner is NEVER invoked; the task leaves the queue; `workspace.generation()` advanced by exactly 1; a `project_closed` audit row exists; the chat sink received the projectClosed beat; machine settles at IDLE; the overlay state's `playUrl` is null (PLAY IT hidden — quick-ko2 verification the task context requires).
    - Test 2 (loop continues): after Test 1's save-and-close, a second, normal suggestion wins the next round → it builds (agentRunner invoked once) — the auto-cycle/drain continuation is alive.
    - Test 3 (free-reign window): window open + "!build <delete-intent text>" via submitDuringWindow path → no agent run, rotation happened, machine returns to FREE_REIGN_WINDOW while the window is still live, and a FOLLOW-UP normal window instruction builds (driveWindowBuild continuation intact).
    - Test 4 (chaos path): a delete-intent candidate picked through a chaos path (chat-chaos `chaosModePick` or console chaos toggle — executor picks whichever the existing harness reaches most directly) → no agent run, rotation + audit + beat.
    - Test 5 (control): a non-delete suggestion builds exactly as before (explicit agentRunner-invoked assertion).
    - Test 6 (already-fresh canvas): delete-intent wins while the workspace is UNSCAFFOLDED (nothing built yet) → NO rotation (generation unchanged), but beat + audit still fire — never silent.
    - Structural gate A: read src/main.ts, drop `//`-comment lines, count occurrences of `buildSession.startBuild(` → exactly 1 (inside dispatchBuild). All build dispatches provably route through the interceptor.
    - Structural gate B: scan all files under src/ — zero matches for `gh repo delete`, `repos/` + `-X DELETE`, or `method: "DELETE"` (repos are never deleted; grep-gate per locked decision 3). Use comment-filtered scans per grep-gate hygiene.
  </behavior>
  <action>
    In src/main.ts, inside the orchestrator composition block, immediately after `orchestrator = buildSession;` (~line 1657), add two helpers:

    `saveAndCloseProject(task: QueuedTask): void` —
    (a) `taskQueue.remove(task.id)` FIRST (runChaosWinner/runRevertWinner idiom — startBuild's finalize normally owns the dequeue; an intercepted task must not linger at the head);
    (b) capture `const closed = workspace.generation()`; if `workspace.scaffolded()` → `const fresh = workspace.newProject(); reRootPreview();` (the EXACT console new-project reuse — locked decision 3; no new publish step: "save" is already true from the last done-build publish); if unscaffolded → skip rotation, `fresh = closed` (double-rotation guard — also covers a delete-intent project-switch arriving after shipThenRotate already rotated);
    (c) `if (db.open) recordProjectClosed(db, { taskId: task.id, closedGeneration: closed, freshGeneration: fresh, streamMode: machine.mode })`;
    (d) `windowNarrator?.projectClosed();`
    (e) guarded return to idle: `if (machine.mode === "BUILD_IN_PROGRESS") { try { machine.transition("IDLE"); } catch (err) { logger.error(...) } }` — ending at IDLE is what makes ALL THREE existing completion continuations (drain-next / window-return / chaos-repick) work with ZERO edits (see interfaces block). Do steps in exactly this order: remove → rotate → audit → narrate → transition (the STATE_CHANGED→IDLE drain is setImmediate-deferred, so the queue is already clean when it fires).

    `dispatchBuild(task: QueuedTask, provenance: BuildProvenance): Promise<void>` — the ONE convergence point (locked decision 2):
    `if (isDestructiveIntent(task.text)) { saveAndCloseProject(task); return; } await buildSession.startBuild(task, provenance);`
    Import `isDestructiveIntent` from `./orchestrator/destructive-intent.js`. Doc comment: cites the 2026-07-16 incident + Ross's verbatim directive, and states the structural invariant "buildSession.startBuild has exactly ONE call site — this wrapper" (enforced by structural gate A).

    Replace ALL FIVE `buildSession.startBuild(` call sites (~1674, ~1719, ~2037, ~2106, ~2142) with `await dispatchBuild(...)`, preserving each site's exact provenance argument. NO other main.ts logic changes: drainVoteQueue's guards/prologue, shipThenRotate's ship-gating, driveWindowBuild/driveChaosBuild continuations, HALTED/halt paths, and the console new-project route all stay byte-identical (locked decisions 2, 6). Note shipThenRotate ships BEFORE dispatchBuild runs — a delete-intent `!build` therefore ships the outgoing app first (a bonus save), and saveAndCloseProject's unscaffolded-skip prevents a wasteful second rotation.

    Then the e2e file + both structural gates per the behavior block. Harness notes: compose the app the way tests/e2e/tier1-commands.e2e.test.ts does (fake agentRunner/sandboxAdapter/gate/publisher, fake chat sink); the overlay `playUrl` assertion reads the overlay state the way existing overlay e2e assertions do (build state → `playUrl` field null after rotation because the fresh generation has no project_repos row).

    Deliberately OUT of scope (do not touch): src/compliance/** (gate stays byte-untouched — locked decision 1), src/overlay/server.ts + overlay client JS (playUrl null-hiding already works), console routes/UI, halt.ts, paid-window.ts, scheduler.

    TDD: commit failing e2e + gates `test(quick-260716-rll): failing save-and-close interception matrix (vote/solo, window, chaos) + structural gates`, then `feat(quick-260716-rll): wipe-intent winners save-and-close via the one dispatchBuild funnel`.
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check src tests</automated>
  </verify>
  <done>Full suite green (≥ 1303 baseline + new tests, zero baseline modifications); invariant suites (single-funnel, paid-chaos separation, prompt-injection boundary) untouched and green; structural gate proves exactly one buildSession.startBuild call site; no repo-deletion strings under src/; tsc + biome clean; two atomic commits (RED, GREEN).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| chat → matcher | Gate-approved but still viewer-authored text reaches isDestructiveIntent |
| matcher → workspace rotation | A text predicate now triggers a state-changing action (rotation) |
| rotation → audit/narration | Outcome must be publicly visible + durably recorded, without leaking chat text into server-composed rows |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-rll-01 | DoS | isDestructiveIntent regex | mitigate | Bounded, linear patterns only (fixed alternations + bounded connector gap); total function, never throws; unit-tested on empty/long input. No user-controlled pattern construction. |
| T-rll-02 | Tampering | saveAndCloseProject | mitigate | Rotation is the EXISTING non-destructive newProject flow (old generation dir archived in place, gallery repo untouched); structural gate B proves zero repo-deletion calls exist in src/. False positives are recoverable by building anew. |
| T-rll-03 | Repudiation | project_closed audit | mitigate | recordProjectClosed row on EVERY interception (including the unscaffolded no-rotation case) — never silent; taskId links back to the winning suggestion's intake rows. |
| T-rll-04 | Info disclosure | audit rationale / chat beat | mitigate | Rationale interpolates internally-generated generation integers only; the beat is a fixed server-composed string — no chat text, no donor detail (recordRevertOutcome doctrine). |
| T-rll-05 | Elevation | second queue path | mitigate | Interception only REMOVES from the queue and never enqueues; single-funnel invariant suite must stay green (verified in Task 2's full-suite run). |
| T-rll-SC | Tampering | npm installs | accept | Zero new dependencies in this plan. |
</threat_model>

<verification>
- Full suite: `npx vitest run` — ≥ 1303 baseline + new tests, 0 failures, no baseline test files modified.
- `npx tsc --noEmit` clean; `npx biome check src tests` clean.
- Invariant suites green untouched: single-funnel, paid-chaos-separation, prompt-injection-boundary, secrets-isolation, dom-safety.
- Structural gate A (in the new e2e file): comment-filtered count of `buildSession.startBuild(` in src/main.ts === 1.
- Structural gate B: zero repo-deletion call patterns under src/.
- Gate classifier surface untouched: `git diff --stat` shows no changes under src/compliance/, src/overlay/server.ts, public/ client JS, halt.ts, paid-window.ts.
</verification>

<success_criteria>
- The live-incident text "I want you to delete the whole app", arriving via ANY of vote-win / solo pick / chaos pick / paid free-reign window, provably never invokes the agent runner and instead rotates to a fresh generation with beat + audit (e2e matrix).
- Repos are never deleted; the last published gallery state persists (structural gate + no new publish step added).
- Default viewer state after close: playUrl null on the overlay wire (e2e-asserted), STANDING BY preview (pre-existing quick-ofs behavior, unchanged files), next round continues (e2e Test 2).
- Non-delete suggestions and HALTED/halt behavior byte-unchanged.
- 4 atomic commits scoped quick-260716-rll (2× RED, 2× GREEN), TDD order.
</success_criteria>

<output>
Create `.planning/quick/260716-rll-delete-intent-suggestions-save-and-close/260716-rll-SUMMARY.md` when done.
</output>
