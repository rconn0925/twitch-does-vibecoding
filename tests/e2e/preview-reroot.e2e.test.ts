import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  GalleryPublisher,
  PublishInput,
  PublishResult,
} from "../../src/orchestrator/gallery-publisher.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";

/**
 * quick-t8k orchestrator-owned preview dev server e2e: the supervisor starts
 * the in-distro 5555 server at boot rooted at the ACTIVE app-N dir and
 * re-roots (one stop+start pair) on EVERY generation change — console
 * new-project, project-switch winner rotation, and swap activation. A failed
 * swap ship re-roots NOTHING; a start failure never crashes the app
 * (fail-open to standing-by); adapters without the optional methods no-op
 * (every pre-existing e2e suite keeps passing unchanged).
 */

// Deterministic, fast supervisor cycles in e2e: zero settle wait.
process.env.PREVIEW_DEV_SERVER_SETTLE_MS = "0";

type AppHandle = Awaited<ReturnType<typeof createApp>>;

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

function recordingRunner() {
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      return (async function* () {
        yield writeBatch("index.html", "<b>hi</b>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return { runner, specs };
}

/** A sandbox adapter WITH the preview lifecycle methods, recording every call. */
function previewSandbox(opts: { failStart?: boolean } = {}) {
  const starts: Array<{ dir: string; port: number }> = [];
  const stops: number[] = [];
  const events: string[] = [];
  const adapter: SandboxAdapter = {
    spawn: () => ({}) as never,
    terminate: async () => {
      events.push("terminate");
    },
    async stopPreviewDevServer(port: number) {
      events.push("stop");
      stops.push(port);
    },
    async startPreviewDevServer(dir: string, port: number) {
      events.push(`start:${dir}`);
      starts.push({ dir, port });
      if (opts.failStart) throw new Error("start failed");
    },
  };
  return { adapter, starts, stops, events };
}

const reachableProbe: DevServerProbe = { reachable: async () => true };

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

function recordingPublisher() {
  const publishCalls: PublishInput[] = [];
  let failFinalSnapshot = false;
  const publisher: GalleryPublisher = {
    publishNow(input) {
      publishCalls.push(input);
      const status: PublishResult["status"] =
        failFinalSnapshot && input.title.includes("final snapshot") ? "failed" : "published";
      return Promise.resolve({
        status,
        commitHash: status === "published" ? "hash" : null,
        detail: "ok",
      });
    },
    revertLast() {
      return Promise.resolve({ status: "failed", commitHash: null, detail: "unused" });
    },
  };
  return {
    publisher,
    publishCalls,
    setFailFinalSnapshot(v: boolean) {
      failFinalSnapshot = v;
    },
  };
}

function fakeChatSource() {
  const messageHandlers: ((e: ChatMessageEvent) => void)[] = [];
  const source: ChatEventSource = {
    onChannelChatMessage(_broadcasterId, _userId, handler) {
      messageHandlers.push(handler);
      return {};
    },
    onUserSocketReady() {
      return {};
    },
    onUserSocketDisconnect() {
      return {};
    },
    start() {},
    stop() {},
  };
  return {
    source,
    say(chatterId: string, displayName: string, messageText: string): void {
      for (const handler of messageHandlers) {
        handler({ chatterId, chatterDisplayName: displayName, messageText });
      }
    },
  };
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

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

function workspaceGeneration(app: AppHandle): number {
  const row = app.db.prepare("SELECT generation FROM workspace_state WHERE id = 1").get() as {
    generation: number;
  };
  return row.generation;
}

function voteKindToVictory(app: AppHandle, kind: string): string {
  app.round.startRound();
  const snap = app.round.snapshot();
  const entry = snap?.candidates.find((c) => c.candidate.kind === kind);
  if (!entry) throw new Error(`no pooled candidate of kind ${kind} in the round`);
  app.round.recordVote("voter-1", entry.option);
  const winnerId = entry.candidate.id;
  app.round.closeRound();
  return winnerId;
}

describe("preview re-root e2e: boot + all three generation-change sites + failed-ship suppression", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
  const sandbox = previewSandbox();
  const pub = recordingPublisher();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let chatter = 100;

  /** Pool one text via a fresh chatter (avoids intake cooldown/cap). */
  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  beforeAll(async () => {
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
      galleryPublisher: pub.publisher,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("BOOT: one stop+start pair, rooted at the active app-1 dir on the resolved port", async () => {
    await until(() => sandbox.starts.length === 1);
    expect(sandbox.starts[0]).toEqual({ dir: "/home/builder/projects/app-1", port: 5555 });
    expect(sandbox.stops).toEqual([5555]);
    // stop strictly BEFORE start.
    expect(sandbox.events.indexOf("stop")).toBeLessThan(
      sandbox.events.indexOf("start:/home/builder/projects/app-1"),
    );
  });

  it("a plain done build (no generation change) re-roots NOTHING", async () => {
    say("!suggest make a counter app");
    say("!suggest seed filler idea");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    await sleep(100);
    expect(sandbox.starts).toHaveLength(1);
  });

  it("CONSOLE new-project re-roots at the fresh generation dir", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/workspace/new-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { generation: number }).toEqual({ generation: 2 });
    await until(() => sandbox.starts.length === 2);
    expect(sandbox.starts[1]).toEqual({ dir: "/home/builder/projects/app-2", port: 5555 });
  });

  it("PROJECT-SWITCH winner rotation (confirmed ship) re-roots at the rotated dir", async () => {
    // Make generation 2 an ACTIVE project first (done build → scaffolded).
    say("!suggest build gen two thing");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 2 && app.machine.mode === "IDLE");

    say("!build a brand new app");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => workspaceGeneration(app) === 3 && app.machine.mode === "IDLE");
    await until(() => sandbox.starts.length === 3);
    expect(sandbox.starts[2]).toEqual({ dir: "/home/builder/projects/app-3", port: 5555 });
  });

  it("SWAP activation re-roots at the TARGET dir; a FAILED swap ship re-roots NOTHING", async () => {
    // Bind repos so the swap can resolve; make gen 3 an active project.
    const now = Date.now();
    const ins = app.db.prepare(
      "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)",
    );
    ins.run(1, "counter-app", now);
    ins.run(2, "gen-two-thing", now);
    ins.run(3, "brand-new-app", now);
    await until(() => app.machine.mode === "IDLE" && runner.specs.length === 3);

    const startsBefore = sandbox.starts.length;

    // (a) FAILED ship → no activation, NO re-root.
    pub.setFailFinalSnapshot(true);
    say('!swapbuild "counter-app"');
    say("!suggest filler four");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "swap");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await sleep(100);
    expect(workspaceGeneration(app)).toBe(3);
    expect(sandbox.starts).toHaveLength(startsBefore);

    // (b) confirmed ship → activation → re-root at the TARGET dir.
    pub.setFailFinalSnapshot(false);
    say('!swapbuild "counter-app"');
    say("!suggest filler five");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "swap");
    await until(() => workspaceGeneration(app) === 1);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-1", port: 5555 });
  });

  it("the supervisor NEVER calls wsl --terminate (halt-path tool)", () => {
    expect(sandbox.events).not.toContain("terminate");
  });
});

describe("preview re-root e2e: fail-open + adapter-absence", () => {
  it("a start rejection never crashes the app — boots fine, machine IDLE", async () => {
    const sandbox = previewSandbox({ failStart: true });
    const runner = recordingRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
    });
    try {
      await until(() => sandbox.starts.length >= 1);
      await sleep(50);
      expect(app.machine.mode).toBe("IDLE");
    } finally {
      await app.close();
    }
  });

  it("an adapter WITHOUT the optional methods boots and runs unchanged (silent no-op supervisor)", async () => {
    const runner = recordingRunner();
    const bare: SandboxAdapter = {
      spawn: () => ({}) as never,
      terminate: async () => {},
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: runner.runner,
      sandboxAdapter: bare,
      devServerProbe: reachableProbe,
    });
    try {
      await sleep(50);
      expect(app.machine.mode).toBe("IDLE");
    } finally {
      await app.close();
    }
  });
});
