/**
 * Pre-screened candidate pool (D-10, bounded per D2-13).
 *
 * Approved candidates land here after background classification; voting
 * rounds (Phase 2+) draw from this pool. The pool is PASSIVE storage —
 * nothing executes from it, so items already pooled when a halt lands are
 * safe to keep (the frozen queue is triaged via D-04). The POOL_CHANGED
 * event (quick-v4e) is a read-only change notification for broadcast
 * projections (the overlay's what's-coming page) — it never triggers
 * execution of anything in the pool.
 *
 * In-memory by design: suggestions do not persist across stream sessions —
 * the pool starts clean each night (D2-13). The audit ledger persists the
 * compliance record; evictions get their own audit row via onEvict.
 */

import { EventEmitter } from "node:events";
import { POOL_CHANGED } from "../shared/events.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";

/** A candidate plus the approved gate result that admitted it. */
export interface ApprovedCandidate {
  candidate: SuggestionCandidate;
  result: GateResult;
  addedAtMs: number;
}

export interface CandidatePoolOptions {
  /** Bound on pool size (D2-13); adding past it drops the OLDEST entry. Unbounded when absent. */
  maxSize?: number;
  /** Called once per dropped entry — the composition root records the audit row here. */
  onEvict?: (item: ApprovedCandidate) => void;
}

export class CandidatePool extends EventEmitter {
  readonly #items = new Map<string, ApprovedCandidate>();
  readonly #maxSize: number | undefined;
  readonly #onEvict: ((item: ApprovedCandidate) => void) | undefined;

  constructor(opts?: CandidatePoolOptions) {
    super();
    this.#maxSize = opts?.maxSize;
    this.#onEvict = opts?.onEvict;
  }

  /** Add an APPROVED candidate. Throws for any non-approved gate result. */
  add(candidate: SuggestionCandidate, result: GateResult): void {
    if (result.decision !== "approved") {
      throw new Error(
        `CandidatePool only accepts approved candidates, got "${result.decision}" (COMP-01)`,
      );
    }
    this.#items.set(candidate.id, { candidate, result, addedAtMs: Date.now() });
    if (this.#maxSize !== undefined && this.#items.size > this.#maxSize) {
      // Oldest = first Map insertion-order key (D2-13 oldest-drop).
      const oldestKey = this.#items.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.#items.get(oldestKey);
        this.#items.delete(oldestKey);
        if (evicted) this.#onEvict?.(evicted);
      }
    }
    // ONE emit at the end covers the add AND any eviction it caused —
    // listeners re-read list(), so a single notification is always enough.
    this.emit(POOL_CHANGED);
  }

  /** All pooled candidates, in insertion order. */
  list(): ApprovedCandidate[] {
    return [...this.#items.values()];
  }

  /** Remove a candidate by its id (drawn into a round, or vetoed). */
  remove(id: string): void {
    // Emit only when the id was actually present — no phantom pushes.
    if (this.#items.delete(id)) {
      this.emit(POOL_CHANGED);
    }
  }
}
