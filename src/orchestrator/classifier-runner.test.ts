/**
 * Guard test for classifier-runner.ts — network-free, injected fake query().
 *
 * Proves the compliance-gate classification query() carries ZERO tool
 * authority (allowedTools: []), is single-turn (maxTurns: 1), is pinned to
 * Sonnet (GATE_MODEL / claude-sonnet-5), and NEVER interpolates candidate text
 * into the system prompt (T-01-06). The real SDK is never loaded: a fake
 * queryFn captures the { prompt, options } and yields canned messages.
 */

import type { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClassifierTransport } from "./classifier-runner.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt-boundary.js";

type QueryFn = typeof query;
type QueryParams = Parameters<QueryFn>[0];

/**
 * Build a fake queryFn that records the single { prompt, options } it receives
 * and streams the provided messages. Cast to the SDK's Query return type — the
 * transport only ever iterates it as an async generator.
 */
function makeFakeQuery(yielded: unknown[]): {
  queryFn: QueryFn;
  captured: () => QueryParams;
  callCount: () => number;
} {
  let call: QueryParams | undefined;
  let calls = 0;
  const queryFn = ((params: QueryParams) => {
    call = params;
    calls += 1;
    return (async function* () {
      for (const m of yielded) yield m;
    })() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return {
    queryFn,
    captured: () => {
      if (call === undefined) throw new Error("queryFn was never called");
      return call;
    },
    callCount: () => calls,
  };
}

const JSON_BODY = '{"decision":"approved","category":null,"rationale":"ok"}';

function assistantMessage(text: string): unknown {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function resultMessage(text: string): unknown {
  return { type: "result", subtype: "success", is_error: false, result: text };
}

describe("createClassifierTransport — tool-authority + single-turn guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs the gate query() with ZERO tool authority (allowedTools deep-equals [])", async () => {
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    const transport = createClassifierTransport({ queryFn });
    await transport("build a todo app");
    expect(captured().options?.allowedTools).toEqual([]);
    // Defensive denylist present alongside the empty allowlist.
    expect(captured().options?.disallowedTools).toContain("Bash");
    expect(captured().options?.disallowedTools).toContain("WebFetch");
  });

  it("is single-turn (maxTurns === 1)", async () => {
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("anything");
    expect(captured().options?.maxTurns).toBe(1);
  });

  it("pins the model to Sonnet by default (claude-sonnet-5)", async () => {
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("anything");
    expect(captured().options?.model).toBe("claude-sonnet-5");
  });

  it("honors GATE_MODEL override", async () => {
    vi.stubEnv("GATE_MODEL", "claude-sonnet-5-custom");
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("anything");
    expect(captured().options?.model).toBe("claude-sonnet-5-custom");
  });
});

describe("createClassifierTransport — prompt boundary (T-01-06)", () => {
  it("uses CLASSIFIER_SYSTEM_PROMPT by bare reference; candidate text never enters it", async () => {
    const sentinel = "zq-sentinel-7391 flurbish gadget";
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })(sentinel);
    const opts = captured().options;
    expect(opts?.systemPrompt).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(opts?.systemPrompt).not.toContain("zq-sentinel-7391");
    expect(opts?.systemPrompt).not.toContain("flurbish");
  });

  it("passes the candidate text ONLY as the query prompt (user content)", async () => {
    const { queryFn, captured } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("build a todo app");
    expect(captured().prompt).toBe("build a todo app");
  });
});

describe("createClassifierTransport — raw text return", () => {
  it("returns the concatenated assistant text when no result message is present", async () => {
    const { queryFn } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe(JSON_BODY);
  });

  it("prefers the final result message text when present", async () => {
    const { queryFn } = makeFakeQuery([
      assistantMessage("partial chunk"),
      resultMessage(JSON_BODY),
    ]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe(JSON_BODY);
  });

  it("calls the query transport exactly once per classification", async () => {
    const { queryFn, callCount } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("x");
    expect(callCount()).toBe(1);
  });
});
