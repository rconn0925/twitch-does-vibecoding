import { describe, expect, it } from "vitest";
import { toQueuedTask } from "../compliance/gate.js";
import type { GateResult, SuggestionCandidate } from "../shared/types.js";
import { TaskQueue } from "./task-queue.js";

function makeCandidate(id: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: "test_viewer",
    text: `build feature ${id}`,
    submittedAtMs: Date.now(),
  };
}

const APPROVED: GateResult = { decision: "approved", category: null, rationale: "clean" };

describe("TaskQueue", () => {
  it("enqueues and lists gate-branded tasks in FIFO order", () => {
    const queue = new TaskQueue();
    queue.enqueue(toQueuedTask(makeCandidate("a"), APPROVED));
    queue.enqueue(toQueuedTask(makeCandidate("b"), APPROVED));

    expect(queue.list().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("remove() returns the removed task and drops it from the queue", () => {
    const queue = new TaskQueue();
    queue.enqueue(toQueuedTask(makeCandidate("a"), APPROVED));
    queue.enqueue(toQueuedTask(makeCandidate("b"), APPROVED));

    const removed = queue.remove("a");
    expect(removed?.id).toBe("a");
    expect(queue.list().map((t) => t.id)).toEqual(["b"]);
  });

  it("remove() returns undefined for unknown ids", () => {
    const queue = new TaskQueue();
    expect(queue.remove("nope")).toBeUndefined();
  });

  it("list() returns a copy — mutating it does not affect the queue", () => {
    const queue = new TaskQueue();
    queue.enqueue(toQueuedTask(makeCandidate("a"), APPROVED));
    queue.list().pop();
    expect(queue.list()).toHaveLength(1);
  });

  it("enqueue() only compiles with a QueuedTask — a raw SuggestionCandidate is a type error (COMP-01)", () => {
    const queue = new TaskQueue();
    const raw = makeCandidate("raw-1");
    // @ts-expect-error — a raw SuggestionCandidate lacks the QueuedTask brand;
    // only src/compliance/gate.ts's toQueuedTask() can construct one (COMP-01).
    queue.enqueue(raw);
    // Runtime is unbranded (the brand is compile-time only — RESEARCH.md
    // Pattern 1 caveat); the protection proven here is that tsc rejects the
    // line above, which @ts-expect-error asserts.
    expect(queue.list()).toHaveLength(1);
  });
});
