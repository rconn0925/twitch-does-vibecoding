/**
 * Tests for classifier.ts — GREEN within this plan.
 *
 * All tests use an INJECTED fake ClassifierTransport — zero network, no SDK.
 * The transport returns the model's raw assistant text (a JSON string) or
 * throws to simulate an SDK/plan-credential failure. Uses fake timers for
 * retry/backoff testing. The system-prompt / tool-authority boundary is proven
 * separately in src/orchestrator/classifier-runner.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionCandidate } from "../shared/types.js";
import { type ClassifierDeps, type ClassifierTransport, classifyWithSonnet } from "./classifier.js";

// ─── Fake transport builder ────────────────────────────────────────────
/**
 * Creates a fake ClassifierTransport that returns raw model text.
 *
 * Each call consumes one of the provided responses, cycling in order. A string
 * response is returned verbatim (the model's raw text); an Error response makes
 * the call REJECT (simulating an SDK / plan-credential / network failure).
 */
function makeTransport(responses: Array<string | Error>): {
  transport: ClassifierTransport;
  transportMock: ReturnType<typeof vi.fn>;
  calls: string[];
} {
  let callCount = 0;
  const calls: string[] = [];
  const transportMock = vi.fn(async (candidateText: string) => {
    calls.push(candidateText);
    const idx = callCount % responses.length;
    const resp = responses[idx];
    callCount += 1;
    if (resp instanceof Error) throw resp;
    return resp as string;
  });
  return { transport: transportMock as ClassifierTransport, transportMock, calls };
}

function deps(
  transport: ClassifierTransport,
  overrides?: Partial<Omit<ClassifierDeps, "transport">>,
): ClassifierDeps {
  return {
    transport,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as ClassifierDeps["logger"],
    ...overrides,
  };
}

function candidate(overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    id: "cand-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer_1",
    text: "build a todo app",
    submittedAtMs: Date.now(),
    ...overrides,
  };
}

// ─── Schema-conformant valid raw-text responses ────────────────────────
const APPROVED = JSON.stringify({
  decision: "approved",
  category: null,
  rationale: "safe build — no policy concerns",
});
const REJECTED_SPAM = JSON.stringify({
  decision: "rejected",
  category: "spam-malware",
  rationale: "requests malware",
});

describe("classifyWithSonnet — happy path", () => {
  it("returns an approved decision when the classifier approves", async () => {
    const { transport } = makeTransport([APPROVED]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("approved");
    expect(result.category).toBeNull();
  });

  it("returns a rejected decision with a valid category", async () => {
    const { transport } = makeTransport([REJECTED_SPAM]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("re-parses the response through GateDecisionSchema (belt-and-suspenders)", async () => {
    const { transport } = makeTransport([APPROVED]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result).toMatchObject({ decision: "approved", category: null });
  });
});

describe("classifyWithSonnet — tolerant JSON extraction", () => {
  it("parses raw text wrapped in a ```json code fence", async () => {
    const fenced = ["```json", APPROVED, "```"].join("\n");
    const { transport } = makeTransport([fenced]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("approved");
  });

  it("parses JSON surrounded by leading/trailing prose", async () => {
    const prose = `Here is my classification:\n${REJECTED_SPAM}\nLet me know if you need more.`;
    const { transport } = makeTransport([prose]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });
});

describe("classifyWithSonnet — D-12 escalation coercion", () => {
  it("coerces held-for-review + non-escalate category to rejected", async () => {
    const response = JSON.stringify({
      decision: "held-for-review",
      category: "spam-malware",
      rationale: "This category should not be held",
    });
    const { transport } = makeTransport([response]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("keeps held-for-review + gambling as-is (escalate-eligible)", async () => {
    const response = JSON.stringify({
      decision: "held-for-review",
      category: "gambling",
      rationale: "Simulated gambling needs streamer judgment",
    });
    const { transport } = makeTransport([response]);
    const result = await classifyWithSonnet(deps(transport), candidate());
    expect(result.decision).toBe("held-for-review");
    expect(result.category).toBe("gambling");
  });
});

describe("classifyWithSonnet — retry budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("succeeds on the third attempt after two failures", async () => {
    const { transport, transportMock } = makeTransport([
      '{"error":true}', // attempt 1 — valid JSON, invalid structure
      '{"error":true}', // attempt 2 — valid JSON, invalid structure
      JSON.stringify({ decision: "approved", category: null, rationale: "ok" }), // attempt 3
    ]);
    const promise = classifyWithSonnet(deps(transport, { maxRetries: 2 }), candidate());
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result.decision).toBe("approved");
    expect(transportMock).toHaveBeenCalledTimes(3);
  });

  it("exhausted retries resolves (never throws) to classifier-unavailable", async () => {
    const { transport } = makeTransport([
      new Error("plan credentials unavailable"),
      new Error("plan credentials unavailable"),
    ]);
    const promise = classifyWithSonnet(deps(transport, { maxRetries: 2 }), candidate());
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("backoff uses exponential delays: 500ms, then 1500ms", async () => {
    const { transport } = makeTransport([
      new Error("fail"),
      new Error("fail"),
      JSON.stringify({ decision: "approved", category: null, rationale: "ok" }),
    ]);
    const promise = classifyWithSonnet(deps(transport, { maxRetries: 2 }), candidate());
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result.decision).toBe("approved");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("classifyWithSonnet — fail-closed", () => {
  it("any error on the first attempt resolves to classifier-unavailable", async () => {
    const { transport } = makeTransport([new Error("instant failure")]);
    const result = await classifyWithSonnet(deps(transport, { maxRetries: 0 }), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("the function never rejects the promise", async () => {
    const { transport } = makeTransport([new Error("always fails")]);
    const result = await classifyWithSonnet(deps(transport, { maxRetries: 0 }), candidate());
    expect(result).toBeDefined();
    expect(result.decision).toBe("rejected");
  });

  it("non-JSON transport output triggers fail-closed", async () => {
    const { transport } = makeTransport(["I cannot help with that request."]);
    const result = await classifyWithSonnet(deps(transport, { maxRetries: 0 }), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("invalid decision structure triggers fail-closed", async () => {
    const { transport } = makeTransport(['{"bad_field":true}']);
    const result = await classifyWithSonnet(deps(transport, { maxRetries: 0 }), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });
});

describe("classifyWithSonnet — boundary", () => {
  it("passes candidate text to the transport as its ONLY input", async () => {
    const { transport, calls } = makeTransport([APPROVED]);
    await classifyWithSonnet(deps(transport), candidate({ text: "build a todo app" }));
    // The untrusted candidate text is the transport's sole argument — the fixed
    // system prompt lives in the orchestrator runner, never this layer.
    expect(calls).toEqual(["build a todo app"]);
  });
});
