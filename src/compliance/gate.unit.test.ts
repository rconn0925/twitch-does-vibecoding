/**
 * Gate unit tests beyond the RED contract in gate.test.ts:
 * audit-exactly-once on every decision path, toQueuedTask() brand
 * construction rules, and the gate-level D-12 escalation guard.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import type { SuggestionCandidate } from "../shared/types.js";
import type { FakeClassifier } from "./gate.js";
import { classify, toQueuedTask } from "./gate.js";
import type { ClassifierDecision } from "./schema.js";

function makeCandidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "test_viewer",
    text: "build a todo app",
    submittedAtMs: Date.now(),
    ...overrides,
  };
}

function gateDecisionRows(db: Database.Database) {
  return db
    .prepare("SELECT * FROM audit_log WHERE event_type = 'gate_decision' ORDER BY id")
    .all() as Array<{
    decision: string;
    category: string | null;
    suggestion_text: string;
    twitch_username: string;
    stream_mode: string;
  }>;
}

describe("classify() audit trail (COMP-05: exactly one row per invocation)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("prefilter-reject path writes exactly one gate_decision row", async () => {
    const fakeClassifier: FakeClassifier = vi.fn(() => {
      throw new Error("must never be called — prefilter rejects first");
    });

    const result = await classify(
      { db, fakeClassifier },
      makeCandidate({ text: "build a keylogger" }),
    );

    expect(result.decision).toBe("rejected");
    expect(fakeClassifier).not.toHaveBeenCalled();
    const rows = gateDecisionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("rejected");
    expect(rows[0]?.suggestion_text).toBe("build a keylogger");
    expect(rows[0]?.twitch_username).toBe("test_viewer");
  });

  it("classifier-reject path writes exactly one row", async () => {
    const fakeClassifier: FakeClassifier = () =>
      ({
        decision: "rejected",
        category: "feasibility",
        rationale: "too big",
      }) satisfies ClassifierDecision;

    const result = await classify({ db, fakeClassifier }, makeCandidate());
    expect(result.decision).toBe("rejected");
    expect(gateDecisionRows(db)).toHaveLength(1);
  });

  it("approve path writes exactly one row", async () => {
    const fakeClassifier: FakeClassifier = () =>
      ({ decision: "approved", category: null, rationale: "clean" }) satisfies ClassifierDecision;

    const result = await classify({ db, fakeClassifier }, makeCandidate());
    expect(result.decision).toBe("approved");
    const rows = gateDecisionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("approved");
  });

  it("hold path writes exactly one row", async () => {
    const fakeClassifier: FakeClassifier = () =>
      ({
        decision: "held-for-review",
        category: "gambling",
        rationale: "play-money gray zone",
      }) satisfies ClassifierDecision;

    const result = await classify({ db, fakeClassifier }, makeCandidate());
    expect(result.decision).toBe("held-for-review");
    expect(gateDecisionRows(db)).toHaveLength(1);
  });

  it("fail-closed path (throwing classifier) writes exactly one row", async () => {
    const fakeClassifier: FakeClassifier = () => {
      throw new Error("network down");
    };

    const result = await classify({ db, fakeClassifier }, makeCandidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
    const rows = gateDecisionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("classifier-unavailable");
  });

  it("no classifier wired at all fails closed with exactly one row", async () => {
    const result = await classify({ db }, makeCandidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
    expect(gateDecisionRows(db)).toHaveLength(1);
  });

  it("records the streamModeProvider's mode on the audit row", async () => {
    const fakeClassifier: FakeClassifier = () =>
      ({ decision: "approved", category: null, rationale: "clean" }) satisfies ClassifierDecision;

    await classify(
      { db, fakeClassifier, streamModeProvider: () => "VOTING_ROUND" },
      makeCandidate(),
    );
    expect(gateDecisionRows(db)[0]?.stream_mode).toBe("VOTING_ROUND");
  });

  it("gate-level D-12 guard: held-for-review with a non-escalate category is coerced to rejected", async () => {
    const fakeClassifier: FakeClassifier = () =>
      ({
        decision: "held-for-review",
        category: "harassment",
        rationale: "fake escalation outside the eligible set",
      }) satisfies ClassifierDecision;

    const result = await classify({ db, fakeClassifier }, makeCandidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("harassment");
    expect(gateDecisionRows(db)).toHaveLength(1);
    expect(gateDecisionRows(db)[0]?.decision).toBe("rejected");
  });
});

describe("toQueuedTask() — the single sanctioned QueuedTask constructor", () => {
  const candidate = makeCandidate();

  it("throws for a rejected result", () => {
    expect(() =>
      toQueuedTask(candidate, { decision: "rejected", category: "feasibility", rationale: "no" }),
    ).toThrow(/approved/);
  });

  it("throws for a held-for-review result", () => {
    expect(() =>
      toQueuedTask(candidate, {
        decision: "held-for-review",
        category: "gambling",
        rationale: "gray",
      }),
    ).toThrow(/approved/);
  });

  it("returns a branded copy of the candidate for an approved result", () => {
    const task = toQueuedTask(candidate, { decision: "approved", category: null, rationale: "ok" });
    expect(task).toEqual(candidate);
    expect(task).not.toBe(candidate);
  });
});
