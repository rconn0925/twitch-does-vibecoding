<!-- GSD:project-start source:PROJECT.md -->
## Project

**Twitch Does Vibecoding**

A livestream system where Twitch chat dictates what software gets built, live on stream. Viewers suggest projects and features, vote in timed rounds, and watch an AI agent pipeline (Claude Code) build the winning ideas in real time — with vote tallies, build queue, and progress shown on a stream overlay, and the app-under-construction viewable live. Built for Ross's own channel first.

**Core Value:** Chat genuinely controls what gets built — safely. The suggest → filter → vote → build loop must work live on stream, and nothing chat requests can ever put the channel at risk of violating Twitch Terms of Service or Community Guidelines.

### Constraints

- **Compliance**: Everything chat can build and every instruction must comply with Twitch ToS and Community Guidelines — hard requirement from the user
- **Model policy**: Research agents run on Sonnet; all other agent work (planning, building, orchestration) runs on Fable — applies both to building this project and inside the live product
- **Platform**: Windows 11 host (streamer's machine); overlay must work as an OBS browser source
- **Live reliability**: The loop runs during a live broadcast — failures are public; graceful degradation and streamer override matter more than feature count
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 24.x (Active LTS) | Runtime for the whole system | Single event-loop process is the natural fit for a system that's mostly concurrent I/O: EventSub WebSocket, overlay WebSocket, chat, and streaming agent output all multiplex cleanly on one runtime. Node 24 is Active LTS as of mid-2026; Node 22 is Maintenance LTS (fallback only); Node 26 doesn't become LTS until Oct 2026 — too new to bet a live-broadcast system on yet. |
| TypeScript | 6.0.x | Language / type safety | EventSub payloads, chat commands, and Agent SDK messages are all structured JSON crossing process/network boundaries — types catch shape mismatches before they cause a live on-stream failure. TS 7.0 (Go-based compiler) is in RC as of July 2026 but not GA; don't build on an RC for a live-reliability-critical project. |
| @anthropic-ai/claude-agent-sdk | ^0.3.x (pin exact version — pre-1.0, breaking changes land in minor versions) | Programmatic orchestration of Claude Code sessions (research + build agents) | See "Agent Orchestration" rationale below. |
| twurple (`@twurple/auth`, `@twurple/api`, `@twurple/eventsub-ws`) | ^8.1.x (verified `@twurple/api@8.1.4`) | Twitch auth, Helix API calls, EventSub WebSocket listener | The only actively-maintained, TypeScript-first library that covers auth token refresh, Helix API, and EventSub in one coherent suite. See "Twitch Integration" rationale below. |
| Express | 5.2.x | Local HTTP server for the overlay page + static assets + OAuth callback endpoint | Express 5 is now the default `npm install express` version (5.1 shipped March 2025, 5.2 is the TC-endorsed production release as of Dec 2025). Minimal, well-understood, more than sufficient for a single-machine localhost server serving one overlay page and a handful of JSON endpoints. |
| ws | ^8.21.x | WebSocket server pushing overlay state updates to the OBS browser source | Lightweight, no protocol overhead. The overlay is same-origin localhost-only (no cross-domain fallback transports needed), so Socket.IO's extra ~200KB client bundle and long-polling fallback machinery buys nothing here. See "Overlay" section for the reconnect pattern. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4.x | Runtime validation of EventSub payloads, chat command parsing, Agent SDK message shapes | Always — this is the seam between untrusted external input (chat, donations) and the ToS filter / build queue. Validate at every boundary. |
| `better-sqlite3` | ^12.11.x | Durable state: suggestion queue, vote tallies, build history, donor "free reign" windows | Use for anything that must survive a process crash mid-stream (queue state, active control windows). Synchronous API fits a single-process app — no async overhead for what's fundamentally a small embedded DB. Node's built-in `node:sqlite` (Node 22+) is a lighter zero-dependency alternative but is still experimental as of mid-2026 — not worth the risk for a live-reliability-critical data store yet. |
| `p-queue` | ^9.x | Serializing/limiting concurrent agent sessions (e.g., cap concurrent research agents, ensure only one build agent runs at a time) | Once you have more than one agent type running concurrently. Prevents runaway concurrent Claude Code sessions from starving each other or the machine. |
| `pino` | ^10.x | Structured logging | Always. A live show fails in public — you need fast, greppable logs (not console.log) to diagnose an incident mid-stream without slowing the process down. |
| `socket.io-client` | ^4.x | Connecting to StreamElements' realtime websocket API for donation/tip events | Only needed if StreamElements is the donation source (recommended — see below). |
| `dotenv` (or Node's native `--env-file` flag) | latest / N/A | Loading Twitch client ID/secret, Anthropic auth config from `.env` | Always, for local secrets. Node 20.6+ has native `--env-file` support — use that instead of the `dotenv` package if you don't need `.env.local` cascading/interpolation. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| `tsx` | Run TypeScript directly in dev (no separate build step) | Preferred over `ts-node` for speed; use `tsc --noEmit` in CI/pre-commit for type-checking, and a real `tsc` build for the production artifact. |
| `vitest` | Unit/integration tests | Fast, native ESM/TS support, no separate ts-jest config layer. Mock the Twitch EventSub payloads and Agent SDK message stream for the ToS filter and command-parsing logic — these are the highest-risk-of-silent-bug areas. |
| Biome | Lint + format in one tool | Replaces ESLint + Prettier with a single fast Rust-based tool. No Twitch/OBS-specific lint rules exist that would require ESLint's plugin ecosystem, so there's no reason to pay the dual-tool complexity tax. Fall back to ESLint + Prettier only if a specific plugin (e.g., an Anthropic SDK lint rule) becomes necessary later. |
## Installation
# Core
# Supporting
# Dev dependencies
## Twitch Integration
- **twurple** (recommended): actively maintained, TypeScript-first, covers auth token refresh + Helix API + EventSub in one coherent suite. This is the only option that cleanly handles all four integration surfaces (chat read, chat write, channel points, bits) without hand-rolling HTTP calls.
- **tmi.js**: still maintained (last release Nov 2025) but is fundamentally an IRC client — it lost functionality when Twitch restricted IRC `/`-commands in Feb 2023, and Twitch is actively steering integrations away from IRC. Don't build a new 2026 project on it.
- **raw fetch/Helix calls**: viable but means re-implementing token refresh, EventSub session/keepalive handling, and reconnect logic yourself — pure maintenance cost with no benefit over twurple for a single-streamer use case.
- **StreamElements** (recommended): fully cloud-based, no desktop client required. Their realtime websocket API (`socket.io-client` against `realtime.streamelements.com`, JWT-authenticated) pushes `tip`, `cheer`, `follow`, `raid`, `subscriber` events. Because it's cloud-only, it doesn't compete for CPU/RAM on the streaming machine the way a desktop overlay app would.
- **Streamlabs** (alternative): its Socket API works the same way but historically expects the Streamlabs desktop client running to relay events — an extra process on a machine that's already running OBS, the Agent SDK build sessions, and the overlay server. Only prefer Streamlabs if Ross is already standardized on it for alerts/widgets elsewhere.
- **Twitch PubSub** — retired by Twitch in April 2025. Do not use, even if you find old tutorials referencing it for channel points (it's been replaced by EventSub).
- **tmi.js** for new chat-read integration — see above; IRC is a deprecated path.
- **Client Credentials Grant (app access token) alone** — cannot subscribe to broadcaster-scoped EventSub events or send authenticated chat messages; only useful for fully public, unauthenticated Helix calls (which this project doesn't need).
## Agent Orchestration
## Overlay (OBS Browser Source)
- The server holds a single in-memory state object (current votes, suggestion queue, build progress, active donor-control window). On WebSocket connect, send the full current state as one JSON message; thereafter, push incremental updates as they happen. This "full state on connect, then diffs" pattern is the standard approach for OBS/XSplit/CasparCG-style controlled overlays and solves the specific problem that OBS browser sources reload their page on scene switches or OBS restarts — a fresh connection must be able to reconstruct full UI state, not just receive the next delta.
- Use plain `ws` rather than Socket.IO: the overlay is same-origin, localhost-only, single-client-at-a-time (or a small handful of scene variants) — none of Socket.IO's cross-domain/fallback-transport/room features are needed, and a ~30-line hand-rolled reconnect-with-backoff script on the client is simpler than debugging Socket.IO's own reconnection/CORS quirks inside an embedded Chromium browser source.
- OBS's embedded browser (CEF) is a modern-enough Chromium that standard `WebSocket`, `fetch`, and CSS animations all work without polyfills — no special OBS-targeted build step needed.
## Runtime/Language: Node/TypeScript, not Python
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| twurple | Raw Helix fetch calls + hand-rolled EventSub WS client | If you need to strip every possible dependency for a minimal footprint — not recommended here; the maintenance cost of reimplementing token refresh/EventSub keepalive outweighs the dependency weight. |
| twurple | `twitch4j` (Java) / `twitchAPI` (Python) | Only if the rest of the stack is already committed to JVM or Python for other reasons — neither applies here. |
| Claude Agent SDK (TypeScript) | Headless `claude -p --output-format stream-json` subprocess | For one-off scripts or CI-style batch jobs where mid-run interruption and per-tool-call gating aren't needed. Not for the live show's core orchestration loop. |
| `ws` for overlay push | `socket.io` | If you anticipate needing overlay clients across different origins/domains (e.g., a hosted remote overlay, not localhost), or want built-in room/broadcast grouping for multiple simultaneous overlay variants without writing your own. |
| StreamElements for donations | Streamlabs Socket API | If Ross already runs Streamlabs desktop for other alert/widget needs and doesn't want a second dashboard/account to manage. |
| `better-sqlite3` | Node's built-in `node:sqlite` | Once `node:sqlite` graduates from experimental (watch Node 24/26 release notes) — would remove a native-compile dependency, which matters on Windows where native module builds can be a source of setup friction. |
| Node/TypeScript | Python (`claude-agent-sdk-python` + `twitchAPI`) | If Ross has strong existing Python investment — functionally viable, just adds a cross-language boundary between the Twitch/agent backend and the JS-native overlay frontend. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Twitch PubSub | Retired by Twitch in April 2025; dead API | EventSub (WebSocket transport) |
| tmi.js (or any IRC-based chat library) for new integration | Twitch is actively restricting IRC functionality in favor of EventSub; IRC parsing is also messier than typed EventSub payloads | `@twurple/eventsub-ws` for reading, Helix `sendChatMessage` for writing |
| Spawning `claude` CLI as a subprocess per agent turn for the live orchestrator | No in-process hook/abort granularity for the ToS filter and streamer veto; harder to stream structured progress to the overlay | `@anthropic-ai/claude-agent-sdk`'s `query()` embedded directly in the orchestrator process |
| Socket.IO for a same-origin localhost-only overlay | Unneeded transport-fallback/CORS complexity and ~200KB client bundle for a problem `ws` solves in ~30 lines | `ws` + a small hand-rolled reconnect wrapper |
| Setting `ANTHROPIC_API_KEY` in the streaming machine's environment if the goal is subscription/plan billing | It silently overrides Claude plan-credit billing and switches to metered pay-per-token API billing | Leave the env var unset; rely on `claude login`'s persisted local credentials, which the Agent SDK picks up automatically |
| TypeScript 7.0 (Go-based compiler) | Still RC as of July 2026, not GA — too risky to build a live-reliability-critical system on a pre-release compiler toolchain | TypeScript 6.0.x (current stable) |
## Stack Patterns by Variant
- Register and auth a second Twitch account as the bot, request `user:bot` scope for it plus `channel:bot` scope granted by the broadcaster account
- Still need the broadcaster's own token for channel-points and cheer EventSub subscriptions (broadcaster-only) — so you'll manage two `RefreshingAuthProvider` instances, not one
- Because this is v1 for a single channel, this adds real complexity for a purely cosmetic gain — default to the single-broadcaster-token approach unless the bot badge/separate rate limit matters to Ross specifically
- Defer the StreamElements/Streamlabs integration entirely and ship channel points + Bits (both native Twitch, already required) first — donations add a third-party dependency and webhook/websocket surface that isn't required to prove the core suggest→vote→build loop
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@twurple/api@8.1.x` | `@twurple/auth@8.1.x`, `@twurple/eventsub-ws@8.1.x` | Twurple ships its packages in lockstep — always install matching major.minor versions across all `@twurple/*` packages to avoid type-mismatch errors between packages. |
| `@anthropic-ai/claude-agent-sdk@0.3.x` | Node.js 18+ | SDK requires Node 18+; irrelevant here since we're targeting Node 24 LTS anyway, but confirms no runtime conflict. |
| Express 5.2.x | Node.js 18+ | No conflicts with Node 24. |
| `better-sqlite3@12.x` | Node.js ABI for whichever Node major is installed | Native module — requires a matching prebuilt binary or a working native build toolchain (Visual Studio Build Tools) on Windows. Verify `npm install` succeeds with a prebuilt binary for Node 24 before relying on it; if prebuilds lag behind Node 24, this is the most likely Windows-specific friction point in the whole stack. |
## Sources
- [dev.twitch.tv/docs/chat/irc-migration](https://dev.twitch.tv/docs/chat/irc-migration/) — official Twitch guidance to migrate IRC → EventSub + Helix API (HIGH)
- [dev.twitch.tv/docs/authentication/refresh-tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/) — Authorization Code Grant refresh token behavior (HIGH)
- [dev.twitch.tv/docs/eventsub/eventsub-subscription-types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) — `channel.channel_points_custom_reward_redemption.add` (broadcaster-only), `channel.cheer` (HIGH)
- [twurple.js.org](https://twurple.js.org/) + [github.com/twurple/twurple](https://github.com/twurple/twurple) — library docs, `RefreshingAuthProvider`, package versions (HIGH)
- npm registry lookups (via WebSearch) for current versions: `@twurple/api@8.1.4`, `ws@8.21.0`, `express@5.2.1`, `better-sqlite3@12.11.1`, `typescript@6.0.3` (MEDIUM — WebSearch-sourced version numbers, not directly queried against npm registry API; recommend re-confirming exact versions with `npm view <pkg> version` at implementation time)
- [code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript) — `Options.model`, `Options.fallbackModel`, `AgentDefinition.model`, `Query.setModel()` (HIGH — fetched directly from official current docs)
- [github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) — confirms `fable` model alias / `claude-fable-5` addition to SDK model types (HIGH — corroborates model-alias behavior referenced in PROJECT.md's model policy)
- [support.claude.com — "Use the Claude Agent SDK with your Claude plan"](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) — June 2026 subscription-credit billing for Agent SDK usage (MEDIUM — WebSearch-summarized, recommend re-reading directly before relying on billing behavior)
- [github.com/StreamElements/api-docs/blob/main/docs/Websockets.md](https://github.com/StreamElements/api-docs/blob/main/docs/Websockets.md) — StreamElements realtime websocket event types including `tip` (MEDIUM)
- [github.com/filiphanes/websocket-overlays](https://github.com/filiphanes/websocket-overlays), [github.com/ched-dev/obs-overlays](https://github.com/ched-dev/obs-overlays) — established OBS browser-source + WebSocket overlay patterns (MEDIUM — community reference implementations, not official OBS docs, but pattern is consistent across independent projects)
- [nodejs.org/en/blog/release/v26.0.0](https://nodejs.org/en/blog/release/v26.0.0/), [endoflife.date/nodejs](https://endoflife.date/nodejs) — Node.js 24 Active LTS / 26 Current status as of July 2026 (HIGH)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
