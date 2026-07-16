import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_CYCLE_CHANGED, POOL_CHANGED, ROUND_CLOSED } from "../shared/events.js";
import type { RoundSnapshot } from "../shared/types.js";
import { AutoCycleScheduler } from "./auto-cycle.js";
import { RoundStartError } from "./round.js";
import { StreamModeMachine } from "./stream-mode.js";

/**
 * Fake-timer FSM matrix for the AutoCycleScheduler (quick-t5k D-01..D-04, A1,
 * VOTE_QUEUE_MAX amendment). All deps injected — no SQLite, no network, no
 * real RoundManager. The scheduler is event-driven: the matrix proves nothing
 * fires while HALTED, deferral conditions park it, and the cadence never
 * busy-spins.
 */

const SUGGEST_MS = 40_000;

function openSnapshot(): RoundSnapshot {
  return {
    roundId: 1,
    status: "open",
    frozen: false,
    candidates: [],
    openedAtMs: 0,
    endsAtMs: 20_000,
    remainingMs: null,
    winnerOption: null,
    tiebreak: false,
    totalVotes: 0,
    winnerQueued: false,
  };
}

interface Harness {
  machine: StreamModeMachine;
  scheduler: AutoCycleScheduler;
  startRound: ReturnType<typeof vi.fn>;
  narrate: {
    suggestionsOpen: ReturnType<typeof vi.fn>;
    stillCollecting: ReturnType<typeof vi.fn>;
    buildQueueFull: ReturnType<typeof vi.fn>;
    waitingForBuild: ReturnType<typeof vi.fn>;
  };
  onToggled: ReturnType<typeof vi.fn>;
  changed: ReturnType<typeof vi.fn>;
  setRound(snap: RoundSnapshot | null): void;
  emitRoundClosed(): void;
  setWindowLive(live: boolean): void;
  setChaosOn(on: boolean): void;
  setQueueFull(full: boolean): void;
  setPoolSize(size: number): void;
  emitPoolChanged(): void;
}

function make(
  opts: {
    enabledAtBoot?: boolean;
    startRoundImpl?: () => RoundSnapshot;
    /** Wire the optional pool dep (quick-l2a early close) with this cap. */
    earlyCloseSize?: number;
    poolSizeAtBoot?: number;
    /** Wire the optional chat-chaos vote-skip hook (quick-rs3). */
    chaosModePick?: () => "picked" | "empty" | null;
    /** Wire the optional single-suggestion auto-build hook (quick-260711-ly4). */
    soloPick?: () => "picked" | "empty" | null;
    /**
     * quick-260716-fdl vote-waits-for-build. LOUD NOTE: the PRODUCTION default
     * is TRUE — main.ts computes it from VOTE_WAITS_FOR_BUILD (only the exact
     * trimmed string "false" disables). The HARNESS defaults to false so every
     * pre-fdl pipelining test stays byte-identical; the wait tests opt in.
     */
    voteWaitsForBuild?: boolean;
  } = {},
): Harness {
  const machine = new StreamModeMachine();
  const roundEmitter = new EventEmitter();
  const poolEmitter = new EventEmitter();
  let roundSnap: RoundSnapshot | null = null;
  let windowLive = false;
  let chaosOn = false;
  let queueFull = false;
  let poolSize = opts.poolSizeAtBoot ?? 0;

  const startRound = vi.fn(
    opts.startRoundImpl ??
      ((): RoundSnapshot => {
        roundSnap = openSnapshot();
        return roundSnap;
      }),
  );
  const narrate = {
    suggestionsOpen: vi.fn(),
    stillCollecting: vi.fn(),
    buildQueueFull: vi.fn(),
    waitingForBuild: vi.fn(),
  };
  const onToggled = vi.fn();

  const scheduler = new AutoCycleScheduler({
    machine,
    round: {
      snapshot: () => roundSnap,
      on: (event, handler) => {
        roundEmitter.on(event, handler);
      },
    },
    startRound: startRound as unknown as (initiator: "auto") => RoundSnapshot,
    isControlWindowLive: () => windowLive,
    isChaosOn: () => chaosOn,
    isVoteQueueFull: () => queueFull,
    // quick-260716-fdl: HARNESS default false (pre-fdl pipelining tests stay
    // byte-identical) — production default is TRUE, computed in main.ts.
    voteWaitsForBuild: opts.voteWaitsForBuild ?? false,
    suggestPhaseMs: SUGGEST_MS,
    enabledAtBoot: opts.enabledAtBoot ?? true,
    narrate,
    onToggled,
    // The optional pool dep (quick-l2a / quick-260711-ly4): wired when EITHER
    // early close OR the solo hook needs the pool.size() sliver, so every
    // pre-existing test still proves the no-pool back-compat path.
    ...(opts.earlyCloseSize !== undefined || opts.soloPick !== undefined
      ? {
          pool: {
            size: () => poolSize,
            on: (event: string, handler: (...args: unknown[]) => void) => {
              poolEmitter.on(event, handler);
            },
          },
        }
      : {}),
    ...(opts.earlyCloseSize !== undefined ? { earlyCloseSize: opts.earlyCloseSize } : {}),
    ...(opts.chaosModePick !== undefined ? { chaosModePick: opts.chaosModePick } : {}),
    ...(opts.soloPick !== undefined ? { soloPick: opts.soloPick } : {}),
  });
  const changed = vi.fn();
  scheduler.on(AUTO_CYCLE_CHANGED, changed);

  return {
    machine,
    scheduler,
    startRound,
    narrate,
    onToggled,
    changed,
    setRound: (snap) => {
      roundSnap = snap;
    },
    emitRoundClosed: () => {
      roundEmitter.emit(ROUND_CLOSED);
    },
    setWindowLive: (live) => {
      windowLive = live;
    },
    setChaosOn: (on) => {
      chaosOn = on;
    },
    setQueueFull: (full) => {
      queueFull = full;
    },
    setPoolSize: (size) => {
      poolSize = size;
    },
    emitPoolChanged: () => {
      poolEmitter.emit(POOL_CHANGED);
    },
  };
}

function haltCtx(machine: StreamModeMachine) {
  return { source: "console" as const, reasonTag: null, frozen: machine.snapshot() };
}

describe("AutoCycleScheduler (fake-timer matrix, quick-t5k)", () => {
  const disposables: AutoCycleScheduler[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const s of disposables.splice(0)) s.dispose();
    vi.useRealTimers();
  });

  function track(h: Harness): Harness {
    disposables.push(h.scheduler);
    return h;
  }

  it("happy cycle: start() while IDLE narrates suggestionsOpen, emits, then startRound('auto') fires after suggestPhaseMs", () => {
    const h = track(make());

    h.scheduler.start();

    expect(h.narrate.suggestionsOpen).toHaveBeenCalledWith(40);
    expect(h.changed).toHaveBeenCalled();
    const snap = h.scheduler.snapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.phase).toBe("suggest");
    expect(snap.phaseEndsAtMs).not.toBeNull();

    vi.advanceTimersByTime(SUGGEST_MS - 1);
    expect(h.startRound).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.startRound).toHaveBeenCalledTimes(1);
    expect(h.startRound).toHaveBeenCalledWith("auto");
    expect(h.scheduler.snapshot().phase).toBeNull();
  });

  it("continuous cadence (A1): ROUND_CLOSED while mode is BUILD_IN_PROGRESS begins the next suggest phase immediately", () => {
    const h = track(make());
    h.scheduler.start();
    vi.advanceTimersByTime(SUGGEST_MS); // round opened (fake sets round snapshot)
    expect(h.startRound).toHaveBeenCalledTimes(1);

    // A drain moved the machine into BUILD_IN_PROGRESS; the round closes
    // while the build is still running — the cadence must NOT wait for it.
    h.machine.transition("BUILD_IN_PROGRESS");
    h.setRound(null);
    h.emitRoundClosed();

    expect(h.scheduler.snapshot().phase).toBe("suggest");
    expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2);
  });

  it("empty-pool restart (D-02): pool-too-small narrates stillCollecting and re-arms ONE full window — no busy spin", () => {
    const h = track(
      make({
        startRoundImpl: () => {
          throw new RoundStartError("pool-too-small");
        },
      }),
    );
    h.scheduler.start();

    vi.advanceTimersByTime(SUGGEST_MS);
    expect(h.startRound).toHaveBeenCalledTimes(1);
    expect(h.narrate.stillCollecting).toHaveBeenCalledWith(40);
    expect(h.scheduler.snapshot().phase).toBe("suggest"); // restarted window

    // No spin: nothing fires inside the restarted window...
    vi.advanceTimersByTime(SUGGEST_MS - 1);
    expect(h.startRound).toHaveBeenCalledTimes(1);
    // ...and exactly ONE more attempt at its end.
    vi.advanceTimersByTime(1);
    expect(h.startRound).toHaveBeenCalledTimes(2);
  });

  it("toggle() off mid-phase cancels the timer, nulls the phase, audits and emits; manual timers stay dead", () => {
    const h = track(make());
    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBe("suggest");

    h.scheduler.toggle();

    expect(h.scheduler.snapshot()).toEqual({ enabled: false, phase: null, phaseEndsAtMs: null });
    expect(h.onToggled).toHaveBeenCalledWith(false);
    expect(h.changed).toHaveBeenCalled();
    vi.advanceTimersByTime(SUGGEST_MS * 3);
    expect(h.startRound).not.toHaveBeenCalled();
  });

  it("toggle() on while eligible starts a phase immediately; while HALTED it parks until recovery", () => {
    const h = track(make({ enabledAtBoot: false }));
    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBeNull(); // disabled at boot → parked

    h.scheduler.toggle();
    expect(h.onToggled).toHaveBeenCalledWith(true);
    expect(h.scheduler.snapshot().phase).toBe("suggest");

    // Off again, halt, then toggle on WHILE HALTED: parks.
    h.scheduler.toggle();
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    h.scheduler.toggle();
    expect(h.scheduler.snapshot().enabled).toBe(true);
    expect(h.scheduler.snapshot().phase).toBeNull();
    vi.advanceTimersByTime(SUGGEST_MS * 3);
    expect(h.startRound).not.toHaveBeenCalled();

    // Recovery to IDLE restarts per the (enabled) toggle state.
    h.machine.recoverTo("IDLE");
    expect(h.scheduler.snapshot().phase).toBe("suggest");
  });

  it("HALT parks: the pending timer is cancelled, NOTHING fires while HALTED, recovery restarts the cycle", () => {
    const h = track(make());
    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBe("suggest");

    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    expect(h.scheduler.snapshot().phase).toBeNull();
    vi.advanceTimersByTime(SUGGEST_MS * 5);
    expect(h.startRound).not.toHaveBeenCalled();

    h.machine.recoverTo("IDLE");
    expect(h.scheduler.snapshot().phase).toBe("suggest");
    vi.advanceTimersByTime(SUGGEST_MS);
    expect(h.startRound).toHaveBeenCalledTimes(1);
  });

  it("deferral: a live control window or chaos-on parks the cycle; the blocker clearing (STATE_CHANGED) resumes it", () => {
    const h = track(make());
    h.setWindowLive(true);
    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBeNull();
    vi.advanceTimersByTime(SUGGEST_MS * 2);
    expect(h.startRound).not.toHaveBeenCalled();

    // The window closes: FREE_REIGN_WINDOW → IDLE fires STATE_CHANGED.
    h.setWindowLive(false);
    h.machine.transition("FREE_REIGN_WINDOW");
    h.machine.transition("IDLE");
    expect(h.scheduler.snapshot().phase).toBe("suggest");

    // Chaos defers the same way (event-driven — no polling interval).
    const h2 = track(make());
    h2.setChaosOn(true);
    h2.scheduler.start();
    expect(h2.scheduler.snapshot().phase).toBeNull();
    h2.setChaosOn(false);
    h2.machine.transition("CHAOS_MODE");
    h2.machine.transition("IDLE");
    expect(h2.scheduler.snapshot().phase).toBe("suggest");
  });

  it("deferral: mode FREE_REIGN_WINDOW / CHAOS_MODE alone parks even when the predicate fns read false", () => {
    const h = track(make());
    h.machine.transition("FREE_REIGN_WINDOW");
    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBeNull();
    vi.advanceTimersByTime(SUGGEST_MS * 2);
    expect(h.startRound).not.toHaveBeenCalled();
  });

  it("VOTE_QUEUE_MAX amendment: a full vote queue parks the cycle with ONE buildQueueFull beat; draining below cap resumes", () => {
    const h = track(make());
    h.setQueueFull(true);

    h.scheduler.start();
    expect(h.scheduler.snapshot().phase).toBeNull();
    expect(h.narrate.buildQueueFull).toHaveBeenCalledTimes(1);

    // Repeated wake-ups while still full never repeat the beat (one per park).
    h.machine.transition("BUILD_IN_PROGRESS");
    h.machine.transition("IDLE");
    expect(h.narrate.buildQueueFull).toHaveBeenCalledTimes(1);
    expect(h.startRound).not.toHaveBeenCalled();

    // Queue drains below the cap → the next STATE_CHANGED resumes the cycle.
    h.setQueueFull(false);
    h.machine.transition("BUILD_IN_PROGRESS");
    h.machine.transition("IDLE");
    expect(h.scheduler.snapshot().phase).toBe("suggest");

    // A LATER park on a re-filled queue narrates again (new park, new beat).
    vi.advanceTimersByTime(SUGGEST_MS); // round opens
    h.setQueueFull(true);
    h.setRound(null);
    h.emitRoundClosed();
    expect(h.scheduler.snapshot().phase).toBeNull();
    expect(h.narrate.buildQueueFull).toHaveBeenCalledTimes(2);
  });

  it("snapshot() returns { enabled, phase, phaseEndsAtMs }", () => {
    const h = track(make());
    expect(h.scheduler.snapshot()).toEqual({ enabled: true, phase: null, phaseEndsAtMs: null });
    h.scheduler.start();
    const snap = h.scheduler.snapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.phase).toBe("suggest");
    expect(typeof snap.phaseEndsAtMs).toBe("number");
  });

  it("dispose() cancels the armed timer (WR-05 shutdown symmetry)", () => {
    const h = track(make());
    h.scheduler.start();
    h.scheduler.dispose();
    vi.advanceTimersByTime(SUGGEST_MS * 2);
    expect(h.startRound).not.toHaveBeenCalled();
  });

  // ── quick-rs3: chat-activated chaos vote-skip hook ───────────────────────
  // The hook runs AFTER the eligibility re-check (halt/window/queue-full/old-
  // chaos parking all still govern) and BEFORE startRound. "picked"/"empty"
  // mean chaos owns this phase end (no vote round); null/absent → byte-
  // identical democratic behavior. The follow-up begin MUST absorb the
  // synchronous STATE_CHANGED re-entrancy (checker BLOCKER pin).
  describe("chat-activated chaos vote-skip hook (quick-rs3)", () => {
    it("'picked' → startRound is NEVER called and exactly one fresh phase begins", () => {
      const chaosModePick = vi.fn(() => "picked" as const);
      const h = track(make({ chaosModePick }));
      h.scheduler.start();
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // boot phase

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(chaosModePick).toHaveBeenCalledTimes(1);
      expect(h.startRound).not.toHaveBeenCalled();
      // Exactly ONE new begin, with the "fresh"/suggestionsOpen beat.
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2);
      expect(h.narrate.stillCollecting).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("suggest");
    });

    it("'empty' → the window restarts with the 'restart'/stillCollecting beat (INFO 2 decision)", () => {
      const chaosModePick = vi.fn(() => "empty" as const);
      const h = track(make({ chaosModePick }));
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.narrate.stillCollecting).toHaveBeenCalledTimes(1);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // boot only
      expect(h.scheduler.snapshot().phase).toBe("suggest");
    });

    it("null → behavior byte-identical to today: startRound fires as usual", () => {
      const chaosModePick = vi.fn(() => null);
      const h = track(make({ chaosModePick }));
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(chaosModePick).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
    });

    it("the hook is NOT consulted when eligibility fails (live control window parks first)", () => {
      const chaosModePick = vi.fn(() => "picked" as const);
      const h = track(make({ chaosModePick }));
      h.scheduler.start();
      h.setWindowLive(true); // FREE REIGN arrives mid-phase — outranks chaos

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(chaosModePick).not.toHaveBeenCalled();
      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBeNull(); // parked
    });

    it("the hook is NOT consulted after a HALT park (nothing fires while HALTED)", () => {
      const chaosModePick = vi.fn(() => "picked" as const);
      const h = track(make({ chaosModePick }));
      h.scheduler.start();
      h.machine.forceTransition("HALTED", haltCtx(h.machine));

      vi.advanceTimersByTime(SUGGEST_MS * 3);

      expect(chaosModePick).not.toHaveBeenCalled();
      expect(h.startRound).not.toHaveBeenCalled();
    });

    it("RE-ENTRANCY PIN (checker BLOCKER): a pick that synchronously fires STATE_CHANGED begins ONE phase, arms ONE timer, never double-fires", () => {
      // The stub mimics the real pick closure: enqueueWinner → onWinnerQueued →
      // drainVoteQueue → machine.transition emits STATE_CHANGED SYNCHRONOUSLY,
      // and the scheduler's own handler may begin the next phase MID-HOOK.
      let h: Harness | null = null;
      const chaosModePick = vi.fn((): "picked" => {
        const machine = h?.machine;
        if (machine) {
          machine.transition(machine.mode === "IDLE" ? "BUILD_IN_PROGRESS" : "IDLE");
        }
        return "picked";
      });
      h = track(make({ chaosModePick }));
      h.scheduler.start();
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1);

      // Phase end #1: the pick fires STATE_CHANGED mid-hook.
      vi.advanceTimersByTime(SUGGEST_MS);
      expect(chaosModePick).toHaveBeenCalledTimes(1);
      // Exactly ONE begin beat for the follow-up phase — not two.
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2);
      expect(h.scheduler.snapshot().phase).toBe("suggest");

      // No orphaned timer: exactly one suggestPhaseMs later there is exactly
      // ONE further phase end (one more pick, one more begin) — never two.
      vi.advanceTimersByTime(SUGGEST_MS);
      expect(chaosModePick).toHaveBeenCalledTimes(2);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(3);
      expect(h.startRound).not.toHaveBeenCalled();
    });
  });

  // ── quick-260711-ly4: single-suggestion auto-build hook ──────────────────
  // On the DEMOCRATIC path (chaosModePick returned null), when startRound throws
  // pool-too-small AND the wired pool holds EXACTLY ONE candidate, the soloPick
  // hook builds that lone candidate directly — no meaningless 1-option vote.
  // Zero candidates → restart (unchanged); 2+ → startRound succeeds (unchanged).
  describe("single-suggestion auto-build hook (quick-260711-ly4)", () => {
    it("size()===1 + 'picked': the lone candidate is built, NO restart, a FRESH window opens", () => {
      const soloPick = vi.fn(() => "picked" as const);
      const h = track(
        make({
          startRoundImpl: () => {
            throw new RoundStartError("pool-too-small");
          },
          poolSizeAtBoot: 1,
          soloPick,
        }),
      );
      h.scheduler.start();
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // boot phase

      vi.advanceTimersByTime(SUGGEST_MS);

      // startRound was ATTEMPTED (threw pool-too-small), then soloPick fired once.
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(soloPick).toHaveBeenCalledTimes(1);
      // NOT the restart path: stillCollecting never fired.
      expect(h.narrate.stillCollecting).not.toHaveBeenCalled();
      // A FRESH window opened via #maybeBegin("fresh").
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2);
      expect(h.scheduler.snapshot().phase).toBe("suggest");
    });

    it("size()===0: soloPick is NOT called; the window restarts (unchanged)", () => {
      const soloPick = vi.fn(() => "picked" as const);
      const h = track(
        make({
          startRoundImpl: () => {
            throw new RoundStartError("pool-too-small");
          },
          poolSizeAtBoot: 0,
          soloPick,
        }),
      );
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(soloPick).not.toHaveBeenCalled();
      expect(h.narrate.stillCollecting).toHaveBeenCalledTimes(1); // restart beat
      expect(h.scheduler.snapshot().phase).toBe("suggest");
    });

    it("size()>=2: startRound succeeds and soloPick is NOT called (unchanged democratic vote)", () => {
      const soloPick = vi.fn(() => "picked" as const);
      const h = track(make({ poolSizeAtBoot: 2, soloPick }));
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
      expect(soloPick).not.toHaveBeenCalled();
    });

    it("'empty' (nothing consumed) → the window restarts, same as a 0-candidate window", () => {
      const soloPick = vi.fn(() => "empty" as const);
      const h = track(
        make({
          startRoundImpl: () => {
            throw new RoundStartError("pool-too-small");
          },
          poolSizeAtBoot: 1,
          soloPick,
        }),
      );
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(soloPick).toHaveBeenCalledTimes(1);
      expect(h.narrate.stillCollecting).toHaveBeenCalledTimes(1);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // boot only
      expect(h.scheduler.snapshot().phase).toBe("suggest");
    });

    it("soloPick only fires on the DEMOCRATIC path: a live chaos pick preempts it (chaosModePick wins)", () => {
      const chaosModePick = vi.fn(() => "picked" as const);
      const soloPick = vi.fn(() => "picked" as const);
      const h = track(
        make({
          startRoundImpl: () => {
            throw new RoundStartError("pool-too-small");
          },
          poolSizeAtBoot: 1,
          chaosModePick,
          soloPick,
        }),
      );
      h.scheduler.start();

      vi.advanceTimersByTime(SUGGEST_MS);

      // Chaos owned the phase end BEFORE startRound — solo is never consulted.
      expect(chaosModePick).toHaveBeenCalledTimes(1);
      expect(h.startRound).not.toHaveBeenCalled();
      expect(soloPick).not.toHaveBeenCalled();
    });

    it("RE-ENTRANCY PIN: a soloPick that synchronously fires STATE_CHANGED begins ONE phase, arms ONE timer, never double-fires", () => {
      // The stub mimics the real closure: enqueueWinner → onWinnerQueued →
      // drainVoteQueue → machine.transition emits STATE_CHANGED SYNCHRONOUSLY,
      // and the scheduler's own handler may begin the next phase MID-HOOK.
      let h: Harness | null = null;
      const soloPick = vi.fn((): "picked" => {
        const machine = h?.machine;
        if (machine) {
          machine.transition(machine.mode === "IDLE" ? "BUILD_IN_PROGRESS" : "IDLE");
        }
        return "picked";
      });
      h = track(
        make({
          startRoundImpl: () => {
            throw new RoundStartError("pool-too-small");
          },
          poolSizeAtBoot: 1,
          soloPick,
        }),
      );
      h.scheduler.start();
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1);

      // Phase end #1: startRound throws pool-too-small; soloPick fires STATE_CHANGED mid-hook.
      vi.advanceTimersByTime(SUGGEST_MS);
      expect(soloPick).toHaveBeenCalledTimes(1);
      // Exactly ONE begin beat for the follow-up phase — not two.
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2);
      expect(h.narrate.stillCollecting).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("suggest");

      // No orphaned timer: exactly ONE further phase end one window later.
      vi.advanceTimersByTime(SUGGEST_MS);
      expect(soloPick).toHaveBeenCalledTimes(2);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(3);
    });
  });

  // ── quick-260716-fdl: vote rounds wait for builds (default mode) ──────────
  // With voteWaitsForBuild: true (the PRODUCTION default), the suggest phase
  // ending mid-build parks the scheduler in a "waiting" state instead of
  // opening a vote round. EVERY BUILD_IN_PROGRESS→IDLE transition un-parks it
  // — done, failed-resolved, refused-resolved, veto and halt-recover are all
  // the SAME machine edge, so one flip-to-IDLE test covers them uniformly
  // (plus one explicit veto-shaped duplicate below). Resume is purely
  // event-driven off STATE_CHANGED / ROUND_CLOSED / start() pokes — no timer
  // exists while waiting. These tests double as the COMP/chaos-bypass and
  // window-interplay assertions referenced by Task 3 (unaffected surfaces).
  describe("vote-waits-for-build park state (quick-260716-fdl)", () => {
    /** Boot into a suggest phase, move to BUILD_IN_PROGRESS, expire the phase → parked. */
    function parkMidBuild(h: Harness): void {
      h.scheduler.start();
      expect(h.scheduler.snapshot().phase).toBe("suggest");
      h.machine.transition("BUILD_IN_PROGRESS");
      vi.advanceTimersByTime(SUGGEST_MS);
    }

    it("default wait: suggest expiry mid-build parks — NO startRound, snapshot phase 'waiting', AUTO_CYCLE_CHANGED, exactly ONE waitingForBuild beat", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      h.scheduler.start();
      h.machine.transition("BUILD_IN_PROGRESS");
      h.changed.mockClear();

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot()).toEqual({
        enabled: true,
        phase: "waiting",
        phaseEndsAtMs: null,
      });
      expect(h.changed).toHaveBeenCalled(); // overlay learns about the park
      expect(h.narrate.waitingForBuild).toHaveBeenCalledTimes(1);
      expect(h.narrate.stillCollecting).not.toHaveBeenCalled();
    });

    it("build terminal un-parks: mode → IDLE opens the parked vote IMMEDIATELY (no new suggest phase, no suggestionsOpen beat first)", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // boot phase only

      // done / failed-resolved / refused-resolved / halt-recovered all reach
      // the scheduler as this SAME BUILD_IN_PROGRESS→IDLE edge.
      h.machine.transition("IDLE");

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
      // NO fresh suggest window opened between the park and the vote.
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1);
      expect(h.scheduler.snapshot().phase).toBeNull(); // a round is open now
    });

    it("veto un-parks: a vetoed build is the same BUILD_IN_PROGRESS→IDLE flip — the parked vote opens", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);

      // finalizeAborted (veto) transitions BUILD_IN_PROGRESS→IDLE like any
      // other terminal — asserted here as its own named case.
      h.machine.transition("IDLE");

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
    });

    it("pipelining restored: voteWaitsForBuild false → phase end mid-BUILD_IN_PROGRESS calls startRound exactly as today", () => {
      const h = track(make({ voteWaitsForBuild: false }));
      h.scheduler.start();
      h.machine.transition("BUILD_IN_PROGRESS");

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
      expect(h.narrate.waitingForBuild).not.toHaveBeenCalled();
    });

    it("early close parks too: pool hits earlyCloseSize mid-build → 'waiting' (no startRound); build end → the vote opens", () => {
      const CAP = 5;
      const h = track(make({ voteWaitsForBuild: true, earlyCloseSize: CAP }));
      h.scheduler.start();
      h.machine.transition("BUILD_IN_PROGRESS");

      h.setPoolSize(CAP);
      h.emitPoolChanged(); // early close funnels through #onPhaseEnd

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("waiting");

      h.machine.transition("IDLE");
      expect(h.startRound).toHaveBeenCalledTimes(1);
    });

    it("HALT mid-wait stays frozen: nothing fires while HALTED; recover to IDLE opens the parked vote (warm pool)", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);

      h.machine.forceTransition("HALTED", haltCtx(h.machine));

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("waiting"); // the owed vote survives the halt
      vi.advanceTimersByTime(SUGGEST_MS * 3);
      expect(h.startRound).not.toHaveBeenCalled();

      h.machine.recoverTo("IDLE");
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
    });

    it("toggle-off mid-wait clears the wait; toggle back on opens a FRESH suggest phase — the owed vote is NOT resurrected", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);
      expect(h.scheduler.snapshot().phase).toBe("waiting");

      h.scheduler.toggle(); // streamer paused the cadence — the owed vote dies
      expect(h.scheduler.snapshot()).toEqual({ enabled: false, phase: null, phaseEndsAtMs: null });

      h.scheduler.toggle(); // back on (mode is still BUILD_IN_PROGRESS)
      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("suggest"); // fresh window
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(2); // boot + fresh
    });

    it("chaos ordering: chaosModePick owns a mid-build phase end — the pick fires, NO waiting park (chaos bypass keeps working mid-build)", () => {
      // COMP/chaos-bypass assertion (also referenced by Task 3): chaos picks
      // enqueue FIFO and drain via drainVoteQueue independent of the wait.
      const chaosModePick = vi.fn(() => "picked" as const);
      const h = track(make({ voteWaitsForBuild: true, chaosModePick }));
      h.scheduler.start();
      h.machine.transition("BUILD_IN_PROGRESS");

      vi.advanceTimersByTime(SUGGEST_MS);

      expect(chaosModePick).toHaveBeenCalledTimes(1);
      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("suggest"); // fresh window, not waiting
      expect(h.narrate.waitingForBuild).not.toHaveBeenCalled();
    });

    it("window live at resume time: mode → IDLE stays waiting; the WINDOW_CLOSED poke (start()) after it clears opens the vote", () => {
      // Window-interplay assertion (also referenced by Task 3): paid-window
      // direct queueing bypasses the scheduler; the wait only defers to it.
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);

      h.setWindowLive(true);
      h.machine.transition("IDLE");
      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("waiting");

      // main.ts pokes start() on WINDOW_CLOSED/WINDOW_REVOKED.
      h.setWindowLive(false);
      h.scheduler.start();
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
    });

    it("vote queue full at resume time: stays waiting; the next STATE_CHANGED after it drains opens the vote", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);

      h.setQueueFull(true);
      h.machine.transition("IDLE");
      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("waiting");

      h.setQueueFull(false);
      h.machine.transition("BUILD_IN_PROGRESS"); // still building elsewhere → stays waiting
      expect(h.startRound).not.toHaveBeenCalled();
      h.machine.transition("IDLE");
      expect(h.startRound).toHaveBeenCalledTimes(1);
    });

    it("ROUND_CLOSED while waiting does NOT open a new suggest phase — still waiting while the build runs", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1);

      h.emitRoundClosed(); // a manual round closed mid-park

      expect(h.scheduler.snapshot().phase).toBe("waiting");
      expect(h.narrate.suggestionsOpen).toHaveBeenCalledTimes(1); // no new window
      expect(h.startRound).not.toHaveBeenCalled();
    });

    it("one beat per park: resume pokes while the build still runs narrate ZERO additional waitingForBuild beats", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      parkMidBuild(h);
      expect(h.narrate.waitingForBuild).toHaveBeenCalledTimes(1);

      // Every poke funnel (ROUND_CLOSED, start()) re-checks and stays parked.
      h.emitRoundClosed();
      h.scheduler.start();
      h.emitRoundClosed();

      expect(h.narrate.waitingForBuild).toHaveBeenCalledTimes(1);
      expect(h.startRound).not.toHaveBeenCalled();
    });

    it("deadlock proof (crash-restore shape): boot mid-build → suggest phase → waiting with ZERO timers → IDLE opens the vote", () => {
      const h = track(make({ voteWaitsForBuild: true }));
      // The machine is already mid-build when the scheduler ignites (the
      // crash-restore shape). BUILD_IN_PROGRESS is begin-eligible (unchanged
      // today), so a suggest phase opens…
      h.machine.transition("BUILD_IN_PROGRESS");
      h.scheduler.start();
      expect(h.scheduler.snapshot().phase).toBe("suggest");

      // …then expiry parks it.
      vi.advanceTimersByTime(SUGGEST_MS);
      expect(h.scheduler.snapshot().phase).toBe("waiting");
      // Resume is PURELY event-driven: no timer of any kind exists while
      // waiting (the existing no-orphaned-timer idiom) — nothing to deadlock.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(SUGGEST_MS * 5);
      expect(h.startRound).not.toHaveBeenCalled();

      h.machine.transition("IDLE");
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
    });
  });

  it("event-driven, zero polling: auto-cycle.ts contains no setInterval", () => {
    const source = readFileSync(fileURLToPath(new URL("./auto-cycle.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/setInterval/);
  });

  // ── quick-l2a: pool-full early close of the suggestion phase ────────────
  // The pool hitting EARLY_CLOSE_POOL_SIZE mid-suggest-phase must funnel
  // through #onPhaseEnd — the EXACT timer-expiry code path — so every
  // eligibility re-check (halt parking, queue-full, window/chaos, mode) and
  // the pool-too-small restart apply unmodified. Never startRound directly.
  describe("pool-full early close (quick-l2a)", () => {
    const CAP = 5;

    it("pool reaching the cap mid-phase cancels the timer and starts the round IMMEDIATELY via the phase-end path", () => {
      const h = track(make({ earlyCloseSize: CAP }));
      h.scheduler.start();
      expect(h.scheduler.snapshot().phase).toBe("suggest");
      h.changed.mockClear();

      // Well BEFORE the phase deadline the pool fills to the cap.
      vi.advanceTimersByTime(5_000);
      h.setPoolSize(CAP);
      h.emitPoolChanged();

      // startRound fired NOW — not at the 40s deadline.
      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
      expect(h.scheduler.snapshot().phase).toBeNull();
      expect(h.changed).toHaveBeenCalled(); // AUTO_CYCLE_CHANGED emitted

      // The cancelled timer stays dead: nothing double-fires at the deadline.
      vi.advanceTimersByTime(SUGGEST_MS * 2);
      expect(h.startRound).toHaveBeenCalledTimes(1);
    });

    it("early close re-checks eligibility: a full vote queue at that moment parks instead of starting", () => {
      const h = track(make({ earlyCloseSize: CAP }));
      h.scheduler.start();

      h.setQueueFull(true); // arrives mid-phase, before the pool fills
      h.setPoolSize(CAP);
      h.emitPoolChanged();

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBeNull(); // parked, same as timer expiry
    });

    it("HALT parks first: POOL_CHANGED at the cap after HALT_TRIGGERED fires nothing", () => {
      const h = track(make({ earlyCloseSize: CAP }));
      h.scheduler.start();

      h.machine.forceTransition("HALTED", haltCtx(h.machine)); // parks the phase
      h.setPoolSize(CAP);
      h.emitPoolChanged();

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBeNull();
      vi.advanceTimersByTime(SUGGEST_MS * 3);
      expect(h.startRound).not.toHaveBeenCalled();
    });

    it("pool events BELOW the cap leave the timer path completely unchanged", () => {
      const h = track(make({ earlyCloseSize: CAP }));
      h.scheduler.start();

      h.setPoolSize(CAP - 1);
      h.emitPoolChanged();
      h.emitPoolChanged(); // removes fire POOL_CHANGED too — still harmless

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBe("suggest");
      vi.advanceTimersByTime(SUGGEST_MS - 1);
      expect(h.startRound).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // startRound only at the deadline
      expect(h.startRound).toHaveBeenCalledTimes(1);
    });

    it("a suggest phase that BEGINS with the pool already at the cap closes immediately through the same path", () => {
      const h = track(make({ earlyCloseSize: CAP, poolSizeAtBoot: CAP }));

      h.scheduler.start();

      expect(h.startRound).toHaveBeenCalledTimes(1);
      expect(h.startRound).toHaveBeenCalledWith("auto");
      expect(h.scheduler.snapshot().phase).toBeNull();
    });

    it("POOL_CHANGED outside any active phase is a no-op (no phantom rounds while parked)", () => {
      const h = track(make({ enabledAtBoot: false, earlyCloseSize: CAP }));
      h.scheduler.start(); // disabled → parked, no phase

      h.setPoolSize(CAP);
      h.emitPoolChanged();

      expect(h.startRound).not.toHaveBeenCalled();
      expect(h.scheduler.snapshot().phase).toBeNull();
    });
  });
});
