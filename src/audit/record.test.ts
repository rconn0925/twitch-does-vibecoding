import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SuggestionCandidate } from "../shared/types.js";
import { openDb } from "./db.js";
import {
  listAuditRecords,
  recordGateDecision,
  recordHalt,
  recordReviewResolution,
  recordVeto,
} from "./record.js";

function candidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer_1",
    text: "build a leaderboard for chat activity",
    submittedAtMs: Date.now(),
    ...overrides,
  };
}

describe("audit record helpers (append-only ledger)", () => {
  it("recordHalt inserts exactly one halt row", () => {
    const db = openDb(":memory:");
    recordHalt(db, { source: "console", priorMode: "VOTING_ROUND", reasonTag: "gut-feeling" });
    const rows = listAuditRecords(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("halt");
    expect(rows[0]?.source).toBe("console");
    expect(rows[0]?.stream_mode).toBe("VOTING_ROUND");
    expect(rows[0]?.category).toBe("gut-feeling");
    db.close();
  });

  it("recordVeto inserts exactly one veto row", () => {
    const db = openDb(":memory:");
    recordVeto(db, {
      taskId: "task-9",
      suggestionText: "something vetoed",
      twitchUsername: "viewer_2",
      reasonTag: "boring",
      streamMode: "BUILD_IN_PROGRESS",
    });
    const rows = listAuditRecords(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("veto");
    expect(rows[0]?.task_id).toBe("task-9");
    db.close();
  });

  it("recordGateDecision inserts exactly one gate_decision row with the full picture (D-16)", () => {
    const db = openDb(":memory:");
    recordGateDecision(db, {
      candidate: candidate(),
      decision: "rejected",
      category: "spam-malware",
      rationale: "requests malicious tooling",
      streamMode: "IDLE",
    });
    const rows = listAuditRecords(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("gate_decision");
    expect(rows[0]?.decision).toBe("rejected");
    expect(rows[0]?.suggestion_text).toBe("build a leaderboard for chat activity");
    expect(rows[0]?.twitch_username).toBe("viewer_1");
    expect(rows[0]?.rationale).toBe("requests malicious tooling");
    db.close();
  });

  it("recordReviewResolution inserts a review_resolved row", () => {
    const db = openDb(":memory:");
    recordReviewResolution(db, {
      reviewId: 42,
      resolution: "approved",
      suggestionText: "borderline IP thing",
      twitchUsername: "viewer_3",
      streamMode: "IDLE",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "review_resolved" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("approved");
    db.close();
  });

  it("listAuditRecords returns records newest-first and honors limit and eventType filters", () => {
    const db = openDb(":memory:");
    recordHalt(db, { source: "console", priorMode: "IDLE", reasonTag: null });
    recordVeto(db, {
      taskId: null,
      suggestionText: null,
      twitchUsername: null,
      reasonTag: null,
      streamMode: "IDLE",
    });
    recordHalt(db, { source: "hotkey", priorMode: "CHAOS_MODE", reasonTag: null });

    const all = listAuditRecords(db, { limit: 10 });
    expect(all).toHaveLength(3);
    // newest-first: autoincrement ids strictly descending
    expect(all[0]!.id).toBeGreaterThan(all[1]!.id);
    expect(all[1]!.id).toBeGreaterThan(all[2]!.id);
    expect(all[0]?.source).toBe("hotkey");

    const halts = listAuditRecords(db, { limit: 10, eventType: "halt" });
    expect(halts).toHaveLength(2);

    const limited = listAuditRecords(db, { limit: 1 });
    expect(limited).toHaveLength(1);
    db.close();
  });

  it("record.ts is structurally append-only: source contains no mutating SQL keywords", () => {
    const source = readFileSync(fileURLToPath(new URL("./record.ts", import.meta.url)), "utf8");
    // No occurrence anywhere — including comments — so the grep gate stays meaningful.
    expect(source).not.toMatch(/UPDATE|DELETE/i);
  });
});

describe("audit schema migration", () => {
  it("creates the review_queue table with full candidate-identity columns (D-06 reconstruction)", () => {
    const db = openDb(":memory:");
    const cols = db
      .prepare("PRAGMA table_info(review_queue)")
      .all()
      .map((c) => (c as { name: string }).name);
    for (const expected of [
      "id",
      "created_at_ms",
      "candidate_id",
      "source",
      "kind",
      "submitted_at_ms",
      "suggestion_text",
      "twitch_username",
      "category",
      "rationale",
      "status",
      "resolved_at_ms",
    ]) {
      expect(cols).toContain(expected);
    }
    db.close();
  });

  it("creates the audit_log table (append-only ledger, two-table split)", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => (t as { name: string }).name);
    expect(tables).toContain("audit_log");
    expect(tables).toContain("review_queue");
    db.close();
  });
});
