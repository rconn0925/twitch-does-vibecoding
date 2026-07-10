import { EventEmitter } from "node:events";
import { HALT_TRIGGERED, STATE_CHANGED } from "../shared/events.js";
import type { HaltContext, StateSnapshot, StreamMode } from "../shared/types.js";

/**
 * Thrown on illegal normal transitions. Message wording feeds the UI-SPEC
 * "Can't transition to {state} from {state}" error copy verbatim.
 */
export class InvalidTransitionError extends Error {
  readonly from: StreamMode;
  readonly to: StreamMode;

  constructor(from: StreamMode, to: StreamMode) {
    super(`Can't transition to ${to} from ${from}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Legal NORMAL transitions for Phase 1. HALTED is deliberately absent as a
 * target here — it is reachable only via forceTransition(), from every state,
 * bypassing this table (D-02). HALTED's only exits are via recover() in
 * src/state-machine/halt.ts (D-04: nothing auto-resumes).
 */
const TRANSITIONS: Record<StreamMode, StreamMode[]> = {
  IDLE: ["VOTING_ROUND", "FREE_REIGN_WINDOW", "CHAOS_MODE"],
  VOTING_ROUND: ["IDLE", "BUILD_IN_PROGRESS"],
  // CR-03: a build triggered by a paid-window instruction or a chaos pick returns
  // to its originating mode so the window can drain its NEXT queued instruction
  // (D-12: one window, multiple sequential builds) and chaos can pick again while
  // still enabled. A round-winner build still returns to IDLE (the vote loop).
  BUILD_IN_PROGRESS: ["IDLE", "FREE_REIGN_WINDOW", "CHAOS_MODE"],
  FREE_REIGN_WINDOW: ["IDLE", "BUILD_IN_PROGRESS"],
  CHAOS_MODE: ["BUILD_IN_PROGRESS", "IDLE"],
  HALTED: [],
};

/**
 * Hand-rolled six-state machine — the single source of truth for "what can
 * chat currently do". No library (RESEARCH.md rejects XState for ~6 states).
 *
 * The HALTED transition is synchronous and unconditional: forceTransition()
 * accepts only "HALTED" as a target (typed literal), bypasses the transition
 * table, and performs zero async work (Pattern 2: instant transition;
 * best-effort abort is decoupled and happens elsewhere, after the fact).
 */
export class StreamModeMachine {
  #mode: StreamMode = "IDLE";
  #activeTaskId: string | null = null;
  #activeTaskPid: number | null = null;
  #queuedTaskIds: string[] = [];
  #haltContext: HaltContext | null = null;
  readonly #emitter = new EventEmitter();

  get mode(): StreamMode {
    return this.#mode;
  }

  snapshot(): StateSnapshot {
    return {
      mode: this.#mode,
      activeTaskId: this.#activeTaskId,
      activeTaskPid: this.#activeTaskPid,
      queuedTaskIds: [...this.#queuedTaskIds],
      haltContext: this.#haltContext,
    };
  }

  /** Normal, table-checked transition. Throws InvalidTransitionError on illegal moves. */
  transition(to: StreamMode): void {
    const allowed = TRANSITIONS[this.#mode];
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError(this.#mode, to);
    }
    this.#mode = to;
    this.#emitter.emit(STATE_CHANGED, this.snapshot());
  }

  /**
   * HALT-priority transition: only "HALTED" is accepted, from ANY state,
   * synchronously, bypassing the transition table (D-02).
   */
  forceTransition(to: "HALTED", ctx: HaltContext): void {
    this.#mode = to;
    this.#haltContext = ctx;
    this.#emitter.emit(STATE_CHANGED, this.snapshot());
    this.#emitter.emit(HALT_TRIGGERED, ctx);
  }

  /**
   * Recovery exit from HALTED — callable ONLY by recover() in halt.ts (D-04:
   * the streamer explicitly picks the recovery action; nothing auto-resumes).
   * Clears the halt context.
   */
  recoverTo(to: StreamMode): void {
    if (this.#mode !== "HALTED") {
      throw new InvalidTransitionError(this.#mode, to);
    }
    this.#mode = to;
    this.#haltContext = null;
    this.#emitter.emit(STATE_CHANGED, this.snapshot());
  }

  /** Track the currently-building task (Phase 1: plumbing for plans 01-03/01-05). */
  setActiveTask(taskId: string | null, pid: number | null = null): void {
    this.#activeTaskId = taskId;
    this.#activeTaskPid = pid;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.#emitter.on(event, handler);
  }
}
