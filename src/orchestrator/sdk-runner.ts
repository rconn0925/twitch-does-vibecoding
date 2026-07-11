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
 * silently unsandboxed, T-03-23). The build inherits the Fable session default
 * (AgentRunSpec carries no model field — the pipeline structurally cannot
 * request an override; the Sonnet classifier gate is a separate surface).
 *
 * The orchestrator-authored systemPrompt is passed by BARE REFERENCE (never an
 * interpolating template literal) so the SAND-04 prompt-boundary invariant
 * holds; all chat-derived text travels only in the delimited userPrompt.
 */

import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { buildSandboxOptions } from "./sandbox-process.js";
import type { AgentMessage, AgentRunner, AgentRunSpec } from "./types.js";

/**
 * Tools structurally FORBIDDEN on any unsandboxed host turn: network egress
 * plus host write/exec. The live pipeline no longer runs host-side turns, but
 * the denylist stays as structural defense-in-depth (CR-02 / WR-01) — if a
 * future spec ever reaches the unsandboxed fallback branch below, the host
 * tool boundary never depends on an SDK default.
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
      if (spec.sandbox && spec.spawnClaudeCodeProcess) {
        // Sandboxed build turn: WSL2 process isolation IS the boundary — the
        // Claude Code engine runs inside the distro (SAND-01/02/03).
        options.sandbox = buildSandboxOptions();
        options.spawnClaudeCodeProcess = spec.spawnClaudeCodeProcess;
        // Persistent workspace (quick-0iu): Options.cwd flows into the
        // SpawnOptions the SDK hands spawnClaudeCodeProcess (verified against
        // the installed SDK's sdk.mjs — the transport destructures `cwd` from
        // its options and passes `{ command, args, cwd, env, signal }`).
        // sandbox-process.ts:184 translates a POSIX-absolute cwd to
        // `wsl --cd <cwd>` (anything else falls back to `~`) — that file is
        // untouched; this line is the only new hand-off.
        options.cwd = spec.workspaceDir;
      } else {
        // Unsandboxed host turn (unreachable from the live pipeline): text-only
        // — NO tools reachable on the host (WR-01). Kept as defense-in-depth;
        // do not depend on an SDK default for this safety boundary.
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
