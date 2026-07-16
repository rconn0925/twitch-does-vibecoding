/**
 * The REAL, SDK-backed AgentRunner — the ONLY place `query()` actually runs.
 *
 * This module statically imports `@anthropic-ai/claude-agent-sdk` (the query()
 * / spawnClaudeCodeProcess tool-use authority), so it is DYNAMICALLY imported
 * behind main.ts's guarded entrypoint (buildOrchestratorAdapters) — never at a
 * test-reachable module-top-level position. vitest injects a fake AgentRunner
 * instead and this file is never loaded in a test run.
 *
 * It wraps each AgentRunSpec into one `query()` turn. Since quick-0iu
 * (straight-to-build) there are no research/plan turns: EVERY live pipeline
 * turn is the sandboxed Fable build turn — spec.spawnClaudeCodeProcess
 * redirects the Claude Code engine into the WSL2 distro and
 * buildSandboxOptions() applies SAND-01/02/03 (failIfUnavailable: true → never
 * silently unsandboxed, T-03-23). The build model is explicitly pinned to
 * Fable in turn-options.ts (BUILD_MODEL env override, default claude-fable-5);
 * AgentRunSpec still carries no model field, so the pipeline structurally
 * cannot request an override; the Sonnet classifier gate is a separate surface.
 *
 * The orchestrator-authored systemPrompt is passed by BARE REFERENCE (never an
 * interpolating template literal) so the SAND-04 prompt-boundary invariant
 * holds; all chat-derived text travels only in the delimited userPrompt.
 */

import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildSandboxOptions } from "./sandbox-process.js";
import { assembleHostTurnOptions, assembleSandboxedBuildOptions } from "./turn-options.js";
import type { AgentMessage, AgentRunner, AgentRunSpec } from "./types.js";

/**
 * Construct the real AgentRunner. Called ONLY from main.ts's guarded entrypoint;
 * if the SDK import or a turn throws, the caller degrades loudly and the vote
 * loop keeps running.
 *
 * Options assembly lives in turn-options.ts (quick-22l) so the MCP lockdown
 * triple (strictMcpConfig + mcpServers: {} + disableClaudeAiConnectors) and the
 * host-turn denylist (HOST_TURN_DISALLOWED, moved there) are unit-tested —
 * this file is never loaded in a vitest run.
 */
export function createSdkAgentRunner(): AgentRunner {
  return {
    async *run(spec: AgentRunSpec): AsyncIterable<AgentMessage> {
      const options: Options =
        spec.sandbox && spec.spawnClaudeCodeProcess
          ? // Sandboxed build turn: WSL2 process isolation IS the boundary — the
            // Claude Code engine runs inside the distro (SAND-01/02/03), cwd is
            // the persistent workspace (quick-0iu: Options.cwd flows into the
            // SpawnOptions the SDK hands spawnClaudeCodeProcess; sandbox-process
            // translates a POSIX-absolute cwd to `wsl --cd <cwd>`).
            assembleSandboxedBuildOptions(spec, buildSandboxOptions())
          : // Unsandboxed host turn (unreachable from the live pipeline):
            // text-only, NO tools reachable on the host (WR-01) — defense-in-depth.
            assembleHostTurnOptions(spec);
      const turn = query({ prompt: spec.userPrompt, options });
      for await (const message of turn) {
        yield message;
      }
    },
  };
}
