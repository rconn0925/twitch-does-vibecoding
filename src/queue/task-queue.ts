/**
 * The build queue — accepts ONLY the branded QueuedTask type (COMP-01).
 *
 * The brand is constructible solely inside src/compliance/gate.ts's
 * toQueuedTask(); passing a raw SuggestionCandidate to enqueue() is a
 * compile error (proven by a @ts-expect-error in task-queue.test.ts).
 *
 * This module deliberately imports NOTHING from src/compliance/ — it only
 * consumes the branded type from shared/types.ts. The brand is a
 * compile-time-only guarantee (RESEARCH.md Pattern 1 caveat); the grep/test
 * gate on `toQueuedTask` being the sole brand assertion closes the loop.
 *
 * In-memory for Phase 1 — see src/queue/pool.ts for the persistence note.
 */

import type { QueuedTask } from "../shared/types.js";

export class TaskQueue {
  #tasks: QueuedTask[] = [];

  /** Enqueue a gate-approved, brand-typed task. No overload accepts SuggestionCandidate. */
  enqueue(task: QueuedTask): void {
    this.#tasks.push(task);
  }

  /** FIFO view of the queue. */
  list(): QueuedTask[] {
    return [...this.#tasks];
  }

  /** Remove a task by id; returns it for triage/veto audit trails. */
  remove(id: string): QueuedTask | undefined {
    const idx = this.#tasks.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;
    return this.#tasks.splice(idx, 1)[0];
  }
}
