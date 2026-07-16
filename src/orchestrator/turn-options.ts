/**
 * Pure SDK Options assembly for every agent turn sdk-runner.ts runs — extracted
 * (quick-22l) so the MCP lockdown is UNIT-TESTABLE: sdk-runner.ts statically
 * imports the real SDK and is deliberately never loaded in a vitest run, so the
 * lockdown assertions live here against an SDK-free module (only `import type`,
 * erased at runtime).
 *
 * WHY THREE LOCKDOWN LAYERS (T-22l-01, memory: mcp-lockdown-github-autocommit):
 * the builder account's claude.ai cloud connectors (Gmail / Drive / HubSpot /
 * Railway / GitHub) were reachable from sandboxed build turns — chat-derived
 * prompts drive that turn, so anything reachable from it is chat-controllable.
 * Each layer closes a DIFFERENT config source, and no safety boundary may
 * depend on an SDK default (CR-02 / WR-01 doctrine):
 *
 *   1. `strictMcpConfig: true`  — belt: ignores every file/settings-based MCP
 *      source (project .mcp.json, user settings, plugins, on-disk agent
 *      frontmatter; sdk.d.ts:1919).
 *   2. `mcpServers: {}`         — braces: even strict mode loads only what is
 *      passed here — nothing.
 *   3. `settings: { disableClaudeAiConnectors: true }` — third layer: gates the
 *      AUTO-FETCHED claude.ai cloud connectors specifically (sdk.d.ts:4950,
 *      "any-source-true wins") — exactly the account-level connector exposure
 *      strictMcpConfig's file/settings coverage does not address.
 *
 * The orchestrator-authored systemPrompt is passed by BARE REFERENCE (never an
 * interpolating template literal) so the SAND-04 prompt-boundary invariant
 * holds; all chat-derived text travels only in the delimited userPrompt.
 */

import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunSpec } from "./types.js";

/**
 * Tools structurally FORBIDDEN on any unsandboxed host turn: network egress
 * plus host write/exec. The live pipeline no longer runs host-side turns, but
 * the denylist stays as structural defense-in-depth (CR-02 / WR-01) — if a
 * future spec ever reaches the unsandboxed fallback branch, the host tool
 * boundary never depends on an SDK default.
 */
export const HOST_TURN_DISALLOWED = [
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

/** One fresh lockdown-settings object per call — never a shared mutable const. */
function lockdownSettings(): Settings {
  return { disableClaudeAiConnectors: true };
}

/**
 * The sandboxed build-turn Options (the ONLY live-pipeline turn since
 * quick-0iu): WSL2 process isolation via `sandbox` + `spawnClaudeCodeProcess`,
 * the persistent-workspace cwd, and the MCP lockdown triple. Pure — reads the
 * spec, never mutates it.
 */
export function assembleSandboxedBuildOptions(
  spec: AgentRunSpec,
  sandboxOptions: Options["sandbox"],
): Options {
  const options: Options = {
    // BARE reference — zero interpolation (SAND-04).
    systemPrompt: spec.systemPrompt,
    abortController: spec.abortController,
    // Persistent workspace (quick-0iu): Options.cwd flows into the SpawnOptions
    // the SDK hands spawnClaudeCodeProcess; sandbox-process.ts translates a
    // POSIX-absolute cwd to `wsl --cd <cwd>`.
    cwd: spec.workspaceDir,
    // EMPTY-01 root-cause fix: the sandboxed build turn is NON-INTERACTIVE —
    // there is nobody to answer a permission prompt. Without this, every
    // Write/Edit was auto-DENIED in 'default' mode ("Claude requested
    // permissions to write to …, but you haven't granted it yet."), the agent
    // ended its turn with zero files, and result:success surfaced as a phantom
    // `done`. acceptEdits auto-accepts file-edit tools ONLY; the actual safety
    // boundaries are unchanged: the WSL2 distro + CLI bubblewrap sandbox
    // (SAND-01/02/03) confine writes, and COMP-02 re-screens every output
    // batch in-flight (D3-07). Deliberately NOT bypassPermissions — no wider
    // grant than the denial that broke the build.
    permissionMode: "acceptEdits",
    // MCP lockdown triple (T-22l-01) — see the module header for why three layers.
    strictMcpConfig: true,
    mcpServers: {},
    settings: lockdownSettings(),
    // Explicit Fable pin (quick-260716-9mk): replaces the former reliance on
    // the builder account's session default — the model policy is a boundary
    // and may not depend on ambient account config (CR-02 / WR-01). Read at
    // assembly-call-time (GATE_MODEL idiom, classifier-runner.ts) so
    // vi.stubEnv tests stay deterministic; `?.trim() ||` (not `??`) so a
    // blank `BUILD_MODEL=` .env entry cannot silently un-pin. The D-1 Sonnet
    // classifier gate (GATE_MODEL) is a separate, untouched surface, and
    // chat-derived AgentRunSpec still carries no model field.
    model: process.env.BUILD_MODEL?.trim() || "claude-fable-5",
  };
  if (sandboxOptions !== undefined) options.sandbox = sandboxOptions;
  if (spec.spawnClaudeCodeProcess) options.spawnClaudeCodeProcess = spec.spawnClaudeCodeProcess;
  return options;
}

/**
 * The unsandboxed host-turn Options (unreachable from the live pipeline —
 * kept as structural defense-in-depth): text-only, NO tools reachable on the
 * host (WR-01), plus the SAME MCP lockdown triple as the sandboxed branch.
 * Pure — reads the spec, never mutates it.
 */
export function assembleHostTurnOptions(spec: AgentRunSpec): Options {
  return {
    systemPrompt: spec.systemPrompt,
    abortController: spec.abortController,
    allowedTools: [],
    disallowedTools: [...HOST_TURN_DISALLOWED],
    // Same lockdown triple as the build turn (CR-02 / WR-01: never depend on an
    // SDK default for a safety boundary, even on an unreachable branch).
    strictMcpConfig: true,
    mcpServers: {},
    settings: lockdownSettings(),
    // Pinned even on this unreachable branch: the host branch is structural
    // defense-in-depth, and CR-02 / WR-01 doctrine says no boundary —
    // including the Fable model policy — may depend on an SDK/account
    // default, exactly the argument the lockdown-triple comment above makes
    // for MCP config. Pinning is harmless and keeps both assembly functions
    // under one doctrine.
    model: process.env.BUILD_MODEL?.trim() || "claude-fable-5",
  };
}
