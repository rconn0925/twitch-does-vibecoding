import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "../queue/task-queue.js";
import type { GateResult, StreamMode, SuggestionCandidate } from "../shared/types.js";
import { type PaidWindowFunnelDeps, submitDuringWindow } from "./paid-window.js";

function candidate(id = "c1"): SuggestionCandidate {
  return {
    id,
    source: "donation",
    kind: "suggestion",
    twitchUsername: "bigspender",
    text: "build a snake game",
    submittedAtMs: 0,
  };
}

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "ok" };
const REJECTED: GateResult = { decision: "rejected", category: "tos-risk", rationale: "no" };
const HELD: GateResult = { decision: "held-for-review", category: "gut-feeling", rationale: "hmm" };

function deps(
  over: Partial<PaidWindowFunnelDeps> & { result?: GateResult; mode?: StreamMode } = {},
): { deps: PaidWindowFunnelDeps; queue: TaskQueue; classify: ReturnType<typeof vi.fn> } {
  const queue = new TaskQueue();
  const classify = vi.fn(async () => over.result ?? APPROVED);
  const d: PaidWindowFunnelDeps = {
    taskQueue: queue,
    classify: over.classify ?? classify,
    mode: () => over.mode ?? "FREE_REIGN_WINDOW",
  };
  return { deps: d, queue, classify };
}

describe("submitDuringWindow — paid single-funnel re-entry (PAID-03)", () => {
  it("refuses while HALTED without classifying or enqueueing", async () => {
    const { deps: d, queue, classify } = deps({ mode: "HALTED" });
    const res = await submitDuringWindow(d, candidate());
    expect(res).toEqual({ queued: false, reason: "halted" });
    expect(classify).not.toHaveBeenCalled();
    expect(queue.list()).toHaveLength(0);
  });

  it("still passes the IDENTICAL gate — a rejected instruction is NOT enqueued (no exemption)", async () => {
    const { deps: d, queue, classify } = deps({ result: REJECTED });
    const res = await submitDuringWindow(d, candidate());
    expect(res).toEqual({ queued: false, reason: "rejected" });
    expect(classify).toHaveBeenCalledOnce();
    expect(queue.list()).toHaveLength(0);
  });

  it("maps a held-for-review decision to reason:'held' and does not enqueue", async () => {
    const { deps: d, queue } = deps({ result: HELD });
    const res = await submitDuringWindow(d, candidate());
    expect(res).toEqual({ queued: false, reason: "held" });
    expect(queue.list()).toHaveLength(0);
  });

  it("enqueues exactly one branded task via toQueuedTask on approval", async () => {
    const { deps: d, queue } = deps({ result: APPROVED });
    const res = await submitDuringWindow(d, candidate("paid-1"));
    expect(res).toEqual({ queued: true });
    const tasks = queue.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("paid-1");
  });
});
