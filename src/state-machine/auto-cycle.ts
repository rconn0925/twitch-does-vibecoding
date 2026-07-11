/**
 * AutoCycleScheduler — the hands-free round cadence (quick-t5k D-01..D-04, A1).
 *
 * Repeats [suggestPhaseMs suggestion window] → startRound("auto") → (voting
 * runs on ROUND_DURATION_SECONDS inside RoundManager) → on ROUND_CLOSED the
 * next suggestion window begins IMMEDIATELY — the cadence never waits for a
 * build (A1: winners queue; builds drain serially via main.ts drainVoteQueue).
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
  ROUND_CLOSED,
  STATE_CHANGED,
} from "../shared/events.js";
import type { RoundSnapshot, StreamMode } from "../shared/types.js";
import { RoundStartError } from "./round.js";

/** Point-in-time scheduler state for console/overlay projections. */
export interface AutoCycleSnapshot {
  enabled: boolean;
  phase: "suggest" | null;
  phaseEndsAtMs: number | null;
}

/** The narration sliver the scheduler needs — late-bound in main.ts (silent-safe pre-chat). */
export interface AutoCycleNarrator {
  suggestionsOpen(seconds: number): void;
  stillCollecting(seconds: number): void;
  buildQueueFull(): void;
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
    } else {
      this.#maybeBegin("fresh");
    }
    this.#deps.onToggled?.(this.#enabled);
    this.#emitChanged();
  }

  snapshot(): AutoCycleSnapshot {
    return {
      enabled: this.#enabled,
      phase: this.#phaseEndsAtMs !== null ? "suggest" : null,
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
  }

  #onPhaseEnd(): void {
    this.#phaseEndsAtMs = null;
    // Re-check eligibility at fire time: a window/chaos/halt/queue-cap that
    // arrived mid-phase parks here; the next STATE_CHANGED resumes the cycle.
    const mode = this.#deps.machine.mode;
    const eligible =
      this.#enabled &&
      this.#deps.round.snapshot() === null &&
      (mode === "IDLE" || mode === "BUILD_IN_PROGRESS") &&
      !this.#deps.isControlWindowLive() &&
      !this.#deps.isChaosOn() &&
      !(this.#deps.isVoteQueueFull?.() ?? false);
    if (!eligible) {
      this.#emitChanged(); // parked — overlay clears the countdown
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

  /** Cancel any pending phase and clear state (halt / toggle-off). */
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
