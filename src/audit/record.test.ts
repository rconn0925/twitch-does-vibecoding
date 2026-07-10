import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SuggestionCandidate } from "../shared/types.js";
import { openDb } from "./db.js";
import {
  listAuditRecords,
  recordChaosPick,
  recordChaosToggled,
  recordGateDecision,
  recordHalt,
  recordPoolDropped,
  recordReviewResolution,
  recordRoundClosed,
  recordRoundOpened,
  recordVeto,
  recordWindowDenied,
  recordWindowExpired,
  recordWindowOpened,
  recordWindowRevoked,
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
    const ids = all.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(3);
    expect(all[0]?.source).toBe("hotkey");

    const halts = listAuditRecords(db, { limit: 10, eventType: "halt" });
    expect(halts).toHaveLength(2);

    const limited = listAuditRecords(db, { limit: 1 });
    expect(limited).toHaveLength(1);
    db.close();
  });

  it("recordRoundOpened inserts one round_opened row with stream mode captured", () => {
    const db = openDb(":memory:");
    recordRoundOpened(db, {
      roundId: 7,
      candidateCount: 3,
      durationMs: 60_000,
      streamMode: "VOTING_ROUND",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "round_opened" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("round_opened");
    expect(rows[0]?.source).toBe("operator");
    expect(rows[0]?.stream_mode).toBe("VOTING_ROUND");
    expect(rows[0]?.task_id).toBe("7");
    db.close();
  });

  it("recordRoundClosed inserts one round_closed row with the tally JSON in rationale (COMP-05)", () => {
    const db = openDb(":memory:");
    const tallySummary = JSON.stringify({ "1": 4, "2": 2, "3": 0 });
    recordRoundClosed(db, {
      roundId: 7,
      winnerText: "build a leaderboard for chat activity",
      winnerOption: 1,
      tallySummary,
      tiebreak: false,
      streamMode: "VOTING_ROUND",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "round_closed" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("round_closed");
    expect(rows[0]?.source).toBe("operator");
    expect(rows[0]?.rationale).toBe(tallySummary);
    expect(rows[0]?.suggestion_text).toBe("build a leaderboard for chat activity");
    expect(rows[0]?.task_id).toBe("7");
    db.close();
  });

  it("recordPoolDropped inserts one pool_dropped row with candidate text and username (D2-13)", () => {
    const db = openDb(":memory:");
    recordPoolDropped(db, { candidate: candidate(), streamMode: "IDLE" });
    const rows = listAuditRecords(db, { limit: 10, eventType: "pool_dropped" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("pool_dropped");
    expect(rows[0]?.source).toBe("chat");
    expect(rows[0]?.suggestion_text).toBe("build a leaderboard for chat activity");
    expect(rows[0]?.twitch_username).toBe("viewer_1");
    db.close();
  });

  it("recordWindowOpened inserts one window_opened row carrying the amount->duration mapping (PAID-04)", () => {
    const db = openDb(":memory:");
    recordWindowOpened(db, {
      trigger: "donation",
      donorIdentifier: "generous_donor",
      amountOrCost: 500,
      durationMs: 60_000,
      streamMode: "FREE_REIGN_WINDOW",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "window_opened" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("window_opened");
    expect(rows[0]?.source).toBe("donation");
    expect(rows[0]?.twitch_username).toBe("generous_donor");
    expect(rows[0]?.stream_mode).toBe("FREE_REIGN_WINDOW");
    // The amount->duration mapping text is present in the rationale (PAID-04).
    expect(rows[0]?.rationale).toContain("->");
    expect(rows[0]?.rationale).toContain("500");
    expect(rows[0]?.rationale).toContain("60000");
    db.close();
  });

  it("recordWindowExpired / recordWindowRevoked insert their lifecycle rows with the trigger as source", () => {
    const db = openDb(":memory:");
    recordWindowExpired(db, {
      trigger: "channel_points",
      donorIdentifier: "redeemer_1",
      streamMode: "FREE_REIGN_WINDOW",
    });
    recordWindowRevoked(db, {
      trigger: "donation",
      donorIdentifier: "donor_2",
      streamMode: "FREE_REIGN_WINDOW",
    });
    const expired = listAuditRecords(db, { limit: 10, eventType: "window_expired" });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.source).toBe("channel_points");
    expect(expired[0]?.twitch_username).toBe("redeemer_1");
    const revoked = listAuditRecords(db, { limit: 10, eventType: "window_revoked" });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.source).toBe("donation");
    db.close();
  });

  it("recordWindowDenied inserts a window_denied row with the reason in category (never-silent, D-05)", () => {
    const db = openDb(":memory:");
    recordWindowDenied(db, {
      trigger: "donation",
      donorIdentifier: "donor_3",
      reason: "cooldown",
      streamMode: "BUILD_IN_PROGRESS",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "window_denied" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("window_denied");
    expect(rows[0]?.category).toBe("cooldown");
    expect(rows[0]?.rationale).toContain("cooldown");
    db.close();
  });

  it("recordChaosToggled inserts a chaos_toggled row from the operator with the enabled state", () => {
    const db = openDb(":memory:");
    recordChaosToggled(db, { enabled: true, streamMode: "CHAOS_MODE" });
    const rows = listAuditRecords(db, { limit: 10, eventType: "chaos_toggled" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("operator");
    expect(rows[0]?.decision).toBe("enabled");
    expect(rows[0]?.stream_mode).toBe("CHAOS_MODE");
    db.close();
  });

  it("recordChaosPick inserts a chaos_pick row with source 'chaos' and the picked title/taskId", () => {
    const db = openDb(":memory:");
    recordChaosPick(db, {
      taskId: "task-42",
      title: "build a random number generator",
      streamMode: "CHAOS_MODE",
    });
    const rows = listAuditRecords(db, { limit: 10, eventType: "chaos_pick" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("chaos");
    expect(rows[0]?.task_id).toBe("task-42");
    expect(rows[0]?.suggestion_text).toBe("build a random number generator");
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

  it("creates the rounds / round_candidates / round_votes tables (Phase 2 vote ledger, D2-14)", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => (t as { name: string }).name);
    expect(tables).toContain("rounds");
    expect(tables).toContain("round_candidates");
    expect(tables).toContain("round_votes");
    db.close();
  });

  it("creates the control_windows table with the crash-safe ledger columns (PAID-04, D-06)", () => {
    const db = openDb(":memory:");
    const cols = db
      .prepare("PRAGMA table_info(control_windows)")
      .all()
      .map((c) => (c as { name: string }).name);
    for (const expected of [
      "id",
      "trigger_type",
      "donor_identifier",
      "amount_or_cost",
      "duration_ms",
      "opened_at_ms",
      "ends_at_ms",
      "status",
      "closed_at_ms",
    ]) {
      expect(cols).toContain(expected);
    }
    db.close();
  });

  it("round_votes upsert keeps exactly one row per (round_id, twitch_user_id) with the later option (D2-15)", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO rounds (opened_at_ms, duration_ms, ends_at_ms) VALUES (1000, 60000, 61000)",
    ).run();
    const upsert = db.prepare(
      `INSERT INTO round_votes (round_id, twitch_user_id, option_index, voted_at_ms)
       VALUES (@roundId, @twitchUserId, @optionIndex, @votedAtMs)
       ON CONFLICT(round_id, twitch_user_id) DO UPDATE SET
         option_index = excluded.option_index,
         voted_at_ms = excluded.voted_at_ms`,
    );
    upsert.run({ roundId: 1, twitchUserId: "111", optionIndex: 1, votedAtMs: 2000 });
    upsert.run({ roundId: 1, twitchUserId: "111", optionIndex: 2, votedAtMs: 3000 });
    const rows = db.prepare("SELECT * FROM round_votes WHERE round_id = 1").all() as {
      option_index: number;
      voted_at_ms: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.option_index).toBe(2);
    expect(rows[0]?.voted_at_ms).toBe(3000);
    db.close();
  });
});
