---
phase: quick-260716-fdl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/state-machine/auto-cycle.ts
  - src/state-machine/auto-cycle.test.ts
  - src/main.ts
  - src/ingestion/narration.ts
  - src/ingestion/narration.test.ts
  - src/overlay/server.ts
  - src/overlay/server.test.ts
  - src/overlay/public/overlay.js
  - src/overlay/overlay-copy.test.ts
  - src/operator-console/server.ts
  - .env.example
autonomous: true
requirements: [QUICK-260716-FDL]
must_haves:
  truths:
    - "While a build is in progress (default mode), the suggest phase ending does NOT open a vote round — the scheduler parks in a 'waiting' state"
    - "The moment the machine leaves BUILD_IN_PROGRESS for IDLE (any terminal: done/failed-resolved/refused-resolved/vetoed/halt-recovered), the parked vote opens against the warm pool — no new suggest window first"
    - "VOTE_WAITS_FOR_BUILD exact trimmed string 'false' restores today's voting-while-building pipelining byte-identically"
    - "!suggest intake keeps pooling during the wait (intake is not scheduler-gated; pool cap still governs)"
    - "The overlay phase banner shows a BUILDING/waiting message (no countdown) while parked, and chat gets one narration beat per park"
    - "HALT during the park stays frozen; halt-recover resumes; chaos vote-skip picks and paid-window direct queueing keep working mid-build"
  artifacts:
    - path: "src/state-machine/auto-cycle.ts"
      provides: "waiting-for-build park state + resume funnel, voteWaitsForBuild dep, snapshot phase 'waiting'"
      contains: "waitingForBuild"
    - path: "src/overlay/public/overlay.js"
      provides: "waiting-state phase banner branch"
      contains: "vote opens when it"
    - path: ".env.example"
      provides: "VOTE_WAITS_FOR_BUILD knob documented (strict-string, default ON)"
      contains: "VOTE_WAITS_FOR_BUILD"
  key_links:
    - from: "src/main.ts"
      to: "src/state-machine/auto-cycle.ts"
      via: "voteWaitsForBuild dep computed with the AUTO_ROUND_ENABLED strict-string idiom"
      pattern: "VOTE_WAITS_FOR_BUILD"
    - from: "src/overlay/server.ts"
      to: "overlay wire"
      via: "voteWaiting boolean narrowed from ac.phase === 'waiting'"
      pattern: "voteWaiting"
---

<objective>
Make the auto-cycle scheduler wait for build-idle before opening a vote round (default ON via new `VOTE_WAITS_FOR_BUILD` strict-string knob; exact `"false"` restores today's pipelining). Suggest intake keeps pooling during builds; the instant the build reaches ANY terminal state the parked vote opens with the warm pool. Overlay banner + one chat beat explain the wait. Recovery matrix (halt/recover, veto, toggle, window, chaos, queue-full) provably deadlock-free.

Purpose: In the default mode the show never runs a vote whose winner queues behind a multi-minute build — chat votes against the app state the build just produced. Build queue depth naturally stays ~1.
Output: Extended scheduler + wiring + overlay/narration surfaces + test matrix.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/state-machine/auto-cycle.ts
@src/state-machine/auto-cycle.test.ts
@src/main.ts (scheduler composition ~L930-1008; drainVoteQueue ~L1811-1925; overlay wiring ~L2060-2091)
@src/ingestion/narration.ts (~L540-565, the suggestionsOpen/buildQueueFull beats)
@src/overlay/server.ts (OverlayState ~L95-155; buildOverlayState ~L410-460)
@src/overlay/public/overlay.js (renderPhaseBanner ~L316-365; tick gate ~L559)
@src/operator-console/server.ts (ConsoleAutoCycleSource ~L131-136)

<interfaces>
Scouted seams (verified in this planning pass — the executor should NOT re-scout):

1. **Build lifecycle already reaches the scheduler via `machine` + STATE_CHANGED.** Every terminal build path in main.ts guardedly transitions `BUILD_IN_PROGRESS → IDLE` (finalize/finalizeAborted in build-session.ts; shipThenRotate/runRevertWinner/runSwapWinner backToIdle in main.ts ~L1591/1641/1671). `enterDecision` (failed/refused) FREEZES the machine in BUILD_IN_PROGRESS until the streamer resolves — keying the wait off `machine.mode === "BUILD_IN_PROGRESS"` therefore inherits exactly the right semantics for free: the vote stays parked through decision-pending and opens when the streamer's resolution returns the machine to IDLE. **No build-session.ts or new event plumbing needed.**

2. **The existing park mechanism to extend:** `#maybeBegin` (VOTE_QUEUE_MAX park — returns without beginning, rides subsequent STATE_CHANGED events, one narration beat per park via `#queueFullNarrated`) and `#onPhaseEnd`'s eligibility re-check. All resume pokes already funnel through `#maybeBegin`: the STATE_CHANGED subscription (ctor), ROUND_CLOSED subscription (ctor), `start()` (also poked by WINDOW_CLOSED/WINDOW_REVOKED in main.ts L1006-1007), and toggle-on.

3. **Snapshot consumers of `phase: "suggest" | null`:**
   - `src/overlay/server.ts` L431-432 narrows to `suggestPhase: {endsAtMs}|null` via `ac.phase === "suggest"` — unknown phases already fail closed to null.
   - `src/operator-console/server.ts` L133 types the seam — must widen the union.
   - `console.js` L420 uses `auto.phase === "suggest" ? ... : "Auto-cycle: on"` — an unknown phase falls to the generic label (safe; optional label improvement only).

4. **Intake is NOT scheduler-gated:** CandidatePool is bounded drop-oldest (POOL_MAX_SIZE, main.ts ~L393-396); !suggest pools whenever the gate approves, regardless of scheduler phase. "Suggest stays open during the wait" is already structurally true — assert it cheaply, don't build it.

5. **Chaos/window bypass already works mid-build:** chaos picks and paid-window instructions enqueue and drain through drainVoteQueue / driveWindowBuild independent of the scheduler; `chaosModePick` is consulted in `#onPhaseEnd` BEFORE startRound. Placing the new wait-check AFTER the chaosModePick branch preserves chaos vote-skip mid-build with zero extra code.

6. **Env idiom precedent (main.ts L945):** `const autoRoundEnabled = (process.env.AUTO_ROUND_ENABLED ?? "").trim() !== "false";`

7. **Narrator seam:** `AutoCycleNarrator` (auto-cycle.ts L59-63) → main.ts L991-995 late-binds to `windowNarrator` methods → implemented in `src/ingestion/narration.ts` (~L544-563; note suggestionsOpen/stillCollecting are deliberate no-ops by anti-spam directive, but buildQueueFull DOES post — the new beat should post like buildQueueFull, once per park).
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Scheduler waiting-for-build park state + resume funnel (core semantics + full test matrix)</name>
  <files>src/state-machine/auto-cycle.ts, src/state-machine/auto-cycle.test.ts</files>
  <behavior>
    Test matrix (extend the existing fake-harness idioms in auto-cycle.test.ts; the harness's fake machine can flip `.mode` and emit STATE_CHANGED — the same seam production uses):
    - Default wait (voteWaitsForBuild: true): suggest timer expiry while mode === "BUILD_IN_PROGRESS" → startRound NOT called; snapshot === { enabled: true, phase: "waiting", phaseEndsAtMs: null }; AUTO_CYCLE_CHANGED emitted; exactly ONE waitingForBuild narration beat.
    - Build terminal un-parks: mode flips to "IDLE" + STATE_CHANGED → startRound("auto") called immediately (NO new suggest phase first, no suggestionsOpen beat before the round). Covers done/failed-resolved/veto uniformly (all are the same BUILD_IN_PROGRESS→IDLE transition — assert in a comment, plus one explicit "veto un-parks" test that is just a second flip-to-IDLE case).
    - Pipelining restored: voteWaitsForBuild: false → phase end mid-BUILD_IN_PROGRESS calls startRound exactly as today (existing voting-while-building tests keep passing with the harness passing false).
    - Early close parks too: pool hits earlyCloseSize mid-build → phase closes early → snapshot phase "waiting" (no startRound); build end → startRound.
    - HALT mid-wait stays frozen: HALT_TRIGGERED then STATE_CHANGED with mode "HALTED" → nothing fires, still waiting; recover (mode "IDLE" + STATE_CHANGED) → startRound fires (warm pool).
    - Toggle-off mid-wait clears the wait: snapshot { enabled: false, phase: null }; toggle back on → fresh suggest phase (suggestionsOpen beat), the owed vote is NOT resurrected.
    - Chaos ordering: chaosModePick wired non-null + phase end mid-BUILD_IN_PROGRESS → the pick hook runs (chaos owns the phase end), NO waiting park. (Chaos bypasses rounds by design and keeps working mid-build.)
    - Window/queue-full at resume time: mode → IDLE while isControlWindowLive() true (or isVoteQueueFull true) → stays waiting; when the blocker clears (next STATE_CHANGED), startRound fires.
    - ROUND_CLOSED while waiting (manual round closed mid-park) → does NOT open a new suggest phase; still waiting if mode is still BUILD_IN_PROGRESS.
    - One beat per park: re-emitting STATE_CHANGED with mode still BUILD_IN_PROGRESS while waiting narrates ZERO additional beats.
    - Deadlock proof (the crash-restore shape): construct the scheduler with mode already "BUILD_IN_PROGRESS", start() → suggest phase opens (unchanged today), timer expiry → waiting, mode → IDLE → vote opens. No timer exists while waiting (resume is purely event-driven — assert via vi timer counts, the existing "no orphaned timer" idiom at test L470).
  </behavior>
  <action>
    In src/state-machine/auto-cycle.ts:
    1. Add REQUIRED dep `voteWaitsForBuild: boolean` to AutoCycleDeps (the enabledAtBoot precedent — main.ts always passes the computed value; no class-level default that could betray the production default). Add `waitingForBuild(): void` to AutoCycleNarrator.
    2. Widen AutoCycleSnapshot: `phase: "suggest" | "waiting" | null`. New private `#waitingForBuild = false` + `#waitNarrated = false` (mirror #queueFullNarrated). snapshot(): phase = "suggest" when #phaseEndsAtMs !== null, else "waiting" when #waitingForBuild, else null.
    3. Extract the vote-attempt tail of #onPhaseEnd (the chaosModePick consult + startRound try/catch with the solo/restart arms) into one private method (e.g. #attemptRoundStart()) so phase end and wait-resume run BYTE-IDENTICAL logic — never a parallel funnel.
    4. #onPhaseEnd: after the existing eligibility check passes and BEFORE #attemptRoundStart, insert the wait gate — `if (this.#deps.voteWaitsForBuild && this.#deps.machine.mode === "BUILD_IN_PROGRESS")` → set #waitingForBuild = true, narrate waitingForBuild() once per park (#waitNarrated), logger.info, #emitChanged(), return. PLACEMENT NOTE: the chaosModePick consult stays where it is only if it runs BEFORE the wait gate — chaos picks must keep firing mid-build (they enqueue FIFO; drainVoteQueue serializes). Order inside #onPhaseEnd: eligibility check → chaosModePick branch → wait gate → #attemptRoundStart.
    5. Resume routing: at the top of #maybeBegin (after the "already in a phase" guard), `if (this.#waitingForBuild) { this.#resumeFromWait(); return; }` — so EVERY existing poke (STATE_CHANGED, ROUND_CLOSED, start(), WINDOW_CLOSED/REVOKED via start()) funnels correctly with zero handler changes. #resumeFromWait(): re-run the SAME eligibility predicate #onPhaseEnd uses (enabled, round.snapshot() null, mode IDLE|BUILD_IN_PROGRESS, no window, no chaos, queue not full) — if it fails, stay waiting and return (this is what keeps HALT frozen); if mode is still BUILD_IN_PROGRESS, stay waiting and return; otherwise CLEAR #waitingForBuild + #waitNarrated FIRST (re-entrancy: #attemptRoundStart's chaos/solo arms call #maybeBegin, which must not redirect back here — recursion guard), then call #attemptRoundStart().
    6. toggle() off: also clear #waitingForBuild + #waitNarrated (streamer paused the cadence; the owed vote dies with the pause). #park() (halt) deliberately does NOT clear #waitingForBuild — halt-recover resumes the owed vote. dispose() unchanged.
    7. Update the module doc comment: the A1 "cadence never waits for a build" paragraph is now conditional on voteWaitsForBuild=false; document the default-ON wait and that queue depth stays ~1 in default mode. Do NOT remove VOTE_QUEUE_MAX/isVoteQueueFull or any pipelining machinery — pipelining mode still uses them.
    Test harness: add voteWaitsForBuild to the harness deps with harness-default `false` + a loud comment ("production default is TRUE — main.ts computes it; harness defaults false so the pre-fdl pipelining tests stay byte-identical; wait tests opt in") so every existing test passes unmodified.
  </action>
  <verify>
    <automated>npx vitest run src/state-machine/auto-cycle.test.ts</automated>
  </verify>
  <done>All new matrix tests pass; every pre-existing auto-cycle test passes unmodified; no repeating interval timer introduced (the existing source-scan test still passes); startRound is never called while waiting in default mode.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Composition + narration + env knob + overlay wire field</name>
  <files>src/main.ts, src/ingestion/narration.ts, src/ingestion/narration.test.ts, src/overlay/server.ts, src/overlay/server.test.ts, src/operator-console/server.ts, .env.example</files>
  <behavior>
    - narration.test.ts: waitingForBuild() sends exactly one chat line — pin the exact string: "Build in progress — the vote opens the moment it's done. Keep the !suggest ideas coming."
    - overlay/server.test.ts: extend the existing narrowing/defence-in-depth tests — OverlayState gains EXACTLY ONE new field `voteWaiting: boolean`; true iff the autoCycle source snapshot phase === "waiting"; suggestPhase stays {endsAtMs}|null and stays null while waiting; the scheduler's enabled flag still never crosses the wire.
  </behavior>
  <action>
    main.ts (scheduler composition block ~L942-998):
    - `const voteWaitsForBuild = (process.env.VOTE_WAITS_FOR_BUILD ?? "").trim() !== "false";` — the EXACT AUTO_ROUND_ENABLED strict-string idiom at L945 (only the exact trimmed string "false" disables the wait). Pass `voteWaitsForBuild` into the AutoCycleScheduler deps and add `waitingForBuild: () => windowNarrator?.waitingForBuild()` to the narrate object (L991-995 shape). Include voteWaitsForBuild in the boot log line at ~L2130.
    narration.ts (~L560, next to buildQueueFull):
    - `waitingForBuild(): void` on the WindowNarrator interface (~L119-126) + implementation sending the pinned line above. This beat POSTS to chat (the buildQueueFull precedent, once per park) — it is NOT one of the anti-spam no-ops, because it fires at most once per build, and chat needs to know why no vote countdown is running.
    overlay/server.ts:
    - Widen the OverlayAutoCycleSource snapshot type to accept phase "waiting"; add `voteWaiting: boolean` to OverlayState with a doc comment following the suggestPhase T-04-13 narrowing idiom (a bare boolean — no deadline, no richer field, since the wait has no known end time); in buildOverlayState: `voteWaiting: ac.phase === "waiting"`. suggestPhase narrowing (L431-432) unchanged.
    operator-console/server.ts L133:
    - Widen ConsoleAutoCycleSource snapshot phase to `"suggest" | "waiting" | null` (type-only; console.js's `=== "suggest"` ternary already fails safe to the generic "Auto-cycle: on" label — do not touch console.js).
    .env.example (next to AUTO_ROUND_ENABLED/VOTE_QUEUE_MAX ~L80-91):
    - Document VOTE_WAITS_FOR_BUILD: default ON — while a build runs, no vote round opens (suggest intake keeps pooling; the vote opens the moment the build ends). STRICT string check (AUTO_ROUND_ENABLED idiom): ONLY the exact value "false" restores voting-while-building pipelining (VOTE_QUEUE_MAX then governs, as before). `VOTE_WAITS_FOR_BUILD=` line with empty value.
  </action>
  <verify>
    <automated>npx vitest run src/ingestion/narration.test.ts src/overlay/server.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>tsc clean (main.ts required-dep enforcement proves the knob is wired); narration beat pinned; voteWaiting on the wire, narrowed, with suggestPhase/enabled-flag contracts intact; .env.example documents the knob.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Overlay waiting banner + copy pins + cheap unaffected-surface assertions</name>
  <files>src/overlay/public/overlay.js, src/overlay/overlay-copy.test.ts, src/state-machine/auto-cycle.test.ts</files>
  <behavior>
    - overlay-copy.test.ts: exact-string pins (raw-file grep idiom this suite uses) for the new banner copy — title "BUILDING — vote opens when it's done" and hint "keep the !suggest ideas coming" — plus a pin that the branch is gated on `voteWaiting` AND the BUILDING pill (no waiting banner during HALT).
    - Existing suggest-banner pins ("Suggestions open:", "type a command to jump in") and the T4 one-line-at-1080p hint pins stay green — the new branch must not disturb them.
  </behavior>
  <action>
    overlay.js renderPhaseBanner (L327-365) — insert ONE new branch between the liveRound branch and the suggestPhase branch (priority: VOTE NOW > waiting > suggestions):
    - Condition: `latest?.voteWaiting && !sp` plus a pill guard so the banner never shows during HALT or a paid window/chaos (those own the show): render only when the mode pill is the BUILDING pill (reuse whatever pill/mode signal the client already receives in `latest.pill` — check PILL_BY_MODE at L130 for the exact BUILDING pill value and compare against that). NOTE: while waiting, the server sends suggestPhase: null, so ordering alone also works — the pill guard is the HALT/window suppressor.
    - Render: same two-row structure (phase-toprow / phase-title / phase-hint classes — no new CSS), NO countdown element (the wait has no deadline). Title: "BUILDING — vote opens when it's done". Hint: "keep the !suggest ideas coming". Fixed copy only — never chat-derived (textContent via el(), the file's existing discipline).
    - The tick gate at L559 (`round open || suggestPhase` → 1s re-render) needs NO change: the waiting banner has no countdown and re-renders on server pushes.
    Cheap unaffected-surface assertions (add to auto-cycle.test.ts if not already covered by Task 1's matrix):
    - chaos pick mid-build proceeds (Task 1 chaos-ordering test — reference it in a comment as the COMP/chaos bypass assertion).
    - A control window live mid-build never interacts with the wait (window eligibility test from Task 1 covers it — paid-window direct queueing bypasses the scheduler entirely; drainVoteQueue/driveWindowBuild untouched by this change, assert via zero diffs outside the planned files).
    Do NOT touch comp02, suggest-intake, chaos/, or control-window code — COMP-03 rejection feedback and paid/chaos surfaces are untouched by construction (scheduler + display files only).
  </action>
  <verify>
    <automated>npx vitest run src/overlay/overlay-copy.test.ts && npx vitest run && npx tsc --noEmit && npx biome check src</automated>
  </verify>
  <done>Full suite green (was 1214 + new tests), tsc + biome clean; banner branch pinned; no diffs outside the 11 planned files.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| chat → scheduler | none new — the scheduler still never touches the gate/queue/pool contents (COMP-01 single-funnel intact); the wait keys off machine.mode only |
| server → overlay wire | one new field crosses the broadcast wire |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-fdl-01 | Information Disclosure | OverlayState.voteWaiting | mitigate | bare boolean, explicitly narrowed from ac.phase — no deadline/enabled-flag/rich field rides along (suggestPhase T-04-13 idiom, test-asserted in Task 2) |
| T-fdl-02 | Denial of Service | scheduler resume path | mitigate | resume is purely event-driven off STATE_CHANGED (no polling, no new timers — existing source-scan test governs); the deadlock matrix in Task 1 proves every park has a proven un-park event |
| T-fdl-03 | Tampering | overlay banner copy | mitigate | fixed strings only, textContent via el(), exact-string pinned in overlay-copy.test.ts — never chat-derived |
| T-fdl-SC | Tampering | npm installs | accept | zero new dependencies in this plan |
</threat_model>

<verification>
- `npx vitest run` — full suite green (baseline 1214 + new matrix/copy/wire tests)
- `npx tsc --noEmit` and `npx biome check src` clean
- Invariant suites (tests/invariants/*) untouched and green — single-funnel, paid-chaos separation, prompt-injection boundary all structurally unaffected (no gate/queue/chaos/window code modified)
- Manual sanity (optional, harness): `npx tsx scripts/overlay-harness.ts` to eyeball the waiting banner
</verification>

<success_criteria>
- Default mode: build running → suggest phase ends → NO vote; build terminal (any of done/failed-resolved/refused-resolved/veto/halt-recover) → vote opens immediately with the warm pool
- `VOTE_WAITS_FOR_BUILD=false` (exact trimmed string) restores today's pipelining; VOTE_QUEUE_MAX + FIFO queue machinery fully preserved
- Intake keeps pooling mid-build and mid-park (structurally unchanged, matrix-asserted)
- Overlay shows the waiting banner (suppressed during HALT); chat gets exactly one beat per park
- Recovery matrix proven: halt-frozen park, halt-recover resume, veto un-park, toggle semantics, window/chaos/queue-full interplay, boot-into-build shape — all deadlock-free with zero new timers
</success_criteria>

<output>
Create `.planning/quick/260716-fdl-vote-rounds-wait-for-builds-no-vote-roun/260716-fdl-SUMMARY.md` when done.

**SUMMARY MUST FLAG:** overlay.js is a CLIENT file cached by OBS CEF — on live deploy, restart the app AND refresh the OBS browser sources (`npm run obs -- refresh` per the OBS control tool memory), or the waiting banner will not appear.
</output>
