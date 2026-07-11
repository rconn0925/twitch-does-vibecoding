---
phase: quick-260711-hak
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [BL-01, HI-01, HI-03, per-project-repo, token-isolation]
files_modified:
  - src/orchestrator/types.ts
  - src/orchestrator/sandbox-process.ts
  - src/orchestrator/build-session.ts
  - src/orchestrator/build-session.test.ts
  - src/orchestrator/sandbox-process.test.ts
  - src/orchestrator/gallery-publisher.ts
  - src/orchestrator/gallery-publisher.test.ts
  - src/audit/schema.sql
  - src/main.ts
  - tests/invariants/secrets-isolation.test.ts
  - .env.example

must_haves:
  truths:
    - "The distro workspace dir /home/builder/projects/app-<N> is created before every build turn; a mkdir failure fails the build CLOSED (never a silent shared-dir fallback, never weakened isolation)."
    - "A build over a NON-EMPTY workspace runs in continue mode even when no prior build finalized done (scaffold prompt never runs over a debris-filled dir)."
    - "A healthy, steadily-progressing long build is never killed by the watchdog; only a genuinely stalled (no-activity) stream trips it — with no false 'done' and no build_history row for the killed build."
    - "The first completed prompt of a generation creates exactly ONE public GitHub repo under owner TwitchVibecodes, named from that first prompt; every later completed prompt in the same generation pushes to that SAME repo and never re-creates one."
    - "Two different generations publish to two different repos (per-project routing)."
    - "A hostile first prompt (shell metachars / unicode / over-length) yields a safe GitHub repo slug and never a shell invocation; falls back to a dated slug when unusable."
    - "GALLERY_GITHUB_TOKEN never enters the sandbox env — mechanically guarded by the secrets-isolation invariant; buildSandboxEnv provably excludes it."
    - "publishNow NEVER throws into the pipeline: every failure resolves { status } after a loud log (fire-and-forget)."
    - "Workspace rotation is NON-DESTRUCTIVE: newProject() advances the active generation pointer and the previous generation's dir remains on disk, addressable by its stable app-<N> identity (no rm/delete path; the watchdog does no workspace reset)."
    - "The rotation seam (workspace.newProject), the ship seam (publishNow(generation)), and the per-project scaffold (new generation -> new repo, keyed on generation) are plain reusable functions callable from ANY path — the console route holds no exclusive claim; a future build/winner path invokes the identical rotate+ship+scaffold flow."
  artifacts:
    - path: "src/orchestrator/sandbox-process.ts"
      provides: "ensureWorkspaceDir + workspaceHasFiles (WSL mkdir/stat via the existing wsl.exe exec seam)"
      contains: "ensureWorkspaceDir"
    - path: "src/orchestrator/build-session.ts"
      provides: "fail-closed ensure-dir before spawn; emptiness-keyed scaffold/continue; stall/idle watchdog"
      contains: "ensureWorkspaceDir"
    - path: "src/orchestrator/gallery-publisher.ts"
      provides: "per-project publisher: sanitizeRepoName, dedup, dated fallback, ProjectRepoStore routing, gh-create-on-scaffold + push-on-continue"
      contains: "sanitizeRepoName"
    - path: "src/audit/schema.sql"
      provides: "project_repos table (generation -> repo_name mapping, durable)"
      contains: "project_repos"
    - path: "tests/invariants/secrets-isolation.test.ts"
      provides: "GALLERY_GITHUB_TOKEN in the guarded host-secret set"
      contains: "GALLERY_GITHUB_TOKEN"
    - path: ".env.example"
      provides: "GALLERY_GITHUB_OWNER + GALLERY_GITHUB_TOKEN documented; GALLERY_REPO_URL retired"
      contains: "GALLERY_GITHUB_OWNER"
  key_links:
    - from: "src/orchestrator/build-session.ts"
      to: "src/orchestrator/sandbox-process.ts"
      via: "sandboxAdapter.ensureWorkspaceDir(dir) awaited before runTurn"
      pattern: "ensureWorkspaceDir"
    - from: "src/orchestrator/build-session.ts"
      to: "src/orchestrator/sandbox-process.ts"
      via: "sandboxAdapter.workspaceHasFiles(dir) reconciled with workspace.scaffolded()"
      pattern: "workspaceHasFiles"
    - from: "src/main.ts"
      to: "src/orchestrator/gallery-publisher.ts"
      via: "onBuildDone -> publishNow({ generation, title, taskId })"
      pattern: "publishNow"
    - from: "src/orchestrator/gallery-publisher.ts"
      to: "project_repos store"
      via: "lookup(generation) routes scaffold(create) vs continue(push)"
      pattern: "lookup"
    - from: "src/orchestrator/gallery-publisher.ts"
      to: "host gh/git"
      via: "GH_TOKEN passed on the exec env (host-side only), arg arrays only"
      pattern: "GH_TOKEN"
---

<objective>
Make the "chat's build lands on GitHub, one public repo per project" loop work end to end, and close the three linked workspace-lifecycle bugs the overnight correctness review found (BL-01, HI-01, HI-03). The sandboxed AI never holds GitHub credentials: the sandbox only builds files inside the distro; the HOST publishes them with a host-only PAT.

Purpose: The headline feature of the recent work does not function live — the distro workspace dir is never created, so persistence/rotation/publish are all no-ops, and the single-repo publisher does not match the streamer's chosen per-project-repo design.

Output: A per-project GitHub publisher (one public repo per workspace generation under TwitchVibecodes), a fail-closed distro-dir bootstrap, emptiness-keyed scaffold/continue, a stall-based build watchdog, and a mechanically-guarded token boundary.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/reviews/overnight-correctness.md

<interfaces>
<!-- Contracts the executor needs. Extracted from the codebase — no exploration needed. -->

From src/orchestrator/types.ts (SandboxAdapter — the WSL boundary; two OPTIONAL methods get ADDED here):
```typescript
export interface SandboxAdapter {
  spawn(opts: SpawnOptions): SpawnedProcess;
  terminate(): Promise<void>;
  // ADD (optional so the ~8 existing test fakes need no change; production impl is concrete):
  ensureWorkspaceDir?(dir: string): Promise<void>;   // wsl mkdir -p <dir>; rejects on failure
  workspaceHasFiles?(dir: string): Promise<boolean>; // wsl: ls -A <dir> has entries?
}
export interface WorkspaceView {
  dir(): string;                // /home/builder/projects/app-<generation>
  scaffolded(): boolean;        // true once ANY build finalized done in this generation
  markBuilt(): void;
  newProject(): number;         // rotate: increment generation, old dir stays on disk (non-destructive)
  generation(): number;         // 1-based
}
```

From src/orchestrator/sandbox-process.ts (existing wsl exec seam + config — REUSE, do not widen the sandbox env):
```typescript
export type SandboxExecFileFn = (file: string, args: readonly string[]) => Promise<unknown>;
export interface SandboxConfig { distroName: string; distroUser: string; distroClaudePath: string; sandboxApiKey?: string; }
// buildSandboxEnv(config) returns { PATH } (+ SANDBOX-derived key ONLY when A1-false). Must stay this narrow.
// resolveWslExePath() gives the absolute wsl.exe path.
```

From src/orchestrator/gallery-publisher.ts (current single-repo shape being REWRITTEN):
```typescript
export interface PublishInput { generation: number; title: string; taskId: string; }
export interface PublishResult { status: "published" | "no-changes" | "failed"; commitHash: string | null; detail: string; }
export type GalleryExec = (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string }>;
export function workspaceCopyFilter(srcPath: string): boolean; // KEEP: rejects node_modules + dotfiles
export function sanitizeCommitTitle(title: string): string;    // KEEP
```

From src/operator-console/server.ts (existing rotation seam — DO NOT couple rotation to this route):
```typescript
// POST /api/workspace/new-project just calls deps.workspace.newProject() (a plain WorkspaceView method)
// + recordWorkspaceReset. Rotation already lives on the workspace object, not the route — keep it that way.
```

From src/audit/record.ts (audit row for each publish attempt — already wired in main.ts onBuildDone):
```typescript
export function recordGalleryPublish(db, { taskId, generation, status, commitHash, detail, streamMode }): void;
```

From src/audit/schema.sql (pattern to copy for the new table — single small additive CREATE TABLE IF NOT EXISTS):
```sql
CREATE TABLE IF NOT EXISTS workspace_state ( id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, ... );
```
</interfaces>
</context>

<design_seams>
Coordinator constraint (fold-in for a follow-on `!build`/`!suggest` mixed-vote task — NOT this plan's scope to build, only to keep reusable):

1. ROTATION STAYS A PLAIN FUNCTION. Workspace rotation is `workspace.newProject()` — already a `WorkspaceView` method that the console route merely calls. Do NOT move any rotation logic into a route handler or hardwire it to HTTP. A future chat `!build` winner must be able to invoke the identical rotate flow by calling the same method.

2. THE THREE SEAMS COMPOSE FROM ANY CALLER. "Ship the current project, then start a new one" is expressible today as: `publishNow({ generation: currentGen, ... })` (final commit/push of the current project) → `workspace.newProject()` (advance the pointer) → the NEXT `publishNow` for the new generation naturally scaffolds a fresh repo because the publisher keys repo creation on `store.lookup(generation)` (a new generation has no row → create). Keep all three independently callable; do not fuse them into one console-only path.

3. FORCED SCAFFOLD COMPOSES WITH THE EMPTINESS RULE. The HI-01 rule (continue when `scaffolded() OR hasFiles`) does NOT block a forced new project: rotation moves to a new generation whose dir (`app-<N+1>`) is a distinct, freshly-created EMPTY dir → hasFiles=false, scaffolded=false → scaffold. So "force a new project even though the current dir has files" is expressed by rotating, and it lands in scaffold mode automatically. Leave this room — do not gate scaffold on anything that would prevent a rotated-to empty generation from scaffolding.

4. NON-DESTRUCTIVE ALWAYS. Rotation never deletes/rm's the previous generation's dir (workspace.ts already has no delete path — preserve that). Every `app-<N>` stays on disk after rotation, addressable by its stable identity, so a future `!swapbuild` can re-activate it. The HI-03 watchdog choice in this plan is the STALL/idle timer specifically because it performs NO workspace reset — nothing in this plan wipes any project dir. (If a future change ever adds a reset-on-failure, it must be scoped to the CURRENT generation's uncommitted changes only, never a whole dir wipe.)
</design_seams>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Distro workspace lifecycle — ensure-dir (BL-01), emptiness-keyed mode (HI-01), stall watchdog (HI-03)</name>
  <files>src/orchestrator/types.ts, src/orchestrator/sandbox-process.ts, src/orchestrator/build-session.ts, src/orchestrator/sandbox-process.test.ts, src/orchestrator/build-session.test.ts</files>
  <behavior>
    - BL-01: build-session awaits sandboxAdapter.ensureWorkspaceDir(workspace.dir()) BEFORE the build turn; a rejection fails the build CLOSED (narrated deciding + enterDecision "failed" — the same route as the watchdog path), never proceeding to spawn and never falling back to a shared dir.
    - BL-01 (adapter): ensureWorkspaceDir runs `wsl.exe -d <distro> -u <user> -- mkdir -p <dir>` via the existing execFileFn seam; rejects (throws) on non-zero exit. It uses the SAME distro/user config as spawn — no new env, no widening of buildSandboxEnv.
    - HI-01: scaffold-vs-continue rule = continue when `workspace.scaffolded() OR (await sandbox.workspaceHasFiles(dir))`, else scaffold. A probe error resolves to hasFiles=true (never assert "empty" when unsure → never scaffold over possible debris). workspaceHasFiles runs `wsl.exe -d <distro> -u <user> -- sh -lc 'ls -A <dir> 2>/dev/null | head -1'` and returns true when stdout is non-empty. This composes with forced rotation (design_seams #3): a rotated-to new generation has a fresh empty dir → scaffold.
    - HI-01 (fallback): when workspaceHasFiles is absent on the injected adapter (existing test fakes), mode falls back to scaffolded()-only — existing build-session tests stay green unchanged.
    - HI-03: the per-turn watchdog becomes a STALL/idle timer — the setTimeout is re-armed on EACH yielded message inside consumeTurn's for-await loop (clear + re-set turnTimeoutMs). A steadily-yielding build never trips it; a stream with NO activity for turnTimeoutMs trips exactly as today (timedOut → teardown → narrated failed decision). Abort semantics unchanged: no false "done", no build_history row for the killed build. NO workspace reset happens on abort (non-destructive — design_seams #4).
  </behavior>
  <action>
Add two OPTIONAL methods to `SandboxAdapter` in types.ts: `ensureWorkspaceDir?(dir: string): Promise<void>` and `workspaceHasFiles?(dir: string): Promise<boolean>`. Optional so the ~8 existing SandboxAdapter fakes (build-flow/build-history/chaos/paid-window/auto-cycle/build-failure e2e, turn-options.test, build-session.test) compile unchanged; the concrete production adapter implements both.

In sandbox-process.ts implement both on the returned adapter using `execFileFn` and `resolveWslExePath()` with `config.distroName`/`config.distroUser`. ensureWorkspaceDir: `wsl.exe -d <distro> -u <user> -- mkdir -p <dir>` — let a non-zero exit REJECT (do NOT swallow it; this is the fail-closed signal, unlike terminate which is fire-and-forget). workspaceHasFiles: `wsl.exe -d <distro> -u <user> -- sh -lc 'ls -A <dir> 2>/dev/null | head -1'`, return `stdout.trim().length > 0`; on reject, log and return true (fail toward continue). Do NOT touch buildSandboxEnv, buildSandboxOptions, or the spawn env — isolation stays exactly as-is (dir bootstrap and stat are separate wsl invocations, not part of the sandboxed engine spawn). Justify in a header comment: the WSL boundary already lives in this adapter, so dir bootstrap/stat belong here, not in the pure-SQLite workspace.ts.

In build-session.ts `runBuildAttempt`, after `emitStage(task, "building")` and BEFORE computing `mode`: `try { await deps.sandboxAdapter.ensureWorkspaceDir?.(deps.workspace.dir()); } catch (err) { ...audit sandbox_teardown rationale "workspace dir ensure failed — build failed closed (BL-01)"; deps.narrator?.buildDeciding(task.text); enterDecision(task, taskText, "failed"); return; }`. Then replace the mode line with the reconciled rule: `const hasFiles = deps.sandboxAdapter.workspaceHasFiles ? await deps.sandboxAdapter.workspaceHasFiles(deps.workspace.dir()).catch(() => true) : false; const mode = (deps.workspace.scaffolded() || hasFiles) ? "continue" : "scaffold";`. Keep the existing "computed FRESH per attempt" comment intent.

In build-session.ts `consumeTurn`, convert the one-shot watchdog into a re-armable stall timer: extract an `armWatchdog()` closure that does `if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(fire, turnTimeoutMs); watchdog.unref?.();` where `fire` (a single stable closure) sets `timedOut = true`, calls `ac.abort()`, and resolves `watchdogFired`. Call `armWatchdog()` once before the loop and again at the top of each `for await` iteration (on activity). The Promise.race + finally clearTimeout stays. All downstream timedOut handling is unchanged. Do NOT add any workspace-reset step on abort — the stall timer is the whole HI-03 fix (non-destructive by design).

Update sandbox-process.test.ts: assert ensureWorkspaceDir issues `mkdir -p <dir>` to the distro/user and REJECTS when execFileFn rejects; assert workspaceHasFiles maps non-empty stdout → true, empty → false, reject → true. Update build-session.test.ts: (a) ensure-dir is invoked before the agent runner's first turn and a rejecting ensureWorkspaceDir routes to a failed decision with NO spawn/publish; (b) a fake adapter reporting workspaceHasFiles=true with scaffolded()=false yields continue-mode prompt; scaffolded()=false + empty yields scaffold; (c) a turn that keeps yielding messages past turnTimeoutMs (using injected small turnTimeoutMs + fake timers or an interval-yielding stream) is NOT aborted, while a silent stream trips the watchdog.
  </action>
  <verify>
    <automated>npx vitest run src/orchestrator/build-session.test.ts src/orchestrator/sandbox-process.test.ts</automated>
  </verify>
  <done>ensure-dir runs fail-closed before every build turn; scaffold/continue is emptiness-reconciled; the watchdog is a re-armable stall timer that does no destructive reset; existing SandboxAdapter fakes compile unchanged.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Rewrite gallery-publisher.ts into the per-project public-repo publisher</name>
  <files>src/orchestrator/gallery-publisher.ts, src/orchestrator/gallery-publisher.test.ts</files>
  <behavior>
    - sanitizeRepoName(title): lowercase; replace every run of non-[a-z0-9] with a single hyphen; strip leading/trailing hyphens; truncate to <=80 chars (re-strip trailing hyphen after truncation); when the result is empty → dated fallback `vibe-YYYYMMDD-HHMM` from an injected clock (host clock at publish time). Pure + exported. A hostile title (shell metachars, unicode, 200 chars) yields a safe slug containing only [a-z0-9-].
    - Per-generation routing via an injected ProjectRepoStore: on the FIRST completed prompt of a generation (store.lookup(generation) === null) → derive+dedup a name, `gh repo create <owner>/<name> --public`, init the per-project mirror, then store.record(generation, name) ONLY after a successful create. On later prompts (lookup !== null) → reuse the stored name/mirror, never re-create. (This is the reusable per-project scaffold seam from design_seams #2 — keyed on generation, callable from any path.)
    - Dedup: base slug; if store.knownNames() contains it, append `-2`, `-3`, ... until free.
    - Config: GALLERY_GITHUB_OWNER (default TwitchVibecodes) + GALLERY_GITHUB_TOKEN (host secret). GALLERY_PUBLISH_ENABLED === "false" (trimmed) disables; ALSO disabled (null) when no token present. GALLERY_REPO_URL retired.
    - Safety invariants preserved 1:1: execFile arg-arrays ONLY (no shell field on the seam), publishNow never throws (resolves {status}), workspaceCopyFilter still skips node_modules/dotfiles, GH_TOKEN travels ONLY on the exec env (never argv, never a persisted remote URL), the internal serialization chain is kept.
  </behavior>
  <action>
Rewrite the module. Extend `GalleryExec` opts to `{ cwd?: string; env?: Record<string, string> }` (still NO `shell` field — the injection-impossibility property is preserved). defaultExec merges `env` as `opts?.env ? { ...process.env, ...opts.env } : undefined` (HOST-side child; inheriting host env for git/gh is expected and unrelated to the SANDBOX boundary).

New `GalleryConfig`: `{ owner: string; token: string; mirrorRootDir: string; workspaceRootUnc: string }`. `resolveGalleryConfig(env)`: return null when `(env.GALLERY_PUBLISH_ENABLED ?? "").trim() === "false"`; owner = `(env.GALLERY_GITHUB_OWNER ?? "").trim() || "TwitchVibecodes"`; token = `(env.GALLERY_GITHUB_TOKEN ?? "").trim()`; if token is empty → return null (auto-disable; the caller logs loudly). mirrorRootDir = "data/gallery-mirror"; workspaceRootUnc unchanged (`\\wsl.localhost\<distro>\home\<user>\projects` from BUILD_DISTRO_NAME/USER defaults). Delete DEFAULT_REPO_URL and all GALLERY_REPO_URL handling.

Add `export interface ProjectRepoStore { lookup(generation: number): string | null; record(generation: number, repoName: string): void; knownNames(): Set<string>; }` and `export function createProjectRepoStore(db: Database.Database): ProjectRepoStore` backed by the `project_repos` table (Task 3 adds the DDL) — prepared statements only, mirroring workspace.ts. Keep `import type Database from "better-sqlite3"` type-only.

Add `export function sanitizeRepoName(title: string, now: () => Date): string` per the behavior block. Keep `workspaceCopyFilter` and `sanitizeCommitTitle` unchanged.

`createGalleryPublisher` deps gain `store: ProjectRepoStore` and `now?: () => Date` (default `() => new Date()`); keep `config, exec?, fsx?, logger`. In doPublish(input):
  1. `let name = store.lookup(input.generation)`. If null (scaffold): base = sanitizeRepoName(input.title, now); dedup against store.knownNames(); `await exec("gh", ["repo", "create", `${config.owner}/${name}`, "--public"], { env: { GH_TOKEN: config.token } })`; ensure `mirrorRootDir/<name>` exists (fsx.mkdir recursive); `await exec("git", ["-C", mirrorDir, "init"])`; `await exec("git", ["-C", mirrorDir, "remote", "add", "origin", `https://github.com/${config.owner}/${name}.git`])`; then `store.record(input.generation, name)`.
  2. mirrorDir = `${config.mirrorRootDir}/${name}`. Copy the workspace generation dir into it, filtered: src = `${config.workspaceRootUnc}\\app-${input.generation}`, dest = mirrorDir; `fsx.cp(src, dest, { recursive, filter: workspaceCopyFilter })`. IMPORTANT: do NOT rm the whole mirrorDir (that would delete `.git`). Deletions in the workspace are captured by `git add -A` below; if you must clear stale tracked files, clear only non-`.git` entries.
  3. `git -C mirrorDir add -A`; `git -C mirrorDir status --porcelain` → empty ⇒ resolve `{ status: "no-changes", commitHash: null, detail }`.
  4. `git -C mirrorDir commit -m "${sanitizeCommitTitle(input.title)}"` (ONE argv element).
  5. Push with token on ENV only, not argv/URL: `git -c credential.helper= -c credential.helper=!gh auth git-credential -C mirrorDir push -u origin HEAD`, `{ env: { GH_TOKEN: config.token } }` (gh's git-credential helper reads GH_TOKEN; origin stays a plain https URL — no token on disk).
  6. `git -C mirrorDir rev-parse HEAD` → commitHash.
Wrap the whole body in the existing try/catch that resolves `{ status: "failed", ... }` after a loud logger.error — publishNow NEVER rejects. Keep the serialization `chain`.

Rewrite gallery-publisher.test.ts entirely against injected exec/fs fakes + an in-memory ProjectRepoStore fake (NO real gh/git/network). Cover: sanitizeRepoName on a HOSTILE title (`x"; rm -rf ~ $(curl evil)\r\n` + 200 A's + unicode) → slug is only [a-z0-9-], <=80, no shell metachars; empty/space-only/all-symbol title → `vibe-YYYYMMDD-HHMM` via injected clock; dedup (knownNames has base → -2, then -3); scaffold path issues `gh repo create <owner>/<name> --public` and records the name; a SECOND publish for the same generation does NOT call `gh repo create` and pushes to the same mirror; two DIFFERENT generations create two different repos; every exec call is `git`/`gh` with an arg ARRAY and no `shell` key; `@ts-expect-error` that `{ shell: true }` is unrepresentable at the seam; GH_TOKEN appears on gh/git call env and the token string never appears in any argv element or remote-add URL; a rejecting push RESOLVES `{ status: "failed" }` + logs; empty porcelain → no-changes.
  </action>
  <verify>
    <automated>npx vitest run src/orchestrator/gallery-publisher.test.ts</automated>
  </verify>
  <done>Per-project publisher creates one repo per generation, routes later prompts to it, sanitizes hostile titles to safe slugs, keeps token on env only, and never throws.</done>
</task>

<task type="auto">
  <name>Task 3: Persist the generation→repo map, wire the publisher in composition, document knobs</name>
  <files>src/audit/schema.sql, src/main.ts, .env.example</files>
  <action>
schema.sql: append an additive `CREATE TABLE IF NOT EXISTS project_repos ( generation INTEGER PRIMARY KEY, repo_name TEXT NOT NULL, created_at_ms INTEGER NOT NULL );` with a short comment (per-project publisher routing, quick-260711-hak; durable so a mid-stream host restart never re-creates a repo for a generation whose first prompt already published). Idempotent, no migration of existing tables.

main.ts: the real publisher now needs the app db (for the store), but the db is created inside createApp — so BUILD IT INSIDE createApp, not at the entrypoint. (a) Change `buildGalleryPublisher` to take `(db: Database.Database, logger: Logger)`: resolve config via `resolveGalleryConfig(process.env)`; if null → loud warn ("GALLERY PUBLISHING DISABLED — set GALLERY_GITHUB_TOKEN … (owner defaults to TwitchVibecodes)") + return undefined; else `createGalleryPublisher({ config, store: createProjectRepoStore(db), logger })`. (b) In createApp's orchestrator block, replace uses of `opts.galleryPublisher` with `const galleryPublisher = opts.galleryPublisher ?? buildGalleryPublisher(db, logger);` and reference that in the onBuildDone hook (unchanged otherwise — the same recordGalleryPublish audit + db.open guard + fire-and-forget .then/.catch). Because resolveGalleryConfig returns null when GALLERY_GITHUB_TOKEN is unset, tests (no token in env) build no real publisher and stay inert — preserving the injected-fake seam. (c) In the `isMain` entrypoint, REMOVE the `buildGalleryPublisher(bootLogger)` call and the `...(galleryPublisher ? { galleryPublisher } : {})` spread (createApp owns it now). Import `createProjectRepoStore` from gallery-publisher.js.

.env.example: replace the GALLERY_REPO_URL block with GALLERY_GITHUB_OWNER (documented default TwitchVibecodes) and GALLERY_GITHUB_TOKEN (host-side PAT with repo scope; NEVER enters the sandbox; publishing auto-disables loudly if unset). Keep the GALLERY_PUBLISH_ENABLED strict-"false" note. State: one PUBLIC repo per project, named from the first prompt, owner TwitchVibecodes, host-side token only.
  </action>
  <verify>
    <automated>npx vitest run tests/e2e/build-flow.e2e.test.ts && npx tsc --noEmit</automated>
  </verify>
  <done>project_repos table is created idempotently; the real publisher is composed inside createApp from the app db and stays inert without a token; entrypoint no longer double-builds it; .env.example documents the new owner/token knobs and retires GALLERY_REPO_URL.</done>
</task>

<task type="auto">
  <name>Task 4: Token isolation guard (belt-and-braces) + full gate</name>
  <files>tests/invariants/secrets-isolation.test.ts, src/orchestrator/sandbox-process.test.ts</files>
  <action>
tests/invariants/secrets-isolation.test.ts: extend the HOST_SECRET guard so GALLERY_GITHUB_TOKEN is named explicitly. The existing alternation already contains `TOKEN` (so any reference in sandbox-process.ts is already caught) — DO NOT weaken it; ADD `GALLERY_GITHUB_TOKEN|GH_TOKEN` to the alternation and add a synthetic offender case (`env.GALLERY_GITHUB_TOKEN = cfg.token;`) plus an allowlisted-clean case to the self-test, proving the scan flags a regression mechanically. Verify the whole existing suite still passes (the sandbox env-construction file references neither GALLERY_GITHUB_TOKEN nor GH_TOKEN).

sandbox-process.test.ts: add a positive assertion that the sandbox spawn env NEVER carries the gallery token — capture the spawnFn argv (the `/usr/bin/env KEY=VAL …` assignments) and assert no element starts with `GALLERY_GITHUB_TOKEN=` or `GH_TOKEN=`; only `PATH=` (and, when configured, the SANDBOX-derived key) appears. This makes "token never in sandbox env" a named, tested property, not just a source-scan.

Run the FULL gate to prove the whole change set is green together.
  </action>
  <verify>
    <automated>npx vitest run && npx tsc --noEmit && npx biome check .</automated>
  </verify>
  <done>GALLERY_GITHUB_TOKEN is a mechanically-guarded host secret (source scan + sandbox-env unit assertion); the full test + type + lint gate passes.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| chat → repo name | First-prompt text (untrusted, gate-approved but still viewer-authored) becomes a GitHub repo slug + commit message |
| host → sandbox | HOST holds GALLERY_GITHUB_TOKEN; the WSL2 sandbox must never receive it |
| host → GitHub | gh/git run host-side with the PAT to create/push the per-project public repo |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-hak-01 | Information Disclosure | GALLERY_GITHUB_TOKEN reaching the sandbox | mitigate | buildSandboxEnv stays PATH-only; secrets-isolation invariant adds GALLERY_GITHUB_TOKEN/GH_TOKEN to the guard set; sandbox-process.test asserts spawn argv carries no token (Task 4) |
| T-hak-02 | Tampering / Elevation | Hostile first-prompt → shell injection via repo name / commit msg | mitigate | execFile arg-arrays only (no shell field on GalleryExec); sanitizeRepoName → [a-z0-9-] slug; sanitizeCommitTitle; token on env not argv/URL (Task 2) |
| T-hak-03 | Denial of Service | Publisher throwing into the live pipeline | mitigate | publishNow resolves {status} after a loud log, fire-and-forget, serialized chain — never rejects (Task 2) |
| T-hak-04 | Tampering | Duplicate repo creation after a mid-stream restart | mitigate | project_repos durably maps generation→repo; record only after a successful create; lookup routes continue-mode pushes (Tasks 2–3) |
| T-hak-05 | Denial of Service | Watchdog killing a healthy long build → corrupt workspace | mitigate | stall/idle watchdog (reset on activity) + emptiness-keyed continue-mode so a debris dir is never scaffolded over (Task 1) |
| T-hak-06 | Denial of Service | Build spawns into a non-existent distro dir | mitigate | fail-closed ensureWorkspaceDir before spawn; no silent shared-dir fallback (Task 1) |
</threat_model>

<verification>
- `npx vitest run` — all suites green (workspace lifecycle, per-project publisher, secrets isolation, e2e build flow).
- `npx tsc --noEmit` — no type errors (optional SandboxAdapter methods keep existing fakes valid).
- `npx biome check .` — lint/format clean.
- Manual spot-check (not automated here): a hostile first prompt in gallery-publisher.test yields a slug of only [a-z0-9-]; GH_TOKEN never appears in any captured argv.
</verification>

<success_criteria>
- BL-01: distro workspace dir created fail-closed before every build turn; no shared-dir fallback; isolation/buildSandboxEnv allowlist unchanged.
- HI-01: continue mode triggers on a non-empty dir even without a prior done build; rule = scaffolded() OR workspaceHasFiles(dir).
- HI-03: watchdog is a stall/idle timer; healthy long builds survive; killed builds produce no false done and no build_history row; no destructive workspace reset.
- Per-project publisher: one public repo per generation under TwitchVibecodes, named from the first prompt (sanitized+deduped, dated fallback), later prompts push to the same repo; GALLERY_REPO_URL retired; owner/token config + auto-disable-without-token.
- Reusable seams: rotation (newProject), ship (publishNow), and per-generation scaffold stay plain functions callable from any path (not console-only); rotation is non-destructive.
- Token isolation: GALLERY_GITHUB_TOKEN mechanically guarded out of the sandbox env; buildSandboxEnv verified.
- publisher-never-throws and token-never-in-sandbox hold as tested must_have truths.
</success_criteria>

<out_of_scope>
The overnight review's MEDIUM findings are NOT in the binding requirement set and are deferred (documented here so they are not silently dropped): ME-01 (gallery copy racing the next continue-mode build in the same generation — the fire-and-forget copy is unchanged), ME-02 (workspace.markBuilt not under auditIfOpen), ME-03 (unbounded mirror/.git growth across generations). HI-02 (Bash-written content bypassing the in-flight COMP-02 re-screen) is also out of scope for this task. The `!build`/`!suggest` command parsing, mixed-vote, ship-on-rotation wiring, and overlay chips are the FOLLOW-ON task's job — this plan only keeps the rotation/ship/scaffold seams reusable (see design_seams). src/compliance/**, halt.ts, kill-switch paths, and CLASSIFIER_SYSTEM_PROMPT are READ-ONLY and untouched.
</out_of_scope>

<output>
Create `.planning/quick/260711-hak-make-per-project-github-publishing-work-/260711-hak-SUMMARY.md` when done.
</output>
