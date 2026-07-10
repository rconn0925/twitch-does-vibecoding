/**
 * Plan-billed compliance-classifier transport — the ONLY place the gate's
 * classification `query()` runs.
 *
 * This module statically imports `@anthropic-ai/claude-agent-sdk` (the query()
 * tool-use authority), so — like sdk-runner.ts — it is DYNAMICALLY imported
 * behind main.ts's guarded entrypoint (buildClassifierTransport) and never at a
 * test-reachable module-top-level position in the compliance layer. vitest
 * injects a fake `queryFn` and never loads the real SDK or touches the network.
 *
 * Billing: `query()` authenticates via `claude login` persisted credentials, so
 * the gate draws on Claude plan/subscription credits — NOT the metered raw
 * Anthropic Messages API (CLAUDE.md "What NOT to Use": ANTHROPIC_API_KEY
 * stays UNSET on the streaming machine). If credentials are unavailable the call
 * throws; the compliance layer's retry/backoff then fails CLOSED (never open).
 *
 * Model policy: the gate stays on Sonnet (GATE_MODEL, default claude-sonnet-5) —
 * a deliberate documented exception to the Fable policy (D-1). Only billing and
 * transport moved; the model and every safety property are unchanged.
 *
 * SAND-04: this runner is confined to src/orchestrator/. The system prompt is
 * the fixed CLASSIFIER_SYSTEM_PROMPT const, passed by BARE REFERENCE (never an
 * interpolating template literal) so the prompt-source guard holds. Untrusted
 * candidate text travels ONLY as the query `prompt` (user content), never into
 * the system prompt (T-01-06).
 */

import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt-boundary.js";

/**
 * Tools structurally FORBIDDEN on the gate's classification turn. Mirrors
 * sdk-runner.ts's HOST_TURN_DISALLOWED: a defensive denylist alongside the
 * empty allowlist so the tool boundary never depends on an SDK default — the
 * gate call must have ZERO tool-execution authority even if a future SDK
 * widens its implicit default tool set (WR-01 / CR-02).
 */
const CLASSIFIER_DISALLOWED = [
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

/** Per-call classification budget — mirrors the retired messages.parse timeout. */
const CLASSIFIER_TIMEOUT_MS = 8000;

/**
 * The compliance↔orchestrator seam: candidate text in → the model's raw
 * assistant text out. The compliance layer (classifier.ts) owns the retry
 * budget, tolerant JSON extraction, zod re-validation, D-12 coercion, and the
 * fail-closed sentinel; this transport owns only model pinning + the query().
 */
export type ClassifierTransport = (candidateText: string) => Promise<string>;

/**
 * Construct the plan-billed classifier transport. Called from main.ts's guarded
 * dynamic import in production; tests inject a fake `queryFn` to stay
 * network-free. Each returned transport call is a single, tools-disabled,
 * Sonnet-pinned query() turn.
 */
export function createClassifierTransport(injected?: {
  queryFn?: typeof query;
}): ClassifierTransport {
  const queryFn = injected?.queryFn ?? query;
  return async (candidateText: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
    // Do not let the abort timer keep the event loop alive.
    if (typeof timer.unref === "function") timer.unref();
    try {
      const options: Options = {
        // BARE reference to a fixed const — zero interpolation (SAND-04 / T-01-06).
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        // Sonnet stays the gate model (D-1); only billing moved to plan credits.
        model: process.env.GATE_MODEL ?? "claude-sonnet-5",
        // ZERO tool-execution authority: empty allowlist + defensive denylist.
        allowedTools: [],
        disallowedTools: CLASSIFIER_DISALLOWED,
        // Single-turn: the gate never multi-turns.
        maxTurns: 1,
        abortController: controller,
      };
      const stream = queryFn({ prompt: candidateText, options });
      let resultText: string | undefined;
      const assistantChunks: string[] = [];
      for await (const message of stream) {
        if (message.type === "result") {
          // The final result message carries the authoritative assistant text.
          if (message.subtype === "success") resultText = message.result;
        } else if (message.type === "assistant") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") assistantChunks.push(block.text);
            }
          }
        }
      }
      // Prefer the final result message; fall back to concatenated assistant text.
      return resultText ?? assistantChunks.join("");
    } finally {
      clearTimeout(timer);
    }
  };
}
