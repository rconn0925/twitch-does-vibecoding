# Deferred Items — quick-260711-rs3 (Chaos Mode)

## 1. Theoretical synchronous restart recursion: chaos "empty" outcome vs pool-full early close

**Where:** `src/state-machine/auto-cycle.ts` `#onPhaseEnd` chaos hook + `#maybeEarlyClose` (quick-l2a).

**Scenario (currently unreachable in production):** if the pool ever held ≥ `EARLY_CLOSE_POOL_SIZE`
candidates that are ALL chaos-ineligible (non-chat/operator sources) while the chat-chaos window is
live, the sequence `"empty" → #maybeBegin("restart") → #beginSuggestPhase → #maybeEarlyClose (pool
still ≥ cap) → #onPhaseEnd → "empty" → …` would recurse synchronously without bound.

**Why it is unreachable today:** the CandidatePool only ever receives candidates via
`submitCandidate` (chat/operator paths); paid-window instructions go queue-direct via
`submitDuringWindow` and never touch the pool. So an eligible-empty pool is always an actually
empty (or sub-cap) pool, and `#maybeEarlyClose`'s `pool.size() < max(cap, 2)` guard breaks the loop.

**Action if a paid-source→pool path is ever added:** add a depth/park guard to the chaos "empty"
restart (or make `#maybeEarlyClose` skip a phase begun by a chaos-owned restart in the same tick).

## 2. Pre-existing scheduler stall after control-window close (FIXED in this task, main.ts-level)

Recorded for visibility: `ControlWindow.revoke()`/`#expire()` transition FREE_REIGN_WINDOW→IDLE
BEFORE nulling `#window`, so the AutoCycleScheduler's STATE_CHANGED resume check saw a live window
and stayed parked after a revoke (revoked windows keep a future `endsAtMs`). Fixed at the
composition root (main.ts subscribes WINDOW_CLOSED/WINDOW_REVOKED → `autoCycle.start()` poke).
A root-cause reorder inside control-window.ts (null `#window` before the transition) was NOT done —
that file is outside this task's scope. Consider it if control-window.ts is ever touched again.
