import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_CYCLE_CHANGED, ROUND_CLOSED } from "../shared/events.js";
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
  };
  onToggled: ReturnType<typeof vi.fn>;
  changed: ReturnType<typeof vi.fn>;
  setRound(snap: RoundSnapshot | null): void;
  emitRoundClosed(): void;
  setWindowLive(live: boolean): void;
  setChaosOn(on: boolean): void;
  setQueueFull(full: boolean): void;
}

function make(
  opts: {
    enabledAtBoot?: boolean;
    startRoundImpl?: () => RoundSnapshot;
  } = {},
): Harness {
  const machine = new StreamModeMachine();
  const roundEmitter = new EventEmitter();
  let roundSnap: RoundSnapshot | null = null;
  let windowLive = false;
  let chaosOn = false;
  let queueFull = false;

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
    suggestPhaseMs: SUGGEST_MS,
    enabledAtBoot: opts.enabledAtBoot ?? true,
    narrate,
    onToggled,
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

  it("event-driven, zero polling: auto-cycle.ts contains no setInterval", () => {
    const source = readFileSync(fileURLToPath(new URL("./auto-cycle.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/setInterval/);
  });
});
