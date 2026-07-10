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

/**
 * Read-only tool allowlist for the host-side research turn (RESEARCH Open Q1).
 *
 * CR-02: WebSearch/WebFetch are DELIBERATELY absent. The research turn runs
 * UNSANDBOXED on the host with the process cwd that holds the very secrets the
 * sandbox design protects (`.env`, `./data/twitch-token.json`, the audit DB) and
 * its only input is untrusted, chat-derived `task.text`. Read/Grep/Glob alone
 * cannot exfiltrate; pairing them with WebFetch would give a
 * read-then-egress channel a prompt injection could drive. Breaking that pairing
 * structurally (allowlist, not prompt wording) removes the exfiltration channel.
 * Sandboxing the research turn too is the ideal, deferred to Wave-0 sandbox
 * validation so the test path stays on fakes (no real WSL2 dependency).
 */
const RESEARCH_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Tools structurally FORBIDDEN on every unsandboxed host turn (research + plan):
 * network egress plus host write/exec. A defensive denylist alongside the
 * allowlist so the host tool boundary never depends on an SDK default (CR-02 /
 * WR-01) — even if a future SDK widens the implicit default tool set.
 */
const HOST_TURN_DISALLOWED = [
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

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
      if (spec.sandbox && spec.spawnClaudeCodeProcess) {
        // Sandboxed build turn: WSL2 process isolation IS the boundary — the
        // Claude Code engine runs inside the distro (SAND-01/02/03).
        options.sandbox = buildSandboxOptions();
        options.spawnClaudeCodeProcess = spec.spawnClaudeCodeProcess;
      } else if (spec.agent === "research") {
        // Unsandboxed host research turn: read-only, NO egress (CR-02).
        options.allowedTools = RESEARCH_TOOLS;
        options.disallowedTools = HOST_TURN_DISALLOWED;
      } else {
        // Unsandboxed host plan turn: text-only — NO tools reachable on the host
        // (WR-01). Do not depend on an SDK default for this safety boundary.
        options.allowedTools = [];
        options.disallowedTools = HOST_TURN_DISALLOWED;
      }
      const turn = query({ prompt: spec.userPrompt, options });
      for await (const message of turn) {
        yield message;
      }
    },
  };
}
