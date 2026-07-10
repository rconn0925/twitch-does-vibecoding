import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAuditRecords } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import { BUILD_STAGE_CHANGED } from "../../src/overlay/server.js";
import type { PipelineStage } from "../../src/shared/types.js";

/**
 * BUILD-03 / BUILD-04 end-to-end (plan 03-09): a build failure is NEVER silent —
 * it degrades to a narrated retry/skip decision on the console + in chat; a model
 * refusal is a first-class `refused` event; and a streamer veto during an
 * in-flight sandboxed build aborts it cleanly (fake sandboxTeardown + the
 * registered AbortController), reaching HALTED immediately (decoupled from
 * teardown, D-02). Driven against createApp's injected-fake seams (fake
 * AgentRunner, fake SandboxAdapter, fake chat) — NO real WSL2 / query() / network.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (plain objects; no SDK type import) ──────────────
const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const resultFailed = { type: "result", subtype: "error_max_turns", is_error: true };
const modelRefusal = { subtype: "model_refusal_no_fallback" };

/** research + plan happy; the SANDBOXED build turn yields `buildStream` each call. */
function buildTurnRunner(buildStream: unknown[]): AgentRunner {
  return {
    run(spec) {
      const sandboxed = spec.sandbox !== undefined;
      return (async function* () {
        if (spec.agent === "research") {
          yield assistantText("research notes") as never;
          yield resultSuccess as never;
        } else if (spec.agent === "build" && !sandboxed) {
          yield assistantText("Build plan: make a small page.") as never;
          yield resultSuccess as never;
        } else {
          for (const m of buildStream) yield m as never;
        }
      })();
    },
  };
}

/** A runner whose sandboxed build turn blocks on a gate the test releases. */
function gatedBuildRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: AgentRunner = {
    run(spec) {
      const sandboxed = spec.sandbox !== undefined;
      return (async function* () {
        if (spec.agent === "research") {
          yield assistantText("research notes") as never;
          yield resultSuccess as never;
        } else if (spec.agent === "build" && !sandboxed) {
          yield assistantText("Build plan: make a small page.") as never;
          yield resultSuccess as never;
        } else {
          await gate; // hold `building` open until the test halts + releases
          yield writeBatch("index.html", "<h1>ok</h1>") as never;
          yield resultSuccess as never;
        }
      })();
    },
  };
  return { runner, release: () => release() };
}

function fakeSandbox(): SandboxAdapter & { terminate: ReturnType<typeof vi.fn> } {
  return {
    spawn: () => ({}) as never,
    terminate: vi.fn(async () => {}),
  } as unknown as SandboxAdapter & { terminate: ReturnType<typeof vi.fn> };
}

const fakeProbe: DevServerProbe = { reachable: async () => false };

function fakeChatSource() {
  const source: ChatEventSource = {
    onChannelChatMessage(_b, _u, _h) {
      return {};
    },
    onUserSocketReady(_h) {
      return {};
    },
    onUserSocketDisconnect(_h) {
      return {};
    },
    start() {},
    stop() {},
  };
  return { source } as { source: ChatEventSource };
}

function capturingSink() {
  const sent: string[] = [];
  const sink: ChatMessageSink = {
    sendChatMessage(_broadcasterId: string, text: string): Promise<unknown> {
      sent.push(text);
      return Promise.resolve({});
    },
  };
  return { sent, sink };
}

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

async function until<T>(
  fn: () => Promise<T | undefined> | (T | undefined),
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await sleep(15);
  }
}

/** Seed two approved candidates, open a round, vote option 1, and close it. */
function drivePooledWinner(app: AppHandle, title = "make a counter app"): void {
  app.pool.add(
    {
      id: "cand-1",
      source: "chat",
      kind: "suggestion",
      twitchUsername: "a",
      text: title,
      submittedAtMs: Date.now(),
    },
    approved,
  );
  app.pool.add(
    {
      id: "cand-2",
      source: "chat",
      kind: "suggestion",
      twitchUsername: "b",
      text: "make a todo list",
      submittedAtMs: Date.now(),
    },
    approved,
  );
  app.round.startRound();
  app.round.recordVote("voter-1", 1);
  app.round.closeRound();
}

function baseUrl(app: AppHandle): string {
  return `http://127.0.0.1:${app.port}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ConsoleBuild {
  build: { taskId: string; title: string; stage: PipelineStage; decisionPending: boolean } | null;
  mode: string;
}
async function consoleState(app: AppHandle): Promise<ConsoleBuild> {
  return (await (await fetch(`${baseUrl(app)}/api/state`)).json()) as ConsoleBuild;
}

describe("build-failure e2e — never silent (BUILD-03 / D3-09)", () => {
  let app: AppHandle | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("a transient build failure auto-retries once, narrates the decision, and skip returns to IDLE with an audit row", async () => {
    const { sent, sink } = capturingSink();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      // Both build attempts fail transiently → auto-retry once → decision pending.
      agentRunner: buildTurnRunner([resultFailed]),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chatSource: fakeChatSource().source,
      chatSink: sink,
    });

    drivePooledWinner(app);

    // Freeze on a `failed` decision — the machine stays BUILD_IN_PROGRESS.
    await until(async () =>
      (await consoleState(app as AppHandle)).build?.decisionPending ? true : undefined,
    );
    const state = await consoleState(app);
    expect(state.mode).toBe("BUILD_IN_PROGRESS");
    expect(state.build?.stage).toBe("failed");
    expect(state.build?.decisionPending).toBe(true);

    // Exactly one auto-retry (D3-09) was recorded.
    expect(listAuditRecords(app.db, { limit: 20, eventType: "build_retry" })).toHaveLength(1);
    // Chat narrated the retry AND the streamer decision — never silent.
    await until(() => sent.some((s) => s.includes("giving it one more shot")));
    await until(() => sent.some((s) => s.includes("streamer's calling retry or skip")));

    // The streamer picks SKIP from the console → clean return to IDLE + audit row.
    const taskId = state.build?.taskId ?? "";
    const res = await postJson(`${baseUrl(app)}/api/tasks/${taskId}/skip`, {
      reasonTag: "too-big",
    });
    expect(res.status).toBe(200);
    await until(async () =>
      (await consoleState(app as AppHandle)).mode === "IDLE" ? true : undefined,
    );
    const skips = listAuditRecords(app.db, { limit: 20, eventType: "build_skip" });
    expect(skips).toHaveLength(1);
    expect(skips[0]?.rationale).toContain("too-big");
    await until(() => sent.some((s) => s.includes("Skipping")));
    // The console build panel collapsed.
    expect((await consoleState(app)).build).toBeNull();
  });

  it("a model refusal surfaces as `refused` on the overlay + a narrated chat line + a console decision", async () => {
    const { sent, sink } = capturingSink();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: buildTurnRunner([modelRefusal]),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      chatSource: fakeChatSource().source,
      chatSink: sink,
    });
    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed");
    const seen: PipelineStage[] = [];
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) seen.push(snap.stage);
    });

    drivePooledWinner(app);

    await until(() => seen.includes("refused"));
    // Refusal is `refused`, NOT `failed` (D3-08), and it freezes a decision.
    expect(seen.at(-1)).toBe("refused");
    expect(seen).not.toContain("done");
    const state = await consoleState(app);
    expect(state.mode).toBe("BUILD_IN_PROGRESS");
    expect(state.build?.stage).toBe("refused");
    expect(state.build?.decisionPending).toBe(true);
    // First-class recorded event + narrated chat line ("Moving on to the next one").
    expect(
      listAuditRecords(app.db, { limit: 20, eventType: "build_refused" }).length,
    ).toBeGreaterThan(0);
    await until(() => sent.some((s) => s.includes("the build agent won't build")));

    // Resolve via skip to leave a clean machine.
    await postJson(`${baseUrl(app)}/api/tasks/${state.build?.taskId ?? ""}/skip`, {});
    await until(async () =>
      (await consoleState(app as AppHandle)).mode === "IDLE" ? true : undefined,
    );
  });

  it("a streamer veto during an in-flight build aborts it: fake sandboxTeardown fires + the AbortController aborts, HALTED immediate", async () => {
    const { sent, sink } = capturingSink();
    const sandbox = fakeSandbox();
    const gated = gatedBuildRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: gated.runner,
      sandboxAdapter: sandbox,
      devServerProbe: fakeProbe,
      chatSource: fakeChatSource().source,
      chatSink: sink,
    });

    // Capture the build's AbortController as it's registered.
    const controllerSpy = vi.spyOn(app.registry, "registerController");

    // CR-01: watch every overlay build-stage the public broadcast would render.
    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed");
    const seen: PipelineStage[] = [];
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) seen.push(snap.stage);
    });

    drivePooledWinner(app);
    // Wait until the sandboxed build is live (`building`).
    await until(async () =>
      (await consoleState(app as AppHandle)).build?.stage === "building" ? true : undefined,
    );

    // Streamer hits Halt → abortActiveWork fires the registered controller +
    // sandboxTeardown; HALTED is reached IMMEDIATELY (decoupled from teardown).
    const haltRes = await postJson(`${baseUrl(app)}/api/halt`, {});
    expect(haltRes.status).toBe(200);
    expect((await consoleState(app)).mode).toBe("HALTED");

    // The registered AbortController was aborted (BUILD-04).
    const ac = controllerSpy.mock.calls.at(-1)?.[1];
    expect(ac?.signal.aborted).toBe(true);
    // The fake WSL2 sandbox teardown ran.
    await until(() => (sandbox.terminate.mock.calls.length > 0 ? true : undefined));
    expect(sandbox.terminate).toHaveBeenCalled();
    // The veto-abort was narrated on chat (D3-10).
    await until(() => sent.some((s) => s.includes("pulling the plug")));

    // Release the held build generator so the aborted pipeline unwinds to its
    // terminal-abort finalize (CR-01), which writes the sandbox_teardown row.
    const db = app.db;
    gated.release();
    await until(() =>
      listAuditRecords(db, { limit: 50, eventType: "sandbox_teardown" }).length > 0
        ? true
        : undefined,
    );

    // CR-01 (THE fix): a vetoed/halted build must NEVER be reported as `done`.
    // The public overlay never renders the "BUILT IT" celebration…
    expect(seen).not.toContain("done");
    // …and the compliance ledger carries NO `pipeline_stage: done` row for this
    // build — only the terminal `sandbox_teardown` row stands in for the abort.
    expect(
      listAuditRecords(db, { limit: 50, eventType: "pipeline_stage", decision: "done" }),
    ).toHaveLength(0);
  });
});
