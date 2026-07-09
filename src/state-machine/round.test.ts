import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { CandidatePool } from "../queue/pool.js";
import { ROUND_CLOSED, ROUND_OPENED, VOTE_RECORDED } from "../shared/events.js";
import type {
  GateResult,
  HaltContext,
  RoundSnapshot,
  SuggestionCandidate,
} from "../shared/types.js";
import type { EnqueueWinnerResult } from "./round.js";
import { RoundManager, RoundStartError, roundDurationMs } from "./round.js";
import { StreamModeMachine } from "./stream-mode.js";

function candidate(id: string, overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: `viewer_${id}`,
    text: `build idea ${id}`,
    submittedAtMs: 500,
    ...overrides,
  };
}

const approved: GateResult = {
  decision: "approved",
  category: null,
  rationale: "clean suggestion",
};

function haltCtx(machine: StreamModeMachine): HaltContext {
  return { source: "console", reasonTag: null, frozen: machine.snapshot() };
}

interface Harness {
  db: ReturnType<typeof openDb>;
  machine: StreamModeMachine;
  pool: CandidatePool;
  enqueueWinner: ReturnType<typeof vi.fn>;
  manager: RoundManager;
  now: () => number;
  setNow: (t: number) => void;
}

function makeHarness(opts: { candidates?: number; rng?: () => number } = {}): Harness {
  const db = openDb(":memory:");
  const machine = new StreamModeMachine();
  const pool = new CandidatePool();
  const count = opts.candidates ?? 3;
  for (let i = 1; i <= count; i++) {
    pool.add(candidate(`cand-${i}`), approved);
  }
  let t = 1_000;
  const now = (): number => t;
  const enqueueWinner = vi.fn((): EnqueueWinnerResult => ({ queued: true }));
  const manager = new RoundManager({
    db,
    machine,
    pool,
    enqueueWinner,
    now,
    rng: opts.rng,
  });
  return {
    db,
    machine,
    pool,
    enqueueWinner,
    manager,
    now,
    setNow: (next: number) => {
      t = next;
    },
  };
}

describe("roundDurationMs (D2-02 env knob)", () => {
  const saved = process.env.ROUND_DURATION_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ROUND_DURATION_SECONDS;
    else process.env.ROUND_DURATION_SECONDS = saved;
  });

  it("defaults to 60 seconds", () => {
    delete process.env.ROUND_DURATION_SECONDS;
    expect(roundDurationMs()).toBe(60_000);
  });

  it("honors ROUND_DURATION_SECONDS and rejects garbage", () => {
    process.env.ROUND_DURATION_SECONDS = "30";
    expect(roundDurationMs()).toBe(30_000);
    process.env.ROUND_DURATION_SECONDS = "not-a-number";
    expect(roundDurationMs()).toBe(60_000);
    process.env.ROUND_DURATION_SECONDS = "-5";
    expect(roundDurationMs()).toBe(60_000);
  });
});

describe("RoundManager.startRound (D2-01/D2-04)", () => {
  beforeEach(() => {
    delete process.env.ROUND_DURATION_SECONDS;
  });

  it("opens a round over 3 pooled candidates: transition, pool draw, persistence, audit, emit", () => {
    const h = makeHarness({ candidates: 4 });
    let emitted: RoundSnapshot | null = null;
    h.manager.on(ROUND_OPENED, (snap) => {
      emitted = snap as RoundSnapshot;
    });

    const snap = h.manager.startRound();

    expect(h.machine.mode).toBe("VOTING_ROUND");
    // first 3 in insertion order drawn, 4th remains
    expect(h.pool.list().map((a) => a.candidate.id)).toEqual(["cand-4"]);

    const rounds = h.db.prepare("SELECT * FROM rounds").all() as Record<string, unknown>[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("open");
    const rcs = h.db
      .prepare("SELECT * FROM round_candidates WHERE round_id = ? ORDER BY option_index")
      .all(snap.roundId) as Record<string, unknown>[];
    expect(rcs).toHaveLength(3);
    expect(rcs.map((r) => r.candidate_id)).toEqual(["cand-1", "cand-2", "cand-3"]);

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_opened" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.stream_mode).toBe("VOTING_ROUND");

    expect(emitted).not.toBeNull();
    expect((emitted as unknown as RoundSnapshot).roundId).toBe(snap.roundId);
    expect(snap.endsAtMs).toBe(snap.openedAtMs + roundDurationMs());
    expect(snap.candidates).toHaveLength(3);
    expect(snap.status).toBe("open");
    h.db.close();
  });

  it("runs with 2 pooled candidates (D2-04)", () => {
    const h = makeHarness({ candidates: 2 });
    const snap = h.manager.startRound();
    expect(snap.candidates).toHaveLength(2);
    expect(h.machine.mode).toBe("VOTING_ROUND");
    h.db.close();
  });

  it("throws pool-too-small with 1 or 0 candidates, without touching the pool", () => {
    for (const count of [0, 1]) {
      const h = makeHarness({ candidates: count });
      expect(() => h.manager.startRound()).toThrowError(RoundStartError);
      try {
        h.manager.startRound();
      } catch (err) {
        expect((err as RoundStartError).reason).toBe("pool-too-small");
      }
      expect(h.pool.list()).toHaveLength(count);
      expect(h.machine.mode).toBe("IDLE");
      h.db.close();
    }
  });

  it("throws not-idle when the machine is not IDLE, without touching the pool", () => {
    const h = makeHarness({ candidates: 3 });
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    try {
      h.manager.startRound();
      expect.unreachable("startRound should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RoundStartError);
      expect((err as RoundStartError).reason).toBe("not-idle");
    }
    expect(h.pool.list()).toHaveLength(3);
    h.db.close();
  });
});

describe("RoundManager.recordVote (CHAT-03/D2-14/D2-15)", () => {
  it("revote overwrites: one round_votes row with the later option; tally matches SQL", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();

    expect(h.manager.recordVote("111", 1)).toBe(true);
    expect(h.manager.recordVote("111", 2)).toBe(true);

    const rows = h.db
      .prepare("SELECT * FROM round_votes WHERE round_id = ? AND twitch_user_id = ?")
      .all(snap.roundId, "111") as { option_index: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.option_index).toBe(2);

    const mem = h.manager.snapshot();
    expect(mem?.candidates.find((c) => c.option === 1)?.votes).toBe(0);
    expect(mem?.candidates.find((c) => c.option === 2)?.votes).toBe(1);
    expect(mem?.totalVotes).toBe(1);

    const sqlTally = h.db
      .prepare(
        "SELECT option_index, COUNT(*) AS n FROM round_votes WHERE round_id = ? GROUP BY option_index",
      )
      .all(snap.roundId) as { option_index: number; n: number }[];
    for (const rc of mem?.candidates ?? []) {
      const sqlCount = sqlTally.find((r) => r.option_index === rc.option)?.n ?? 0;
      expect(rc.votes).toBe(sqlCount);
    }
    h.db.close();
  });

  it("persists the vote row BEFORE emitting VOTE_RECORDED (write-through, D2-14)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    let rowCountAtEmit = -1;
    h.manager.on(VOTE_RECORDED, () => {
      rowCountAtEmit = (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM round_votes WHERE round_id = ?")
          .get(snap.roundId) as { n: number }
      ).n;
    });
    h.manager.recordVote("111", 1);
    expect(rowCountAtEmit).toBe(1);
    h.db.close();
  });

  it("silently ignores invalid votes: bad option, no round open, wrong machine mode", () => {
    const h = makeHarness();

    // no round open yet
    expect(h.manager.recordVote("111", 1)).toBe(false);

    h.manager.startRound();
    // option out of range (3 candidates)
    expect(h.manager.recordVote("111", 4)).toBe(false);
    expect(h.manager.recordVote("111", 0)).toBe(false);

    // machine no longer VOTING_ROUND (halt) — vote refused
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    expect(h.manager.recordVote("111", 1)).toBe(false);

    const count = (h.db.prepare("SELECT COUNT(*) AS n FROM round_votes").get() as { n: number }).n;
    expect(count).toBe(0);
    h.db.close();
  });
});

describe("RoundManager.closeRound (D2-03/D2-05)", () => {
  it("clear leader: closes row, enqueues winner once with the persisted pooled_at_ms, returns losers", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 1);
    h.manager.recordVote("333", 2);

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });

    h.manager.closeRound();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBe(1);
    expect(row.tiebreak).toBe(0);

    expect(h.enqueueWinner).toHaveBeenCalledTimes(1);
    const [winCand, winResult, pooledAtMs] = h.enqueueWinner.mock.calls[0] as [
      SuggestionCandidate,
      GateResult,
      number,
    ];
    expect(winCand.id).toBe("cand-1");
    expect(winResult.decision).toBe("approved");
    const persisted = h.db
      .prepare("SELECT pooled_at_ms FROM round_candidates WHERE round_id = ? AND option_index = 1")
      .get(snap.roundId) as { pooled_at_ms: number };
    expect(pooledAtMs).toBe(persisted.pooled_at_ms);

    // losers back in the pool, winner not
    const pooledIds = h.pool.list().map((a) => a.candidate.id);
    expect(pooledIds).toContain("cand-2");
    expect(pooledIds).toContain("cand-3");
    expect(pooledIds).not.toContain("cand-1");

    expect(h.machine.mode).toBe("IDLE");

    const audit = listAuditRecords(h.db, { limit: 10, eventType: "round_closed" });
    expect(audit).toHaveLength(1);
    const tally = JSON.parse(audit[0]?.rationale ?? "{}") as Record<string, number>;
    expect(tally["1"]).toBe(2);
    expect(tally["2"]).toBe(1);

    expect(closed).not.toBeNull();
    expect((closed as unknown as RoundSnapshot).tiebreak).toBe(false);
    expect((closed as unknown as RoundSnapshot).winnerOption).toBe(1);
    h.db.close();
  });

  it("after crash-restore, closeRound still passes the ORIGINAL pooled_at_ms (survives via the row)", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 2);

    const persisted = h.db
      .prepare("SELECT pooled_at_ms FROM round_candidates WHERE round_id = ? AND option_index = 2")
      .get(snap.roundId) as { pooled_at_ms: number };

    // second manager on the same db, much later wall clock
    const enqueue2 = vi.fn((): EnqueueWinnerResult => ({ queued: true }));
    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueue2,
      now: () => 9_999_999,
    });
    manager2.restore();
    // ends_at_ms passed during downtime → restore() closed it immediately
    expect(enqueue2).toHaveBeenCalledTimes(1);
    const [, , pooledAtMs] = enqueue2.mock.calls[0] as [SuggestionCandidate, GateResult, number];
    expect(pooledAtMs).toBe(persisted.pooled_at_ms);
    h.db.close();
  });

  it("tie: picks only among tied leaders with the injected rng and flags tiebreak (D2-03)", () => {
    // rng → 0.99 picks the LAST tied leader; option 3 (0 votes) must never win
    const h = makeHarness({ rng: () => 0.99 });
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 2);

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });
    h.manager.closeRound();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.tiebreak).toBe(1);
    expect(row.winner_option).toBe(2); // last leader, never option 3
    expect((closed as unknown as RoundSnapshot).tiebreak).toBe(true);
    expect((closed as unknown as RoundSnapshot).winnerOption).toBe(2);
    expect(h.enqueueWinner).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it("zero votes: no winner, no enqueue, ALL candidates return to the pool", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    expect(h.pool.list()).toHaveLength(0);

    h.manager.closeRound();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBeNull();
    expect(h.enqueueWinner).not.toHaveBeenCalled();
    expect(h.pool.list().map((a) => a.candidate.id).sort()).toEqual([
      "cand-1",
      "cand-2",
      "cand-3",
    ]);
    expect(h.machine.mode).toBe("IDLE");
    h.db.close();
  });
});

describe("RoundManager halt-freeze (D2-16)", () => {
  it("a halt mid-round freezes the timer and persists frozen_remaining_ms", () => {
    const h = makeHarness();
    const snap = h.manager.startRound(); // opened at 1000, ends at 61000
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    const mem = h.manager.snapshot();
    expect(mem?.frozen).toBe(true);
    expect(mem?.remainingMs).toBe(40_000);

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.frozen_remaining_ms).toBe(40_000);
    expect(row.status).toBe("open");
    h.db.close();
  });

  it("recoverTo VOTING_ROUND resumes with endsAtMs = now + frozen remaining", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));
    h.setNow(500_000);
    h.machine.recoverTo("VOTING_ROUND");

    const mem = h.manager.snapshot();
    expect(mem?.frozen).toBe(false);
    expect(mem?.remainingMs).toBeNull();
    expect(mem?.endsAtMs).toBe(540_000);
    // votes accepted again after resume
    expect(h.manager.recordVote("111", 1)).toBe(true);
    h.db.close();
  });

  it("recoverTo IDLE discards: row status 'discarded', candidates return to the pool", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    let closed: RoundSnapshot | null = null;
    h.manager.on(ROUND_CLOSED, (s) => {
      closed = s as RoundSnapshot;
    });
    h.machine.recoverTo("IDLE");

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("discarded");
    expect(h.pool.list()).toHaveLength(3);
    expect(h.enqueueWinner).not.toHaveBeenCalled();
    expect((closed as unknown as RoundSnapshot).status).toBe("discarded");
    h.db.close();
  });
});

describe("RoundManager.restore (crash recovery, D2-14)", () => {
  it("a second manager on the same db reproduces roundId, candidates, tally, endsAtMs", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);
    h.manager.recordVote("222", 2);

    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: vi.fn((): EnqueueWinnerResult => ({ queued: true })),
      now: () => 30_000, // round still live (ends at 61000)
    });
    manager2.restore();

    const restored = manager2.snapshot();
    expect(restored?.roundId).toBe(snap.roundId);
    expect(restored?.endsAtMs).toBe(snap.endsAtMs);
    expect(restored?.candidates.map((c) => c.candidate.id)).toEqual([
      "cand-1",
      "cand-2",
      "cand-3",
    ]);
    expect(restored?.candidates.find((c) => c.option === 1)?.votes).toBe(1);
    expect(restored?.candidates.find((c) => c.option === 2)?.votes).toBe(1);
    expect(restored?.totalVotes).toBe(2);

    // revote by a pre-crash voter still overrides, not duplicates
    expect(manager2.recordVote("111", 3)).toBe(true);
    const rows = h.db
      .prepare("SELECT * FROM round_votes WHERE round_id = ? AND twitch_user_id = ?")
      .all(snap.roundId, "111") as { option_index: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.option_index).toBe(3);
    h.db.close();
  });

  it("a round whose ends_at_ms passed during downtime closes immediately on restore", () => {
    const h = makeHarness();
    const snap = h.manager.startRound();
    h.manager.recordVote("111", 1);

    const enqueue2 = vi.fn((): EnqueueWinnerResult => ({ queued: true }));
    const machine2 = new StreamModeMachine();
    machine2.transition("VOTING_ROUND");
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: enqueue2,
      now: () => 100_000, // past ends_at_ms 61000
    });
    manager2.restore();

    const row = h.db.prepare("SELECT * FROM rounds WHERE id = ?").get(snap.roundId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("closed");
    expect(row.winner_option).toBe(1);
    expect(enqueue2).toHaveBeenCalledTimes(1);
    expect(machine2.mode).toBe("IDLE");
    h.db.close();
  });

  it("restores a frozen round with its persisted remaining time (D2-16)", () => {
    const h = makeHarness();
    h.manager.startRound();
    h.setNow(21_000);
    h.machine.forceTransition("HALTED", haltCtx(h.machine));

    const machine2 = new StreamModeMachine();
    machine2.forceTransition("HALTED", haltCtx(machine2));
    const manager2 = new RoundManager({
      db: h.db,
      machine: machine2,
      pool: new CandidatePool(),
      enqueueWinner: vi.fn((): EnqueueWinnerResult => ({ queued: true })),
      now: () => 999_000,
    });
    manager2.restore();

    const restored = manager2.snapshot();
    expect(restored?.frozen).toBe(true);
    expect(restored?.remainingMs).toBe(40_000);
    h.db.close();
  });
});
