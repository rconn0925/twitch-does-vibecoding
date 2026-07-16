import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  createGalleryPublisher,
  type GalleryConfig,
  type GalleryExec,
  type GalleryFs,
  type ProjectRepoStore,
  resolveGalleryConfig,
  sanitizeCommitTitle,
  sanitizeRepoName,
  workspaceCopyFilter,
} from "./gallery-publisher.js";

/**
 * quick-260711-hak Task 2: the per-project host-side gallery publisher, tested
 * ENTIRELY against injected exec/fs/store/clock fakes — vitest never runs real
 * git/gh/fs/network (project seam discipline). Safety-critical assertions:
 *   - T-hak-01: GALLERY_GITHUB_TOKEN travels ONLY on the exec ENV — never in any
 *     argv element and never embedded in a remote-add / origin URL.
 *   - T-hak-02: chat titles reach git/gh only as sanitized argv elements of arg
 *     ARRAYS; the exec seam's type has no `shell` field at all; a hostile first
 *     prompt yields a [a-z0-9-] repo slug, never a shell invocation.
 *   - T-hak-03: publishNow NEVER rejects — failure is a resolved status + a loud
 *     logger.error, never a throw into the pipeline.
 *   - Per-project routing: one repo per generation; later prompts push to it.
 *   - W1: deletions propagate (non-.git entries cleared before each copy).
 */

const fakeLogger = (): Logger =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as Logger;

const TOKEN = "ghp_SECRETTOKEN123";
const TEST_CONFIG: GalleryConfig = {
  owner: "TwitchVibecodes",
  token: TOKEN,
  mirrorRootDir: "data/gallery-mirror",
  workspaceRootUnc: "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects",
};

interface ExecCall {
  file: string;
  args: string[];
  opts: { cwd?: string; env?: Record<string, string> } | undefined;
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
    if (args.includes("--porcelain")) return { stdout: " M index.html\n" };
    if (args.includes("rev-parse")) return { stdout: "abc1234def\n" };
    return { stdout: "" };
  };
  return { exec, calls };
}

/** A recording fs fake. `hasGit` controls the access(mirror/.git) probe. */
function captureFs(over?: { hasGit?: boolean; entries?: string[] }): {
  fsx: GalleryFs;
  rmCalls: string[];
  cpCalls: Array<{ src: string; dest: string }>;
  mkdirCalls: string[];
  writeFileCalls: Array<{ path: string; content: string }>;
} {
  const rmCalls: string[] = [];
  const cpCalls: Array<{ src: string; dest: string }> = [];
  const mkdirCalls: string[] = [];
  const writeFileCalls: Array<{ path: string; content: string }> = [];
  const hasGit = over?.hasGit ?? true;
  const entries = over?.entries ?? [".git", "index.html", "old.js"];
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
      if (!hasGit) throw new Error("ENOENT");
    },
    readdir: async () => entries,
    writeFile: async (path, content) => {
      writeFileCalls.push({ path, content });
    },
  };
  return { fsx, rmCalls, cpCalls, mkdirCalls, writeFileCalls };
}

/** In-memory ProjectRepoStore fake — no SQLite. */
function fakeStore(
  initial: Array<[number, string]> = [],
): ProjectRepoStore & { records: Array<[number, string]> } {
  const map = new Map<number, string>(initial);
  const records: Array<[number, string]> = [];
  return {
    lookup: (g) => map.get(g) ?? null,
    record: (g, name) => {
      map.set(g, name);
      records.push([g, name]);
    },
    knownNames: () => new Set(map.values()),
    records,
  };
}

const fixedClock = () => new Date("2026-07-11T09:05:00");

describe("sanitizeRepoName — hostile chat title → safe [a-z0-9-] slug (T-hak-02)", () => {
  it("reduces shell metachars + unicode + over-length to a safe slug", () => {
    const hostile = `x"; rm -rf ~ $(curl evil) café ${"A".repeat(200)}`;
    const slug = sanitizeRepoName(hostile, fixedClock);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/[\s$();"~`]/);
    // No trailing hyphen after truncation.
    expect(slug.endsWith("-")).toBe(false);
  });

  it("produces readable slugs for normal titles", () => {
    expect(sanitizeRepoName("Make a Counter App!", fixedClock)).toBe("make-a-counter-app");
    expect(sanitizeRepoName("  Snake   Game  ", fixedClock)).toBe("snake-game");
  });

  it("falls back to a dated slug from the injected clock when the title is unusable", () => {
    expect(sanitizeRepoName("", fixedClock)).toBe("vibe-20260711-0905");
    expect(sanitizeRepoName("   ", fixedClock)).toBe("vibe-20260711-0905");
    expect(sanitizeRepoName("!@#$%^&*()", fixedClock)).toBe("vibe-20260711-0905");
  });
});

describe("workspaceCopyFilter — the secrets gate (T-hak-02)", () => {
  it("rejects any path containing a node_modules segment", () => {
    expect(workspaceCopyFilter("app-1/node_modules")).toBe(false);
    expect(workspaceCopyFilter("app-1/node_modules/express/index.js")).toBe(false);
    expect(workspaceCopyFilter("app-1\\node_modules\\express\\index.js")).toBe(false);
  });

  it("rejects any basename starting with '.' (dotfiles AND dotdirs)", () => {
    expect(workspaceCopyFilter("app-1/.env")).toBe(false);
    expect(workspaceCopyFilter("app-1/.git")).toBe(false);
    expect(workspaceCopyFilter("app-1\\.config")).toBe(false);
  });

  it("accepts normal project files", () => {
    expect(workspaceCopyFilter("app-1/src/index.ts")).toBe(true);
    expect(workspaceCopyFilter("app-1/package.json")).toBe(true);
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
  it("returns null when GALLERY_GITHUB_TOKEN is unset/blank (auto-disable)", () => {
    expect(resolveGalleryConfig({})).toBeNull();
    expect(resolveGalleryConfig({ GALLERY_GITHUB_TOKEN: "   " })).toBeNull();
  });

  it("defaults owner to TwitchVibecodes and mirror/UNC roots when a token is present", () => {
    const config = resolveGalleryConfig({ GALLERY_GITHUB_TOKEN: "ghp_x" });
    expect(config).not.toBeNull();
    expect(config?.owner).toBe("TwitchVibecodes");
    expect(config?.token).toBe("ghp_x");
    expect(config?.mirrorRootDir).toBe("data/gallery-mirror");
    expect(config?.workspaceRootUnc).toBe(
      "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects",
    );
  });

  it("returns null ONLY for the exact string 'false' (AUTO_ROUND_ENABLED idiom, inverted)", () => {
    expect(
      resolveGalleryConfig({ GALLERY_GITHUB_TOKEN: "t", GALLERY_PUBLISH_ENABLED: "false" }),
    ).toBeNull();
    expect(
      resolveGalleryConfig({ GALLERY_GITHUB_TOKEN: "t", GALLERY_PUBLISH_ENABLED: " false " }),
    ).toBeNull();
    expect(
      resolveGalleryConfig({ GALLERY_GITHUB_TOKEN: "t", GALLERY_PUBLISH_ENABLED: "0" }),
    ).not.toBeNull();
  });

  it("honors GALLERY_GITHUB_OWNER and the sandbox distro/user env overrides", () => {
    const config = resolveGalleryConfig({
      GALLERY_GITHUB_TOKEN: "t",
      GALLERY_GITHUB_OWNER: "  CustomOwner  ",
      BUILD_DISTRO_NAME: "custom-distro",
      BUILD_DISTRO_USER: "someone",
    });
    expect(config?.owner).toBe("CustomOwner");
    expect(config?.workspaceRootUnc).toBe(
      "\\\\wsl.localhost\\custom-distro\\home\\someone\\projects",
    );
  });
});

describe("createGalleryPublisher.publishNow — per-project routing", () => {
  it("FIRST prompt of a generation: gh repo create <owner>/<name> --public + records the name", async () => {
    const { exec, calls } = captureExec();
    const { fsx, cpCalls } = captureFs({ hasGit: false });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
      now: fixedClock,
    });

    const result = await publisher.publishNow({
      generation: 1,
      title: "make a counter app",
      taskId: "task-1",
    });

    expect(result).toMatchObject({ status: "published", commitHash: "abc1234def" });
    // Repo created under the configured owner with the sanitized name.
    const create = calls.find((c) => c.file === "gh");
    expect(create?.args).toEqual([
      "repo",
      "create",
      "TwitchVibecodes/make-a-counter-app",
      "--public",
    ]);
    // Recorded ONLY after the create — keyed on generation.
    expect(store.records).toEqual([[1, "make-a-counter-app"]]);
    // Fresh mirror wired: init + remote add with a PLAIN https origin (no token).
    const remoteAdd = calls.find((c) => c.args.includes("remote"));
    expect(remoteAdd?.args).toEqual([
      "-C",
      "data/gallery-mirror/make-a-counter-app",
      "remote",
      "add",
      "origin",
      "https://github.com/TwitchVibecodes/make-a-counter-app.git",
    ]);
    // Snapshot copied from the UNC workspace generation dir into the repo root.
    expect(cpCalls).toEqual([
      {
        src: "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects\\app-1",
        dest: "data/gallery-mirror/make-a-counter-app",
      },
    ]);
  });

  it("SECOND prompt of the same generation reuses the repo — NO gh repo create, pushes the same mirror", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "make-a-counter-app"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({
      generation: 1,
      title: "add a reset button",
      taskId: "task-2",
    });

    expect(result.status).toBe("published");
    // Never created (or re-created) a repo; never recorded a new name. (The
    // only gh call allowed here is the quick-1ki Pages enablement, `gh api`.)
    expect(calls.some((c) => c.file === "gh" && c.args.includes("create"))).toBe(false);
    expect(store.records).toEqual([]);
    // Pushed to the SAME per-project mirror.
    const push = calls.find((c) => c.args.includes("push"));
    expect(push?.args).toContain("data/gallery-mirror/make-a-counter-app");
  });

  it("two DIFFERENT generations create two DIFFERENT repos (per-project routing)", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    await publisher.publishNow({ generation: 1, title: "counter app", taskId: "t1" });
    await publisher.publishNow({ generation: 2, title: "snake game", taskId: "t2" });

    const creates = calls
      .filter((c) => c.file === "gh" && c.args.includes("create"))
      .map((c) => c.args.find((a) => a.startsWith("TwitchVibecodes/")));
    expect(creates).toEqual(["TwitchVibecodes/counter-app", "TwitchVibecodes/snake-game"]);
    expect(store.records).toEqual([
      [1, "counter-app"],
      [2, "snake-game"],
    ]);
  });

  it("dedups a colliding base slug against knownNames (base → -2 → -3)", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore([
      [8, "counter-app"],
      [9, "counter-app-2"],
    ]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    await publisher.publishNow({ generation: 1, title: "Counter App", taskId: "t1" });

    const create = calls.find((c) => c.file === "gh");
    expect(create?.args).toContain("TwitchVibecodes/counter-app-3");
    expect(store.records).toEqual([[1, "counter-app-3"]]);
  });
});

describe("createGalleryPublisher.publishNow — safety invariants", () => {
  it("hostile title reaches the commit as ONE sanitized argv element; NO shell key on any call (T-hak-02)", async () => {
    const hostile = `x"; rm -rf ~ $(curl evil) \r\n${"A".repeat(200)}`;
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[3, "safe-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 3, title: hostile, taskId: "task-3" });
    expect(result.status).toBe("published");

    const commit = calls.find((c) => c.args.includes("commit"));
    expect(commit?.args.slice(0, 8)).toEqual([
      "-C",
      "data/gallery-mirror/safe-repo",
      "-c",
      "user.name=Twitch Vibecodes",
      "-c",
      "user.email=twitchvibecodes@users.noreply.github.com",
      "commit",
      "-m",
    ]);
    expect(commit?.args).toHaveLength(9);
    const message = commit?.args[8] ?? "";
    expect(message).toBe(sanitizeCommitTitle(hostile));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are ABSENT is the point
    expect(message).not.toMatch(/[\r\n\t\x00-\x1f]/);
    // EVERY exec call is git/gh with an arg ARRAY and NO shell key.
    for (const call of calls) {
      expect(["git", "gh"]).toContain(call.file);
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.opts && "shell" in call.opts).toBeFalsy();
    }
    // Type-level: `shell` is UNREPRESENTABLE at the exec seam.
    // @ts-expect-error — GalleryExec's opts type has no `shell` field
    const unrepresentable: Parameters<GalleryExec>[2] = { shell: true };
    expect(unrepresentable).toBeDefined();
  });

  it("GH_TOKEN travels on the gh/git ENV only — never in any argv element or remote URL (T-hak-01)", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    await publisher.publishNow({ generation: 1, title: "make a counter", taskId: "t1" });

    // The token appears on the create + push env.
    const create = calls.find((c) => c.file === "gh");
    const push = calls.find((c) => c.args.includes("push"));
    expect(create?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    expect(push?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    // The token NEVER appears in any argv element of any call, nor in the origin URL.
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN);
      }
    }
    const remoteAdd = calls.find((c) => c.args.includes("remote"));
    expect(remoteAdd?.args.at(-1)).toBe("https://github.com/TwitchVibecodes/make-a-counter.git");
  });

  it("W1: DELETED workspace files disappear — non-.git entries are cleared before each copy (never rm the mirror root)", async () => {
    const { exec } = captureExec();
    const { fsx, rmCalls, cpCalls } = captureFs({
      hasGit: true,
      entries: [".git", "index.html", "old.js"],
    });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });

    // Stale tracked files are removed individually — but NEVER .git, and NEVER
    // the whole mirror dir (a plain cp-over-top / rm-mirror would leak or wipe).
    expect(rmCalls).toContain("data/gallery-mirror/my-repo/index.html");
    expect(rmCalls).toContain("data/gallery-mirror/my-repo/old.js");
    expect(rmCalls).not.toContain("data/gallery-mirror/my-repo/.git");
    expect(rmCalls).not.toContain("data/gallery-mirror/my-repo");
    // The fresh snapshot is copied in after clearing.
    expect(cpCalls).toEqual([
      {
        src: "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects\\app-1",
        dest: "data/gallery-mirror/my-repo",
      },
    ]);
  });

  it("W2: a continue-path publish whose mirror lost its .git re-clones from origin before git ops", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });
    expect(result.status).toBe("published");
    // Re-cloned (no gh create), token on the clone env, plain origin URL.
    const clone = calls.find((c) => c.args.includes("clone"));
    expect(clone?.args).toEqual([
      "clone",
      "https://github.com/TwitchVibecodes/my-repo.git",
      "data/gallery-mirror/my-repo",
    ]);
    expect(clone?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    // No repo re-create on the continue path (gh api Pages calls are allowed).
    expect(calls.some((c) => c.file === "gh" && c.args.includes("create"))).toBe(false);
  });

  it("W2: a gh repo create name-collision ('already exists') is non-fatal — proceeds to push", async () => {
    const { exec, calls } = captureExec((call) =>
      call.file === "gh"
        ? Promise.reject(new Error("GraphQL: Name already exists on this account"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore();
    const logger = fakeLogger();
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 1, title: "counter", taskId: "t1" });
    expect(result.status).toBe("published");
    // Despite the collision, the flow still pushed and recorded the name.
    expect(calls.some((c) => c.args.includes("push"))).toBe(true);
    expect(store.records).toEqual([[1, "counter"]]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("failure isolation: a rejecting push RESOLVES { status: 'failed' } and logs loudly (T-hak-03)", async () => {
    const logger = fakeLogger();
    const { exec, calls } = captureExec((call) =>
      call.args.includes("push") ? Promise.reject(new Error("remote hung up")) : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[2, "repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 2, title: "t", taskId: "task-2" });
    expect(result).toEqual({
      status: "failed",
      commitHash: null,
      detail: expect.stringContaining("remote hung up") as unknown as string,
    });
    expect(logger.error).toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes("push"))).toBe(true);
  });

  it("no changes: empty porcelain → no commit/push, resolves { status: 'no-changes' }", async () => {
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--porcelain") ? Promise.resolve({ stdout: "" }) : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result).toMatchObject({ status: "no-changes", commitHash: null });
    expect(calls.some((c) => c.args.includes("commit"))).toBe(false);
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("EMPTY-01 preflight: a dotfiles-only workspace (.claude debris) publishes NOTHING and creates NO repo", async () => {
    const { exec, calls } = captureExec();
    const { fsx, cpCalls } = captureFs({ hasGit: false, entries: [".claude", ".bash_profile"] });
    const store = fakeStore();
    const logger = fakeLogger();
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({
      generation: 1,
      title: "build a simple digital clock web page",
      taskId: "t1",
    });

    expect(result).toMatchObject({ status: "no-changes", commitHash: null });
    expect(result.detail).toContain("no committable files");
    // The regression that motivated this: gh repo create ran BEFORE any content
    // check and littered an empty public repo. Now: zero exec calls, no record.
    expect(calls).toHaveLength(0);
    expect(store.records).toEqual([]);
    expect(cpCalls).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("EMPTY-01 preflight: a node_modules-only workspace is also skipped (copy filter would strip it)", async () => {
    const { exec, calls } = captureExec();
    const { fsx } = captureFs({ hasGit: false, entries: ["node_modules"] });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 2, title: "t", taskId: "t2" });
    expect(result.status).toBe("no-changes");
    expect(calls).toHaveLength(0);
    expect(store.records).toEqual([]);
  });

  it("EMPTY-01 preflight: an UNREADABLE workspace dir resolves { status: 'failed' } loudly — never a silent empty repo", async () => {
    const { exec, calls } = captureExec();
    const logger = fakeLogger();
    const { fsx } = captureFs({ hasGit: false });
    fsx.readdir = async () => {
      throw new Error("ENOENT: \\\\wsl.localhost unreachable");
    };
    const store = fakeStore();
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("serialization: two overlapping publishNow calls never interleave their exec sequences", async () => {
    const labels: string[] = [];
    const verbs = ["clone", "init", "add", "status", "commit", "push", "rev-parse"];
    const exec: GalleryExec = async (file, args) => {
      const verb = args.find((a) => verbs.includes(a)) ?? args[0] ?? "?";
      labels.push(`${file}:${verb}`);
      await new Promise((r) => setImmediate(r));
      if (args.includes("--porcelain")) return { stdout: " M x\n" };
      if (args.includes("rev-parse")) return { stdout: "hash\n" };
      return { stdout: "" };
    };
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([
      [1, "repo-a"],
      [2, "repo-b"],
    ]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
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
    // The first project's full git sequence precedes the second's — no
    // interleave. (quick-1ki: each publish now carries the Pages enablement
    // pair after its push — rev-parse --abbrev-ref, then gh api.)
    expect(labels).toEqual([
      "git:add",
      "git:status",
      "git:commit",
      "git:push",
      "git:rev-parse",
      "gh:api",
      "git:rev-parse",
      "git:add",
      "git:status",
      "git:commit",
      "git:push",
      "git:rev-parse",
      "gh:api",
      "git:rev-parse",
    ]);
  });
});

// ── quick-1ki Task 1: ensurePagesEnabled — every pushed publish gets Pages ──

describe("createGalleryPublisher — GitHub Pages enablement (quick-1ki)", () => {
  it("after a successful publish, ONE gh api …/pages call fires with the ACTUAL branch + root path; token on env ONLY", async () => {
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--abbrev-ref") ? Promise.resolve({ stdout: "master\n" }) : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });
    expect(result.status).toBe("published");

    const pages = calls.filter((c) => c.args.some((a) => a.endsWith("/pages")));
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.file).toBe("gh");
    expect(page?.args).toEqual([
      "api",
      "--method",
      "POST",
      "repos/TwitchVibecodes/my-repo/pages",
      "-f",
      "source[branch]=master",
      "-f",
      "source[path]=/",
    ]);
    // The branch came from the rev-parse --abbrev-ref fake, never hardcoded.
    expect(page?.args).toContain("source[branch]=master");
    // PAT on the env of that call only — never in any argv element anywhere.
    expect(page?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN);
      }
    }
    // Fires AFTER the push (the repo's branch must exist on the remote first).
    const pushIdx = calls.findIndex((c) => c.args.includes("push"));
    const pagesIdx = calls.findIndex((c) => c.args.some((a) => a.endsWith("/pages")));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBeGreaterThan(pushIdx);
  });

  it("a Pages call rejecting with 409 Conflict leaves the result 'published' with NO error log (quiet no-op)", async () => {
    const logger = fakeLogger();
    const { exec } = captureExec((call) =>
      call.args.some((a) => a.endsWith("/pages"))
        ? Promise.reject(new Error("HTTP 409: Conflict — Pages already enabled"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });
    expect(result.status).toBe("published");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a Pages call rejecting with ANY other error ALSO leaves 'published' — warn logged, non-fatal (T-1ki-04)", async () => {
    const logger = fakeLogger();
    const { exec } = captureExec((call) =>
      call.args.some((a) => a.endsWith("/pages"))
        ? Promise.reject(new Error("HTTP 500: server exploded"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });
    expect(result).toMatchObject({ status: "published", commitHash: "abc1234def" });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a rejecting rev-parse --abbrev-ref (branch read) is ALSO non-fatal — still 'published'", async () => {
    const logger = fakeLogger();
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--abbrev-ref")
        ? Promise.reject(new Error("fatal: not a git repository"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.publishNow({ generation: 1, title: "update", taskId: "t1" });
    expect(result.status).toBe("published");
    expect(logger.warn).toHaveBeenCalled();
    // The gh api call never ran (no branch to point it at).
    expect(calls.some((c) => c.args.some((a) => a.endsWith("/pages")))).toBe(false);
  });

  it("NO Pages call on the no-changes path — nothing was pushed", async () => {
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--porcelain") ? Promise.resolve({ stdout: "" }) : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result.status).toBe("no-changes");
    expect(calls.some((c) => c.args.some((a) => a.endsWith("/pages")))).toBe(false);
  });
});

// ── quick-1ki Task 2: index-site publish chained after each project publish ──

describe("createGalleryPublisher — gallery index publish (quick-1ki)", () => {
  const INDEX_ENTRIES = [
    {
      title: "make a counter app",
      repoName: "make-a-counter-app",
      nightLabel: "Tuesday, July 8, 2026",
      provenance: "vote" as const,
    },
  ];

  it("a 'published' publish is FOLLOWED on the SAME chain by the index repo create/commit/push (project push first)", async () => {
    const { exec, calls } = captureExec();
    const { fsx, writeFileCalls } = captureFs({ hasGit: false });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      indexEntries: () => INDEX_ENTRIES,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "counter", taskId: "t1" });
    expect(result.status).toBe("published");

    // The index-site repo was created under the LOWERCASED-owner user-site name.
    const indexCreate = calls.find(
      (c) => c.file === "gh" && c.args.includes("TwitchVibecodes/twitchvibecodes.github.io"),
    );
    expect(indexCreate?.args).toEqual([
      "repo",
      "create",
      "TwitchVibecodes/twitchvibecodes.github.io",
      "--public",
    ]);
    // The rendered page was written into the underscore mirror (unreachable by
    // sanitizeRepoName — no collision with project mirrors), disclaimer intact.
    expect(writeFileCalls).toHaveLength(1);
    expect(writeFileCalls[0]?.path).toBe("data/gallery-mirror/_index-site/index.html");
    expect(writeFileCalls[0]?.content).toContain("unreviewed by humans");
    expect(writeFileCalls[0]?.content).toContain("make a counter app");
    // Ordering: the PROJECT push strictly precedes the INDEX push.
    const pushes = calls.filter((c) => c.args.includes("push"));
    expect(pushes).toHaveLength(2);
    expect(pushes[0]?.args).toContain("data/gallery-mirror/counter");
    expect(pushes[1]?.args).toContain("data/gallery-mirror/_index-site");
    // The index push carries the SAME credential-helper invocation + env token.
    expect(pushes[1]?.args.slice(0, 4)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
    ]);
    expect(pushes[1]?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    // The index mirror's origin is a PLAIN https URL — token never on disk.
    const indexRemote = calls.find(
      (c) => c.args.includes("remote") && c.args.includes("data/gallery-mirror/_index-site"),
    );
    expect(indexRemote?.args.at(-1)).toBe(
      "https://github.com/TwitchVibecodes/twitchvibecodes.github.io.git",
    );
    // Token NEVER in any argv element of any call (T-1ki-03).
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN);
      }
    }
  });

  it("an index-side exec failure still resolves the ORIGINAL 'published' result + logger.error fired (T-1ki-04)", async () => {
    const logger = fakeLogger();
    const { exec } = captureExec((call) =>
      call.args.includes("push") && call.args.includes("data/gallery-mirror/_index-site")
        ? Promise.reject(new Error("index remote hung up"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      indexEntries: () => INDEX_ENTRIES,
      logger,
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result).toMatchObject({ status: "published", commitHash: "abc1234def" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("an 'already exists' index repo create is tolerated (user-site repo persists across publishes)", async () => {
    const { exec, calls } = captureExec((call) =>
      call.file === "gh" &&
      call.args.includes("create") &&
      call.args.includes("TwitchVibecodes/twitchvibecodes.github.io")
        ? Promise.reject(new Error("Name already exists on this account"))
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const logger = fakeLogger();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      indexEntries: () => INDEX_ENTRIES,
      logger,
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result.status).toBe("published");
    // The index push still went out despite the create collision.
    const indexPush = calls.find(
      (c) => c.args.includes("push") && c.args.includes("data/gallery-mirror/_index-site"),
    );
    expect(indexPush).toBeDefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("an unchanged index (empty porcelain in the index mirror) skips commit/push silently", async () => {
    const { exec, calls } = captureExec((call) =>
      call.args.includes("--porcelain") && call.args.includes("data/gallery-mirror/_index-site")
        ? Promise.resolve({ stdout: "" })
        : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      indexEntries: () => INDEX_ENTRIES,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result.status).toBe("published");
    const indexCommit = calls.find(
      (c) => c.args.includes("commit") && c.args.includes("data/gallery-mirror/_index-site"),
    );
    const indexPush = calls.find(
      (c) => c.args.includes("push") && c.args.includes("data/gallery-mirror/_index-site"),
    );
    expect(indexCommit).toBeUndefined();
    expect(indexPush).toBeUndefined();
  });

  it("'no-changes' and 'failed' publishes trigger ZERO index activity", async () => {
    // no-changes: dotfiles-only workspace (EMPTY-01 preflight short-circuits).
    {
      const { exec, calls } = captureExec();
      const { fsx, writeFileCalls } = captureFs({ hasGit: false, entries: [".claude"] });
      const publisher = createGalleryPublisher({
        config: TEST_CONFIG,
        store: fakeStore(),
        exec,
        fsx,
        indexEntries: () => INDEX_ENTRIES,
        logger: fakeLogger(),
      });
      const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
      expect(result.status).toBe("no-changes");
      expect(calls).toHaveLength(0);
      expect(writeFileCalls).toEqual([]);
    }
    // failed: the project push rejects — the index step never starts.
    {
      const { exec, calls } = captureExec((call) =>
        call.args.includes("push") ? Promise.reject(new Error("remote hung up")) : undefined,
      );
      const { fsx, writeFileCalls } = captureFs({ hasGit: true });
      const publisher = createGalleryPublisher({
        config: TEST_CONFIG,
        store: fakeStore([[2, "repo"]]),
        exec,
        fsx,
        indexEntries: () => INDEX_ENTRIES,
        logger: fakeLogger(),
      });
      const result = await publisher.publishNow({ generation: 2, title: "t", taskId: "t2" });
      expect(result.status).toBe("failed");
      expect(writeFileCalls).toEqual([]);
      expect(calls.some((c) => c.args.some((a) => a.includes("_index-site")))).toBe(false);
    }
  });

  it("ABSENT indexEntries → index publishing entirely OFF (existing compositions unchanged)", async () => {
    const { exec, calls } = captureExec();
    const { fsx, writeFileCalls } = captureFs({ hasGit: true });
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store: fakeStore([[1, "my-repo"]]),
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.publishNow({ generation: 1, title: "t", taskId: "t1" });
    expect(result.status).toBe("published");
    expect(writeFileCalls).toEqual([]);
    expect(calls.some((c) => c.args.some((a) => a.includes("_index-site")))).toBe(false);
  });
});

// ── quick-q5n Task 2: revertLast — mirror git-revert + workspace write-back ──

const WS_DIR = "\\\\wsl.localhost\\vibecoding-build\\home\\builder\\projects\\app-1";

/** rev-list responds with `count`; everything else follows captureExec defaults. */
function revertExec(
  count: string,
  behavior?: (call: ExecCall) => Promise<{ stdout: string }> | undefined,
): { exec: GalleryExec; calls: ExecCall[] } {
  return captureExec((call) => {
    const overridden = behavior?.(call);
    if (overridden) return overridden;
    if (call.args.includes("rev-list")) return Promise.resolve({ stdout: `${count}\n` });
    return undefined;
  });
}

describe("createGalleryPublisher.revertLast — chat-voted rollback (quick-q5n)", () => {
  it("happy path: git revert --no-edit HEAD with -c identity, copy-first write-back, push → { status: 'reverted', commitHash }", async () => {
    const { exec, calls } = revertExec("3");
    const { fsx, cpCalls } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.revertLast({ generation: 1, taskId: "task-r1" });

    expect(result).toMatchObject({ status: "reverted", commitHash: "abc1234def" });
    // Exact rev-list guard invocation.
    const revList = calls.find((c) => c.args.includes("rev-list"));
    expect(revList?.args).toEqual([
      "-C",
      "data/gallery-mirror/my-repo",
      "rev-list",
      "--count",
      "HEAD",
    ]);
    // Exact revert invocation: -c identity, --no-edit, HEAD — arg array only.
    const revert = calls.find((c) => c.args.includes("revert"));
    expect(revert?.args).toEqual([
      "-C",
      "data/gallery-mirror/my-repo",
      "-c",
      "user.name=Twitch Vibecodes",
      "-c",
      "user.email=twitchvibecodes@users.noreply.github.com",
      "revert",
      "--no-edit",
      "HEAD",
    ]);
    // Identical push invocation to publishNow: credential helper, PAT env-only.
    const push = calls.find((c) => c.args.includes("push"));
    expect(push?.args).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "-C",
      "data/gallery-mirror/my-repo",
      "push",
      "-u",
      "origin",
      "HEAD",
    ]);
    expect(push?.opts?.env?.GH_TOKEN).toBe(TOKEN);
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(TOKEN);
      }
    }
    // Write-back: mirror → workspace UNC dir (reversed direction, same fs seam).
    expect(cpCalls).toEqual([{ src: "data/gallery-mirror/my-repo", dest: WS_DIR }]);
  });

  it("prunes stale TOP-LEVEL workspace entries absent from the mirror ONLY after the cp (dot-entries + node_modules survive)", async () => {
    const { exec } = revertExec("3");
    const ops: string[] = [];
    const { fsx } = captureFs({ hasGit: true });
    fsx.readdir = async (p) =>
      p.startsWith("\\\\wsl.localhost")
        ? ["index.html", "stale.js", ".claude", "node_modules"]
        : [".git", "index.html"];
    fsx.cp = async (src, dest) => {
      ops.push(`cp:${src}->${dest}`);
    };
    fsx.rm = async (p) => {
      ops.push(`rm:${p}`);
    };
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result.status).toBe("reverted");
    // COPY-FIRST ordering: the cp happens before any workspace rm.
    expect(ops).toEqual([`cp:data/gallery-mirror/my-repo->${WS_DIR}`, `rm:${WS_DIR}\\stale.js`]);
  });

  it("no stored repo → { status: 'nothing-to-revert' }, ZERO exec calls, workspace untouched", async () => {
    const { exec, calls } = revertExec("3");
    const { fsx, rmCalls, cpCalls } = captureFs({ hasGit: true });
    const store = fakeStore();
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result).toMatchObject({ status: "nothing-to-revert", commitHash: null });
    expect(calls).toHaveLength(0);
    expect(rmCalls).toEqual([]);
    expect(cpCalls).toEqual([]);
  });

  it("rev-list count < 2 → { status: 'nothing-to-revert' } — reverting the only commit would empty the project", async () => {
    const { exec, calls } = revertExec("1");
    const { fsx, rmCalls, cpCalls } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result).toMatchObject({ status: "nothing-to-revert", commitHash: null });
    expect(calls.some((c) => c.args.includes("revert"))).toBe(false);
    // Workspace fs never touched.
    expect(rmCalls.filter((p) => p.startsWith("\\\\wsl.localhost"))).toEqual([]);
    expect(cpCalls.filter((c) => c.dest.startsWith("\\\\wsl.localhost"))).toEqual([]);
  });

  it("a rejecting git revert → best-effort revert --abort, resolves failed, workspace fs NEVER touched (invariant #7)", async () => {
    const logger = fakeLogger();
    const { exec, calls } = revertExec("3", (call) =>
      call.args.includes("revert") && !call.args.includes("--abort")
        ? Promise.reject(new Error("could not revert: merge conflict"))
        : undefined,
    );
    const { fsx, rmCalls, cpCalls } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result.status).toBe("failed");
    expect(result.commitHash).toBeNull();
    // Best-effort abort attempted.
    const abort = calls.find((c) => c.args.includes("--abort"));
    expect(abort?.args).toEqual(["-C", "data/gallery-mirror/my-repo", "revert", "--abort"]);
    // NO fs op receives a workspace UNC path on this branch.
    expect(rmCalls.filter((p) => p.startsWith("\\\\wsl.localhost"))).toEqual([]);
    expect(cpCalls.filter((c) => c.dest.startsWith("\\\\wsl.localhost"))).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it("a rejecting revert whose --abort ALSO rejects still resolves failed (never throws)", async () => {
    const { exec } = revertExec("3", (call) =>
      call.args.includes("revert") ? Promise.reject(new Error("busted")) : undefined,
    );
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    await expect(publisher.revertLast({ generation: 1, taskId: "t" })).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("a rejecting mirror→workspace cp → failed, ZERO rm on workspace paths (pre-revert files provably intact), mirror commit stays", async () => {
    const logger = fakeLogger();
    const { exec, calls } = revertExec("3");
    const rmPaths: string[] = [];
    const { fsx } = captureFs({ hasGit: true });
    fsx.rm = async (p) => {
      rmPaths.push(p);
    };
    fsx.cp = async (_src, dest) => {
      if (dest.startsWith("\\\\wsl.localhost")) throw new Error("UNC write failed mid-copy");
    };
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({ config: TEST_CONFIG, store, exec, fsx, logger });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result.status).toBe("failed");
    // Copy-first ordering: NO rm has run against the workspace — every
    // pre-revert file is still there (worst case: a buildable superset).
    expect(rmPaths.filter((p) => p.startsWith("\\\\wsl.localhost"))).toEqual([]);
    // The mirror-side revert commit exists (divergence tolerated — the next
    // publishNow's refreshSnapshot re-syncs the mirror FROM the workspace).
    expect(calls.some((c) => c.args.includes("revert"))).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("a missing mirror re-clones from origin before any git op (continueRepo reuse)", async () => {
    const { exec, calls } = revertExec("3");
    const { fsx } = captureFs({ hasGit: false });
    const store = fakeStore([[1, "my-repo"]]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const result = await publisher.revertLast({ generation: 1, taskId: "t" });
    expect(result.status).toBe("reverted");
    const cloneIdx = calls.findIndex((c) => c.args.includes("clone"));
    const revListIdx = calls.findIndex((c) => c.args.includes("rev-list"));
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeLessThan(revListIdx);
  });

  it("serialization: an overlapping publishNow and revertLast share ONE chain — no interleaved git", async () => {
    const labels: string[] = [];
    const verbs = [
      "clone",
      "init",
      "add",
      "status",
      "commit",
      "push",
      "rev-parse",
      "rev-list",
      "revert",
    ];
    const exec: GalleryExec = async (file, args) => {
      const verb = args.find((a) => verbs.includes(a)) ?? args[0] ?? "?";
      labels.push(`${file}:${verb}`);
      await new Promise((r) => setImmediate(r));
      if (args.includes("--porcelain")) return { stdout: " M x\n" };
      if (args.includes("rev-parse")) return { stdout: "hash\n" };
      if (args.includes("rev-list")) return { stdout: "3\n" };
      return { stdout: "" };
    };
    const { fsx } = captureFs({ hasGit: true });
    const store = fakeStore([
      [1, "repo-a"],
      [2, "repo-b"],
    ]);
    const publisher = createGalleryPublisher({
      config: TEST_CONFIG,
      store,
      exec,
      fsx,
      logger: fakeLogger(),
    });

    const [pub, rev] = await Promise.all([
      publisher.publishNow({ generation: 1, title: "first", taskId: "t1" }),
      publisher.revertLast({ generation: 2, taskId: "t2" }),
    ]);
    expect(pub.status).toBe("published");
    expect(rev.status).toBe("reverted");
    // The publish's full sequence (incl. its quick-1ki Pages pair) precedes
    // the revert's — no interleave. Reverts do NOT re-enable Pages.
    expect(labels).toEqual([
      "git:add",
      "git:status",
      "git:commit",
      "git:push",
      "git:rev-parse",
      "gh:api",
      "git:rev-parse",
      "git:rev-list",
      "git:revert",
      "git:push",
      "git:rev-parse",
    ]);
  });
});
