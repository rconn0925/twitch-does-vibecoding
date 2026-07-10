import { describe, expect, it, vi } from "vitest";
import type { ApprovedCandidate } from "../queue/pool.js";
import { TaskQueue } from "../queue/task-queue.js";
import type { GateResult, StreamMode, SuggestionCandidate } from "../shared/types.js";
import { type SubmitChaosPickDeps, submitChaosPick } from "./chaos.js";

function candidate(id = "c1"): SuggestionCandidate {
  return {
    id,
    source: "chaos",
    kind: "suggestion",
    twitchUsername: "viewer",
    text: "build a clock",
    submittedAtMs: 0,
  };
}

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "ok" };

function pooled(id = "c1", addedAtMs = Date.now()): ApprovedCandidate {
  return { candidate: candidate(id), result: APPROVED, addedAtMs };
}

function deps(
  over: Partial<SubmitChaosPickDeps> & { mode?: StreamMode } = {},
): {
  deps: SubmitChaosPickDeps;
  queue: TaskQueue;
  resubmit: ReturnType<typeof vi.fn>;
} {
  const queue = new TaskQueue();
  const resubmit = vi.fn(() => ({ accepted: true as const, id: "c1" }));
  const d: SubmitChaosPickDeps = {
    taskQueue: queue,
    mode: () => over.mode ?? "CHAOS_MODE",
    resubmit: over.resubmit ?? resubmit,
    staleAfterMs: over.staleAfterMs,
  };
  return { deps: d, queue, resubmit };
}

describe("submitChaosPick — chaos single-funnel re-entry (CHAOS-01)", () => {
  it("refuses while HALTED without enqueueing or re-submitting", () => {
    const { deps: d, queue, resubmit } = deps({ mode: "HALTED" });
    const res = submitChaosPick(d, pooled());
    expect(res).toEqual({ queued: false, reason: "halted" });
    expect(queue.list()).toHaveLength(0);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("enqueues exactly one branded task via toQueuedTask for a fresh pick", () => {
    const { deps: d, queue, resubmit } = deps({ staleAfterMs: 60_000 });
    const res = submitChaosPick(d, pooled("chaos-1", Date.now()));
    expect(res).toEqual({ queued: true });
    const tasks = queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("chaos-1");
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("re-submits (narrates) a stale pick instead of silently re-rolling — never enqueues stale (Pitfall 3)", () => {
    const { deps: d, queue, resubmit } = deps({ staleAfterMs: 1_000 });
    // addedAtMs far in the past → past the staleness bound.
    const res = submitChaosPick(d, pooled("stale-1", Date.now() - 10_000));
    expect(res).toEqual({ queued: false, reason: "stale-reclassified" });
    expect(resubmit).toHaveBeenCalledOnce();
    expect(queue.list()).toHaveLength(0);
  });
});
