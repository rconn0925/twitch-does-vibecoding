---
status: diagnosed
trigger: "Finished build's task re-executes. Task 6bb0528e rebuilt 13s after done (solo_pick same second); task 12dff1cb rebuilt 14s after done, two build_history rows, two gallery publishes. VOTE_WAITS_FOR_BUILD=on, auto-cycle on, live chat 2026-07-16."
created: 2026-07-16T21:30:00Z
updated: 2026-07-16T22:05:00Z
mode: find_root_cause_only (READ-ONLY — concurrent executor owns the tree)
---

## Current Focus

hypothesis: CONFIRMED — see Resolution. Synchronous soloPick→onWinnerQueued→drainVoteQueue chain fires inside finalize()'s IDLE-before-dequeue window.
test: complete
expecting: —
next_action: hand off to fix planning (report below)

## Symptoms

expected: A task that reaches "done" is dequeued exactly once and never re-executed.
actual: Same task_id re-enters "building" 13-14s after "done". Task 12dff1cb produced TWO build_history rows and two gallery apps (app-9 AND app-10 with the same content).
errors: none (silent double-execution)
reproduction: Live 2026-07-16, VOTE_WAITS_FOR_BUILD=on (default), auto-cycle on. Deterministic whenever (a) a suggest phase ended mid-build and parked (fdl waitingForBuild), AND (b) the pool holds exactly 1 candidate when the build finishes.
started: First bit tonight — the night quick-260716-fdl (VOTE_WAITS_FOR_BUILD) went live.

## Eliminated

- hypothesis: "The 14s gap means something delays the DEQUEUE for seconds after the IDLE transition (gallery publish awaited between transition and remove)."
  evidence: finalize() is fully synchronous from transition("IDLE") (build-session.ts:550) to taskQueue.remove (:557); onBuildDone is fire-and-forget (main.ts:1626 `void galleryPublisher.publishNow(...)`). The dequeue happened milliseconds after done. The RE-EXECUTION DECISION was made 3ms after done (audit rows 955/1039, stream_mode=IDLE); the 13-14s to the second `building` row is run 2's OWN prologue: ~9s shipThenRotate gallery ship (serialized behind run 1's async publish) + ~4.5s COMP-02 pre-build classifier screen.
  timestamp: 2026-07-16T21:55:00Z
- hypothesis: "The deferred STATE_CHANGED drain (main.ts:2073 setImmediate) is the leak."
  evidence: setImmediate runs after finalize() completes (finalize is synchronous), so by then the head is dequeued. That call site is safe; its own comment (main.ts:2060-2066) documents the hazard correctly. The leak is a DIFFERENT, undeferred route into the same drainVoteQueue.
  timestamp: 2026-07-16T21:50:00Z

## Evidence

- timestamp: 2026-07-16T21:40:00Z
  checked: src/orchestrator/build-session.ts finalize() (lines 504-558)
  found: Order is (1) emitStage done :509, (2) onBuildDone hook :524 (fire-and-forget publish), (3) recordBuildHistory :538, (4) machine.transition("IDLE") :550, (5) setActiveTask(null) :552, (6) registry.unregister :556, (7) taskQueue.remove(task.id) :557. IDLE transition precedes dequeue by design; same shape in finalizeAborted (:592 vs :603) and skipTask (:1114 vs :1122).
  implication: Any synchronous STATE_CHANGED listener that reaches drainVoteQueue during step (4) sees the finished task still at the queue head.
- timestamp: 2026-07-16T21:42:00Z
  checked: src/state-machine/stream-mode.ts transition() (:77-84)
  found: `this.#mode = to; this.#emitter.emit(STATE_CHANGED, this.snapshot());` — synchronous emit, plain EventEmitter.
  implication: All STATE_CHANGED handlers execute inline inside build-session.ts:550.
- timestamp: 2026-07-16T21:45:00Z
  checked: src/state-machine/auto-cycle.ts (:200-204, :261-289, :375-381, :388-477)
  found: STATE_CHANGED handler calls #maybeBegin with NO deferral. With #waitingForBuild=true (fdl park), #maybeBegin routes to #resumeFromWait → #isEligible (mode IDLE passes) → #attemptRoundStart → startRound throws pool-too-small → pool.size()===1 → soloPick() (:444-445). The comment block at :394-408 even names the exact chain "enqueueWinner → onWinnerQueued → drainVoteQueue → machine.transition" — its re-entrancy analysis covered the scheduler's own phase bookkeeping but not finalize's IDLE-before-dequeue window.
  implication: The fdl resume is CAUSALLY CHAINED, synchronously, to the exact BUILD→IDLE transition instant.
- timestamp: 2026-07-16T21:47:00Z
  checked: src/main.ts soloPick (:960-1003), onWinnerQueued (:2056-2058), drainVoteQueue (:1978-2047)
  found: soloPick → enqueueWinner (new candidate queued) → recordSoloPick → onWinnerQueued() → drainVoteQueue() SYNCHRONOUSLY. drainVoteQueue guards: mode!==BUILD_IN_PROGRESS (mode is IDLE — passes), no live window, no chaos, head = taskQueue.list().find(isVoteOrigin). NO per-task started/finished mark exists — the only "am I already built?" protection is the mode check plus queue membership, and inside the window BOTH lie.
  implication: The drain captures the finished head by reference; finalize's later remove() cannot un-start it.
- timestamp: 2026-07-16T21:52:00Z
  checked: data/audit.db audit_log — incident 1 (rows 950-968)
  found: 954 pipeline_stage done 6bb0528e @02:14:56.464Z (mode BUILD_IN_PROGRESS) → 955 solo_pick 7ce49485 @02:14:56.467Z with stream_mode **IDLE** (+3ms — the machine is only IDLE inside finalize's window) → 956 gallery_publish published app-7 6bb0528e @02:15:05.539 (run 1's async onBuildDone publish) → 957 gallery_publish no-changes app-7 @02:15:05.780 (run 2 shipThenRotate's ship, serialized behind 956) → 958 workspace_reset "rotated to generation 8" → 959/960 COMP-02 PRE-BUILD re-screen of "build minecraft from scratch" (6bb0528e's own text) @02:15:09.680 → 961 pipeline_stage building 6bb0528e @02:15:09.680 → 962-964 streamer halt + sandbox_teardown + veto @02:18-02:19 killed run 2.
  implication: Run 2 trigger = solo_pick of a NEW candidate executing inside the 3ms window; head captured was the finished project-switch task; run 2 rotated the workspace AGAIN (gen 8) before being vetoed, leaving gen-8 debris.
- timestamp: 2026-07-16T21:54:00Z
  checked: data/audit.db audit_log — incident 2 (rows 1036-1062)
  found: 1038 done 12dff1cb @02:39:33.235 → 1039 solo_pick 87ea0116 @02:39:33.238 stream_mode **IDLE** (+3ms, identical signature) → 1040 published app-9 @02:39:42.340 (run 1 async publish) → 1041 no-changes app-9 @02:39:42.532 (run 2's ship) → 1042 workspace_reset gen 10 → 1043/1044 pre-screen of 12dff1cb's own text → 1045 building @02:39:47.053 (done+13.8s) → 1058 done @02:42:26 → 1062 published app-10 @02:42:35. Then 87ea0116 (the legitimate solo winner) built next (1059-1061).
  implication: 13.8s = 9.3s ship + 4.5s classifier — fully reconciled; no delayed-dequeue mechanism exists.
- timestamp: 2026-07-16T21:56:00Z
  checked: data/audit.db build_history
  found: 12dff1cb has TWO rows (id 41 @02:39:33, id 42 @02:42:26, both result 'built'). 6bb0528e has ONE row (id 37) — its run 2 was halted, and finalizeAborted deliberately writes no build_history row (CR-01, working as designed).
  implication: Double-run of a completing build double-counts history; a halted double-run does not.
- timestamp: 2026-07-16T21:58:00Z
  checked: main.ts onBuildDone wiring (:1623-1654), shipThenRotate (:1670-1721), announcePlayable (:1547-1577)
  found: onBuildDone is `void publisher.publishNow(...)` — async, resolves ~9s later. shipThenRotate AWAITS its own publishNow, then rotates + startBuild. announcePlayable's guard (:1564 `if (machine.mode !== "BUILD_IN_PROGRESS")`) suppressed run 1's play-link overlay push because run 2 had already re-entered BUILD_IN_PROGRESS — a secondary on-stream symptom (missing play link).
  implication: Both tasks were kind=project-switch, so run 2 went through shipThenRotate: extra generation rotation + duplicate gallery app. A kind=suggestion double-run would instead rebuild in the SAME workspace in continue mode (lighter damage, still a double build + double history row).

## Resolution

root_cause: |
  finalize() transitions the machine to IDLE BEFORE dequeuing the finished task
  (src/orchestrator/build-session.ts:550 vs :557). StreamModeMachine.transition()
  emits STATE_CHANGED synchronously (src/state-machine/stream-mode.ts:83). The
  quick-260716-fdl AutoCycleScheduler subscribes to STATE_CHANGED with NO
  deferral (src/state-machine/auto-cycle.ts:200-204) and, when a vote is parked
  behind the build (#waitingForBuild), resumes SYNCHRONOUSLY inside that emit:
  #maybeBegin → #resumeFromWait (:375) → #attemptRoundStart (:388) →
  startRound throws pool-too-small → pool size 1 → soloPick (main.ts:960) →
  enqueueWinner → onWinnerQueued (main.ts:994 → :2056) → drainVoteQueue
  (main.ts:1978) — all inside build-session.ts:550, BEFORE the dequeue at :557.
  drainVoteQueue's only re-run protections are the mode check (mode IS IDLE in
  the window) and queue membership (the finished task IS still queued in the
  window); there is no per-task started/finished mark. It captures the finished
  head by reference, transitions IDLE→BUILD_IN_PROGRESS (:2006), and re-executes
  it. The later taskQueue.remove() is a no-op against the captured reference.

  The 13-14s done→building gap is NOT a delayed dequeue: the re-execution
  decision landed 3ms after done (audit rows 955/1039, stream_mode=IDLE — the
  machine is only IDLE inside finalize's window, which timestamps the race
  exactly). The visible gap is run 2's own prologue: ~9s shipThenRotate gallery
  ship (its publishNow serialized behind run 1's fire-and-forget onBuildDone
  publish) + ~4.5s COMP-02 pre-build classifier screen, THEN the "building" row.

  Why fdl made it systematic tonight: pre-fdl, onWinnerQueued fired from round
  timers/phase-end timers — statistically never inside a sub-millisecond window.
  fdl chains the scheduler's resume CAUSALLY to the exact BUILD→IDLE emit, so
  the window is hit 100% of the time the parked vote resumes onto a 1-candidate
  pool (routine with minutes-long builds + 40s suggest phases + slow late-night
  chat). Both incidents carry the identical fingerprint. The chaosModePick
  "picked" arm (auto-cycle.ts:409-411 → main.ts:939) is the same latent
  synchronous shape (untriggered tonight). Call site (b) main.ts:2068-2076 was
  correctly deferred with setImmediate for EXACTLY this hazard — the
  onWinnerQueued route into the same drain was the missed path.
fix: |
  PROPOSAL ONLY (read-only session — not applied). Two layers, both cheap:

  1. ORDERING (primary): in build-session.ts, dequeue BEFORE the IDLE
     transition — move `deps.taskQueue.remove(task.id)` (and the
     registry.unregister) ABOVE the machine.transition("IDLE") block in
     finalize() (:549-557), finalizeAborted() (:592-603), and skipTask()
     (:1113-1122). Invariant: "a task is never discoverable in the queue once
     its terminal stage is recorded / the machine leaves BUILD_IN_PROGRESS."
     Side effect check: isVoteQueueFull's deliberate off-by-one (main.ts:1034)
     merely drops one emit earlier — benign; the h73 pending-window promote and
     scheduler eligibility don't read the queue head. With this fix, the
     in-window synchronous drain finds the NEW solo winner as head and starts
     it — correct behavior, equivalent to closeRound's synchronous start.

  2. GUARD (belt, defends all future drain paths): give drainVoteQueue a
     positive re-run check — skip/refuse a head whose id matches the
     just-finished build. Cleanest form: a `finishedTaskIds` tombstone
     (bounded Set, or compare against machine's last active task id cleared
     only AFTER dequeue), or a `started` mark stamped on the QueuedTask when a
     build first picks it up, with head-selection skipping started tasks.

  NOT recommended alone: deferring onWinnerQueued's drain via setImmediate —
  it would fix tonight's incidents but changes closeRound's deliberate
  synchronous VOTING_ROUND→BUILD_IN_PROGRESS semantics (main.ts:565-568) and
  leaves the underlying inverted ordering in place for the next synchronous
  listener someone adds.

  Regression tests to pin it:
  - Double-run regression: fake runner, fdl on, exactly 1 pooled approved
    candidate, suggest phase ends mid-build (scheduler parks). Drive build to
    done. Assert: exactly ONE pipeline_stage 'building' AND one build_history
    row per task_id; the NEXT build started is the solo-picked winner, not the
    finished task.
  - Ordering invariant: register a synchronous STATE_CHANGED listener in the
    test; on the BUILD→IDLE emit assert taskQueue.list() no longer contains
    the finished task id (pins dequeue-before-transition forever, including
    finalizeAborted and skipTask variants).
  - Kind matrix: repeat the double-run test with head.kind='suggestion'
    (plain rebuild) and 'project-switch' (assert exactly ONE workspace_reset
    row per win — tonight each double-run burned an extra generation).
  - History uniqueness: e2e sweep asserting no task_id has >1 build_history
    row with result='built'.
verification: |
  Not applied (diagnose-only). Evidence chain verified against audit.db:
  the stream_mode=IDLE solo_pick rows at done+3ms (955, 1039) are only
  producible inside finalize's transition-before-dequeue window, and the
  13-14s reconciliation (9s ship + 4.5s pre-screen) matches rows
  956/957/958/960/961 and 1040/1041/1042/1044/1045 to the millisecond.
files_changed: []

## Related Exposure

- 3+ runs of the same task: NOT possible via this window. Run 1's finalize
  removes the task from the queue milliseconds after the drain captures it, so
  a third capture has nothing to find; the mechanism requires live queue
  membership. Bounded at exactly 2 runs per incident.
- Gallery/index: no structural corruption observed. Damage is (a) duplicate
  apps — app-10 is a re-build of app-9's suggestion in a fresh generation;
  (b) an extra workspace generation burned per project-switch double-run;
  (c) generation-8 debris: 6bb0528e's vetoed run 2 had already rotated to
  gen 8 before the halt, and the next project-switch later shipped app-8 from
  that debris. Same-generation double publish (956 vs 957) was handled cleanly
  by the publisher's no-changes path (serialized, 240ms apart).
- build_history: double 'built' rows for a completing double-run (12dff1cb ids
  41/42) — pollutes the public changelog/history surface.
- Play-link announce: run 1's overlay play-link push was suppressed by the
  announcePlayable BUILD_IN_PROGRESS guard (main.ts:1564) because run 2 had
  already re-entered building — a user-visible secondary symptom.
- Latent sibling trigger: chaosModePick "picked" during a fdl resume takes the
  identical synchronous path (auto-cycle.ts:409-411 → main.ts:939) — would fire
  the same double-run if a chat-chaos window is live at BUILD→IDLE.
- Same inverted ordering (transition before remove) also exists in
  finalizeAborted (build-session.ts:592/:603) and skipTask (:1114/:1122) —
  currently unexploited (no synchronous consumer races those), but the fix
  should reorder all three for one invariant.
