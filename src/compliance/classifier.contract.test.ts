/**
 * Anthropic SDK structural contract pins (WR-03) — NO network, ever.
 *
 * Every functional classifier test injects a mock, so nothing else verifies
 * that the REAL installed SDK still exposes the exact call surface
 * classifier.ts depends on: the `messages.parse` method, the
 * `output_config.format = { type: "json_schema", schema }` request field, and
 * the `parsed_output` response property. Because the classifier is
 * structurally fail-closed, a drifted shape would not crash — it would
 * silently reject 100% of live chat with no failing test to warn anyone.
 *
 * These assertions check only the installed SDK's runtime symbols and type
 * declarations. The real-API end-to-end check remains `npm run gate:eval`,
 * which should be run as a pre-stream gate.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ParsedMessage } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GateDecisionSchema } from "./schema.js";

describe("Anthropic SDK contract (WR-03 — network-free)", () => {
  it("the installed SDK exposes messages.parse as a callable method at runtime", () => {
    // Constructing a client performs no I/O; the key is never used.
    const client = new Anthropic({ apiKey: "contract-test-never-sent" });
    expect(typeof client.messages.parse).toBe("function");
  });

  it("the exact request shape classifier.ts sends conforms to the SDK's request type", () => {
    // `satisfies` makes this a COMPILE-TIME pin: if an SDK upgrade renames or
    // retypes model/max_tokens/system/messages/output_config/format/
    // json_schema, `tsc --noEmit` fails here — before the gate silently
    // rejects every live suggestion.
    const request = {
      model: "claude-sonnet-5",
      max_tokens: 512,
      system: "contract pin",
      messages: [{ role: "user", content: "contract pin" }],
      output_config: {
        format: {
          type: "json_schema",
          schema: z.toJSONSchema(GateDecisionSchema) as { [key: string]: unknown },
        },
      },
    } satisfies Anthropic.MessageCreateParamsNonStreaming;

    expect(request.output_config.format.type).toBe("json_schema");
    expect(request.output_config.format.schema).toBeTruthy();
  });

  it("the parse response type still carries parsed_output", () => {
    // Type-level pin: `parsed_output` must remain a key of ParsedMessage —
    // classifier.ts reads `response.parsed_output` after every parse call.
    const key: keyof ParsedMessage<unknown> = "parsed_output";
    expect(key).toBe("parsed_output");
  });
});
