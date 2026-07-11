import type { SandboxSettings, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  assembleHostTurnOptions,
  assembleSandboxedBuildOptions,
  HOST_TURN_DISALLOWED,
} from "./turn-options.js";
import type { AgentRunSpec, SandboxAdapter } from "./types.js";

/**
 * quick-22l T-22l-01: the MCP lockdown triple must be unit-provable. sdk-runner.ts
 * statically imports the real SDK and is deliberately never loaded in a vitest
 * run, so these assertions live against the SDK-free options-assembly module —
 * every Options object handed to query() flows through these two functions.
 */

/** A no-op SandboxAdapter stand-in — tests never touch a real wsl.exe. */
const fakeSandboxAdapter = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as unknown as SpawnedProcess,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

/** Minimal SandboxSettings fixture standing in for buildSandboxOptions()'s output. */
const fakeSandboxSettings = (): SandboxSettings => ({
  enabled: true,
  failIfUnavailable: true,
});

function makeSpec(): AgentRunSpec {
  const spawn = (_opts: SpawnOptions): SpawnedProcess => ({}) as unknown as SpawnedProcess;
  return {
    agent: "build",
    systemPrompt: "orchestrator-authored system prompt",
    userPrompt: "delimited chat-derived task text",
    workspaceDir: "/home/builder/projects/app-1",
    sandbox: fakeSandboxAdapter(),
    spawnClaudeCodeProcess: spawn,
    abortController: new AbortController(),
  };
}

/** Narrow Options.settings (string | Settings) down to the object form for assertion. */
function settingsObject(settings: unknown): Record<string, unknown> {
  expect(typeof settings).toBe("object");
  expect(settings).not.toBeNull();
  return settings as Record<string, unknown>;
}

describe("assembleSandboxedBuildOptions — MCP lockdown triple (T-22l-01)", () => {
  it("carries strictMcpConfig: true, mcpServers: {}, and settings.disableClaudeAiConnectors: true", () => {
    const options = assembleSandboxedBuildOptions(makeSpec(), fakeSandboxSettings());
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(settingsObject(options.settings).disableClaudeAiConnectors).toBe(true);
  });

  it("grants file-edit tools via permissionMode: 'acceptEdits' — NEVER bypassPermissions (EMPTY-01)", () => {
    const options = assembleSandboxedBuildOptions(makeSpec(), fakeSandboxSettings());
    // Root-cause regression: the non-interactive sandboxed turn auto-DENIED
    // every Write in 'default' mode → phantom `done` with zero files. The
    // grant must be exactly acceptEdits — file edits only, no blanket bypass.
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("passes systemPrompt by IDENTITY (SAND-04 bare-reference invariant) plus abort/sandbox/spawn/cwd", () => {
    const spec = makeSpec();
    const sandboxSettings = fakeSandboxSettings();
    const options = assembleSandboxedBuildOptions(spec, sandboxSettings);
    expect(options.systemPrompt).toBe(spec.systemPrompt);
    expect(options.abortController).toBe(spec.abortController);
    expect(options.sandbox).toBe(sandboxSettings);
    expect(options.spawnClaudeCodeProcess).toBe(spec.spawnClaudeCodeProcess);
    expect(options.cwd).toBe(spec.workspaceDir);
  });

  it("does not mutate the input spec", () => {
    const spec = makeSpec();
    const frozen = Object.freeze(spec);
    const before = { ...spec };
    assembleSandboxedBuildOptions(frozen, fakeSandboxSettings());
    expect(spec).toEqual(before);
  });
});

describe("assembleHostTurnOptions — defense-in-depth on the unreachable host branch", () => {
  it("returns allowedTools: [] and the full host denylist (WR-01 / CR-02)", () => {
    const options = assembleHostTurnOptions(makeSpec());
    expect(options.allowedTools).toEqual([]);
    for (const tool of [
      "WebFetch",
      "WebSearch",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ]) {
      expect(options.disallowedTools).toContain(tool);
      expect(HOST_TURN_DISALLOWED).toContain(tool);
    }
  });

  it("carries the SAME MCP lockdown triple as the sandboxed branch", () => {
    const options = assembleHostTurnOptions(makeSpec());
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(settingsObject(options.settings).disableClaudeAiConnectors).toBe(true);
  });

  it("does NOT widen host-turn permissions — no permissionMode grant on the unsandboxed branch", () => {
    const options = assembleHostTurnOptions(makeSpec());
    // The acceptEdits grant is scoped to the SANDBOXED turn only; the host
    // branch stays text-only with its denylist (WR-01 / CR-02).
    expect(options.permissionMode).toBeUndefined();
  });

  it("passes systemPrompt by identity and does not mutate the input spec", () => {
    const spec = makeSpec();
    const frozen = Object.freeze(spec);
    const before = { ...spec };
    const options = assembleHostTurnOptions(frozen);
    expect(options.systemPrompt).toBe(spec.systemPrompt);
    expect(options.abortController).toBe(spec.abortController);
    expect(spec).toEqual(before);
  });
});
