/**
 * enqueueWinner — the ONLY route from a round winner to the build queue
 * (COMP-01). This is a sanctioned single-funnel entry point, listed by exact
 * filename in tests/invariants/single-funnel.test.ts's check (d) allowlist:
 * it may reference toQueuedTask, and its .enqueue( call is permitted by
 * check (b)'s src/pipeline/ rule.
 *
 * Deliberately narrow and SEPARATE from submit.ts: submitCandidate handles
 * NEW, unclassified candidates (full gate classification); this module
 * promotes ALREADY-approved pool items drawn into a round — two different
 * trust states (RESEARCH.md Structure Rationale).
 *
 * D2-05 staleness bound: a winner whose pool approval is older than
 * WINNER_STALENESS_MINUTES (default 360 — effectively never within one
 * stream session, since the pool starts clean each night per D2-13, but
 * honest against multi-hour marathon pools) is NOT enqueued on its old
 * pass. It re-enters submitCandidate for full re-classification instead.
 * The staleness input is approved.addedAtMs, populated from the winner's
 * PERSISTED round_candidates.pooled_at_ms (RoundManager's third callback
 * argument) — never a timestamp reconstructed at close time.
 *
 * The queued task's text is the pooled candidate's text, byte-identical —
 * never re-derived from raw chat (RESEARCH.md Security Domain).
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { toQueuedTask } from "../compliance/gate.js";
import type { ApprovedCandidate } from "../queue/pool.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { StreamMode, SuggestionCandidate } from "../shared/types.js";
import type { EnqueueWinnerResult } from "../state-machine/round.js";
import type { SubmitResult } from "./submit.js";

export interface EnqueueWinnerDeps {
  taskQueue: TaskQueue;
  db: Database.Database;
  /** Current stream mode — a closure over the StreamModeMachine (D-02 gate). */
  mode: () => StreamMode;
  /** The re-classification path for stale winners: pipeline/submit.ts, pre-bound. */
  resubmit: (candidate: SuggestionCandidate) => SubmitResult;
  /** D2-05 staleness bound; defaults from WINNER_STALENESS_MINUTES (360min). */
  staleAfterMs?: number;
  logger?: Logger;
}

const DEFAULT_WINNER_STALENESS_MINUTES = 360;

/** D2-05 staleness bound from WINNER_STALENESS_MINUTES env, in milliseconds. */
function winnerStalenessMs(): number {
  const raw = process.env.WINNER_STALENESS_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINNER_STALENESS_MINUTES;
  return minutes * 60_000;
}

/**
 * Promote a round winner into the build queue through the sanctioned funnel.
 *
 * - HALTED → refuse (belt-and-suspenders: RoundManager never closes a round
 *   while HALTED, but this funnel must be independently safe).
 * - Stale approval (D2-05) → re-submit through the full compliance gate.
 * - Otherwise → toQueuedTask(candidate, ORIGINAL stored result) + enqueue.
 *   A non-approved result propagates toQueuedTask's throw — loud, never
 *   swallowed (COMP-01).
 */
export function enqueueWinner(
  deps: EnqueueWinnerDeps,
  approved: ApprovedCandidate,
): EnqueueWinnerResult {
  if (deps.mode() === "HALTED") {
    deps.logger?.warn(
      { candidateId: approved.candidate.id },
      "round winner refused — stream is HALTED, nothing may reach the build queue",
    );
    return { queued: false, reason: "halted" };
  }

  const staleAfterMs = deps.staleAfterMs ?? winnerStalenessMs();
  if (Date.now() - approved.addedAtMs > staleAfterMs) {
    deps.logger?.info(
      { candidateId: approved.candidate.id, addedAtMs: approved.addedAtMs, staleAfterMs },
      "round winner's gate approval is stale — re-classifying through the gate (D2-05)",
    );
    deps.resubmit(approved.candidate);
    return { queued: false, reason: "stale-reclassified" };
  }

  const task = toQueuedTask(approved.candidate, approved.result);
  deps.taskQueue.enqueue(task);
  deps.logger?.info(
    { candidateId: approved.candidate.id },
    "round winner queued for the build via the gate funnel",
  );
  return { queued: true };
}
