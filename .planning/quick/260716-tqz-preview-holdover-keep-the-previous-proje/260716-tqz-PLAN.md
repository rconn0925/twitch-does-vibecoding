---
phase: quick-260716-tqz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/main.ts
  - tests/e2e/preview-reroot.e2e.test.ts
  - src/orchestrator/sandbox-process.test.ts
autonomous: true
requirements: [QUICK-260716-TQZ]
tags: [preview, dev-server, obs, holdover, reroot]

must_haves:
  truths:
    - "During a project-switch build (new generation), the OBS LIVE BUILD preview keeps serving the PREVIOUS project's directory for the entire build — no STANDING BY / empty-listing window"
    - "The moment the new project's build finalizes done, the preview reroots to the new generation's directory (one stop+start pair, serialized, fail-open)"
    - "A FAILED / skipped / aborted project-switch build never reroots — the previous project stays on screen until a later successful done (or an explicit operator action)"
    - "Boot, console new-project, save-and-close, and swap activation still reroot IMMEDIATELY (byte-equivalent behavior for those paths)"
    - "During the holdover window the overlay playUrl shows the PREVIOUS project's URL (matches what viewers see), flipping to the new project only after done + publish creates the new row"
  artifacts:
    - path: "src/main.ts"
      provides: "previewHoldoverGeneration state + deferred done-time reroot riding the onBuildDone hook + holdover-aware playUrl source"
    - path: "tests/e2e/preview-reroot.e2e.test.ts"
      provides: "gated-runner holdover matrix: mid-build no-reroot, done-time reroot, failed-build no-reroot, playUrl coherence, immediate-path pins"
  key_links:
    - from: "src/main.ts shipThenRotate confirmed-ship branch (~line 1789)"
      to: "previewHoldoverGeneration"
      via: "sets holdover instead of calling reRootPreview()"
      pattern: "previewHoldoverGeneration"
    - from: "src/main.ts onBuildDone hook (~line 1626)"
      to: "reRootPreview"
      via: "holdover check FIRST (before the galleryPublisher early-return), fire-and-forget"
      pattern: "onBuildDone"
    - from: "src/main.ts playUrl.current() (~line 2366)"
      to: "overlayPlayRepoStmt"
      via: "generation: previewHoldoverGeneration ?? workspace.generation()"
      pattern: "previewHoldoverGeneration \\?\\? workspace\\.generation\\(\\)"
---

<objective>
Preview holdover: when a project-switch winner rotates the workspace and starts building the NEW generation, the app-under-construction preview (WSL2 dev server on 5555, framed by the OBS LIVE BUILD slot) must KEEP serving the PREVIOUS generation's directory until the new build finalizes `done` — then reroot. Today `shipThenRotate` fires `reRootPreview()` at rotation time, so viewers stare at an empty listing / STANDING BY card for the entire multi-minute build (live incident 2026-07-16 ~20:2x, gen-8).

User ask verbatim (Ross, 2026-07-16): "when building a new project. i want the previous project to be visable on stream until the new project completes its build."

Purpose: viewers always have a real app on screen; the swap is instantaneous at build completion.
Output: deferred done-time reroot for the project-switch path only; holdover-aware playUrl; all other reroot triggers byte-equivalent; e2e matrix proof.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/main.ts (reroot seam + all call sites — see interfaces below)
@src/preview/dev-server-supervisor.ts (reroot(): serialized, never rejects, late-bound workspaceDir() — NO changes needed here)
@src/orchestrator/build-session.ts (onBuildDone contract, lines 145–152 + 517–534)
@tests/e2e/preview-reroot.e2e.test.ts (the suite to extend; previewSandbox/recordingRunner/voteKindToVictory helpers)
@tests/e2e/build-flow.e2e.test.ts (fetchPlayUrl helper pattern, line ~400: GET /api/state → state.playUrl)
@tests/e2e/save-and-close.e2e.test.ts (rll pins — consult before touching saveAndCloseProject; do not break its assertions)
@.planning/debug/260716-double-build-execution.md (t1n ordering lesson — nothing synchronous rides finalize's IDLE transition)
</context>

<interfaces>
<!-- Verified against the working tree 2026-07-16. Executor: use these anchors directly. -->

**src/main.ts reroot seam and call sites (5 total):**
- Line ~465: `let reRootPreview: () => void = () => {};` (late-bound; assigned at ~2308 to `() => void devServerSupervisor.reroot()`)
- Line ~1501: console new-project wrapper (`workspace.newProject()` then `reRootPreview()`) — IMMEDIATE, stays
- Line ~1692–1695: `saveAndCloseProject` — rotates + reroots only when `workspace.scaffolded()` — IMMEDIATE, stays, BUT see the wipe-intent-after-rotation edge case in Task 2
- Line ~1789–1799: `shipThenRotate` confirmed-ship branch — `const rotated = workspace.newProject(); … reRootPreview();` — THIS is the one that defers
- Line ~2025: `runSwapWinner` activation → `reRootPreview()` — IMMEDIATE, stays (activation IS the completion; there is no build)
- Line ~2311: boot `void devServerSupervisor.reroot();` — IMMEDIATE, stays

**src/main.ts onBuildDone hook (~1626):** currently starts with `if (!galleryPublisher) return;` — the holdover reroot must run BEFORE that early-return. build-session.ts guarantees (lines 145–152, 517–534): called ONLY on a `done` finalize, synchronously while still BUILD_IN_PROGRESS, inside its own try/catch — failed/refused/comp02-rejected/aborted/skipped exits NEVER call it.

**src/main.ts playUrl source (~2365–2373):**
```typescript
playUrl: {
  current: () => {
    try {
      if (!db.open) return null;
      const row = overlayPlayRepoStmt.get({ generation: workspace.generation() }) as
        | { repo_name: string } | undefined;
      return row ? galleryPlayUrl(galleryOwner, row.repo_name) : null;
    } catch (err) { /* fail-closed → null */ }
  },
},
```

**dev-server-supervisor.ts:** `reroot()` reads `workspaceDir()` late-bound at cycle time (line 80), serializes on an internal chain, never rejects. Deferring the CALL to done-time automatically roots at the new gen dir — the supervisor needs ZERO changes.

**sandbox-process.ts startPreviewDevServer (~line 322):** launch payload ALREADY begins `mkdir -p ${dir} && cd ${dir} && nohup python3 …` (added at t8k). The design-intent "mkdir race" item is therefore a TEST PIN, not an implementation change — and the empty-listing incident's real fix is the holdover itself (the rotation-time reroot was serving a freshly-mkdir'd EMPTY dir).
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: RED — gated-runner holdover matrix + playUrl coherence + mkdir pin (failing tests)</name>
  <files>tests/e2e/preview-reroot.e2e.test.ts, src/orchestrator/sandbox-process.test.ts</files>
  <behavior>
    New/updated e2e assertions in tests/e2e/preview-reroot.e2e.test.ts (extend the existing suite; reuse previewSandbox, fakeChatSource, until, voteKindToVictory, workspaceGeneration helpers):

    Add a GATED runner helper: like recordingRunner but the async generator awaits a per-build deferred before yielding resultSuccess (expose releaseNext(); a queue of deferreds so sequential builds each gate). This lets tests hold a build mid-flight deterministically.

    - HOLDOVER CORE (rewrites the existing "PROJECT-SWITCH winner rotation (confirmed ship) re-roots at the rotated dir" test): make gen N active (done build), seed a project_repos row for gen N (INSERT like the swap test does), then win a project-switch vote. While the new build is GATED mid-flight assert: (a) workspaceGeneration(app) === N+1 (rotation DID happen — publish/ship semantics untouched), (b) sandbox.starts.length UNCHANGED since before the vote (no reroot at rotation time), (c) GET /api/state on the overlay port → playUrl still equals the gen-N repo's galleryPlayUrl (previous project's URL — matches what viewers see; copy the fetchPlayUrl helper shape from tests/e2e/build-flow.e2e.test.ts ~line 400). Then releaseNext() → build finalizes done → assert exactly ONE new stop+start pair rooted at /home/builder/projects/app-{N+1}, and (after the fake publisher's row lands or via a seeded row) playUrl flips off the gen-N URL.
    - FAILED PATH PIN: a project-switch whose NEW build fails (runner yields an is_error result after the gate) → NO reroot fires (starts length unchanged after settling), playUrl still the previous project's URL. Resolve the frozen decision via the existing skip route (consult build-flow e2e for the skip/retry console call shape) — skip also does NOT reroot.
    - RECOVERY PIN: after that failed project-switch, a subsequent SUCCESSFUL done build (suggest-kind tweak on the new gen) DOES fire the deferred reroot at the new gen dir and clears the holdover (playUrl now derives from workspace.generation()).
    - IMMEDIATE-PATH PINS (existing tests must stay green as-is): boot, console new-project, swap activation, plain done build with no generation change (still re-roots NOTHING when no holdover is pending — assert a done suggest build with holdover ABSENT does not reroot).

    src/orchestrator/sandbox-process.test.ts: assert the startPreviewDevServer sh payload STARTS with `mkdir -p ${dir} && cd ${dir}` (the dir-exists guarantee is load-bearing for every reroot path — pin it so a future edit can't silently drop it). If an equivalent pin already exists, strengthen/skip accordingly.
  </behavior>
  <action>
    Write the tests above. The holdover-core, failed-path, recovery, and playUrl assertions MUST fail against the current code (rotation-time reroot). Do NOT modify src/. Keep the existing "SWAP activation", "BOOT", "CONSOLE new-project", "fail-open", "no wsl --terminate" tests untouched (they pin the unchanged exceptions). Commit RED: `test(quick-260716-tqz): failing holdover matrix — preview keeps previous project until new build done`.
  </action>
  <verify>
    <automated>npx vitest run tests/e2e/preview-reroot.e2e.test.ts src/orchestrator/sandbox-process.test.ts 2>&1 | tail -20</automated>
  </verify>
  <done>New holdover/failed/recovery/playUrl tests FAIL for the right reason (reroot observed at rotation time / playUrl null mid-holdover); untouched pins still pass; RED commit made.</done>
</task>

<task type="auto">
  <name>Task 2: GREEN — previewHoldoverGeneration + done-time reroot on the onBuildDone seam</name>
  <files>src/main.ts</files>
  <action>
    All changes in src/main.ts only (supervisor + build-session untouched):

    1. Next to the `reRootPreview` declaration (~465): add `let previewHoldoverGeneration: number | null = null;` and a helper `const rerootPreviewNow = (): void => { previewHoldoverGeneration = null; reRootPreview(); };` — every IMMEDIATE reroot path goes through it so a stale holdover can never outlive an operator action.

    2. shipThenRotate confirmed-ship branch (~1789): capture the outgoing generation BEFORE `workspace.newProject()` (the `generation` const at ~1760 already holds it), then REPLACE `reRootPreview()` with `previewHoldoverGeneration = generation;` — no reroot at rotation time. Comment: the deferred reroot rides onBuildDone; a failed/aborted new build keeps the previous project on screen by design (quick-tqz).

    3. onBuildDone hook (~1626): BEFORE the `if (!galleryPublisher) return;` early-return, insert the holdover discharge: `if (previewHoldoverGeneration !== null) { previewHoldoverGeneration = null; reRootPreview(); }`. This is a flag check + a void fire-and-forget call — build-session already wraps the hook in try/catch and reroot() never rejects, so nothing synchronous or throwing rides finalize's IDLE transition (t1n discipline; .planning/debug/260716-double-build-execution.md). Note: this MUST fire even when no galleryPublisher is composed — hence before the early-return.

    4. Immediate paths switch to the clearing helper: console new-project wrapper (~1501) and swap activation (~2025) call `rerootPreviewNow()` instead of `reRootPreview()`. saveAndCloseProject (~1692): the scaffolded branch calls `rerootPreviewNow()`; ALSO handle the wipe-intent-after-rotation edge (rll: shipThenRotate rotates + sets holdover, then dispatchBuild intercepts the wipe-intent winner and calls saveAndCloseProject on the UNSCAFFOLDED fresh gen — the old code path fires no reroot, which would strand the holdover and keep the dead project on screen forever): in the unscaffolded-skip branch, if `previewHoldoverGeneration !== null` call `rerootPreviewNow()` (the default screen IS the point of save-and-close). Consult tests/e2e/save-and-close.e2e.test.ts before editing — its existing pins must stay green.

    5. playUrl source (~2369): change the lookup generation to `previewHoldoverGeneration ?? workspace.generation()` — during holdover the overlay play link matches what viewers actually see; fail-closed try/catch and the no-row → null behavior unchanged. No wire shape change (value selection only); D3-12 holds — zero edits to src/preview/*.

    6. Boot reroot (~2311) unchanged (holdover starts null). Halt/abort paths: finalizeAborted/skipTask never call onBuildDone, so the holdover persists and the previous project stays visible after a halt mid-project-switch-build — intended, matches the failed-path decision.

    Run the Task 1 suite to GREEN, then the FULL gates: `npx vitest run` (baseline 1381 passing + new), `npx tsc --noEmit`, `npx biome check .`. Commit GREEN: `feat(quick-260716-tqz): preview holdover — previous project stays on the LIVE BUILD slot until the new build completes`.
  </action>
  <verify>
    <automated>npx vitest run 2>&1 | tail -5 && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>All Task 1 tests pass; full suite ≥1381 green with zero pre-existing test edits outside preview-reroot/sandbox-process test files; tsc + biome clean; GREEN commit made. Grep gates: `grep -c "reRootPreview()" src/main.ts` counts only the intended remaining direct call sites; `previewHoldoverGeneration ?? workspace.generation()` present in the playUrl source.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| chat → workspace dir | None new: the reroot dir is `workspace.dir()` (internally derived generation counter), never chat text — unchanged from t8k |
| overlay wire | No new fields; playUrl changes VALUE selection only (post-gate repo slug through the existing galleryPlayUrl funnel) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-tqz-01 | Information Disclosure | overlay playUrl during holdover | mitigate | value still sourced ONLY from durable project_repos rows (post-gate sanitizeRepoName slug); fail-closed try/catch → null retained |
| T-tqz-02 | Denial of Service | deferred reroot inside finalize | mitigate | flag check + fire-and-forget void call only; hook already try/catch-wrapped in build-session; supervisor serializes and never rejects (t1n ordering discipline held) |
| T-tqz-03 | Tampering | stale holdover strands preview on a dead dir | mitigate | rerootPreviewNow() clears holdover on every operator/immediate path (console new-project, swap, save-and-close); any later successful done also discharges it |
| T-tqz-SC | Tampering | npm/pip/cargo installs | accept | zero new dependencies in this task |
</threat_model>

<verification>
- Full suite ≥ 1381 + new tests passing; tsc --noEmit clean; biome check clean.
- tests/e2e/preview-reroot.e2e.test.ts proves: no reroot between rotation and done; exactly one stop+start at done rooted at the new gen dir; failed/skipped build → no reroot; recovery via next done; boot/console/swap/save-and-close immediate paths unchanged; playUrl = previous project's URL for the whole holdover window.
- src/preview/* byte-identical (D3-12: preview client/server stay orchestrator-state-free; supervisor untouched).
- sandbox-process.test.ts pins `mkdir -p ${dir} && cd ${dir}` at the head of the launch payload.
</verification>

<success_criteria>
- A project-switch build shows the PREVIOUS project on the OBS LIVE BUILD slot for the entire build, swapping to the new app the moment it finalizes done — proven e2e with a gated runner.
- Failed/aborted/skipped new-project builds keep the previous project on screen (reroot only on a successful done); pinned.
- Boot, console new-project, save-and-close, swap activation reroot immediately, exactly as before; pinned.
- Atomic commits scoped quick-260716-tqz (RED test commit + GREEN feat commit).
</success_criteria>

<output>
Create `.planning/quick/260716-tqz-preview-holdover-keep-the-previous-proje/260716-tqz-SUMMARY.md` when done.
</output>
