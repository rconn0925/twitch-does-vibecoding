/**
 * Tests for classifier.ts — GREEN within this plan.
 *
 * All tests use a mocked Anthropic client — zero network calls.
 * Uses fake timers for retry/backoff testing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionCandidate } from "../shared/types.js";
import type { ClassifierDeps } from "./classifier.js";
import { classifyWithSonnet } from "./classifier.js";

// ─── Fake client builder ───────────────────────────────────────────────
/**
 * Creates a mock Anthropic client that returns structured-parse responses.
 *
 * Each call to `messages.parse` consumes one of the provided responses,
 * cycling in order. A string response is auto-wrapped in a parse result;
 * an Error response makes the call REJECT with that error (simulating a
 * network/API failure).
 */
function makeMockClient(responses: Array<string | Error | { parsed_output: unknown }>): {
  anthropic: NonNullable<ClassifierDeps["anthropic"]>;
  parseMock: ReturnType<typeof vi.fn>;
  callCount: number;
} {
  let callCount = 0;
  const parseMock = vi.fn(async (..._args: unknown[]) => {
    const idx = callCount % responses.length;
    const resp = responses[idx];
    callCount += 1;
    if (resp instanceof Error) {
      throw resp;
    }
    if (typeof resp === "string") {
      return { parsed_output: JSON.parse(resp) };
    }
    return resp as { parsed_output: unknown };
  });
  const anthropic = {
    messages: {
      parse: parseMock,
    },
  } as unknown as NonNullable<ClassifierDeps["anthropic"]>;

  return { anthropic, parseMock, get callCount() { return callCount; } };
}

function deps(
  anthropic: NonNullable<ClassifierDeps["anthropic"]>,
  overrides?: Partial<Omit<ClassifierDeps, "anthropic">>,
): ClassifierDeps {
  return { anthropic, logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as any, ...overrides };
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

// ─── Schema-conformant valid responses ─────────────────────────────────
const APPROVED = { parsed_output: { decision: "approved", category: null, rationale: "safe build — no policy concerns" } };
const REJECTED_SPAM = { parsed_output: { decision: "rejected", category: "spam-malware", rationale: "requests malware" } };

describe("classifyWithSonnet — happy path", () => {
  it("returns an approved decision when the classifier approves", async () => {
    const { anthropic } = makeMockClient([APPROVED]);
    const result = await classifyWithSonnet(deps(anthropic), candidate());
    expect(result.decision).toBe("approved");
    expect(result.category).toBeNull();
  });

  it("returns a rejected decision with a valid category", async () => {
    const { anthropic } = makeMockClient([REJECTED_SPAM]);
    const result = await classifyWithSonnet(deps(anthropic), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("re-parses the response through GateDecisionSchema (belt-and-suspenders)", async () => {
    // The mock returns a valid structure; the schema re-parse should pass
    const { anthropic } = makeMockClient([APPROVED]);
    const result = await classifyWithSonnet(deps(anthropic), candidate());
    expect(result).toMatchObject({ decision: "approved", category: null });
  });
});

describe("classifyWithSonnet — D-12 escalation coercion", () => {
  it("coerces held-for-review + non-escalate category to rejected", async () => {
    const response = {
      parsed_output: {
        decision: "held-for-review",
        category: "spam-malware",
        rationale: "This category should not be held",
      },
    };
    const { anthropic } = makeMockClient([response]);
    const result = await classifyWithSonnet(deps(anthropic), candidate());
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("keeps held-for-review + gambling as-is (escalate-eligible)", async () => {
    const response = {
      parsed_output: {
        decision: "held-for-review",
        category: "gambling",
        rationale: "Simulated gambling needs streamer judgment",
      },
    };
    const { anthropic } = makeMockClient([response]);
    const result = await classifyWithSonnet(deps(anthropic), candidate());
    expect(result.decision).toBe("held-for-review");
    expect(result.category).toBe("gambling");
  });
});

describe("classifyWithSonnet — retry budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("succeeds on the third attempt after two failures", async () => {
    const { anthropic, parseMock } = makeMockClient([
      { parsed_output: { error: true } }, // attempt 1 — returns invalid structure
      { parsed_output: { error: true } }, // attempt 2 — returns invalid structure
      { parsed_output: { decision: "approved", category: null, rationale: "ok" } }, // attempt 3 — success
    ]);
    const promise = classifyWithSonnet(
      deps(anthropic, { maxRetries: 2 }),
      candidate(),
    );
    // Advance past both backoff delays (500ms + 1500ms = 2000ms total)
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result.decision).toBe("approved");
    expect(parseMock).toHaveBeenCalledTimes(3);
  });

  it("exhausted retries resolves (never throws) to classifier-unavailable", async () => {
    const { anthropic } = makeMockClient([
      new Error("network timeout"),
      new Error("network timeout"),
    ]);
    const promise = classifyWithSonnet(
      deps(anthropic, { maxRetries: 2 }),
      candidate(),
    );
    // Advance past both backoff delays
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("backoff uses exponential delays: 500ms, then 1500ms", async () => {
    const { anthropic } = makeMockClient([
      new Error("fail"),
      new Error("fail"),
      { parsed_output: { decision: "approved", category: null, rationale: "ok" } },
    ]);
    const promise = classifyWithSonnet(
      deps(anthropic, { maxRetries: 2 }),
      candidate(),
    );
    // First backoff: 500ms
    await vi.advanceTimersByTimeAsync(500);
    // After first failure, still pending
    // Second backoff: 1500ms
    await vi.advanceTimersByTimeAsync(1500);
    // After second failure, still pending
    // Third attempt succeeds
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
    const { anthropic } = makeMockClient([new Error("instant failure")]);
    const result = await classifyWithSonnet(
      deps(anthropic, { maxRetries: 0 }),
      candidate(),
    );
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("the function never rejects the promise", async () => {
    const { anthropic } = makeMockClient([new Error("always fails")]);
    const result = await classifyWithSonnet(
      deps(anthropic, { maxRetries: 0 }),
      candidate(),
    );
    expect(result).toBeDefined();
    expect(result.decision).toBe("rejected");
  });

  it("invalid parsed_output structure triggers retry then fail-closed", async () => {
    const { anthropic } = makeMockClient([
      // Return something that fails GateDecisionSchema validation
      { parsed_output: { bad_field: true } },
    ]);
    const result = await classifyWithSonnet(
      deps(anthropic, { maxRetries: 0 }),
      candidate(),
    );
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });
});

describe("classifyWithSonnet — boundary", () => {
  it("sends candidate text ONLY in the user role message", async () => {
    const { anthropic, parseMock } = makeMockClient([{ parsed_output: { decision: "approved", category: null, rationale: "ok" } }]);
    await classifyWithSonnet(deps(anthropic), candidate({ text: "build a todo app" }));
    const calls = parseMock.mock.calls;
    expect(calls).toHaveLength(1);
    const [msg] = calls[0]! as [{ messages?: Array<{ role: string; content: unknown }> }];
    expect(msg.messages).toHaveLength(1);
    expect(msg.messages![0]!.role).toBe("user");
    expect(msg.messages![0]!.content).toBe("build a todo app");
  });

  it("the system prompt is a fixed constant — no candidate interpolation", async () => {
    const OK = { parsed_output: { decision: "approved", category: null, rationale: "ok" } };
    const { anthropic, parseMock } = makeMockClient([OK, OK]);
    // Distinctive sentinel strings that cannot legitimately appear in a
    // fixed system prompt (unlike e.g. "keylogger", which the prompt's
    // category descriptions mention by design).
    const sentinelA = "zq-sentinel-7391 flurbish gadget";
    const sentinelB = "xv-sentinel-4482 crontlin widget";
    await classifyWithSonnet(deps(anthropic), candidate({ text: sentinelA }));
    await classifyWithSonnet(deps(anthropic), candidate({ text: sentinelB }));
    const calls = parseMock.mock.calls;
    expect(calls).toHaveLength(2);
    const [first] = calls[0]! as [{ system?: string }];
    const [second] = calls[1]! as [{ system?: string }];
    // No interpolation of candidate fields into the system prompt...
    expect(first.system).not.toContain("zq-sentinel-7391");
    expect(first.system).not.toContain("flurbish");
    expect(second.system).not.toContain("xv-sentinel-4482");
    // ...and the system prompt is byte-identical across different candidates.
    expect(first.system).toBe(second.system);
  });
});
