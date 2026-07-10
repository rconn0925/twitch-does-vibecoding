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

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type {
  SDKMessage,
  SpawnedProcess,
  SpawnOptions,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { AbortRegistry } from "../kill-switch/abort.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type {
  BuildStatusView,
  GateResult,
  StreamMode,
  SuggestionCandidate,
} from "../shared/types.js";

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
  /** D3-03 model policy: research always runs on Sonnet; build inherits Fable. */
  agent: "research" | "build";
  /** "sonnet" for research; undefined for build (omitted → inherits Fable). */
  model: "sonnet" | undefined;
  /** Orchestrator-authored agent instructions — never contains chat text. */
  systemPrompt: string;
  /** The per-turn user content: delimited chat-derived task/plan text as DATA. */
  userPrompt: string;
  /** Present for the sandboxed build agent; absent for host-side research. */
  sandbox?: SandboxAdapter;
  /** Redirects Claude Code execution into WSL2 (03-05); absent → native spawn. */
  spawnClaudeCodeProcess?: (opts: SpawnOptions) => SpawnedProcess;
  /** Registered into AbortRegistry for the streamer veto (BUILD-04 / D3-10). */
  abortController: AbortController;
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
}

/**
 * Preview-manager seam (03-08): is the sandboxed dev server answering yet? The
 * real implementation polls 127.0.0.1:<PREVIEW_DEV_SERVER_PORT>; tests inject a
 * fake that resolves deterministically.
 */
export interface DevServerProbe {
  reachable(): Promise<boolean>;
}

/**
 * Minimal state-machine sliver the orchestrator drives (OverlayModeSource
 * pattern): flips BUILD_IN_PROGRESS on pickup, IDLE on done/failed/skip, and
 * records the active task's PID for the abort path (main.ts:206-232 plumbing).
 */
export interface BuildMachineView {
  readonly mode: StreamMode;
  transition(next: StreamMode): void;
  setActiveTask(taskId: string, pid: number | null): void;
}

/**
 * COMP-02 second-pass caller (03-04): re-screens the build agent's OWN generated
 * plan text through the SAME Phase 1 gate (classify()) BEFORE any code is
 * written (D3-06). A blocking approve/reject/hold — never submitCandidate().
 */
export interface Comp02Screen {
  screenPlan(args: { taskId: string; planText: string }): Promise<GateResult>;
}

/**
 * SAND-04 zero-interpolation prompt construction (03-06): turns a QueuedTask
 * into the delimited `<task_description source="chat">…</task_description>` user
 * prompt. Mirrors the classifier's fixed-system-prompt / untrusted-text-as-data
 * discipline.
 */
export interface PromptBoundary {
  buildTaskPrompt(task: SuggestionCandidate): string;
}

/**
 * Where translated pipeline-stage transitions go (overlay push / console state /
 * chat narration). Consumers receive only the BuildStatusView vocabulary, never
 * a raw SDK message.
 */
export interface ProgressSink {
  push(status: BuildStatusView): void;
}

/**
 * The DI shape 03-06's build session implements against — everything the
 * orchestrator touches is injected so vitest never constructs a real
 * query()/WSL2/SQLite (mirrors EnqueueWinnerDeps). Skeleton: fields are the
 * seams above plus the existing Phase 1/2 handles the orchestrator consumes.
 */
export interface BuildSessionDeps {
  /** Read-only consumer: list()/remove(); NEVER a new .enqueue() call site. */
  taskQueue: TaskQueue;
  /** Audit ledger handle (recordPipelineStage + siblings write here, D3-13). */
  db: Database.Database;
  /** State-machine sliver (BUILD_IN_PROGRESS ↔ IDLE, active-task PID). */
  machine: BuildMachineView;
  /** Agent-session abort/teardown registry (BUILD-04 / D3-10). */
  registry: AbortRegistry;
  /** Host-side SDK query() wrapper (research + build turns). */
  agentRunner: AgentRunner;
  /** WSL2 process isolation for the build agent (03-05). */
  sandboxAdapter: SandboxAdapter;
  /** COMP-02 pre-write plan re-screen (03-04, D3-06). */
  comp02: Comp02Screen;
  /** SAND-04 delimited-prompt construction (03-06). */
  promptBoundary: PromptBoundary;
  /** Translated pipeline-stage sink (overlay/console/chat). */
  progress: ProgressSink;
  logger?: Logger;
}
