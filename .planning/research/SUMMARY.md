# Project Research Summary

**Project:** Twitch Does Vibecoding
**Domain:** Twitch chat-controlled live AI coding stream system (chat bot + agent orchestrator + OBS overlay + live app preview, with a hard Twitch ToS/Community Guidelines compliance requirement)
**Researched:** 2026-07-08
**Confidence:** MEDIUM-HIGH

## Executive Summary

This is a single-channel, single-operator live broadcast system, not a general SaaS product — and the research across all five dimensions (stack, features, architecture, pitfalls, compliance) converges on the same shape: a single Node/TypeScript process owns Twitch I/O, an explicit stream-mode state machine, and one mandatory compliance chokepoint that every possible path to "build something" — free suggestion, timed vote, channel points redemption, or paid donation window — must pass through with zero exceptions. The genre ("chat plays X") has real precedent (Twitch Plays Pokémon, Crowd Control, Neuro-sama) and one directly relevant but cautionary precedent in this exact niche (Claude Crowd, which grants chat-voted commands full root access with no moderation layer at all — the explicit negative case study to avoid). The recommended stack (Node 24 LTS, TypeScript 6, `@anthropic-ai/claude-agent-sdk`, twurple, Express + `ws`, `better-sqlite3`) is chosen specifically because it lets one process hold Twitch EventSub, the overlay WebSocket, and Claude Agent SDK sessions as a single source of truth, with the SDK's in-process hooks/`AbortController` giving the per-tool-call gating that a subprocess-wrapped CLI cannot.

The recommended approach is: build the compliance gate and the operator veto/kill-switch before any live chat input reaches an agent, because both research and compliance findings agree these are the actual safety backstops, not the AI filter alone (LLM classifiers have real false-negative rates against paraphrasing/obfuscation, so a second pass on the *build output*, not just the *suggestion text*, is required — this is the two-pass filter design flagged independently by both PITFALLS.md and COMPLIANCE.md). Compliance research adds constraints the other four files don't fully capture on their own: the donation-funded "free reign" mechanic should be funded through an external donation platform (StreamElements/Streamlabs/Ko-fi), not Twitch Bits, because Bits' Acceptable Use Policy explicitly bars exchanging Bits for services "not native to Twitch" (control-time is structurally similar to the policy's own prohibited examples like "graphic design services"); and the mechanic must keep "paid, guaranteed control" and "chaos mode, random pick" strictly separate, because blending them (e.g., "donate for a chance at control") would reintroduce the "chance" element and trip US sweepstakes law (prize + chance + consideration). As designed — guaranteed, proportional control time, no chance element — the mechanic is not a regulated sweepstakes, which is a materially favorable finding but only holds if that separation is enforced in the architecture, not just the marketing copy.

Key risks, in order of severity: (1) a compliance filter that only screens the suggestion text and never re-checks what the agent actually built — a "benign suggestion, non-compliant output" gap that goes live publicly and can't be undone; (2) prompt injection through the suggestion/vote pipeline, since every chat message is untrusted, adversarial-by-design input reaching an agent with tool-use authority; (3) running the build agent unsandboxed on the streaming machine itself, where a single `rm -rf`-class mistake or an adversarially-steered agent action damages the host that's also running OBS, Twitch credentials, and personal files (Windows has no native Claude Code sandbox — WSL2 or Docker is required and is flagged as needing a dedicated spike); and (4) Twitch's own platform mechanics (chat rate limits, EventSub disconnects with no event replay) silently breaking paid-control triggers or locking the bot out mid-stream if not budgeted for explicitly. All four are addressed by the architecture's single-funnel compliance gate, explicit state machine, and always-available operator veto — the roadmap should sequence these safety-critical components before the first phase that lets real chat input reach an agent.

## Key Findings

### Recommended Stack

Node.js 24 (Active LTS) and TypeScript 6.0.x form the runtime, chosen because this is an I/O-bound, WebSocket-heavy system (EventSub, overlay push, chat, streaming agent output) that fits a single event-loop process far better than a compute-bound or multi-language split would. twurple is the only actively-maintained, TypeScript-first library covering Twitch auth token refresh, Helix API, and EventSub in one coherent suite — read via EventSub WebSocket (`channel.chat.message`), write via the Helix Send Chat Message API, never IRC (Twitch is actively deprecating IRC in favor of EventSub, and PubSub was fully retired in April 2025). The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), embedded directly in the orchestrator process rather than shelled out to via CLI subprocess, is what makes the per-tool-call gating and instant kill-switch (via `AbortController`/hooks) possible — a hard requirement given the streamer-veto constraint.

**Core technologies:**
- Node.js 24.x + TypeScript 6.0.x — single-process runtime for concurrent Twitch/overlay/agent I/O
- `@anthropic-ai/claude-agent-sdk` (^0.3.x, pin exact — pre-1.0) — in-process agent orchestration with per-tool-call gating and streaming progress, mapped to the project's Sonnet-research/Fable-build model policy
- `@twurple/auth`, `@twurple/api`, `@twurple/eventsub-ws` (^8.1.x, lockstep versions) — Twitch auth, Helix API, EventSub WebSocket
- Express 5.2.x + `ws` ^8.21.x — local overlay HTTP/WebSocket server, deliberately not Socket.IO (same-origin localhost-only, no cross-domain fallback needed)
- `better-sqlite3` ^12.x + `zod` ^4.x — durable queue/vote/token state and runtime validation at every untrusted-input boundary (chat, donations, EventSub payloads)
- Donations: StreamElements (cloud-only realtime websocket API) recommended over Streamlabs (requires a desktop client) — but see compliance note below on why donations should route around Twitch Bits entirely for the "free reign" mechanic

Full detail: `.planning/research/STACK.md`

### Expected Features

The genre ("chat plays X" applied to live AI coding) has clear table stakes derived from Twitch Plays Pokémon, Crowd Control, and vote-bot precedent, plus one directly relevant cautionary precedent (Claude Crowd — full root access, no moderation, explicitly the negative case study). The single most important table-stakes item is also the highest-complexity one: a content/intent filter in front of every suggestion, because Twitch's own AutoMod only catches surface toxicity, not instruction/intent safety ("add a keylogger" isn't a slur).

**Must have (table stakes) — v1 launch:**
- `!suggest` submission and timed `!vote 1/2/3` rounds with one-vote-per-viewer/revote-overrides-previous
- AI ToS/Community Guidelines filter on every suggestion, with in-chat rejection feedback (non-negotiable compliance gate)
- Overlay with live vote tally, suggestion queue, and build status — the "screen" the format is watched through
- Winning suggestion → orchestrator (Sonnet research, Fable build) → build task, narrated in chat
- Streamer veto/kill switch reachable at all times
- Live view of the app under construction, and graceful (narrated, not silent) failure handling

**Should have (differentiators) — add after v1 validates on a real stream night:**
- Chaos mode (AI random-picks from the *already-filtered* pool — chaos of outcome, never chaos of unfiltered input, unlike TPP's Anarchy mode)
- Channel points micro-version of free reign (native Twitch currency, no third-party platform needed, low compliance risk)
- Donation-proportional "free reign" control window — highest complexity and highest compliance risk of any feature; per COMPLIANCE.md, fund this via an external donation platform, not Twitch Bits, and only ship once the filter/veto path is battle-tested on the simpler vote/chaos paths
- Suggestion clustering/dedup to reduce ballot noise

**Defer (v2+):**
- Multi-stage build-pipeline transparency, persistent build history/changelog UI, sub-weighted voting, multi-streamer/SaaS generalization (explicitly out of scope for v1 per PROJECT.md)

**Anti-features to actively avoid:** TPP-style unfiltered "Anarchy" execution; any tier (donor/sub) that skips the ToS filter; fully unattended operation with no human in the loop; open-ended natural-language commands mapped to raw shell/system access; a real-time collaborative code editor where viewers type directly into the codebase.

Full detail: `.planning/research/FEATURES.md`

### Architecture Approach

The system is an event-driven pipeline with a single funnel point, not a microservice mesh: every external input (chat, channel points, donation) is normalized into one `SuggestionCandidate` shape and passed through exactly one compliance gate function before it can become a `QueuedTask` — no component, including paid/admin paths, is allowed to enqueue a build task directly. An explicit stream-mode state machine (`IDLE → VOTING_ROUND → BUILD_IN_PROGRESS`, `FREE_REIGN_WINDOW`, `CHAOS_MODE`, `HALTED`) is the single source of truth for "what can chat currently do," with operator veto available as a highest-priority transition from any state. Recommended process model for the Windows 11 streaming PC: one main Node process for ingestion/normalization/compliance/state-machine/overlay/operator-console/chat-bot, with agent build sessions as separately-supervised child processes (so a hung/crashed agent can't take down the main process or block chat/veto handling), the built app's dev server as its own process, and — critically — a WSL2 or Docker boundary for the agent's actual code execution, since Claude Code's native sandbox isn't supported on Windows.

**Major components:**
1. Twitch/Donation Ingestion Adapters + Normalization — source-per-file, shape-agnostic downstream; this is what makes "every path gates through compliance" enforceable in code
2. Compliance Gate — isolated, independently testable chokepoint; cheap regex/keyword pre-filter followed by an LLM categorical classifier; COMPLIANCE.md's taxonomy (13 categories: hateful conduct, harassment, sexual content, violence, self-harm, illegal activity, gambling, privacy/doxxing, impersonation/deepfakes, spam/malware, IP infringement, misinformation, unsafe build targets) should drive this component's rules, with a two-pass design (suggestion text pre-vote, build plan/output pre-ship)
3. Stream Mode State Machine — owns mode/timers/candidate pool/vote tallies/active donor; the brain, never talks to Claude directly
4. Agent Orchestrator — spawns Claude Agent SDK research (Sonnet) and build (Fable) sessions as managed child processes, translates raw agent events into a small stable progress-event vocabulary for the overlay
5. Overlay Broadcast Server + Operator Console — separate localhost servers for different audiences (public overlay vs. streamer-only control surface); operator console is the always-available veto/kill-switch/force-transition authority
6. Live App Preview — the built app's dev server, sandboxed and secret-isolated separately from the orchestrator process that holds real Twitch/donation credentials

Full detail: `.planning/research/ARCHITECTURE.md`

### Critical Pitfalls

1. **ToS filter treated as a single point of trust** — a single LLM pass on the raw suggestion text misses paraphrasing, encoding tricks, and requests that are individually benign but combine into a violation once actually built. Avoid by running a second compliance pass on the build plan/output before it ships, keeping the streamer veto as the true final authority (not the filter), and adversarially testing the filter against jailbreak/obfuscation patterns before the first live stream.
2. **Prompt injection through the suggestion/vote pipeline** — every chat message is untrusted, adversarial-by-design input reaching an agent with tool-use authority; published research shows 41-84% attack success rates against agentic coding tools with no trust boundary. Avoid by treating all chat-derived text as data (never concatenated into a system prompt or given tool-use authority) and running a separate injection-pattern detector distinct from the content-policy filter.
3. **Unsandboxed agent puts the host machine at risk** — the build agent runs with real filesystem/process access on the same Windows machine as OBS, Twitch credentials, and personal files, and the adversarial-input risk is structural here (not hypothetical), since crowd-sourced suggestions are the design, not an edge case. Avoid by isolating agent execution (WSL2/Docker), capping resources/turns/timeouts per session, and never letting the agent's workspace contain real secrets.
4. **No fast, always-available kill switch** — veto UX built last, as an afterthought (CLI command, second monitor), defeats the entire point during a live incident. Avoid by building and load-testing the kill switch early (single hotkey, works even if the agent is hung, resolves in a few seconds) — before, not after, the compliance/build pipeline goes live.
5. **Twitch platform mechanics silently break paid-control features** — chat rate-limit lockout (20 msgs/30s per bot account, 30-minute lockout on violation) and EventSub disconnects with no event replay can silently drop a donor's paid "free reign" trigger, on stream, in front of the donor. Avoid by routing high-frequency state to the overlay (not chat text), budgeting message sends with margin, and adding a reconciliation poll as a safety net for paid-control events specifically.

Full detail: `.planning/research/PITFALLS.md` (8 critical pitfalls total, plus technical-debt patterns, integration gotchas, and a "looks done but isn't" checklist)

### Compliance Requirements (Twitch ToS / Community Guidelines)

This project has a hard, non-negotiable compliance constraint (PROJECT.md), and COMPLIANCE.md provides the concrete rule set the architecture's compliance gate must implement — this is not generic content moderation but a two-layer problem: screening what chat *says* (the suggestion text) and what the agent's build actually *does* (functional behavior a "harmless-sounding" suggestion can decompose into, e.g., "build a leaderboard" vs. "build a leaderboard that scrapes usernames and emails"). Because intent can hide in implementation, COMPLIANCE.md independently arrives at the same **two-pass filter design** flagged in PITFALLS.md: pass 1 screens the raw suggestion before voting, pass 2 screens the research/plan output before the build agent starts writing code — same reject → chat feedback → log flow both times.

Two findings materially shape the paid-influence architecture. First, the **Bits Acceptable Use Policy risk**: Twitch's Bits AUP explicitly prohibits exchanging Bits for "items or services not natively available on Twitch," with examples (graphic design services, cooking lessons) structurally identical to "buy control time over what gets built" — so the "donation buys free reign" mechanic should be funded through an external donation platform (StreamElements/Streamlabs/Ko-fi/PayPal), never Bits/Cheer, sidestepping this restriction entirely. Second, the **sweepstakes-law separation**: US lottery law requires prize + chance + consideration; because paid "free reign" control time is guaranteed and proportional to the donation (no chance element), it reads as a paid commissioned service, not a regulated sweepstakes — but this favorable legal posture only holds if chaos mode (random pick) and paid control (guaranteed) stay strictly separate mechanics in the architecture. Blending them (e.g., "donate for a chance at control") would reintroduce chance and require an Alternate Method of Entry under most state laws. Both findings reinforce the architecture's existing single-funnel compliance-gate invariant: paid instructions get priority and duration, never a compliance exemption, and the gate that enforces this must be architecturally incapable of a donor-path shortcut, not just conventionally disciplined about it.

Additional constraints: Anthropic's Usage Policy is an independent third backstop beyond both Twitch layers (malware/exploits, weapons content, fraud/deception tooling, guardrail circumvention — expect Claude's own refusals to catch some suggestions even if the Twitch-specific filter has a gap, but design the system to treat a mid-build refusal as a first-class logged event, not a silent failure); bot-account rate limits are comfortably covered by modding the bot in-channel (100 msgs/30s tier, no need to pursue rarely-granted Verified Bot status); and channel points redemptions are low-risk as designed (no prohibited category, no monetary value).

Full detail: `.planning/research/COMPLIANCE.md`

## Implications for Roadmap

Based on combined research, suggested phase structure:

### Phase 1: Foundation — Shared Types, Event Bus, Compliance Gate
**Rationale:** Nothing else compiles without shared types (`SuggestionCandidate`, `QueuedTask`, `StreamMode`), and the compliance gate is the hard-requirement component that must be built and validated in isolation, against a fixture set of known-good/known-bad/adversarial inputs, before any real chat input exists to test against. ARCHITECTURE.md's suggested build order and PITFALLS.md's pitfall-to-phase mapping both independently place this first.
**Delivers:** `shared/types.ts`, `shared/events.ts`, and a standalone, unit-testable `compliance/gate.ts` implementing the two-pass design (suggestion-text pre-filter + regex/keyword pre-pass) with COMPLIANCE.md's 13-category taxonomy encoded as classifier rules.
**Addresses:** "AI ToS/Community Guidelines filter on every suggestion" (FEATURES.md P1 table stakes)
**Avoids:** Pitfall 4 (filter treated as single point of trust) and Pitfall 3 (prompt injection) — build the injection-pattern detector as a distinct check from the content-policy filter here, not later.

### Phase 2: Safety Backstop — Stream Mode State Machine + Operator Console
**Rationale:** PITFALLS.md explicitly flags the kill switch as something that "should ship no later than the first phase that allows chat-driven builds to run unattended," and ARCHITECTURE.md sequences the operator console before agent orchestration for the same reason — you don't want to be building your safety net at the same time as the thing it needs to catch.
**Delivers:** The explicit `IDLE/VOTING_ROUND/FREE_REIGN_WINDOW/CHAOS_MODE/BUILD_IN_PROGRESS/HALTED` state machine tested against synthetic events (including veto-from-any-state), plus a localhost-only operator console exposing veto/kill/force-transition.
**Implements:** ARCHITECTURE.md Pattern 2 (Explicit Stream Mode State Machine)
**Avoids:** Pitfall 6 (no fast, always-available kill switch) — test veto latency here, under synthetic load, before real Twitch input exists.

### Phase 3: Twitch Ingestion — Chat, EventSub, Channel Points
**Rationale:** Now that the gate and state machine are solid, wire real Twitch connections into them — this is where live-API quirks (rate limits, reconnect/resubscribe, welcome-message handshake) get discovered against an already-tested pipeline rather than compounding with untested downstream logic.
**Delivers:** `!suggest`/`!vote` command ingestion via EventSub WebSocket (`channel.chat.message`), channel points redemption handling (`channel.channel_points_custom_reward_redemption.add`), Helix chat-send for status/rejection feedback, full EventSub reconnect + reconciliation-poll logic.
**Uses:** twurple (`@twurple/auth`, `@twurple/api`, `@twurple/eventsub-ws`) from STACK.md
**Avoids:** Pitfall 1 (rate-limit lockout — mod the bot in-channel per COMPLIANCE.md section 2, route high-frequency state to overlay not chat) and Pitfall 2 (EventSub disconnects silently dropping paid-control events — add the reconciliation poll now, before any paid feature depends on EventSub reliability).

### Phase 4: Stream Presentation — Overlay Broadcast Server
**Rationale:** High value early because it makes every subsequent step (voting, build progress, mode changes) visually debuggable during development, and it's a well-established pattern (state-snapshot-on-connect, then deltas) with no genre-specific unknowns.
**Delivers:** WS server + OBS browser-source page rendering live vote tally, suggestion queue, build status, current mode.
**Addresses:** "Overlay: live vote tally, current suggestion queue, build status" (FEATURES.md P1 table stakes)
**Implements:** ARCHITECTURE.md's overlay component and Anti-Pattern 3 guard (single state machine as sole authority on mode, overlay never re-derives it)

### Phase 5: Build Engine — Agent Orchestrator + Sandboxing
**Rationale:** The most complex, most novel component — deliberately sequenced after the safety-critical and visualization pieces are solid, per ARCHITECTURE.md's suggested build order, since this is also where the Windows sandboxing spike (WSL2/Docker) needs to happen and is likely to surface unknowns.
**Delivers:** Claude Agent SDK integration (Sonnet research sub-agent, Fable build agent) as supervised child processes with progress-event translation to the state machine/overlay; hard per-session turn/token/wall-clock limits; sandboxed execution boundary (WSL2 or Docker) with no secrets in the agent's workspace.
**Addresses:** "Agent orchestrator drives Claude Code sessions" (PROJECT.md/FEATURES.md P1)
**Avoids:** Pitfall 3 (prompt injection reaching an agent with tool-use authority), Pitfall 5 (unsandboxed agent = host machine at risk), and Anti-Pattern 2 from ARCHITECTURE.md (agent orchestrator blocking the event loop — sessions must run as independently-progressing child processes, never a synchronously-awaited call inside the chat-event handler).

### Phase 6: Live App Preview + Secrets Isolation
**Rationale:** Depends on knowing what kind of dev server the build agent typically produces, so it's sequenced after the orchestrator is real, per ARCHITECTURE.md.
**Delivers:** Preview manager that starts/stops/restarts the built app's dev server on a fixed local port, captured by OBS, with output redaction and zero shared credentials with the orchestrator process.
**Addresses:** "Live view of the app under construction" (FEATURES.md P1 table stakes)
**Avoids:** Pitfall 8 (secrets/live-app exposure on the overlay or preview) — the preview surface must never be able to read Twitch/donation API tokens even if compromised.

### Phase 7: Paid Influence — Donations + Channel Points
**Rationale:** FEATURES.md explicitly sequences this as "add once the filter/veto path is battle-tested on the simpler vote/chaos paths" — it's the highest-complexity, highest-compliance-risk feature, and both COMPLIANCE.md and PITFALLS.md treat it as needing the most scrutiny of any single feature.
**Delivers:** Channel points micro-control (native, low-risk, ship first within this phase) and donation-proportional "free reign" window funded via an external platform (StreamElements recommended) — explicitly NOT Twitch Bits, per COMPLIANCE.md's Bits AUP finding — with amount-to-duration mapping, chargeback/refund handling (time-boxed, logged, revocable grant), and every donor instruction routed through the identical compliance gate as free suggestions (no elevated trust).
**Addresses:** "Donation free reign" + "Channel points redemption" (FEATURES.md P2 differentiators)
**Avoids:** Pitfall 7 (vote/suggestion brigading — leverage the paid tier's inherent cost-based rate limiting) and the sweepstakes-law trap (COMPLIANCE.md Finding A) — keep this mechanic architecturally separate from chaos mode's random selection.

### Phase 8: Chaos Mode + Suggestion Quality Polish
**Rationale:** FEATURES.md flags chaos mode as low cost/low risk, added once voting-round pacing is proven — it's a scheduling/selection variant on infrastructure that already exists by this point, not new pipeline plumbing.
**Delivers:** Chaos mode toggle (random pick from the already-filtered candidate pool, streamer/schedule-controlled, never chat-voted per the anti-feature warning against TPP's supermajority mode-switch complexity), optional suggestion clustering/dedup.
**Addresses:** "Chaos mode" (FEATURES.md P2 differentiator)

### Phase 9: End-to-End Dry Run + First Live Stream Night
**Rationale:** ARCHITECTURE.md's suggested build order ends here explicitly: a full loop rehearsal against a real (low-stakes) Twitch test channel, exercising every mode (voting, free-reign via a real small donation, chaos) and confirming the veto/kill switch works against an in-progress build, before the actual first stream.
**Delivers:** Validated end-to-end suggest → filter → vote → build → preview loop; "v1 done" per PROJECT.md's own definition (first real stream night, zero ToS incidents).

### Phase Ordering Rationale

- **Safety-before-features, consistently:** compliance gate (Phase 1) and kill switch (Phase 2) both come before any real chat input reaches the system (Phase 3+), matching the explicit PROJECT.md priority ("streamer override matters more than feature count") and both PITFALLS.md and COMPLIANCE.md's independent convergence on the two-pass filter and always-available veto as the actual backstops.
- **Infrastructure-before-complexity:** overlay (Phase 4, well-understood pattern, high debugging value) comes before the agent orchestrator (Phase 5, the most novel/risky component with an unresolved Windows-sandboxing question), so later phases are visually debuggable from the start.
- **Simple-monetization-before-complex-monetization:** channel points (native, low-risk) is grouped with donations (third-party, higher-risk) in one phase but should be built first within it; both are deferred past the entire core loop (Phases 1-6) per FEATURES.md's explicit "add after validation" guidance.
- **Chaos mode last among features:** it's cheap to add once voting infrastructure exists, and TPP precedent shows chat-voted mode-switching (rather than streamer-controlled) adds unwarranted complexity — keep it simple and late.

### Research Flags

Phases likely needing deeper research during planning (`/gsd:plan-phase --research-phase <N>`):
- **Phase 5 (Build Engine / Agent Orchestrator):** Windows sandboxing for Claude Agent SDK sessions (WSL2 vs. Docker) is explicitly flagged as MEDIUM confidence pending a hands-on spike in ARCHITECTURE.md — native Windows has no supported Claude Code sandbox, and the constraint (must run alongside OBS on the same PC, must not add meaningful latency to a live build) hasn't been validated.
- **Phase 7 (Paid Influence):** the Bits-vs-external-donation-platform decision, chargeback/refund handling for revocable "free reign" grants, and StreamElements vs. Streamlabs integration specifics all carry MEDIUM confidence in source research (COMPLIANCE.md and STACK.md both recommend re-verifying exact Bits AUP wording and donation-platform API details before implementation).
- **Phase 1 (Compliance Gate):** while the taxonomy itself is well-sourced, the *adversarial testing methodology* (jailbreak/paraphrase/obfuscation test suite) and the exact two-pass prompt design need dedicated design work, not just implementation — treat as a research-adjacent phase even though it's sequenced first.

Phases with standard, well-documented patterns (skip research-phase):
- **Phase 3 (Twitch Ingestion):** twurple + EventSub is HIGH confidence, official-docs-verified, with mature community precedent (rate limits, reconnect flow all documented).
- **Phase 4 (Overlay Broadcast Server):** the state-snapshot-on-connect-then-deltas WebSocket pattern is HIGH confidence, established across multiple independent OBS overlay projects.
- **Phase 2 (State Machine + Operator Console):** conceptually simple (~6 states), well-precedented pattern; no genre-specific research needed beyond the design already captured in ARCHITECTURE.md.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH (Twitch integration, runtime) / MEDIUM (Agent SDK specifics, donation platform choice) | Twitch/Node/twurple guidance verified against official current docs. Agent SDK is pre-1.0 with a fast-moving interface — re-verify against the installed version before locking implementation details. No official Twitch-native donation API exists, so that choice is inherently third-party. |
| Features | MEDIUM-HIGH | Twitch platform mechanics (channel points, AutoMod, polls) are HIGH confidence via official docs. "Chat plays AI coding" is a nascent sub-genre with only one directly relevant precedent (Claude Crowd, LOW-MEDIUM confidence, self-described community project) — genre-specific conclusions (what differentiates this format) are MEDIUM. |
| Architecture | MEDIUM-HIGH | Individual component patterns (Twitch bots, moderation gates, agent orchestration, overlay servers) are mature and well-precedented; the specific composition of all four into one live system is novel, so the composition judgment is MEDIUM. |
| Pitfalls | MEDIUM-HIGH | Twitch platform rules and IRC/EventSub mechanics are HIGH confidence (official docs). AI agent safety and chat-governance lessons are MEDIUM (vendor writeups, incident reports, historical "Twitch Plays"-style projects) — no direct precedent project matching this exact system was found, so pitfall composition is inferential. |
| Compliance | MEDIUM-HIGH | Community Guidelines taxonomy and Anthropic Usage Policy are corroborated across multiple sources / fetched directly (HIGH for gambling policy, privacy/scraping, rate limits, Anthropic policy). Bits/Channel Points AUP content and exact Community Guidelines wording were sourced via search-engine summarization (legal.twitch.com resisted direct scraping) — recommend a manual spot-check of live policy pages before implementing the donation mechanic. Sweepstakes-law analysis is general (non-Twitch-specific) legal principle, MEDIUM-HIGH. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Windows agent sandboxing approach (WSL2 vs. Docker):** not validated hands-on in this research pass; treat as a required spike at the start of Phase 5, not an implementation detail to figure out mid-build.
- **Verbatim current text of Twitch's Bits AUP, Channel Points AUP, Developer Agreement, and Community Guidelines:** sourced via search-engine summarization rather than direct fetch (client-rendered pages resisted scraping) — re-verify against the live site immediately before finalizing the compliance gate's rule set and the donation mechanic's payment rail, per COMPLIANCE.md's own flagged gap.
- **Simulated/play-money gambling mechanics on third-party apps shown on stream:** no definitive Twitch statement found for this specific scenario (as opposed to gambling-site streaming); treat any such suggestion as escalate-to-streamer, not auto-approve or auto-reject, until clarified.
- **Exact donation platform choice (StreamElements vs. Streamlabs):** STACK.md recommends StreamElements by default but flags this as a decision the streamer should confirm (e.g., if Ross already has Streamlabs infrastructure for other alerts) — resolve before Phase 7 planning.
- **Adversarial test suite design for the compliance gate:** the taxonomy is documented, but the specific jailbreak/paraphrase/obfuscation test cases needed to validate the filter before first live use don't yet exist — build this out as part of Phase 1, informed by PITFALLS.md's "camouflage and distraction" and encoding-trick references.

## Sources

### Primary (HIGH confidence)
- dev.twitch.tv/docs/chat, dev.twitch.tv/docs/eventsub, dev.twitch.tv/docs/authentication — official Twitch developer docs (rate limits, EventSub mechanics, OAuth flows)
- legal.twitch.com/legal/dmca-guidelines, legal.twitch.com/legal/channel-points-acceptable-use-policy — official Twitch legal pages (partially direct-fetched, partially search-summarized)
- anthropic.com/legal/aup — Anthropic Usage Policy, fetched directly
- code.claude.com/docs/en/agent-sdk, code.claude.com/docs/en/sandbox-environments — official Claude Agent SDK and sandboxing docs
- twurple.js.org / github.com/twurple/twurple — library documentation

### Secondary (MEDIUM confidence)
- StreamElements/Streamlabs developer docs (donation platform integration patterns)
- github.com/pajbot/tmi-rate-limits — community-maintained rate-limit reference, corroborated by developer forum threads
- Twitch Plays Pokémon Wiki / Wikipedia, Crowd Control product pages — genre precedent
- Sweepstakes/lottery law compliance guides (sweeppeasweeps.com, kickofflabs.com) — general (non-Twitch-specific) legal principle

### Tertiary (LOW confidence)
- Hacker News "Show HN: Twitch Plays Claude" / Claude Crowd (claudecrowd.clodhost.com) — single, self-described community project; directly relevant as a negative case study but not independently audited

Full source lists with individual confidence ratings are in each research file: `.planning/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `COMPLIANCE.md`.

---
*Research completed: 2026-07-08*
*Ready for roadmap: yes*
