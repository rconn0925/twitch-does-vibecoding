/**
 * submitDuringWindow — the ONLY route from a donor instruction issued during an
 * ACTIVE control window to the build queue (PAID-03). A sanctioned single-funnel
 * entry point, listed by exact filename in tests/invariants/single-funnel.test.ts
 * check (d)'s allowlist: it may reference toQueuedTask, and its .enqueue( call is
 * permitted by check (b)'s src/pipeline/ rule.
 *
 * PAID-03 — guaranteed SELECTION, never a gate EXEMPTION: a paid instruction
 * skips the vote but still passes the IDENTICAL classify() every other candidate
 * source clears. There is NO code path around the gate. A rejected/held
 * instruction returns a typed reason (never silent) and is NOT enqueued.
 *
 * This is the concrete impl behind control-window.ts's injected
 * `submitDuringWindow` seam (T-04-09): ControlWindow only ever sees this
 * function, never the gate or the queue directly — the paid side of the D-08
 * separation. This file references payment context but NEVER an RNG (enforced by
 * tests/invariants/paid-chaos-separation.test.ts).
 */

import type { Logger } from "pino";
import { toQueuedTask } from "../compliance/gate.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { GateResult, StreamMode, SuggestionCandidate } from "../shared/types.js";

export interface PaidWindowFunnelDeps {
  taskQueue: TaskQueue;
  /** The compliance gate, pre-bound with its own deps (src/compliance/gate.ts classify). */
  classify: (candidate: SuggestionCandidate) => Promise<GateResult>;
  /** Current stream mode — a closure over the StreamModeMachine (D-02 gate). */
  mode: () => StreamMode;
  logger?: Logger;
}

/** Outcome of the paid funnel — matches control-window.ts's SubmitDuringWindow seam. */
export type PaidWindowResult =
  | { queued: true }
  | { queued: false; reason: "halted" | "rejected" | "held" };

/**
 * Route a donor instruction through the sanctioned funnel.
 *
 * - HALTED → refuse (belt-and-suspenders: nothing may reach the build queue
 *   while halted, even a paid instruction).
 * - Non-approved gate decision → typed { queued:false } reason, NOT enqueued
 *   (PAID-03: no exemption; the paid path is gated identically to the vote path).
 * - Approved → toQueuedTask(candidate, result) + enqueue.
 */
export async function submitDuringWindow(
  deps: PaidWindowFunnelDeps,
  candidate: SuggestionCandidate,
): Promise<PaidWindowResult> {
  if (deps.mode() === "HALTED") {
    deps.logger?.warn(
      { candidateId: candidate.id },
      "paid window instruction refused — stream is HALTED, nothing may reach the build queue",
    );
    return { queued: false, reason: "halted" };
  }

  // The IDENTICAL gate every candidate source clears (COMP-01..04, PAID-03).
  const result = await deps.classify(candidate);
  if (result.decision !== "approved") {
    const reason = result.decision === "held-for-review" ? "held" : "rejected";
    deps.logger?.info(
      { candidateId: candidate.id, decision: result.decision },
      "paid window instruction not queued — gate did not approve (never silent)",
    );
    return { queued: false, reason };
  }

  deps.taskQueue.enqueue(toQueuedTask(candidate, result));
  deps.logger?.info(
    { candidateId: candidate.id },
    "paid window instruction queued via the gate funnel (guaranteed selection, still gated)",
  );
  return { queued: true };
}
