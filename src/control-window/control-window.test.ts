import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { WINDOW_CLOSED, WINDOW_OPENED, WINDOW_PENDING, WINDOW_REVOKED } from "../shared/events.js";
import type { ControlWindowSnapshot, HaltContext, SuggestionCandidate } from "../shared/types.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import {
  ControlWindow,
  ControlWindowError,
  type OpenWindowRequest,
  type SubmitDuringWindow,
} from "./control-window.js";

const DONATION_CFG = { ratePerUnit: 12, minSeconds: 30, maxSeconds: 300 };
const REDEMPTION_CFG = { ratePerUnit: 0.03, minSeconds: 30, maxSeconds: 120 };
const COOLDOWN_MS = 120_000;

function candidate(id = "c1", overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id,
    source: "donation",
    kind: "suggestion",
    twitchUsername: "viewer_a",
    text: `build idea ${id}`,
    submittedAtMs: 500,
    ...overrides,
  };
}

function donationRequest(overrides: Partial<OpenWindowRequest> = {}): OpenWindowRequest {
  return {
    trigger: "donation",
    donorIdentifier: "viewer_a",
    donorDisplayName: "Viewer A",
    amountOrCost: 5,
    ...overrides,
  };
}

function haltCtx(machine: StreamModeMachine): HaltContext {
  return { source: "console", reasonTag: null, frozen: machine.snapshot() };
}

interface Harness {
  db: ReturnType<typeof openDb>;
  machine: StreamModeMachine;
  submit: ReturnType<typeof vi.fn>;
  manager: ControlWindow;
  now: () => number;
  setNow: (t: number) => void;
}

function makeHarness(opts: { submit?: SubmitDuringWindow } = {}): Harness {
  const db = openDb(":memory:");
  const machine = new StreamModeMachine();
  let t = 1_000;
  const now = (): number => t;
  const submit =
    (opts.submit as ReturnType<typeof vi.fn>) ??
    vi.fn(async () => ({ queued: true }) as { queued: true });
  const manager = new ControlWindow({
    db,
    machine,
    submitDuringWindow: submit,
    donationConfig: DONATION_CFG,
    redemptionConfig: REDEMPTION_CFG,
    cooldownMs: COOLDOWN_MS,
    now,
  });
  return {
    db,
    machine,
    submit,
    manager,
    now,
    setNow: (next: number) => {
      t = next;
    },
  };
}

describe("ControlWindow.open (PAID-01/02, D-04/D-05)", () => {
  let h: Harness;
  afterEach(() => {
    h?.manager.dispose();
    h?.db.close();
  });

  it("opens a window: transition, persist, arm timer, audit, emit, honest label", () => {
    h = makeHarness();
    const events: ControlWindowSnapshot[] = [];
    h.manager.on(WINDOW_OPENED, (s) => events.push(s as ControlWindowSnapshot));

    const snap = h.manager.open(donationRequest());

    expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");
    expect(snap.trigger).toBe("donation");
    expect(snap.donorDisplayName).toBe("Viewer A");
    expect(snap.durationMs).toBe(60_000); // $5 * 12 = 60s
    expect(snap.endsAtMs).toBe(61_000); // now 1000 + 60000
    // Honest console mapping text (D-04/WR-02): 5 USD → 1:00, cap shown as 5:00,
    // labelled in the actual currency (USD default) — never a hardcoded "$".
    expect(snap.amountLabel).toBe("5.00 USD -> 1:00 window (capped at 5:00)");
    expect(events).toHaveLength(1);

    const row = h.db
      .prepare("SELECT * FROM control_windows WHERE status = 'active'")
      .get() as Record<string, unknown>;
    expect(row.ends_at_ms).toBe(61_000);
    expect(row.duration_ms).toBe(60_000);
    expect(row.trigger_type).toBe("donation");

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "window_opened" });
    expect(audit).toHaveLength(1);
  });

  it("a redemption window uses the smaller-scale config and a points label", () => {
    h = makeHarness();
    const snap = h.manager.open(
      donationRequest({
        trigger: "channel_points",
        amountOrCost: 1_000,
        donorDisplayName: "Redeemer",
      }),
    );
    // 1000 points * 0.03 = 30s (clears the floor exactly).
    expect(snap.durationMs).toBe(30_000);
    expect(snap.amountLabel).toBe("1000 points -> 0:30 window");
  });

  it("WR-02: a non-USD donation earns only the FLOOR window and is labelled in its actual currency", () => {
    h = makeHarness();
    // amount 5 in JPY would map to 60s if treated as USD; least-favorable
    // treatment floors it to 30s and the label reads JPY, never "$".
    const snap = h.manager.open(donationRequest({ amountOrCost: 5, currency: "JPY" }));
    expect(snap.durationMs).toBe(30_000); // floor (minSeconds 30), NOT 60s
    expect(snap.amountLabel).toBe("5.00 JPY -> 0:30 window (capped at 5:00)");
  });

  it("WR-02: an explicit USD donation maps normally (currency-aware, not least-favorable)", () => {
    h = makeHarness();
    const snap = h.manager.open(donationRequest({ amountOrCost: 5, currency: "usd" }));
    expect(snap.durationMs).toBe(60_000); // $5 * 12 = 60s, full mapping
    expect(snap.amountLabel).toBe("5.00 USD -> 1:00 window (capped at 5:00)");
  });

  it("refuses a second window while one is active: window-active + window_denied(already-active), no stacking", () => {
    h = makeHarness();
    h.manager.open(donationRequest());

    expect(() => h.manager.open(donationRequest({ donorIdentifier: "viewer_b" }))).toThrowError(
      ControlWindowError,
    );
    try {
      h.manager.open(donationRequest({ donorIdentifier: "viewer_c" }));
    } catch (err) {
      expect((err as ControlWindowError).reason).toBe("window-active");
    }

    // Exactly ONE active row — the second/third requests did not stack.
    const active = h.db
      .prepare("SELECT COUNT(*) AS n FROM control_windows WHERE status = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(1);

    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]?.category).toBe("already-active");
  });

  it("refuses a donor inside the cooldown: cooldown + window_denied(cooldown)", () => {
    h = makeHarness();
    h.manager.open(donationRequest());
    h.manager.revoke(); // window closed, but lastGrantedAt for viewer_a persists

    // now unchanged → 0ms elapsed < COOLDOWN_MS → cooldown guard fires.
    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest());
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("cooldown");

    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied.some((r) => r.category === "cooldown")).toBe(true);
  });

  it("allows the same donor again once the cooldown has elapsed", () => {
    h = makeHarness();
    h.manager.open(donationRequest());
    h.manager.revoke();
    h.setNow(1_000 + COOLDOWN_MS + 1);
    expect(() => h.manager.open(donationRequest())).not.toThrow();
    expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");
  });

  it("HALTED still refuses outright: not-idle + window_denied(not-idle) — the kill switch outranks money", () => {
    // quick-260716-h73: VOTING_ROUND / BUILD_IN_PROGRESS / CHAOS_MODE now BANK a
    // pending window (see the pending-slot suite below) — HALTED is the ONLY
    // mode left on the outright-denial path, keeping the "not-idle" reason
    // vocabulary (the audit row's stream_mode HALTED distinguishes it).
    h = makeHarness();
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest());
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("not-idle");
    expect(h.machine.mode).toBe("HALTED");
    expect(h.manager.pendingSnapshot()).toBeNull(); // never banked out of a halt

    // CR-01/never-silent: the denial leaves a durable window_denied row
    // (reason "not-idle", captured in the HALTED mode the tip arrived in).
    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.category).toBe("not-idle");
    expect(denied[0]?.stream_mode).toBe("HALTED");
  });
});

describe("ControlWindow pending slot (quick-260716-h73: bank mid-busy, promote on IDLE)", () => {
  let h: Harness;
  afterEach(() => {
    h?.manager.dispose();
    h?.db.close();
  });

  it("banks a PENDING window mid-build: no transition, durable pending row, window_pending audit, WINDOW_PENDING emit", () => {
    h = makeHarness();
    h.machine.transition("BUILD_IN_PROGRESS");
    const pendingEvents: ControlWindowSnapshot[] = [];
    h.manager.on(WINDOW_PENDING, (s) => pendingEvents.push(s as ControlWindowSnapshot));

    const snap = h.manager.open(donationRequest());

    // The bank returns a PENDING snapshot: console-only flag + the documented
    // endsAtMs 0 no-deadline sentinel (the clock starts at OPEN, not at bank).
    expect(snap.pending).toBe(true);
    expect(snap.endsAtMs).toBe(0);
    expect(snap.durationMs).toBe(60_000); // $5 * 12 — the UNCHANGED D-04 mapping
    expect(snap.donorDisplayName).toBe("Viewer A");
    // NO machine transition, NO active window: pending grants nothing yet.
    expect(h.machine.mode).toBe("BUILD_IN_PROGRESS");
    expect(h.manager.snapshot()).toBeNull(); // snapshot() stays ACTIVE-only
    expect(h.manager.pendingSnapshot()?.pending).toBe(true);

    const row = h.db
      .prepare("SELECT * FROM control_windows WHERE status = 'pending'")
      .get() as Record<string, unknown>;
    expect(row.duration_ms).toBe(60_000);
    expect(row.opened_at_ms).toBe(1_000); // provisional bank time

    // Never-silent: ONE window_pending row, ZERO window_denied rows.
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_pending" })).toHaveLength(1);
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_denied" })).toHaveLength(0);
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]?.pending).toBe(true);
  });

  it("banks from VOTING_ROUND and CHAOS_MODE too (every busy mode except HALTED)", () => {
    for (const mode of ["VOTING_ROUND", "CHAOS_MODE"] as const) {
      const harness = makeHarness();
      harness.machine.transition(mode);
      const snap = harness.manager.open(donationRequest());
      expect(snap.pending).toBe(true);
      expect(harness.machine.mode).toBe(mode);
      expect(harness.manager.pendingSnapshot()).not.toBeNull();
      expect(listAuditRecords(harness.db, { limit: 10, eventType: "window_pending" })).toHaveLength(
        1,
      );
      harness.manager.dispose();
      harness.db.close();
    }
  });

  it("one slot: a second trigger while one is PENDING is denied window-pending + window_denied(window-pending)", () => {
    h = makeHarness();
    h.machine.transition("BUILD_IN_PROGRESS");
    h.manager.open(donationRequest());

    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest({ donorIdentifier: "viewer_b" }));
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("window-pending");

    // Never silent: a durable window_denied row with the NEW reason.
    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.category).toBe("window-pending");
    // The first pending is unaffected — still exactly one pending row.
    const rows = h.db
      .prepare("SELECT COUNT(*) AS n FROM control_windows WHERE status = 'pending'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("cooldown is stamped at GRANT (bank) time: a discarded pending still consumed the donor's cooldown", () => {
    h = makeHarness();
    h.machine.transition("BUILD_IN_PROGRESS");
    h.manager.open(donationRequest()); // banks at t=1000 — cooldown stamped HERE
    h.manager.revoke(); // discards the pending (streamer's call)
    h.machine.transition("IDLE");

    // Same donor re-tips from IDLE, still inside cooldownMs of the BANK.
    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest());
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("cooldown");
    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied.some((r) => r.category === "cooldown")).toBe(true);
  });

  it("a donor already in cooldown tipping mid-build is denied 'cooldown', NOT banked (guard runs before the bank branch)", () => {
    h = makeHarness();
    h.manager.open(donationRequest()); // opens at IDLE, stamps cooldown
    h.manager.revoke();
    h.machine.transition("BUILD_IN_PROGRESS");

    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest()); // same donor, inside cooldown, mid-build
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("cooldown");
    expect(h.manager.pendingSnapshot()).toBeNull(); // never banked
    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied.some((r) => r.category === "cooldown")).toBe(true);
  });

  it("promotes on the return to IDLE: FULL duration from promote-time, durable promote, WINDOW_OPENED { fromPending: true }", () => {
    vi.useFakeTimers();
    try {
      h = makeHarness();
      const openedArgs: unknown[][] = [];
      h.manager.on(WINDOW_OPENED, (...args) => openedArgs.push(args));
      h.machine.transition("BUILD_IN_PROGRESS");
      h.manager.open(donationRequest()); // banked at t=1000 ($5 → 60s)

      h.setNow(50_000); // the build ran 49s; the machine returns to IDLE now
      h.machine.transition("IDLE");

      // The window opened SYNCHRONOUSLY on the STATE_CHANGED to IDLE.
      expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");
      const snap = h.manager.snapshot();
      expect(snap).not.toBeNull();
      // FULL paid duration from promote-time — NEVER bank-time + duration.
      expect(snap?.endsAtMs).toBe(110_000); // 50000 + 60000
      expect(h.manager.pendingSnapshot()).toBeNull();

      const row = h.db
        .prepare("SELECT * FROM control_windows ORDER BY id DESC LIMIT 1")
        .get() as Record<string, unknown>;
      expect(row.status).toBe("active");
      expect(row.opened_at_ms).toBe(50_000);
      expect(row.ends_at_ms).toBe(110_000);

      // window_opened audit written at promote (streamMode = the pre-open IDLE).
      const opened = listAuditRecords(h.db, { limit: 10, eventType: "window_opened" });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.stream_mode).toBe("IDLE");

      // The composition-root discriminator: promoted opens carry a second arg.
      expect(openedArgs).toHaveLength(1);
      expect(openedArgs[0]?.[1]).toEqual({ fromPending: true });

      // Expiry timer armed for the FULL duration — advancing 60s expires it.
      vi.advanceTimersByTime(59_999);
      expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");
      vi.advanceTimersByTime(1);
      expect(h.machine.mode).toBe("IDLE");
      expect(
        h.db.prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1").get(),
      ).toEqual({ status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("WR-02: a non-USD donation banks with only the FLOOR duration (least-favorable, actual currency label)", () => {
    h = makeHarness();
    h.machine.transition("BUILD_IN_PROGRESS");
    const snap = h.manager.open(donationRequest({ amountOrCost: 5, currency: "JPY" }));
    expect(snap.pending).toBe(true);
    expect(snap.durationMs).toBe(30_000); // floor (minSeconds 30), NOT 60s
    expect(snap.amountLabel).toContain("JPY");
  });

  it("halt discard: a HALT while PENDING discards it on recover-to-IDLE — a window NEVER auto-opens out of a halt", () => {
    h = makeHarness();
    const revoked: ControlWindowSnapshot[] = [];
    h.manager.on(WINDOW_REVOKED, (s) => revoked.push(s as ControlWindowSnapshot));
    h.machine.transition("BUILD_IN_PROGRESS");
    h.manager.open(donationRequest()); // banks

    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    expect(h.manager.pendingSnapshot()).not.toBeNull(); // still banked while frozen

    h.machine.recoverTo("IDLE");
    // Discarded, never opened: machine stays IDLE, row revoked, audit + emit.
    expect(h.machine.mode).toBe("IDLE");
    expect(h.manager.pendingSnapshot()).toBeNull();
    expect(h.manager.snapshot()).toBeNull();
    const row = h.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    expect(row.status).toBe("revoked");
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_revoked" })).toHaveLength(1);
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_opened" })).toHaveLength(0);
    // The WINDOW_REVOKED payload is the PENDING snapshot (pending:true rides
    // along so the composition root narrates the pending-cancelled beat).
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.pending).toBe(true);
  });

  it("revoke() cancels a PENDING window exactly like an active one (row revoked + audit + emit); machine untouched", () => {
    h = makeHarness();
    const revoked: ControlWindowSnapshot[] = [];
    h.manager.on(WINDOW_REVOKED, (s) => revoked.push(s as ControlWindowSnapshot));
    h.machine.transition("VOTING_ROUND");
    h.manager.open(donationRequest()); // banks

    h.manager.revoke();

    expect(h.manager.pendingSnapshot()).toBeNull();
    expect(h.machine.mode).toBe("VOTING_ROUND"); // pending never held the mode
    const row = h.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    expect(row.status).toBe("revoked");
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_revoked" })).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.pending).toBe(true);

    // With neither active nor pending, revoke() stays a harmless no-op.
    expect(() => h.manager.revoke()).not.toThrow();
    expect(listAuditRecords(h.db, { limit: 10, eventType: "window_revoked" })).toHaveLength(1);
  });
});

describe("ControlWindow pending restore (quick-260716-h73 crash safety: never lost, never double-opened)", () => {
  function makeManager(
    db: ReturnType<typeof openDb>,
    machine: StreamModeMachine,
    nowMs: number,
  ): ControlWindow {
    return new ControlWindow({
      db,
      machine,
      submitDuringWindow: vi.fn(async () => ({ queued: true }) as { queued: true }),
      donationConfig: DONATION_CFG,
      redemptionConfig: REDEMPTION_CFG,
      cooldownMs: COOLDOWN_MS,
      now: () => nowMs,
    });
  }

  it("a pending row + IDLE machine at restore(): opens IMMEDIATELY with the FULL duration from restore-time", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO control_windows
         (trigger_type, donor_identifier, amount_or_cost, duration_ms, opened_at_ms, ends_at_ms, status)
       VALUES ('donation', 'viewer_a', 5, 60000, 1000, 61000, 'pending')`,
    ).run();

    const machine = new StreamModeMachine();
    const manager = makeManager(db, machine, 200_000);
    manager.restore();

    expect(machine.mode).toBe("FREE_REIGN_WINDOW");
    expect(manager.pendingSnapshot()).toBeNull();
    const snap = manager.snapshot();
    // FULL duration from restore-time — the provisional bank-time deadline is dead.
    expect(snap?.endsAtMs).toBe(260_000); // 200000 + 60000
    const row = db
      .prepare("SELECT status, opened_at_ms, ends_at_ms FROM control_windows LIMIT 1")
      .get() as { status: string; opened_at_ms: number; ends_at_ms: number };
    expect(row.status).toBe("active");
    expect(row.opened_at_ms).toBe(200_000);
    expect(row.ends_at_ms).toBe(260_000);
    manager.dispose();
    db.close();
  });

  it("a pending row + BUSY machine at restore(): restores as in-memory pending, opens on the LATER return to IDLE", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO control_windows
         (trigger_type, donor_identifier, amount_or_cost, duration_ms, opened_at_ms, ends_at_ms, status)
       VALUES ('donation', 'viewer_a', 5, 60000, 1000, 61000, 'pending')`,
    ).run();

    const machine = new StreamModeMachine();
    machine.transition("VOTING_ROUND"); // boot restored into a busy mode
    const manager = makeManager(db, machine, 200_000);
    manager.restore();

    // Still pending: no open, no transition, nothing lost.
    expect(machine.mode).toBe("VOTING_ROUND");
    expect(manager.snapshot()).toBeNull();
    expect(manager.pendingSnapshot()).not.toBeNull();

    machine.transition("IDLE"); // the round ends → promote fires
    expect(machine.mode).toBe("FREE_REIGN_WINDOW");
    expect(manager.snapshot()?.endsAtMs).toBe(260_000);
    expect(manager.pendingSnapshot()).toBeNull();
    manager.dispose();
    db.close();
  });

  it("never double-opened: after a promote, a fresh restore() reads the row as ACTIVE with the promoted deadline", () => {
    const db = openDb(":memory:");
    const machine1 = new StreamModeMachine();
    machine1.transition("BUILD_IN_PROGRESS");
    let t = 1_000;
    const manager1 = new ControlWindow({
      db,
      machine: machine1,
      submitDuringWindow: vi.fn(async () => ({ queued: true }) as { queued: true }),
      donationConfig: DONATION_CFG,
      redemptionConfig: REDEMPTION_CFG,
      cooldownMs: COOLDOWN_MS,
      now: () => t,
    });
    manager1.open(donationRequest()); // banks at 1000
    t = 2_000;
    machine1.transition("IDLE"); // promotes: opened 2000, ends 62000
    expect(manager1.snapshot()?.endsAtMs).toBe(62_000);
    manager1.dispose();

    // Crash + restart: a fresh FSM on the SAME db finds NO pending row —
    // only the promoted ACTIVE row with its authoritative deadline.
    const machine2 = new StreamModeMachine();
    const manager2 = makeManager(db, machine2, 10_000);
    manager2.restore();
    expect(manager2.pendingSnapshot()).toBeNull();
    expect(manager2.snapshot()?.endsAtMs).toBe(62_000); // the PROMOTED deadline, not a fresh one
    expect(machine2.mode).toBe("FREE_REIGN_WINDOW");
    manager2.dispose();
    db.close();
  });
});

describe("ControlWindow expiry + revoke (D-12, PAID-03)", () => {
  it("the expiry timer closes the window as expired and reverts to IDLE (full duration, D-12)", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const closed: ControlWindowSnapshot[] = [];
      h.manager.on(WINDOW_CLOSED, (s) => closed.push(s as ControlWindowSnapshot));
      h.manager.open(donationRequest());

      // Nothing fires before the full amount-proportional duration elapses.
      vi.advanceTimersByTime(59_000);
      expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");

      vi.advanceTimersByTime(1_000); // reaches 60s
      expect(h.machine.mode).toBe("IDLE");
      expect(closed).toHaveLength(1);

      const row = h.db
        .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
        .get() as { status: string };
      expect(row.status).toBe("expired");
      const audit = listAuditRecords(h.db, { limit: 10, eventType: "window_expired" });
      expect(audit).toHaveLength(1);
      h.manager.dispose();
      h.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revoke() closes as revoked and reverts to IDLE — no new abort pathway", () => {
    const h = makeHarness();
    const revoked: ControlWindowSnapshot[] = [];
    h.manager.on(WINDOW_REVOKED, (s) => revoked.push(s as ControlWindowSnapshot));
    h.manager.open(donationRequest());

    h.manager.revoke();

    expect(h.machine.mode).toBe("IDLE");
    expect(h.manager.snapshot()).toBeNull();
    expect(revoked).toHaveLength(1);
    const row = h.db
      .prepare("SELECT status, closed_at_ms FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as { status: string; closed_at_ms: number | null };
    expect(row.status).toBe("revoked");
    expect(row.closed_at_ms).toBe(1_000);
    const audit = listAuditRecords(h.db, { limit: 10, eventType: "window_revoked" });
    expect(audit).toHaveLength(1);
    h.manager.dispose();
    h.db.close();
  });

  it("revoke() with no active window is a harmless no-op", () => {
    const h = makeHarness();
    expect(() => h.manager.revoke()).not.toThrow();
    expect(h.machine.mode).toBe("IDLE");
    h.db.close();
  });
});

describe("ControlWindow halt symmetry (halt-aware, reuses Phase 1 machinery)", () => {
  it("a HALT freezes the window and IDLE-recovery discards it (revoked + audit, machine IDLE)", () => {
    const h = makeHarness();
    h.manager.open(donationRequest());

    h.machine.forceTransition("HALTED", haltCtx(h.machine)); // freezes the timer
    expect(h.manager.snapshot()).not.toBeNull(); // still loaded while frozen

    h.machine.recoverTo("IDLE"); // triage → reset to idle → discard
    expect(h.manager.snapshot()).toBeNull();
    expect(h.machine.mode).toBe("IDLE");
    const row = h.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    expect(row.status).toBe("revoked");
    const audit = listAuditRecords(h.db, { limit: 10, eventType: "window_revoked" });
    expect(audit).toHaveLength(1);
    h.manager.dispose();
    h.db.close();
  });

  it("a HALT then FREE_REIGN_WINDOW-recovery resumes the window from the ABSOLUTE deadline", () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.manager.open(donationRequest()); // ends at 61000
      h.setNow(21_000);
      h.machine.forceTransition("HALTED", haltCtx(h.machine));
      // Resume: the window re-arms from ends_at_ms (61000) - now (21000) = 40000.
      h.machine.recoverTo("FREE_REIGN_WINDOW");
      expect(h.manager.snapshot()).not.toBeNull();
      vi.advanceTimersByTime(39_999);
      expect(h.manager.snapshot()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(h.manager.snapshot()).toBeNull();
      expect(h.machine.mode).toBe("IDLE");
      h.manager.dispose();
      h.db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ControlWindow.submitInstruction (D-11 open slot, D-12 full duration)", () => {
  it("routes the candidate to the INJECTED funnel and returns its result", async () => {
    const h = makeHarness();
    h.manager.open(donationRequest());
    const cand = candidate("c1");
    const result = await h.manager.submitInstruction(cand);
    expect(result).toEqual({ queued: true });
    expect(h.submit).toHaveBeenCalledWith(cand);
  });

  it("a rejected/held submission leaves the window OPEN with endsAtMs unchanged (never shortens)", async () => {
    const submit = vi.fn(async () => ({ queued: false, reason: "rejected" }) as const);
    const h = makeHarness({ submit });
    const before = h.manager.open(donationRequest());
    const result = await h.manager.submitInstruction(candidate("c1"));
    expect(result).toEqual({ queued: false, reason: "rejected" });
    // Window still active, deadline untouched — time is not consumed (D-12).
    const after = h.manager.snapshot();
    expect(after).not.toBeNull();
    expect(after?.endsAtMs).toBe(before.endsAtMs);
    expect(h.machine.mode).toBe("FREE_REIGN_WINDOW");
    h.manager.dispose();
    h.db.close();
  });
});

describe("ControlWindow.restore (crash safety, D-06/PAID-04/T-04-08)", () => {
  it("a window whose ends_at_ms passed during downtime closes as expired on restore", () => {
    const h = makeHarness();
    h.manager.open(donationRequest()); // opened 1000, ends 61000
    h.manager.dispose();

    const machine2 = new StreamModeMachine();
    const manager2 = new ControlWindow({
      db: h.db,
      machine: machine2,
      submitDuringWindow: vi.fn(async () => ({ queued: true }) as { queued: true }),
      donationConfig: DONATION_CFG,
      redemptionConfig: REDEMPTION_CFG,
      cooldownMs: COOLDOWN_MS,
      now: () => 100_000, // past ends_at_ms 61000
    });
    manager2.restore();

    expect(manager2.snapshot()).toBeNull();
    expect(machine2.mode).toBe("IDLE");
    const row = h.db
      .prepare("SELECT status FROM control_windows ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    expect(row.status).toBe("expired");
    manager2.dispose();
    h.db.close();
  });

  it("a still-live window re-arms for EXACTLY the remaining time, never the full duration (D-06 linchpin)", () => {
    const h = makeHarness();
    const opened = h.manager.open(donationRequest()); // opened 1000, ends 61000, duration 60000
    h.manager.dispose();

    const machine2 = new StreamModeMachine();
    const manager2 = new ControlWindow({
      db: h.db,
      machine: machine2,
      submitDuringWindow: vi.fn(async () => ({ queued: true }) as { queued: true }),
      donationConfig: DONATION_CFG,
      redemptionConfig: REDEMPTION_CFG,
      cooldownMs: COOLDOWN_MS,
      now: () => 21_000, // 40s remain of the original 60s
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    manager2.restore();

    // The re-arm delay is the REMAINDER (40000), NOT the full duration (60000).
    const lastCall = setTimeoutSpy.mock.calls.at(-1);
    const delay = lastCall?.[1];
    expect(delay).toBe(40_000);
    expect(delay).not.toBe(60_000);
    setTimeoutSpy.mockRestore();

    // Restored window is coherent: machine reflects the live window, deadline intact.
    expect(machine2.mode).toBe("FREE_REIGN_WINDOW");
    expect(manager2.snapshot()?.endsAtMs).toBe(opened.endsAtMs);
    manager2.dispose();
    h.db.close();
  });

  it("restore() with no active row is a harmless no-op", () => {
    const h = makeHarness();
    expect(() => h.manager.restore()).not.toThrow();
    expect(h.manager.snapshot()).toBeNull();
    h.db.close();
  });

  it("WR-03: the per-donor cooldown survives a restart (rebuilt from the ledger, not reset)", () => {
    const h = makeHarness();
    h.manager.open(donationRequest()); // viewer_a granted at t=1000
    h.manager.revoke(); // window closed, but the grant persists in the ledger
    h.manager.dispose();

    // A fresh FSM on the SAME db, still WITHIN the cooldown window (elapsed
    // 1000ms << 120s cooldown). Before WR-03 the in-memory map was empty here,
    // so the donor could immediately re-open — the D-04 bypass this fixes.
    const machine2 = new StreamModeMachine();
    const manager2 = new ControlWindow({
      db: h.db,
      machine: machine2,
      submitDuringWindow: vi.fn(async () => ({ queued: true }) as { queued: true }),
      donationConfig: DONATION_CFG,
      redemptionConfig: REDEMPTION_CFG,
      cooldownMs: COOLDOWN_MS,
      now: () => 2_000, // 1s after the original grant — inside the 120s cooldown
    });
    manager2.restore();

    let caught: ControlWindowError | null = null;
    try {
      manager2.open(donationRequest());
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("cooldown");
    manager2.dispose();
    h.db.close();
  });
});
