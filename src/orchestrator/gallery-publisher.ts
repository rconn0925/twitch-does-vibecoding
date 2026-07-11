/**
 * quick-22l gallery snapshot publisher — HOST-side post-build auto-commit.
 *
 * After each build that finalizes `done`, the orchestrator (host process, the
 * streamer's own git credentials) commits + pushes a snapshot of the persistent
 * workspace generation dir to the private gallery repo. The chat/build agent
 * NEVER gets GitHub access: publishing is a controlled host-side snapshot, and
 * the streamer's git/gh credentials live in the HOST credential manager only —
 * they never enter the sandbox (T-22l-05; sandbox-process.ts is untouched).
 *
 * Secrets discipline (T-22l-03):
 *   - workspaceCopyFilter rejects node_modules segments and every dot-basename
 *     (.env, .git, .cache, .config — dotfiles AND dotdirs), so nothing from the
 *     workspace's dotfiles can enter a commit;
 *   - nothing from the orchestrator's .env is ever written into the mirror;
 *   - the local mirror sits under `data/gallery-mirror`, covered by the repo's
 *     `data/` .gitignore entry (verified) — the mirror never leaks into THIS
 *     repo's history either.
 *
 * Shell-injection surface (T-22l-02): every git invocation goes through the
 * GalleryExec seam — execFile with an ARG ARRAY, never a shell string. The seam
 * type deliberately has NO `shell` field, so `shell: true` is unrepresentable.
 * sanitizeCommitTitle is additional message hygiene, not the security boundary.
 *
 * Failure isolation (T-22l-04): publishNow NEVER rejects. Any failure resolves
 * `{ status: "failed" }` after a loud pino error — the show loop, finalize, and
 * halt paths are structurally unreachable from a publish failure.
 *
 * Every external touch-point is INJECTED (exec/fs) so vitest never runs real
 * git/fs/network — the project seam discipline.
 */

import { execFile } from "node:child_process";
import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";

/** What a `done` build hands the publisher. `title` is chat-derived — hostile. */
export interface PublishInput {
  /** The internally-generated workspace generation INTEGER — never chat text in paths (workspace.ts doctrine). */
  generation: number;
  /** The gate-APPROVED task title (D-03) — still viewer-authored, treated as hostile. */
  title: string;
  taskId: string;
}

/** publishNow's resolved outcome — it NEVER rejects (T-22l-04). */
export interface PublishResult {
  status: "published" | "no-changes" | "failed";
  commitHash: string | null;
  detail: string;
}

export interface GalleryPublisher {
  publishNow(input: PublishInput): Promise<PublishResult>;
}

/**
 * The exec seam: execFile-style ARG ARRAYS only. Deliberately NO `shell` field
 * in the opts type — `shell: true` is unrepresentable at this seam (T-22l-02).
 */
export type GalleryExec = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string }>;

/** The fs seam — the node:fs/promises subset the publisher touches. */
export interface GalleryFs {
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  cp(
    src: string,
    dest: string,
    opts: { recursive: boolean; filter?: (src: string) => boolean },
  ): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  access(path: string): Promise<void>;
}

export interface GalleryConfig {
  repoUrl: string;
  /** Local clone of the gallery repo — under gitignored `data/` (verified: .gitignore has `data/`). */
  mirrorDir: string;
  /** `\\wsl.localhost\<distro>\home\<user>\projects` — the host's UNC view of the distro workspace root. */
  workspaceRootUnc: string;
}

const DEFAULT_REPO_URL = "https://github.com/rconn0925/vibecoding-gallery.git";

/**
 * Pure copy filter — the secrets gate (T-22l-03). Rejects any path with a
 * `node_modules` segment and any basename starting with "." (dotfiles AND
 * dotdirs: .env, .git, .cache, .config). Exported for direct testing.
 */
export function workspaceCopyFilter(srcPath: string): boolean {
  const segments = srcPath.replaceAll("\\", "/").split("/");
  if (segments.includes("node_modules")) return false;
  const basename = segments.at(-1) ?? "";
  if (basename.startsWith(".")) return false;
  return true;
}

/**
 * Commit-message hygiene (defense-in-depth — shell injection is already
 * impossible via arg arrays): strip control chars to spaces, collapse
 * whitespace, trim, truncate to 80 chars, fall back when empty.
 */
export function sanitizeCommitTitle(title: string): string {
  const cleaned = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars IS the point
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned.length > 0 ? cleaned : "untitled build";
}

/**
 * Resolve publisher config from env. Enabled unless GALLERY_PUBLISH_ENABLED is
 * the EXACT trimmed string "false" (the AUTO_ROUND_ENABLED strict-string idiom,
 * inverted default) — returns null when disabled.
 */
export function resolveGalleryConfig(env: NodeJS.ProcessEnv): GalleryConfig | null {
  if ((env.GALLERY_PUBLISH_ENABLED ?? "").trim() === "false") return null;
  const repoUrl = (env.GALLERY_REPO_URL ?? "").trim() || DEFAULT_REPO_URL;
  if (repoUrl.length === 0) return null;
  // Distro defaults duplicated from sandbox-process.ts:64-65 (READ-ONLY file;
  // importing it would drag the WSL spawn adapter into every consumer).
  const distroName = env.BUILD_DISTRO_NAME ?? "vibecoding-build";
  const distroUser = env.BUILD_DISTRO_USER ?? "builder";
  return {
    repoUrl,
    mirrorDir: "data/gallery-mirror",
    workspaceRootUnc: `\\\\wsl.localhost\\${distroName}\\home\\${distroUser}\\projects`,
  };
}

/** Production exec default: promisified execFile — arg ARRAY, never a shell. */
const execFileAsync = promisify(execFile);
const defaultExec: GalleryExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, opts?.cwd ? { cwd: opts.cwd } : {});
  return { stdout };
};

const defaultFs: GalleryFs = { rm, cp, mkdir, access };

/**
 * Construct the publisher. All touch-points injectable; production defaults are
 * node builtins only (zero new dependencies).
 */
export function createGalleryPublisher(deps: {
  config: GalleryConfig;
  exec?: GalleryExec;
  fsx?: GalleryFs;
  logger: Logger;
}): GalleryPublisher {
  const { config, logger } = deps;
  const exec = deps.exec ?? defaultExec;
  const fsx = deps.fsx ?? defaultFs;

  /**
   * Internal serialization chain: overlapping publishes run strictly
   * one-after-the-other. Builds are concurrency-1, but a slow push can outlive
   * the next short build — interleaved git commands in one mirror would corrupt
   * the index. doPublish never rejects, so the chain never breaks.
   */
  let chain: Promise<unknown> = Promise.resolve();

  async function doPublish(input: PublishInput): Promise<PublishResult> {
    const { generation, taskId } = input;
    try {
      // 1) Ensure the mirror clone exists.
      const gitDir = `${config.mirrorDir}/.git`;
      let mirrorReady = true;
      try {
        await fsx.access(gitDir);
      } catch {
        mirrorReady = false;
      }
      if (!mirrorReady) {
        await fsx.mkdir(path.dirname(config.mirrorDir), { recursive: true });
        await exec("git", ["clone", config.repoUrl, config.mirrorDir]);
      }

      // 2) REPLACE-copy the workspace generation dir into the mirror, filtered
      // (files deleted in the workspace disappear from the snapshot). The host
      // reaches the distro workspace via the \\wsl.localhost UNC share.
      // PLAN NOTE (verified reasoning — re-verify live at the FIRST real
      // publish): automount=off governs distro→host drive mounts only;
      // host→distro access via \\wsl.localhost is served by WSL's Plan 9
      // server regardless, and touching the UNC path auto-starts a stopped
      // distro. If the copy fails anyway, that is a FAILED publish (audited +
      // logged) — never a pipeline error.
      const src = `${config.workspaceRootUnc}\\app-${generation}`;
      const dest = `${config.mirrorDir}/app-${generation}`;
      await fsx.rm(dest, { recursive: true, force: true });
      await fsx.cp(src, dest, { recursive: true, filter: workspaceCopyFilter });

      // 3-4) Stage everything; empty porcelain → nothing to publish.
      await exec("git", ["-C", config.mirrorDir, "add", "-A"]);
      const status = await exec("git", ["-C", config.mirrorDir, "status", "--porcelain"]);
      if (status.stdout.trim() === "") {
        return {
          status: "no-changes",
          commitHash: null,
          detail: `app-${generation}: mirror already matches the workspace snapshot`,
        };
      }

      // 5-7) Commit (sanitized title as ONE argv element), push (-u origin HEAD
      // handles a freshly-cloned empty repo with no upstream branch), read hash.
      const message = `app-${generation}: ${sanitizeCommitTitle(input.title)}`;
      await exec("git", ["-C", config.mirrorDir, "commit", "-m", message]);
      await exec("git", ["-C", config.mirrorDir, "push", "-u", "origin", "HEAD"]);
      const rev = await exec("git", ["-C", config.mirrorDir, "rev-parse", "HEAD"]);
      return {
        status: "published",
        commitHash: rev.stdout.trim(),
        detail: `app-${generation}: snapshot pushed`,
      };
    } catch (err) {
      // T-22l-04: LOUD, never thrown — the show loop continues untouched.
      logger.error({ err, generation, taskId }, "gallery publish FAILED — show loop unaffected");
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", commitHash: null, detail: message };
    }
  }

  return {
    publishNow(input: PublishInput): Promise<PublishResult> {
      const result = chain.then(() => doPublish(input));
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
