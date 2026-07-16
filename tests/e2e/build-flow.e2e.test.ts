import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditRecords, listBuildHistory } from "../../src/audit/record.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import type { ChatEventSource } from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type {
  GalleryPublisher,
  PublishInput,
  PublishResult,
} from "../../src/orchestrator/gallery-publisher.js";
import { translate } from "../../src/orchestrator/progress-events.js";
import type { AgentRunner, DevServerProbe, SandboxAdapter } from "../../src/orchestrator/types.js";
import { BUILD_STAGE_CHANGED } from "../../src/overlay/server.js";
import type { PipelineStage } from "../../src/shared/types.js";

/**
 * MVP e2e (plan 03-06, reshaped by quick-0iu straight-to-build): the FULL
 * happy-path slice, GREEN.
 *
 *   pooled winner → funnel → machine enters BUILD_IN_PROGRESS → COMP-02
 *   re-screens the winning SUGGESTION text and approves → the SINGLE sandboxed
 *   build turn runs → building → done → machine returns to IDLE; the overlay
 *   reflects the live stage; a refused build narrates `refused` and never
 *   silently stalls. No research/plan turns exist anymore.
 *
 * Driven against createApp's injected-fake seams (fake AgentRunner, fake
 * SandboxAdapter, fake DevServerProbe, fakeClassifier) — NO real WSL2 / query()
 * / network. The fakes travel the IDENTICAL composition path the entrypoint's
 * real SDK/WSL2 adapters use (03-06 wiring), so this proves the production wiring
 * without src edits.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

// ── SDK-ish message fixtures (plain objects; no SDK type import) ──────────────
const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const modelRefusal = { subtype: "model_refusal_no_fallback" };

const PIPELINE_FIXTURES: unknown[] = [
  { hook_event_name: "SubagentStart", agent_type: "build" },
  { type: "result", subtype: "success", is_error: false },
];

/** A fake AgentRunner whose single sandboxed BUILD turn blocks on a gate the test releases. */
function gatedHappyRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let specsConsumed = 0;
  const runner: AgentRunner = {
    run() {
      specsConsumed += 1;
      return (async function* () {
        // The one sandboxed build turn — pause so the test can observe `building`.
        await gate;
        yield writeBatch("index.html", "<button id=b>count: 0</button>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return { runner, release: () => release(), specsConsumed: () => specsConsumed };
}

/** A fake AgentRunner whose BUILD turn refuses (model refusal). */
function refusingRunner(): AgentRunner {
  return {
    run() {
      return (async function* () {
        yield modelRefusal as never;
      })();
    },
  };
}

const fakeSandbox = (): SandboxAdapter =>
  ({
    spawn: () => ({}) as never,
    terminate: async () => {},
  }) as unknown as SandboxAdapter;

const fakeProbe: DevServerProbe = { reachable: async () => false };

const approved = { decision: "approved" as const, category: null, rationale: "test: approved" };

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

/** Seed two approved candidates, open a round, vote option 1, and close it. */
function drivePooledWinner(app: AppHandle): void {
  app.pool.add(
    {
      id: "cand-1",
      source: "chat",
      kind: "suggestion",
      twitchUsername: "a",
      text: "make a counter app",
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

async function fetchBuildStage(port: number): Promise<PipelineStage | null> {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  const state = (await res.json()) as {
    buildStatus: { stage: PipelineStage; title: string } | null;
  };
  return state.buildStatus?.stage ?? null;
}

describe("build-flow e2e (MVP happy path) — 03-06 GREEN", () => {
  let app: AppHandle;
  const stagesSeen: PipelineStage[] = [];
  let midMachineMode = "";
  let midBuildStage: PipelineStage | null = null;
  let midBuildTitle: string | undefined;
  let classifyIdsAtGate: string[] = [];
  let finalMachineMode = "";

  const recordedIds: string[] = [];
  /** (id, text, runner-specs-consumed-at-call) per classify call. */
  const recordedCalls: Array<{ id: string; text: string; specsAtCall: number }> = [];
  let gated: ReturnType<typeof gatedHappyRunner>;

  beforeAll(async () => {
    gated = gatedHappyRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (c) => {
        recordedIds.push(c.id);
        recordedCalls.push({ id: c.id, text: c.text, specsAtCall: gated.specsConsumed() });
        return { decision: "approved", category: null, rationale: "test: approved" };
      },
      agentRunner: gated.runner,
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed — agentRunner wiring is broken");
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) stagesSeen.push(snap.stage);
    });

    // Fire the winner → the winner hook synchronously enters BUILD_IN_PROGRESS.
    drivePooledWinner(app);
    midMachineMode = app.machine.mode;

    // The build turn blocks on the gate: observe the live `building` stage on
    // the OVERLAY surface (buildStatus is an overlay field, not the console's).
    await waitUntil(() => stagesSeen.includes("building"));
    midBuildStage = await fetchBuildStage(app.overlay.port);
    const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
    const state = (await res.json()) as { buildStatus: { title: string } | null };
    midBuildTitle = state.buildStatus?.title;
    classifyIdsAtGate = [...recordedIds];

    // Release the build → run to done → back to IDLE.
    gated.release();
    await waitUntil(() => app.machine.mode === "IDLE");
    finalMachineMode = app.machine.mode;
  });

  afterAll(async () => {
    await app.close();
  });

  it("encodes the observable stage sequence the fake AgentRunner emits (build→done)", () => {
    const stages = PIPELINE_FIXTURES.map((m) => translate(m)).filter((s) => s !== null);
    expect(stages).toEqual(["building", "done"]);
  });

  it("boots the full app harness the orchestrator slice plugs into (createApp injected-fake seam)", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    expect(res.status).toBe(200);
  });

  it("consumes a QueuedTask and transitions the machine to BUILD_IN_PROGRESS (03-06)", () => {
    expect(midMachineMode).toBe("BUILD_IN_PROGRESS");
  });

  it("goes STRAIGHT to build: the FIRST stage seen is 'building' — no researching/planning ever emits", () => {
    expect(stagesSeen[0]).toBe("building");
    expect(stagesSeen).not.toContain("researching");
    expect(stagesSeen).not.toContain("planning");
  });

  it("COMP-02 re-screens the winning SUGGESTION text BEFORE any runner spec is consumed (03-04 / quick-0iu)", () => {
    // The pre-build re-screen ran (a `-plan` candidate hit the gate) with the
    // raw suggestion text as input, BEFORE the AgentRunner consumed any spec —
    // and no `-output` in-flight re-screen had happened yet at the gate.
    const preScreen = recordedCalls.find((c) => c.id.endsWith("-plan"));
    expect(preScreen).toBeDefined();
    expect(preScreen?.text).toBe("make a counter app");
    expect(preScreen?.specsAtCall).toBe(0);
    expect(classifyIdsAtGate.some((id) => id.endsWith("-plan"))).toBe(true);
    expect(classifyIdsAtGate.some((id) => id.endsWith("-output"))).toBe(false);
    const rows = listAuditRecords(app.db, { limit: 20, eventType: "comp02_decision" });
    expect(rows.some((r) => r.decision === "approved")).toBe(true);
  });

  it("emits building → done and returns the machine to IDLE (03-06)", () => {
    expect(stagesSeen).toEqual(["building", "done"]);
    expect(finalMachineMode).toBe("IDLE");
  });

  it("overlay GET /api/state reflects the current pipeline stage (PRES-02/04)", () => {
    expect(midBuildStage).toBe("building");
    expect(midBuildTitle).toBe("make a counter app");
  });

  it("persists a build_history row with provenance 'vote' — the onWinnerQueued driver threads it (HIST-01)", () => {
    const rows = listBuildHistory(app.db, { limit: 20 });
    const entry = rows.find((r) => r.title === "make a counter app");
    expect(entry).toBeDefined();
    expect(entry?.provenance).toBe("vote");
    expect(entry?.result).toBe("built");
  });
});

describe("build-flow e2e (gallery publish wiring) — done-only, failure-isolated (quick-22l)", () => {
  /** Instantly-done runner: one Write batch then success — no gate needed. */
  const doneRunner = (): AgentRunner => ({
    run() {
      return (async function* () {
        yield writeBatch("index.html", "<p>hi</p>") as never;
        yield resultSuccess as never;
      })();
    },
  });

  function recordingPublisher(result?: () => Promise<PublishResult>): {
    publisher: GalleryPublisher;
    calls: PublishInput[];
  } {
    const calls: PublishInput[] = [];
    const publisher: GalleryPublisher = {
      revertLast: () =>
        Promise.resolve({ status: "failed", commitHash: null, detail: "unused in this suite" }),
      publishNow(input) {
        calls.push(input);
        return result
          ? result()
          : Promise.resolve({
              status: "published",
              commitHash: "fakehash",
              detail: "test",
            } satisfies PublishResult);
      },
    };
    return { publisher, calls };
  }

  it("a done build invokes publishNow ONCE with { generation, title: task.text, taskId } and audits the attempt", async () => {
    const { publisher, calls } = recordingPublisher();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => calls.length > 0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ generation: 1, title: "make a counter app" });
    expect(typeof calls[0]?.taskId).toBe("string");
    // One gallery_publish audit row per attempt (T-22l-06).
    await waitUntil(
      () => listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" }).length > 0,
    );
    const rows = listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" });
    expect(rows[0]?.decision).toBe("published");

    await app.close();
  });

  it("a REJECTING publishNow leaves the app healthy: build finalized done, no unhandled rejection", async () => {
    const { publisher, calls } = recordingPublisher(() =>
      Promise.reject(new Error("publisher exploded")),
    );
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => calls.length > 0);

    // The build finalized done despite the publisher rejection.
    const rows = listBuildHistory(app.db, { limit: 10 });
    expect(rows.some((r) => r.result === "built")).toBe(true);
    expect(app.machine.mode).toBe("IDLE");
    // Give the rejected promise's .catch a tick to run, then close cleanly.
    await new Promise((r) => setTimeout(r, 20));
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("no galleryPublisher injected → the done path stays inert (no gallery_publish rows)", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await new Promise((r) => setTimeout(r, 20));

    expect(listAuditRecords(app.db, { limit: 10, eventType: "gallery_publish" })).toHaveLength(0);
    await app.close();
  });
});

describe("build-flow e2e (playable announce) — publish-confirmed play link + overlay playable (quick-260716-g8p)", () => {
  const doneRunner = (): AgentRunner => ({
    run() {
      return (async function* () {
        yield writeBatch("index.html", "<p>hi</p>") as never;
        yield resultSuccess as never;
      })();
    },
  });

  /** No-op chat source: the chat block composes (narrator exists) — nothing drives messages. */
  const noopChatSource = (): ChatEventSource =>
    ({
      onChannelChatMessage: () => ({}),
      onUserSocketReady: () => ({}),
      onUserSocketDisconnect: () => ({}),
      start() {},
      stop() {},
    }) as unknown as ChatEventSource;

  function capturingChatSink(): { sent: string[]; sink: ChatMessageSink } {
    const sent: string[] = [];
    return {
      sent,
      sink: {
        sendChatMessage(_broadcasterId: string, text: string): Promise<unknown> {
          sent.push(text);
          return Promise.resolve({});
        },
      },
    };
  }

  const playSends = (sent: string[]): string[] => sent.filter((m) => m.startsWith("Play it"));

  async function fetchPlayable(port: number): Promise<{ url: string } | null> {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    const state = (await res.json()) as { playable: { url: string } | null };
    return state.playable;
  }

  /** The PERSISTENT phase-banner play link (quick-260716-ko2) — distinct from the transient `playable`. */
  async function fetchPlayUrl(port: number): Promise<string | null> {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    const state = (await res.json()) as { playUrl: string | null };
    return state.playUrl ?? null;
  }

  /** The announce reads the DURABLE project_repos routing row — seed it like the real publisher would. */
  function seedRepoRow(app: AppHandle, repoName: string): void {
    app.db
      .prepare(
        "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (1, @repoName, 1)",
      )
      .run({ repoName });
  }

  it("published + awaitPagesBuilt 'built' → exactly ONE 'Play it now:' send AND the overlay playable carries the slug URL", async () => {
    const { sent, sink } = capturingChatSink();
    const publisher: GalleryPublisher = {
      publishNow: () =>
        Promise.resolve({ status: "published", commitHash: "hash", detail: "test" }),
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
      awaitPagesBuilt: async () => "built",
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    seedRepoRow(app, "counter-app");

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => playSends(sent).length > 0);

    expect(playSends(sent)).toEqual([
      "Play it now: https://twitchvibecodes.github.io/counter-app/",
    ]);
    expect(await fetchPlayable(app.overlay.port)).toEqual({
      url: "https://twitchvibecodes.github.io/counter-app/",
    });
    await app.close();
  });

  it("awaitPagesBuilt 'timeout' → the honest '(going live in ~1 min)' variant posts", async () => {
    const { sent, sink } = capturingChatSink();
    const publisher: GalleryPublisher = {
      publishNow: () =>
        Promise.resolve({ status: "published", commitHash: "hash", detail: "test" }),
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
      awaitPagesBuilt: async () => "timeout",
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    seedRepoRow(app, "counter-app");

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => playSends(sent).length > 0);

    expect(playSends(sent)).toEqual([
      "Play it: https://twitchvibecodes.github.io/counter-app/ (going live in ~1 min)",
    ]);
    await app.close();
  });

  it("a FAILED publish → ZERO play-link sends AND overlay playable stays null (the NEVER-on-failed gate)", async () => {
    const { sent, sink } = capturingChatSink();
    let published = false;
    const publisher: GalleryPublisher = {
      publishNow: () => {
        published = true;
        return Promise.resolve({ status: "failed", commitHash: null, detail: "boom" });
      },
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
      awaitPagesBuilt: async () => "built",
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    seedRepoRow(app, "counter-app");

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => published);
    // Give any (wrong) announce path a beat to run before asserting silence.
    await new Promise((r) => setTimeout(r, 50));

    expect(playSends(sent)).toEqual([]);
    expect(await fetchPlayable(app.overlay.port)).toBeNull();
    await app.close();
  });

  it("a fake WITHOUT awaitPagesBuilt announces immediately (absent method ⇒ ready)", async () => {
    const { sent, sink } = capturingChatSink();
    const publisher: GalleryPublisher = {
      publishNow: () =>
        Promise.resolve({ status: "published", commitHash: "hash", detail: "test" }),
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    seedRepoRow(app, "counter-app");

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => playSends(sent).length > 0);

    expect(playSends(sent)).toEqual([
      "Play it now: https://twitchvibecodes.github.io/counter-app/",
    ]);
    await app.close();
  });

  it("playUrl (quick-260716-ko2): the PERSISTENT field carries the active generation's galleryPlayUrl even OUTSIDE the done beat; null with no project_repos row", async () => {
    const { sent, sink } = capturingChatSink();
    const publisher: GalleryPublisher = {
      publishNow: () =>
        Promise.resolve({ status: "published", commitHash: "hash", detail: "test" }),
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
      awaitPagesBuilt: async () => "built",
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    seedRepoRow(app, "counter-app");

    // PERSISTENT, pull-based: the durable project_repos row + active generation
    // alone compose the URL — visible on the FIRST state read, no build-done
    // beat required ("set it now for this voidfarer project").
    expect(await fetchPlayUrl(app.overlay.port)).toBe(
      "https://twitchvibecodes.github.io/counter-app/",
    );

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => playSends(sent).length > 0);

    // … and still present AFTER the build/announce ran — the field never
    // expires with the transient 8s done beat.
    expect(await fetchPlayUrl(app.overlay.port)).toBe(
      "https://twitchvibecodes.github.io/counter-app/",
    );
    await app.close();

    // No project_repos row for the active generation → null (no line, no
    // empty shell — the fail-closed absent state).
    const bare = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
    });
    expect(await fetchPlayUrl(bare.overlay.port)).toBeNull();
    await bare.close();
  });

  it("a confirmed publish with NO project_repos row (EMPTY-01 skip) announces nothing", async () => {
    const { sent, sink } = capturingChatSink();
    let published = false;
    const publisher: GalleryPublisher = {
      publishNow: () => {
        published = true;
        return Promise.resolve({ status: "no-changes", commitHash: null, detail: "skip" });
      },
      revertLast: () => Promise.resolve({ status: "failed", commitHash: null, detail: "unused" }),
      awaitPagesBuilt: async () => "built",
    };
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => approved,
      chatSource: noopChatSource(),
      chatSink: sink,
      agentRunner: doneRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
      galleryPublisher: publisher,
    });
    // NO seedRepoRow: nothing was ever published for this generation.

    drivePooledWinner(app);
    await waitUntil(() => app.machine.mode === "IDLE");
    await waitUntil(() => published);
    await new Promise((r) => setTimeout(r, 50));

    expect(playSends(sent)).toEqual([]);
    expect(await fetchPlayable(app.overlay.port)).toBeNull();
    await app.close();
  });
});

describe("build-flow e2e (refusal) — never silent, freezes a decision (BUILD-03 / D3-09)", () => {
  it("a refused build emits `refused`, freezes a streamer decision (BUILD_IN_PROGRESS), and skip returns to IDLE", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: () => ({ decision: "approved", category: null, rationale: "ok" }),
      agentRunner: refusingRunner(),
      sandboxAdapter: fakeSandbox(),
      devServerProbe: fakeProbe,
    });
    const orch = app.orchestrator;
    if (!orch) throw new Error("orchestrator was not composed");
    const seen: PipelineStage[] = [];
    orch.on(BUILD_STAGE_CHANGED, () => {
      const snap = orch.snapshot();
      if (snap) seen.push(snap.stage);
    });

    drivePooledWinner(app);
    // D3-09: a refusal is NEVER a silent auto-IDLE — it freezes a retry/skip
    // decision with the machine still BUILD_IN_PROGRESS.
    await waitUntil(() => seen.includes("refused"));

    expect(seen.at(-1)).toBe("refused");
    expect(seen).not.toContain("done");
    expect(app.machine.mode).toBe("BUILD_IN_PROGRESS");
    // Audit: the refusal is a first-class recorded event (D3-08), never silent.
    const rows = listAuditRecords(app.db, { limit: 20, eventType: "build_refused" });
    expect(rows.length).toBeGreaterThan(0);

    // The streamer resolves the frozen build via skip → clean return to IDLE.
    orch.skipTask(orch.snapshot()?.taskId ?? "");
    await waitUntil(() => app.machine.mode === "IDLE");
    expect(orch.snapshot()).toBeNull();

    await app.close();
  });
});
