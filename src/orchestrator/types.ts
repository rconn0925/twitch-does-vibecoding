/**
 * Injected structural interfaces for the Phase 3 build orchestrator.
 *
 * These are the DEPENDENCY-INJECTION seams (mirroring KeyEventSource /
 * ChatEventSource / OverlayModeSource) that let vitest inject fakes and never
 * touch real WSL2 / query() / network. Every real, native/network-touching
 * implementation is constructed ONLY in src/main.ts's entrypoint branch or a
 * guarded dynamic import (buildTwitchAdapters / armPanicHotkey pattern).
 *
 * Raw Agent SDK message/hook/spawn types are imported HERE (and inspected in
 * progress-events.ts) and NOWHERE ELSE — src/orchestrator/ is the containment
 * boundary. Nothing outside src/orchestrator/ imports a raw SDK type; only the
 * small stable PipelineStage/BuildStatusView vocabulary crosses outward
 * (single-funnel COMP-01 discipline; PILL_BY_MODE analog).
 */

import type {
  SDKMessage,
  SpawnedProcess,
  SpawnOptions,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { BuildStatusView, StreamMode } from "../shared/types.js";

/**
 * The small internal message type the AgentRunner yields. It aliases the raw
 * SDK message union plus the two subagent-lifecycle hook inputs — deliberately
 * confined to src/orchestrator/. progress-events.translate() is the ONLY place
 * these shapes are structurally inspected; consumers downstream see only
 * PipelineStage.
 */
export type AgentMessage = SDKMessage | SubagentStartHookInput | SubagentStopHookInput;

/**
 * What the orchestrator hands an AgentRunner for one agent turn. The system
 * prompt is 100% orchestrator-authored; the untrusted, chat-derived task text
 * travels ONLY in `userPrompt`, delimited as data (SAND-04 / D3-05 — never
 * concatenated into `systemPrompt`).
 */
export interface AgentRunSpec {
  /**
   * D3-03 model policy (updated quick-0iu): research turns no longer exist in
   * the live pipeline — every pipeline turn is the sandboxed BUILD turn; the
   * orchestrator pins the model explicitly in turn-options.ts (BUILD_MODEL
   * override, default claude-fable-5). No `model` field exists, so the
   * pipeline structurally cannot request an override. The Sonnet compliance
   * gate (classifier-runner.ts, documented D-1 exception) is a SEPARATE
   * surface, untouched by this narrowing.
   */
  agent: "build";
  /** Orchestrator-authored agent instructions — never contains chat text. */
  systemPrompt: string;
  /** The per-turn user content: delimited chat-derived task text as DATA. */
  userPrompt: string;
  /**
   * POSIX-absolute path INSIDE the distro the build turn cds into
   * (`/home/builder/projects/app-<generation>`, quick-0iu persistent
   * workspace). sdk-runner sets `Options.cwd` from this; sandbox-process.ts
   * translates a POSIX-absolute SpawnOptions.cwd to `wsl --cd`.
   */
  workspaceDir: string;
  /** Present for the sandboxed build agent (always, in the live pipeline). */
  sandbox?: SandboxAdapter;
  /** Redirects Claude Code execution into WSL2 (03-05); absent → native spawn. */
  spawnClaudeCodeProcess?: (opts: SpawnOptions) => SpawnedProcess;
  /** Registered into AbortRegistry for the streamer veto (BUILD-04 / D3-10). */
  abortController: AbortController;
}

/**
 * The persistent-workspace seam (quick-0iu amendment A/B). ONE workspace
 * directory persists across builds inside the WSL2 distro: the first winner in
 * a generation scaffolds, later winners CONTINUE the same project. "New
 * project" rotates the generation — the previous dir stays on disk untouched
 * (archive-by-construction; no deletion path exists). Backed by a single-row
 * SQLite table so state survives a host-process crash mid-stream; the distro
 * filesystem itself survives `wsl --terminate` (plain files, nothing wipes
 * per-task). Implemented by src/orchestrator/workspace.ts; vitest injects a
 * fake like every other seam.
 */
export interface WorkspaceView {
  /** `/home/builder/projects/app-<generation>` — POSIX-absolute inside the distro. */
  dir(): string;
  /** True once ANY build finalized `done` in the current generation. */
  scaffolded(): boolean;
  /** A build finalized `done` — the workspace is now an existing project. */
  markBuilt(): void;
  /**
   * Rotate to a fresh generation (old dir archived in place); returns the new
   * generation. quick-t8k: allocates ABOVE the all-time top_generation
   * high-water mark — never `generation + 1` off a possibly swapped-back
   * pointer — so a fresh generation can never collide with an existing app-N
   * dir or project_repos row.
   */
  newProject(): number;
  /** The current generation number (1-based). */
  generation(): number;
  /**
   * quick-t8k chat-voted portfolio swap: move ONLY the generation pointer to
   * an EXISTING generation (scaffolded flips to 1 — the target holds a built
   * project, so the next build continues it). Non-destructive: no filesystem
   * touch, no deletion, top_generation untouched. VALIDATING (BLOCKER 2):
   * throws on a non-integer target, target < 1, target > top_generation, and
   * target === the current generation — always BEFORE any write.
   */
  activateExisting(generation: number): void;
}

/**
 * Wraps the SDK `query()` call. The real implementation (03-06) lives host-side
 * and keeps every raw SDK type inside src/orchestrator/; tests inject a fake
 * that yields hand-built AgentMessage fixtures with no network.
 */
export interface AgentRunner {
  run(spec: AgentRunSpec): AsyncIterable<AgentMessage>;
}

/**
 * The process-isolation seam behind which the real wsl.exe implementation
 * (03-05) hides. `terminate()` is the reliable, total teardown (wsl.exe
 * --terminate <distro>) required because tree-kill on the wsl.exe wrapper PID
 * does not reach the Linux process tree (RESEARCH.md §g, BUILD-04).
 */
export interface SandboxAdapter {
  spawn(opts: SpawnOptions): SpawnedProcess;
  terminate(): Promise<void>;
  /**
   * BL-01 fail-closed distro-dir bootstrap. `wsl mkdir -p <dir>` via the same
   * distro/user config as spawn(); REJECTS (throws) on a non-zero exit so the
   * build fails CLOSED rather than spawning into a non-existent workspace or
   * silently falling back to a shared dir. OPTIONAL so the ~8 existing test
   * fakes need no change; the concrete production adapter implements it.
   */
  ensureWorkspaceDir?(dir: string): Promise<void>;
  /**
   * HI-01 emptiness probe. Resolves true when the dir has any NON-HIDDEN entry
   * (so continue-mode runs over real debris even without a prior `done`), false
   * when empty or dotfiles-only. Dot-entries are deliberately ignored (EMPTY-01):
   * the agent's own `.claude` session dir must never flip an unbuilt generation
   * into continue mode. OPTIONAL (existing fakes fall back to scaffolded()-only).
   */
  workspaceHasFiles?(dir: string): Promise<boolean>;
  /**
   * EMPTY-01 post-build output probe: does the workspace hold anything the
   * gallery publisher could actually commit (any non-hidden entry that isn't
   * node_modules)? build-session consults this AFTER an ok build turn and
   * withholds the `done` finalize (→ narrated failed decision instead) when the
   * turn produced nothing — a phantom `done` must never markBuilt() or publish.
   * OPTIONAL — when absent (test fakes), the guard is skipped and `done`
   * finalizes as before.
   */
  workspaceHasCommittableFiles?(dir: string): Promise<boolean>;
  /**
   * quick-t8k preview ownership: start the in-distro preview dev server
   * (inline `python3 -c` SimpleHTTPRequestHandler subclass adding
   * `Cache-Control: no-store` on every response — quick-k3x; detached, port
   * argv-final so the cmdline still ends `http.server <port>`) rooted at
   * `dir`. Both args are
   * INTERNALLY derived — `dir` from workspace.dir() (integer-generation path)
   * and `port` from resolvePreviewDevServerPort — never chat text. REJECTS on
   * wsl exec failure (the supervisor catches — fail-open, never the app).
   * OPTIONAL (ensureWorkspaceDir precedent): existing test fakes need no change.
   */
  startPreviewDevServer?(dir: string, port: number): Promise<void>;
  /**
   * quick-t8k preview ownership: stop ONLY the exact-port preview server via
   * an END-ANCHORED `pkill -f 'http\.server <port>$'` — port 5555 can never
   * match a hypothetical 55555, and `wsl --terminate` (the halt path's tool)
   * is NEVER involved. `|| true` makes a no-match exit success by
   * construction. OPTIONAL like startPreviewDevServer.
   */
  stopPreviewDevServer?(port: number): Promise<void>;
}

/**
 * Preview-manager seam (03-08): is the sandboxed dev server answering yet? The
 * real implementation polls 127.0.0.1:<PREVIEW_DEV_SERVER_PORT>; tests inject a
 * fake that resolves deterministically.
 */
export interface DevServerProbe {
  /**
   * Pure TCP process-up check: is 127.0.0.1:<port> answering a socket connect?
   * MUST stay content-blind — the dev-server-supervisor depends on this exact
   * "is the process listening?" semantics, so its meaning never changes.
   */
  reachable(): Promise<boolean>;
  /**
   * quick-ofs content-aware readiness the PREVIEW surface uses. A bounded, timed
   * HTTP GET of the dev server's own body: false when the body is a bare
   * python http.server "Directory listing for /" page (no real app built yet)
   * or on ANY failure (refused / timeout / non-200 / parse) — fail-closed so a
   * directory listing can never render as "LIVE" on the broadcast. OPTIONAL so
   * TCP-only fakes and the console-path default that implement only reachable()
   * stay valid; /api/reachable falls back to reachable() when it is absent.
   */
  appReady?(): Promise<boolean>;
}

/**
 * Minimal state-machine sliver the orchestrator drives (OverlayModeSource
 * pattern): flips BUILD_IN_PROGRESS on pickup, IDLE on done/failed/skip, and
 * records the active task's PID for the abort path (main.ts:206-232 plumbing).
 */
export interface BuildMachineView {
  readonly mode: StreamMode;
  transition(next: StreamMode): void;
  /** taskId is nullable so the orchestrator can CLEAR the active task on build
   *  end — matches StreamModeMachine.setActiveTask(taskId: string | null, …). */
  setActiveTask(taskId: string | null, pid: number | null): void;
}

/**
 * Where translated pipeline-stage transitions go (overlay push / console state /
 * chat narration). Consumers receive only the BuildStatusView vocabulary, never
 * a raw SDK message.
 *
 * NOTE (WR-04): the authoritative build-session dependency shape is
 * `BuildSessionDeps` in build-session.ts (which consumes `Comp02Deps` from
 * comp02.ts and the prompt-boundary.ts functions directly). Earlier blueprint
 * interfaces (`BuildSessionDeps`, `Comp02Screen`, `PromptBoundary`) that once
 * lived here diverged from the real shapes and were unused by any source file —
 * they were removed so this file is not a misleading second source of truth.
 */
export interface ProgressSink {
  push(status: BuildStatusView): void;
}
