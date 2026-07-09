import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { HALT_TRIGGERED, STATE_CHANGED } from "../shared/events.js";
import type { HaltContext, StreamMode } from "../shared/types.js";
import { recover, triggerHalt } from "./halt.js";
import { InvalidTransitionError, StreamModeMachine } from "./stream-mode.js";

const ALL_MODES: StreamMode[] = [
  "IDLE",
  "VOTING_ROUND",
  "BUILD_IN_PROGRESS",
  "FREE_REIGN_WINDOW",
  "CHAOS_MODE",
  "HALTED",
];

/** Drive a fresh machine to `target` using only legal transitions (or force for HALTED). */
function machineAt(target: StreamMode): StreamModeMachine {
  const m = new StreamModeMachine();
  switch (target) {
    case "IDLE":
      break;
    case "VOTING_ROUND":
      m.transition("VOTING_ROUND");
      break;
    case "BUILD_IN_PROGRESS":
      m.transition("VOTING_ROUND");
      m.transition("BUILD_IN_PROGRESS");
      break;
    case "FREE_REIGN_WINDOW":
      m.transition("FREE_REIGN_WINDOW");
      break;
    case "CHAOS_MODE":
      m.transition("CHAOS_MODE");
      break;
    case "HALTED":
      m.forceTransition("HALTED", haltCtx(m));
      break;
  }
  return m;
}

function haltCtx(m: StreamModeMachine): HaltContext {
  return { source: "console", reasonTag: null, frozen: m.snapshot() };
}

describe("StreamModeMachine", () => {
  it("starts in IDLE", () => {
    expect(new StreamModeMachine().mode).toBe("IDLE");
  });

  it("forceTransition to HALTED succeeds synchronously from EVERY state", () => {
    for (const start of ALL_MODES) {
      const m = machineAt(start);
      m.forceTransition("HALTED", haltCtx(m));
      // next line, no await — the HALT transition must be synchronous (D-02)
      expect(m.mode).toBe("HALTED");
    }
  });

  it("rejects invalid normal transitions with a typed error naming both states", () => {
    const m = new StreamModeMachine();
    expect(() => m.transition("BUILD_IN_PROGRESS")).toThrowError(InvalidTransitionError);
    try {
      m.transition("BUILD_IN_PROGRESS");
      expect.unreachable("transition should have thrown");
    } catch (err) {
      const e = err as InvalidTransitionError;
      expect(e.from).toBe("IDLE");
      expect(e.to).toBe("BUILD_IN_PROGRESS");
      // feeds UI-SPEC "Can't transition to {state} from {state}" error copy
      expect(e.message).toContain("BUILD_IN_PROGRESS");
      expect(e.message).toContain("IDLE");
    }
  });

  it("allows valid normal transitions (IDLE -> VOTING_ROUND) and emits state:changed", () => {
    const m = new StreamModeMachine();
    const handler = vi.fn();
    m.on(STATE_CHANGED, handler);
    m.transition("VOTING_ROUND");
    expect(m.mode).toBe("VOTING_ROUND");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("triggerHalt", () => {
  it("captures the pre-halt snapshot, emits halt:triggered, records exactly one audit row", () => {
    const db = openDb(":memory:");
    const m = machineAt("VOTING_ROUND");
    const onHalt = vi.fn();
    m.on(HALT_TRIGGERED, onHalt);

    const frozen = triggerHalt(m, { db }, "console");

    expect(m.mode).toBe("HALTED");
    expect(frozen.mode).toBe("VOTING_ROUND");
    expect(m.snapshot().haltContext?.frozen.mode).toBe("VOTING_ROUND");
    expect(onHalt).toHaveBeenCalledTimes(1);

    const rows = listAuditRecords(db, { limit: 10, eventType: "halt" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("console");
    expect(rows[0]?.stream_mode).toBe("VOTING_ROUND");
    db.close();
  });

  it("invokes the abortActiveWork extension point with the frozen snapshot, never blocking the halt", () => {
    const db = openDb(":memory:");
    const m = machineAt("BUILD_IN_PROGRESS");
    const abort = vi.fn(() => {
      throw new Error("abort hook exploded — halt must still succeed");
    });
    const frozen = triggerHalt(m, { db, abortActiveWork: abort }, "hotkey");
    expect(m.mode).toBe("HALTED");
    expect(abort).toHaveBeenCalledWith(frozen);
    db.close();
  });

  it("WR-04: a recordHalt ledger-write failure never unwinds the halt — state stays HALTED, failure logged", () => {
    const m = machineAt("VOTING_ROUND");
    const logger = { error: vi.fn() };
    // Every ledger write starts with db.prepare(); throwing here simulates a
    // SQLite failure (disk I/O, locked file) on the halt audit row.
    const explodingDb = {
      prepare() {
        throw new Error("SQLITE_IOERR: disk I/O error");
      },
    } as unknown as Parameters<typeof triggerHalt>[1]["db"];

    const frozen = triggerHalt(m, { db: explodingDb, logger }, "console");

    expect(m.mode).toBe("HALTED");
    expect(frozen.mode).toBe("VOTING_ROUND");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("recover", () => {
  it('"resume" restores the exact frozen prior mode', () => {
    const db = openDb(":memory:");
    const m = machineAt("VOTING_ROUND");
    triggerHalt(m, { db }, "console");
    recover(m, { db }, "resume");
    expect(m.mode).toBe("VOTING_ROUND");
    db.close();
  });

  it('"reset-to-idle" goes to IDLE', () => {
    const db = openDb(":memory:");
    const m = machineAt("CHAOS_MODE");
    triggerHalt(m, { db }, "console");
    recover(m, { db }, "reset-to-idle");
    expect(m.mode).toBe("IDLE");
    db.close();
  });

  it('"discard-and-resume" records a veto row and falls back to IDLE when prior mode was BUILD_IN_PROGRESS', () => {
    const db = openDb(":memory:");
    const m = machineAt("VOTING_ROUND");
    m.setActiveTask("task-123", null);
    m.transition("BUILD_IN_PROGRESS");
    triggerHalt(m, { db }, "console");
    recover(m, { db }, "discard-and-resume", "tos-risk");
    expect(m.mode).toBe("IDLE");
    const vetoes = listAuditRecords(db, { limit: 10, eventType: "veto" });
    expect(vetoes).toHaveLength(1);
    expect(vetoes[0]?.task_id).toBe("task-123");
    db.close();
  });

  it("throws if the machine is not HALTED", () => {
    const db = openDb(":memory:");
    const m = machineAt("IDLE");
    expect(() => recover(m, { db }, "resume")).toThrowError();
    db.close();
  });

  it("nothing auto-resumes: halt.ts contains no timer or interval", () => {
    const source = readFileSync(fileURLToPath(new URL("./halt.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });
});
