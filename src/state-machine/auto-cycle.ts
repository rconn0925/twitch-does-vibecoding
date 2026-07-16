/**
 * AutoCycleScheduler — the hands-free round cadence (quick-t5k D-01..D-04, A1).
 *
 * Repeats [suggestPhaseMs suggestion window] → startRound("auto") → (voting
 * runs on ROUND_DURATION_SECONDS inside RoundManager) → on ROUND_CLOSED the
 * next suggestion window begins IMMEDIATELY.
 *
 * Vote-waits-for-build (quick-260716-fdl, DEFAULT ON): while a build is in
 * progress, a suggest phase that ends does NOT open a vote round — the
 * scheduler parks in a "waiting" state (no timer; purely event-driven) and the
 * parked vote opens against the warm pool the moment the machine returns to
 * IDLE (any terminal: done / failed-resolved / refused-resolved / veto /
 * halt-recover). !suggest intake keeps pooling during the wait (intake is not
 * scheduler-gated). Build queue depth naturally stays ~1 in this mode.
 *
 * With voteWaitsForBuild=false (VOTE_WAITS_FOR_BUILD="false" exact string) the
 * original A1 pipelining is restored byte-identically: the cadence never waits
 * for a build — winners queue and builds drain serially via main.ts
 * drainVoteQueue, governed by VOTE_QUEUE_MAX / isVoteQueueFull below (that
 * machinery is fully preserved for pipelining mode; do not remove it).
 *
 * Entirely event-driven: ONE unref'd setTimeout per suggestion phase, plus
 * STATE_CHANGED / HALT_TRIGGERED / ROUND_CLOSED subscriptions. Zero polling —
 * no repeating interval timer exists in this module (source-scan enforced).
 *
 * Safety posture:
 *  - HALT_TRIGGERED cancels the pending timer synchronously; NOTHING fires
 *    while HALTED (D-04 ethos: the kill switch parks the whole cadence).
 *  - Recovery returns to the toggle's current setting via the STATE_CHANGED
 *    subscription — the streamer's enabled/paused choice survives a halt.
 *  - Free-reign windows and chaos mode defer the cycle (they own the show);
 *    the cycle resumes on the STATE_CHANGED that returns the loop to IDLE.
 *  - VOTE_QUEUE_MAX (user amendment): a full vote-winner queue defers the next
 *    suggestion phase — never mint winners that can't be honored. One
 *    buildQueueFull narration beat per park; the cycle resumes on the first
 *    STATE_CHANGED after the queue drains below the cap. Manual round starts
 *    are NOT capped (operator override goes through the console route).
 *  - Pool-full early close (quick-l2a): when the OPTIONAL pool dep is wired
 *    and the pool reaches earlyCloseSize mid-suggest-phase, the phase ends
 *    NOW — but exclusively by cancelling the timer and calling #onPhaseEnd(),
 *    the exact method the timer expiry calls. Every eligibility re-check
 *    (halt parking, queue-full, window/chaos, mode) and the pool-too-small
 *    restart apply unmodified; the pool itself stays approved-only by
 *    construction (CandidatePool.add throws for non-approved, COMP-01), so
 *    early close changes WHEN the vote starts, never what enters it.
 *
 * This module never touches the queue, the gate, or the mode table — it only
 * calls the injected startRound (RoundManager owns all transitions). COMP-01
 * single-funnel stays intact.
 */

import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  AUTO_CYCLE_CHANGED,
  HALT_TRIGGERED,
  POOL_CHANGED,
  ROUND_CLOSED,
  STATE_CHANGED,
} from "../shared/events.js";
import type { RoundSnapshot, StreamMode } from "../shared/types.js";
import { RoundStartError } from "./round.js";

/**
 * Point-in-time scheduler state for console/overlay projections.
 * phase "waiting" (quick-260716-fdl): a suggest phase ended while a build was
 * in progress and the vote is parked until the machine returns to IDLE — no
 * deadline exists (phaseEndsAtMs stays null while waiting).
 */
export interface AutoCycleSnapshot {
  enabled: boolean;
  phase: "suggest" | "waiting" | null;
  phaseEndsAtMs: number | null;
}

/** The narration sliver the scheduler needs — late-bound in main.ts (silent-safe pre-chat). */
export interface AutoCycleNarrator {
  suggestionsOpen(seconds: number): void;
  stillCollecting(seconds: number): void;
  buildQueueFull(): void;
  /** The vote is parked behind an in-progress build (quick-260716-fdl) — one beat per park. */
  waitingForBuild(): void;
}

export interface AutoCycleDeps {
  /** The mode sliver of StreamModeMachine (OverlayModeSource shape). */
  machine: {
    readonly mode: StreamMode;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
  /** The round sliver of RoundManager: live snapshot + ROUND_CLOSED events. */
  round: {
    snapshot(): RoundSnapshot | null;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
  /** RoundManager.startRound pre-bound — throws RoundStartError when refused. */
  startRound: (initiator: "auto") => RoundSnapshot;
  /** True while a paid/redemption control window is live (it owns the show). */
  isControlWindowLive: () => boolean;
  /** True while chaos mode is on (it owns selection — no votes, D-05). */
  isChaosOn: () => boolean;
  /**
   * VOTE_QUEUE_MAX amendment: true when the vote-winner build queue is at or
   * over the cap — the scheduler defers new suggestion phases until it drains.
   */
  isVoteQueueFull?: () => boolean;
  /**
   * quick-260716-fdl: when true (the PRODUCTION default — main.ts computes it
   * from VOTE_WAITS_FOR_BUILD; only the exact trimmed string "false" disables),
   * a suggest phase ending while machine.mode === "BUILD_IN_PROGRESS" parks the
   * vote in the "waiting" state instead of opening a round; the parked vote
   * opens on the STATE_CHANGED that returns the machine to IDLE. REQUIRED (the
   * enabledAtBoot precedent): no class-level default may betray the production
   * default — the composition root always passes the computed value.
   */
  voteWaitsForBuild: boolean;
  /**
   * OPTIONAL pool sliver (quick-l2a early close): current approved-pool size
   * plus a POOL_CHANGED subscription. When absent, the scheduler behaves
   * exactly as before — timer-expiry only.
   */
  pool?: {
    size(): number;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };
  /**
   * Pool size that ends an ACTIVE suggest phase early (EARLY_CLOSE_POOL_SIZE,
   * default 5 in main.ts — a SEPARATE knob from ROUND_MAX_OPTIONS/POOL_MAX_SIZE
   * even though all three default to 5). Only meaningful when `pool` is wired.
   */
  earlyCloseSize?: number;
  /**
   * quick-rs3 chat-activated chaos-mode vote-skip hook (main.ts's pick
   * closure). Consulted at phase end AFTER the eligibility re-check passes:
   *  - "picked": chaos owned the phase end and enqueued one pooled candidate —
   *    skip startRound, open a fresh window;
   *  - "empty":  chaos owned the phase end but nothing was eligible — restart
   *    the window with the stillCollecting beat (nothing was consumed);
   *  - null (or absent dep): chaos does not own this phase end → proceed to
   *    startRound, byte-identical to today.
   */
  chaosModePick?: () => "picked" | "empty" | null;
  /**
   * quick-260711-ly4 single-suggestion auto-build hook (main.ts's soloPick
   * closure). Consulted at phase end on the DEMOCRATIC path (chaosModePick
   * returned null) when the pool holds EXACTLY ONE candidate — a 1-option vote
   * is meaningless, so that lone candidate is enqueued via the SAME winner
   * funnel a voted/chaos win uses. Same tri-state contract as chaosModePick:
   *  - "picked": the lone candidate entered the queue — skip startRound, open a
   *    fresh window (RE-ENTRANCY: uses #maybeBegin, never #beginSuggestPhase);
   *  - "empty":  nothing was eligible to build — restart the window (nothing
   *    consumed), exactly as a 0-candidate window restarts;
   *  - null (or absent dep): treated as "empty" — restart the window.
   */
  soloPick?: () => "picked" | "empty" | null;
  /** Suggestion-window length (SUGGEST_PHASE_SECONDS, default 40s). */
  suggestPhaseMs: number;
  /** AUTO_ROUND_ENABLED boot state (only the exact string "false" disables). */
  enabledAtBoot: boolean;
  narrate?: AutoCycleNarrator;
  /** Toggle audit hook — main.ts wires recordAutoCycleToggled here. */
  onToggled?: (enabled: boolean) => void;
  logger?: Logger;
  now?: () => number;
}

export class AutoCycleScheduler {
  readonly #deps: AutoCycleDeps;
  readonly #now: () => number;
  readonly #emitter = new EventEmitter();

  #enabled: boolean;
  #phaseEndsAtMs: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** One buildQueueFull beat per park (amendment) — reset when a phase begins. */
  #queueFullNarrated = false;
  /**
   * quick-260716-fdl: the vote is parked behind an in-progress build. No timer
   * exists while this is set — resume is purely event-driven (STATE_CHANGED /
   * ROUND_CLOSED / start() pokes funnel through #maybeBegin → #resumeFromWait).
   * #park() (halt) deliberately does NOT clear it: halt-recover resumes the
   * owed vote. toggle() off DOES clear it (the owed vote dies with the pause).
   */
  #waitingForBuild = false;
  /** One waitingForBuild beat per park (mirrors #queueFullNarrated). */
  #waitNarrated = false;

  constructor(deps: AutoCycleDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#enabled = deps.enabledAtBoot;

    // HALT parks the cycle synchronously — nothing fires while HALTED.
    deps.machine.on(HALT_TRIGGERED, () => {
      this.#park();
    });
    // Every mode change is a resume opportunity: recovery out of HALTED,
    // window close, chaos off, build completion, queue drain (the drain
    // itself moves the mode). Eligibility gating keeps this idempotent.
    deps.machine.on(STATE_CHANGED, () => {
      if (this.#phaseEndsAtMs === null && this.#timer === null) {
        this.#maybeBegin("fresh");
      }
    });
    // A1 continuous cadence: the moment a round closes — even mid-build —
    // the next suggestion window starts.
    deps.round.on(ROUND_CLOSED, () => {
      this.#maybeBegin("fresh");
    });
    // Pool-full early close (quick-l2a): POOL_CHANGED fires on add AND remove;
    // the active-phase + size>=cap guard in #maybeEarlyClose makes removes and
    // below-cap adds harmless no-ops (O(1) size check, T-l2a-04).
    deps.pool?.on(POOL_CHANGED, () => {
      this.#maybeEarlyClose();
    });
  }

  /** Called once from main.ts after composition — boot into the cadence if eligible. */
  start(): void {
    this.#maybeBegin("fresh");
  }

  /** Console pause/resume (D-04). Manual POST /api/round/start works while paused. */
  toggle(): void {
    this.#enabled = !this.#enabled;
    if (!this.#enabled) {
      this.#clearTimer();
      this.#phaseEndsAtMs = null;
      // The streamer paused the cadence — the owed vote dies with the pause
      // (quick-260716-fdl): toggling back on opens a FRESH suggest phase.
      this.#waitingForBuild = false;
      this.#waitNarrated = false;
    } else {
      this.#maybeBegin("fresh");
    }
    this.#deps.onToggled?.(this.#enabled);
    this.#emitChanged();
  }

  snapshot(): AutoCycleSnapshot {
    return {
      enabled: this.#enabled,
      phase:
        this.#phaseEndsAtMs !== null ? "suggest" : this.#waitingForBuild ? "waiting" : null,
      phaseEndsAtMs: this.#phaseEndsAtMs,
    };
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.#emitter.on(event, handler);
  }

  /** Shutdown hook (WR-05 symmetry with RoundManager.dispose). */
  dispose(): void {
    this.#clearTimer();
  }

  /**
   * Begin a suggestion phase if every eligibility condition holds; otherwise
   * stay parked. The queue-full park narrates ONCE per park (amendment).
   */
  #maybeBegin(kind: "fresh" | "restart"): void {
    if (this.#phaseEndsAtMs !== null || this.#timer !== null) return; // already in a phase
    // quick-260716-fdl resume routing: while a vote is parked behind a build,
    // EVERY existing poke (STATE_CHANGED, ROUND_CLOSED, start(), the
    // WINDOW_CLOSED/WINDOW_REVOKED start() pokes) funnels into the wait-resume
    // check instead of opening a new suggest phase — zero handler changes.
    if (this.#waitingForBuild) {
      this.#resumeFromWait();
      return;
    }
    if (!this.#enabled) return;
    if (this.#deps.round.snapshot() !== null) return; // a round is open/loaded
    const mode = this.#deps.machine.mode;
    if (mode !== "IDLE" && mode !== "BUILD_IN_PROGRESS") return;
    if (this.#deps.isControlWindowLive() || this.#deps.isChaosOn()) return;
    if (this.#deps.isVoteQueueFull?.() ?? false) {
      // VOTE_QUEUE_MAX park: never mint winners that can't be honored. One
      // beat per park; re-checks ride subsequent STATE_CHANGED events.
      if (!this.#queueFullNarrated) {
        this.#queueFullNarrated = true;
        this.#deps.narrate?.buildQueueFull();
        this.#deps.logger?.warn("auto-cycle parked — vote queue at VOTE_QUEUE_MAX");
        this.#emitChanged();
      }
      return;
    }
    this.#queueFullNarrated = false;
    this.#beginSuggestPhase(kind);
  }

  #beginSuggestPhase(kind: "fresh" | "restart"): void {
    const endsAtMs = this.#now() + this.#deps.suggestPhaseMs;
    this.#phaseEndsAtMs = endsAtMs;
    const seconds = Math.round(this.#deps.suggestPhaseMs / 1_000);
    if (kind === "fresh") this.#deps.narrate?.suggestionsOpen(seconds);
    else this.#deps.narrate?.stillCollecting(seconds);
    this.#deps.logger?.info({ endsAtMs, kind }, "auto-cycle suggestion phase opened");
    this.#emitChanged();
    // ONE unref'd timeout per phase (main.ts sweep-timer idiom) — never keeps
    // the process alive, cancelled by halt/toggle/dispose.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#onPhaseEnd();
    }, this.#deps.suggestPhaseMs);
    this.#timer.unref();
    // A phase that OPENS onto an already-full pool closes immediately —
    // through the same #onPhaseEnd funnel as every other close (quick-l2a).
    this.#maybeEarlyClose();
  }

  /**
   * Pool-full early close (quick-l2a): no-op unless a suggest phase is ACTIVE
   * and the wired pool has reached earlyCloseSize; otherwise cancel the timer
   * and run #onPhaseEnd() — the EXACT method the timer expiry calls, so the
   * halt/mode/window/chaos/queue-full eligibility re-check and the
   * pool-too-small restart all apply unmodified. Never calls startRound
   * directly (the "same code path" rule).
   */
  #maybeEarlyClose(): void {
    const pool = this.#deps.pool;
    const cap = this.#deps.earlyCloseSize;
    if (pool === undefined || cap === undefined) return;
    if (this.#phaseEndsAtMs === null || this.#timer === null) return; // no active phase
    // Math.max(cap, 2): D2-04 needs 2 candidates to open a round. Without this
    // floor, a misconfigured earlyCloseSize of 1 would loop forever — early
    // close → startRound throws pool-too-small → restart phase → early close…
    if (pool.size() < Math.max(cap, 2)) return;
    this.#deps.logger?.info(
      { poolSize: pool.size(), earlyCloseSize: cap },
      "auto-cycle suggestion phase closed early — pool full",
    );
    this.#clearTimer();
    this.#onPhaseEnd();
  }

  /**
   * The shared eligibility predicate — #onPhaseEnd and #resumeFromWait run the
   * IDENTICAL check (quick-260716-fdl: one predicate, never a parallel copy).
   * A HALTED / window-live / chaos-on / queue-full moment fails here, which is
   * exactly what keeps a parked vote frozen through a halt.
   */
  #isEligible(): boolean {
    const mode = this.#deps.machine.mode;
    return (
      this.#enabled &&
      this.#deps.round.snapshot() === null &&
      (mode === "IDLE" || mode === "BUILD_IN_PROGRESS") &&
      !this.#deps.isControlWindowLive() &&
      !this.#deps.isChaosOn() &&
      !(this.#deps.isVoteQueueFull?.() ?? false)
    );
  }

  #onPhaseEnd(): void {
    this.#phaseEndsAtMs = null;
    // Re-check eligibility at fire time: a window/chaos/halt/queue-cap that
    // arrived mid-phase parks here; the next STATE_CHANGED resumes the cycle.
    if (!this.#isEligible()) {
      this.#emitChanged(); // parked — overlay clears the countdown
      return;
    }
    this.#attemptRoundStart();
  }

  /**
   * quick-260716-fdl resume: a poke arrived while a vote is parked behind a
   * build. Re-runs the SAME eligibility predicate #onPhaseEnd uses — failing
   * it stays waiting (this is what keeps HALT frozen: mode HALTED is not
   * eligible), as does a machine still in BUILD_IN_PROGRESS. Otherwise the
   * wait clears FIRST (re-entrancy: #attemptRoundStart's chaos/solo arms call
   * #maybeBegin, which must not redirect back here — recursion guard) and the
   * parked vote opens through #attemptRoundStart — the BYTE-IDENTICAL funnel a
   * phase end uses, never a parallel one.
   */
  #resumeFromWait(): void {
    if (!this.#isEligible()) return; // stay waiting (halt/window/chaos/queue-full)
    if (this.#deps.machine.mode === "BUILD_IN_PROGRESS") return; // still building
    this.#waitingForBuild = false;
    this.#waitNarrated = false;
    this.#attemptRoundStart();
  }

  /**
   * The vote-attempt tail shared by phase end and wait-resume (quick-260716-fdl
   * extraction): chaosModePick consult → the wait gate → startRound with the
   * solo/restart arms. Callers have ALREADY passed the eligibility check.
   */
  #attemptRoundStart(): void {
    // quick-rs3 chat-activated chaos: while its window is live the vote round
    // is SKIPPED — the pick hook owns this phase end (it runs AFTER the
    // eligibility check above, so halt/window/old-chaos/queue-full parking
    // still govern, and FREE REIGN keeps outranking CHAOS).
    //
    // RE-ENTRANCY (checker BLOCKER — why #maybeBegin, NEVER #beginSuggestPhase):
    // the pick closure can synchronously enter BUILD_IN_PROGRESS
    // (enqueueWinner → onWinnerQueued → drainVoteQueue → machine.transition),
    // which emits STATE_CHANGED synchronously; this scheduler's STATE_CHANGED
    // handler sees #phaseEndsAtMs === null && #timer === null (both true
    // inside #onPhaseEnd) and may ALREADY have begun the next phase before
    // control returns here. #maybeBegin's first-line "already in a phase"
    // guard absorbs that re-entrant begin idempotently — one phase, one beat,
    // one timer. A direct #beginSuggestPhase call would overwrite
    // #phaseEndsAtMs, double-narrate, and orphan the first timer (steady-state
    // 2x picks/beats per window). The democratic path below needs no such care
    // only because startRound makes round.snapshot() non-null before the
    // handler runs. Beat choice: "picked" → "fresh" (the pick consumed the
    // window); "empty" → "restart"/stillCollecting (nothing consumed —
    // consistent with the democratic pool-too-small restart; INFO 2 decision).
    const chaosOutcome = this.#deps.chaosModePick?.() ?? null;
    if (chaosOutcome !== null) {
      this.#maybeBegin(chaosOutcome === "picked" ? "fresh" : "restart");
      return;
    }
    // quick-260716-fdl wait gate — AFTER the chaosModePick consult (chaos picks
    // must keep firing mid-build: they enqueue FIFO; drainVoteQueue serializes)
    // and BEFORE startRound: in default mode a vote never opens against a
    // running build — it parks and opens the moment the machine returns to
    // IDLE, so chat always votes on the app state the build just produced.
    if (this.#deps.voteWaitsForBuild && this.#deps.machine.mode === "BUILD_IN_PROGRESS") {
      this.#waitingForBuild = true;
      if (!this.#waitNarrated) {
        this.#waitNarrated = true;
        this.#deps.narrate?.waitingForBuild();
      }
      this.#deps.logger?.info("auto-cycle parked — vote waits for the in-progress build");
      this.#emitChanged(); // overlay swaps the countdown for the waiting banner
      return;
    }
    try {
      this.#deps.startRound("auto");
      // Success: ROUND_CLOSED continues the cadence. RoundManager emitted
      // ROUND_OPENED (its own overlay push); emit ours so the suggest
      // countdown clears in the same beat.
      this.#emitChanged();
    } catch (err) {
      if (err instanceof RoundStartError && err.reason === "pool-too-small") {
        // quick-260711-ly4 single-suggestion auto-build: a 1-option "vote" is
        // meaningless. When the wired pool holds EXACTLY ONE candidate and a
        // soloPick hook is wired, build that lone candidate directly through the
        // same winner funnel a vote/chaos win uses. Zero candidates (or no hook)
        // → restart, byte-identical to before. This runs ONLY on the democratic
        // path (chaosModePick returned null above), so FREE REIGN > CHAOS >
        // (democratic: solo-if-1 / vote-if-2+) precedence is preserved.
        if (this.#deps.pool?.size() === 1 && this.#deps.soloPick !== undefined) {
          const solo = this.#deps.soloPick?.() ?? null;
          if (solo === "picked") {
            // RE-ENTRANCY (identical to the chaosOutcome branch above — why
            // #maybeBegin, NEVER #beginSuggestPhase): the enqueue can
            // synchronously enter BUILD_IN_PROGRESS (enqueueWinner →
            // onWinnerQueued → drainVoteQueue → machine.transition), emitting
            // STATE_CHANGED synchronously, which may ALREADY have begun the next
            // phase. #maybeBegin's "already in a phase" guard absorbs it
            // idempotently — one phase, one beat, one timer.
            this.#maybeBegin("fresh");
            return;
          }
          // "empty"/null → nothing consumed → restart, same as a 0-candidate
          // window (fall through to the restart below).
        }
        // D-02: restart another full window with the "still collecting" beat
        // — exactly one startRound attempt per window, no busy spin.
        this.#beginSuggestPhase("restart");
        return;
      }
      if (err instanceof RoundStartError) {
        // not-idle / round-active: something else owns the show right now —
        // park and let the next STATE_CHANGED / ROUND_CLOSED resume us.
        this.#deps.logger?.warn({ reason: err.reason }, "auto-cycle round start refused — parked");
        this.#emitChanged();
        return;
      }
      // Unknown failure inside a timer callback: log loudly, park — never
      // crash the live show from the scheduler.
      this.#deps.logger?.error({ err }, "auto-cycle startRound failed unexpectedly — parked");
      this.#emitChanged();
    }
  }

  /**
   * Cancel any pending phase and clear state (halt / toggle-off). Deliberately
   * does NOT clear #waitingForBuild (quick-260716-fdl): a halt mid-wait keeps
   * the owed vote parked; halt-recover's STATE_CHANGED resumes it.
   */
  #park(): void {
    this.#clearTimer();
    if (this.#phaseEndsAtMs !== null) {
      this.#phaseEndsAtMs = null;
    }
    this.#emitChanged();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #emitChanged(): void {
    this.#emitter.emit(AUTO_CYCLE_CHANGED, this.snapshot());
  }
}
