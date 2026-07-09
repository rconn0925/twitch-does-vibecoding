# Phase 1: Compliance Gate & Kill Switch - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-08
**Phase:** 1-Compliance Gate & Kill Switch
**Areas discussed:** Kill-switch ergonomics, Escalation flow, Classifier model & failure behavior, Audit log review surface

---

## Kill-switch ergonomics

| Option | Description | Selected |
|--------|-------------|----------|
| Both: hotkey + console | Global Windows hotkey for instant halt + console page for granular actions | ✓ |
| Console page only | One localhost page with big halt buttons | |
| Hotkey only | Fastest halt, no granularity | |

**User's choice:** Both: hotkey + console (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze everything | Transition to HALTED: abort in-progress, pause queue, stop input; nothing deleted | ✓ |
| Kill current task only | Abort top task, show continues | |
| Kill + discard | Abort AND delete from queue permanently | |

**User's choice:** Freeze everything (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| No confirm, chorded key | One press, deliberate chord | |
| Double-tap to confirm | Press twice within ~2 seconds | ✓ |
| Hold to trigger | Hold ~1 second | |

**User's choice:** Double-tap to confirm (chose accidental-press protection over the recommended zero-friction option)

| Option | Description | Selected |
|--------|-------------|----------|
| Triage then choose | HALTED shows what froze; explicit resume / discard-and-resume / reset to IDLE | ✓ |
| Always reset to IDLE | Un-halt always drops to IDLE | |
| Resume exactly where paused | One-press return to prior state | |

**User's choice:** Triage then choose (recommended)

---

## Escalation flow

| Option | Description | Selected |
|--------|-------------|----------|
| Console approval queue | Dedicated "needs review" section, checked between rounds | ✓ |
| Queue + attention ping | Same queue plus sound/toast nudge | |
| Auto-reject, log for later | Uncertain = rejected; review log off-stream | |

**User's choice:** Console approval queue (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Misses round, re-enters pool | Round proceeds; approved items join the next round's pool | ✓ |
| Round waits briefly | Delay round start ~30s for pending reviews | |
| Approved = dead | Items that miss their round are gone | |

**User's choice:** Misses round, re-enters pool (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Expire end of stream | Auto-expire at session end, logged as expired-unreviewed | ✓ |
| Short TTL (~15 min) | Expire after ~15 minutes unreviewed | |
| Never expire | Persist across sessions | |

**User's choice:** Expire end of stream (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Honest three-state | approved / rejected(category) / held-for-review, visible to viewers | ✓ |
| Two-state to viewers | Escalation internal; viewers see nothing until decided | |
| You decide | Claude picks during planning | |

**User's choice:** Honest three-state (recommended)

---

## Classifier model & failure behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Sonnet | Balance of adversarial robustness, latency, cost | ✓ |
| Haiku, escalate to bigger | Tiered two-prompt design | |
| Fable | Maximum judgment, slowest/costliest | |

**User's choice:** Sonnet (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| On submission, async | Classify immediately in background | ✓ |
| Batch at round start | Screen the pool when a round opens | |
| Both passes | Submission + round-start re-check | |

**User's choice:** On submission, async (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Hold for review | Route failures to approval queue, degrade to manual mode | |
| Reject with 'try again' | Reject failed checks; viewer resubmits shortly | ✓ |
| Auto-pause suggestions | "Suggestions closed" flag until API recovers | |

**User's choice:** Reject with 'try again' (chose over the recommended hold-for-review — prefers a clean review queue; accepts that an API outage bounces suggestions)

| Option | Description | Selected |
|--------|-------------|----------|
| Escalate liberally | Anything not clearly safe/violating goes to review | |
| Lean reject | Uncertain = rejected; only explicit gray-zone categories escalate | ✓ |
| You decide | Claude tunes per category from fixture results | |

**User's choice:** Lean reject (chose over the recommended escalate-liberally — prefers minimal live review load)

**User-raised topic (freeform):** "I want to prevent users from doing long tasks that cost a lot of tokens. For example 'research every chess position' would take a long time, lots of tokens, and bore viewers."

| Option | Description | Selected |
|--------|-------------|----------|
| Reject + suggest trim | Feasibility score; oversized asks rejected with a trimmed-variant suggestion | ✓ |
| Plain reject | "Too large for a live build" category, no counter-proposal | |
| Escalate to you | Oversized asks go to review queue | |

**User's choice:** Reject + suggest trim (recommended)

**Feasibility yardstick question** (options were ~15–30 min / ~1 hour / ~5–10 min per build):

**User's choice (freeform):** "Ideally one big project, but if everyone in chat suggests changing projects, there should be that option. Plus an option if someone donates enough, that one user can change projects."

**Notes:** Interpreted and confirmed with the user as: (1) suggestions are judged as increments to one ongoing project, not whole apps; (2) project-switch is a special instruction type — chat-consensus mechanic deferred to Phase 2, donation-triggered switch deferred to Phase 4; Phase 1 defines the event type.

---

## Audit log review surface

| Option | Description | Selected |
|--------|-------------|----------|
| Console audit page | Filterable decision list in the operator console | |
| Structured logs only | SQLite + pino, query manually | |
| You decide | Claude picks based on Phase 1 console scope | ✓ |

**User's choice:** You decide

| Option | Description | Selected |
|--------|-------------|----------|
| Full record + username | Text, username, decision, category, rationale, timestamps | ✓ |
| Full record, hashed user | Same but hashed identity | |
| Decision-only | Minimal footprint, no identity | |

**User's choice:** Full record + username (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| 90 days rolling | Auto-purge job deletes older rows | ✓ |
| 30 days rolling | Tighter privacy posture | |
| Keep forever | No purge | |

**User's choice:** 90 days rolling (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Optional one-tap tags | Quick reason chips after veto/halt, skippable | ✓ |
| No reason capture | Just who/what/when | |
| Required reason | Demand a reason before completing | |

**User's choice:** Optional one-tap tags (recommended)

---

## Claude's Discretion

- Audit review surface (console page vs structured logs) — user delegated; CONTEXT.md records the recommendation (console audit page, scope-flexible)
- Global hotkey implementation technology
- Console page layout/aesthetics
- SQLite schema, classifier retry/timeout budgets
- Adversarial fixture-suite composition (flagged research-adjacent in ROADMAP.md)

## Deferred Ideas

- Project-switch by chat consensus vote → Phase 2 (Chat Vote Loop)
- Project-switch purchasable by large donation (one user changes the project) → Phase 4 (Paid Influence)
