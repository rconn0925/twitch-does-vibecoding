# Architecture Research

**Domain:** Twitch chat-controlled live AI coding stream system
**Researched:** 2026-07-08
**Confidence:** MEDIUM-HIGH (component patterns are well-established individually — Twitch bots, moderation gates, agent orchestration, overlay servers all have mature precedent; the specific composition of all four into one live system is novel, so the *composition* judgment is MEDIUM, not HIGH)

## Standard Architecture

### System Overview

This is fundamentally an **event-driven pipeline with a single funnel point**, not a microservice mesh. Every external input (chat command, channel points redemption, donation event) is a differently-shaped event that must be normalized into one thing — a `SuggestionCandidate` — before anything else happens to it. The load-bearing architectural rule for this whole project:

> **There is exactly one door into the build queue, and the compliance filter stands in it.** No component is allowed to enqueue a build task directly. Every path — free chat suggestion, channel points redemption, donation free-reign instruction, chaos-mode random pick — is a `SuggestionCandidate` that must pass through the same filter function before becoming a `QueuedTask`.

```
┌───────────────────────────────────────────────────────────────────────┐
│                         EVENT INGESTION LAYER                         │
├───────────────┬───────────────┬───────────────┬───────────────────────┤
│  Twitch Chat   │ Channel Points │  Donation/Tip │   Streamer Operator   │
│  (EventSub WS  │  (EventSub WS  │  (StreamElements│   Console (local     │
│  chat.message) │  reward redeem)│  /Streamlabs   │   HTTP/WS, not a     │
│                │                │  webhook)      │   Twitch event)      │
└───────┬────────┴───────┬────────┴───────┬────────┴───────────┬─────────┘
        │                │                │                    │
        ▼                ▼                ▼                    │
┌───────────────────────────────────────────────────────────────────────┐
│                    NORMALIZATION / EVENT BUS                          │
│   All inputs mapped to: SuggestionCandidate { source, userId,          │
│   text, weight, timestamp, mode-context }                             │
│   In-process EventEmitter (or lightweight queue) — NOT a message      │
│   broker. Single Node process, single source of truth.                │
└───────────────────────────┬─────────────────────────────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    COMPLIANCE GATE (mandatory, synchronous)           │
│   AI classifier (fast, cheap model) screens against Twitch ToS/       │
│   Community Guidelines categories. Every candidate passes through     │
│   here — suggestions, votes-become-tasks, paid free-reign commands,   │
│   chaos-mode picks. Reject → chat feedback + audit log.               │
│   Accept → becomes eligible for queue/vote/direct-build.              │
└───────────────────────────┬─────────────────────────────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    STREAM MODE STATE MACHINE                          │
│   States: IDLE → VOTING_ROUND → BUILD_IN_PROGRESS                    │
│                → FREE_REIGN_WINDOW → BUILD_IN_PROGRESS               │
│                → CHAOS_MODE → BUILD_IN_PROGRESS → IDLE               │
│   Owns: current mode, timers, active donor (if free-reign),          │
│   candidate pool, vote tallies. Emits mode-change events consumed     │
│   by overlay + orchestrator. STREAMER VETO can force-transition       │
│   from ANY state to IDLE or KILL at any time.                         │
└───────────┬─────────────────────────────────────────────┬───────────┘
            │ (winning task)                               │ (state)
            ▼                                               ▼
┌──────────────────────────────┐          ┌─────────────────────────────┐
│   AGENT ORCHESTRATOR         │          │   OVERLAY BROADCAST SERVER  │
│   Spawns Claude Agent SDK    │          │   WebSocket server; pushes  │
│   sessions as child          │◄────────►│   state snapshots (votes,   │
│   processes:                 │  status  │   queue, build progress,    │
│   - Research sub-agent       │  events  │   mode) to OBS browser      │
│     (Sonnet) investigates    │          │   source overlay.           │
│     the winning suggestion   │          └─────────────────────────────┘
│   - Build agent (Fable)      │
│     plans + implements in    │          ┌─────────────────────────────┐
│     sandboxed workspace      │          │  LIVE APP PREVIEW            │
│   Streams progress events    │─────────►│  Separate served process/    │
│   back to state machine      │  build   │  window (built app running   │
│                               │  output  │  on its own port), captured  │
└──────────────────────────────┘          │  as an OBS window/browser    │
                                            │  source.                    │
                                            └─────────────────────────────┘
            ▲
            │ (operator override, always wins)
┌──────────────────────────────┐
│  STREAMER OPERATOR CONSOLE   │
│  Local-only control surface: │
│  veto/kill switch, force-    │
│  mode-change, manual reject  │
│  override, pause/resume      │
└──────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|-------------------------|
| Twitch Ingestion Adapter | Connect to EventSub WebSocket for chat messages + channel points redemptions; parse chat commands (`!suggest`, `!vote`); emit normalized events | Node.js, `tmi.js` (chat/IRC, mature, simple) or native Twitch EventSub WS client (`ws` on Node 22+); one persistent WS connection per Twitch best practice |
| Donation/Points Adapter | Receive webhook/socket events from StreamElements or Streamlabs for tips; compute free-reign duration from amount; emit normalized events | StreamElements Socket.IO client or Streamlabs webhook receiver (Express endpoint) |
| Normalization/Event Bus | Convert all source-specific payloads into a single `SuggestionCandidate` shape; single funnel before compliance | In-process `EventEmitter` or a tiny internal queue (array + processing loop) — no external broker needed at this scale |
| Compliance Gate | Classify candidate text/instruction against Twitch ToS/Community Guidelines categories; approve or reject with reason; log every decision | Fast/cheap LLM call (or moderation-purpose model) with a strict categorical prompt + keyword/regex pre-filter for obvious cases (cheaper, catches spam before burning an LLM call); synchronous in the pipeline — nothing proceeds until this returns |
| Stream Mode State Machine | Own the current mode (idle/voting/free-reign/chaos/building), timers, candidate pool, vote tallies, active donor; the single source of truth for "what is chat allowed to do right now" | XState (or a hand-rolled explicit state machine — given only ~5-6 states, hand-rolled may be simpler and easier to debug live); persists state to disk/memory for crash recovery |
| Agent Orchestrator | Given a winning/approved task, spawn a Claude Agent SDK research session (Sonnet) then a build session (Fable); manage session lifecycle, capture streamed output, translate agent events into stream-mode-consumable progress events; enforce sandbox/workspace boundaries | Claude Agent SDK (Node/TS or Python), sessions run as child processes or SDK-managed subprocess; workspace scoped to a disposable project directory per build |
| Overlay Broadcast Server | Hold current UI-relevant state (votes, queue, progress, mode, countdown); push to all connected overlay clients on change | Node `ws` WebSocket server + a plain HTML/JS/CSS page consumed by OBS as a Browser Source; broadcast-on-state-change pattern (server holds full snapshot, sends full snapshot to new connections, deltas to existing ones) |
| Live App Preview | Serve/display the actual app chat is building so it's watchable | The build agent's dev server running on a fixed local port, captured via an OBS Window Capture or Browser Source pointed at `localhost:PORT`; orchestrator is responsible for starting/stopping/restarting this per build |
| Streamer Operator Console | Local-only UI/CLI giving the streamer veto, kill-switch, force-mode-change, and manual override power over anything queued or in progress | Simple local web page or CLI served only on localhost, authenticated implicitly by being on the machine; talks to the same control API the state machine and orchestrator expose |
| Twitch Chat Response Bot | Post status/results/rejection feedback back to chat | Twitch Chat API (Send Chat Message) via the same bot account/token as ingestion, subject to the 100 msgs/30s (bot) rate limit — batch/throttle status updates |

## Recommended Project Structure

```
src/
├── ingestion/                  # Twitch + donation event sources
│   ├── twitch-chat.ts          # EventSub WS client, chat command parsing
│   ├── twitch-points.ts        # channel_points_custom_reward_redemption.add handler
│   ├── donations.ts            # StreamElements/Streamlabs socket/webhook adapter
│   └── normalize.ts            # maps all sources -> SuggestionCandidate
├── compliance/
│   ├── gate.ts                 # the single chokepoint function: classify() -> accept/reject
│   ├── categories.ts           # ToS/Community Guidelines category definitions
│   ├── prefilter.ts            # cheap regex/keyword pass before LLM call
│   └── audit-log.ts            # append-only record of every decision (for review/appeals)
├── state-machine/
│   ├── stream-mode.ts          # idle/voting/free-reign/chaos/building states + transitions
│   ├── voting.ts                # tally logic, timers, winner selection
│   ├── free-reign.ts           # donor session, duration-from-amount, expiry
│   └── chaos.ts                 # random-pick logic over the approved pool
├── orchestrator/
│   ├── agent-session.ts        # spawns/manages Claude Agent SDK sessions
│   ├── research-agent.ts       # Sonnet research sub-agent wiring
│   ├── build-agent.ts          # Fable build session wiring, workspace lifecycle
│   └── progress-events.ts      # translates agent stream output -> UI-consumable events
├── overlay/
│   ├── server.ts                # WS server, state snapshot broadcast
│   └── public/                  # static HTML/CSS/JS served as OBS browser source
├── operator-console/
│   ├── server.ts                # localhost-only control API + minimal UI
│   └── public/
├── preview/
│   └── preview-manager.ts       # starts/stops/restarts the built app's dev server
├── shared/
│   ├── types.ts                 # SuggestionCandidate, QueuedTask, StreamMode, etc.
│   └── events.ts                 # internal event bus types/names
└── main.ts                       # single process entrypoint, wires everything together
```

### Structure Rationale

- **ingestion/ is source-per-file but shape-agnostic downstream:** each Twitch/donation source has its own auth/protocol quirks, but they all funnel through `normalize.ts` — this is what makes "every path gates through compliance" enforceable in code, not just convention.
- **compliance/ is isolated and independently testable:** because it's a hard requirement ("nothing chat requests can ever put the channel at risk"), the gate needs to be unit-testable in isolation with a large fixture set of known-bad inputs, decoupled from the live Twitch connection.
- **state-machine/ is the brain, orchestrator/ is the hands:** the state machine decides *what* should happen next; it never talks to Claude directly. This boundary matters because agent sessions are slow (seconds to minutes) and the state machine must stay responsive to chat/veto events the whole time.
- **overlay/ and operator-console/ are both "just servers with a UI"** but serve different audiences (public stream viewers vs. streamer only) — kept separate so the operator console is never accidentally exposed the same way the overlay is (overlay URL ends up in OBS, could leak; console must not).

## Architectural Patterns

### Pattern 1: Single Funnel Compliance Gate

**What:** Every possible way a "thing to build/do" can enter the system — free chat suggestion, channel-points redemption text, donor free-reign command, even the chaos-mode random selection — is modeled as the same `SuggestionCandidate` type and passed through one `gate.classify(candidate)` function before it can become a `QueuedTask` or be handed to an agent. There is no code path that skips this function, including admin/paid paths.
**When to use:** Any system where "money/points can influence outcome" and "outcome must never violate a hard safety constraint" coexist — this is exactly the shape of this project's "paid influence never bypasses compliance" requirement.
**Trade-offs:** Adds latency (an LLM call) to every single interaction, including free-reign donor commands where responsiveness matters for the donor's experience. Mitigate with a fast/cheap pre-filter (regex/keyword deny-list catches obvious violations without an LLM round-trip) and a low-latency classifier model for the remainder.

**Example:**
```typescript
// compliance/gate.ts
export async function classify(candidate: SuggestionCandidate): Promise<GateResult> {
  const preFiltered = prefilterCheck(candidate.text); // cheap regex/keyword pass
  if (preFiltered.rejected) {
    auditLog.record(candidate, "rejected", preFiltered.reason);
    return { accepted: false, reason: preFiltered.reason };
  }
  const result = await llmClassify(candidate.text); // categorical ToS classifier
  auditLog.record(candidate, result.accepted ? "accepted" : "rejected", result.reason);
  return result;
}

// EVERY producer of tasks calls this — no exceptions:
// voting.ts winner -> gate.classify() -> queue
// freeReign.ts donor command -> gate.classify() -> queue
// chaos.ts random pick -> gate.classify() -> queue (already gated at suggestion time,
//   but re-check at selection time in case guidelines/context changed)
```

### Pattern 2: Explicit Stream Mode State Machine

**What:** A single, explicit state machine (not scattered boolean flags) owns "what mode is the stream in and what can chat currently do." States: `IDLE`, `VOTING_ROUND`, `FREE_REIGN_WINDOW`, `CHAOS_MODE`, `BUILD_IN_PROGRESS`, `HALTED` (veto/kill). Transitions are the only way mode changes; anything reading "current mode" reads from this machine, never infers it from other state.
**When to use:** Any live/broadcast system with multiple mutually-exclusive interaction modes and a hard requirement for an instant override (streamer veto) from any state.
**Trade-offs:** Upfront design cost to enumerate all states/transitions correctly, but pays off hugely for live reliability — a live stream is the worst possible place to discover an unhandled state combination. A library (XState) gives you visualization/debugging for free; hand-rolling is viable too since the state count here is small (~6 states), and hand-rolling means one less dependency in a system that already has a lot of moving parts.

**Example:**
```typescript
// state-machine/stream-mode.ts (conceptual, library-agnostic)
type StreamMode = "IDLE" | "VOTING_ROUND" | "FREE_REIGN_WINDOW"
                 | "CHAOS_MODE" | "BUILD_IN_PROGRESS" | "HALTED";

// Veto/kill is a transition available from EVERY state, always highest priority:
onOperatorVeto(() => transitionTo("HALTED", { reason: "operator override" }));
```

### Pattern 3: Long-Running Agent Session as Managed Child Process

**What:** The build/research work (Claude Agent SDK sessions) is slow, stateful, and can fail mid-way. Treat each agent session as a supervised child process with a defined lifecycle (spawn → stream progress events → complete/fail/killed), not as a blocking function call. The orchestrator owns start/stop/kill and translates raw agent tool-call/output events into the small set of progress events the state machine and overlay actually need (`started`, `progress(message)`, `completed`, `failed`, `killed`).
**When to use:** Whenever an AI agent's build/work session needs to run for longer than a request/response cycle while the rest of the system (chat ingestion, veto handling, overlay) must remain responsive.
**Trade-offs:** Requires careful process supervision (what happens if the streamer hits kill mid-build? what happens if the agent process crashes vs. hangs?) but is the only pattern that keeps a live stream from freezing while an agent thinks for 90 seconds.

**Example:**
```typescript
// orchestrator/agent-session.ts
async function runBuildSession(task: QueuedTask): Promise<void> {
  const session = spawnAgentSession({ model: "fable", workspace: task.workspaceDir });
  session.on("progress", (msg) => stateMachine.emit("build-progress", msg));
  session.on("complete", () => stateMachine.transitionTo("IDLE"));
  session.on("error", (err) => stateMachine.emit("build-failed", err));
  activeSessions.set(task.id, session); // so operator console can kill it by id
}

function killActiveSession(taskId: string) {
  activeSessions.get(taskId)?.kill();
  stateMachine.transitionTo("HALTED", { reason: "streamer kill switch" });
}
```

## Data Flow

### Request Flow (chat suggestion → build)

```
Twitch chat "!suggest add a snake game"
    ↓
[Twitch Ingestion Adapter] parses command, extracts text
    ↓
[Normalize] → SuggestionCandidate { source: "chat", userId, text, weight: 1 }
    ↓
[Compliance Gate] classify() — prefilter, then LLM categorical check
    ↓ (accepted)                              ↓ (rejected)
[Candidate Pool]                    [Chat Response Bot] posts rejection + reason
    ↓ (voting round opens)
[State Machine: VOTING_ROUND] collects "!vote N" from chat, tallies
    ↓ (round timer expires)
[State Machine] selects winner → re-validates via Compliance Gate (defense in depth)
    ↓ (accepted)
[Agent Orchestrator] spawns research session (Sonnet) → then build session (Fable)
    ↓ (streamed progress)
[Overlay Broadcast Server] pushes progress to OBS overlay
[Preview Manager] starts/updates the built app's dev server → captured by OBS
    ↓ (complete)
[State Machine] → IDLE, [Chat Response Bot] posts result link/summary
```

### Free-Reign / Paid Path (same gate, different mode)

```
Donation event ($20 tip) → [Donation Adapter] → weight/duration computed
    ↓
[State Machine] transitions to FREE_REIGN_WINDOW, active donor = userId, timer = f(amount)
    ↓
Donor sends chat commands during window → [Normalize] → SuggestionCandidate { source: "free-reign", ... }
    ↓
[Compliance Gate] — IDENTICAL function call, no bypass, no shortcut, no elevated trust
    ↓ (accepted)                              ↓ (rejected)
[Agent Orchestrator] executes directly       [Chat Response Bot] posts rejection to donor
    (no vote needed — donor has direct control, but still gated)
```

### Chaos Mode Path

```
[State Machine: CHAOS_MODE] picks random candidate FROM THE ALREADY-APPROVED POOL
    ↓
[Compliance Gate] re-check at selection time (candidate may be stale/context may have shifted)
    ↓ (accepted)
[Agent Orchestrator] executes
```

### Operator Veto (out-of-band, always available)

```
[Streamer Operator Console] veto/kill signal
    ↓ (highest priority, bypasses all other transition logic)
[State Machine] → HALTED (from any state)
[Agent Orchestrator] kill active session if any
[Overlay Broadcast Server] shows "paused by streamer" state
```

### Key Data Flows

1. **Funnel invariant:** every arrow that terminates at "becomes a `QueuedTask`" passes through exactly one compliance gate function call — this is enforced by only exposing task-creation through that function, not by convention/discipline alone (make the illegal state unrepresentable in code: `QueuedTask` should only be constructible via `gate.classify()` returning accepted).
2. **State machine as single source of truth for mode:** overlay, orchestrator, chat bot, and operator console all read "current mode" from the state machine's published state — never derive it independently, or they will drift and disagree live on stream.
3. **Progress events are the interface between slow agent work and fast live systems:** the orchestrator never lets raw agent internals (tool calls, file diffs) reach the overlay directly — it translates to a small stable event vocabulary so the overlay/chat bot don't need to change when agent internals change.

## Scaling Considerations

This is a single-channel, single-streamer v1 (explicitly out of scope: multi-streamer/SaaS). "Scale" here means concurrent chat volume on one channel, not multi-tenant growth.

| Scale | Architecture Adjustments |
|-------|---------------------------|
| Small stream (0-50 concurrent chatters) | Single Node process handles everything comfortably. In-process event bus, no external queue/broker needed. Compliance gate LLM calls are the main latency concern, not throughput. |
| Growing stream (50-500 concurrent chatters) | Chat message volume becomes the bottleneck before anything else. Add debouncing/sampling on `!suggest` (e.g., dedupe identical suggestions within a window before they each hit the compliance gate) and batch vote tally updates to the overlay (don't push a WS update per vote, push at most every N ms). Compliance gate may need a request queue with concurrency limit to avoid hammering the LLM API. |
| Large stream (500+ concurrent chatters) | Out of scope for v1 per PROJECT.md, but if it happens: move compliance pre-filtering to be more aggressive (catch more with regex before LLM), consider a proper queue (even just an in-memory bounded queue with backpressure) between ingestion and compliance so a burst of chat doesn't overwhelm the classifier. |

### Scaling Priorities

1. **First bottleneck: compliance gate LLM latency/cost under chat bursts.** A viral moment producing 200 `!suggest` messages in 10 seconds will queue up 200 LLM calls. Fix: cheap regex pre-filter absorbs the bulk of spam/obvious junk before it reaches the LLM; rate-limit suggestions per user (e.g., 1 pending suggestion per user at a time) so the same person can't flood the gate.
2. **Second bottleneck: overlay WebSocket broadcast frequency during a voting round.** If every single vote triggers a full-state broadcast to all connected overlay clients, high vote volume causes needless network churn (though at OBS-overlay scale — one connection, maybe a couple — this is unlikely to matter until much later). Fix: batch tally updates on a short interval (e.g., every 250-500ms) rather than per-event.

## Anti-Patterns

### Anti-Pattern 1: Separate Compliance Checks Per Input Source

**What people do:** Write one moderation check for chat suggestions and a separate, "simpler" check for donor free-reign commands because "donors paid, they're probably fine" or because the free-reign code path was bolted on later.
**Why it's wrong:** This is precisely the bypass the PROJECT.md explicitly forbids ("ToS filter bypass for donors/subscribers at any tier" is out of scope). Divergent code paths drift over time even with the best intentions — the fix six months from now is a "quick tweak" to the donor path that quietly reintroduces a gap.
**Do this instead:** One `SuggestionCandidate` type, one `gate.classify()` function, called from every producer. If free-reign needs different *behavior* (e.g., skip the vote, act immediately), that's a state-machine concern downstream of the gate, not a gate concern.

### Anti-Pattern 2: Letting the Agent Orchestrator Block the Event Loop / Ingestion

**What people do:** Await the full Claude Agent SDK build session synchronously inside the same handler that's processing chat events, so while a build is running, new chat messages/votes/veto commands aren't processed until it completes.
**Why it's wrong:** Builds can take minutes. A live stream where chat and the veto button stop responding for 90 seconds while the agent thinks is a broken live product — and specifically defeats the "streamer veto on anything queued or in progress" hard requirement, since the veto handler itself needs to keep running concurrently.
**Do this instead:** Agent sessions run as independently-progressing child processes/async tasks (Pattern 3 above); the main event loop for ingestion/state-machine/veto handling is never blocked waiting on agent output. The orchestrator emits events as things happen; it doesn't return a single promise the rest of the system waits on.

### Anti-Pattern 3: Trusting Twitch's Client-Side/Third-Party Numbers Without a Server-Side State Machine

**What people do:** Let each subsystem (overlay, chat bot, orchestrator) independently interpret raw Twitch events and decide "what mode are we in" from local heuristics (e.g., overlay infers voting is active because it received a vote message).
**Why it's wrong:** Leads to desync live on stream — e.g., overlay shows "voting" after the round has actually closed because it missed the close event, chat bot still accepts votes after the state machine moved on. This is exactly the kind of bug that's invisible until it's happening in front of your audience.
**Do this instead:** Single state machine (Pattern 2) is the only authority on mode; every other component subscribes to and displays/acts on its published state, never re-derives it.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|----------------------|-------|
| Twitch EventSub (chat + channel points) | Persistent WebSocket connection (`wss://eventsub.wss.twitch.tv/ws`); subscribe to `channel.chat.message` and `channel.channel_points_custom_reward_redemption.add` after receiving the welcome message's session ID | PubSub is fully decommissioned (April 2025) — EventSub is the only path now. Must resubscribe on reconnect; no event replay for gaps during reconnection. 10-second window to subscribe after welcome message or the server closes the connection. |
| Twitch Chat API (send message) | REST call to post bot responses/status/rejection feedback | Known-bot rate limit ~50 msgs/30s in the general bucket, separate bucket for the Send Chat Message API specifically — batch/throttle status updates so a burst of rejections doesn't trip rate limiting mid-stream. |
| StreamElements or Streamlabs (donations/tips) | Socket.IO client (StreamElements) or webhook receiver (Streamlabs) listening for tip/donation events | Pick one as primary for v1 (StreamElements Socket.IO is simpler to integrate than polling); research task should confirm which the streamer already uses for existing alerts, since duplicating alert infrastructure is wasted effort. |
| Claude Agent SDK | Programmatic sessions (Node/TS or Python) for research (Sonnet) and build (Fable) agents | Per project's own model policy: research agents on Sonnet, all planning/building/orchestration on Fable. Sandboxing on Windows is not natively supported (Claude Code's sandbox relies on Linux bubblewrap / macOS Seatbelt) — on a native Windows 11 host, isolation for agent-executed code needs to come from WSL2 (recommended: install WSL2, run the sandboxed agent workspace inside it) or a Docker container with mounted volumes and network policy, not from Claude Code's built-in sandbox alone. This has direct implications for "the build sandbox stays contained" (PROJECT.md out-of-scope constraint) and should be flagged as a phase-specific research/spike item. |
| OBS Studio | NOT via `obs-websocket` (that's for remote-controlling OBS scenes/sources) — the overlay is a plain Browser Source pointing at a locally-served HTML page that itself opens a WebSocket connection to your own overlay server | Two entirely different "OBS + WebSocket" concepts exist in search results; don't conflate them. `obs-websocket` would only matter if you wanted to programmatically switch OBS scenes (e.g., auto-cut to the live app preview during builds) — worth considering as a differentiator but not required for v1. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|----------------|-------|
| Ingestion ↔ Normalization | Direct function call / in-process event emit | No network hop needed; same process. |
| Normalization ↔ Compliance Gate | Direct async function call (`await gate.classify(candidate)`) | Synchronous in the pipeline sense — nothing downstream proceeds until this resolves. This is the one boundary that must never be bypassed by a shortcut. |
| Compliance Gate ↔ State Machine | Event emit (`gate:accepted` / `gate:rejected`) consumed by state machine and chat-response-bot | State machine only ever sees already-gated candidates. |
| State Machine ↔ Agent Orchestrator | Function call to start a session + event subscription for progress | State machine tells orchestrator "build this," orchestrator tells state machine "here's progress / done / failed." |
| State Machine / Orchestrator ↔ Overlay Server | Event emit → overlay server maintains a snapshot → broadcasts to WS clients | One-directional (system → overlay); overlay never sends commands back into the pipeline. |
| Operator Console ↔ Everything | Direct calls into state machine's veto/kill/force-transition API, and orchestrator's kill-session API | Localhost-only exposure; this is the one component allowed to override normal flow control from outside the pipeline's own logic. |
| Agent Orchestrator ↔ Preview Manager | Function call (start/stop/restart the built app's dev server, on a fixed local port) | Kept as its own small module because "restart the currently-running local app without leaking old processes/ports" is a real operational headache worth isolating and testing on its own. |

## Process Model: What Runs Where on the Windows 11 Streaming PC

The instinct to split this into many microservices should be resisted for v1 — this is a single-operator, single-machine, single-channel system, and process-per-component adds operational overhead (more things that can silently die mid-stream) without a real scaling benefit at this size.

**Recommended: one main Node.js process, few auxiliary processes:**

1. **Main process (`main.ts`)** — hosts ingestion adapters, normalization, compliance gate, state machine, overlay WebSocket server, operator console server, chat response bot, and preview manager. All in-process, communicating via function calls and an internal event emitter. This is the process that must never crash mid-stream; wrap it with a process supervisor (e.g., `pm2`, or even a simple watchdog batch/PowerShell script) that auto-restarts it and, critically, force-transitions state to `HALTED` on restart rather than resuming an unknown mid-build state.
2. **Agent session child processes** — each Claude Agent SDK research/build session runs as its own spawned child process (or SDK-managed subprocess), one at a time in v1 (no concurrent builds — the state machine's `BUILD_IN_PROGRESS` state is exclusive). Isolated so a hung/crashed agent session doesn't take down the main process, and so it can be killed independently via the operator veto.
3. **Built app's dev server** — the actual "app chat is building," started/stopped by the Preview Manager on a fixed local port (e.g., `localhost:5555`), captured into OBS as its own Browser/Window Source. This is inherently a separate process because it's a different, changing codebase each time.
4. **WSL2 (or Docker) sandbox environment** — if Claude Agent SDK build sessions need genuine filesystem/network isolation on Windows (recommended for the "no destructive system access" out-of-scope constraint), the build agent's actual code-execution happens inside a WSL2 distro or container, with the main Windows process talking to it rather than running agent shell commands directly on the host. This is the one place where "one process" is not achievable — treat it as a boundary, not a component to skip.
5. **OBS Studio itself** — separate application entirely (not something this system launches/manages in v1), simply pointed at the overlay's localhost URL and the preview's localhost URL as sources.

**Why not split ingestion/compliance/state-machine/overlay into separate services:** at this scale (one channel, one streamer, a few hundred chatters at most), the coordination overhead of IPC/HTTP between separate services outweighs any benefit, and — more importantly — a live broadcast reliability requirement favors *fewer* moving parts that can independently fail and need independent monitoring. The build order and mental model both get simpler with one process holding the core pipeline, and only genuinely separate lifecycles (agent sessions, the built app, sandboxed execution) get their own process boundary.

## Suggested Build Order

Dependencies flow from the diagram above; build in an order that lets you test each layer against fakes/stubs before the next layer depends on it being real:

1. **Shared types + internal event bus** (`shared/`) — nothing else compiles without this; defines `SuggestionCandidate`, `QueuedTask`, `StreamMode`, event names. Near-zero external dependency, fast to get right.
2. **Compliance gate, in isolation** (`compliance/`) — build and test against a fixture set of known-good/known-bad inputs *before* wiring any real Twitch input. This is the hard-requirement component; validate it thoroughly on its own, decoupled from live chat noise. Use a stub `SuggestionCandidate` generator for testing.
3. **Stream mode state machine, in isolation** (`state-machine/`) — build and test transitions (including veto-from-any-state) against synthetic events, before real ingestion exists. Verify voting timers, free-reign expiry, and chaos-mode selection logic with fakes.
4. **Twitch ingestion + normalization** (`ingestion/`) — now wire real chat/channel-points/EventSub connections, feeding into the already-tested gate and state machine. This is where live-API quirks (rate limits, reconnect/resubscribe logic, welcome-message handshake) get discovered — better to hit them once the pipeline behind them is already solid.
5. **Donation/points adapter** (`ingestion/donations.ts`) — same pattern as chat ingestion but for StreamElements/Streamlabs; can be built in parallel with step 4 since both just produce `SuggestionCandidate`s into the same funnel.
6. **Overlay broadcast server** (`overlay/`) — now that state machine emits real events, build the WS server + browser-source page to visualize votes/queue/mode. High value early because it makes every subsequent step visually debuggable during development.
7. **Operator console** (`operator-console/`) — veto/kill/force-transition surface; build once the state machine's override API exists to hook into. Should ship before agent orchestration goes live, since "streamer veto on anything in progress" is a hard requirement and you don't want to be building your safety net at the same time as the thing it needs to catch.
8. **Agent orchestrator** (`orchestrator/`) — the most complex, most novel component (long-running sessions, sandboxing decisions on Windows). Deliberately sequenced after the safety-critical and visualization pieces are solid, since this is also where the WSL2/Docker sandboxing spike needs to happen and is likely to surface unknowns.
9. **Preview manager** (`preview/`) — wire once the orchestrator can actually produce a runnable app; depends on knowing what kind of dev server the build agent typically produces (may need iteration once real builds are happening).
10. **End-to-end dry run** — full loop with a real (low-stakes) Twitch test channel before the first live stream night, exercising every mode (voting, free-reign via a real small donation, chaos) and confirming the veto/kill switch works against an in-progress build.

**Research flags for later phases:** the sandboxing/isolation approach for agent-executed code on Windows (step 8) is the item most likely to need its own dedicated research pass — training-data-era assumptions about Claude Code sandboxing are Linux/macOS-centric, and the WSL2/Docker path for this specific project's constraints (must run alongside OBS on the same streaming PC, must not add meaningful latency to a live build) hasn't been validated here and should be treated as MEDIUM confidence pending a hands-on spike.

## Sources

- [Handling WebSocket Events | Twitch Developers](https://dev.twitch.tv/docs/eventsub/handling-websocket-events)
- [EventSub | Twitch Developers](https://dev.twitch.tv/docs/eventsub/)
- [EventSub Subscription Types | Twitch Developers](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Legacy PubSub to EventSub Migration Guide](https://dev.twitch.tv/docs/pubsub/) (confirms PubSub decommissioned April 2025, channel points now via EventSub)
- [Example Chatbot Guide | Twitch Developers](https://dev.twitch.tv/docs/chat/chatbot-guide/)
- [GitHub - obsproject/obs-websocket](https://github.com/obsproject/obs-websocket) (control-plane WS for OBS itself — distinct from overlay WS server)
- [GitHub - obsproject/obs-browser](https://github.com/obsproject/obs-browser/blob/master/README.md) (Browser Source = CEF, full web API access)
- [GitHub - filiphanes/websocket-overlays](https://github.com/filiphanes/websocket-overlays) (state-snapshot broadcast pattern for overlay servers)
- [Making Claude Code more secure and autonomous with sandboxing — Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Choose a sandbox environment — Claude Code Docs](https://code.claude.com/docs/en/sandbox-environments) (confirms native Windows unsupported; WSL2 supported, WSL1 not)
- [Subagents in the SDK — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/subagents)
- [GitHub - tomaarsen/TwitchCubieBot](https://github.com/tomaarsen/TwitchCubieBot) (vote aggregation precedent)
- Twitch Plays Pokemon "anarchy vs. democracy" mode precedent (well-documented public case study; direct conceptual ancestor of this project's voting-round vs. free-reign vs. chaos-mode split) — MEDIUM confidence, general knowledge/WebSearch corroborated, not a single authoritative source
- [StreamElements Custom Widgets API Reference](https://dev.streamelements.com/docs/api-docs/775038fd4f4a9-stream-elements-custom-widgets)
- [Triggering alerts — Streamlabs Developers](https://dev.streamlabs.com/docs/triggering-alerts)

---
*Architecture research for: Twitch chat-controlled live AI coding stream system*
*Researched: 2026-07-08*
