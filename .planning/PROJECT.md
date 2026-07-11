# Twitch Does Vibecoding

## What This Is

A livestream system where Twitch chat dictates what software gets built, live on stream. Viewers suggest projects and features, vote in timed rounds, and watch an AI agent pipeline (Claude Code) build the winning ideas in real time — with vote tallies, build queue, and progress shown on a stream overlay, and the app-under-construction viewable live. Built for Ross's own channel first.

## Core Value

Chat genuinely controls what gets built — safely. The suggest → filter → vote → build loop must work live on stream, and nothing chat requests can ever put the channel at risk of violating Twitch Terms of Service or Community Guidelines.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Chat control loop**
- [x] Viewers submit ideas via chat command (e.g., `!suggest`) — *Built in Phase 2: EventSub listener → pre-classification intake limits → gate. Live-channel smoke pending (02-HUMAN-UAT.md).*
- [x] Timed voting rounds where chat picks between candidate ideas (e.g., `!vote 1/2/3`) — *Built in Phase 2: console-triggered rounds, chatterId-keyed crash-recoverable ledger, revote override.*
- [x] Winning suggestion becomes the next build task — *Built in Phase 2: winner → single-funnel gate → brand-typed queue, staleness re-check per D2-05.*

**Paid influence**
- [ ] Donations grant the donor a "free reign" window — direct control over what gets built, with duration proportional to the donation amount
- [ ] Channel points redemptions offer a similar (smaller-scale) direct-influence mechanic *(DESCOPED for v1, 2026-07-10 — channel not affiliate, Helix 403; built + fake-tested, dormant; see Key Decisions)*
- [ ] Paid control NEVER bypasses compliance: every instruction still passes the ToS filter and streamer veto

**Chaos mode**
- [ ] A mode where the AI picks pending suggestions at random instead of running votes

**ToS compliance (hard requirement)**
- [x] AI filter screens every suggestion/instruction against Twitch ToS and Community Guidelines categories (hateful conduct, harassment, sexual content, illegal activity, malware/harmful code, privacy violations, etc.) before it can enter the queue — *Built in Phase 1: single-funnel gate (prefilter + fail-closed Sonnet classifier, 15-category taxonomy, machine-enforced invariant). Live-Sonnet eval + physical hotkey test pending human verification (01-HUMAN-UAT.md); chat feedback lands with Phase 2 chat integration.*
- [x] Rejected suggestions get feedback in chat — *Built in Phase 2: category-label-only @-replies, coalesced under the rate budget (COMP-03).*
- [x] Streamer veto / kill switch on anything queued or in progress — *Built in Phase 1: double-tap panic hotkey, tree-kill abort, operator console with per-task veto + HALTED triage.*

**Build engine**
- [ ] Agent orchestrator drives Claude Code sessions to build what chat picked
- [ ] Sonnet-powered agents handle research (investigating chat's ideas); Fable handles planning and building

**Stream presentation**
- [ ] Twitch chat bot reads commands and posts status/results back to chat
- [ ] OBS browser-source overlay showing current votes, suggestion queue, and build progress
- [ ] A way to show the app being built, live (in browser or a separate app window)

### Out of Scope

- ToS filter bypass for donors/subscribers at any tier — money buys priority and control time, never a compliance exemption; channel safety is non-negotiable
- Multi-streamer / SaaS platform — v1 is for Ross's channel only; generalize later if it works
- Building arbitrary/unsafe workloads from chat (e.g., anything requiring secrets, destructive system access, or deploying to third parties) — the build sandbox stays contained

## Context

- Runs on Ross's machine/channel; greenfield project in `C:\Users\ross\Projects\twitch-does-vibecoding`
- Twitch integration surface: chat (IRC/EventSub), channel points redemptions, and donation events (likely via a service like Streamlabs/StreamElements or Twitch Bits — research to determine)
- Twitch developer agreement + ToS also constrain the *system itself* (bot behavior, chat rate limits, incentive mechanics around donations/points) — not just the content chat suggests; research must cover both
- The dev workflow for this repo mirrors the product: Sonnet for research agents, Fable for everything else

## Constraints

- **Compliance**: Everything chat can build and every instruction must comply with Twitch ToS and Community Guidelines — hard requirement from the user
- **Model policy**: Research agents run on Sonnet; all other agent work (planning, building, orchestration) runs on Fable — applies both to building this project and inside the live product
- **Platform**: Windows 11 host (streamer's machine); overlay must work as an OBS browser source
- **Live reliability**: The loop runs during a live broadcast — failures are public; graceful degradation and streamer override matter more than feature count

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Suggest + vote rounds as the base control loop | Democratic, stream-friendly, easy to follow on overlay | — Pending |
| Donation "free reign" windows (time ∝ amount) + channel points equivalent | Monetization and engagement; Twitch-native economy provides rate limiting | — Pending |
| Chaos mode (AI random pick) | Adds entertainment variance to the format | — Pending |
| AI filter + streamer veto (filter applies to paid control too) | Automated screening scales to chat volume; human kill switch is the backstop; no compliance bypass at any price | — Pending |
| Bot + orchestrator + overlay + live app preview | Full stream-night experience in v1 | — Pending |
| Sonnet for research, Fable for everything else | User's model policy for cost/quality split | — Pending |
| v1 done = first real stream night | End-to-end proof in production: chat suggests, votes, watches a small app get built, zero ToS incidents | — Pending |
| Descope channel-points control windows (PAID-02) from v1 — paid influence is tips-only (StreamElements) | The authorized broadcaster account is the real channel and is NOT Twitch affiliate; Helix returned 403 "The broadcaster must have partner or affiliate status" on the custom-rewards endpoint (verified 2026-07-10). Custom rewards cannot exist on this channel yet. Code stays built + dormant behind the existing degradation path (src/main.ts:1311-1320). | ✅ Decided 2026-07-10 — revisit when the channel reaches affiliate |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-10 — channel-points (PAID-02) v1 descope logged (quick 260710-sa0)*
