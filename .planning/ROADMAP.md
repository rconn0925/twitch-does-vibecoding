# Roadmap: Twitch Does Vibecoding

## Overview

Build the safety spine first — a single compliance chokepoint and an always-reachable streamer kill switch — before any chat input can touch anything. Then wire the live chat loop (suggest → filter → vote → winner) as the first demoable slice, running entirely through that gate. Next comes the most novel piece: the sandboxed agent build engine plus the on-stream show (overlay build status, live app preview), sequenced after safety and gated behind a Windows sandboxing spike. Only once the filter/veto path is battle-tested on the free vote path does paid influence ship (external-platform donations and channel points, never Bits), alongside chaos mode as a strictly separate mechanic. v1 closes with persistent build history and a full end-to-end dry run on a test channel — the rehearsal for the first real stream night, which is the project's own definition of done.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Compliance Gate & Kill Switch** - Single-funnel ToS filter, state machine, and operator veto — the safety spine, adversarially tested before any chat input exists (completed 2026-07-09)
- [x] **Phase 2: Chat Vote Loop** - Twitch EventSub ingestion, !suggest/!vote rounds, chat narration, and live vote overlay — the first end-to-end demoable slice (completed 2026-07-10)
- [ ] **Phase 3: Sandboxed Build Engine & Live Show** - Agent orchestrator (Sonnet research, Fable build) in a WSL2/Docker sandbox, second-pass output screening, build overlay, and live app preview
- [ ] **Phase 4: Paid Influence & Chaos Mode** - Donation free-reign windows (external platform), channel points micro-control, and chaos mode — all through the identical gate
- [ ] **Phase 5: Build History & Stream Night Dry Run** - Persistent changelog and a full-loop rehearsal on a test channel before the first real stream night

## Phase Details

### Phase 1: Compliance Gate & Kill Switch

**Goal**: Every possible path to the build queue runs through one adversarially-tested compliance chokepoint, and the streamer can halt anything, from anywhere, in seconds
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: COMP-01, COMP-04, COMP-05
**Success Criteria** (what must be TRUE):

  1. A candidate instruction can only become a queued task by passing through the single compliance gate — code review confirms no component (including future paid/admin paths) can enqueue any other way
  2. The gate correctly classifies a fixture suite spanning all 13 taxonomy categories, including adversarial cases (paraphrase, obfuscation, encoding tricks, prompt-injection strings), with uncertain cases escalated rather than auto-approved
  3. Streamer can veto or kill any queued or in-progress task from the operator console page (and/or hotkey) from any system state, and the halt resolves within seconds even against a synthetic hung task
  4. Every filter decision and every veto is logged with the triggering input and is reviewable after the fact

**Plans**: 5 plans

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Walking Skeleton: scaffold, shared types, state machine + audit ledger, console with Halt Everything (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Gate classification engine: 15-category taxonomy, adversarial fixture suite, prefilter, fail-closed Sonnet classifier (wave 2)
- [x] 01-03-PLAN.md — Kill switch: global double-tap hotkey, tree-kill abort, synthetic hung-task proof (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-05-PLAN.md — Gate chokepoint: classify() + branded QueuedTask funnel, review workflow, HALTED-gated submission pipeline (D-02), live Sonnet eval (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-04-PLAN.md — Operator console completion: review queue, HALTED triage, veto + reason tags, audit page, 90-day purge, single-funnel invariant test (wave 4)

**UI hint**: yes

Research-adjacent: the adversarial test suite design (jailbreak/paraphrase/obfuscation cases) and two-pass prompt design need dedicated design work during planning (per research SUMMARY flags for this phase).

### Phase 2: Chat Vote Loop

**Goal**: Chat can suggest, vote in timed rounds, and see the winner queued — live on the overlay, with every suggestion routing through the Phase 1 gate
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, COMP-03, INFRA-01, INFRA-02, PRES-01
**Success Criteria** (what must be TRUE):

  1. A viewer types `!suggest <idea>` and the idea either enters the candidate pool or gets category-level rejection feedback in chat
  2. Chat votes with `!vote 1/2/3` in timed rounds; each viewer gets one vote, a revote overrides, and the live tally plus round timer render on the OBS browser-source overlay
  3. The winning suggestion is announced in chat and lands in the build queue via the compliance gate
  4. The bot narrates round open/close/winner in chat while staying inside its rate-limit budget (high-frequency state goes to the overlay, not chat)
  5. Killing the connection mid-round recovers cleanly — EventSub resubscribes, state reconciles, and no votes or queued tasks are silently lost

**Plans**: 6 plans

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Round & vote ledger engine: RoundManager, write-through SQLite votes, halt-freeze, crash restore (wave 1)
- [x] 02-02-PLAN.md — Twitch client foundation: twurple install, command parser, rate-limited chat sender + invariant, persisted auth (wave 1)

**Wave 2** *(blocked on 02-01)*

- [x] 02-03-PLAN.md — Winner funnel (pipeline/round.ts + single-funnel allowlist) and console Start Round control (wave 2)

**Wave 3** *(blocked on 02-02 + 02-03)*

- [x] 02-04-PLAN.md — Live chat slice: EventSub listener, intake limits (closes T-01-11), COMP-03 feedback, narration, OAuth routes (wave 3)

**Wave 4** *(blocked on 02-04)*

- [x] 02-05-PLAN.md — Public OBS overlay: separate read-only surface, live tally + countdown, DOM-safety scan (wave 4)

**Wave 5** *(blocked on 02-05)*

- [x] 02-06-PLAN.md — Full-loop + recovery e2e, operator docs, live OAuth/chat smoke checkpoint (wave 5)

**UI hint**: yes

### Phase 3: Sandboxed Build Engine & Live Show

**Goal**: The winning suggestion gets researched, planned, and built by the agent pipeline inside an isolated sandbox — and viewers watch the whole process live
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: BUILD-01, BUILD-02, BUILD-03, BUILD-04, COMP-02, SAND-01, SAND-02, SAND-03, SAND-04, PRES-02, PRES-03, PRES-04
**Success Criteria** (what must be TRUE):

  1. A queued task drives the full pipeline — Sonnet agents research, Fable plans and builds — with the plan re-screened by a second compliance pass before any code is written, and mid-build model refusals surfaced as first-class narrated events
  2. The build executes entirely inside the sandbox (WSL2 or Docker): the agent cannot read/write host files outside its workspace, cannot control host applications, and has zero access to secrets or personal data
  3. Chat-derived text reaches agents only as data — an injection-style suggestion cannot alter agent behavior
  4. The overlay shows the suggestion queue, current build status, and pipeline stage (researching → planning → building) in real time, and viewers watch the app under construction via a browser view of the sandboxed dev server
  5. A build failure is narrated in chat/overlay with retry/skip options (never silent dead air), and the streamer veto cleanly aborts an in-flight agent session

**Plans**: 9 plans

Plans:
**Wave 0** *(mandatory human go/no-go — gates the whole phase)*

- [ ] 03-01-PLAN.md — WSL2 sandbox install + isolation/veto/billing/latency human validation (SAND-01, SAND-02) (wave 0)

**Wave 1** *(blocked on Wave 0 GO verdict)*

- [ ] 03-02-PLAN.md — Contracts, SDK install, PipelineStage vocabulary + progress-events translation, audit records, failing e2e (BUILD-02) (wave 1)

**Wave 2** *(blocked on 03-02)*

- [ ] 03-03-PLAN.md — Prompt-injection boundary: zero-interpolation delimited prompts + adversarial-fixture suite (SAND-04) (wave 2)
- [ ] 03-04-PLAN.md — COMP-02 second pass: direct classify() re-screen of the build plan (COMP-02) (wave 2)
- [ ] 03-05-PLAN.md — Sandbox adapter (env allowlist) + secrets-isolation invariant + wsl --terminate veto teardown (SAND-03, BUILD-04) (wave 2)
- [ ] 03-07-PLAN.md — Overlay build panel: queue + build status + pipeline stepper (PRES-02, PRES-04) (wave 2)
- [ ] 03-08-PLAN.md — App-under-construction preview surface: iframe to sandboxed dev server, auto-refresh (PRES-03) (wave 2)

**Wave 3** *(blocked on 03-02..03-05 + 03-07 + 03-08)*

- [ ] 03-06-PLAN.md — Build-session orchestrator: research→plan→comp02→sandboxed build→done, main.ts composition, happy-path e2e (BUILD-01) (wave 3)

**Wave 4** *(blocked on 03-06)*

- [ ] 03-09-PLAN.md — Graceful failure: narrated retry/skip, first-class refusals, console controls, full failure/veto e2e (BUILD-03) (wave 4)

**UI hint**: yes

Research flag: RESOLVED by the Phase 3 sandbox spike (03-RESEARCH.md) — WSL2 (dedicated distro, automount off, dedicated unprivileged user, NAT networking, spawnClaudeCodeProcess) with a mandatory Wave 0 human go/no-go before any orchestrator code is trusted.

### Phase 4: Paid Influence & Chaos Mode

**Goal**: Money buys guaranteed, time-boxed control — never a compliance exemption — and chaos mode adds random-pick variance as a strictly separate mechanic
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: PAID-01, PAID-02, PAID-03, PAID-04, CHAOS-01, CHAOS-02
**Success Criteria** (what must be TRUE):

  1. A donation via the external platform (not Bits) grants the donor a free-reign window with duration proportional to amount, subject to caps and cooldowns
  2. A channel points redemption grants a smaller-scale direct-influence window via native EventSub redemptions
  3. Every instruction issued during any paid window passes the identical compliance gate and remains streamer-vetoable; windows are time-boxed, revocable, and logged with the amount-to-duration mapping
  4. Streamer can toggle chaos mode, and the system randomly picks the next task from the already-filtered pool instead of running a vote
  5. Paid control (guaranteed) and chaos mode (random) share no code path that attaches chance to payment — verified in the architecture, not just convention

**Plans**: 8 plans

Plans:
**Wave 1** *(foundation/seam — disjoint files)*

- [ ] 04-01-PLAN.md — Shared contracts + events + control_windows ledger schema + audit records (wave 1)
- [ ] 04-02-PLAN.md — Ingestion seams: StreamElements donation source + EventSub redemption source + channel:read:redemptions scope (wave 1)

**Wave 2** *(blocked on 04-01)*

- [ ] 04-03-PLAN.md — ControlWindow FSM: linear+capped duration, cooldown, one-at-a-time, absolute-timestamp crash-safe restore, halt-aware, injected funnel (wave 2)
- [ ] 04-04-PLAN.md — Overlay: free-reign banner + FREE REIGN/CHAOS pills + provenance chip (coarse public projection) (wave 2)
- [ ] 04-05-PLAN.md — Console: window panel + Revoke + chaos toggle + donations/missing-scope pills + audit filters (wave 2)

**Wave 3** *(blocked on 04-03)*

- [ ] 04-06-PLAN.md — Chaos selector + single-funnel re-entry (paid-window.ts + chaos.ts) + paid↔chaos separation invariant + single-funnel allowlist (wave 3)

**Wave 4** *(blocked on 04-02..04-06)*

- [ ] 04-07-PLAN.md — Composition: main.ts wiring + window/chaos chat narration + paid-window & chaos end-to-end tests (wave 4)

**Wave 5** *(blocked on 04-07 — batched live human gates)*

- [ ] 04-08-PLAN.md — Live gate: StreamElements account/JWT + broadcaster re-auth + real tip/redemption smoke test + AUP re-read (wave 5)

Research flag: RESOLVED by the Phase 4 research pass (04-RESEARCH.md) — StreamElements LOCKED (D-01), Bits rejected with verbatim AUP citation, chargeback out of scope for MVP, channel:read:redemptions scope correction folded into 04-02. Live-platform binding is the deferred human gate (04-08).

### Phase 5: Build History & Stream Night Dry Run

**Goal**: The format is provably ready for the first real stream night — full loop rehearsed end-to-end on a test channel with zero compliance incidents
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: HIST-01
**Success Criteria** (what must be TRUE):

  1. Winning suggestions and their build results persist to a browsable changelog page across stream nights
  2. A full dry run on a low-stakes test channel exercises every mode end-to-end: suggest → filter → vote → build → live preview, plus a real small donation triggering a free-reign window and a chaos-mode round
  3. The kill switch is exercised against a genuinely in-progress build during the dry run and halts it cleanly
  4. The audit log from the dry run confirms zero unfiltered inputs reached an agent and every rejection produced chat feedback

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Compliance Gate & Kill Switch | 5/5 | Complete   | 2026-07-09 |
| 2. Chat Vote Loop | 6/6 | Complete   | 2026-07-10 |
| 3. Sandboxed Build Engine & Live Show | 8/9 | Code complete (review/verify/secure green); Wave 0 WSL2 go/no-go pending | - |
| 4. Paid Influence & Chaos Mode | 0/8 | Planned | - |
| 5. Build History & Stream Night Dry Run | 0/TBD | Not started | - |

## Coverage

31/31 v1 requirements mapped. No orphans, no duplicates.

| Category | Requirements | Phase |
|----------|--------------|-------|
| Compliance Gate | COMP-01, COMP-04, COMP-05 | 1 |
| Compliance Gate | COMP-03 | 2 |
| Compliance Gate | COMP-02 | 3 |
| Chat Control Loop | CHAT-01..05 | 2 |
| Platform Integration | INFRA-01, INFRA-02 | 2 |
| Stream Presentation | PRES-01 | 2 |
| Stream Presentation | PRES-02, PRES-03, PRES-04 | 3 |
| Sandbox & Privacy | SAND-01..04 | 3 |
| Build Engine | BUILD-01..04 | 3 |
| Paid Influence | PAID-01..04 | 4 |
| Chaos Mode | CHAOS-01, CHAOS-02 | 4 |
| Build History | HIST-01 | 5 |
