import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "../../src/orchestrator/types.js";
import type { GateResult } from "../../src/shared/types.js";

/**
 * Single-suggestion auto-build e2e (quick-260711-ly4): when the auto-cycle
 * suggestion window ends with EXACTLY ONE pooled candidate, that lone candidate
 * is built DIRECTLY through the SAME winner funnel a voted/chaos win uses — no
 * meaningless 1-option vote round is opened. Proven against createApp's injected
 * fakes (fake chat/sink, fakeClassifier, fake runner/sandbox) — no network, no
 * real git/WSL2.
 *
 * A short SUGGEST_PHASE_SECONDS (0.3s) drives real-timer phase ends; the default
 * EARLY_CLOSE_POOL_SIZE (5) never trips for a single candidate, so the window
 * elapses normally, startRound throws pool-too-small, and the solo path fires.
 */

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

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

const approved: GateResult = { decision: "approved", category: null, rationale: "test: approved" };

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

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(20);
  }
}

function setEnv(vars: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function soloPickRows(app: AppHandle) {
  return listAuditRecords(app.db, { limit: 50, eventType: "solo_pick" });
}

function roundCount(app: AppHandle): number {
  return (app.db.prepare("SELECT COUNT(*) AS n FROM rounds").get() as { n: number }).n;
}

describe("solo auto-build e2e: one pooled candidate builds directly, NO vote round", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  let runner: ReturnType<typeof recordingRunner>;
  let app: AppHandle;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = setEnv({
      SUGGEST_PHASE_SECONDS: "0.3", // short real-timer phase ends
      // Default EARLY_CLOSE_POOL_SIZE (5) never trips for one candidate.
    });
    runner = recordingRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    // Exactly ONE approved suggestion enters the pool. At the next suggest-window
    // end the pool holds size 1 → the solo path builds it directly.
    chat.say("s1", "eve", "!suggest build a snake game");
    await until(() => soloPickRows(app).length === 1);
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    // Give any (incorrect) second pick / round-open room to surface.
    await sleep(500);
  }, 20_000);

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it("a distinct solo_pick audit row is written (kind in decision, unopposed rationale)", () => {
    const rows = soloPickRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_id).toBeTruthy(); // the pipeline-generated candidate id
    expect(rows[0]?.suggestion_text).toBe("build a snake game");
    expect(rows[0]?.decision).toBe("suggestion"); // candidate kind recorded in decision
    expect(rows[0]?.rationale).toContain("single-suggestion auto-build");
  });

  it("NO vote round was ever opened for the lone candidate (zero rounds rows, no round-open beat)", () => {
    expect(roundCount(app)).toBe(0);
    expect(sent.some((m) => m.startsWith("Voting is OPEN"))).toBe(false);
  });

  it("NO chaos_pick and NO round_closed rows were written (distinct from vote/chaos)", () => {
    expect(listAuditRecords(app.db, { limit: 50, eventType: "chaos_pick" })).toHaveLength(0);
    expect(listAuditRecords(app.db, { limit: 50, eventType: "round_closed" })).toHaveLength(0);
  });

  it("the candidate built through the SAME winner rail: one agent run, queue drained, pool empty", () => {
    expect(runner.specs).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(app.pool.list()).toHaveLength(0);
    // Same-winner-rail: build_history provenance reads "vote" by design; the
    // true origin is the solo_pick audit row above.
    const history = listBuildHistory(app.db, { limit: 10 });
    expect(history.some((h) => h.title === "build a snake game" && h.provenance === "vote")).toBe(
      true,
    );
  });

  it("the distinct solo build beat was narrated (never the chaos or vote copy)", () => {
    expect(sent.some((m) => m === 'Only one idea in — building it: "build a snake game".')).toBe(
      true,
    );
    expect(sent.some((m) => m.startsWith("Chaos picked:"))).toBe(false);
  });
});
