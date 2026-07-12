/**
 * ChaosModeController — the CHAT-VOTED timed chaos window (quick-260711-ly4,
 * RS3-01/RS3-04).
 *
 * Pure show-mode state: an absolute close time and ONE unref'd expiry timer
 * (AutoCycleScheduler idiom). This module knows nothing about candidates,
 * pools, queues, votes, or selection — the CHAOS ballot candidate, the vote
 * round it wins, and the random picks during the window are all composed in
 * main.ts. That separation is scan-enforced: this file lives in src/chaos/ and
 * is governed by the source-separation invariant test, so it references only
 * timers and the window deadline.
 *
 * quick-260711-ly4: the old 3-unique-chatter tally threshold is REMOVED. The
 * window now opens via activate(), called by the drain-time kind router when a
 * server-composed CHAOS candidate WINS a normal vote round — winning is the
 * only chat path to chaos.
 *
 * State is IN-MEMORY ONLY by design: a process that crashes mid-chaos reboots
 * into democratic mode — the safe default for a live broadcast.
 *
 * DISTINCT from the console CHAOS_MODE machine toggle (CHAOS_TOGGLED): this
 * controller never transitions the stream-mode machine — the suggest cycle
 * keeps running while the chat-voted window is live.
 */

import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { CHAOS_MODE_CHANGED } from "../shared/events.js";

export interface ChaosModeDeps {
  /** Active-window length (CHAOS_MODE_DURATION_SECONDS, default 300s). */
  durationMs: number;
  /** Fired exactly once per activation (audit + narration hook in main.ts). */
  onActivated?: (endsAtMs: number) => void;
  /** Fired exactly once per NATURAL expiry — never on clear() (halt ≠ expiry). */
  onExpired?: () => void;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class ChaosModeController {
  readonly #deps: ChaosModeDeps;
  readonly #now: () => number;
  readonly #emitter = new EventEmitter();

  /** Absolute close time while the window is live; null otherwise. */
  #endsAtMs: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: ChaosModeDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Open the chaos window (quick-260711-ly4): called when a CHAOS ballot
   * candidate wins a vote round. Sets the absolute deadline, arms the expiry
   * timer, fires onActivated, and emits CHAOS_MODE_CHANGED. A second activate()
   * while the window is already live is an idempotent no-op (guard on
   * #endsAtMs), so a stray duplicate CHAOS winner can never re-arm the timer.
   */
  activate(): void {
    if (this.#endsAtMs !== null) return; // already live — no-op
    const endsAtMs = this.#now() + this.#deps.durationMs;
    this.#endsAtMs = endsAtMs;
    this.#armTimer();
    this.#deps.logger?.info({ endsAtMs }, "chaos mode activated by vote win");
    this.#deps.onActivated?.(endsAtMs);
    this.#emitChanged();
  }

  /** { endsAtMs } while the window is live, null otherwise. */
  snapshot(): { endsAtMs: number } | null {
    return this.#endsAtMs === null ? null : { endsAtMs: this.#endsAtMs };
  }

  /**
   * HALT semantics (RS3-04): wipe the active window, cancel the timer, fire NO
   * onExpired (a halt is not an expiry). Chaos never survives a halt —
   * recovery restores democratic mode.
   */
  clear(): void {
    this.#clearTimer();
    this.#endsAtMs = null;
    this.#emitChanged();
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.#emitter.on(event, handler);
  }

  /** Shutdown hook (WR-05 symmetry) — cancels the timer only. */
  dispose(): void {
    this.#clearTimer();
  }

  #armTimer(): void {
    this.#clearTimer();
    // ONE unref'd timeout (AutoCycleScheduler idiom) — never keeps the
    // process alive; cancelled by clear()/dispose().
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#endsAtMs = null;
      this.#deps.logger?.info("chaos mode expired — democratic mode restored");
      this.#deps.onExpired?.();
      this.#emitChanged();
    }, this.#deps.durationMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #emitChanged(): void {
    this.#emitter.emit(CHAOS_MODE_CHANGED, this.snapshot());
  }
}
