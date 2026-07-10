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

/** A NON-success terminal result (e.g. error_max_turns / error_during_execution). */
function errorResultMessage(subtype: string): unknown {
  return { type: "result", subtype, is_error: true };
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

describe("createClassifierTransport — raw text return (fail-closed contract)", () => {
  it("returns the authoritative result text on a SUCCESS result", async () => {
    const { queryFn } = makeFakeQuery([
      assistantMessage("partial chunk"),
      resultMessage(JSON_BODY),
    ]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe(JSON_BODY);
  });

  it("falls back to assistant chunks only when a SUCCESS result had empty text", async () => {
    const { queryFn } = makeFakeQuery([assistantMessage(JSON_BODY), resultMessage("")]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe(JSON_BODY);
  });

  it("returns empty (→ fail closed) when the stream has NO success result", async () => {
    // Assistant text present but no terminal success → the gate must not trust it.
    const { queryFn } = makeFakeQuery([assistantMessage(JSON_BODY)]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe("");
  });

  it("returns empty on a NON-success terminal result even with valid-looking text (WR-01)", async () => {
    // A run that emits a complete `{"decision":"approved"}` and THEN errors must
    // NOT approve — trust text only on subtype:success.
    const { queryFn } = makeFakeQuery([
      assistantMessage(JSON_BODY),
      errorResultMessage("error_max_turns"),
    ]);
    const raw = await createClassifierTransport({ queryFn })("x");
    expect(raw).toBe("");
  });

  it("calls the query transport exactly once per classification", async () => {
    const { queryFn, callCount } = makeFakeQuery([resultMessage(JSON_BODY)]);
    await createClassifierTransport({ queryFn })("x");
    expect(callCount()).toBe(1);
  });
});

describe("createClassifierTransport — hard timeout bound (WR-02)", () => {
  it("rejects (→ fail closed) if the query stalls past the timeout budget", async () => {
    vi.useFakeTimers();
    try {
      // A generator that never yields and never returns — a stalled query().
      const queryFn = (() =>
        (async function* () {
          await new Promise(() => {});
          // eslint-disable-next-line no-unreachable
          yield resultMessage(JSON_BODY);
        })() as unknown as ReturnType<QueryFn>) as QueryFn;
      const promise = createClassifierTransport({ queryFn })("x");
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(8000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
