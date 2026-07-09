import { describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import type { ApprovedCandidate } from "../queue/pool.js";
import { TaskQueue } from "../queue/task-queue.js";
import type { GateResult, StreamMode, SuggestionCandidate } from "../shared/types.js";
import { type EnqueueWinnerDeps, enqueueWinner } from "./round.js";
import type { SubmitResult } from "./submit.js";

function makeCandidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    // Deliberately unicode-heavy: the byte-identity assertion below must catch
    // any re-derivation/normalization of pooled text (RESEARCH.md Security
    // Domain — the queued text is the ALREADY-GATED text, never re-derived).
    text: "build a snake game — with emoji \u{1F40D} and  double  spaces",
    submittedAtMs: 1_000,
    ...overrides,
  };
}

const APPROVED: GateResult = {
  decision: "approved",
  category: null,
  rationale: "fine for stream",
};

function makeApproved(overrides: Partial<ApprovedCandidate> = {}): ApprovedCandidate {
  return {
    candidate: makeCandidate(),
    result: APPROVED,
    addedAtMs: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EnqueueWinnerDeps> = {}): {
  deps: EnqueueWinnerDeps;
  taskQueue: TaskQueue;
  resubmit: ReturnType<typeof vi.fn>;
} {
  const taskQueue = new TaskQueue();
  const resubmit = vi.fn(
    (candidate: SuggestionCandidate): SubmitResult => ({ accepted: true, id: candidate.id }),
  );
  const deps: EnqueueWinnerDeps = {
    taskQueue,
    db: openDb(":memory:"),
    mode: (): StreamMode => "IDLE",
    resubmit,
    staleAfterMs: 60_000,
    ...overrides,
  };
  return { deps, taskQueue, resubmit };
}

describe("enqueueWinner (src/pipeline/round.ts — the winner→queue funnel entry)", () => {
  it("queues a fresh approved winner exactly once, text byte-identical to the pooled candidate", () => {
    const { deps, taskQueue, resubmit } = makeDeps();
    const approved = makeApproved();

    const outcome = enqueueWinner(deps, approved);

    expect(outcome).toEqual({ queued: true });
    const queued = taskQueue.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe(approved.candidate.text);
    expect(queued[0]?.id).toBe(approved.candidate.id);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("re-submits a stale winner through the gate instead of enqueueing (D2-05)", () => {
    const { deps, taskQueue, resubmit } = makeDeps();
    const approved = makeApproved({ addedAtMs: Date.now() - 120_000 }); // staleAfterMs is 60s

    const outcome = enqueueWinner(deps, approved);

    expect(outcome).toEqual({ queued: false, reason: "stale-reclassified" });
    expect(taskQueue.list()).toHaveLength(0);
    expect(resubmit).toHaveBeenCalledTimes(1);
    expect(resubmit).toHaveBeenCalledWith(approved.candidate);
  });

  it("uses the persisted pool-entry time for staleness — a fresh addedAtMs queues under the default bound", () => {
    // No staleAfterMs override: the WINNER_STALENESS_MINUTES default (360min)
    // applies, so a just-pooled winner must queue.
    const base = makeDeps();
    const deps: EnqueueWinnerDeps = { ...base.deps };
    delete deps.staleAfterMs;
    const approved = makeApproved({ addedAtMs: Date.now() });

    const outcome = enqueueWinner(deps, approved);

    expect(outcome).toEqual({ queued: true });
    expect(base.taskQueue.list()).toHaveLength(1);
  });

  it("refuses to queue while HALTED, without enqueueing or re-submitting (belt-and-suspenders)", () => {
    const { deps, taskQueue, resubmit } = makeDeps({ mode: () => "HALTED" });
    const approved = makeApproved();

    const outcome = enqueueWinner(deps, approved);

    expect(outcome).toEqual({ queued: false, reason: "halted" });
    expect(taskQueue.list()).toHaveLength(0);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("propagates toQueuedTask's throw for a non-approved gate result (COMP-01 stays loud)", () => {
    const { deps, taskQueue } = makeDeps();
    const approved = makeApproved({
      result: { decision: "rejected", category: "hate", rationale: "nope" },
    });

    expect(() => enqueueWinner(deps, approved)).toThrow(/approved/);
    expect(taskQueue.list()).toHaveLength(0);
  });
});
