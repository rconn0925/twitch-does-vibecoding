import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { WINDOW_CLOSED, WINDOW_OPENED, WINDOW_REVOKED } from "../shared/events.js";
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

  it("refuses opening when the stream is not IDLE (precedence): not-idle + window_denied(not-idle)", () => {
    h = makeHarness();
    h.machine.transition("VOTING_ROUND");
    let caught: ControlWindowError | null = null;
    try {
      h.manager.open(donationRequest());
    } catch (err) {
      caught = err as ControlWindowError;
    }
    expect(caught?.reason).toBe("not-idle");
    expect(h.machine.mode).toBe("VOTING_ROUND");

    // CR-01: a not-idle denial is NOT silent — it leaves a durable window_denied
    // row (reason "not-idle", captured in the mode the tip arrived in).
    const denied = listAuditRecords(h.db, { limit: 10, eventType: "window_denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.category).toBe("not-idle");
    expect(denied[0]?.stream_mode).toBe("VOTING_ROUND");
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
