/**
 * Voting-round lifecycle manager (Phase 2, CHAT-02/CHAT-03).
 *
 * Owns the open → vote → close → winner/tiebreak cycle for streamer-triggered
 * rounds (D2-01), with three hard guarantees:
 *
 *   - Vote integrity (D2-15): one vote per viewer per round, keyed by Twitch
 *     numeric user id (EventSub chatterId — NEVER display name); a revote
 *     overwrites via a native SQLite upsert, so there is no read-then-write race.
 *   - Durability (D2-14): every vote is written through to the round_votes
 *     ledger BEFORE the in-memory tally moves or VOTE_RECORDED fires. A crash
 *     mid-round loses nothing acknowledged; restore() rebuilds the exact state.
 *   - Halt honesty (D2-16): a kill-switch halt freezes the round timer with
 *     the remaining time persisted; recovery triage resumes from that frozen
 *     remainder or discards the round back to the pool.
 *
 * Funnel isolation: the winner is handed to the INJECTED enqueueWinner
 * function (implemented under src/pipeline/ in plan 02-03). This module never
 * imports the queue or gate internals — the COMP-01 single-funnel invariant
 * scan must stay clean.
 */

import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { recordRoundClosed, recordRoundOpened } from "../audit/record.js";
import type { CandidatePool } from "../queue/pool.js";
import {
  HALT_TRIGGERED,
  ROUND_CLOSED,
  ROUND_OPENED,
  STATE_CHANGED,
  VOTE_RECORDED,
} from "../shared/events.js";
import type {
  CandidateKind,
  CandidateSource,
  GateResult,
  RoundSnapshot,
  RoundStatus,
  StateSnapshot,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";
import type { StreamModeMachine } from "./stream-mode.js";

/** Thrown by startRound() when the show is not in a startable state. */
export class RoundStartError extends Error {
  readonly reason: "not-idle" | "pool-too-small" | "round-active";

  constructor(reason: "not-idle" | "pool-too-small" | "round-active") {
    super(
      reason === "round-active"
        ? "Can't start a round while another round is still loaded"
        : reason === "not-idle"
          ? "Can't start a round unless the stream is IDLE"
          : "Can't start a round with fewer than 2 pooled candidates (D2-04)",
    );
    this.name = "RoundStartError";
    this.reason = reason;
  }
}

/**
 * Outcome of handing the winner to the pipeline funnel (plan 02-03).
 * "stale-reclassified" = the item aged past the D2-05 staleness bound and was
 * sent back through the gate instead of straight to the queue.
 */
export type EnqueueWinnerResult =
  | { queued: true }
  | { queued: false; reason: "stale-reclassified" | "halted" };

export interface RoundManagerDeps {
  db: Database.Database;
  machine: StreamModeMachine;
  pool: CandidatePool;
  /**
   * The ONLY bridge to the build queue (COMP-01). pooledAtMs is the winner's
   * pool-entry time read from its persisted round_candidates row — the D2-05
   * staleness input, which survives crash restore via that row.
   */
  enqueueWinner: (
    candidate: SuggestionCandidate,
    result: GateResult,
    pooledAtMs: number,
  ) => EnqueueWinnerResult;
  logger?: Logger;
  now?: () => number;
  /** Injectable RNG for deterministic tiebreak tests (D2-03). */
  rng?: () => number;
}

const DEFAULT_ROUND_DURATION_SECONDS = 60;

/** D2-02 round length from ROUND_DURATION_SECONDS env (default 60s), in milliseconds. */
export function roundDurationMs(): number {
  const raw = process.env.ROUND_DURATION_SECONDS;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROUND_DURATION_SECONDS;
  return seconds * 1_000;
}

/** One drawn option with its full identity and live vote count. */
interface StoredOption {
  option: number;
  candidate: SuggestionCandidate;
  result: GateResult;
  pooledAtMs: number;
  votes: number;
}

interface ActiveRound {
  roundId: number;
  status: RoundStatus;
  frozen: boolean;
  openedAtMs: number;
  durationMs: number;
  endsAtMs: number;
  frozenRemainingMs: number | null;
  winnerOption: number | null;
  tiebreak: boolean;
  options: StoredOption[];
  votesByUser: Map<string, number>;
}

/** Raw rounds row shape (snake_case, as stored). */
interface RoundRow {
  id: number;
  status: string;
  opened_at_ms: number;
  duration_ms: number;
  ends_at_ms: number;
  frozen_remaining_ms: number | null;
  closed_at_ms: number | null;
  winner_option: number | null;
  tiebreak: number;
}

/** Raw round_candidates row shape (snake_case, as stored). */
interface RoundCandidateRow {
  round_id: number;
  option_index: number;
  candidate_id: string;
  source: string;
  kind: string;
  twitch_username: string | null;
  text: string;
  submitted_at_ms: number;
  gate_category: string | null;
  gate_rationale: string;
  pooled_at_ms: number;
}

export class RoundManager {
  readonly #db: Database.Database;
  readonly #machine: StreamModeMachine;
  readonly #pool: CandidatePool;
  readonly #enqueueWinner: RoundManagerDeps["enqueueWinner"];
  readonly #logger: Logger | undefined;
  readonly #now: () => number;
  readonly #rng: () => number;
  readonly #emitter = new EventEmitter();
  readonly #upsertVote: Database.Statement;

  #round: ActiveRound | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastMode: StreamMode;

  constructor(deps: RoundManagerDeps) {
    this.#db = deps.db;
    this.#machine = deps.machine;
    this.#pool = deps.pool;
    this.#enqueueWinner = deps.enqueueWinner;
    this.#logger = deps.logger;
    this.#now = deps.now ?? Date.now;
    this.#rng = deps.rng ?? Math.random;
    this.#lastMode = deps.machine.mode;

    // The RESEARCH.md prepared statement: native upsert, one row per
    // (round, voter), last write wins — atomic revote override (D2-15).
    this.#upsertVote = this.#db.prepare(`
      INSERT INTO round_votes (round_id, twitch_user_id, option_index, voted_at_ms)
      VALUES (@roundId, @twitchUserId, @optionIndex, @votedAtMs)
      ON CONFLICT(round_id, twitch_user_id) DO UPDATE SET
        option_index = excluded.option_index,
        voted_at_ms = excluded.voted_at_ms
    `);

    // D2-16: a halt freezes an open round synchronously.
    this.#machine.on(HALT_TRIGGERED, () => {
      this.#freeze();
    });
    // Recovery triage (D-04): HALTED→VOTING_ROUND resumes, HALTED→IDLE discards.
    this.#machine.on(STATE_CHANGED, (...args: unknown[]) => {
      const snap = args[0] as StateSnapshot;
      const prev = this.#lastMode;
      this.#lastMode = snap.mode;
      if (prev !== "HALTED") return;
      if (snap.mode === "VOTING_ROUND") this.#resume();
      else if (snap.mode === "IDLE") this.#discard();
    });
  }

  /**
   * Streamer-triggered round open (D2-01 — the console route in plan 02-03 is
   * the only caller). Draws the first min(3, pool size) candidates in pool
   * insertion order; requires at least 2 (D2-04).
   */
  startRound(): RoundSnapshot {
    // CR-01: refuse while ANY round is still loaded — mode alone is not
    // enough (a crash-restored frozen round sits in memory while the machine
    // is IDLE). Overwriting #round would orphan its acknowledged votes and
    // strand its 'open' row forever (D2-14 / D-02).
    if (this.#round !== null) {
      throw new RoundStartError("round-active");
    }
    if (this.#machine.mode !== "IDLE") {
      throw new RoundStartError("not-idle");
    }
    const pooled = this.#pool.list();
    if (pooled.length < 2) {
      throw new RoundStartError("pool-too-small");
    }
    const drawn = pooled.slice(0, 3);
    const openedAtMs = this.#now();
    const durationMs = roundDurationMs();
    const endsAtMs = openedAtMs + durationMs;

    const info = this.#db
      .prepare(
        `INSERT INTO rounds (status, opened_at_ms, duration_ms, ends_at_ms)
         VALUES ('open', @openedAtMs, @durationMs, @endsAtMs)`,
      )
      .run({ openedAtMs, durationMs, endsAtMs });
    const roundId = Number(info.lastInsertRowid);

    const insertCandidate = this.#db.prepare(
      `INSERT INTO round_candidates
         (round_id, option_index, candidate_id, source, kind, twitch_username,
          text, submitted_at_ms, gate_category, gate_rationale, pooled_at_ms)
       VALUES
         (@roundId, @optionIndex, @candidateId, @source, @kind, @twitchUsername,
          @text, @submittedAtMs, @gateCategory, @gateRationale, @pooledAtMs)`,
    );
    const options: StoredOption[] = drawn.map((approved, i) => {
      insertCandidate.run({
        roundId,
        optionIndex: i + 1,
        candidateId: approved.candidate.id,
        source: approved.candidate.source,
        kind: approved.candidate.kind,
        twitchUsername: approved.candidate.twitchUsername,
        text: approved.candidate.text,
        submittedAtMs: approved.candidate.submittedAtMs,
        gateCategory: approved.result.category,
        gateRationale: approved.result.rationale,
        // Persisted pool-entry time — what closeRound() later hands to
        // enqueueWinner for the D2-05 staleness check.
        pooledAtMs: approved.addedAtMs,
      });
      return {
        option: i + 1,
        candidate: approved.candidate,
        result: approved.result,
        pooledAtMs: approved.addedAtMs,
        votes: 0,
      };
    });
    for (const approved of drawn) {
      this.#pool.remove(approved.candidate.id);
    }

    this.#round = {
      roundId,
      status: "open",
      frozen: false,
      openedAtMs,
      durationMs,
      endsAtMs,
      frozenRemainingMs: null,
      winnerOption: null,
      tiebreak: false,
      options,
      votesByUser: new Map(),
    };

    this.#machine.transition("VOTING_ROUND");
    recordRoundOpened(this.#db, {
      roundId,
      candidateCount: options.length,
      durationMs,
      streamMode: this.#machine.mode,
    });
    this.#armTimer(durationMs);

    const snap = this.#buildSnapshot(this.#round);
    this.#logger?.info(
      { roundId, candidateCount: options.length, durationMs },
      "voting round opened",
    );
    this.#emitter.emit(ROUND_OPENED, snap);
    return snap;
  }

  /**
   * Record one viewer's vote. Write-through FIRST (D2-14): the SQLite upsert
   * commits before the in-memory tally moves or VOTE_RECORDED fires. Invalid
   * votes are ignored silently (D2-15 — no chat noise).
   *
   * @param twitchUserId EventSub chatterId — Twitch numeric user id, never a
   *   display name (D2-15, RESEARCH.md Pitfall 2).
   */
  recordVote(twitchUserId: string, option: number): boolean {
    const round = this.#round;
    if (round?.status !== "open" || round.frozen) return false;
    if (this.#machine.mode !== "VOTING_ROUND") return false;
    if (!Number.isInteger(option) || option < 1 || option > round.options.length) return false;

    this.#upsertVote.run({
      roundId: round.roundId,
      twitchUserId,
      optionIndex: option,
      votedAtMs: this.#now(),
    });

    const previous = round.votesByUser.get(twitchUserId);
    if (previous !== option) {
      if (previous !== undefined) {
        const prevOption = round.options[previous - 1];
        if (prevOption) prevOption.votes -= 1;
      }
      const nextOption = round.options[option - 1];
      if (nextOption) nextOption.votes += 1;
      round.votesByUser.set(twitchUserId, option);
    }

    this.#emitter.emit(VOTE_RECORDED, this.#buildSnapshot(round));
    return true;
  }

  /**
   * Close the round: pick the winner (random among tied leaders, D2-03),
   * hand it to the injected funnel with its PERSISTED pooled_at_ms (D2-05),
   * return the losers (or, on zero votes, everyone) to the pool.
   */
  closeRound(): void {
    const round = this.#round;
    if (round?.status !== "open") return;
    this.#clearTimer();

    const totalVotes = round.options.reduce((sum, o) => sum + o.votes, 0);
    let winnerOption: number | null = null;
    let tiebreak = false;
    if (totalVotes > 0) {
      const max = Math.max(...round.options.map((o) => o.votes));
      const leaders = round.options.filter((o) => o.votes === max);
      if (leaders.length === 1) {
        winnerOption = leaders[0]?.option ?? null;
      } else {
        tiebreak = true;
        const pick = Math.min(Math.floor(this.#rng() * leaders.length), leaders.length - 1);
        winnerOption = leaders[pick]?.option ?? null;
      }
    }

    const closedAtMs = this.#now();
    this.#db
      .prepare(
        `UPDATE rounds
         SET status = 'closed', closed_at_ms = @closedAtMs,
             winner_option = @winnerOption, tiebreak = @tiebreak,
             frozen_remaining_ms = NULL
         WHERE id = @roundId`,
      )
      .run({
        closedAtMs,
        winnerOption,
        tiebreak: tiebreak ? 1 : 0,
        roundId: round.roundId,
      });
    round.status = "closed";
    round.frozen = false;
    round.frozenRemainingMs = null;
    round.winnerOption = winnerOption;
    round.tiebreak = tiebreak;

    let winner: StoredOption | undefined;
    if (winnerOption === null) {
      // Zero votes: no winner, everyone returns to the pool (UI-SPEC beat).
      for (const option of round.options) {
        this.#pool.add(option.candidate, option.result);
      }
    } else {
      winner = round.options[winnerOption - 1];
      if (winner) {
        // Read pooled_at_ms from the persisted row — NEVER now(); this is the
        // D2-05 staleness input and must survive crash restore via the row.
        const persisted = this.#db
          .prepare(
            "SELECT pooled_at_ms FROM round_candidates WHERE round_id = ? AND option_index = ?",
          )
          .get(round.roundId, winnerOption) as { pooled_at_ms: number } | undefined;
        const pooledAtMs = persisted?.pooled_at_ms ?? winner.pooledAtMs;
        const outcome = this.#enqueueWinner(winner.candidate, winner.result, pooledAtMs);
        if (!outcome.queued) {
          this.#logger?.warn(
            { roundId: round.roundId, reason: outcome.reason },
            "round winner was not queued",
          );
        }
      }
      for (const option of round.options) {
        if (option.option !== winnerOption) {
          this.#pool.add(option.candidate, option.result);
        }
      }
    }

    // A close can never fight a halt: only leave VOTING_ROUND if we're in it.
    if (this.#machine.mode === "VOTING_ROUND") {
      this.#machine.transition("IDLE");
    }

    recordRoundClosed(this.#db, {
      roundId: round.roundId,
      winnerText: winner?.candidate.text ?? null,
      winnerOption,
      tallySummary: JSON.stringify(this.#tallyObject(round)),
      tiebreak,
      streamMode: this.#machine.mode,
    });

    const snap = this.#buildSnapshot(round);
    this.#round = null;
    this.#logger?.info({ roundId: snap.roundId, winnerOption, tiebreak }, "voting round closed");
    this.#emitter.emit(ROUND_CLOSED, snap);
  }

  /** Point-in-time view of the current round, or null when none is loaded. */
  snapshot(): RoundSnapshot | null {
    return this.#round ? this.#buildSnapshot(this.#round) : null;
  }

  /**
   * Crash recovery (D2-14) — called at startup BEFORE any listener accepts
   * votes. Rebuilds candidates, tally, and timer state exclusively from
   * SQLite; a round that expired during downtime closes immediately.
   */
  restore(): void {
    const row = this.#db
      .prepare("SELECT * FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1")
      .get() as RoundRow | undefined;
    if (!row) return;

    const candidateRows = this.#db
      .prepare("SELECT * FROM round_candidates WHERE round_id = ? ORDER BY option_index")
      .all(row.id) as RoundCandidateRow[];
    const options: StoredOption[] = candidateRows.map((c) => ({
      option: c.option_index,
      candidate: {
        id: c.candidate_id,
        source: c.source as CandidateSource,
        kind: c.kind as CandidateKind,
        twitchUsername: c.twitch_username,
        text: c.text,
        submittedAtMs: c.submitted_at_ms,
      },
      // Pool items are approved by construction (COMP-01); the persisted
      // category/rationale restore the exact GateResult — no lossy defaults.
      result: {
        decision: "approved",
        category: c.gate_category,
        rationale: c.gate_rationale,
      },
      pooledAtMs: c.pooled_at_ms,
      votes: 0,
    }));

    const votesByUser = new Map<string, number>();
    const voteRows = this.#db
      .prepare("SELECT twitch_user_id, option_index FROM round_votes WHERE round_id = ?")
      .all(row.id) as { twitch_user_id: string; option_index: number }[];
    for (const vote of voteRows) {
      votesByUser.set(vote.twitch_user_id, vote.option_index);
      const option = options[vote.option_index - 1];
      if (option) option.votes += 1;
    }

    const frozen = row.frozen_remaining_ms !== null;
    this.#round = {
      roundId: row.id,
      status: "open",
      frozen,
      openedAtMs: row.opened_at_ms,
      durationMs: row.duration_ms,
      endsAtMs: row.ends_at_ms,
      frozenRemainingMs: row.frozen_remaining_ms,
      winnerOption: null,
      tiebreak: false,
      options,
      votesByUser,
    };
    this.#logger?.info(
      { roundId: row.id, votes: voteRows.length, frozen },
      "restored open round from SQLite",
    );

    if (frozen) return; // frozen rounds wait for recovery triage (D2-16)

    const remaining = row.ends_at_ms - this.#now();
    if (remaining <= 0) {
      this.closeRound();
      return;
    }
    this.#armTimer(remaining);
  }

  /**
   * Boot-time exit for a crash-restored FROZEN round (CR-01): the halt
   * context is never persisted, so after a restart no HALTED-mode triage
   * exists — the frozen round would otherwise be unrecoverable (and
   * silently corruptible). Policy: discard with the same semantics as
   * recovery-triage discard — the row goes 'discarded', candidates repool,
   * ROUND_CLOSED is emitted. Acknowledged votes stay in the round_votes
   * ledger (D-02: nothing is deleted).
   */
  discardRestoredFrozen(): void {
    this.#discard();
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.#emitter.on(event, handler);
  }

  /** D2-16: cancel the timer and persist the frozen remainder, synchronously. */
  #freeze(): void {
    const round = this.#round;
    if (round?.status !== "open" || round.frozen) return;
    this.#clearTimer();
    const remaining = Math.max(round.endsAtMs - this.#now(), 0);
    this.#db
      .prepare("UPDATE rounds SET frozen_remaining_ms = @remaining WHERE id = @roundId")
      .run({ remaining, roundId: round.roundId });
    round.frozen = true;
    round.frozenRemainingMs = remaining;
    this.#logger?.warn({ roundId: round.roundId, remaining }, "halt froze the voting round");
  }

  /** Resume a frozen round: new endsAtMs = now + frozen remainder. */
  #resume(): void {
    const round = this.#round;
    if (round?.status !== "open" || !round.frozen) return;
    const remaining = round.frozenRemainingMs ?? 0;
    const endsAtMs = this.#now() + remaining;
    this.#db
      .prepare(
        "UPDATE rounds SET ends_at_ms = @endsAtMs, frozen_remaining_ms = NULL WHERE id = @roundId",
      )
      .run({ endsAtMs, roundId: round.roundId });
    round.endsAtMs = endsAtMs;
    round.frozen = false;
    round.frozenRemainingMs = null;
    this.#armTimer(remaining);
    this.#logger?.info({ roundId: round.roundId, endsAtMs }, "frozen round resumed");
  }

  /** Recovery chose discard: round is dropped, all candidates return to the pool. */
  #discard(): void {
    const round = this.#round;
    if (round?.status !== "open" || !round.frozen) return;
    this.#clearTimer();
    this.#db
      .prepare(
        `UPDATE rounds
         SET status = 'discarded', closed_at_ms = @closedAtMs, frozen_remaining_ms = NULL
         WHERE id = @roundId`,
      )
      .run({ closedAtMs: this.#now(), roundId: round.roundId });
    round.status = "discarded";
    round.frozen = false;
    round.frozenRemainingMs = null;
    for (const option of round.options) {
      this.#pool.add(option.candidate, option.result);
    }
    const snap = this.#buildSnapshot(round);
    this.#round = null;
    this.#logger?.info({ roundId: snap.roundId }, "frozen round discarded — candidates repooled");
    this.#emitter.emit(ROUND_CLOSED, snap);
  }

  #armTimer(delayMs: number): void {
    this.#clearTimer();
    // main.ts sweep-timer idiom: unref'd so the timer never keeps the process alive.
    this.#timer = setTimeout(() => {
      this.closeRound();
    }, delayMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #tallyObject(round: ActiveRound): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const option of round.options) {
      tally[String(option.option)] = option.votes;
    }
    return tally;
  }

  #buildSnapshot(round: ActiveRound): RoundSnapshot {
    return {
      roundId: round.roundId,
      status: round.status,
      frozen: round.frozen,
      candidates: round.options.map((o) => ({
        option: o.option,
        candidate: { ...o.candidate },
        result: { ...o.result },
        votes: o.votes,
      })),
      openedAtMs: round.openedAtMs,
      endsAtMs: round.endsAtMs,
      remainingMs: round.frozen ? round.frozenRemainingMs : null,
      winnerOption: round.winnerOption,
      tiebreak: round.tiebreak,
      totalVotes: round.options.reduce((sum, o) => sum + o.votes, 0),
    };
  }
}
