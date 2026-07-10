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

/**
 * Per-call classification budget. The Agent SDK query() spawns a claude CLI
 * subprocess, so its cold start is far heavier than the retired direct HTTP
 * messages.parse call — an 8s bound (fine for raw HTTP) fired before a real
 * cold-start classification could answer. Default 20s, GATE_TIMEOUT_MS-tunable;
 * on timeout the call rejects and the compliance envelope fails CLOSED.
 */
const CLASSIFIER_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.GATE_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 20_000;
})();

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
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Hard latency bound (WR-02): race the stream consumption against an explicit
    // timeout that BOTH aborts the query AND rejects. The abortController alone is
    // not enough — if query() ignores or is slow to honor the abort, a stalled
    // call would hang classify() indefinitely. On timeout the reject propagates,
    // classifier.ts catches it, and the gate fails CLOSED (never open).
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("classifier query timed out"));
      }, CLASSIFIER_TIMEOUT_MS);
      // Do not let the abort timer keep the event loop alive.
      if (timer && typeof timer.unref === "function") timer.unref();
    });

    const consume = async (): Promise<string> => {
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
        // Extended thinking OFF: classification is a single-shot judgment, not an
        // agentic task. With adaptive thinking ON, the model spends its ONE turn
        // reasoning and the run terminates as error_max_turns (never success),
        // which fail-closes EVERY suggestion — and the ~13s it burns blows the
        // latency budget. Disabled, the model still reasons inside its reply and
        // returns a clean success in ~3s. The eval harness validates screening
        // quality holds without extended thinking.
        thinking: { type: "disabled" },
        abortController: controller,
      };
      const stream = queryFn({ prompt: candidateText, options });
      let sawSuccess = false;
      let resultText: string | undefined;
      const assistantChunks: string[] = [];
      for await (const message of stream) {
        if (message.type === "result") {
          // Trust the run ONLY when the SDK reports success (WR-01). A non-success
          // terminal result (error_max_turns / error_during_execution) must NOT
          // yield text — even a complete-looking `{"decision":"approved"}` from a
          // failed run has to fail closed, so we leave the text empty and let the
          // compliance envelope reject.
          if (message.subtype === "success") {
            sawSuccess = true;
            resultText = message.result;
          }
        } else if (message.type === "assistant") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") assistantChunks.push(block.text);
            }
          }
        }
      }
      // No successful result → return empty so the envelope fails closed.
      if (!sawSuccess) return "";
      // Prefer the authoritative result text; the streamed chunks are only a
      // fallback for a successful run whose result field came back empty.
      return resultText && resultText.length > 0 ? resultText : assistantChunks.join("");
    };

    try {
      return await Promise.race([consume(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
