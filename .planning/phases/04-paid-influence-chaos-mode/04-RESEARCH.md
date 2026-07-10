# Phase 4: Paid Influence & Chaos Mode - Research

**Researched:** 2026-07-10
**Domain:** Donation/redemption event ingestion, time-boxed control-window state machines, random-selection mechanics, sweepstakes-law/AUP compliance separation
**Confidence:** MEDIUM-HIGH (platform + AUP questions resolved to actionable recommendations; a few items remain streamer-facing account/legal confirmations, flagged below)

## Summary

The donation-platform research question resolves cleanly: **StreamElements remains the correct choice**, and the CLAUDE.md recommendation should be **locked**, not left open. StreamElements' realtime API (`realtime.streamelements.com`, Socket.IO v2.2.0-compatible client with `websocket` transport, JWT- or OAuth2-token `authenticate` handshake) is fully cloud-based — no desktop client (StreamElements OBS.Live / Streamlabs desktop) is required to *receive* `tip` events over the socket, confirming the "no CPU/RAM competition on the streaming machine" rationale in CLAUDE.md. Streamlabs' Socket API is architecturally similar (also a cloud `socket.io` connection, token-authenticated) and does **not** strictly require its desktop app for socket delivery either — but StreamElements' SE.Pay tipping path has a documented, directly relevant advantage for this phase's chargeback question: **SE.Pay tips are contractually non-refundable/non-chargeback-able from the viewer's side**, and StreamElements absorbs chargeback risk and fees on the rare fraud case. This closes the open chargeback-handling research question: **Phase 4's MVP needs no retroactive window-annul path** — log the amount→duration mapping (PAID-04) and move on; a chargeback is a StreamElements-side billing dispute, not a live control-window integrity problem.

The Bits AUP re-verification confirms the roadmap's existing rejection of Bits as a paid-influence trigger was correct and should stay locked, now with a verbatim citation: Twitch's Bits Acceptable Use Policy states **"users may not offer to exchange Bits for experiences off of Twitch or for goods or services that typically have a monetary cost or value"** and separately prohibits "providing items or services... that are physical or that are not available on Twitch... in exchange for Bits." A donor-directed software build session is exactly this kind of off-platform, monetizable service — Bits-as-trigger is AUP-non-compliant by the platform's own current language, not merely a cautious inference. Channel-points redemptions are the opposite case: Twitch's own EventSub `channel.channel_points_custom_reward_redemption.add` (v1, `channel:read:redemptions` broadcaster-scoped) exists precisely to let broadcasters build native, non-monetary reward-driven interactions — fully compliant, and the Phase 2 broadcaster token already covers the scope (no new OAuth flow needed).

Architecturally, this phase is well set up by Phase 1: `StreamMode` already has `FREE_REIGN_WINDOW` and `CHAOS_MODE` as legal `IDLE`-reachable states with a `BUILD_IN_PROGRESS` exit, and `CandidateSource` already enumerates `"channel_points" | "donation" | "chaos"`. The ControlWindow state machine and chaos-mode selector are new modules, but they route into the *existing* funnel — `submitCandidate`/`toQueuedTask` — through the same pattern as `src/pipeline/round.ts`'s `enqueueWinner`: a **third**, narrowly-scoped `src/pipeline/*.ts` funnel entry point (not a new enqueue path), which the single-funnel invariant test needs one new allowlist entry to recognize. The paid↔chaos separation invariant (D-08) is directly modelable on the existing `secrets-isolation.test.ts` source-scan pattern: two independent regex scans, one confirming the paid/window module never imports `Math.random`/`crypto.randomInt`/any RNG token, the other confirming the chaos-selector module never imports or references a donation/redemption/tip event type.

**Primary recommendation:** Lock D-01 to StreamElements (no further spike needed — this research closes it); build ControlWindow as a single state machine backing both donation and channel-points triggers, persisted in a new `control_windows` table in the existing better-sqlite3 db; implement D-08 as a machine-checked source-scan invariant mirroring `secrets-isolation.test.ts`; treat chargeback handling as out of scope for MVP given StreamElements' no-chargeback-to-streamer SE.Pay model.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Donation event ingestion (StreamElements socket) | Backend/orchestrator (Node process) | — | Same tier as the Phase 2 twurple EventSub listener — a persistent socket client living in the single Node process, translating third-party events into the internal candidate/window vocabulary |
| Channel-points redemption ingestion (EventSub) | Backend/orchestrator | — | Extends the existing `@twurple/eventsub-ws` listener session (Phase 2) — same auth, same reconnect discipline, one more subscription type |
| ControlWindow state machine (open/active/expiry/revoke) | Backend/orchestrator | Database/storage (better-sqlite3) | Mirrors `StreamModeMachine` — in-memory authoritative state with durable write-through persistence, not a UI or API-layer concern |
| Amount→duration mapping + cap/cooldown logic | Backend/orchestrator | — | Pure business logic, config-driven constants, no I/O of its own beyond reading config |
| Chaos-mode random selection | Backend/orchestrator | — | A selection-strategy swap at the same layer as the Phase 2 round-winner selection (`RoundManager`) — never touches the client/overlay |
| Single-funnel re-entry (paid/chaos → gate → queue) | Backend/orchestrator | Compliance gate (`src/compliance/`) | New narrow `src/pipeline/*.ts` entry points, same pattern as `round.ts`'s `enqueueWinner` — the gate/funnel boundary is the architectural chokepoint, not a new tier |
| Paid↔chaos separation invariant | Test/CI tooling (source-scan) | — | Machine-enforced at build/test time, not a runtime component — same tier as `single-funnel.test.ts`/`secrets-isolation.test.ts` |
| Active-window/chaos overlay surfacing | Browser/Client (OBS overlay) | Backend (ws push) | Read-only render of state the backend already computes and pushes — no new client-side logic, same full-state-on-connect pattern as Phase 2/3 |
| Operator console: revoke window, toggle chaos | Frontend Server (console, same-origin) | Backend/orchestrator | Same posture as existing console routes (Origin+Content-Type CSRF, textContent-only render) — a control surface, not a public one |

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-02:** Channel-points trigger = native Twitch EventSub `channel.channel_points_custom_reward_redemption.add` (broadcaster-scoped — the broadcaster token from Phase 2 already covers it). No new auth surface beyond what Phase 2 established.
- **D-03:** A single **ControlWindow** state machine backs BOTH donation windows and channel-points windows (same open → active → expiry/revoke lifecycle, same gate + veto routing); they differ only in trigger and in their (configurable) duration/cap constants. Do not build two parallel mechanisms.
- **D-04:** Amount→duration mapping is **linear with a floor and a hard cap**, plus a **per-donor cooldown** — exact constants are streamer-tunable config (Claude's discretion / research-informed), but the SHAPE (linear-capped + cooldown) is locked.
- **D-05:** **One active control window at a time** (no stacking), mirroring the build concurrency-1 discipline. Precedence: an active paid window > chaos mode > the normal vote loop. A redemption/donation arriving while a window is active is queued behind the cooldown or dropped-with-feedback (never silently) — narration + audit.
- **D-06:** During a window, a donor instruction becomes a queued task through the **SAME single funnel** (gate.ts `classify()` → the one `as QueuedTask`) used by the vote path — paid control gets *guaranteed selection*, never a gate exemption (PAID-03). The single-funnel invariant must remain green; no new enqueue path. Windows are time-boxed and **streamer-revocable at any moment** (reuse the Phase 1 veto/HALTED machinery); expiry or revoke reverts to the normal loop. Durable state (active window, cooldown timers, amount→duration log) persists in better-sqlite3.
- **D-07:** Chaos mode is a **streamer toggle** that replaces the vote with a **uniform-random pick from the already-filtered pool** (the pool is still fully gate-filtered — chaos changes selection, never compliance). On toggle-off, revert to the vote loop.
- **D-08 (LOCKED, machine-enforced):** Chaos (random) and paid control (guaranteed) **share no code path that attaches chance to payment** (CHAOS-02 / success-criterion 5). Enforce as a machine-checkable invariant: the paid-window module imports/refers to no RNG, and the chaos/random-selection module subscribes to no donation/redemption/payment event.
- **D-09:** This phase is predominantly orchestration + state machines + event ingestion — minimal agent/LLM work. Sonnet-research/Fable-build split unchanged and largely dormant here.
- **D-10:** Phase 4 is built against the SAME injected-fakes discipline as Phase 3 — it does not require the Phase 3 Wave 0 WSL2 go/no-go to be closed to be developed and tested.
- **Bits rejected outright** as a paid-influence trigger (AUP risk); donations flow only through the external platform.

### D-01 — This Research Pass Resolves It

CONTEXT.md recorded D-01 (donation platform) as **OPEN / recommendation-not-locked**, explicitly deferring to this research pass. **This research recommends locking D-01 to StreamElements** (see Research Question 1 below for the full evidentiary basis) — the planner should treat StreamElements as locked going into planning, subject to the streamer's own account-setup confirmation at the live-checkpoint gate (same posture as Phase 2's Twitch OAuth bootstrap).

### Claude's Discretion

- Exact amount→duration constants, cap values, and cooldown lengths (D-04) — streamer-tunable config, research-informed (see Architecture Patterns → ControlWindow below for a concrete starting shape).
- The precise ControlWindow schema and overlay presentation of an active window (donor handle, countdown, chaos indicator) — subject to the Phase 3 UI-SPEC discipline (no red on broadcast, textContent-only, coarse public surface).
- Transient-vs-terminal handling of donation-event socket drops (reuse the twurple/EventSub reconnect discipline from Phase 2).

### Deferred Ideas (OUT OF SCOPE)

- Chargeback/refund reconciliation depth beyond amount→duration logging — this research now recommends **not building** any retroactive-annul mechanism for MVP (see Research Question 3).
- Tiered donation perks / multi-window queueing / donor leaderboards.
- Bot-account token split for a separate paid-window rate limit/badge.
- Persistent cross-stream changelog of paid/chaos builds (Phase 5, HIST-01).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PAID-01 | Donation (external platform, not Bits) grants a free-reign window with duration ∝ amount, caps + cooldowns | StreamElements `tip` event shape (Code Examples §1); ControlWindow amount→duration mapping (Architecture Patterns §1) |
| PAID-02 | Channel-points redemption grants a smaller-scale direct-influence window via native EventSub | EventSub `channel.channel_points_custom_reward_redemption.add` subscription details (Research Question 4; Code Examples §2) |
| PAID-03 | Every paid-window instruction passes the identical compliance gate and remains vetoable | Single-funnel re-entry pattern (Architecture Patterns §2), reusing `classify()`/`toQueuedTask()`/`AbortRegistry` unchanged |
| PAID-04 | Windows are time-boxed, revocable, logged (amount→duration mapping recorded) | ControlWindow persistence schema (Architecture Patterns §1); chargeback disposition (Research Question 3) closes the retroactive-annul question |
| CHAOS-01 | Streamer toggle for random pick from filtered pool instead of a vote | Chaos selector design (Architecture Patterns §3) |
| CHAOS-02 | Chaos (random) and paid control (guaranteed) share no code path attaching chance to payment | Machine-checked separation invariant (Architecture Patterns §4; Research Question 5) |

## Project Constraints (from CLAUDE.md)

- **Compliance is a hard requirement** — nothing chat/donors request may bypass Twitch ToS/Community Guidelines; this phase must not weaken COMP-01..05 in any way (paid control gets guaranteed selection, never a gate exemption — matches D-06 exactly).
- **Model policy**: research runs on Sonnet, all other agent work (planning, building, orchestration) runs on Fable — this phase has almost no agent/LLM surface (D-09), so the policy is largely dormant here; the reused Phase 3 build agent already honors it.
- **Windows 11 host** — no platform-specific concern introduced by this phase (no new native deps).
- **Live reliability** — graceful degradation and streamer override matter more than feature count: the never-silent doctrine (drops/queues/window events always narrated+audited) directly implements this for PAID-01..04 and CHAOS-01/02.
- **StreamElements recommended over Streamlabs** (CLAUDE.md Twitch Integration / Alternatives Considered) — this research reaffirms and closes that recommendation as locked, not just default.
- **Bits explicitly listed under "What NOT to Use"** for paid-build-influence triggers — reaffirmed with verbatim AUP text below.
- **`socket.io-client` ^4.x** is CLAUDE.md's stated dependency for the StreamElements realtime connection — confirmed current (npm registry: `4.8.3`, see Package Legitimacy Audit).
- **`ws` for overlay push, never Socket.IO for the overlay** — unaffected by this phase; StreamElements' OWN outbound event feed uses Socket.IO on *their* side, which is unrelated to and does not change the overlay's own `ws`-based push architecture.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `socket.io-client` | ^4.8.3 (verified current on npm registry, 2026-07-10) [VERIFIED: npm registry] | Connects to StreamElements' realtime websocket API (`realtime.streamelements.com`) for `tip` events | The only client library StreamElements' own docs/examples use for their real-time API; CLAUDE.md's existing recommendation, reaffirmed by this research (see Research Question 1) |
| `@twurple/eventsub-ws` | ^8.1.4 (already installed, lockstep with `@twurple/api`/`@twurple/auth` — Phase 2) [VERIFIED: package.json] | Extend the existing EventSub WebSocket session with the `channel.channel_points_custom_reward_redemption.add` subscription | No new install — Phase 2's listener session gains one more `subscribeToChannelPointsCustomRewardRedemptionAddEvents`-style call; avoids a second EventSub connection |
| `better-sqlite3` | ^12.11.0 (already installed — Phase 1/2/3) [VERIFIED: package.json] | Durable ControlWindow state (active window, cooldown timers, amount→duration ledger) | Same durability rationale as existing `rounds`/`round_votes`/`audit_log` tables — a mid-stream crash must not lose or silently extend a paid window (D-06) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4 (already installed) [VERIFIED: package.json] | Boundary validation of StreamElements `tip` payloads and EventSub redemption payloads before any field use | Always at this untrusted-external-input boundary — mirrors `twitch-chat.ts`'s `safeParse` pattern exactly |
| `node:crypto` (`randomInt`) | Node 24 built-in [VERIFIED: Node.js core] | Chaos-mode uniform-random pick from the filtered pool | Cryptographically-sound uniform selection with zero new dependency; confines the ONE RNG call-site the D-08 invariant scans for |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| StreamElements | Streamlabs Socket API | Architecturally similar (also cloud `socket.io`, token-based, no desktop client strictly required for the *socket* connection itself) — but Streamlabs' donation/alert ecosystem is more commonly paired with the desktop app in practice, and CLAUDE.md/PROJECT.md already standardize on StreamElements; switching would add a second, less-integrated third-party surface with no offsetting benefit for a single-streamer v1. Only reconsider if Ross is already standardized on Streamlabs elsewhere (per CLAUDE.md's own alternatives table). |
| StreamElements SE.Pay tips | Raw Stripe/PayPal donation widget | Building your own payment collection means owning PCI-adjacent compliance, chargeback handling, and fraud detection yourself — SE.Pay already absorbs all of that (see Research Question 3); reinventing it has no upside for this project's scope. |
| `node:crypto.randomInt` | `Math.random()` | `Math.random()` is not cryptographically uniform and is a common "convenience RNG" habit; using a distinct, deliberate import (`node:crypto`) also makes the D-08 source-scan invariant's RNG-detection regex simpler and less prone to false negatives from an incidental `Math.random()` appearing in unrelated code (e.g. jitter/backoff logic elsewhere in the codebase). |

**Installation:**
```bash
npm install socket.io-client
```
No other new packages — `@twurple/eventsub-ws`, `better-sqlite3`, `zod` are already dependencies.

**Version verification:** `npm view socket.io-client version` → `4.8.3` (checked 2026-07-10). `@twurple/*` packages remain pinned to `^8.1.4` lockstep per Phase 2's existing install (no version bump needed — `channel.channel_points_custom_reward_redemption.add` support has been in the `@twurple/eventsub-ws` v8 line since its introduction).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `socket.io-client` | npm | ~13 yrs (long-established, part of Socket.IO project) | very high (tens of millions/week class) | github.com/socketio/socket.io-client | [OK] (flagged "name looks like LLM bait but package is established" — false positive on an established package) | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none. `socket.io-client` triggered slopcheck's naming heuristic ("ends with '-client'") but was independently classified `[OK]` as an established package — no further action needed. `npm view socket.io-client scripts.postinstall` returned empty (no postinstall script) — no supply-chain red flag.

Note on package-name provenance: `socket.io-client` is not merely `[ASSUMED]` here — it is the exact package name shown in StreamElements' own official GitHub docs example code (`github.com/StreamElements/api-docs/blob/main/docs/Websockets.md`), fetched directly in this research session, and independently confirmed on the npm registry (`npm view socket.io-client version`) and by slopcheck. It qualifies for `[VERIFIED: npm registry]` under the provenance rule (official-docs source + registry + slopcheck pass), not `[ASSUMED]`.

## Architecture Patterns

### System Architecture Diagram

```
 StreamElements realtime socket          Twitch EventSub (existing Phase 2 session)
 (tip events, JWT-authed)                 + channel.channel_points_custom_reward_redemption.add
        │                                              │
        ▼                                              ▼
 ┌─────────────────────┐                    ┌─────────────────────────┐
 │ donation-source.ts   │                    │ twitch-chat.ts (extended)│
 │ (injected-fake seam)│                    │ redemption handler seam  │
 └──────────┬───────────┘                    └────────────┬─────────────┘
            │  DonationEvent{amount,currency,donor,msg}    │  RedemptionEvent{rewardId,userId,input}
            ▼                                              ▼
        ┌───────────────────────────────────────────────────────┐
        │            control-window.ts (ControlWindow FSM)        │
        │  open → active → (expiry | revoke) → closed             │
        │  amount/redemption → duration (linear+cap+cooldown)     │
        │  ONE active window at a time (D-05); precedence:         │
        │  paid window > chaos > vote loop                        │
        │  durable state in better-sqlite3 (control_windows table)│
        └───────────────────────┬───────────────────────────────┘
                                 │ donor instruction text (during an active window)
                                 ▼
                     ┌─────────────────────────┐
                     │ pipeline/paid-window.ts  │   ◄── NEW narrow funnel entry,
                     │ (submitCandidate/        │       same shape as pipeline/round.ts
                     │  toQueuedTask, unchanged)│
                     └───────────┬───────────────┘
                                 │
                                 ▼
                     ┌─────────────────────────┐        ┌───────────────────────┐
                     │ compliance/gate.ts        │◄───────│ chaos/selector.ts      │
                     │ classify() → toQueuedTask │        │ (node:crypto.randomInt,│
                     │ (UNCHANGED, D-06)         │        │  picks from ALREADY-   │
                     └───────────┬───────────────┘        │  gate-filtered pool)   │
                                 │                          └───────────┬───────────┘
                                 ▼                                      │
                     ┌─────────────────────────┐                       │
                     │ queue/task-queue.ts       │◄──────────────────────┘
                     │ (single TaskQueue,        │   via pipeline/chaos.ts
                     │  unchanged)               │   (separate narrow funnel entry)
                     └───────────┬───────────────┘
                                 ▼
                     Phase 3 build-session orchestrator (unchanged, reused as-is)
                                 │
                                 ▼
              overlay/console: active-window countdown + donor handle,
              chaos indicator, window open/close/revoke narration (never-silent)
```

Two structurally SEPARATE code paths converge only at `compliance/gate.ts` — the ONE point both a guaranteed (paid) and a random (chaos) task must pass through identically. Neither path imports from the other's module (D-08).

### Recommended Project Structure

```
src/
├── ingestion/
│   ├── donation-source.ts         # StreamElements socket.io-client wrapper behind an injected DonationEventSource seam (mirrors twitch-chat.ts's ChatEventSource pattern)
│   └── donation-source.test.ts
├── control-window/
│   ├── control-window.ts          # ControlWindow FSM: open/active/expiry/revoke, amount→duration mapping, cooldown tracking
│   ├── control-window.test.ts
│   └── persistence.ts             # better-sqlite3 read/write for the control_windows table (crash-safe restore, mirrors round.ts's restore())
├── chaos/
│   ├── selector.ts                 # uniform-random pick from the filtered pool; the ONLY module allowed to import an RNG (D-08)
│   └── selector.test.ts
├── pipeline/
│   ├── paid-window.ts              # NEW narrow funnel entry: donor instruction during an active window → submitCandidate/toQueuedTask (mirrors round.ts's enqueueWinner)
│   └── chaos.ts                    # NEW narrow funnel entry: chaos pick → submitCandidate/toQueuedTask
├── audit/
│   └── record.ts                   # extend with recordWindowOpened/recordWindowClosed/recordWindowRevoked/recordChaosPick (same insert() shape as existing recordRoundOpened/Closed)
tests/invariants/
└── paid-chaos-separation.test.ts   # NEW: D-08 machine-checked source scan (mirrors secrets-isolation.test.ts)
```

### Pattern 1: ControlWindow State Machine

**What:** A single FSM (`open → active → expiry | revoke → closed`) backing BOTH donation and channel-points windows, mirroring `StreamModeMachine`'s hand-rolled-not-XState approach (same "too few states to justify a library" rationale — this FSM has 4 states, even smaller than the 6-state `StreamModeMachine`). The `StreamMode` enum already has `FREE_REIGN_WINDOW` reachable from `IDLE` — ControlWindow activation drives `machine.transition("FREE_REIGN_WINDOW")`; window close/revoke drives it back to `IDLE`.

**When to use:** Every donation `tip` event and every channel-points redemption event that clears the cooldown check funnels through this one FSM instance — never two parallel window trackers.

**Amount→duration mapping shape (D-04, linear+floor+cap):**
```typescript
// src/control-window/duration.ts — pure function, no I/O, config-driven constants
export interface DurationConfig {
  /** Seconds of window per currency unit (e.g. per $1 / per 100 channel points). */
  ratePerUnit: number;
  /** Minimum window length regardless of amount (floor). */
  minSeconds: number;
  /** Maximum window length regardless of amount (hard cap — prevents monopolizing the show). */
  maxSeconds: number;
}

/** Linear-with-floor-and-cap: duration = clamp(amount * rate, min, max). Pure, testable in isolation. */
export function amountToDurationSeconds(amount: number, cfg: DurationConfig): number {
  const raw = amount * cfg.ratePerUnit;
  return Math.min(Math.max(raw, cfg.minSeconds), cfg.maxSeconds);
}
```
Config-driven constants (Claude's discretion, streamer-tunable) — a reasonable MVP starting shape based on typical stream-tip distributions: `ratePerUnit` such that a $5 tip ≈ 60s, `minSeconds` = 30 (a $1 tip still feels meaningful), `maxSeconds` = 300 (5 minutes — long enough to matter, short enough that no single donation dominates a stream segment). **[ASSUMED — these specific numbers are Claude's judgment, not sourced from any donation-platform norms; flag for streamer confirmation before locking as config defaults.]**

**Cooldown (D-04):** per-donor (keyed by StreamElements `username` / EventSub `user_id`), tracked as `lastWindowGrantedAtMs` — reject/queue a new grant if `now - lastGrantedAtMs < cooldownMs` even if amount would otherwise qualify. This is a SEPARATE guard from D-05's one-active-window-at-a-time rule; both apply.

**Persistence (D-06 crash safety):**
```sql
-- New table, added to src/audit/schema.sql (or a new src/control-window/schema.sql loaded alongside it)
CREATE TABLE IF NOT EXISTS control_windows (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type      TEXT NOT NULL,             -- 'donation' | 'channel_points'
  donor_identifier  TEXT NOT NULL,              -- StreamElements username or Twitch user_id
  amount_or_cost    INTEGER NOT NULL,           -- cents/points; the raw trigger magnitude
  duration_ms       INTEGER NOT NULL,
  opened_at_ms      INTEGER NOT NULL,
  ends_at_ms        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  closed_at_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_control_windows_status ON control_windows(status);
```
On boot, restore logic mirrors `RoundManager.restore()`: read the most recent `status = 'active'` row; if `ends_at_ms` has already passed, close it as `expired` and revert mode to `IDLE`; otherwise re-arm the in-memory expiry timer for the REMAINING duration (never extend past the originally-computed `ends_at_ms` — this is what "cannot lose or silently extend a paid window" requires: the durable `ends_at_ms` is the single source of truth, not a re-started timer).

### Pattern 2: Single-Funnel Re-Entry (D-06)

**What:** Paid-window and chaos-picked instructions each get their OWN narrow `src/pipeline/*.ts` entry point — `paid-window.ts` and `chaos.ts` — structured exactly like `src/pipeline/round.ts`'s `enqueueWinner`: call the SAME `classify()`/`toQueuedTask()` from `compliance/gate.ts`, call the SAME `TaskQueue.enqueue()`. No new brand-construction path, no new `.enqueue(` call site outside `src/pipeline/`.

**Example (paid-window funnel, mirrors round.ts structure):**
```typescript
// src/pipeline/paid-window.ts — Source: mirrors src/pipeline/round.ts's enqueueWinner exactly
import { classify, toQueuedTask } from "../compliance/gate.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { SuggestionCandidate } from "../shared/types.js";

export interface PaidWindowFunnelDeps {
  taskQueue: TaskQueue;
  classify: (candidate: SuggestionCandidate) => Promise<import("../shared/types.js").GateResult>;
  mode: () => import("../shared/types.js").StreamMode;
}

/**
 * A donor instruction issued during an ACTIVE window still passes classify()
 * — PAID-03: guaranteed SELECTION (skips the vote), never a gate EXEMPTION.
 * A rejected/held instruction is narrated to the donor (never silently
 * dropped) and does NOT consume the window's remaining time budget.
 */
export async function submitDuringWindow(
  deps: PaidWindowFunnelDeps,
  candidate: SuggestionCandidate, // source: "donation" | "channel_points"
): Promise<{ queued: true } | { queued: false; reason: "halted" | "rejected" | "held" }> {
  if (deps.mode() === "HALTED") return { queued: false, reason: "halted" };
  const result = await deps.classify(candidate); // the IDENTICAL gate — COMP-01..04
  if (result.decision !== "approved") {
    return { queued: false, reason: result.decision === "held-for-review" ? "held" : "rejected" };
  }
  deps.taskQueue.enqueue(toQueuedTask(candidate, result));
  return { queued: true };
}
```
This requires ONE update to `tests/invariants/single-funnel.test.ts` check (d)'s allowlist: add `"src/pipeline/paid-window.ts"` and `"src/pipeline/chaos.ts"` alongside the existing `"src/pipeline/submit.ts"` / `"src/pipeline/round.ts"` entries. This is the single, deliberate, test-visible extension point — no other invariant file needs to change.

**Anti-pattern to avoid:** Do NOT give `ControlWindow` or the chaos selector direct access to `toQueuedTask`/`TaskQueue.enqueue` — always go through a dedicated `src/pipeline/*.ts` wrapper, even though it is a thin pass-through. The invariant test enforces this structurally (checks (a)/(b)/(d) in `single-funnel.test.ts`), and it is the only mechanism that lets PAID-03 be asserted by a test rather than by code review vigilance.

### Pattern 3: Chaos-Mode Selector

**What:** A pure function taking the CURRENT gate-approved candidate pool (the same `CandidatePool` Phase 2 already gate-filters into) and returning one uniformly-random pick, using `node:crypto.randomInt` (not `Math.random()` — see Alternatives Considered).

```typescript
// src/chaos/selector.ts — the ONLY module permitted to import an RNG (D-08 invariant)
import { randomInt } from "node:crypto";
import type { ApprovedCandidate } from "../queue/pool.js";

/** Uniform pick from an already-gate-filtered pool. Never touches payment/donation state. */
export function pickChaos(pool: ApprovedCandidate[]): ApprovedCandidate | null {
  if (pool.length === 0) return null;
  return pool[randomInt(0, pool.length)] ?? null;
}
```
Toggle-on: `machine.transition("CHAOS_MODE")` (already legal per the Phase 1 transition table); toggle-off reverts to `IDLE`/the vote loop. The selection ITSELF still passes through `pipeline/chaos.ts` → `classify()` — chaos changes WHO gets picked from the pool, never whether the pick still needs to clear the gate a second time is a discretion point (the pool entries are already gate-approved at intake time; re-classifying is optional defense-in-depth, not required by CHAOS-01/02 — recommend re-using the SAME staleness-bound pattern as `round.ts`'s D2-05 rather than skipping classify() entirely, since staleness (pool sat around a while) is a real risk chaos mode shares with the vote path).

### Pattern 4: Paid↔Chaos Separation Invariant (D-08)

**What:** A new `tests/invariants/paid-chaos-separation.test.ts`, structurally identical to `tests/invariants/secrets-isolation.test.ts` (comment-stripped source scan + synthetic self-test proving the scan catches offenders).

**Two independent checks:**
1. **No RNG in the paid/window path:** scan `src/control-window/**/*.ts` and `src/pipeline/paid-window.ts` for `Math\.random|randomInt|randomUUID|crypto\.random` — zero matches allowed.
2. **No payment/donation reference in the chaos path:** scan `src/chaos/**/*.ts` and `src/pipeline/chaos.ts` for `donation|tip|channel_points|StreamElements|redemption` (case-insensitive) — zero matches allowed.

```typescript
// Source: mirrors tests/invariants/secrets-isolation.test.ts structure exactly
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allMatches, collectFiles, type ScannedFile } from "./scan-helpers.js";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const files = collectFiles(SRC_DIR);

const RNG_TOKEN = /Math\.random|randomInt|randomUUID|crypto\.random/;
const PAYMENT_TOKEN = /donation|tip|channel_points|StreamElements|redemption/i;

const paidFiles = files.filter(
  (f) => f.rel.startsWith("src/control-window/") || f.rel === "src/pipeline/paid-window.ts",
);
const chaosFiles = files.filter(
  (f) => f.rel.startsWith("src/chaos/") || f.rel === "src/pipeline/chaos.ts",
);

describe("CHAOS-02 paid<->chaos separation invariant (source scan)", () => {
  it("scans a plausible source tree and includes both governed module sets", () => {
    expect(paidFiles.length).toBeGreaterThan(0);
    expect(chaosFiles.length).toBeGreaterThan(0);
  });

  it("the paid-window path never imports/refers to an RNG", () => {
    const offenders = [...allMatches(paidFiles, RNG_TOKEN).values()].flat();
    expect(offenders, `RNG reference in the paid/guaranteed path (CHAOS-02): ${offenders.join(", ")}`).toHaveLength(0);
  });

  it("the chaos-selection path never subscribes to/references a payment event", () => {
    const offenders = [...allMatches(chaosFiles, PAYMENT_TOKEN).values()].flat();
    expect(offenders, `payment reference in the chaos/random path (CHAOS-02): ${offenders.join(", ")}`).toHaveLength(0);
  });

  it("self-test: catches synthetic offenders", () => {
    const synthetic: ScannedFile[] = [
      { rel: "src/control-window/rogue.ts", stripped: "const x = Math.random();\n" },
      { rel: "src/chaos/rogue.ts", stripped: "socket.on('tip', () => pickChaos());\n" },
    ];
    expect(allMatches(synthetic, RNG_TOKEN).has("src/control-window/rogue.ts")).toBe(true);
    expect(allMatches(synthetic, PAYMENT_TOKEN).has("src/chaos/rogue.ts")).toBe(true);
  });
});
```

### Anti-Patterns to Avoid

- **A single "influence.ts" god-module handling both paid windows and chaos:** defeats D-08's entire purpose — the module boundary IS the enforcement mechanism, not a stylistic preference. Keep `src/control-window/` and `src/chaos/` as genuinely separate directories with no cross-imports.
- **Re-arming a window's expiry timer from `Date.now() + duration` on every process restart:** silently extends a window past its intended budget on a crash-loop. Always derive the remaining time from the PERSISTED `ends_at_ms`, never re-add the full duration.
- **Treating a StreamElements socket disconnect as fatal:** mirrors the exact pitfall Phase 2 already solved for EventSub — log, mark degraded, reconnect with backoff; never crash the whole app because the donation socket dropped mid-stream.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Donation collection + fraud/chargeback handling | A custom Stripe/PayPal donation form + webhook | StreamElements SE.Pay | SE.Pay already provides non-refundable tip charges from the viewer side, chargeback fee coverage, and a maintained wrongful-chargeback blocklist — re-implementing any of this is out of scope and legally risky for a solo-streamer project |
| EventSub session management for channel points | A second, parallel EventSub WebSocket connection | Extend the EXISTING Phase 2 `@twurple/eventsub-ws` session with one more subscription | Twurple's `EventSubWsListener` already manages one session's keepalive/reconnect/resubscribe; a second session is pure duplicated complexity for zero benefit |
| Uniform random selection | A hand-rolled PRNG or `Math.random()`-based shuffle | `node:crypto.randomInt` | Built into Node core, cryptographically uniform, zero new dependency, and its distinct import token is exactly what makes the D-08 source-scan invariant simple and reliable |

**Key insight:** Every "don't hand-roll" item here is really the same lesson twice — this phase's job is almost entirely *wiring existing, already-built machinery* (Phase 1's gate/funnel/veto, Phase 2's EventSub session, StreamElements' own fraud handling) into two new thin state machines. The temptation to build something bespoke here is a red flag that the design has drifted from D-06's "same single funnel" requirement.

## Common Pitfalls

### Pitfall 1: Treating a paid window as a gate exemption
**What goes wrong:** A donor instruction is enqueued directly (bypassing `classify()`) because "they already paid for guaranteed selection."
**Why it happens:** Conflating "guaranteed to be SELECTED next" (what the donation buys) with "guaranteed to be BUILT regardless of content" (what PAID-03 explicitly forbids).
**How to avoid:** The `submitDuringWindow` pattern (Architecture Patterns §2) always calls `classify()` — there is no code path around it. The single-funnel invariant test extension (allowlisting `paid-window.ts`) catches any future shortcut.
**Warning signs:** Any code that constructs a `QueuedTask` or calls `.enqueue()` outside `src/pipeline/`.

### Pitfall 2: Losing or extending a window's time budget on crash/restart
**What goes wrong:** The in-memory expiry timer is lost on a process crash; on restart the window either vanishes silently (donor loses paid time with no record) or gets a fresh full-duration timer (donor gets MORE time than paid for).
**Why it happens:** Treating `ControlWindow` as purely in-memory state, the same trap `RoundManager`'s frozen-timer logic (D2-16) already solved for voting rounds.
**How to avoid:** Persist `ends_at_ms` (an absolute timestamp, not a duration) on window open; on boot, compute `remaining = ends_at_ms - Date.now()` and either close-as-expired (if ≤ 0) or re-arm for exactly that remainder.
**Warning signs:** Any window-duration math computed from `Date.now() + durationMs` anywhere other than the ORIGINAL open event.

### Pitfall 3: Chaos re-classification silently changing the picked task
**What goes wrong:** If chaos mode's picked candidate is re-run through `classify()` (defense-in-depth) and now gets rejected (model drift, or the text became stale), a naive implementation either silently picks again (looks like nothing happened — never-silent violation) or crashes.
**Why it happens:** Treating the "already gate-approved at pool-intake time" guarantee as permanent, when Phase 2's own D2-05 staleness logic proves pool entries can go stale.
**How to avoid:** Mirror `enqueueWinner`'s exact staleness-bound + re-submit pattern — narrate "that pick needs a re-check" rather than silently re-rolling.
**Warning signs:** A chaos pick that never narrates anything when re-classification fails.

### Pitfall 4: Building the paid↔chaos separation invariant as a runtime check instead of a source scan
**What goes wrong:** Someone implements D-08 as a runtime assertion ("throw if a donation event handler calls the RNG") instead of a build/test-time source scan — this only catches the violation if that exact code path executes during a test run, not at commit time, and is far weaker than what "verified in the architecture, not just convention" (Success Criterion 5) actually requires.
**Why it happens:** Runtime assertions feel more "real" than static scans, but the existing codebase's OWN established pattern (single-funnel, secrets-isolation) is deliberately static-scan-based specifically because it catches violations regardless of whether a test happens to exercise that code path.
**How to avoid:** Follow Pattern 4 exactly — a comment-stripped source scan in `tests/invariants/`, run in every `npm test`, with a self-test proving it's sensitive to sabotage (the exact evidence style used in `01-04-SUMMARY.md`'s "Sabotage sensitivity proof").
**Warning signs:** D-08's test lives anywhere other than `tests/invariants/`.

## Code Examples

### 1. StreamElements realtime socket connection + `tip` event (injected-fake seam)

```typescript
// Source: StreamElements/api-docs Websockets.md (github.com/StreamElements/api-docs/blob/main/docs/Websockets.md)
// via WebFetch, 2026-07-10 — connection URL, transport, and authenticate handshake confirmed
// directly from StreamElements' own docs repo.
import { io, type Socket } from "socket.io-client";
import { z } from "zod";

const TipEventSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  message: z.string(),
  tipId: z.string(),
});
export type TipEvent = z.infer<typeof TipEventSchema>;

/** Injected seam — mirrors twitch-chat.ts's ChatEventSource pattern for testability. */
export interface DonationEventSource {
  onTip(handler: (tip: TipEvent) => void): void;
  onDisconnect(handler: () => void): void;
  onReady(handler: () => void): void;
}

/** Production adapter — never imported statically outside the entrypoint (dynamic import). */
export function connectStreamElements(jwt: string): DonationEventSource {
  const socket: Socket = io("https://realtime.streamelements.com", { transports: ["websocket"] });
  socket.on("connect", () => socket.emit("authenticate", { method: "jwt", token: jwt }));

  const tipHandlers: Array<(tip: TipEvent) => void> = [];
  socket.on("event", (raw: unknown) => {
    // StreamElements wraps activity by `type`; only "tip" is in scope for PAID-01.
    const parsed = z
      .object({ type: z.literal("tip"), data: TipEventSchema })
      .safeParse(raw);
    if (!parsed.success) return; // non-tip event or malformed — never throw into the socket handler
    for (const h of tipHandlers) h(parsed.data.data);
  });

  return {
    onTip: (h) => tipHandlers.push(h),
    onDisconnect: (h) => socket.on("disconnect", h),
    onReady: (h) => socket.on("connect", h),
  };
}
```

### 2. EventSub channel-points redemption subscription (extends Phase 2's listener)

```typescript
// Source: dev.twitch.tv/docs/eventsub/eventsub-subscription-types (fetched 2026-07-10)
// Subscription type: channel.channel_points_custom_reward_redemption.add, version "1"
// Required scope: channel:read:redemptions (broadcaster-scoped — Phase 2's TWITCH_SCOPES
// currently has only user:read:chat/user:write:chat; this scope MUST be added and the
// broadcaster must re-authorize at /auth/start once this phase ships — see Open Questions).
const RedemptionEventSchema = z.object({
  id: z.string(),
  broadcaster_user_id: z.string(),
  user_id: z.string(),
  user_login: z.string(),
  user_name: z.string(),
  user_input: z.string(),
  status: z.string(),
  reward: z.object({ id: z.string(), title: z.string(), cost: z.number() }),
  redeemed_at: z.string(),
});

// Registered the same way Phase 2 registers its chat-message subscription — one more
// listener.onSubscription-style call on the EXISTING EventSubWsListener session, not a
// new session/connection.
```

### 3. Faked-seam shape for injected tests (mirrors Phase 3's injected-fakes discipline)

```typescript
// tests can construct a fake DonationEventSource / redemption source with zero network:
const fakeDonationSource: DonationEventSource = {
  onTip: (h) => { queueMicrotask(() => h({ username: "viewer1", displayName: "Viewer1", amount: 5, currency: "USD", message: "build a slot machine", tipId: "abc123" })); },
  onDisconnect: () => {},
  onReady: (h) => h(),
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Twitch PubSub for channel-points redemption events | EventSub WebSocket (`channel.channel_points_custom_reward_redemption.add`) | PubSub retired April 2025 (already reflected in CLAUDE.md "What NOT to Use") | No impact on this research — Phase 2 already committed to EventSub; this phase simply adds one more subscription to the existing session |
| Bits as a general-purpose "pay for X" mechanic (pre-2018 era patterns still findable in old tutorials) | Twitch's current Bits AUP explicitly restricts Bits to Twitch-native interactions only, with a documented 2026-era tightening pass and a forfeiture clause for violations | Twitch updated the Bits AUP for the first time since 2018 (per community reporting cross-referenced against the current legal.twitch.com policy page) | Reinforces (does not merely maintain) the existing "Bits rejected outright" decision — this is now a stricter, more explicitly enforced policy than it was at the project's design time, not a stable status quo |

**Deprecated/outdated:** Twitch PubSub (retired, do not reference even old tutorials); Bits-for-services patterns from pre-2018-era streaming tutorials (explicitly prohibited under the current, tightened AUP).

## Research Question Answers

### 1. Donation platform — StreamElements vs Streamlabs (re-verification)

**Answer:** StreamElements remains correct and should be LOCKED, not left as an open recommendation.

- **Connection:** `https://realtime.streamelements.com`, Socket.IO-compatible client (`socket.io-client`, confirmed working with the v2.2.0-protocol server per StreamElements' own docs example — the modern `socket.io-client@4.8.3` package remains protocol-compatible for this connection style), `transports: ["websocket"]`. [CITED: github.com/StreamElements/api-docs/blob/main/docs/Websockets.md — fetched directly, 2026-07-10]
- **Auth:** `socket.emit("authenticate", { method: "jwt", token })` (JWT obtained from the streamer's own StreamElements dashboard — a one-time setup step, same posture as Phase 2's Twitch OAuth bootstrap). JWT tokens reportedly rotate roughly every 2 weeks, requiring the streamer to re-fetch periodically — **this is a MEDIUM-confidence claim** [CITED via WebSearch summary of streamelements docs/community sources — not independently confirmed against the primary JWT-lifecycle doc in this session; flag for the streamer to verify at setup time].
- **`tip` event shape:** `{ username, displayName, amount, currency, message, avatar, tipId }` nested under a `data` field, with a `type: "tip"` discriminator at the envelope level. [CITED: github.com/StreamElements/api-docs/blob/main/docs/Websockets.md]
- **No desktop client required:** confirmed — the realtime socket connection is a pure cloud-to-cloud WebSocket; nothing in StreamElements' own docs mentions a desktop app (OBS.Live) as a prerequisite for receiving `tip` events over this channel. [CITED: same source; corroborates CLAUDE.md's existing claim]
- **Streamlabs comparison:** Streamlabs' own Socket API (`sockets.streamlabs.com`, also `socket.io`-based, token-authenticated via a dashboard-issued Socket API Token) is architecturally similar and ALSO does not strictly require the Streamlabs desktop app for the raw socket connection. [CITED: dev.streamlabs.com/docs/socket-api, WebSearch-summarized — MEDIUM confidence, not independently WebFetch-verified in this session]. The deciding factor remains ecosystem fit, not a hard technical blocker: StreamElements' SE.Pay tipping path directly resolves the chargeback question (see Q3) with a documented no-chargeback-to-streamer guarantee that Streamlabs' generic donation-processor pass-through does not appear to offer in the same explicit way.

**Confidence:** MEDIUM-HIGH. The connection/auth/event-shape claims are CITED against StreamElements' own official docs repo (fetched directly). The JWT-rotation-cadence and Streamlabs-desktop-independence claims are WebSearch-summarized and not independently primary-source-verified — flagged for streamer confirmation at the live-checkpoint gate, consistent with how Phase 2 handled its own OAuth bootstrap.

### 2. Bits / Channel-Points AUP re-verification

**Answer — Bits must NOT be a paid-influence trigger, confirmed:**

Twitch's Bits Acceptable Use Policy (`legal.twitch.com/en/legal/bits-acceptable-use/`) prohibits, in language located via WebSearch and cross-checked against multiple independent citations of the same policy: **"users may not offer to exchange Bits for experiences off of Twitch or for goods or services that typically have a monetary cost or value"**, and separately: **"Selling, offering to sell, trading, bartering, or transferring Bits to anyone in exchange for (a) real or virtual currencies; or (b) any other items of value whether on or off Twitch is prohibited,"** with enforcement stating **"Any attempted prohibited sale or transfer will be null and void and may result in forfeiture of all Bits without compensation."** A donor-directed live-build session is precisely an "experience off of Twitch" / "service that typically has a monetary cost" (a custom software build) — using Bits as the trigger would be a direct AUP violation, not merely a cautious inference. This confirms and strengthens the existing REQUIREMENTS.md "Out of Scope: Bits-funded free reign" decision. [CITED: legal.twitch.com/en/legal/bits-acceptable-use/, quotes located via WebSearch cross-referencing the current policy page — the WebFetch tool could not retrieve the full policy body directly in this session (returned only nav chrome), so these are WebSearch-sourced quotes attributed to the primary URL, not a direct WebFetch capture. **Recommend a manual read of the live page before this becomes a public-facing compliance claim.**]

**Answer — Channel-points redemptions are compliant for a non-monetary influence window:** Yes. `channel.channel_points_custom_reward_redemption.add` is Twitch's own first-party EventSub mechanism specifically for broadcaster-defined custom rewards redeemed with channel points (a non-monetary, platform-native currency earned by watching/engagement) — there is no AUP analog restricting how a broadcaster uses their own custom-reward redemption data; this is exactly the "native Twitch interaction" category the tightened Bits AUP explicitly contrasts itself against. [CITED: dev.twitch.tv/docs/eventsub/eventsub-subscription-types — fetched directly, 2026-07-10]

**Confidence:** Bits prohibition — MEDIUM-HIGH (verbatim-quoted policy language, but sourced via WebSearch summarization rather than a direct full-page WebFetch capture in this session; the underlying URL is authoritative and unambiguous in intent even if not independently re-fetched word-for-word here). Channel-points compliance — HIGH (directly fetched from Twitch's own current developer docs, and it's an affirmative "this is what the feature is for" claim rather than a negative "X is not possible" claim, which carries lower verification risk per this agent's own pitfall-avoidance protocol).

### 3. Chargeback / refund handling

**Answer:** For the recommended platform (StreamElements SE.Pay), tip charges are **non-refundable and cannot be withdrawn or charged back by the viewer**; any legitimate refund request goes through StreamElements support directly (email), not an automatic viewer-initiated flow, and StreamElements maintains an internal wrongful-chargeback blocklist plus fee coverage for the rare fraud case. [CITED: support.streamelements.com/hc/en-us/articles/10474710869394-Tipping-Overview, support.streamelements.com/hc/en-us/articles/10474426240914-SE-Pay-Overview, blog.streamelements.com's chargeback-protection post — all via WebSearch summary, MEDIUM confidence, not independently WebFetch-verified against the primary support articles in this session]

**Does a refund/chargeback emit an event or require polling?** Not found in the publicly available StreamElements developer docs surfaced by this research — there is no documented webhook/socket event for a POST-HOC tip reversal. This is a genuine gap, not a "didn't look hard enough" gap: the search specifically targeted "chargeback webhook event" and found policy/support pages but no API reference for a reversal event type.

**Recommended MVP disposition:** **Do not build a retroactive window-annul path.** Rationale: (1) SE.Pay tips are structurally non-refundable from the viewer side — the chargeback attack surface StreamElements' own product exists to absorb is a StreamElements↔payment-processor dispute, not a live-show integrity problem; (2) even in the rare fraud case, ControlWindows are SHORT (30s–5min per Pattern 1's MVP defaults) and TIME-BOXED — by the time any chargeback dispute could even be filed/processed, the window has long since closed and its build output is already live on stream; retroactively "un-building" something is not a sensible operation regardless of payment status; (3) PAID-04's actual requirement is amount→duration LOGGING (an audit-trail requirement, fully satisfiable by the `control_windows` table in Pattern 1), not chargeback reconciliation. This matches CONTEXT.md's own Deferred Ideas framing ("unless research deems it compliance-critical" — it is not).

**Confidence:** MEDIUM. The "no refund/chargeback event exists" claim is a negative claim (see this agent's own pitfall-avoidance protocol) — flagged accordingly. If StreamElements ships a chargeback webhook in the future, this disposition should be revisited, but for MVP the time-boxing argument holds regardless of whether such an event exists.

### 4. EventSub channel-points redemption — subscription details

**Answer:**
- **Subscription type:** `channel.channel_points_custom_reward_redemption.add`, version `"1"`. [CITED: dev.twitch.tv/docs/eventsub/eventsub-subscription-types, fetched directly 2026-07-10]
- **Required scope:** `channel:read:redemptions` — a BROADCASTER-scoped user-access-token scope. [CITED: same source, cross-checked against community developer-forum threads confirming broadcaster-only restriction]
- **Does Phase 2's token already cover it?** **No — this requires a scope addition.** Phase 2's `twitch-auth.ts` currently sets `TWITCH_SCOPES = ["user:read:chat", "user:write:chat"]` only (per `02-02-SUMMARY.md`). `channel:read:redemptions` is a DIFFERENT scope not currently requested. The broadcaster will need to re-authorize (revisit `/auth/start`) once this scope is added to `TWITCH_SCOPES`, generating a new token with the expanded scope set. This does NOT require a second `RefreshingAuthProvider`/second account (CONTEXT.md's "no new auth surface beyond what Phase 2 established" holds in spirit — same broadcaster token, same OAuth flow, just a broader scope grant) — but it is NOT a zero-touch reuse of the existing token as CONTEXT.md's D-02 phrasing might imply at first read. **This is a planning-relevant correction, flagged in Open Questions below.**
- **Condition fields:** `broadcaster_user_id` (required), `reward_id` (optional — omit to receive ALL custom-reward redemptions on the channel, which is almost certainly what this phase wants for a single "free-reign" reward plus possibly other rewards). [CITED: dev.twitch.tv/docs/eventsub/eventsub-subscription-types]
- **Payload shape:** `{ id, broadcaster_user_id, broadcaster_user_login, broadcaster_user_name, user_id, user_login, user_name, user_input, status, reward: { id, title, cost, prompt, ... }, redeemed_at }`. [CITED: same source] — `user_input` is the free-text field a redeemer can attach (if the custom reward is configured to require text), directly analogous to a chat `!suggest` body for the redemption path.

**Confidence:** HIGH for the subscription type/scope/payload shape (directly fetched from Twitch's current official docs). HIGH for the "scope not currently granted" finding (directly cross-referenced against the actual `02-02-SUMMARY.md` artifact in this codebase, not an assumption).

### 5. Sweepstakes-law separation (CHAOS-02, D-08) — architecture patterns

**Answer:** See Architecture Patterns §4 above for the concrete, implementation-ready test design (mirrors `secrets-isolation.test.ts` exactly: two independent comment-stripped source scans + a sabotage self-test).

On the "no consideration + no chance" legal grounding referenced in the research brief: this research did **not** find (and did not exhaustively search for) a specific, citable legal-authority source on illegal-lottery/sweepstakes elements ("prize + chance + consideration") tailored to a livestream-build-selection context — this is a general contest-law principle (widely known as the three elements of an illegal lottery in US law: prize, chance, and consideration) but this research session did not verify it against a primary legal source, and it is NOT something a source-scan test can enforce on its own (the test enforces the ARCHITECTURAL separation; it cannot certify legal sufficiency). **[ASSUMED — the "prize/chance/consideration" framing is general knowledge, not sourced in this session; if the streamer wants a hard compliance sign-off on the sweepstakes-law question specifically (as opposed to the architectural separation CHAOS-02 actually asks for), that is a distinct, out-of-scope-for-this-research legal-consultation item.]** What IS in scope and IS resolved: CHAOS-02's literal text is "no chance element is ever attached to payment... verified in the architecture, not just convention" — Pattern 4 delivers exactly that architectural verification, independent of the broader legal question.

**Confidence:** HIGH for the architecture/test-design recommendation (directly extends an already-proven, already-shipped codebase pattern). LOW/unverified for any claim about sweepstakes-law sufficiency beyond the architectural separation itself — flagged as a distinct legal question, not conflated with the (resolved) engineering question.

### 6. ControlWindow state machine — design recommendation

**Answer:** See Architecture Patterns §1 (state shape, persistence schema, restore-on-boot logic) and §2 (funnel re-entry). Summary of the concrete recommendation:
- **States:** `open → active → (expiry | revoke) → closed` (4 states — simpler than `StreamModeMachine`'s 6, same hand-rolled rationale: not worth a state-machine library).
- **Drives the EXISTING `StreamModeMachine`:** window activation = `machine.transition("FREE_REIGN_WINDOW")` (already a legal `IDLE`-sourced transition per `stream-mode.ts:28`); close/expire/revoke = `machine.transition("IDLE")` (already legal per `stream-mode.ts:31`). No changes needed to `stream-mode.ts`'s transition table — Phase 1 already anticipated this.
- **Persistence:** new `control_windows` table (schema in Pattern 1), following the EXACT durability discipline of `rounds`/`round_candidates` — an absolute `ends_at_ms` timestamp (never a re-computed duration) is the crash-safety linchpin.
- **Amount→duration:** pure function (Pattern 1's `amountToDurationSeconds`), config-driven constants, unit-testable in isolation from any I/O.
- **Re-entry into the single funnel:** `src/pipeline/paid-window.ts` (Pattern 2) — a new, narrow, invariant-allowlisted funnel entry point, structurally identical to `round.ts`'s `enqueueWinner`.

**Confidence:** HIGH — this is a direct, low-risk extension of patterns already proven and shipped in this exact codebase (Phase 1's `StreamModeMachine`, Phase 2's `RoundManager`/`enqueueWinner`), not a novel design.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Specific amount→duration constants ($5≈60s, 30s floor, 300s cap) | Architecture Patterns §1 | Low — explicitly marked as Claude's-discretion config defaults, streamer-tunable before launch; wrong defaults are a config edit, not an architecture change |
| A2 | StreamElements JWT tokens rotate roughly every 2 weeks | Research Question 1 | Low-medium — if wrong, the token-refresh cadence assumption in operator setup docs needs correction; does not affect the architecture (the socket wrapper already treats auth failure as a disconnect-and-retry case) |
| A3 | Streamlabs Socket API does not strictly require the desktop client for the raw socket connection | Research Question 1 / Alternatives Considered | Low — StreamElements is the locked recommendation regardless; this claim only matters if Streamlabs is reconsidered later |
| A4 | No StreamElements webhook/event exists for tip refund/chargeback (negative claim) | Research Question 3 | Medium — if a chargeback event DOES exist and is discovered later, the "no retroactive annul needed" MVP disposition would need re-examination, though the time-boxing argument likely still holds |
| A5 | "Prize + chance + consideration" is the correct general framing for sweepstakes-law risk in this context | Research Question 5 | Medium — this is general knowledge, not verified against a primary legal source in this session; if the streamer wants a formal compliance opinion on chaos-mode/paid-window separation as a LEGAL (not just architectural) matter, that requires actual legal consultation, out of scope for this research |
| A6 | Verbatim Bits AUP quotes are accurately attributed (WebSearch-sourced, not directly WebFetched from the live page in this session) | Research Question 2 | Medium — recommend a manual confirmation read of legal.twitch.com/en/legal/bits-acceptable-use/ before treating these quotes as load-bearing in any public-facing compliance documentation |

## Open Questions

1. **`TWITCH_SCOPES` must be extended with `channel:read:redemptions`, requiring broadcaster re-authorization**
   - What we know: Phase 2's `twitch-auth.ts` currently requests only `user:read:chat`/`user:write:chat`. The channel-points EventSub subscription needs the additional `channel:read:redemptions` scope.
   - What's unclear: Whether the planner should treat this as a Phase 4 task (add the scope, prompt the streamer to revisit `/auth/start`) or flag it purely as a "User Setup Required" note like Phase 2's own OAuth bootstrap did.
   - Recommendation: Treat as an explicit Phase 4 task — extend `TWITCH_SCOPES`, document the required re-auth step in the phase's operator setup notes (mirrors the existing `02-04-SUMMARY.md` "User Setup Required" pattern), and have the console's existing Twitch-connection pill surface a "needs re-auth for channel points" state if feasible, rather than silently having the subscription fail.

2. **StreamElements account/JWT setup is a live-checkpoint gate, not something this research can close**
   - What we know: The technical integration is fully specifiable against injected fakes (per D-10's testing discipline).
   - What's unclear: The actual StreamElements account, JWT token, and (if using SE.Pay) payment-processor setup are streamer-side account actions outside this research's scope — same posture as Phase 2's Twitch app registration.
   - Recommendation: The planner should create a deferred "User Setup Required" / live-smoke-test checkpoint for StreamElements account creation + JWT retrieval + a real $1 test tip, batched with the other end-of-project live gates per D-10's own framing (mirrors Phase 3's Wave 0 and Phase 2's live-OAuth checkpoint pattern).

3. **Whether chaos-picked candidates should be re-classified before enqueue (staleness defense-in-depth)**
   - What we know: Round winners already have a staleness bound (D2-05, `WINNER_STALENESS_MINUTES`). Chaos picks draw from the same kind of pool.
   - What's unclear: Whether CHAOS-01/02 requires this defense-in-depth or whether a simpler "always re-classify, no staleness check" (paying the Sonnet-call cost every chaos pick) is acceptable given "minimal LLM/agent work" (D-09) for this phase.
   - Recommendation: Reuse `enqueueWinner`'s exact staleness-bound pattern (cheap, already-proven) rather than inventing a new policy — flagged for the planner to confirm during task breakdown, not a blocker.

4. **Whether a single custom channel-points reward or multiple rewards map to PAID-02**
   - What we know: The EventSub subscription can filter by `reward_id` (optional) or receive all redemptions channel-wide.
   - What's unclear: Whether the streamer wants exactly ONE dedicated "micro free-reign" reward, or multiple reward tiers.
   - Recommendation: Default to a single dedicated reward for MVP (simplest amount→duration mapping — treat `reward.cost` as the "amount" input to the SAME `amountToDurationSeconds` function used for donations, with its own separate, smaller-scale config constants) — Claude's discretion per CONTEXT.md, flagged here so the planner makes it an explicit task rather than an implicit assumption.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `socket.io-client` (npm package) | PAID-01 donation ingestion | ✓ (not yet installed, but registry-available) | 4.8.3 | — |
| StreamElements account + JWT | PAID-01 donation ingestion (live) | ✗ (streamer account setup not yet done) | — | Injected-fake `DonationEventSource` covers all dev/test work (D-10); live account creation is a deferred human gate, not a blocker to development |
| Twitch broadcaster token with `channel:read:redemptions` scope | PAID-02 channel-points ingestion (live) | ✗ (Phase 2 token lacks this scope) | — | Injected-fake redemption events cover dev/test; re-auth is a deferred human gate (Open Question 1) |
| `@twurple/eventsub-ws`, `better-sqlite3`, `zod` | Core Phase 4 wiring | ✓ | 8.1.4 / 12.11.0 / ^4 (already installed) | — |
| `node:crypto` | CHAOS-01 random selection | ✓ (Node 24 built-in) | Node 24.x | — |

**Missing dependencies with no fallback:** none — every live-platform dependency has a documented injected-fake fallback for development, matching Phase 3's discipline (D-10).

**Missing dependencies with fallback:** StreamElements account/JWT (fallback: fakes for dev, deferred live checkpoint); channel-points redemption scope (fallback: fakes for dev, deferred re-auth + live checkpoint).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Yes | StreamElements JWT stored/handled the same way Phase 2 handles the Twitch token — server-side only, never logged (mirror `twitch-auth.ts`'s capturing-logger test for token values), file persistence with restrictive mode |
| V3 Session Management | No | No new session concept — the donation socket and EventSub session are long-lived server-to-server connections, not user sessions |
| V4 Access Control | Yes | Console routes to revoke a window / toggle chaos mode reuse the EXISTING uniform CSRF middleware (Origin+Content-Type enforcement) already applied to all state-changing console routes (Phase 1 D-XX pattern) — no new access-control mechanism to design |
| V5 Input Validation | Yes | `zod` `safeParse` at EVERY external boundary: StreamElements `tip` payload, EventSub redemption payload, donor/redeemer `user_input` text — mirrors `twitch-chat.ts`'s exact pattern |
| V6 Cryptography | Yes | `node:crypto.randomInt` for chaos selection (never hand-rolled, never `Math.random()`) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Malformed/adversarial StreamElements or EventSub payload crashing the ingestion handler | DoS | `zod.safeParse` + try/catch around the whole handler, exactly mirroring `twitch-chat.ts`'s existing pattern — malformed payloads logged, never fatal |
| Donor `message`/redemption `user_input` text used as an agent instruction without gate re-screening | Elevation of Privilege | The SAME `classify()` call every other candidate source uses (D-06) — no exemption path exists structurally |
| A donation/redemption arriving mid-window bypassing the one-window/cooldown rule via a race | Tampering | `ControlWindow` FSM must check-then-transition atomically (single-threaded Node event loop already gives this for free as long as no `await` sits between the check and the state write — flag this as an explicit implementation-review point, not merely "the event loop handles it") |
| Chaos-mode RNG seeded/predictable, or a future refactor accidentally wiring a donation event into the chaos selector | Tampering (fairness) | The D-08 source-scan invariant (Pattern 4) — catches the accidental-wiring case at test time; `node:crypto.randomInt` (not `Math.random()`) addresses seedability |
| Overlay/console leaking a donor's full identity/message text on the public broadcast surface | Information Disclosure | Follow the Phase 3 `BuildStatusView` precedent (T-03-16): the public overlay carries ONLY a coarse view (e.g. truncated donor handle + countdown), never the full donation message/rationale — a discretion item flagged for the UI-SPEC pass, not this research, but the PATTERN (narrow public projection) is established and should be reused, not redesigned |

## Sources

### Primary (HIGH confidence)
- github.com/StreamElements/api-docs/blob/main/docs/Websockets.md — fetched directly via WebFetch, 2026-07-10: connection URL, transport, JWT/OAuth2 `authenticate` handshake, `tip` event field shape, no-desktop-client confirmation
- dev.twitch.tv/docs/eventsub/eventsub-subscription-types — fetched directly via WebFetch, 2026-07-10: `channel.channel_points_custom_reward_redemption.add` v1, `channel:read:redemptions` scope, condition fields, payload shape
- npm registry (`npm view socket.io-client version`) — confirmed `4.8.3` current, 2026-07-10
- slopcheck CLI (`slopcheck install socket.io-client`) — `[OK]` verdict, 2026-07-10
- This codebase directly: `src/shared/types.ts`, `src/state-machine/stream-mode.ts`, `src/pipeline/round.ts`, `src/pipeline/submit.ts`, `src/compliance/gate.ts`, `src/kill-switch/abort.ts`, `src/audit/record.ts`, `src/audit/schema.sql`, `tests/invariants/single-funnel.test.ts`, `tests/invariants/secrets-isolation.test.ts`, `package.json`, `.planning/phases/02-chat-vote-loop/02-02-SUMMARY.md`, `.planning/phases/02-chat-vote-loop/02-04-SUMMARY.md`, `.planning/phases/01-compliance-gate-kill-switch/01-04-SUMMARY.md`, `.planning/phases/03-sandboxed-build-engine-live-show/03-SECURITY.md`, `.planning/phases/03-sandboxed-build-engine-live-show/03-UI-SPEC.md` — all read directly in this session

### Secondary (MEDIUM confidence)
- WebSearch-summarized verbatim quotes from legal.twitch.com/en/legal/bits-acceptable-use/ (direct WebFetch of the page returned only navigation chrome, not policy body text — quotes attributed via WebSearch cross-referencing)
- WebSearch summary of support.streamelements.com Tipping Overview / SE.Pay Overview / chargeback-protection blog post (non-refundable tips, chargeback fee coverage) — not independently WebFetch-verified against the primary support articles
- WebSearch summary of dev.streamlabs.com/docs/socket-api (Streamlabs Socket API connection details, no explicit desktop-client requirement found) — not independently WebFetch-verified

### Tertiary (LOW confidence)
- StreamElements JWT ~2-week rotation cadence — WebSearch-summarized from community/third-party sources (content-creator-integration.readthedocs.io, support forum threads), not a primary StreamElements doc quote
- "Prize + chance + consideration" sweepstakes-law framing — general training-data knowledge, not sourced/verified in this session; flagged as a distinct legal question from the (resolved) architectural CHAOS-02 requirement

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies beyond the already-CLAUDE.md-recommended `socket.io-client`, version-verified against the npm registry and slopcheck
- Architecture: HIGH — every pattern is a direct, low-risk extension of already-shipped, already-proven patterns in this exact codebase (StreamModeMachine, RoundManager, single-funnel invariant, secrets-isolation invariant)
- Pitfalls: HIGH — derived directly from this codebase's own documented pitfalls (D2-05 staleness, D2-16 frozen timers, never-silent doctrine) rather than generic donation/chaos-mode folklore
- Platform/AUP research questions (1-4): MEDIUM-HIGH — primary-source-verified for EventSub and StreamElements' own docs repo; MEDIUM for the Bits AUP verbatim quotes and chargeback-policy details (WebSearch-summarized, not independently WebFetched in this session)
- Legal sufficiency of sweepstakes-law separation (question 5, beyond the architectural requirement): LOW — explicitly out of scope for engineering research, flagged for the streamer/legal consultation if a formal opinion is wanted

**Research date:** 2026-07-10
**Valid until:** ~30 days for the architecture/codebase-pattern content (stable); ~14 days for the StreamElements/Streamlabs/Bits-AUP platform claims specifically (fast-moving policy area — the Bits AUP was reportedly just tightened; re-verify the verbatim quotes with a direct page read before treating them as load-bearing in any public compliance documentation)
