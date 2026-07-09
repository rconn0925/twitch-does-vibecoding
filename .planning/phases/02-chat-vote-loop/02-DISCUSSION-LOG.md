# Phase 2: Chat Vote Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.
> **Mode: --auto** — no user was present; Claude selected the recommended default for every question. Review CONTEXT.md and override any decision before planning if desired.

**Date:** 2026-07-09
**Phase:** 02-chat-vote-loop
**Areas discussed:** Round mechanics, Chat feedback & rate budget, Twitch auth model, Suggestion intake policy, Vote integrity & recovery, Overlay scope

---

## Round mechanics

| Option | Description | Selected |
|--------|-------------|----------|
| Streamer-triggered rounds | Console "Start round" action; streamer controls pacing | ✓ (auto) |
| Auto-scheduled rounds | Fixed cadence timer opens rounds automatically | |

**Auto-selection rationale:** Live-reliability constraint favors streamer control; auto-scheduling deferred as an idea.

---

## Chat feedback & rate budget

| Option | Description | Selected |
|--------|-------------|----------|
| Public @-reply, coalesced | Category one-liners in chat; tallies only on overlay | ✓ (auto) |
| Whisper feedback | Private, but extra scopes + unreliable delivery | |
| No feedback | Violates COMP-03 | |

**Auto-selection rationale:** COMP-03 requires chat feedback; roadmap success criterion 4 dictates the chat/overlay split.

---

## Twitch auth model

| Option | Description | Selected |
|--------|-------------|----------|
| Single broadcaster token | One RefreshingAuthProvider; CLAUDE.md default for v1 | ✓ (auto) |
| Separate bot account | Bot badge + separate rate limit; two auth providers | |

**Auto-selection rationale:** CLAUDE.md stack guidance explicitly defaults to single-token for a single-channel v1.

---

## Suggestion intake policy

| Option | Description | Selected |
|--------|-------------|----------|
| Cooldown + pending cap before classification | Closes T-01-11 (Sonnet flood) at the intake edge | ✓ (auto) |
| Classify everything, limit later | Burns metered calls under flood | |

**Auto-selection rationale:** T-01-11 was accepted in Phase 1 explicitly contingent on Phase 2 rate limits.

---

## Vote integrity & recovery

| Option | Description | Selected |
|--------|-------------|----------|
| In-memory tally + SQLite write-through | Crash-recoverable per success criterion 5 | ✓ (auto) |
| In-memory only | Loses votes on crash — violates criterion 5 | |

---

## Overlay scope

| Option | Description | Selected |
|--------|-------------|----------|
| Round tally + timer + queue strip + state pill | Minimal PRES-01 surface, separate from console | ✓ (auto) |
| Full dashboard overlay | More build-out than PRES-01 needs this phase | |

---

## Claude's Discretion

twurple wiring details, sender-queue token-bucket numbers, pool staleness bound, SQLite schema for rounds/votes/tokens, overlay layout, dedup normalization reuse, console round-start transition composition, bot narration copy.

## Deferred Ideas

- Change-project consensus vote (D-15 roadmap conflict — needs user decision on where it lands)
- Separate bot account
- Semantic near-duplicate dedup
- Auto-scheduled rounds
- Channel-points intake (Phase 4)
