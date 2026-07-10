/**
 * Classifier transport contract pins — NO network, no Anthropic SDK, ever.
 *
 * The live gate now bills via the Claude plan: candidate text → the injected
 * ClassifierTransport (Sonnet via the Agent SDK query() under src/orchestrator/)
 * → the model's raw assistant text. Because `query()` has no native json_schema
 * enforcement, this layer must tolerantly extract the JSON object from raw text
 * and then fail CLOSED on anything malformed. These tests pin exactly that
 * contract with an injected fake transport — the real end-to-end check remains
 * `npm run gate:eval`, run as a pre-stream gate.
 *
 * Since the classifier is structurally fail-closed, a drifted transport shape
 * would not crash — it would silently reject 100% of live chat. These pins are
 * the network-free warning that the extraction + validation surface still works.
 */

import { describe, expect, it } from "vitest";
import type { SuggestionCandidate } from "../shared/types.js";
import { type ClassifierTransport, classifyWithSonnet } from "./classifier.js";
import { GateDecisionSchema } from "./schema.js";

function candidate(text: string): SuggestionCandidate {
  return {
    id: "contract-1",
    source: "chat",
    kind: "suggestion",
    twitchUsername: "viewer",
    text,
    submittedAtMs: 1_700_000_000_000,
  };
}

/** A transport that always returns the same raw text. */
function fixedTransport(raw: string): ClassifierTransport {
  return async () => raw;
}

const DECISION = { decision: "rejected", category: "spam-malware", rationale: "requests malware" };
const RAW_JSON = JSON.stringify(DECISION);

describe("classifier transport contract (network-free, no SDK)", () => {
  it("GateDecisionSchema still validates a well-formed decision (validator pin)", () => {
    // If the schema surface drifts, this fails BEFORE the gate silently rejects.
    const parsed = GateDecisionSchema.safeParse(DECISION);
    expect(parsed.success).toBe(true);
  });

  it("extracts and validates a BARE JSON object from the transport", async () => {
    const result = await classifyWithSonnet(
      { transport: fixedTransport(RAW_JSON), maxRetries: 0 },
      candidate("x"),
    );
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("extracts JSON wrapped in a ```json code fence", async () => {
    const fenced = "```json\n" + RAW_JSON + "\n```";
    const result = await classifyWithSonnet(
      { transport: fixedTransport(fenced), maxRetries: 0 },
      candidate("x"),
    );
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("spam-malware");
  });

  it("extracts JSON surrounded by prose", async () => {
    const prose = `Sure — here is the verdict:\n${RAW_JSON}\nHope that helps!`;
    const result = await classifyWithSonnet(
      { transport: fixedTransport(prose), maxRetries: 0 },
      candidate("x"),
    );
    expect(result.decision).toBe("rejected");
  });

  it("fails CLOSED on non-JSON transport output (never fail-open)", async () => {
    const result = await classifyWithSonnet(
      { transport: fixedTransport("I refuse to answer."), maxRetries: 0 },
      candidate("x"),
    );
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });

  it("fails CLOSED when the transport throws (plan credentials unavailable)", async () => {
    const throwing: ClassifierTransport = async () => {
      throw new Error("not logged in — run claude login");
    };
    const result = await classifyWithSonnet({ transport: throwing, maxRetries: 0 }, candidate("x"));
    expect(result.decision).toBe("rejected");
    expect(result.category).toBe("classifier-unavailable");
  });
});
