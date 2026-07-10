# Phase 4: Paid Influence & Chaos Mode - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.
> **Mode: --auto** — no user present; Claude selected recommended defaults grounded in ROADMAP.md + CLAUDE.md + prior-phase decisions. The donation-platform choice (D-01) was deliberately NOT auto-locked because the roadmap flags it as MEDIUM-confidence and mandates a research pass. Review CONTEXT.md and override before planning if desired.

**Date:** 2026-07-10
**Phase:** 04-paid-influence-chaos-mode
**Areas discussed:** Donation platform & ingestion, Control-window model, Amount→duration mapping, Chaos mode & paid↔chaos separation, Concurrency/precedence, Dependency posture on Phase 3 Wave 0

---

## Donation platform & event ingestion (D-01, D-02)

| Option | Description | Selected |
|--------|-------------|----------|
| StreamElements | Cloud-only realtime websocket (`socket.io-client`), no desktop client on the streaming machine; `tip` events | ✓ (auto, **recommended — NOT locked**, pending research) |
| Streamlabs | Socket API but historically expects the Streamlabs desktop client running — extra process on an already-loaded machine | (research to re-verify) |
| Twitch Bits | — | ✗ rejected (Bits AUP risk — CLAUDE.md "What NOT to Use") |

**Auto-selection rationale:** CLAUDE.md recommends StreamElements; the roadmap mandates `--research-phase 4` to re-verify vs Streamlabs, re-verify verbatim Bits/Channel-Points AUP, and settle chargeback handling. Recorded as recommendation, not a lock (mirrors Phase 3's un-locked sandbox spike). Channel-points trigger = native EventSub redemption on the existing broadcaster token.

---

## Control-window model (D-03, D-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Single ControlWindow machine for donation + channel-points | One open→active→expiry/revoke lifecycle, both route through the existing single funnel + gate + veto | ✓ (auto) |
| Two parallel mechanisms | Duplicates lifecycle + funnel; more surface, more drift | |

---

## Amount→duration mapping & concurrency (D-04, D-05)

| Option | Description | Selected |
|--------|-------------|----------|
| Linear-with-cap + per-donor cooldown, one active window at a time | Bounded windows, no monopolisation, mirrors build concurrency-1; constants streamer-tunable | ✓ (auto) |
| Uncapped/proportional, stacking windows | Unbounded show takeover; overlap chaos | |

**Precedence locked:** active paid window > chaos > normal vote; a window arriving during another is queued-behind-cooldown or dropped-with-feedback (never silent).

---

## Chaos mode & paid↔chaos separation (D-07, D-08)

| Option | Description | Selected |
|--------|-------------|----------|
| Toggle swaps selection strategy (vote → uniform-random from filtered pool); machine-enforced separation from paid | RNG confined to the free/vote selection layer; paid path provably imports no RNG; chaos path subscribes to no payment event — verified by a source-scan test | ✓ (auto) |
| Convention-only separation | Fails success-criterion 5 ("verified in architecture, not just convention") | |

---

## Dependency posture on Phase 3 Wave 0 (D-10)

| Option | Description | Selected |
|--------|-------------|----------|
| Build Phase 4 against injected fakes now; batch all human gates at end | Paid/chaos live at the selection/gate/window layer, untouched by the sandbox adapter; a later Wave 0 NO-GO (→ Docker) does not ripple in | ✓ (auto — per user request to start Phase 4 and defer human-gated work) |
| Block Phase 4 until Wave 0 GO | Unnecessary — no code dependency; would stall reversible work behind a hands-on gate | |

---

## Claude's Discretion

Exact amount→duration/cap/cooldown constants; ControlWindow schema + overlay presentation (under Phase 3 UI-SPEC discipline); transient-vs-terminal donation-socket-drop handling (reuse EventSub reconnect discipline).

## Deferred Ideas

- Chargeback/refund retroactive window annulment (research question, likely post-MVP hardening)
- Tiered donation perks / multi-window queueing / donor leaderboards (new capabilities)
- Bot-account token split for paid-window rate limit/badge (single-broadcaster-token default)
- Persistent cross-stream changelog of paid/chaos builds (Phase 5, HIST-01)
