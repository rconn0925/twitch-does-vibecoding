# Requirements — Twitch Does Vibecoding

## v1 Requirements

### Chat Control Loop

- [ ] **CHAT-01**: Viewer can submit a project/feature idea via `!suggest <idea>` in Twitch chat
- [ ] **CHAT-02**: Chat can vote in timed rounds with numbered options (`!vote 1/2/3`), with round duration visible on the overlay
- [ ] **CHAT-03**: Each viewer gets one vote per round; a revote overrides their earlier vote
- [ ] **CHAT-04**: The winning suggestion is announced in chat and becomes the next build task
- [ ] **CHAT-05**: The bot narrates state transitions in chat (round open/close, winner, build progress, build failures)

### Compliance Gate (hard requirement)

- [ ] **COMP-01**: Every candidate instruction — from suggestions, votes, channel points, donation windows, or chaos mode — passes through a single AI compliance filter screening against Twitch ToS/Community Guidelines categories (hateful conduct, harassment, sexual content, violence/threats, self-harm, illegal activity, gambling, privacy/doxxing, impersonation, malware/scraping, IP infringement) before it can enter the build queue; no code path can enqueue a task any other way
- [ ] **COMP-02**: The build plan/output is re-screened in a second compliance pass before and during execution (an approved-but-vague suggestion must not produce non-compliant output)
- [ ] **COMP-03**: A rejected suggestion gets category-level feedback in chat (viewer knows why, without a lecture)
- [x] **COMP-04**: Streamer has an always-reachable veto/kill switch (operator console and/or hotkey) that halts or discards any queued or in-progress task, identically across all control modes
- [x] **COMP-05**: All filter decisions and vetoes are logged with the triggering input (audit trail)

### Sandbox & Privacy (hard requirement)

- [ ] **SAND-01**: All chat-driven builds execute inside an isolated sandbox (WSL2 or Docker); the build agent cannot read or write host files outside its dedicated project workspace
- [ ] **SAND-02**: The system cannot open or control applications on the host machine; the only host-visible surface of a build is a browser/OBS browser source pointed at the sandboxed dev server
- [ ] **SAND-03**: The build sandbox has no access to personal files, personal info, or credentials; Twitch/API tokens and secrets live outside the sandbox and are never exposed to build agents or chat-derived code
- [ ] **SAND-04**: Chat-derived text is treated as data, never as agent instructions (prompt-injection defense at the orchestrator boundary)

### Paid Influence

- [ ] **PAID-01**: A donation (via an external platform — not Twitch Bits, per Bits AUP) grants the donor a "free reign" control window with duration proportional to the amount, with caps and cooldowns
- [ ] **PAID-02**: A channel points redemption grants a smaller-scale direct-influence window via native Twitch EventSub redemptions
- [ ] **PAID-03**: Every instruction issued during a paid window passes the same compliance filter and remains vetoable — paid control never bypasses COMP-01..04
- [ ] **PAID-04**: Free-reign windows are time-boxed, revocable by the streamer, and logged (donation amount → duration mapping recorded)

### Chaos Mode

- [ ] **CHAOS-01**: Streamer can toggle chaos mode, where the system randomly picks the next task from the already-filtered suggestion pool instead of running a vote
- [ ] **CHAOS-02**: Chaos mode (random) and paid control (guaranteed) are strictly separate mechanics — no chance element is ever attached to payment (sweepstakes-law separation)

### Build Engine

- [ ] **BUILD-01**: An orchestrator drives the agent pipeline for each task: Sonnet agents research the idea, the session default model (Fable) plans and builds
- [ ] **BUILD-02**: The orchestrator emits status events (queued, researching, planning, building, done, failed) consumable by overlay and chat narration
- [ ] **BUILD-03**: Build failures degrade gracefully — narrated on stream and in chat with retry/skip, never silent dead air
- [ ] **BUILD-04**: The streamer veto (COMP-04) can abort an in-flight agent session cleanly

### Stream Presentation

- [ ] **PRES-01**: OBS browser-source overlay shows the live vote tally during rounds
- [ ] **PRES-02**: Overlay shows the suggestion queue and current build status
- [ ] **PRES-03**: Viewers can watch the app under construction live via an auto-refreshing browser view of the sandboxed dev server
- [ ] **PRES-04**: Overlay shows the agent pipeline stage (researching → planning → building) — the AI process is part of the show

### Build History

- [ ] **HIST-01**: Winning suggestions and their build results persist to a browsable changelog page ("the audience built this together" across stream nights)

### Platform Integration

- [ ] **INFRA-01**: Twitch integration uses EventSub over WebSocket (chat read/write, channel points) with persisted auto-refreshing tokens
- [ ] **INFRA-02**: EventSub disconnects are detected and reconciled (resubscribe + state recheck), and outbound chat messages respect rate-limit budgeting

## v2 Requirements

- [ ] **CHAT-06**: LLM-based suggestion clustering merges near-duplicate suggestions into single ballot options (deferred until real suggestion volume justifies it)
- [ ] Sub/loyalty-weighted voting — only if the community asks; fairness-perception risk
- [ ] Native Twitch Polls API as an alternative voting substrate

## Out of Scope

- **Compliance bypass at any paid tier** — money buys priority and time, never a filter/veto exemption; channel safety is non-negotiable
- **Bits-funded free reign** — likely violates the Bits Acceptable Use Policy (exchanging Bits for non-native services); external donation platforms only
- **Unfiltered "anarchy" mode** (raw chat → agent execution) — the Claude Crowd precedent (full root access, no moderation) is the negative case study, not a pattern to copy
- **Raw shell/system access from chat** — suggestions are natural-language feature descriptions; only the sandboxed build agent writes code
- **Real-time collaborative code editor for viewers** — unreviewable concurrent edits; the agent pipeline is the sole code-writer
- **TPP-style supermajority mode-switch voting** — mode selection is a streamer toggle, not a chat meta-vote
- **Multi-streamer/SaaS platform** — one channel until the format is proven
- **Fully unattended operation** — a human-reachable kill switch is table stakes in every serious precedent

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CHAT-01 | Phase 2 | Pending |
| CHAT-02 | Phase 2 | Pending |
| CHAT-03 | Phase 2 | Pending |
| CHAT-04 | Phase 2 | Pending |
| CHAT-05 | Phase 2 | Pending |
| COMP-01 | Phase 1 | Pending |
| COMP-02 | Phase 3 | Pending |
| COMP-03 | Phase 2 | Pending |
| COMP-04 | Phase 1 | Complete |
| COMP-05 | Phase 1 | Complete |
| SAND-01 | Phase 3 | Pending |
| SAND-02 | Phase 3 | Pending |
| SAND-03 | Phase 3 | Pending |
| SAND-04 | Phase 3 | Pending |
| PAID-01 | Phase 4 | Pending |
| PAID-02 | Phase 4 | Pending |
| PAID-03 | Phase 4 | Pending |
| PAID-04 | Phase 4 | Pending |
| CHAOS-01 | Phase 4 | Pending |
| CHAOS-02 | Phase 4 | Pending |
| BUILD-01 | Phase 3 | Pending |
| BUILD-02 | Phase 3 | Pending |
| BUILD-03 | Phase 3 | Pending |
| BUILD-04 | Phase 3 | Pending |
| PRES-01 | Phase 2 | Pending |
| PRES-02 | Phase 3 | Pending |
| PRES-03 | Phase 3 | Pending |
| PRES-04 | Phase 3 | Pending |
| HIST-01 | Phase 5 | Pending |
| INFRA-01 | Phase 2 | Pending |
| INFRA-02 | Phase 2 | Pending |

**Coverage:** 31/31 v1 requirements mapped to phases. No orphans.
