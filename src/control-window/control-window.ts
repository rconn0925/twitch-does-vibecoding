/**
 * ControlWindow lifecycle manager (Phase 4, PAID-01/02/04).
 *
 * The single FSM (open → active → expiry | revoke → closed) backing BOTH
 * donation and channel-points windows (D-03) — they differ only in `trigger`
 * and in their (configurable) duration constants. Mirrors `RoundManager`
 * exactly, with the same hard guarantees:
 *
 *   - One at a time (D-05): only one window is ever active. A second trigger
 *     while one is live, or a trigger from a donor still inside the per-donor
 *     cooldown, is rejected with a typed `ControlWindowError` and a durable
 *     window_denied audit row — NEVER silently (never-silent doctrine).
 *   - Capped duration (D-04): duration is linear in amount with a floor and a
 *     hard cap, so a large donation can never buy an unbounded window (T-04-07).
 *   - Crash safety (D-06/PAID-04): `ends_at_ms` is persisted ABSOLUTE. On
 *     restore(), a window whose deadline has passed closes as expired; a still
 *     live one re-arms for exactly the REMAINING time — a crash never loses or
 *     silently extends a paid window (T-04-08).
 *   - Halt honesty: a kill-switch halt freezes the window timer; recovery to
 *     IDLE discards it — reusing the Phase 1 machinery via injected
 *     StreamModeMachine transitions, no new abort pathway.
 *
 * Funnel isolation (T-04-09): a donor instruction issued during an active
 * window is handed to the INJECTED `submitDuringWindow` funnel (the real impl
 * is src/pipeline/paid-window.ts, 04-06). This module NEVER imports the
 * compliance gate, the task queue, or any RNG — the paid side of the D-08
 * separation, structurally enforced by the 04-06 source scan.
 */

import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import {
  recordWindowDenied,
  recordWindowExpired,
  recordWindowOpened,
  recordWindowRevoked,
} from "../audit/record.js";
import {
  HALT_TRIGGERED,
  STATE_CHANGED,
  WINDOW_CLOSED,
  WINDOW_OPENED,
  WINDOW_REVOKED,
} from "../shared/events.js";
import type {
  ControlWindowSnapshot,
  StateSnapshot,
  StreamMode,
  SuggestionCandidate,
  WindowTrigger,
} from "../shared/types.js";
import type { StreamModeMachine } from "../state-machine/stream-mode.js";
import { amountToDurationSeconds, type DurationConfig } from "./duration.js";
import { closeWindow, insertWindow, readActiveWindow } from "./persistence.js";

/** Thrown by open() when a window request is refused (D-05, never silent). */
export class ControlWindowError extends Error {
  readonly reason: "window-active" | "cooldown" | "not-idle";

  constructor(reason: "window-active" | "cooldown" | "not-idle") {
    super(
      reason === "window-active"
        ? "A control window is already active — only one at a time (D-05)"
        : reason === "cooldown"
          ? "This donor is still within the per-donor cooldown (D-04)"
          : "Can't open a control window unless the stream is IDLE",
    );
    this.name = "ControlWindowError";
    this.reason = reason;
  }
}

/**
 * The ONLY bridge to the build queue for a donor instruction (T-04-09). The
 * real impl (src/pipeline/paid-window.ts, 04-06) re-screens through the SAME
 * single funnel (the shared gate + queue) — this module only ever sees the
 * injected function, never the gate or the queue directly.
 */
export type SubmitDuringWindow = (
  candidate: SuggestionCandidate,
) => Promise<{ queued: true } | { queued: false; reason: "halted" | "rejected" | "held" }>;

export interface ControlWindowDeps {
  db: Database.Database;
  machine: StreamModeMachine;
  /** INJECTED single-funnel bridge (paid-window.ts, 04-06). */
  submitDuringWindow: SubmitDuringWindow;
  /** D-04 amount→duration config for donation-triggered windows. */
  donationConfig: DurationConfig;
  /** D-04 amount→duration config for channel-points-triggered windows. */
  redemptionConfig: DurationConfig;
  /** D-04 per-donor cooldown in milliseconds. */
  cooldownMs: number;
  logger?: Logger;
  now?: () => number;
}

/** A window request from a validated upstream trigger (amount/donor from 04-02). */
export interface OpenWindowRequest {
  trigger: WindowTrigger;
  /** Stable donor key for cooldown tracking (StreamElements username / EventSub user_id). */
  donorIdentifier: string;
  /** Display name for the console/overlay projection. */
  donorDisplayName: string;
  /** Tip amount (dollars) or redemption cost (points) — the D-04 mapping input. */
  amountOrCost: number;
  /**
   * WR-02: the tip's ISO-4217 currency code (donations only; redemptions are
   * points and leave this undefined). Without an FX table (no network on the
   * live host), a non-USD donation is treated LEAST-FAVORABLY — it earns only
   * the floor window and is labelled/narrated in its ACTUAL currency, never as
   * dollars. Absent/undefined is treated as USD.
   */
  currency?: string;
}

/** In-memory authoritative view of the single active window. */
interface ActiveWindow {
  id: number;
  trigger: WindowTrigger;
  donorIdentifier: string;
  donorDisplayName: string;
  amountOrCost: number;
  /** ISO currency code for a donation window (WR-02); undefined for points. */
  currency: string | undefined;
  amountLabel: string;
  durationMs: number;
  openedAtMs: number;
  endsAtMs: number;
  frozen: boolean;
}

export class ControlWindow {
  readonly #db: Database.Database;
  readonly #machine: StreamModeMachine;
  readonly #submitDuringWindow: SubmitDuringWindow;
  readonly #donationConfig: DurationConfig;
  readonly #redemptionConfig: DurationConfig;
  readonly #cooldownMs: number;
  readonly #logger: Logger | undefined;
  readonly #now: () => number;
  readonly #emitter = new EventEmitter();
  readonly #lastGrantedAtMs = new Map<string, number>();

  #window: ActiveWindow | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastMode: StreamMode;

  constructor(deps: ControlWindowDeps) {
    this.#db = deps.db;
    this.#machine = deps.machine;
    this.#submitDuringWindow = deps.submitDuringWindow;
    this.#donationConfig = deps.donationConfig;
    this.#redemptionConfig = deps.redemptionConfig;
    this.#cooldownMs = deps.cooldownMs;
    this.#logger = deps.logger;
    this.#now = deps.now ?? Date.now;
    this.#lastMode = deps.machine.mode;

    // Halt honesty: a halt freezes the active window synchronously.
    this.#machine.on(HALT_TRIGGERED, () => {
      this.#freeze();
    });
    // Recovery triage symmetry with RoundManager: HALTED→FREE_REIGN_WINDOW
    // resumes the frozen window, HALTED→IDLE discards it.
    this.#machine.on(STATE_CHANGED, (...args: unknown[]) => {
      const snap = args[0] as StateSnapshot;
      const prev = this.#lastMode;
      this.#lastMode = snap.mode;
      if (prev !== "HALTED") return;
      if (snap.mode === "FREE_REIGN_WINDOW") this.#resume();
      else if (snap.mode === "IDLE") this.#discard();
    });
  }

  /**
   * Open a control window from a validated trigger (PAID-01/02). Guard order
   * mirrors RoundManager.startRound (window-active before not-idle, since an
   * active window puts the machine in FREE_REIGN_WINDOW): each denial writes a
   * window_denied audit row (for the donor-facing cases) and logs, THEN throws —
   * never silent (D-05). T-04-10: the guard-check → state-write is fully
   * synchronous (no await between the checks and the persist/transition), so a
   * concurrent trigger can never slip a second window in on the event loop.
   */
  open(request: OpenWindowRequest): ControlWindowSnapshot {
    if (this.#window !== null) {
      recordWindowDenied(this.#db, {
        trigger: request.trigger,
        donorIdentifier: request.donorIdentifier,
        reason: "already-active",
        streamMode: this.#machine.mode,
      });
      this.#logger?.warn(
        { donor: request.donorIdentifier, trigger: request.trigger },
        "control window request denied — already active (D-05)",
      );
      throw new ControlWindowError("window-active");
    }
    if (this.#machine.mode !== "IDLE") {
      // CR-01: a tip arriving mid-round / mid-build (the routine, frequent case)
      // must still leave a durable window_denied row — the compliance record of
      // truth for real money can never go silent (never-silent doctrine).
      recordWindowDenied(this.#db, {
        trigger: request.trigger,
        donorIdentifier: request.donorIdentifier,
        reason: "not-idle",
        streamMode: this.#machine.mode,
      });
      this.#logger?.warn(
        { donor: request.donorIdentifier, mode: this.#machine.mode },
        "control window request denied — stream not idle",
      );
      throw new ControlWindowError("not-idle");
    }
    const lastGranted = this.#lastGrantedAtMs.get(request.donorIdentifier);
    const nowMs = this.#now();
    if (lastGranted !== undefined && nowMs - lastGranted < this.#cooldownMs) {
      recordWindowDenied(this.#db, {
        trigger: request.trigger,
        donorIdentifier: request.donorIdentifier,
        reason: "cooldown",
        streamMode: this.#machine.mode,
      });
      this.#logger?.warn(
        { donor: request.donorIdentifier, sinceMs: nowMs - lastGranted },
        "control window request denied — donor in cooldown (D-04)",
      );
      throw new ControlWindowError("cooldown");
    }

    const config = request.trigger === "donation" ? this.#donationConfig : this.#redemptionConfig;
    // WR-02: a non-USD donation earns only the FLOOR window (least-favorable
    // treatment, since we can't fairly convert without an FX table) — so a
    // "5" JPY tip never buys the same window a $5 USD tip does. USD donations
    // and points map normally.
    const currency = request.currency?.toUpperCase();
    const nonUsdDonation =
      request.trigger === "donation" && currency !== undefined && currency !== "USD";
    const durationSeconds = nonUsdDonation
      ? config.minSeconds
      : amountToDurationSeconds(request.amountOrCost, config);
    const durationMs = durationSeconds * 1_000;
    const endsAtMs = nowMs + durationMs;
    const amountLabel = this.#buildAmountLabel(
      request.trigger,
      request.amountOrCost,
      durationMs,
      request.currency,
    );

    const id = insertWindow(this.#db, {
      trigger: request.trigger,
      donorIdentifier: request.donorIdentifier,
      amountOrCost: request.amountOrCost,
      durationMs,
      openedAtMs: nowMs,
      endsAtMs,
    });

    this.#window = {
      id,
      trigger: request.trigger,
      donorIdentifier: request.donorIdentifier,
      donorDisplayName: request.donorDisplayName,
      amountOrCost: request.amountOrCost,
      currency: request.currency,
      amountLabel,
      durationMs,
      openedAtMs: nowMs,
      endsAtMs,
      frozen: false,
    };
    this.#lastGrantedAtMs.set(request.donorIdentifier, nowMs);

    // IN-03: capture the mode the request ARRIVED in (guaranteed IDLE by the
    // not-idle guard above) BEFORE the transition, so the window_opened ledger
    // row reflects the pre-open mode rather than the freshly-entered
    // FREE_REIGN_WINDOW.
    const priorMode = this.#machine.mode;
    this.#machine.transition("FREE_REIGN_WINDOW");
    this.#armTimer(durationMs);
    recordWindowOpened(this.#db, {
      trigger: request.trigger,
      donorIdentifier: request.donorIdentifier,
      amountOrCost: request.amountOrCost,
      durationMs,
      streamMode: priorMode,
    });

    const snap = this.#buildSnapshot(this.#window);
    this.#logger?.info(
      { windowId: id, trigger: request.trigger, durationMs, endsAtMs },
      "control window opened",
    );
    this.#emitter.emit(WINDOW_OPENED, snap);
    return snap;
  }

  /**
   * Hand a donor instruction to the INJECTED funnel during an active window
   * (D-11: an OPEN sponsored slot — no donor-ownership guard). A rejected/held
   * result is returned to the caller (never silent) and does NOT consume the
   * window's remaining time budget — the window runs its FULL duration (D-12).
   */
  async submitInstruction(
    candidate: SuggestionCandidate,
  ): Promise<{ queued: true } | { queued: false; reason: "halted" | "rejected" | "held" }> {
    const result = await this.#submitDuringWindow(candidate);
    if (!result.queued) {
      this.#logger?.warn(
        { reason: result.reason, candidateId: candidate.id },
        "control window submission was not queued (window time unaffected)",
      );
    }
    return result;
  }

  /** Streamer revoke (PAID-03): close as revoked and revert to IDLE — no new abort pathway. */
  revoke(): void {
    const window = this.#window;
    if (window === null) return;
    this.#clearTimer();
    closeWindow(this.#db, window.id, "revoked", this.#now());
    if (this.#machine.mode === "FREE_REIGN_WINDOW") {
      this.#machine.transition("IDLE");
    }
    recordWindowRevoked(this.#db, {
      trigger: window.trigger,
      donorIdentifier: window.donorIdentifier,
      streamMode: this.#machine.mode,
    });
    const snap = this.#buildSnapshot(window);
    this.#window = null;
    this.#logger?.info({ windowId: window.id }, "control window revoked by streamer");
    this.#emitter.emit(WINDOW_REVOKED, snap);
  }

  /** Point-in-time console view of the active window, or null when none. */
  snapshot(): ControlWindowSnapshot | null {
    return this.#window ? this.#buildSnapshot(this.#window) : null;
  }

  /**
   * Crash recovery (PAID-04) — called at startup BEFORE any donation/redemption
   * listener accepts events. A window whose ends_at_ms passed during downtime
   * closes as expired; a still-live one re-arms for exactly the REMAINING time
   * (never a fresh full duration — the D-06 crash-safety linchpin, T-04-08).
   */
  restore(): void {
    const row = readActiveWindow(this.#db);
    if (row === undefined) return;

    const trigger = row.trigger_type as WindowTrigger;
    this.#window = {
      id: row.id,
      trigger,
      donorIdentifier: row.donor_identifier,
      // donorDisplayName is not separately persisted (schema has no column);
      // the stable identifier is the honest fallback for the console projection.
      donorDisplayName: row.donor_identifier,
      amountOrCost: row.amount_or_cost,
      // WR-02: currency is not persisted (schema has no column); a restored
      // donation window's console label falls back to USD — best-effort after a
      // crash, mirroring the donorDisplayName→identifier fallback above.
      currency: undefined,
      amountLabel: this.#buildAmountLabel(trigger, row.amount_or_cost, row.duration_ms),
      durationMs: row.duration_ms,
      openedAtMs: row.opened_at_ms,
      endsAtMs: row.ends_at_ms,
      frozen: false,
    };
    this.#logger?.info(
      { windowId: row.id, endsAtMs: row.ends_at_ms },
      "restored active control window from SQLite",
    );

    const remaining = row.ends_at_ms - this.#now();
    if (remaining <= 0) {
      this.#expire();
      return;
    }
    // Re-arm for the REMAINDER only, and reflect the live window in the machine
    // (only when the freshly-booted machine is still IDLE — never re-transition
    // an already-restored FREE_REIGN_WINDOW).
    if (this.#machine.mode === "IDLE") {
      this.#machine.transition("FREE_REIGN_WINDOW");
    }
    this.#armTimer(remaining);
  }

  /** Cancel the armed expiry timer on shutdown so it can't fire against a closed db. */
  dispose(): void {
    this.#clearTimer();
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.#emitter.on(event, handler);
  }

  /** Natural expiry (timer fire or expired-on-restore): close as expired, revert to IDLE. */
  #expire(): void {
    const window = this.#window;
    if (window === null) return;
    this.#clearTimer();
    closeWindow(this.#db, window.id, "expired", this.#now());
    // A close can never fight a halt: only leave FREE_REIGN_WINDOW if we're in it.
    if (this.#machine.mode === "FREE_REIGN_WINDOW") {
      this.#machine.transition("IDLE");
    }
    recordWindowExpired(this.#db, {
      trigger: window.trigger,
      donorIdentifier: window.donorIdentifier,
      streamMode: this.#machine.mode,
    });
    const snap = this.#buildSnapshot(window);
    this.#window = null;
    this.#logger?.info(
      { windowId: window.id },
      "control window expired — reverting to normal loop",
    );
    this.#emitter.emit(WINDOW_CLOSED, snap);
  }

  /** Halt freeze: cancel the timer so the window can't expire mid-halt. */
  #freeze(): void {
    const window = this.#window;
    if (window === null || window.frozen) return;
    this.#clearTimer();
    window.frozen = true;
    this.#logger?.warn({ windowId: window.id }, "halt froze the control window");
  }

  /**
   * Recovery RESUME (HALTED→FREE_REIGN_WINDOW): re-arm from the ABSOLUTE
   * ends_at_ms — if the deadline already passed during the halt, expire.
   */
  #resume(): void {
    const window = this.#window;
    if (window === null || !window.frozen) return;
    window.frozen = false;
    const remaining = window.endsAtMs - this.#now();
    if (remaining <= 0) {
      this.#expire();
      return;
    }
    this.#armTimer(remaining);
    this.#logger?.info({ windowId: window.id, remaining }, "frozen control window resumed");
  }

  /**
   * Recovery DISCARD (HALTED→IDLE): the paid window is dropped. The machine has
   * already moved to IDLE via recoverTo, so we do NOT transition again — we close
   * the durable row as revoked and audit it (never silent).
   */
  #discard(): void {
    const window = this.#window;
    if (window === null) return;
    this.#clearTimer();
    closeWindow(this.#db, window.id, "revoked", this.#now());
    recordWindowRevoked(this.#db, {
      trigger: window.trigger,
      donorIdentifier: window.donorIdentifier,
      streamMode: this.#machine.mode,
    });
    const snap = this.#buildSnapshot(window);
    this.#window = null;
    this.#logger?.warn(
      { windowId: window.id },
      "halt recovery discarded the control window — reverting to normal loop",
    );
    this.#emitter.emit(WINDOW_REVOKED, snap);
  }

  #armTimer(delayMs: number): void {
    this.#clearTimer();
    // unref'd so the expiry timer never keeps the process alive (main.ts idiom).
    this.#timer = setTimeout(() => {
      this.#expire();
    }, delayMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Honest console mapping text (D-04). Donations show dollars + the hard cap so
   * the streamer sees exactly how much control the money bought; redemptions show
   * points. This label is CONSOLE-ONLY — the coarse public overlay projection
   * (04-04) never carries an amount (T-04-03 info-disclosure mitigation).
   */
  #buildAmountLabel(
    trigger: WindowTrigger,
    amountOrCost: number,
    durationMs: number,
    currency?: string,
  ): string {
    if (trigger === "donation") {
      const capMs = this.#donationConfig.maxSeconds * 1_000;
      // WR-02: label in the ACTUAL currency (ISO code), never a hardcoded "$".
      const cur = currency?.toUpperCase() ?? "USD";
      return `${amountOrCost.toFixed(2)} ${cur} -> ${formatMmss(durationMs)} window (capped at ${formatMmss(capMs)})`;
    }
    return `${amountOrCost} points -> ${formatMmss(durationMs)} window`;
  }

  #buildSnapshot(window: ActiveWindow): ControlWindowSnapshot {
    return {
      donorDisplayName: window.donorDisplayName,
      trigger: window.trigger,
      amountLabel: window.amountLabel,
      durationMs: window.durationMs,
      endsAtMs: window.endsAtMs,
    };
  }
}

/** Format a millisecond duration as m:ss (e.g. 60000 → "1:00", 30000 → "0:30"). */
function formatMmss(ms: number): string {
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
