/**
 * submitCandidate — the ONLY intended ingestion entry point for ALL current
 * and future suggestion sources (Phase 2 chat, Phase 3 rounds, Phase 4 paid
 * channel-points/donations). Everything funnels through here into the
 * compliance gate (COMP-01).
 *
 * D-10 async-on-submission: the caller gets { accepted: true, id } back
 * immediately; classification runs on a floating background promise and
 * routes approved → CandidatePool, held-for-review → review_queue,
 * rejected → audit only.
 *
 * D-02 halt gating: while the stream mode is HALTED, intake is refused
 * synchronously — nothing is classified, pooled, or queued; one
 * submission_refused audit row is written. A classification already IN
 * FLIGHT when a halt lands is allowed to settle and route normally: the
 * pool is passive pre-screened storage, nothing executes from it while
 * HALTED, and the frozen queue is triaged via D-04.
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { z } from "zod";
import { recordSubmissionRefused } from "../audit/record.js";
import type { CandidatePool } from "../queue/pool.js";
import type { GateResult, StreamMode, SuggestionCandidate } from "../shared/types.js";
import { insertHeld } from "../state-machine/review-queue.js";

/**
 * Untrusted-boundary shape validation (viewer input is adversarial by
 * design). Throws ZodError on malformed candidates — ingestion adapters
 * must construct well-formed candidates before calling submitCandidate.
 */
const CandidateSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["chat", "channel_points", "donation", "chaos", "operator"]),
  kind: z.enum(["suggestion", "project-switch"]),
  twitchUsername: z.string().nullable(),
  text: z.string().min(1).max(2000),
  submittedAtMs: z.number().int().nonnegative(),
});

export interface SubmitDeps {
  db: Database.Database;
  /** Current stream mode — a closure over the StreamModeMachine (D-02 gate). */
  mode: () => StreamMode;
  pool: CandidatePool;
  /** The compliance gate, pre-bound with its own deps (src/compliance/gate.ts classify). */
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
  logger?: Logger;
}

export type SubmitResult = { accepted: true; id: string } | { accepted: false; reason: "halted" };

/**
 * Accept (or refuse) a candidate. Returns synchronously; classification and
 * routing happen in the background (D-10).
 */
export function submitCandidate(deps: SubmitDeps, candidate: SuggestionCandidate): SubmitResult {
  const parsed: SuggestionCandidate = CandidateSchema.parse(candidate);

  if (deps.mode() === "HALTED") {
    // D-02 "stop accepting input": refuse cheaply, synchronously, and
    // audit-visibly. No classification, no pooling, no queueing.
    recordSubmissionRefused(deps.db, { candidate: parsed, streamMode: "HALTED" });
    return { accepted: false, reason: "halted" };
  }

  // Floating promise (D-10): classify() itself never throws (fail-closed),
  // but routing (pool/review_queue writes) could — keep the guard.
  void deps
    .classify(parsed)
    .then((result) => {
      route(deps, parsed, result);
    })
    .catch((err: unknown) => {
      deps.logger?.error(
        { err, candidateId: parsed.id },
        "background classification/routing failed — candidate dropped (fail-closed)",
      );
    });

  return { accepted: true, id: parsed.id };
}

/** D-10 routing: approved → pool, held → review_queue, rejected → audit only. */
function route(deps: SubmitDeps, candidate: SuggestionCandidate, result: GateResult): void {
  switch (result.decision) {
    case "approved":
      deps.pool.add(candidate, result);
      return;
    case "held-for-review":
      insertHeld(deps.db, candidate, result);
      return;
    case "rejected":
      // classify() already wrote the gate_decision audit row — nothing else.
      return;
  }
}
