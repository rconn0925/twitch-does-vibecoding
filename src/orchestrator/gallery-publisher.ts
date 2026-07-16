/**
 * quick-260711-hak per-project gallery publisher — HOST-side post-build push.
 *
 * After each build that finalizes `done`, the orchestrator (host process, the
 * streamer's own GitHub PAT) commits + pushes a snapshot of the persistent
 * workspace generation dir to ONE PUBLIC GitHub repo PER PROJECT (per workspace
 * generation) under owner `TwitchVibecodes`. The first completed prompt of a
 * generation CREATES the repo (named from that prompt, sanitized); every later
 * prompt in the same generation pushes to that SAME repo. Two generations →
 * two repos (per-project routing, keyed on generation via ProjectRepoStore).
 *
 * The sandboxed AI NEVER holds GitHub credentials (T-hak-01): the sandbox only
 * builds files inside the distro; the HOST publishes them with a host-only PAT.
 * GALLERY_GITHUB_TOKEN travels ONLY on the exec ENV (never argv, never a
 * persisted remote URL) — sandbox-process.ts is untouched and the
 * secrets-isolation invariant guards the token out of the sandbox spawn env.
 *
 * Secrets discipline (T-hak-02):
 *   - workspaceCopyFilter rejects node_modules segments and every dot-basename
 *     (.env, .git, .cache, .config — dotfiles AND dotdirs), so nothing from the
 *     workspace's dotfiles can enter a commit;
 *   - sanitizeRepoName reduces a hostile first prompt to a safe [a-z0-9-] slug
 *     (or a dated fallback) — a repo name can never be a shell invocation;
 *   - the local mirror sits under `data/gallery-mirror`, covered by the repo's
 *     `data/` .gitignore entry — the mirror never leaks into THIS repo either.
 *
 * Shell-injection surface (T-hak-02): every git/gh invocation goes through the
 * GalleryExec seam — execFile with an ARG ARRAY, never a shell string. The seam
 * type deliberately has NO `shell` field, so `shell: true` is unrepresentable.
 * sanitizeCommitTitle is additional message hygiene, not the security boundary.
 *
 * Failure isolation (T-hak-03): publishNow NEVER rejects. Any failure resolves
 * `{ status: "failed" }` after a loud pino error — the show loop, finalize, and
 * halt paths are structurally unreachable from a publish failure.
 *
 * Every external touch-point is INJECTED (exec/fs/store/clock) so vitest never
 * runs real git/gh/fs/network — the project seam discipline.
 */

import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { type GalleryIndexEntry, renderGalleryIndexHtml } from "./gallery-index.js";

/** What a `done` build hands the publisher. `title` is chat-derived — hostile. */
export interface PublishInput {
  /** The internally-generated workspace generation INTEGER — never chat text in paths (workspace.ts doctrine). */
  generation: number;
  /** The gate-APPROVED task title (D-03) — still viewer-authored, treated as hostile. */
  title: string;
  taskId: string;
}

/** publishNow's resolved outcome — it NEVER rejects (T-hak-03). */
export interface PublishResult {
  status: "published" | "no-changes" | "failed";
  commitHash: string | null;
  detail: string;
}

/** What a chat-voted revert winner hands the publisher (quick-q5n). */
export interface RevertInput {
  /** The internally-generated workspace generation INTEGER — never chat text in paths. */
  generation: number;
  taskId: string;
}

/** revertLast's resolved outcome — like publishNow, it NEVER rejects (T-hak-03 idiom). */
export interface RevertResult {
  status: "reverted" | "nothing-to-revert" | "failed";
  commitHash: string | null;
  detail: string;
}

export interface GalleryPublisher {
  publishNow(input: PublishInput): Promise<PublishResult>;
  /**
   * quick-q5n chat-voted rollback: revert the last mirror commit, write the
   * reverted tree back to the distro workspace (COPY-FIRST — no rm before a
   * successful cp), and push. Serializes on the SAME chain as publishNow.
   */
  revertLast(input: RevertInput): Promise<RevertResult>;
  /**
   * quick-260716-g8p: bounded (~90s) poll of the repo's GitHub Pages build
   * status — the play-link announce gate. Resolves "built" the moment the
   * latest Pages build reports built; resolves "timeout" past the deadline.
   * NEVER rejects (T-hak-03) and never touches the mirror or the publish
   * serialization chain (read-only `gh api`) — it runs concurrently with the
   * next build's publish. OPTIONAL so every existing fake stays type-valid;
   * absent ⇒ callers announce immediately.
   */
  awaitPagesBuilt?(repoName: string): Promise<"built" | "timeout">;
}

/**
 * The exec seam: execFile-style ARG ARRAYS only. Deliberately NO `shell` field
 * in the opts type — `shell: true` is unrepresentable at this seam (T-hak-02).
 * `env` is a HOST-side child overlay (git/gh inherit the host env plus the
 * per-call PAT); it is unrelated to the SANDBOX boundary (sandbox-process.ts).
 */
export type GalleryExec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
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
  readdir(path: string): Promise<string[]>;
  /** quick-1ki: the index-site mirror writes its rendered index.html here. */
  writeFile(path: string, content: string): Promise<void>;
}

export interface GalleryConfig {
  /** GitHub owner the per-project repos are created under (default TwitchVibecodes). */
  owner: string;
  /** Host-side PAT (repo scope). Travels ONLY on the exec env — never argv/URL. */
  token: string;
  /** Root of the per-project local mirrors — under gitignored `data/`. */
  mirrorRootDir: string;
  /** `\\wsl.localhost\<distro>\home\<user>\projects` — host's UNC view of the distro workspace root. */
  workspaceRootUnc: string;
}

/**
 * The default owner when GALLERY_GITHUB_OWNER is unset. Exported (quick-t8k)
 * so main.ts can compose the tier-2 info-command github.com links WITHOUT a
 * configured token — the owner string is public data, not a credential.
 */
export const DEFAULT_GALLERY_OWNER = "TwitchVibecodes";

/**
 * The playable GitHub Pages URL for one project repo (quick-260716-g8p) — the
 * SINGLE URL-construction point (main.ts must not duplicate this template).
 * Inputs are ONLY the config-derived owner and the post-gate sanitizeRepoName
 * slug ([a-z0-9-]) — never raw chat text. Pages hosts are case-insensitive
 * but canonical-lowercase, so the owner is lowercased here.
 */
export function galleryPlayUrl(owner: string, repoName: string): string {
  return `https://${owner.toLowerCase()}.github.io/${repoName}/`;
}

/**
 * The gallery index site root (the `<owner>.github.io` user site,
 * quick-260716-g8p). Same input discipline as galleryPlayUrl: the
 * config-derived owner only, lowercased.
 */
export function galleryIndexUrl(owner: string): string {
  return `https://${owner.toLowerCase()}.github.io/`;
}

/**
 * Fixed commit identity (EMPTY-01 live-run finding): the mirror repos are fresh
 * `git init` clones with NO local identity, and the host has no global git
 * user.name/user.email — the first live `git commit` died with "Author identity
 * unknown" (exit 128). Pass the identity per-invocation with `-c` so the
 * publisher NEVER depends on host-machine git config.
 */
const COMMIT_USER_NAME = "Twitch Vibecodes";
const COMMIT_USER_EMAIL = "twitchvibecodes@users.noreply.github.com";

/**
 * Per-generation → repo-name routing store, backed by the durable `project_repos`
 * table (schema.sql). A mid-stream host restart never re-creates a repo for a
 * generation whose first prompt already published — lookup() finds the row and
 * routes to continue-mode push. Prepared statements only (workspace.ts idiom).
 */
export interface ProjectRepoStore {
  /** The repo name for this generation, or null if none has published yet. */
  lookup(generation: number): string | null;
  /** Bind a generation to a repo name — called ONLY after a successful create. */
  record(generation: number, repoName: string): void;
  /** Every repo name ever recorded — the dedup namespace. */
  knownNames(): Set<string>;
}

export function createProjectRepoStore(db: Database.Database): ProjectRepoStore {
  const lookupStmt = db.prepare(
    "SELECT repo_name FROM project_repos WHERE generation = @generation",
  );
  const recordStmt = db.prepare(
    "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (@generation, @repoName, @now)",
  );
  const namesStmt = db.prepare("SELECT repo_name FROM project_repos");
  return {
    lookup(generation: number): string | null {
      const row = lookupStmt.get({ generation }) as { repo_name: string } | undefined;
      return row ? row.repo_name : null;
    },
    record(generation: number, repoName: string): void {
      recordStmt.run({ generation, repoName, now: Date.now() });
    },
    knownNames(): Set<string> {
      const rows = namesStmt.all() as Array<{ repo_name: string }>;
      return new Set(rows.map((r) => r.repo_name));
    },
  };
}

/**
 * Pure copy filter — the secrets gate (T-hak-02). Rejects any path with a
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
    .replaceAll(/[ -]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned.length > 0 ? cleaned : "untitled build";
}

/** `vibe-YYYYMMDD-HHMM` from the host clock — the empty-slug fallback name. */
function datedFallback(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `vibe-${stamp}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Reduce a (hostile) chat title to a SAFE GitHub repo slug (T-hak-02): lowercase,
 * collapse every run of non-[a-z0-9] to a single hyphen, strip leading/trailing
 * hyphens, truncate to <=80 (re-strip a trailing hyphen after truncation). When
 * the result is empty (all-symbol / whitespace title), fall back to a dated slug
 * from the injected clock. The output contains ONLY [a-z0-9-] — never a shell
 * metachar, unicode, or over-length string. Pure + exported.
 */
export function sanitizeRepoName(title: string, now: () => Date): string {
  let slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (slug.length > 80) {
    slug = slug.slice(0, 80).replaceAll(/-+$/g, "");
  }
  return slug.length > 0 ? slug : datedFallback(now());
}

/** Production exec default: promisified execFile — arg ARRAY, never a shell. */
const execFileAsync = promisify(execFile);
const defaultExec: GalleryExec = async (file, args, opts) => {
  const execOpts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
  if (opts?.cwd) execOpts.cwd = opts.cwd;
  // HOST-side child: inheriting host env for git/gh is expected; the per-call
  // PAT overlays it. This is unrelated to the SANDBOX env boundary.
  if (opts?.env) execOpts.env = { ...process.env, ...opts.env };
  const { stdout } = await execFileAsync(file, args, execOpts);
  return { stdout };
};

const defaultFs: GalleryFs = { rm, cp, mkdir, access, readdir, writeFile };

/**
 * Resolve publisher config from env. Enabled unless GALLERY_PUBLISH_ENABLED is
 * the EXACT trimmed string "false" (the AUTO_ROUND_ENABLED strict-string idiom,
 * inverted default); ALSO disabled (null) when no GALLERY_GITHUB_TOKEN is set —
 * the caller logs loudly. Owner defaults to TwitchVibecodes. GALLERY_REPO_URL is
 * retired.
 */
export function resolveGalleryConfig(env: NodeJS.ProcessEnv): GalleryConfig | null {
  if ((env.GALLERY_PUBLISH_ENABLED ?? "").trim() === "false") return null;
  const token = (env.GALLERY_GITHUB_TOKEN ?? "").trim();
  if (token.length === 0) return null;
  const owner = (env.GALLERY_GITHUB_OWNER ?? "").trim() || DEFAULT_GALLERY_OWNER;
  // Distro defaults duplicated from sandbox-process.ts:64-65 (READ-ONLY file;
  // importing it would drag the WSL spawn adapter into every consumer).
  const distroName = env.BUILD_DISTRO_NAME ?? "vibecoding-build";
  const distroUser = env.BUILD_DISTRO_USER ?? "builder";
  return {
    owner,
    token,
    mirrorRootDir: "data/gallery-mirror",
    workspaceRootUnc: `\\\\wsl.localhost\\${distroName}\\home\\${distroUser}\\projects`,
  };
}

/**
 * Construct the per-project publisher. All touch-points injectable; production
 * defaults are node builtins + the host gh/git CLIs (zero new dependencies).
 */
/** Default Pages-poll cadence/budget (quick-260716-g8p): 5s checks, ~90s cap. */
const DEFAULT_PAGES_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGES_POLL_TIMEOUT_MS = 90_000;

/** Production sleep default: promise-wrapped UNREF'd setTimeout (never holds the process open). */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export function createGalleryPublisher(deps: {
  config: GalleryConfig;
  store: ProjectRepoStore;
  now?: () => Date;
  exec?: GalleryExec;
  fsx?: GalleryFs;
  /**
   * quick-1ki: supplies the public gallery entries for the index site. ABSENT
   * → index publishing is OFF entirely (existing compositions unchanged).
   */
  indexEntries?: () => GalleryIndexEntry[];
  /** quick-260716-g8p poll seams — injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  pagesPollIntervalMs?: number;
  pagesPollTimeoutMs?: number;
  logger: Logger;
}): GalleryPublisher {
  const { config, store, logger } = deps;
  const exec = deps.exec ?? defaultExec;
  const fsx = deps.fsx ?? defaultFs;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const pagesPollIntervalMs = deps.pagesPollIntervalMs ?? DEFAULT_PAGES_POLL_INTERVAL_MS;
  const pagesPollTimeoutMs = deps.pagesPollTimeoutMs ?? DEFAULT_PAGES_POLL_TIMEOUT_MS;

  /** The plain https origin for a repo — NO token ever embedded (T-hak-01). */
  const originUrl = (name: string): string => `https://github.com/${config.owner}/${name}.git`;
  /** Every git/gh call carries the PAT on the ENV only — never argv/URL. */
  const withToken = { env: { GH_TOKEN: config.token } };

  /**
   * Internal serialization chain: overlapping publishes run strictly
   * one-after-the-other. Builds are concurrency-1, but a slow push can outlive
   * the next short build — interleaved git commands in one mirror would corrupt
   * the index. doPublish never rejects, so the chain never breaks.
   */
  let chain: Promise<unknown> = Promise.resolve();

  /** Does this mirror already have a git repo? */
  async function hasGit(mirrorDir: string): Promise<boolean> {
    try {
      await fsx.access(`${mirrorDir}/.git`);
      return true;
    } catch {
      return false;
    }
  }

  /** Dedup a base slug against the store's known names (base → base-2 → base-3…). */
  function dedupName(base: string): string {
    const known = store.knownNames();
    if (!known.has(base)) return base;
    let n = 2;
    while (known.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  /**
   * FIRST prompt of a generation: create the public repo, wire a fresh local
   * mirror, and record the routing ONLY after a successful create. Tolerates a
   * `gh repo create` name-collision (create-succeeded-but-record-never-ran
   * leaves an orphan remote) — treat "already exists" as non-fatal (W2).
   */
  async function scaffoldRepo(generation: number, title: string): Promise<string> {
    const name = dedupName(sanitizeRepoName(title, now));
    const mirrorDir = `${config.mirrorRootDir}/${name}`;
    try {
      await exec("gh", ["repo", "create", `${config.owner}/${name}`, "--public"], withToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) throw err;
      logger.warn(
        { name, generation },
        "gh repo create: name already exists — proceeding to push (orphan-remote recovery, W2)",
      );
    }
    await fsx.mkdir(mirrorDir, { recursive: true });
    if (!(await hasGit(mirrorDir))) {
      await exec("git", ["-C", mirrorDir, "init"]);
      await exec("git", ["-C", mirrorDir, "remote", "add", "origin", originUrl(name)]);
    }
    // Record ONLY after the create/init succeeded (durable generation→repo map).
    store.record(generation, name);
    return mirrorDir;
  }

  /**
   * LATER prompt of a generation: reuse the stored repo/mirror. Guard mirror
   * existence — if `<name>/.git` is missing (host restart cleared
   * data/gallery-mirror, or a partial first publish), re-clone from origin
   * before any git ops (W2).
   */
  async function continueRepo(name: string): Promise<string> {
    const mirrorDir = `${config.mirrorRootDir}/${name}`;
    if (!(await hasGit(mirrorDir))) {
      logger.warn({ name }, "mirror missing .git — re-cloning from origin before push (W2)");
      // Clear any partial dir with no .git, then clone the public repo fresh.
      await fsx.rm(mirrorDir, { recursive: true, force: true });
      await fsx.mkdir(config.mirrorRootDir, { recursive: true });
      await exec("git", ["clone", originUrl(name), mirrorDir], withToken);
    }
    return mirrorDir;
  }

  /**
   * quick-1ki: enable GitHub Pages (deploy-from-branch, root path) on a repo
   * that was JUST pushed. Called after every successful push (NOT at scaffold
   * time — the create-Pages API 422s when the source branch does not yet exist
   * on the remote, and at scaffold time nothing has been pushed). Idempotent:
   * an already-enabled repo answers 409 Conflict, treated as a quiet no-op.
   *
   * NEVER throws and NEVER changes the publish result — the publish is already
   * `published` when this runs; a Pages failure is a loud warn, nothing more.
   * The branch name is read from the mirror (fresh `git init`s may be master OR
   * main depending on host config — never hardcode). All through the GalleryExec
   * seam, arg arrays only, PAT only via the existing withToken env (T-hak-01/02).
   */
  async function ensurePagesEnabled(repoName: string, mirrorDir: string): Promise<void> {
    try {
      const branchOut = await exec("git", ["-C", mirrorDir, "rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = branchOut.stdout.trim();
      await exec(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${config.owner}/${repoName}/pages`,
          "-f",
          `source[branch]=${branch}`,
          "-f",
          "source[path]=/",
        ],
        withToken,
      );
      logger.info({ repoName, branch }, "GitHub Pages enabled (deploy-from-branch, root)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/409|already exists|conflict/i.test(msg)) {
        // Pages already enabled — the expected steady-state on every push
        // after the first. Quiet no-op (debug, never warn).
        logger.debug({ repoName }, "GitHub Pages already enabled — no-op (409)");
        return;
      }
      // Loud but NON-FATAL: the snapshot push already succeeded; a Pages
      // hiccup must never surface as a publish failure (T-1ki-04).
      logger.warn(
        { err, repoName },
        "GitHub Pages enablement FAILED — publish result unchanged (non-fatal)",
      );
    }
  }

  /**
   * Replace the mirror's tracked working tree with the current workspace
   * snapshot so DELETED workspace files actually disappear from each push (W1).
   * `.git` lives at `mirrorDir/.git` — clearing NON-.git entries then copying
   * the snapshot in (never a plain cp-over-top, which would leak deleted files
   * into every push), and `git add -A` below captures the deletions.
   */
  async function refreshSnapshot(mirrorDir: string, generation: number): Promise<void> {
    for (const entry of await fsx.readdir(mirrorDir)) {
      if (entry === ".git") continue;
      await fsx.rm(`${mirrorDir}/${entry}`, { recursive: true, force: true });
    }
    const src = `${config.workspaceRootUnc}\\app-${generation}`;
    await fsx.cp(src, mirrorDir, { recursive: true, filter: workspaceCopyFilter });
  }

  async function doPublish(input: PublishInput): Promise<PublishResult> {
    const { generation, title, taskId } = input;
    try {
      // 0) EMPTY-01 preflight: NEVER create a repo for a workspace with nothing
      //    committable. Top-level entries are judged by the SAME filter the
      //    snapshot copy uses (workspaceCopyFilter: no dot-entries, no
      //    node_modules) — a `.claude`-only workspace publishes nothing and
      //    creates nothing. A missing/unreadable dir throws into the outer
      //    catch → loud `failed` result (T-hak-03), never a silent empty repo.
      const snapshotSrc = `${config.workspaceRootUnc}\\app-${generation}`;
      const topEntries = await fsx.readdir(snapshotSrc);
      if (!topEntries.some((entry) => workspaceCopyFilter(entry))) {
        logger.warn(
          { generation, taskId },
          "gallery publish skipped — workspace has no committable files (no repo created, EMPTY-01)",
        );
        return {
          status: "no-changes",
          commitHash: null,
          detail: `app-${generation}: workspace has no committable files — publish skipped (no repo created)`,
        };
      }

      // 1) Route: first prompt of a generation scaffolds a repo; later prompts
      //    reuse the stored one. Keyed on generation (per-project routing).
      const existing = store.lookup(generation);
      const mirrorDir =
        existing === null ? await scaffoldRepo(generation, title) : await continueRepo(existing);

      // 2) Refresh the mirror to the workspace snapshot (delete-propagating, W1).
      await refreshSnapshot(mirrorDir, generation);

      // 3-4) Stage everything; empty porcelain → nothing to publish.
      await exec("git", ["-C", mirrorDir, "add", "-A"]);
      const status = await exec("git", ["-C", mirrorDir, "status", "--porcelain"]);
      if (status.stdout.trim() === "") {
        return {
          status: "no-changes",
          commitHash: null,
          detail: `app-${generation}: mirror already matches the workspace snapshot`,
        };
      }

      // 5-7) Commit (sanitized title as ONE argv element; explicit -c identity —
      //      never host git config), push (PAT on the ENV only via gh's
      //      git-credential helper — origin stays a plain https URL, no token
      //      on disk), read the hash.
      await exec("git", [
        "-C",
        mirrorDir,
        "-c",
        `user.name=${COMMIT_USER_NAME}`,
        "-c",
        `user.email=${COMMIT_USER_EMAIL}`,
        "commit",
        "-m",
        sanitizeCommitTitle(title),
      ]);
      await exec(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "-C",
          mirrorDir,
          "push",
          "-u",
          "origin",
          "HEAD",
        ],
        withToken,
      );
      // quick-1ki: right after every successful push, make the repo PLAYABLE —
      // enable Pages (tolerant of already-enabled, non-fatal on any error).
      const repoName = store.lookup(generation);
      if (repoName !== null) await ensurePagesEnabled(repoName, mirrorDir);
      const rev = await exec("git", ["-C", mirrorDir, "rev-parse", "HEAD"]);
      return {
        status: "published",
        commitHash: rev.stdout.trim(),
        detail: `${config.owner}/${store.lookup(generation)}: snapshot pushed`,
      };
    } catch (err) {
      // T-hak-03: LOUD, never thrown — the show loop continues untouched.
      logger.error({ err, generation, taskId }, "gallery publish FAILED — show loop unaffected");
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", commitHash: null, detail: message };
    }
  }

  /**
   * quick-1ki: regenerate + push the public gallery INDEX site to the
   * `<owner-lowercased>.github.io` user-site repo after each successful project
   * publish. NEVER rejects (the T-hak-03 idiom: full try/catch, loud
   * logger.error, resolve void) — an index failure is invisible to the show
   * loop and never alters the project publish's result (T-1ki-04).
   *
   * The mirror lives at `<mirrorRootDir>/_index-site`: the leading underscore
   * is unreachable by sanitizeRepoName's [a-z0-9-] output, so it can never
   * collide with a project mirror. All git/gh through the exec seam (arg
   * arrays, PAT on env only — T-1ki-03/05); the commit message is a fixed
   * server-composed string, never chat text.
   */
  async function doPublishIndex(entriesFn: () => GalleryIndexEntry[]): Promise<void> {
    try {
      const indexRepoName = `${config.owner.toLowerCase()}.github.io`;
      const mirrorDir = `${config.mirrorRootDir}/_index-site`;
      // Create-or-tolerate the user-site repo (scaffoldRepo's W2 idiom).
      try {
        await exec(
          "gh",
          ["repo", "create", `${config.owner}/${indexRepoName}`, "--public"],
          withToken,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) throw err;
      }
      await fsx.mkdir(mirrorDir, { recursive: true });
      if (!(await hasGit(mirrorDir))) {
        await exec("git", ["-C", mirrorDir, "init"]);
        await exec("git", ["-C", mirrorDir, "remote", "add", "origin", originUrl(indexRepoName)]);
      }
      await fsx.writeFile(
        `${mirrorDir}/index.html`,
        renderGalleryIndexHtml(entriesFn(), config.owner),
      );
      await exec("git", ["-C", mirrorDir, "add", "-A"]);
      const status = await exec("git", ["-C", mirrorDir, "status", "--porcelain"]);
      if (status.stdout.trim() === "") return; // index unchanged — nothing to push
      await exec("git", [
        "-C",
        mirrorDir,
        "-c",
        `user.name=${COMMIT_USER_NAME}`,
        "-c",
        `user.email=${COMMIT_USER_EMAIL}`,
        "commit",
        "-m",
        "update gallery index",
      ]);
      await exec(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "-C",
          mirrorDir,
          "push",
          "-u",
          "origin",
          "HEAD",
        ],
        withToken,
      );
      // User-site repos usually auto-enable Pages — the call stays tolerant.
      await ensurePagesEnabled(indexRepoName, mirrorDir);
    } catch (err) {
      // T-1ki-04: LOUD, never thrown — the show loop continues untouched.
      logger.error({ err }, "gallery index publish FAILED — show loop unaffected");
    }
  }

  /**
   * quick-q5n chat-voted rollback. Ordering guarantee (safety invariant #7):
   * the workspace is not touched until the mirror revert commit succeeds — a
   * failed revert leaves the workspace bit-for-bit as it was. The distro
   * workspace holds NO .git (workspaceCopyFilter has always excluded
   * dot-entries), so a detached/broken git state in the workspace is
   * structurally impossible. Like doPublish, doRevert never rejects
   * (T-hak-03 idiom): any throw → logger.error + { status: "failed" }.
   */
  async function doRevert(input: RevertInput): Promise<RevertResult> {
    const { generation, taskId } = input;
    try {
      // 1) No repo = no history — nothing to revert, zero exec calls.
      const name = store.lookup(generation);
      if (name === null) {
        return {
          status: "nothing-to-revert",
          commitHash: null,
          detail: `app-${generation}: no repo has published yet — nothing to revert`,
        };
      }

      // 2) Re-clone a missing mirror from origin before any git op (W2 reuse).
      const mirrorDir = await continueRepo(name);

      // 3) Reverting the ONLY commit would empty the project — refuse politely.
      const countOut = await exec("git", ["-C", mirrorDir, "rev-list", "--count", "HEAD"]);
      const commitCount = Number.parseInt(countOut.stdout.trim(), 10);
      if (!Number.isFinite(commitCount) || commitCount < 2) {
        return {
          status: "nothing-to-revert",
          commitHash: null,
          detail: `app-${generation}: only ${Number.isFinite(commitCount) ? commitCount : 0} commit(s) — reverting would empty the project`,
        };
      }

      // 4) Mirror-side revert commit FIRST — the workspace stays untouched
      //    until this succeeds (invariant #7). Arg arrays only; the GalleryExec
      //    type makes shell:true unrepresentable (T-hak-02).
      try {
        await exec("git", [
          "-C",
          mirrorDir,
          "-c",
          `user.name=${COMMIT_USER_NAME}`,
          "-c",
          `user.email=${COMMIT_USER_EMAIL}`,
          "revert",
          "--no-edit",
          "HEAD",
        ]);
      } catch (revertErr) {
        // Best-effort abort so the mirror index isn't left mid-revert; its own
        // failure is swallowed (the outer resolve is already "failed").
        try {
          await exec("git", ["-C", mirrorDir, "revert", "--abort"]);
        } catch {
          // ignore — abort is best-effort
        }
        logger.error(
          { err: revertErr, generation, taskId },
          "mirror git revert FAILED — workspace untouched, resolving failed (quick-q5n)",
        );
        const message = revertErr instanceof Error ? revertErr.message : String(revertErr);
        return { status: "failed", commitHash: null, detail: message };
      }

      // 5) COPY-FIRST write-back to the distro workspace (invariant #7): an
      //    rm-then-cp sequence could gut the workspace if the cp then failed,
      //    leaving it unbuildable AND letting the next refreshSnapshot mirror
      //    the gutted state over the last good commit. So: cp first (overwrite
      //    in place; the filter drops .git and every dot-basename from the
      //    mirror side), prune stale entries ONLY after the cp resolves.
      const wsDir = `${config.workspaceRootUnc}\\app-${generation}`;
      try {
        await fsx.cp(mirrorDir, wsDir, { recursive: true, filter: workspaceCopyFilter });
      } catch (cpErr) {
        // The workspace still holds ALL pre-revert files (nothing deleted yet);
        // worst case a partial cp leaves a buildable SUPERSET, and the next
        // publishNow's refreshSnapshot re-syncs the mirror to whatever the
        // workspace actually holds (workspace stays authoritative).
        logger.error(
          { err: cpErr, generation, taskId },
          "revert write-back cp FAILED — workspace keeps every pre-revert file (copy-first); mirror divergence re-syncs on next publish",
        );
        const message = cpErr instanceof Error ? cpErr.message : String(cpErr);
        return { status: "failed", commitHash: null, detail: message };
      }
      try {
        // Prune TOP-LEVEL workspace entries the mirror no longer has. Entries
        // failing workspaceCopyFilter (dot-entries like .claude, node_modules)
        // survive — the mirror never contained node_modules, so deleting it
        // would only force a reinstall.
        const wsEntries = await fsx.readdir(wsDir);
        const mirrorEntries = new Set(await fsx.readdir(mirrorDir));
        for (const entry of wsEntries) {
          if (!workspaceCopyFilter(entry)) continue;
          if (mirrorEntries.has(entry)) continue;
          await fsx.rm(`${wsDir}\\${entry}`, { recursive: true, force: true });
        }
      } catch (pruneErr) {
        // The workspace remains a buildable superset — loud, resolve failed.
        logger.error(
          { err: pruneErr, generation, taskId },
          "revert stale-entry prune FAILED — workspace remains a buildable superset",
        );
        const message = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
        return { status: "failed", commitHash: null, detail: message };
      }

      // 6) Push the revert commit — identical invocation to publishNow (PAT on
      //    the ENV via gh's credential helper; plain https origin, never argv).
      await exec(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "-C",
          mirrorDir,
          "push",
          "-u",
          "origin",
          "HEAD",
        ],
        withToken,
      );
      const rev = await exec("git", ["-C", mirrorDir, "rev-parse", "HEAD"]);
      return {
        status: "reverted",
        commitHash: rev.stdout.trim(),
        detail: `${config.owner}/${name}: last change reverted and pushed`,
      };
    } catch (err) {
      // T-hak-03 idiom: LOUD, never thrown — the show loop continues untouched.
      logger.error({ err, generation, taskId }, "gallery revert FAILED — show loop unaffected");
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", commitHash: null, detail: message };
    }
  }

  return {
    publishNow(input: PublishInput): Promise<PublishResult> {
      // quick-1ki: a confirmed "published" project publish is FOLLOWED (on the
      // SAME serialization chain, before it releases) by the gallery index
      // regeneration + push — index pushes never interleave with project
      // pushes. doPublishIndex never rejects and can never alter the returned
      // PublishResult; absent indexEntries → index publishing OFF.
      const indexEntries = deps.indexEntries;
      const result = chain.then(async () => {
        const publishResult = await doPublish(input);
        if (publishResult.status === "published" && indexEntries !== undefined) {
          await doPublishIndex(indexEntries);
        }
        return publishResult;
      });
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    revertLast(input: RevertInput): Promise<RevertResult> {
      // The SAME serialization chain as publishNow — one mirror, interleaved
      // git would corrupt the index. doRevert never rejects, so the chain
      // never breaks.
      const result = chain.then(() => doRevert(input));
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    /**
     * quick-260716-g8p: bounded Pages-readiness poll. Deliberately OFF the
     * serialization `chain` and mirror-free — a read-only `gh api` status
     * check that must run concurrently with the next build's publish and can
     * never block the show loop (T-hak-03/T-g8p-04). The METHOD never rejects:
     * every iteration is try/caught (a 404 = the first Pages build hasn't
     * started yet on a brand-new repo — expected, not fatal) and the loop
     * hard-resolves "timeout" past the deadline.
     */
    async awaitPagesBuilt(repoName: string): Promise<"built" | "timeout"> {
      const deadlineMs = now().getTime() + pagesPollTimeoutMs;
      for (;;) {
        try {
          const out = await exec(
            "gh",
            ["api", `repos/${config.owner}/${repoName}/pages/builds/latest`, "--jq", ".status"],
            withToken,
          );
          if (out.stdout.trim() === "built") return "built";
        } catch (err) {
          // Not-ready (404 pre-first-build) or transient gh hiccup — poll on.
          logger.debug({ err, repoName }, "Pages build status not ready yet — polling on");
        }
        if (now().getTime() >= deadlineMs) {
          logger.warn(
            { repoName, pagesPollTimeoutMs },
            "Pages build never reported built inside the poll budget — announcing with the honest timeout phrasing",
          );
          return "timeout";
        }
        await sleep(pagesPollIntervalMs);
      }
    },
  };
}
