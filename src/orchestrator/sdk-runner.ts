/**
 * The REAL, SDK-backed AgentRunner — the ONLY place `query()` actually runs.
 *
 * This module statically imports `@anthropic-ai/claude-agent-sdk` (the query()
 * / spawnClaudeCodeProcess tool-use authority), so it is DYNAMICALLY imported
 * behind main.ts's guarded entrypoint (buildOrchestratorAdapters) — never at a
 * test-reachable module-top-level position. vitest injects a fake AgentRunner
 * instead and this file is never loaded in a test run.
 *
 * It wraps each AgentRunSpec into one `query()` turn:
 *   - research turns run host-side on Sonnet with a read-only tool allowlist
 *     (RESEARCH Open Question 1);
 *   - build turns run on the Fable session default (model undefined) INSIDE the
 *     WSL2 sandbox — spec.spawnClaudeCodeProcess redirects the Claude Code
 *     engine into the distro and buildSandboxOptions() applies SAND-01/02/03
 *     (failIfUnavailable: true → never silently unsandboxed, T-03-23).
 *
 * The orchestrator-authored systemPrompt is passed by BARE REFERENCE (never an
 * interpolating template literal) so the SAND-04 prompt-boundary invariant
 * holds; all chat-derived text travels only in the delimited userPrompt.
 */

import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildSandboxOptions } from "./sandbox-process.js";
import type { AgentMessage, AgentRunner, AgentRunSpec } from "./types.js";

/** Read-only tool allowlist for the host-side research turn (RESEARCH Open Q1). */
const RESEARCH_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

/**
 * Construct the real AgentRunner. Called ONLY from main.ts's guarded entrypoint;
 * if the SDK import or a turn throws, the caller degrades loudly and the vote
 * loop keeps running.
 */
export function createSdkAgentRunner(): AgentRunner {
  return {
    async *run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      const options: Options = {
        systemPrompt: spec.systemPrompt,
        abortController: spec.abortController,
      };
      if (spec.model !== undefined) options.model = spec.model;
      if (spec.agent === "research") options.allowedTools = RESEARCH_TOOLS;
      if (spec.sandbox && spec.spawnClaudeCodeProcess) {
        options.sandbox = buildSandboxOptions();
        options.spawnClaudeCodeProcess = spec.spawnClaudeCodeProcess;
      }
      const turn = query({ prompt: spec.userPrompt, options });
      for await (const message of turn) {
        yield message;
      }
    },
  };
}
