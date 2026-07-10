/**
 * submitChaosPick — the ONLY route from a chaos-mode selection to the build
 * queue (CHAOS-01). A sanctioned single-funnel entry point, listed by exact
 * filename in tests/invariants/single-funnel.test.ts check (d)'s allowlist: it
 * may reference toQueuedTask, and its .enqueue( call is permitted by check (b)'s
 * src/pipeline/ rule.
 *
 * Structurally identical to src/pipeline/round.ts's enqueueWinner: chaos changes
 * WHO gets picked from the already-gate-approved pool, never whether the pick
 * clears the funnel. It promotes an ALREADY-approved pool item using its stored
 * gate result, with the same D2-05 staleness bound — a pick whose pool approval
 * has aged out re-enters the full gate via resubmit instead of riding its stale
 * pass (Pitfall 3: narrate "that pick needs a re-check", NEVER silently re-roll).
 *
 * This is the chaos side of the D-08 separation: this file references randomness
 * context but NEVER a payment event (enforced by
 * tests/invariants/paid-chaos-separation.test.ts).
 */

import type { Logger } from "pino";
import { toQueuedTask } from "../compliance/gate.js";
import type { ApprovedCandidate } from "../queue/pool.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { StreamMode, SuggestionCandidate } from "../shared/types.js";
import type { SubmitResult } from "./submit.js";

export interface SubmitChaosPickDeps {
  taskQueue: TaskQueue;
  /** Current stream mode — a closure over the StreamModeMachine (D-02 gate). */
  mode: () => StreamMode;
  /** The re-classification path for stale picks: pipeline/submit.ts, pre-bound. */
  resubmit: (candidate: SuggestionCandidate) => SubmitResult;
  /** D2-05 staleness bound; defaults from CHAOS_STALENESS_MINUTES (360min). */
  staleAfterMs?: number;
  logger?: Logger;
}

/**
 * Outcome of promoting a chaos pick. "stale-reclassified" = the pool entry aged
 * past the staleness bound and was sent back through the gate (never a silent
 * re-roll — the pick is narrated, not swallowed).
 */
export type ChaosPickResult =
  | { queued: true }
  | { queued: false; reason: "halted" | "stale-reclassified" };

const DEFAULT_CHAOS_STALENESS_MINUTES = 360;

/** Staleness bound from CHAOS_STALENESS_MINUTES env (default 360min), in milliseconds. */
function chaosStalenessMs(): number {
  const raw = process.env.CHAOS_STALENESS_MINUTES;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAOS_STALENESS_MINUTES;
  return minutes * 60_000;
}

/**
 * Promote a chaos pick into the build queue through the sanctioned funnel.
 *
 * - HALTED → refuse (nothing may reach the build queue while halted).
 * - Stale approval (D2-05) → re-submit through the full compliance gate and
 *   narrate; do NOT silently re-roll (Pitfall 3).
 * - Otherwise → toQueuedTask(candidate, ORIGINAL stored result) + enqueue.
 *   A non-approved stored result propagates toQueuedTask's throw — loud, never
 *   swallowed (COMP-01).
 */
export function submitChaosPick(
  deps: SubmitChaosPickDeps,
  approved: ApprovedCandidate,
): ChaosPickResult {
  if (deps.mode() === "HALTED") {
    deps.logger?.warn(
      { candidateId: approved.candidate.id },
      "chaos pick refused — stream is HALTED, nothing may reach the build queue",
    );
    return { queued: false, reason: "halted" };
  }

  const staleAfterMs = deps.staleAfterMs ?? chaosStalenessMs();
  if (Date.now() - approved.addedAtMs > staleAfterMs) {
    deps.logger?.info(
      { candidateId: approved.candidate.id, addedAtMs: approved.addedAtMs, staleAfterMs },
      "chaos pick's gate approval is stale — re-classifying through the gate (D2-05, never a silent re-roll)",
    );
    deps.resubmit(approved.candidate);
    return { queued: false, reason: "stale-reclassified" };
  }

  const task = toQueuedTask(approved.candidate, approved.result);
  deps.taskQueue.enqueue(task);
  deps.logger?.info(
    { candidateId: approved.candidate.id },
    "chaos pick queued for the build via the gate funnel",
  );
  return { queued: true };
}
