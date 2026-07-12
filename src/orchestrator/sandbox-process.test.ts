import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildSandboxOptions,
  createSandboxAdapter,
  resolveWslExePath,
  type SandboxAdapterDeps,
  type SandboxConfig,
  type SandboxExecFileFn,
  type SandboxSpawnFn,
  sandboxConfigFromEnv,
} from "./sandbox-process.js";

/** Matches any host-secret-shaped env key we must NEVER forward into the sandbox. */
const HOST_SECRET_KEY = /TWITCH_|ANTHROPIC_API_KEY|SECRET|TOKEN/;

/** A no-op SpawnedProcess stand-in — tests never touch a real wsl.exe. */
const FAKE_CHILD = {} as unknown as SpawnedProcess;

const TEST_CONFIG: SandboxConfig = {
  distroName: "vibecoding-build",
  distroUser: "builder",
  distroClaudePath: "/usr/bin/claude",
};

/** The absolute wsl.exe path the adapter resolves on this machine. */
const WSL_EXE = resolveWslExePath();

function spawnOpts(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    // Native-binary mode: the SDK hands us the HOST claude.exe path + CLI flags.
    command: "C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe",
    args: ["--input-format", "stream-json", "--output-format", "stream-json"],
    env: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

function captureSpawn(): {
  fn: SandboxSpawnFn;
  calls: Array<{
    command: string;
    args: readonly string[];
    options: { env: Record<string, string | undefined>; signal: AbortSignal };
  }>;
} {
  const calls: ReturnType<typeof captureSpawn>["calls"] = [];
  const fn: SandboxSpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return FAKE_CHILD;
  };
  return { fn, calls };
}

describe("sandboxConfigFromEnv", () => {
  it("falls back to the SANDBOX-SETUP.md defaults when env is unset", () => {
    const config = sandboxConfigFromEnv({});
    expect(config.distroName).toBe("vibecoding-build");
    expect(config.distroUser).toBe("builder");
    expect(config.distroClaudePath).toBe("/usr/bin/claude");
    expect(config.sandboxApiKey).toBeUndefined();
  });

  it("reads exactly the env it needs and nothing else (no host-secret leakage)", () => {
    const config = sandboxConfigFromEnv({
      BUILD_DISTRO_NAME: "custom-distro",
      BUILD_DISTRO_USER: "runner",
      BUILD_DISTRO_CLAUDE_PATH: "/opt/claude/bin/claude",
      TWITCH_CLIENT_SECRET: "leak-me",
      ANTHROPIC_API_KEY: "host-plan-key",
    });
    expect(config.distroName).toBe("custom-distro");
    expect(config.distroUser).toBe("runner");
    expect(config.distroClaudePath).toBe("/opt/claude/bin/claude");
    expect(config.sandboxApiKey).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("leak-me");
    expect(JSON.stringify(config)).not.toContain("host-plan-key");
  });

  it("populates the fallback key ONLY from the distinct SANDBOX_ANTHROPIC_API_KEY var", () => {
    const config = sandboxConfigFromEnv({ SANDBOX_ANTHROPIC_API_KEY: "sandbox-scoped" });
    expect(config.sandboxApiKey).toBe("sandbox-scoped");
  });
});

describe("resolveWslExePath", () => {
  it("resolves under the system root so the empty-env spawn needs no PATH lookup", () => {
    expect(resolveWslExePath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\wsl.exe");
    expect(resolveWslExePath({ SYSTEMROOT: "E:\\W" })).toBe("E:\\W\\System32\\wsl.exe");
    expect(resolveWslExePath({})).toBe("C:\\Windows\\System32\\wsl.exe");
  });
});

describe("createSandboxAdapter — spawn env isolation (SAND-03)", () => {
  it("spawns wsl.exe with an EMPTY Windows-side env — nothing of the host env exists in the child", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(spawnOpts());

    expect(calls[0]?.options.env).toEqual({});
  });

  it("injects the allowlist env LINUX-side via /usr/bin/env (PATH only on the primary path)", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(spawnOpts());

    const args = calls[0]?.args ?? [];
    const envIdx = args.indexOf("/usr/bin/env");
    expect(envIdx).toBeGreaterThan(-1);
    const assignments = args.slice(envIdx + 1, args.indexOf("/usr/bin/claude"));
    expect(assignments).toEqual(["PATH=/usr/bin:/bin"]);
    for (const assignment of assignments) {
      const key = assignment.split("=")[0] ?? "";
      expect(key, `host-secret-shaped key leaked into sandbox env: ${key}`).not.toMatch(
        HOST_SECRET_KEY,
      );
    }
  });

  it("NEVER carries the gallery PAT (GALLERY_GITHUB_TOKEN / GH_TOKEN) in the sandbox spawn env (T-hak-01)", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(spawnOpts());

    const args = calls[0]?.args ?? [];
    const envIdx = args.indexOf("/usr/bin/env");
    const assignments = args.slice(envIdx + 1, args.indexOf("/usr/bin/claude"));
    // Only PATH crosses on the primary path — no gallery token assignment at all.
    expect(assignments).toEqual(["PATH=/usr/bin:/bin"]);
    for (const assignment of assignments) {
      expect(assignment.startsWith("GALLERY_GITHUB_TOKEN=")).toBe(false);
      expect(assignment.startsWith("GH_TOKEN=")).toBe(false);
    }
    // The token names never appear anywhere in the spawn argv either.
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("GALLERY_GITHUB_TOKEN");
    expect(serialized).not.toContain("GH_TOKEN");
  });

  it("never leaks a host TWITCH_/ANTHROPIC_API_KEY even when present on the SDK-supplied opts.env", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    // opts.env carries what the SDK's default spawn would forward ({...process.env}
    // plus SDK vars) — it must be ignored entirely.
    adapter.spawn(
      spawnOpts({
        env: { TWITCH_CLIENT_SECRET: "xyz", ANTHROPIC_API_KEY: "host", PATH: "C:\\host\\bin" },
      }),
    );

    const call = calls[0];
    expect(call?.options.env).toEqual({});
    const serialized = JSON.stringify(call?.args);
    expect(serialized).not.toContain("xyz");
    expect(serialized).not.toContain("host");
    expect(serialized).not.toContain("TWITCH");
  });

  it("injects ONLY the sandbox-scoped key when the A1-false fallback is active", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: { ...TEST_CONFIG, sandboxApiKey: "sandbox-scoped-key" },
      spawnFn: fn,
    });

    adapter.spawn(spawnOpts());

    const args = calls[0]?.args ?? [];
    const envIdx = args.indexOf("/usr/bin/env");
    const assignments = args.slice(envIdx + 1, args.indexOf("/usr/bin/claude"));
    // The value is the DISTINCT sandbox-scoped credential, never a host key.
    expect(assignments).toEqual(["PATH=/usr/bin:/bin", "ANTHROPIC_API_KEY=sandbox-scoped-key"]);
    expect(calls[0]?.options.env).toEqual({});
  });
});

describe("createSandboxAdapter — host→distro launch translation", () => {
  it("substitutes the distro CLI for the host claude.exe and passes SDK flags verbatim via --exec (native-binary mode)", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });
    const signal = new AbortController().signal;

    adapter.spawn(
      spawnOpts({
        args: ["--input-format", "stream-json", "--mcp-config", '{"mcpServers":{"a b":{}}}'],
        signal,
      }),
    );

    expect(calls[0]?.command).toBe(WSL_EXE);
    expect(calls[0]?.args).toEqual([
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--cd",
      "~",
      "--exec",
      "/usr/bin/env",
      "PATH=/usr/bin:/bin",
      "/usr/bin/claude",
      "--input-format",
      "stream-json",
      "--mcp-config",
      '{"mcpServers":{"a b":{}}}',
    ]);
    expect(calls[0]?.options.signal).toBe(signal);
  });

  it("drops the node-exec prefix through cli.js in node mode — only CLI flags cross", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(
      spawnOpts({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [
          "--enable-source-maps",
          "C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js",
          "--output-format",
          "stream-json",
        ],
      }),
    );

    const args = calls[0]?.args ?? [];
    const claudeIdx = args.indexOf("/usr/bin/claude");
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(args.slice(claudeIdx)).toEqual(["/usr/bin/claude", "--output-format", "stream-json"]);
    // No host path fragment may survive translation.
    expect(JSON.stringify(args)).not.toContain("node.exe");
    expect(JSON.stringify(args)).not.toContain("cli.js");
  });

  it("honors the configured distro CLI path", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({
      config: { ...TEST_CONFIG, distroClaudePath: "/opt/claude/bin/claude" },
      spawnFn: fn,
    });

    adapter.spawn(spawnOpts());

    expect(calls[0]?.args).toContain("/opt/claude/bin/claude");
    expect(calls[0]?.args).not.toContain("/usr/bin/claude");
  });

  it("maps a POSIX-absolute opts.cwd to --cd and any host cwd to the build user's home", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(spawnOpts({ cwd: "/home/builder/workspace" }));
    adapter.spawn(spawnOpts({ cwd: "C:\\Users\\ross\\Projects\\twitch-does-vibecoding" }));
    adapter.spawn(spawnOpts({ cwd: undefined }));

    const cdOf = (i: number) => {
      const args = calls[i]?.args ?? [];
      return args[args.indexOf("--cd") + 1];
    };
    expect(cdOf(0)).toBe("/home/builder/workspace");
    expect(cdOf(1)).toBe("~");
    expect(cdOf(2)).toBe("~");
  });

  it("never forwards the host command path into the distro argv (regression: claude.exe passed verbatim)", () => {
    const { fn, calls } = captureSpawn();
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, spawnFn: fn });

    adapter.spawn(spawnOpts());

    expect(JSON.stringify(calls[0]?.args)).not.toContain("claude.exe");
  });
});

describe("createSandboxAdapter — terminate (BUILD-04)", () => {
  it("runs wsl.exe --terminate <distro> by absolute path (no PATH dependence)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => undefined);
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await adapter.terminate();

    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, ["--terminate", "vibecoding-build"]);
  });

  it("degrades a teardown failure to a logged error, never a throw (fail-closed)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("wsl.exe not found");
    });
    const logger = { error: vi.fn() } as unknown as NonNullable<SandboxAdapterDeps["logger"]>;
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn, logger });

    await expect(adapter.terminate()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("--terminate failed"),
    );
  });
});

describe("createSandboxAdapter — ensureWorkspaceDir (BL-01 fail-closed distro bootstrap)", () => {
  it("runs `mkdir -p <dir>` in the SAME distro/user via the execFileFn seam", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await adapter.ensureWorkspaceDir?.("/home/builder/projects/app-1");

    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, [
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "mkdir",
      "-p",
      "/home/builder/projects/app-1",
    ]);
  });

  it("REJECTS when execFileFn rejects — the fail-closed signal (NOT swallowed like terminate)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("mkdir: cannot create directory: Permission denied");
    });
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(adapter.ensureWorkspaceDir?.("/home/builder/projects/app-1")).rejects.toThrow(
      "Permission denied",
    );
  });
});

describe("createSandboxAdapter — workspaceHasFiles (HI-01 emptiness probe)", () => {
  it("runs `ls <dir>` (NO -A — dot-entries like .claude never count, EMPTY-01) and maps non-empty stdout → true", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "index.html\n" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(adapter.workspaceHasFiles?.("/home/builder/projects/app-1")).resolves.toBe(true);
    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, [
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "sh",
      "-lc",
      "ls /home/builder/projects/app-1 2>/dev/null | head -1",
    ]);
  });

  it("maps empty stdout → false (a genuinely empty dir scaffolds)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "  \n" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(adapter.workspaceHasFiles?.("/home/builder/projects/app-2")).resolves.toBe(false);
  });

  it("resolves TRUE when the probe rejects — never assert 'empty' when unsure (fail toward continue)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("wsl.exe not found");
    });
    const logger = { error: vi.fn() } as unknown as NonNullable<SandboxAdapterDeps["logger"]>;
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn, logger });

    await expect(adapter.workspaceHasFiles?.("/home/builder/projects/app-3")).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createSandboxAdapter — workspaceHasCommittableFiles (EMPTY-01 output probe)", () => {
  it("runs `ls <dir> | grep -v '^node_modules$'` in the SAME distro/user and maps non-empty stdout → true", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "index.html\n" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(
      adapter.workspaceHasCommittableFiles?.("/home/builder/projects/app-1"),
    ).resolves.toBe(true);
    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, [
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "sh",
      "-lc",
      "ls /home/builder/projects/app-1 2>/dev/null | grep -v '^node_modules$' | head -1",
    ]);
  });

  it("maps empty stdout → false (dotfiles-only / node_modules-only workspace: nothing committable)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "\n" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(
      adapter.workspaceHasCommittableFiles?.("/home/builder/projects/app-1"),
    ).resolves.toBe(false);
  });

  it("resolves TRUE when the probe rejects — a flaky probe must never fail a good live build", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("wsl.exe hiccup");
    });
    const logger = { error: vi.fn() } as unknown as NonNullable<SandboxAdapterDeps["logger"]>;
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn, logger });

    await expect(
      adapter.workspaceHasCommittableFiles?.("/home/builder/projects/app-1"),
    ).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createSandboxAdapter — preview dev-server lifecycle (quick-t8k, execFileFn seam ONLY)", () => {
  it("stopPreviewDevServer runs an END-ANCHORED pkill by port via sh -lc with `|| true` (no-match is success)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await adapter.stopPreviewDevServer?.(5555);

    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, [
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "sh",
      "-lc",
      "pkill -f 'http\\.server 5555$' || true",
    ]);
  });

  it("the pkill pattern carries the literal `$` anchor after the port — 5555 can never match 55555 (checker INFO a)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await adapter.stopPreviewDevServer?.(5555);

    const script = (execFileFn.mock.calls[0]?.[1] ?? []).at(-1) as string;
    expect(script).toContain("5555$'");
    expect(script).toContain("|| true");
  });

  it("startPreviewDevServer runs mkdir+cd+nohup python3 http.server with the port argv-final (matches the stop anchor)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "" }));
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await adapter.startPreviewDevServer?.("/home/builder/projects/app-3", 5555);

    expect(execFileFn).toHaveBeenCalledWith(WSL_EXE, [
      "-d",
      "vibecoding-build",
      "-u",
      "builder",
      "--",
      "sh",
      "-lc",
      "mkdir -p /home/builder/projects/app-3 && cd /home/builder/projects/app-3 && nohup python3 -m http.server 5555 >/dev/null 2>&1 & sleep 2",
    ]);
  });

  it("startPreviewDevServer REJECTS on wsl exec failure (the supervisor catches — adapter stays honest like ensureWorkspaceDir)", async () => {
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => {
      throw new Error("wsl.exe hiccup");
    });
    const adapter = createSandboxAdapter({ config: TEST_CONFIG, execFileFn });

    await expect(
      adapter.startPreviewDevServer?.("/home/builder/projects/app-1", 5555),
    ).rejects.toThrow("hiccup");
  });

  it("NEVER touches spawn()/terminate()/buildSandboxEnv — zero new process-spawn paths, zero env bytes in the scripts", async () => {
    const { fn: spawnFn, calls } = captureSpawn();
    const execFileFn = vi.fn<SandboxExecFileFn>(async () => ({ stdout: "" }));
    const adapter = createSandboxAdapter({
      config: { ...TEST_CONFIG, sandboxApiKey: "sandbox-scoped-key" },
      spawnFn,
      execFileFn,
    });

    await adapter.stopPreviewDevServer?.(5555);
    await adapter.startPreviewDevServer?.("/home/builder/projects/app-1", 5555);

    // No engine spawn, no wsl --terminate — distinct exec invocations only.
    expect(calls).toHaveLength(0);
    for (const call of execFileFn.mock.calls) {
      expect(call[1]).not.toContain("--terminate");
      // The scripts carry NO env assignments and NO secret-shaped bytes —
      // buildSandboxEnv is untouched (secrets-isolation invariant).
      const script = (call[1] ?? []).at(-1) as string;
      expect(script).not.toMatch(/ANTHROPIC|TWITCH|TOKEN|SECRET|PATH=/);
    }
  });
});

describe("buildSandboxOptions — defense-in-depth (T-03-14)", () => {
  it("fails loud if unavailable and never silently runs unsandboxed", () => {
    const opts = buildSandboxOptions();
    expect(opts.enabled).toBe(true);
    expect(opts.failIfUnavailable).toBe(true);
  });

  it("pre-populates a package-registry network allowlist and denies /mnt", () => {
    const opts = buildSandboxOptions();
    expect(opts.network?.allowedDomains).toContain("registry.npmjs.org");
    expect(opts.filesystem?.denyRead).toContain("/mnt");
    expect(opts.filesystem?.denyWrite).toContain("/mnt");
  });
});
