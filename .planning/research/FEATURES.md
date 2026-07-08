# Feature Research

**Domain:** Chat-controlled/interactive Twitch stream systems ("chat plays" formats applied to live AI coding)
**Researched:** 2026-07-08
**Confidence:** MEDIUM-HIGH (Twitch platform mechanics are HIGH confidence via official docs; "chat plays AI coding" is a nascent sub-genre with only a couple of direct precedents, so genre-specific conclusions are MEDIUM)

## Feature Landscape

### Table Stakes (Users Expect These)

Features viewers of any "chat controls X" format assume exist. Missing these makes the format feel broken or makes chat's control illusory.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Suggestion submission command (`!suggest <idea>`) | Baseline mechanism for chat to inject ideas; every chat-plays format has an input channel | LOW | Simple chat command parsing via IRC/EventSub chat subscription |
| Timed voting rounds with numbered options (`!vote 1/2/3`) | Direct descendant of Twitch Plays Pokémon's "Democracy" mode (30s tallied rounds); viewers expect a clear window and clear choices | LOW-MEDIUM | TPP's Democracy mode tallied all inputs received over ~30s and executed the winner (twitchplayswiki.fandom.com/wiki/Democracy). Round duration must be visible on overlay. |
| One-vote-per-viewer with revote override | Prevents one user from voting many times to skew results; established pattern in Twitch voting bots | LOW | TwitchCubieBot and chat.vote both implement "latest vote from a user overrides their earlier vote" as the standard anti-spam pattern (github.com/tomaarsen/TwitchCubieBot, chat.vote) |
| Live vote tally on overlay (bar/count per option) | Chat needs to see its own influence in real time or the format feels like a black box | LOW-MEDIUM | OBS browser-source pattern: bot/server pushes state over WebSocket, overlay re-renders instantly; no polling needed |
| Winning suggestion → build task, announced in chat | Closes the loop — chat must see cause and effect ("we voted, and X is now happening") | LOW | Twitch chat bots already do this pattern for game-vote / poll-result bots (moo.bot/r/gamevote) |
| Content/ToS filter on every suggestion before it can enter the queue | Twitch AutoMod already screens raw chat text (5 filter levels across discrimination, sexual content, hostility, swearing categories — dev.twitch.tv/docs/chat/moderation) but AutoMod only catches surface language, not intent (e.g. "add a keylogger" isn't a slur). A layer built for this product's specific risk (code/instruction safety, not just chat toxicity) is non-negotiable per PROJECT.md's hard compliance requirement | HIGH | This is the single highest-complexity table-stakes item — it's an LLM/classifier judgment call on *intent*, not a wordlist. AutoMod is necessary but not sufficient. |
| Rejected-suggestion feedback in chat | Viewers need to know *why* their idea didn't make the ballot or morale/trust collapses (silent rejection reads as arbitrary/broken) | LOW | Reply in chat or via overlay toast; doesn't need to explain full reasoning, just category |
| Streamer veto / kill switch on anything queued or in progress | Every interactive-stream tool in this space (Crowd Control, Twitch Plays Pokémon operators, Neuro-sama's Vedal) keeps a human override as the actual safety backstop, not the automated filter alone | MEDIUM | Crowd Control offers per-effect enable/disable, cooldowns, and price controls as its moderation layer (crowdcontrol.live/features). Neuro-sama's team keeps human moderators live *in addition to* AI filters because filters alone are known to fail (Wikipedia: Neuro-sama) |
| Build/queue status on overlay (what's next, what's building, what's done) | Chat needs situational awareness during the (likely multi-minute) build phase or they disengage between rounds | MEDIUM | Requires orchestrator to emit status events the overlay subscribes to |
| Live view of the app under construction | This *is* the show — "chat plays Pokémon" without a visible game screen isn't a format. Browser window/screen capture of the running build is the equivalent of the emulator screen | MEDIUM | Simplest v1: OBS window/browser-source capture of a dev server tab; auto-reload on file change |
| Chat bot status narration (round start/end, winner, build progress, errors) | TPP, poll bots, and Crowd Control all narrate state transitions in chat so viewers not watching the overlay stay oriented | LOW | Reuse the same bot connection as suggestion/vote ingestion |
| Graceful degradation on build failure (visible "this broke, retrying/skipping" rather than silent dead air) | Live broadcast failures are public (per PROJECT.md); TPP-style formats survive on-stream chaos by narrating it rather than hiding it | MEDIUM-HIGH | Needs explicit failure states in the orchestrator, not just try/catch to a log file |

### Differentiators (Competitive Advantage)

Features that set this format apart from generic chat-plays/voting bots. Should reinforce the Core Value: chat genuinely controls what gets built, safely.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Donation-proportional "free reign" control windows | Direct monetization tied to the core mechanic (not just alerts/goals bar) — a donor becomes the sole director for a duration scaled to their gift, still gated by the same filter/veto as everyone else. No confirmed precedent does this specifically for AI-coding streams; closest analogue is Crowd Control's pay-to-trigger-effects model (Bits/Channel Points/Tips purchase in-game effects — crowdcontrol.live/twitch) | HIGH | Needs Streamlabs/StreamElements (or Twitch Bits) webhook → amount-to-duration mapping → temporary control-mode switch. Must route through the same AI filter + veto as any other suggestion (per PROJECT.md, no compliance bypass at any price) |
| Channel points micro-version of free reign | Smaller-scale version of the above using Twitch's native, free-to-use currency; broadens participation beyond people willing to pay real money | MEDIUM | Twitch Channel Points custom rewards + EventSub redemption events are official, documented, and don't require a third-party donation platform (dev.twitch.tv/docs/api/reference); redemption queue can be set to auto-fulfill or require mod approval via `should_redemptions_skip_request_queue` |
| Chaos mode (AI random-picks from the filtered suggestion pool instead of running a vote) | Direct homage to TPP's "Anarchy" mode variance, but *safer*: TPP anarchy applies every raw input in sequence (true chaos); this format's chaos mode still only randomly selects from AI-filtered, ToS-safe candidates — chaos of *outcome*, not chaos of *unfiltered input* | LOW-MEDIUM | Toggle is streamer- or schedule-controlled, not viewer-voted (avoids TPP's complex 75%/80% mode-switch threshold system — see anti-features) |
| Suggestion clustering / semantic dedup before ballot | Raw chat produces many near-duplicate suggestions ("add a todo list", "todo app", "make a to-do tracker"); an LLM-based clustering step merges these into one ballot option, which no generic voting bot in this space does — most (TwitchCubieBot, chat.vote) only dedupe *votes*, not the *options themselves* | MEDIUM-HIGH | Improves signal quality over raw TPP-style chaos; can reuse the Sonnet research agent tier already planned for the project |
| Multi-stage build transparency (visible handoff from research agent → planning/build agent) | Makes the "AI agent pipeline" itself part of the spectacle — showing *how* the AI reasons, not just the result, is novel relative to Twitch Plays Claude / Claude Crowd, which surface only the command and the raw output | MEDIUM | Overlay panel showing current pipeline stage; low marginal cost since the orchestrator already has this structure (Sonnet research, Fable plan/build) |
| Persistent build history / changelog viewers can browse | Turns single-session chaos into a cumulative "the audience built this app together" narrative across stream nights — differentiates from one-off chat-plays sessions that reset each stream | MEDIUM | Simple append-only log of winning suggestions + resulting diffs/screenshots; can be a static page, not urgent for MVP |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| TPP-style "Anarchy" mode: every chat message executed immediately, unfiltered, in raw sequence | Feels most authentic to the Twitch Plays Pokémon heritage; maximal chaos is entertaining | For a coding agent with repo/file access, unfiltered per-message execution means unreviewable, unsafe, potentially destructive instructions land directly on a live channel — this is close to what "Claude Crowd" (a very similar existing experiment) actually does: crowd-voted commands get **full root access** with an explicit disclaimer "Things might break. Systems might conflict," and no documented moderation layer at all (claudecrowd.clodhost.com). That's the negative case study, not a pattern to copy. | Keep the filter + queue in front of *every* mode, including chaos mode. Chaos mode randomizes selection among already-filtered candidates, never bypasses filtering |
| Donor/subscriber tiers that skip the ToS filter ("VIPs can say/build anything") | Feels like a natural monetization lever — bigger spenders expect bigger control | Explicitly called out as catastrophic in PROJECT.md's Out of Scope: any compliance bypass at any price tier risks the channel itself. A single incident during a paid "free reign" window is a worse outcome than losing that revenue mechanic | Donations/points buy priority and duration only; the instruction still round-trips through the same filter and streamer veto as free suggestions |
| Fully unattended/no-human-in-the-loop operation | Reduces streamer workload; "let the AI run itself" is the dream of automation | Both real precedents in this exact niche keep a human in the loop: Neuro-sama's team "monitors and moderates" continuously despite AI filters (Wikipedia), and the one precedent *without* human oversight (Claude Crowd) explicitly frames itself as unsafe-by-design rather than something to emulate for a real channel's ToS standing | Streamer veto/kill switch must be reachable at all times (hotkey/dashboard), and the loop should default to "pause and flag" rather than "proceed" on ambiguous AI-filter verdicts |
| Open-ended natural-language commands that map to arbitrary shell/system access | "Root access" style control (as in Claude Crowd) is maximally entertaining and technically simple to wire up | Directly conflicts with PROJECT.md's Out of Scope ("no destructive system access... build sandbox stays contained"); also a much larger ToS/security surface than a scoped coding agent | Suggestions are natural-language *feature descriptions*; only the sandboxed build agent (Fable) translates them into constrained repo edits, never raw shell/system commands from chat |
| Real-time collaborative code editor where multiple viewers type directly into the codebase | "Chat literally codes" reads as the most literal interpretation of the project name | Unreviewable concurrent edits, merge conflicts, trivially used to inject unsafe code, and doesn't fit an orchestrated agent pipeline (Sonnet research / Fable build) that PROJECT.md already commits to | Chat expresses intent via suggestions/votes; the agent pipeline is the sole code-writer, keeping a single reviewable actor between "chat wants X" and "code changes" |
| TPP's full mode-switch democracy system (75-80% supermajority thresholds to toggle between modes) | Feels like a deep, "real" democratic mechanic worth copying wholesale from the genre's most famous example | Adds real UX complexity (viewers must understand two thresholds, in what direction, at what percentage) for a mechanic TPP itself only added because the game got stuck — it's a fix for TPP's specific problem, not a generally desirable feature | Keep mode selection (vote / chaos) as a simple streamer-set toggle or a scheduled rotation, not a chat-voted meta-vote |
| Multi-streamer/SaaS control panel in v1 | Natural "what's next" question once the format proves out | Explicitly out of scope per PROJECT.md; adds auth/tenancy/billing surface with zero validation that the core loop works yet | Build for one channel first; revisit generalization only after a proven stream night |

## Feature Dependencies

```
Suggestion submission (!suggest)
    └──requires──> AI ToS filter (every suggestion screened before queue)
                       └──requires──> Rejected-suggestion feedback in chat

Timed voting rounds
    └──requires──> Suggestion submission (need filtered candidates to vote on)
    └──requires──> One-vote-per-viewer dedup
Vote tally overlay
    └──requires──> Timed voting rounds (needs live vote data to render)

Chaos mode
    └──requires──> Suggestion submission + AI ToS filter (still picks from a filtered pool)
    └──conflicts──> Timed voting rounds (mutually exclusive per round — streamer/schedule picks the active mode, not chat)

Donation "free reign" window
    └──requires──> AI ToS filter + Streamer veto (every donor instruction still passes both, per PROJECT.md)
    └──requires──> Donation platform webhook (Streamlabs/StreamElements/Twitch Bits) → amount-to-duration mapping
Channel points micro-control
    └──requires──> Twitch Channel Points custom rewards API + EventSub redemption events

Build engine / orchestrator
    └──requires──> Winning suggestion (from vote, chaos, or free-reign window)
Build/queue status overlay
    └──requires──> Build engine emitting status events
Live app preview
    └──requires──> Build engine producing a running, viewable artifact

Suggestion clustering/dedup ──enhances──> Timed voting rounds (cleaner ballot, not required for MVP)
Multi-stage build transparency ──enhances──> Build/queue status overlay (surfaces pipeline stage, not required for MVP)
Streamer veto/kill switch ──cross-cuts──> every control mode (vote, chaos, donation window, channel points) — must be reachable regardless of which mode is active
```

### Dependency Notes

- **Timed voting rounds requires Suggestion submission:** there must be a filtered pool of candidate ideas before a round can present numbered options.
- **Chaos mode conflicts with Timed voting rounds:** both are "how the next build task gets picked" mechanisms; only one is active at a time. Unlike TPP, don't let chat vote on *which mode* is active — that reintroduces the supermajority-threshold complexity flagged as an anti-feature.
- **Donation free reign requires AI ToS filter + Streamer veto:** this is the load-bearing dependency for the whole paid-influence pillar. If the filter/veto can't be guaranteed to apply to the donation path with the same rigor as free suggestions, the feature must not ship — this is a hard requirement from PROJECT.md, not a nice-to-have.
- **Streamer veto/kill switch cross-cuts every mode:** it cannot be a feature of one control mode; it must sit at the orchestrator level so it functions identically whether the active pick came from a vote, chaos, channel points, or a donation window.
- **Build/queue status overlay requires the orchestrator to emit status events:** this is an architectural dependency, not just a UI task — the build engine needs a status-event contract before the overlay can be built (informs roadmap phase ordering: orchestrator status events before overlay polish).

## MVP Definition

### Launch With (v1)

Minimum viable product — proves chat genuinely and safely controls what gets built, live.

- [ ] `!suggest` command ingestion — the only way ideas enter the system
- [ ] AI ToS/Community Guidelines filter on every suggestion, with in-chat rejection feedback — the non-negotiable compliance gate
- [ ] Timed voting round (`!vote 1/2/3`) with one-vote-per-viewer, revote-overrides-previous
- [ ] Overlay: live vote tally, current suggestion queue, build status — this is the "screen" the whole format is watched through
- [ ] Winning suggestion → orchestrator (Sonnet research agent, Fable plan/build agent) → build task
- [ ] Streamer veto / kill switch reachable at all times (chat command and/or local hotkey) — the human backstop behind the AI filter
- [ ] Live view of the app under construction (browser window or OBS browser source, auto-refreshing)
- [ ] Chat bot status narration (round open/close, winner announced, build progress, failures)
- [ ] Graceful failure handling — a broken build is narrated, not silent dead air

### Add After Validation (v1.x)

Add once the core suggest → filter → vote → build loop has run cleanly on at least one real stream night.

- [ ] Chaos mode toggle — add once voting-round pacing is proven; low cost, adds variance
- [ ] Channel points redemption for a smaller-scale direct-influence mechanic — add once EventSub redemption plumbing is justified by demonstrated chat engagement
- [ ] Donation-proportional "free reign" window — highest complexity and highest compliance risk of any feature; only add once the filter/veto path is battle-tested on the simpler vote/chaos paths
- [ ] Suggestion clustering/dedup — add once raw suggestion volume on a real stream shows enough near-duplicates to justify it

### Future Consideration (v2+)

Defer until the single-channel format has proven itself across multiple stream nights.

- [ ] Multi-stage build transparency (pipeline-stage visualization) — polish feature, not core-loop-blocking
- [ ] Persistent build history / changelog browsing UI — nice narrative feature once there's a backlog of sessions to show
- [ ] Sub/loyalty-weighted voting — adds fairness-perception risk (pay/status-weighted votes can read as unfair); only consider if community explicitly asks for it
- [ ] Multi-streamer/SaaS generalization — explicitly out of scope until v1 is proven on one channel (per PROJECT.md)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `!suggest` submission | HIGH | LOW | P1 |
| AI ToS/compliance filter | HIGH | HIGH | P1 |
| Timed voting rounds + tally overlay | HIGH | MEDIUM | P1 |
| Winning suggestion → build task | HIGH | MEDIUM | P1 |
| Streamer veto / kill switch | HIGH | MEDIUM | P1 |
| Live app preview | HIGH | MEDIUM | P1 |
| Chat bot status narration | MEDIUM | LOW | P1 |
| Graceful failure handling | HIGH | MEDIUM-HIGH | P1 |
| Chaos mode | MEDIUM | LOW-MEDIUM | P2 |
| Channel points micro-control | MEDIUM | MEDIUM | P2 |
| Donation "free reign" window | HIGH (monetization) | HIGH | P2 |
| Suggestion clustering/dedup | MEDIUM | MEDIUM-HIGH | P2 |
| Multi-stage build transparency | LOW-MEDIUM | MEDIUM | P3 |
| Persistent build history UI | LOW-MEDIUM | MEDIUM | P3 |
| Sub-weighted voting | LOW | LOW-MEDIUM | P3 |
| Multi-streamer/SaaS | N/A (out of scope) | HIGH | Not planned |

**Priority key:**
- P1: Must have for launch (first real stream night)
- P2: Should have, add after v1 validated live
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Twitch Plays Pokémon | Crowd Control | Claude Crowd / "Twitch Plays Claude" | Our Approach |
|---------|----------------------|----------------|----------------------------------------|--------------|
| Input mechanism | Raw chat commands (arrow keys etc.), executed immediately (Anarchy) or tallied over ~30s (Democracy) | Viewers buy/trigger discrete pre-defined effects via Bits/Channel Points/Tips | Chat proposes/upvotes commands; highest-voted command sent to Claude Code every 10 min with **full root access** | `!suggest` for ideas, `!vote` for timed rounds, AI-filtered pool for chaos mode — never raw unfiltered execution |
| Content moderation | None beyond standard Twitch chat moderation; anarchy was the literal point | Streamer sets per-effect enable/disable, cooldowns, price scaling | None documented — explicit disclaimer "things might break" | Dedicated AI intent filter (ToS/Community Guidelines categories) in front of every suggestion, all modes, no exceptions |
| Streamer override | Broadcaster added Democracy mode mid-run as a manual fix to a stuck game; no real-time per-input veto | Yes — effect-level enable/disable and cooldowns act as ongoing moderation | Not documented | Explicit, always-available veto/kill switch at the orchestrator level, independent of which control mode is active |
| Monetization tie-in | None (pre-dates Bits/Channel Points maturity) | Core mechanic — viewers pay per effect via Bits/Tips/Channel Points | Not documented (community-run experiment) | Donation-proportional "free reign" window + channel points micro-version, both still filtered/vetoed |
| Chaos/variance mode | Anarchy mode (raw chaos) vs Democracy (tallied) | N/A — always effect-based | Always "chaos" — no voting rounds, just upvote-and-fire every 10 min | Chaos mode = random pick among *already-filtered* candidates, not unfiltered raw input |
| Visible "screen"/output | Live emulator video feed | Live gameplay video feed | Presumably a code/terminal view (not fully documented) | Live browser view of the app under construction (auto-refreshing), plus overlay build-status panel |

## Sources

- [Democracy | Twitch Plays Pokémon Wiki](https://twitchplayswiki.fandom.com/wiki/Democracy) — MEDIUM confidence (fan wiki, but consistent across multiple sources)
- [Twitch Plays Pokémon - Wikipedia](https://en.wikipedia.org/wiki/Twitch_Plays_Pok%C3%A9mon) — MEDIUM-HIGH confidence
- [Crowd Control — Features](https://crowdcontrol.live/features/) and [Crowd Control — Twitch](https://crowdcontrol.live/twitch/) — MEDIUM confidence (official product marketing pages, cross-checked)
- [Twitch Developers — Reference API (Channel Points custom rewards)](https://dev.twitch.tv/docs/api/reference) — HIGH confidence (official docs)
- [Twitch Developer Forums — Receiving data from channel point redeems via EventSub](https://discuss.dev.twitch.com/t/receiving-data-from-channel-point-redeems-via-eventsub/63558) — MEDIUM confidence (developer forum, corroborates official docs)
- [Twitch Developers — Moderating Twitch Chatrooms (AutoMod)](https://dev.twitch.tv/docs/chat/moderation) — HIGH confidence (official docs)
- [Twitch Help — How to Use AutoMod](https://help.twitch.tv/s/article/how-to-use-automod?language=en_US) — HIGH confidence (official docs)
- [pajbot/tmi-rate-limits (GitHub)](https://github.com/pajbot/tmi-rate-limits) — MEDIUM confidence (widely-cited community reference, corroborated by Twitch developer forum threads)
- [Twitch Developers — Polls API](https://dev.twitch.tv/docs/api/polls) and [Predictions API](https://dev.twitch.tv/docs/api/predictions) — HIGH confidence (official docs; native Twitch Polls could be an alternative/backup voting substrate worth evaluating in a later phase)
- [Twitch Blog — Polls and Channel Points Predictions API/EventSub](https://blog.twitch.tv/en/2021/05/24/polls-and-channel-points-predictions-have-leveled-up-with-twitch-api-and-eventsub-support/) — HIGH confidence
- [StreamElements Custom Widget/Overlay Events docs](https://docs.streamelements.com/overlays/custom-widget-events) and [dev.streamelements.com API reference](https://dev.streamelements.com/docs/api-docs/775038fd4f4a9-stream-elements-custom-widgets) — MEDIUM-HIGH confidence (official developer docs)
- [Streamlabs Developers — Triggering Alerts](https://dev.streamlabs.com/docs/triggering-alerts) — MEDIUM-HIGH confidence (official developer docs)
- [tomaarsen/TwitchCubieBot (GitHub)](https://github.com/tomaarsen/TwitchCubieBot) and [chat.vote](https://chat.vote/) — MEDIUM confidence (real open-source/product implementations of vote-dedup pattern)
- [Neuro-sama — Wikipedia](https://en.wikipedia.org/wiki/Neuro-sama) — MEDIUM confidence (well-sourced encyclopedia entry, cross-referenced with multiple press pieces in search results)
- [Hacker News — "Show HN: Twitch Plays Claude"](https://news.ycombinator.com/item?id=46347669) and [Claude Crowd](https://claudecrowd.clodhost.com/) — LOW-MEDIUM confidence (single community project, self-described, not independently audited — but directly relevant prior art in this exact niche and useful as a negative case study for the anti-features section)

---
*Feature research for: Chat-controlled/interactive Twitch stream systems (AI-coding-on-stream format)*
*Researched: 2026-07-08*
