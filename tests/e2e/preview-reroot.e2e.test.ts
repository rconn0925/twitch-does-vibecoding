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
const resultFailed = { type: "result", subtype: "error_max_turns", is_error: true };

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

/**
 * quick-260717-093: the string an app's marker-aware fakeClassifier rejects.
 * It only ever appears inside a "comp02"-released build's Write batch — never
 * in intake suggestion text — so intake stays approved while the in-flight
 * COMP-02 output re-screen rejects exactly that batch (D3-07 driving pattern).
 */
const COMP02_MARKER = "XX-COMP02-REJECT-MARKER-093-XX";

/**
 * quick-260716-tqz GATED runner: like recordingRunner, but each build's async
 * generator AWAITS a per-build deferred between the write batch and the result
 * message — the build hangs mid-flight (machine BUILD_IN_PROGRESS, stream
 * open) until the test calls releaseNext(). A queue of outcomes means
 * sequential builds each gate deterministically, and an early releaseNext()
 * (before the generator reaches its gate) parks the outcome for pickup.
 *
 * quick-260717-093 adds the "comp02" outcome: the released build yields ONE
 * more Write batch carrying COMP02_MARKER — a marker-aware fakeClassifier
 * rejects it in-flight, finalizing the build `refused` (the live 2026-07-16
 * 20:25 twitch-clone incident path).
 */
function gatedRunner() {
  type Outcome = "success" | "failed" | "comp02";
  const specs: AgentRunSpec[] = [];
  const waiters: Array<(outcome: Outcome) => void> = [];
  const parked: Outcome[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      return (async function* () {
        yield writeBatch("index.html", "<b>hi</b>") as never;
        const outcome = await new Promise<Outcome>((resolve) => {
          const queued = parked.shift();
          if (queued !== undefined) resolve(queued);
          else waiters.push(resolve);
        });
        if (outcome === "comp02") {
          // The in-flight screen rejects this batch and breaks out of the
          // stream; the trailing success result is unreachable by design (it
          // only ever runs if the rejection seam is broken).
          yield writeBatch("evil.html", COMP02_MARKER) as never;
          yield resultSuccess as never;
          return;
        }
        yield (outcome === "success" ? resultSuccess : resultFailed) as never;
      })();
    },
  };
  const releaseNext = (outcome: Outcome = "success"): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(outcome);
    else parked.push(outcome);
  };
  return { runner, specs, releaseNext };
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

  // quick-260716-tqz: this pin is deliberately TIMING-AGNOSTIC — it asserts
  // only that by the time the project-switch's NEW build completes, exactly one
  // reroot landed at the rotated dir. WHEN it fires (holdover: at done, never
  // at rotation) is pinned by the dedicated HOLDOVER describe below.
  it("PROJECT-SWITCH (confirmed ship): by build completion, the preview is rooted at the rotated dir", async () => {
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

/**
 * quick-260716-tqz PREVIEW HOLDOVER: during a project-switch build the OBS
 * LIVE BUILD slot must keep serving the PREVIOUS project's directory for the
 * ENTIRE build (no STANDING BY / empty-listing window — live incident
 * 2026-07-16 ~20:2x, gen-8), rerooting exactly once the moment the new build
 * finalizes done. quick-260717-093 (D093-4) SUPERSEDES the tqz "failed/skipped
 * switch builds never reroot" pins: the on-screen outcome is unchanged (the
 * previous project stays visible) but the mechanism inverts — those teardown
 * paths now reroot AT THE HOLDOVER DIR (the sandbox teardown killed the dev
 * server; resurrection at the held-over generation brings the previous project
 * back). The holdover stays armed; only a later successful done discharges it.
 * Throughout the holdover window the overlay playUrl shows the PREVIOUS
 * project's URL — what viewers actually see on the preview.
 */
describe("preview HOLDOVER e2e (quick-260716-tqz): previous project stays live until the new build completes", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
  const sandbox = previewSandbox();
  const pub = recordingPublisher();
  let runner: ReturnType<typeof gatedRunner>;
  let app: AppHandle;
  let chatter = 500;

  /** Pool one text via a fresh chatter (avoids intake cooldown/cap). */
  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  /** The PERSISTENT phase-banner play link (build-flow e2e's fetchPlayUrl shape). */
  const fetchPlayUrl = async (): Promise<string | null> => {
    const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
    const state = (await res.json()) as { playUrl: string | null };
    return state.playUrl ?? null;
  };

  /** Seed the durable project_repos routing row the playUrl source reads. */
  const seedRepoRow = (generation: number, repoName: string): void => {
    app.db
      .prepare("INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)")
      .run(generation, repoName, Date.now());
  };

  beforeAll(async () => {
    runner = gatedRunner();
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
    // Drain any still-gated generators so close() never waits on the WR-05
    // drain bound (a "failed" release at most parks a retry/skip decision).
    for (let i = 0; i < 4; i += 1) runner.releaseNext("failed");
    await app.close();
  });

  it("HOLDOVER CORE: mid-build NO reroot + previous playUrl; done-time reroot at the new gen dir", async () => {
    await until(() => sandbox.starts.length === 1); // boot reroot at app-1

    // Make gen 1 an ACTIVE project (done build) with a durable repo row.
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 1);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    seedRepoRow(1, "counter-app");
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/counter-app/");

    const startsBefore = sandbox.starts.length;

    // Project-switch winner: rotation happens, the NEW build gates mid-flight.
    say("!build a brand new app");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => runner.specs.length === 2); // new build in flight (gated)

    // (a) the rotation DID happen — publish/ship semantics untouched.
    expect(workspaceGeneration(app)).toBe(2);
    // (b) NO reroot at rotation time — the previous project keeps serving.
    expect(sandbox.starts).toHaveLength(startsBefore);
    // (c) playUrl still the PREVIOUS project's URL (matches what viewers see).
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/counter-app/");

    // Release → done → exactly ONE new stop+start pair at the NEW gen dir.
    seedRepoRow(2, "brand-new-app");
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-2", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    // playUrl flipped off the gen-1 URL to the new generation's row.
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");
  });

  it("FAILED project-switch build: no reroot until the decision resolves; skip reroots at the HOLDOVER dir, holdover stays armed (D093-4)", async () => {
    const startsBefore = sandbox.starts.length;

    say("!build another new app");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => runner.specs.length === 3); // attempt 1 gated
    expect(workspaceGeneration(app)).toBe(3);
    expect(sandbox.starts).toHaveLength(startsBefore);
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");

    // Fail attempt 1 → the D3-09 auto-retry gates attempt 2 → fail it too →
    // the build freezes a retry/skip decision (machine stays BUILD_IN_PROGRESS).
    // The decision freeze is NOT a teardown — no reroot yet (D093-2).
    runner.releaseNext("failed");
    await until(() => runner.specs.length === 4); // auto-retry attempt gated
    runner.releaseNext("failed");
    await until(() => app.orchestrator?.snapshot()?.stage === "failed");
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore);
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");

    // Resolve the frozen decision via the existing skip route: quick-260717-093
    // (D093-4, superseding the tqz "no reroot" pin) — the teardown resurrection
    // reroots exactly once AT THE HOLDOVER DIR (app-2: the previous project
    // comes back on screen), and the holdover stays armed (playUrl unchanged).
    const taskId = app.orchestrator?.snapshot()?.taskId ?? "";
    app.orchestrator?.skipTask(taskId);
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-2", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");
  });

  it("RECOVERY: the next successful done build discharges the holdover — reroot at the current gen dir", async () => {
    const startsBefore = sandbox.starts.length;
    seedRepoRow(3, "fresh-third-app");

    // A suggest-kind tweak on the (still-unseen) gen 3.
    say("!suggest add a splash of color");
    say("!suggest filler four");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 5); // gated mid-flight

    // Mid-flight the holdover STILL governs playUrl: the gen-3 row exists but
    // the overlay keeps showing the previous project's URL until done.
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");

    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-3", port: 5555 });
    // The holdover is cleared: playUrl re-derives from workspace.generation().
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/fresh-third-app/");
  });

  it("holdover ABSENT: a plain done suggest build re-roots NOTHING (discharge is a strict no-op)", async () => {
    const startsBefore = sandbox.starts.length;

    say("!suggest one more tweak");
    say("!suggest filler five");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 6);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore);
  });
});

/**
 * quick-260717-093 TEARDOWN RESURRECTION: the app-under-construction preview
 * must NEVER drop to "Between builds" because a build was refused/failed/
 * aborted (Ross's verbatim directive 2026-07-17). Every non-done teardown that
 * kills the WSL sandbox kills the 5555 dev server with it — the orchestrator
 * now resurrects it serving `previewHoldoverGeneration ?? workspace.generation()`:
 * a refused TWEAK brings the CURRENT project back; a refused PROJECT-SWITCH
 * under a holdover brings the PREVIOUS project back (holdover stays armed).
 * While HALTED nothing reroots; leaving HALTED fires exactly one holdover-aware
 * reroot. A done build behaves exactly as before (tqz discharge semantics).
 */
describe("preview TEARDOWN RESURRECTION e2e (quick-260717-093)", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
  const sandbox = previewSandbox();
  const pub = recordingPublisher();
  let runner: ReturnType<typeof gatedRunner>;
  let app: AppHandle;
  let chatter = 900;

  /** Pool one text via a fresh chatter (avoids intake cooldown/cap). */
  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  const fetchPlayUrl = async (): Promise<string | null> => {
    const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
    const state = (await res.json()) as { playUrl: string | null };
    return state.playUrl ?? null;
  };

  const seedRepoRow = (generation: number, repoName: string): void => {
    app.db
      .prepare("INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)")
      .run(generation, repoName, Date.now());
  };

  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    runner = gatedRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      // Marker-aware classifier: intake + pre-build screens approve (no marker
      // in suggestion text); the in-flight COMP-02 output re-screen rejects
      // exactly the "comp02"-released build's marker batch.
      fakeClassifier: (candidate) =>
        candidate.text.includes(COMP02_MARKER)
          ? { decision: "rejected", category: "malware", rationale: "test: marker rejected" }
          : approved,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
      galleryPublisher: pub.publisher,
    });
  });

  afterAll(async () => {
    // Drain any still-gated generators so close() never waits on the WR-05
    // drain bound.
    for (let i = 0; i < 8; i += 1) runner.releaseNext("failed");
    await app.close();
  });

  it("refused TWEAK build (COMP-02 in-flight): exactly ONE resurrection stop+start at the CURRENT gen dir", async () => {
    await until(() => sandbox.starts.length === 1); // boot reroot at app-1

    // Make gen 1 an ACTIVE project (done build) with a durable repo row.
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 1);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    seedRepoRow(1, "counter-app");
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/counter-app/");

    const startsBefore = sandbox.starts.length;
    const stopsBefore = sandbox.stops.length;

    // A tweak build on the scaffolded current gen, rejected in flight by the
    // second safety check — the exact live 2026-07-16 20:25 incident shape.
    say("!suggest add a scoreboard");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 2); // gated mid-flight
    runner.releaseNext("comp02");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);

    // Exactly ONE new stop+start pair, rooted at the CURRENT generation dir —
    // the current project stays visible, never "Between builds".
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-1", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    expect(sandbox.stops).toHaveLength(stopsBefore + 1);
    // playUrl unchanged — no generation moved.
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/counter-app/");
  });

  it("refused PROJECT-SWITCH under holdover: resurrection at the HOLDOVER dir, holdover stays armed; a later done discharges it", async () => {
    const startsBefore = sandbox.starts.length;

    // Project-switch winner: shipThenRotate rotates to gen 2 + arms the holdover.
    say("!build a brand new app");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => runner.specs.length === 3); // new build in flight (gated)
    expect(workspaceGeneration(app)).toBe(2);

    // In-flight refusal → the resurrection lands at the HOLDOVER dir (app-1):
    // the PREVIOUS project comes back on screen (REPLACES the tqz "no reroot
    // on a failed switch" expectation per D093-4).
    runner.releaseNext("comp02");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-1", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    // The holdover is STILL armed: playUrl stays the gen-1 URL.
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/counter-app/");

    // A later successful done build discharges it: single reroot at the ACTIVE
    // gen dir, playUrl flips — tqz discharge semantics preserved.
    seedRepoRow(2, "brand-new-app");
    say("!suggest start the new app properly");
    say("!suggest filler four");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 4);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 2);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-2", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 2);
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");
  });

  it("HALT: no reroot while HALTED; leaving HALTED fires exactly ONE reroot; a pre-halt holdover survives recovery", async () => {
    const startsBefore = sandbox.starts.length;

    // Arm a holdover: project-switch rotates to gen 3 (holdover = gen 2), the
    // new build gates mid-flight.
    say("!build yet another app");
    say("!suggest filler five");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "project-switch");
    await until(() => runner.specs.length === 5);
    expect(workspaceGeneration(app)).toBe(3);

    // HALT mid-build, then release the gate so the aborted turn unwinds into
    // finalizeAborted — while HALTED the preview may stay dark: NO reroot.
    const haltRes = await postJson("/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    runner.releaseNext("success"); // outcome ignored — the abort wins
    await until(() => app.orchestrator?.snapshot() === null);
    await sleep(150); // give any (incorrect) reroot room to fire
    expect(sandbox.starts).toHaveLength(startsBefore);

    // Recover: leaving HALTED fires exactly ONE holdover-aware reroot — the
    // holdover (gen 2) is STILL armed, so the resurrection serves app-2.
    const recoverRes = await postJson("/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).toBe("IDLE");
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-2", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    // Holdover survived recovery: playUrl stays the previous generation's.
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/brand-new-app/");
  });

  it("done path unchanged: holdover discharge reroots exactly ONCE (no double); a plain done build reroots NOTHING", async () => {
    // (a) The armed holdover (gen 2, from the halt test) discharges on the
    // next done build — exactly ONE reroot at the active gen dir, never two
    // (the teardown hook must not also fire on done).
    const startsBefore = sandbox.starts.length;
    seedRepoRow(3, "third-app");
    say("!suggest fill in the third app");
    say("!suggest filler six");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 6);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)).toEqual({ dir: "/home/builder/projects/app-3", port: 5555 });
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore + 1);
    expect(await fetchPlayUrl()).toBe("https://twitchvibecodes.github.io/third-app/");

    // (b) A plain successful tweak build (no holdover) produces ZERO
    // resurrection reroots.
    const startsBefore2 = sandbox.starts.length;
    say("!suggest one more tweak");
    say("!suggest filler seven");
    await until(() => app.pool.list().length === 2);
    voteKindToVictory(app, "suggestion");
    await until(() => runner.specs.length === 7);
    runner.releaseNext("success");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await sleep(100);
    expect(sandbox.starts).toHaveLength(startsBefore2);
  });
});
