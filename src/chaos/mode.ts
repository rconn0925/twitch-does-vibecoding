/**
 * ChaosModeController — the CHAT-activated timed chaos window (quick-rs3,
 * RS3-01/RS3-04).
 *
 * Pure show-mode state: a unique-chatter tally, an activation threshold, and
 * ONE unref'd expiry timer (AutoCycleScheduler idiom). This module knows
 * nothing about candidates, pools, queues, or selection — the pick itself is
 * composed in main.ts. That separation is scan-enforced: this file lives in
 * src/chaos/ and is governed by the source-separation invariant test, so it
 * references only chatter ids, counts, and timers.
 *
 * State is IN-MEMORY ONLY by design: a process that crashes mid-chaos reboots
 * into democratic mode — the safe default for a live broadcast.
 *
 * DISTINCT from the console CHAOS_MODE machine toggle (CHAOS_TOGGLED): this
 * controller never transitions the stream-mode machine — the suggest cycle
 * keeps running while the chat-activated window is live.
 */

import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { CHAOS_MODE_CHANGED } from "../shared/events.js";

/** Discriminated outcome of one !chaos vote. */
export type ChaosVoteResult =
  /** A NEW unique chatter below the threshold — narrate the tally progress. */
  | { kind: "counted"; count: number; threshold: number }
  /** A repeat chatter — silent no-op (D2-15). */
  | { kind: "duplicate" }
  /** The threshold-th unique chatter landed — the window is now live. */
  | { kind: "activated"; votes: number; endsAtMs: number }
  /** Chaos is already live — silent no-op. */
  | { kind: "already-active" };

export interface ChaosModeDeps {
  /** Unique chatters required to activate (CHAOS_ACTIVATION_VOTES, default 3). */
  thresholdVotes: number;
  /** Active-window length (CHAOS_MODE_DURATION_SECONDS, default 300s). */
  durationMs: number;
  /** Fired exactly once per activation (audit + narration hook in main.ts). */
  onActivated?: (votes: number, endsAtMs: number) => void;
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

  /** Unique chatter ids that voted !chaos since the last reset — O(1) dedupe (T-rs3-03). */
  #tally = new Set<string>();
  /** Absolute close time while the window is live; null otherwise. */
  #endsAtMs: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: ChaosModeDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Register one !chaos vote. Repeats are idempotent no-ops; the threshold-th
   * UNIQUE chatter activates the window and resets the tally.
   */
  vote(chatterId: string): ChaosVoteResult {
    if (this.#endsAtMs !== null) return { kind: "already-active" };
    if (this.#tally.has(chatterId)) return { kind: "duplicate" };
    this.#tally.add(chatterId);
    const count = this.#tally.size;
    if (count < this.#deps.thresholdVotes) {
      return { kind: "counted", count, threshold: this.#deps.thresholdVotes };
    }
    // Threshold reached: tally resets, window opens, expiry timer arms.
    this.#tally = new Set();
    const endsAtMs = this.#now() + this.#deps.durationMs;
    this.#endsAtMs = endsAtMs;
    this.#armTimer();
    this.#deps.logger?.info({ votes: count, endsAtMs }, "chaos mode activated by chat");
    this.#deps.onActivated?.(count, endsAtMs);
    this.#emitChanged();
    return { kind: "activated", votes: count, endsAtMs };
  }

  /** { endsAtMs } while the window is live, null otherwise. */
  snapshot(): { endsAtMs: number } | null {
    return this.#endsAtMs === null ? null : { endsAtMs: this.#endsAtMs };
  }

  /**
   * HALT semantics (RS3-04): wipe the tally AND the active window, cancel the
   * timer, fire NO onExpired (a halt is not an expiry). Chaos never survives
   * a halt — recovery restores democratic mode.
   */
  clear(): void {
    this.#clearTimer();
    this.#tally = new Set();
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
