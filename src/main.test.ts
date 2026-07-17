/**
 * quick-260717-2gr (D-08) — createApp-level tests for the held-verdict PARK
 * composition: the onHeldForReview handler (review row + parked registry +
 * 120s auto-decline timer + P4 preview-taint semantics), the console
 * approve/reject routing through the late-bound heldBuilds seam, and the
 * REVIEW_HOLD_TIMEOUT_SECONDS expiry knob.
 *
 * Everything is injected fakes on the IDENTICAL createApp composition path
 * production uses (the preview-reroot / save-and-close e2e harness idiom) —
 * no real WSL2 / query() / network.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listAuditRecords, listBuildHistory } from "./audit/record.js";
import type { ChatMessageSink } from "./ingestion/chat-sender.js";
import type { ChatEventSource, ChatMessageEvent } from "./ingestion/twitch-chat.js";
import { createApp } from "./main.js";
import type {
  AgentRunner,
  AgentRunSpec,
  DevServerProbe,
  SandboxAdapter,
} from "./orchestrator/types.js";
import type { GateResult, SuggestionCandidate } from "./shared/types.js";
import { getReview, listPending } from "./state-machine/review-queue.js";

// Deterministic, fast supervisor cycles: zero settle wait.
process.env.PREVIEW_DEV_SERVER_SETTLE_MS = "0";

type AppHandle = Awaited<ReturnType<typeof createApp>>;

/** Marker the fakeClassifier HOLDS when it appears in a `-plan` candidate. */
const PRE_HOLD_MARKER = "XX-PREHOLD-2GR-XX";
/** Marker the fakeClassifier HOLDS when it appears in an `-output` batch. */
const MID_HOLD_MARKER = "XX-MIDHOLD-2GR-XX";
const HOLD_RATIONALE = "test: gray-zone clone concern";

/** Marker-aware classifier: intake approves everything; COMP-02 holds markers. */
const markerClassifier = (candidate: SuggestionCandidate): GateResult => {
  if (candidate.id.endsWith("-plan") && candidate.text.includes(PRE_HOLD_MARKER)) {
    return { decision: "held-for-review", category: "ip-infringement", rationale: HOLD_RATIONALE };
  }
  if (candidate.id.endsWith("-output") && candidate.text.includes(MID_HOLD_MARKER)) {
    return { decision: "held-for-review", category: "ip-infringement", rationale: HOLD_RATIONALE };
  }
  return { decision: "approved", category: null, rationale: "test: approved" };
};

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };
const resultFailed = { type: "result", subtype: "error_max_turns", is_error: true };

/**
 * Runner that emits the MID_HOLD_MARKER batch for every "flagme" build EXCEPT
 * an approved continuation (its prompt carries the host-authored note) — so
 * the incident build parks and the streamer-approved resume runs to done.
 * "failme" builds fail (the teardown driver for the taint-guard rows).
 */
function markerRunner() {
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      return (async function* () {
        if (spec.userPrompt.includes("failme")) {
          yield resultFailed as never;
          return;
        }
        if (
          spec.userPrompt.includes("flagme") &&
          !spec.userPrompt.includes("reviewed and approved")
        ) {
          yield writeBatch("styles.css", `body { /* ${MID_HOLD_MARKER} */ }`) as never;
          yield resultSuccess as never;
          return;
        }
        yield writeBatch("index.html", "<b>hi</b>") as never;
        yield resultSuccess as never;
      })();
    },
  };
  return { runner, specs };
}

/** A sandbox adapter WITH the preview lifecycle methods, recording every call. */
function previewSandbox() {
  const starts: Array<{ dir: string; port: number }> = [];
  const stops: number[] = [];
  const adapter: SandboxAdapter = {
    spawn: () => ({}) as never,
    terminate: async () => {},
    async stopPreviewDevServer(port: number) {
      stops.push(port);
    },
    async startPreviewDevServer(dir: string, port: number) {
      starts.push({ dir, port });
    },
  };
  return { adapter, starts, stops };
}

const reachableProbe: DevServerProbe = { reachable: async () => true };

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

function voteTextToVictory(app: AppHandle, text: string): string {
  app.round.startRound();
  const snap = app.round.snapshot();
  const entry = snap?.candidates.find((c) => c.candidate.text === text);
  if (!entry) throw new Error(`no pooled candidate with text ${JSON.stringify(text)}`);
  app.round.recordVote("voter-1", entry.option);
  const winnerId = entry.candidate.id;
  app.round.closeRound();
  return winnerId;
}

function poolCandidate(id: string, text: string): SuggestionCandidate {
  return {
    id,
    source: "chat",
    kind: "suggestion",
    twitchUsername: id,
    text,
    submittedAtMs: Date.now(),
  };
}

const approvedResult: GateResult = {
  decision: "approved",
  category: null,
  rationale: "test: approved",
};

function postJson(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function consoleState(app: AppHandle): Promise<{
  review: Array<{ id: number; rationale: string; expiresAtMs: number | null }>;
}> {
  const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
  return (await res.json()) as {
    review: Array<{ id: number; rationale: string; expiresAtMs: number | null }>;
  };
}

// ── mid-build hold: park + approve-resume (the 20:25:45 incident class) ──────

describe("main onHeldForReview: MID-BUILD hold parks, streamer approve resumes through dispatchBuild", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 100;
  let reviewId = 0;
  let startsAtPark = 0;

  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  beforeAll(async () => {
    runner = markerRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
    });

    // Seed: make gen 1 an ACTIVE project (done build) so the hold is a TWEAK.
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "make the first app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    startsAtPark = sandbox.starts.length;

    // THE INCIDENT SHAPE: a tweak build whose Write batch gets HELD in flight.
    say("!suggest flagme add a scoreboard");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme add a scoreboard");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    reviewId = listPending(app.db)[0]?.id ?? 0;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("inserts a review row: candidate = the task, rationale = classifier rationale + '---' + flagged excerpt", () => {
    const pending = listPending(app.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe("flagme add a scoreboard");
    expect(pending[0]?.category).toBe("ip-infringement");
    expect(pending[0]?.rationale).toContain(HOLD_RATIONALE);
    expect(pending[0]?.rationale).toContain("---");
    expect(pending[0]?.rationale).toContain(MID_HOLD_MARKER);
  });

  it("writes the park audit chain (comp02 held → build_parked_for_review) and leaves NO history row", () => {
    const comp02 = listAuditRecords(app.db, { limit: 20, eventType: "comp02_decision" });
    expect(comp02.some((r) => r.decision === "held-for-review")).toBe(true);
    expect(
      listAuditRecords(app.db, { limit: 20, eventType: "build_parked_for_review" }),
    ).toHaveLength(1);
    expect(
      listBuildHistory(app.db, { limit: 20 }).filter((r) => r.result !== "built"),
    ).toHaveLength(0);
  });

  it("the show loop is free: machine IDLE, queue empty, and the parked task is NEVER re-picked by drain", () => {
    expect(app.machine.mode).toBe("IDLE");
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("the console state carries expiresAtMs ≈ now + 120s (the REVIEW_HOLD_TIMEOUT_SECONDS default)", async () => {
    const state = await consoleState(app);
    const item = state.review.find((r) => r.id === reviewId);
    expect(item).toBeDefined();
    const remaining = (item?.expiresAtMs ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(100_000);
    expect(remaining).toBeLessThanOrEqual(120_000);
  });

  it("P4 tweak taint: NO reroot fired at park time (the 093 resurrection is withheld)", () => {
    expect(sandbox.starts.length).toBe(startsAtPark);
  });

  it("narrates the buildHeld beat (never silent)", async () => {
    await until(() => sent.some((m) => m.includes("held for streamer review")));
  });

  it("show-loop-continues: a NEW suggestion builds normally while the item stays parked", async () => {
    const specsBefore = runner.specs.length;
    say("!suggest unrelated new tweak");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "unrelated new tweak");
    await until(() => runner.specs.length === specsBefore + 1 && app.machine.mode === "IDLE");
    // Still parked, still pending.
    expect(listPending(app.db)).toHaveLength(1);
  });

  it("the NEXT done build discharges the tweak taint: exactly one reroot at the current gen dir (P4 discharge b)", async () => {
    await until(() => sandbox.starts.length === startsAtPark + 1);
    expect(sandbox.starts.at(-1)?.dir).toBe("/home/builder/projects/app-1");
  });

  it("APPROVE via the real HTTP route: 200, resolveParked (pool untouched), continuation resumes to done", async () => {
    const specsBefore = runner.specs.length;
    const poolBefore = app.pool.list().length;
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);

    // Pool NEVER touched — the continuation dispatches directly.
    expect(app.pool.list().length).toBe(poolBefore);
    // Row resolved approved + review_resolved audit (NOT re-pooled).
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
    const resolved = listAuditRecords(app.db, { limit: 20, eventType: "review_resolved" });
    expect(resolved.some((r) => r.decision === "approved")).toBe(true);

    // The continuation ran through dispatchBuild → startBuild with the
    // mid-build resume: FULL pipeline incl. the pre-build re-screen, and the
    // prompt carries the approved-continuation note.
    await until(
      () => runner.specs.length === specsBefore + 1 && app.machine.mode === "IDLE",
      15_000,
    );
    const contSpec = runner.specs.at(-1);
    expect(contSpec?.userPrompt).toContain("flagme add a scoreboard");
    expect(contSpec?.userPrompt).toContain("reviewed and approved");
    // Original provenance preserved: the vote-origin continuation lands a
    // build_history row with provenance 'vote'.
    const history = listBuildHistory(app.db, { limit: 20 });
    const row = history.find((r) => r.title === "flagme add a scoreboard");
    expect(row?.provenance).toBe("vote");
    expect(row?.result).toBe("built");
  });

  it("narrates buildResumedFromReview on the approve-resume (calm beat)", async () => {
    await until(() => sent.some((m) => m.includes("Streamer approved")));
  });
});

// ── reject + pre-build hold + HALTED conflict ────────────────────────────────

describe("main onHeldForReview: PRE-BUILD hold, reject path, HALTED conflict", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 500;

  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  beforeAll(async () => {
    runner = markerRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
    });
    await until(() => sandbox.starts.length === 1); // boot reroot
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("a PRE-BUILD hold parks with a console row (plain rationale, no excerpt) and ZERO preview calls — the 20:25:52 bug is dead", async () => {
    const startsBefore = sandbox.starts.length;
    say(`!suggest ${PRE_HOLD_MARKER} build a casino-looking thing`);
    say("!suggest filler a");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, `${PRE_HOLD_MARKER} build a casino-looking thing`);
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE");

    const pending = listPending(app.db);
    expect(pending[0]?.rationale).toBe(HOLD_RATIONALE); // plain — no "---" excerpt
    // The runner was NEVER invoked; no preview action at all (no teardown happened).
    expect(runner.specs).toHaveLength(0);
    await sleep(50);
    expect(sandbox.starts.length).toBe(startsBefore);
  });

  it("approve of the PRE-BUILD park builds WITHOUT re-screening the same text (no -plan re-hold loop)", async () => {
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE", 15_000);
    // It built — the pre-build screen was skipped (a re-screen would re-hold
    // the marker text and never invoke the runner).
    expect(runner.specs[0]?.userPrompt).toContain(PRE_HOLD_MARKER);
    // A pre-build resume carries NO approved-continuation note (no prior output).
    expect(runner.specs[0]?.userPrompt).not.toContain("reviewed and approved");
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
  });

  it("REJECT on a parked row: resolveParked rejected + denial beat + nothing dispatched + park kept (no reroot)", async () => {
    const specsBefore = runner.specs.length;
    say(`!suggest ${PRE_HOLD_MARKER} another borderline one`);
    say("!suggest filler b");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, `${PRE_HOLD_MARKER} another borderline one`);
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE");
    const reviewId = listPending(app.db)[0]?.id ?? 0;

    const res = await postJson(app.port, `/api/review/${reviewId}/reject`, {
      reasonTag: "tos-risk",
    });
    expect(res.status).toBe(200);
    expect(getReview(app.db, reviewId)?.status).toBe("rejected");
    const resolved = listAuditRecords(app.db, { limit: 20, eventType: "review_resolved" });
    expect(resolved.some((r) => r.decision === "rejected" && r.category === "tos-risk")).toBe(true);
    // Denial beat (the SAME comp02Rejected wording — locked decision 6).
    await until(() => sent.some((m) => m.includes("didn't pass the second safety check")));
    // Nothing dispatched.
    await sleep(100);
    expect(runner.specs.length).toBe(specsBefore);
  });

  it("approve while HALTED → 409, row STAYS pending, nothing dispatched; recover → approve works (P8)", async () => {
    say("!suggest flagme make it sparkle");
    say("!suggest filler c");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme make it sparkle");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    // Captured AFTER the incident build consumed its spec — asserts the
    // APPROVE attempt dispatches nothing while HALTED.
    const specsBefore = runner.specs.length;

    const haltRes = await postJson(app.port, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");

    const approveRes = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(approveRes.status).toBe(409);
    expect(getReview(app.db, reviewId)?.status).toBe("pending");
    await sleep(50);
    expect(runner.specs.length).toBe(specsBefore);

    // Recover, then approve resumes normally.
    const recoverRes = await postJson(app.port, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    const approveRes2 = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(approveRes2.status).toBe(200);
    await until(
      () => runner.specs.length === specsBefore + 1 && app.machine.mode === "IDLE",
      15_000,
    );
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
  });
});

// ── 120s auto-decline expiry (fake timers + knob override) ───────────────────

describe("main parked-review expiry: 120s default (fake timers) + REVIEW_HOLD_TIMEOUT_SECONDS knob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function parkOne(app: AppHandle): Promise<number> {
    app.pool.add(poolCandidate("hold-1", `${PRE_HOLD_MARKER} spin to win`), approvedResult);
    app.pool.add(poolCandidate("fill-1", "filler idea"), approvedResult);
    app.round.startRound();
    const snap = app.round.snapshot();
    const entry = snap?.candidates.find((c) => c.candidate.id === "hold-1");
    if (!entry) throw new Error("hold candidate not in round");
    app.round.recordVote("voter-1", entry.option);
    app.round.closeRound();
    // Flush the async dispatch → park chain (microtasks + zero-timers).
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
      if (listPending(app.db).length === 1) break;
    }
    const id = listPending(app.db)[0]?.id;
    if (id === undefined) throw new Error("park did not land");
    return id;
  }

  it("with the knob UNSET the timer is 120_000ms: still pending at 119s, review_expired + denial + discard at 120s", async () => {
    vi.useFakeTimers();
    const chat = fakeChatSource();
    const { sent, sink } = capturingSink();
    const runner = markerRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: previewSandbox().adapter,
      devServerProbe: reachableProbe,
    });
    try {
      // Pause the auto-cycle so advancing 2 minutes never opens phases/rounds.
      app.autoCycle.toggle();
      const reviewId = await parkOne(app);

      await vi.advanceTimersByTimeAsync(119_000);
      expect(getReview(app.db, reviewId)?.status).toBe("pending");
      expect(listAuditRecords(app.db, { limit: 10, eventType: "review_expired" })).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(getReview(app.db, reviewId)?.status).toBe("expired-unreviewed");
      const expired = listAuditRecords(app.db, { limit: 10, eventType: "review_expired" });
      expect(expired).toHaveLength(1);
      // The auto-decline takes today's denial path — comp02Rejected wording.
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(sent.some((m) => m.includes("didn't pass the second safety check"))).toBe(true);
      // Fail-closed, never a zombie: approve after expiry falls through to the
      // intake path and 409s (row is terminal).
      expect(listPending(app.db)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  }, 30_000);

  it("REVIEW_HOLD_TIMEOUT_SECONDS=1 fires the auto-decline at 1s (knob override pin)", async () => {
    const restore = setEnv({ REVIEW_HOLD_TIMEOUT_SECONDS: "1" });
    vi.useFakeTimers();
    const runner = markerRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      agentRunner: runner.runner,
      sandboxAdapter: previewSandbox().adapter,
      devServerProbe: reachableProbe,
    });
    try {
      app.autoCycle.toggle();
      const reviewId = await parkOne(app);

      await vi.advanceTimersByTimeAsync(900);
      expect(getReview(app.db, reviewId)?.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(100);
      expect(getReview(app.db, reviewId)?.status).toBe("expired-unreviewed");
      expect(listAuditRecords(app.db, { limit: 10, eventType: "review_expired" })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await app.close();
      restore();
    }
  }, 30_000);

  it("a resolution beats the timer: approve first, the later firing writes NOTHING (idempotent guard)", async () => {
    const restore = setEnv({ REVIEW_HOLD_TIMEOUT_SECONDS: "1" });
    vi.useFakeTimers();
    const runner = markerRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      agentRunner: runner.runner,
      sandboxAdapter: previewSandbox().adapter,
      devServerProbe: reachableProbe,
    });
    try {
      app.autoCycle.toggle();
      const reviewId = await parkOne(app);
      const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
      expect(res.status).toBe(200);
      // The continuation build runs; flush it to done.
      for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getReview(app.db, reviewId)?.status).toBe("approved");
      expect(listAuditRecords(app.db, { limit: 10, eventType: "review_expired" })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await app.close();
      restore();
    }
  }, 30_000);
});

// ── P4 preview-taint matrix (project-switch holdover + reroot guards) ────────

describe("main preview taint (P4): project-switch hold, teardown/HALTED-exit guards, discharge paths", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 900;

  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  beforeAll(async () => {
    runner = markerRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
      galleryPublisher: {
        publishNow: () =>
          Promise.resolve({ status: "published" as const, commitHash: "hash", detail: "ok" }),
        revertLast: () =>
          Promise.resolve({ status: "failed" as const, commitHash: null, detail: "unused" }),
      },
    });
    // Seed: gen 1 active project.
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "make the first app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("PROJECT-SWITCH mid-build hold: exactly ONE raw reroot at the HOLDOVER dir; holdover survives reject", async () => {
    const startsBefore = sandbox.starts.length;
    say("!build flagme a brand new app");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme a brand new app");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);

    // Rotation happened (holdover armed at gen 1) and the hold rerooted at
    // the HOLDOVER dir — the previous project comes back on the OBS slot.
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)?.dir).toBe("/home/builder/projects/app-1");

    // Reject the park: the holdover is RETAINED (no extra reroot, no discharge).
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    const res = await postJson(app.port, `/api/review/${reviewId}/reject`, {});
    expect(res.status).toBe(200);
    await sleep(100);
    expect(sandbox.starts.length).toBe(startsBefore + 1);
  });

  it("a tweak-hold park withholds resurrection: a LATER teardown (failed build → skip) NEVER reroots the tainted dir", async () => {
    // Next done build discharges the earlier holdover first.
    say("!suggest settle the new canvas");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "settle the new canvas");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.at(-1)?.dir === "/home/builder/projects/app-2");

    // Park a TWEAK hold (no holdover) → previewParked set, no reroot.
    const startsBefore = sandbox.starts.length;
    say("!suggest flagme sneak in a tweak");
    say("!suggest filler four");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme sneak in a tweak");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    expect(sandbox.starts.length).toBe(startsBefore);
    // Reject keeps the park.
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    await postJson(app.port, `/api/review/${reviewId}/reject`, {});

    // A LATER failing build's teardown (skip) must NOT resurrect the dir.
    say("!suggest failme this one breaks");
    say("!suggest filler five");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "failme this one breaks");
    await until(() => app.orchestrator?.snapshot()?.stage === "failed", 15_000);
    const taskId = app.orchestrator?.snapshot()?.taskId ?? "";
    app.orchestrator?.skipTask(taskId);
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await sleep(150);
    expect(sandbox.starts.length).toBe(startsBefore); // reroot SKIPPED

    // HALTED-exit reroot is ALSO guarded while parked.
    await postJson(app.port, "/api/halt", {});
    expect(app.machine.mode).toBe("HALTED");
    await postJson(app.port, "/api/recover", { action: "reset-to-idle" });
    expect(app.machine.mode).toBe("IDLE");
    await sleep(150);
    expect(sandbox.starts.length).toBe(startsBefore); // still skipped

    // The NEXT done build discharges previewParked: exactly one reroot.
    say("!suggest a clean healthy tweak");
    say("!suggest filler six");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "a clean healthy tweak");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)?.dir).toBe("/home/builder/projects/app-2");

    // And once discharged, later teardowns reroot normally again.
    say("!suggest failme again");
    say("!suggest filler seven");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "failme again");
    await until(() => app.orchestrator?.snapshot()?.stage === "failed", 15_000);
    const taskId2 = app.orchestrator?.snapshot()?.taskId ?? "";
    app.orchestrator?.skipTask(taskId2);
    await until(() => sandbox.starts.length === startsBefore + 2);
  }, 60_000);

  it("rerootPreviewNow (operator new-project) clears the park taint too", async () => {
    // Park a tweak hold again.
    const startsBefore = sandbox.starts.length;
    say("!suggest flagme once more");
    say("!suggest filler eight");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme once more");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    await postJson(app.port, `/api/review/${reviewId}/reject`, {});
    expect(sandbox.starts.length).toBe(startsBefore);

    // Operator "New project" → rerootPreviewNow clears previewParked + reroots.
    const res = await postJson(app.port, "/api/workspace/new-project", {});
    expect(res.status).toBe(200);
    await until(() => sandbox.starts.length === startsBefore + 1);
  }, 30_000);
});
