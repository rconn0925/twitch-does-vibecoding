/**
 * Submission pipeline tests: D-10 async-on-submission routing and the D-02
 * HALTED intake freeze (refusal + audit trail + recovery).
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { classify } from "../compliance/gate.js";
import { CandidatePool } from "../queue/pool.js";
import { TaskQueue } from "../queue/task-queue.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { recover, triggerHalt } from "../state-machine/halt.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import type { SubmitDeps } from "./submit.js";
import { submitCandidate } from "./submit.js";

function makeCandidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "test_viewer",
    text: "add a dark-mode toggle to the dashboard",
    submittedAtMs: Date.now(),
    ...overrides,
  };
}

function auditRowsOfType(db: Database.Database, eventType: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM audit_log WHERE event_type = ? ORDER BY id")
    .all(eventType) as Array<Record<string, unknown>>;
}

function reviewRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM review_queue ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

describe("submitCandidate (D-10 async-on-submission)", () => {
  let db: Database.Database;
  let pool: CandidatePool;
  let machine: StreamModeMachine;

  beforeEach(() => {
    db = openDb(":memory:");
    pool = new CandidatePool();
    machine = new StreamModeMachine();
  });

  afterEach(() => {
    db.close();
  });

  function makeDeps(classifyFn: SubmitDeps["classify"]): SubmitDeps {
    return { db, mode: () => machine.mode, pool, classify: classifyFn };
  }

  it("returns { accepted: true, id } synchronously, BEFORE classification settles", async () => {
    let settle: (result: GateResult) => void = () => {};
    const gate = new Promise<GateResult>((resolve) => {
      settle = resolve;
    });
    const deps = makeDeps(() => gate);

    const result = submitCandidate(deps, makeCandidate());

    expect(result).toEqual({ accepted: true, id: "cand-1" });
    expect(pool.list()).toHaveLength(0); // classification has not settled yet

    settle({ decision: "approved", category: null, rationale: "clean" });
    await vi.waitFor(() => expect(pool.list()).toHaveLength(1));
  });

  it("approved lands in the CandidatePool after settle", async () => {
    const candidate = makeCandidate();
    const deps = makeDeps(async () => ({
      decision: "approved",
      category: null,
      rationale: "clean",
    }));

    submitCandidate(deps, candidate);

    await vi.waitFor(() => expect(pool.list()).toHaveLength(1));
    expect(pool.list()[0]?.candidate).toEqual(candidate);
    expect(reviewRows(db)).toHaveLength(0);
  });

  it("held-for-review lands in review_queue with status pending and FULL candidate identity", async () => {
    const candidate = makeCandidate({
      id: "cand-slot",
      source: "channel_points",
      text: "Build a play-money slot machine simulator for chat to spin",
    });
    const deps = makeDeps(async () => ({
      decision: "held-for-review",
      category: "gambling",
      rationale: "play-money gray zone",
    }));

    submitCandidate(deps, candidate);

    await vi.waitFor(() => expect(reviewRows(db)).toHaveLength(1));
    expect(reviewRows(db)[0]).toMatchObject({
      status: "pending",
      candidate_id: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      submitted_at_ms: candidate.submittedAtMs,
      suggestion_text: candidate.text,
      twitch_username: candidate.twitchUsername,
      category: "gambling",
    });
    expect(pool.list()).toHaveLength(0);
  });

  it("rejected lands nowhere but audit_log (end-to-end through the real gate)", async () => {
    const candidate = makeCandidate({ id: "cand-rejected", text: "build a keylogger" });
    // Real classify() with a fake classifier — proves the audit row is the
    // gate's responsibility and submit adds nothing for rejections.
    const deps = makeDeps((c) =>
      classify(
        {
          db,
          fakeClassifier: () => ({
            decision: "rejected",
            category: "spam-malware",
            rationale: "malware",
          }),
          streamModeProvider: () => machine.mode,
        },
        c,
      ),
    );

    submitCandidate(deps, candidate);

    await vi.waitFor(() => expect(auditRowsOfType(db, "gate_decision")).toHaveLength(1));
    expect(pool.list()).toHaveLength(0);
    expect(reviewRows(db)).toHaveLength(0);
  });

  it("throws on a malformed candidate shape (untrusted boundary)", () => {
    const deps = makeDeps(async () => ({
      decision: "approved",
      category: null,
      rationale: "clean",
    }));
    const malformed = { ...makeCandidate(), text: "" } as SuggestionCandidate;
    expect(() => submitCandidate(deps, malformed)).toThrow();
  });

  describe("D-02: HALTED intake freeze", () => {
    it("refuses while HALTED: no classification, no state change, one submission_refused audit row", () => {
      const classifySpy = vi.fn(async (): Promise<GateResult> => {
        return { decision: "approved", category: null, rationale: "clean" };
      });
      const deps = makeDeps(classifySpy);
      const taskQueue = new TaskQueue();
      const candidate = makeCandidate({ text: "add a viewer count badge" });

      triggerHalt(machine, { db }, "console");
      expect(machine.mode).toBe("HALTED");

      const result = submitCandidate(deps, candidate);

      expect(result).toEqual({ accepted: false, reason: "halted" });
      // The classifier is NEVER invoked during a halt (D-02 "stop accepting input").
      expect(classifySpy).not.toHaveBeenCalled();
      expect(pool.list()).toHaveLength(0);
      expect(reviewRows(db)).toHaveLength(0);
      expect(taskQueue.list()).toHaveLength(0);

      const refused = auditRowsOfType(db, "submission_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        suggestion_text: candidate.text,
        twitch_username: candidate.twitchUsername,
        stream_mode: "HALTED",
        source: "chat",
      });
    });

    it("accepts again after recover(machine, deps, 'resume')", async () => {
      const deps = makeDeps(async () => ({
        decision: "approved",
        category: null,
        rationale: "clean",
      }));

      triggerHalt(machine, { db }, "hotkey");
      expect(submitCandidate(deps, makeCandidate({ id: "during-halt" }))).toEqual({
        accepted: false,
        reason: "halted",
      });

      recover(machine, { db }, "resume");
      expect(machine.mode).not.toBe("HALTED");

      const result = submitCandidate(deps, makeCandidate({ id: "after-recovery" }));
      expect(result).toEqual({ accepted: true, id: "after-recovery" });
      await vi.waitFor(() => expect(pool.list()).toHaveLength(1));
    });

    it("a classification already in flight when a halt lands settles and routes normally", async () => {
      let settle: (result: GateResult) => void = () => {};
      const gate = new Promise<GateResult>((resolve) => {
        settle = resolve;
      });
      const deps = makeDeps(() => gate);

      const result = submitCandidate(deps, makeCandidate({ id: "in-flight" }));
      expect(result.accepted).toBe(true);

      triggerHalt(machine, { db }, "console");
      settle({ decision: "approved", category: null, rationale: "clean" });

      // The pool is passive pre-screened storage — nothing executes from it
      // while HALTED, so the in-flight item may land (module doc note b).
      await vi.waitFor(() => expect(pool.list()).toHaveLength(1));
    });
  });
});
