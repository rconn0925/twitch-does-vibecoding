/**
 * Pre-screened candidate pool (D-10).
 *
 * Approved candidates land here after background classification; voting
 * rounds (Phase 2+) draw from this pool. The pool is PASSIVE storage —
 * nothing executes from it, so items already pooled when a halt lands are
 * safe to keep (the frozen queue is triaged via D-04).
 *
 * In-memory for Phase 1: the audit ledger already persists the compliance
 * record; durable queue persistence is a later-phase concern.
 */

import type { GateResult, SuggestionCandidate } from "../shared/types.js";

/** A candidate plus the approved gate result that admitted it. */
export interface ApprovedCandidate {
  candidate: SuggestionCandidate;
  result: GateResult;
  addedAtMs: number;
}

export class CandidatePool {
  readonly #items = new Map<string, ApprovedCandidate>();

  /** Add an APPROVED candidate. Throws for any non-approved gate result. */
  add(candidate: SuggestionCandidate, result: GateResult): void {
    if (result.decision !== "approved") {
      throw new Error(
        `CandidatePool only accepts approved candidates, got "${result.decision}" (COMP-01)`,
      );
    }
    this.#items.set(candidate.id, { candidate, result, addedAtMs: Date.now() });
  }

  /** All pooled candidates, in insertion order. */
  list(): ApprovedCandidate[] {
    return [...this.#items.values()];
  }

  /** Remove a candidate by its id (drawn into a round, or vetoed). */
  remove(id: string): void {
    this.#items.delete(id);
  }
}
