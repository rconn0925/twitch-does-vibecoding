/**
 * quick-260717-2gr (D-08) held-for-review PARK e2e proof matrix.
 *
 * Replays BOTH 2026-07-16 live incidents against the REAL createApp
 * composition with fakes (the save-and-close/093 harness pattern):
 *  - 20:25:45 class: a mid-build styles.css hold ABORTED a whole build →
 *    now PARKS it (workspace kept, console review card, approve resumes).
 *  - 20:25:52 class: a pre-build hold narrated "streamer review" while the
 *    console showed NOTHING → now a console row appears, with approve/reject.
 *
 * Plus: expiry knob, show-loop-continues, the halt matrix, preview-taint
 * survival, re-hold recurrence (T-2gr-03), and the LOCKED structural rails
 * (single-funnel grep gate; flagged content never on the overlay/chat wire).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
import type { GateResult, SuggestionCandidate } from "../../src/shared/types.js";
import { getReview, listPending } from "../../src/state-machine/review-queue.js";
import { stripComments } from "../invariants/scan-helpers.js";

// Deterministic, fast supervisor cycles in e2e: zero settle wait.
process.env.PREVIEW_DEV_SERVER_SETTLE_MS = "0";

type AppHandle = Awaited<ReturnType<typeof createApp>>;

const PRE_HOLD_MARKER = "XX-PREHOLD-E2E-2GR-XX";
const MID_HOLD_MARKER = "XX-MIDHOLD-E2E-2GR-XX";
const HOLD_RATIONALE = "e2e: deliberately near-identical look-alike concern";

const markerClassifier = (candidate: SuggestionCandidate): GateResult => {
  if (candidate.id.endsWith("-plan") && candidate.text.includes(PRE_HOLD_MARKER)) {
    return { decision: "held-for-review", category: "ip-infringement", rationale: HOLD_RATIONALE };
  }
  if (candidate.id.endsWith("-output") && candidate.text.includes(MID_HOLD_MARKER)) {
    return { decision: "held-for-review", category: "ip-infringement", rationale: HOLD_RATIONALE };
  }
  return { decision: "approved", category: null, rationale: "e2e: approved" };
};

const writeBatch = (filePath: string, content: string) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Write", input: { file_path: filePath, content } }],
  },
});
const resultSuccess = { type: "result", subtype: "success", is_error: false };

/**
 * "flagme" builds emit the flagged batch UNLESS the prompt carries the
 * approved-continuation note (the resume) — with `alwaysFlag` the batch is
 * emitted on the resume too (the T-2gr-03 recurrence driver).
 */
function markerRunner(opts: { alwaysFlag?: boolean } = {}) {
  const specs: AgentRunSpec[] = [];
  const runner: AgentRunner = {
    run(spec) {
      specs.push(spec);
      return (async function* () {
        const resumed = spec.userPrompt.includes("reviewed and approved");
        if (spec.userPrompt.includes("flagme") && (opts.alwaysFlag || !resumed)) {
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
  const adapter: SandboxAdapter = {
    spawn: () => ({}) as never,
    terminate: async () => {},
    async stopPreviewDevServer() {},
    async startPreviewDevServer(dir: string, port: number) {
      starts.push({ dir, port });
    },
  };
  return { adapter, starts };
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

function workspaceRow(app: AppHandle): { generation: number; scaffolded: number } {
  return app.db
    .prepare("SELECT generation, scaffolded FROM workspace_state WHERE id = 1")
    .get() as { generation: number; scaffolded: number };
}

/** The console approve/reject POST rides the REAL CSRF middleware (json type). */
function postJson(port: number, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── INCIDENT REPLAY 1 (20:25:45): mid-build hold parks + approve resumes ─────

describe("held-review-park e2e: INCIDENT 1 — mid-build Write hold PARKS the build; approve resumes to done", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 100;
  let reviewId = 0;
  let winnerId = "";
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

    // Gen 1 becomes an ACTIVE project (a tweak-hold is the incident shape).
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "make the first app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    startsAtPark = sandbox.starts.length;

    // THE INCIDENT: a tweak whose styles.css batch is HELD mid-flight.
    say("!suggest flagme give it a facelift");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    winnerId = voteTextToVictory(app, "flagme give it a facelift");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    reviewId = listPending(app.db)[0]?.id ?? 0;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("the build PARKED (not tossed): machine IDLE, queue clean, workspace generation intact, NO reset ever", () => {
    expect(app.machine.mode).toBe("IDLE");
    expect(app.taskQueue.list()).toHaveLength(0);
    expect(workspaceRow(app)).toEqual({ generation: 1, scaffolded: 1 });
    expect(listAuditRecords(app.db, { limit: 50, eventType: "workspace_reset" })).toHaveLength(0);
  });

  it("the console shows the parked review with the flagged content, rationale, and expiresAtMs", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    const state = (await res.json()) as {
      review: Array<{ id: number; rationale: string; expiresAtMs: number | null }>;
    };
    const item = state.review.find((r) => r.id === reviewId);
    expect(item).toBeDefined();
    expect(item?.rationale).toContain(HOLD_RATIONALE);
    expect(item?.rationale).toContain(MID_HOLD_MARKER);
    expect(typeof item?.expiresAtMs).toBe("number");
  });

  it("T-2gr-01: the flagged content + rationale NEVER cross the overlay or chat wire (console-only surface)", async () => {
    // Overlay state JSON (the broadcast wire) — raw-bytes-absent, T-04-13 discipline.
    const res = await fetch(`http://127.0.0.1:${app.overlay.port}/api/state`);
    const raw = await res.text();
    expect(raw).not.toContain(MID_HOLD_MARKER);
    expect(raw).not.toContain(HOLD_RATIONALE);
    // Chat narration never carries the flagged bytes either.
    for (const message of sent) {
      expect(message).not.toContain(MID_HOLD_MARKER);
      expect(message).not.toContain(HOLD_RATIONALE);
    }
  });

  it("the preview was NOT rerooted at park time (the tainted workspace never serves — P4)", () => {
    expect(sandbox.starts.length).toBe(startsAtPark);
  });

  it("show-loop-continues: a NEW vote winner builds and completes normally while the item stays parked (never re-picked)", async () => {
    const specsBefore = runner.specs.length;
    say("!suggest an unrelated safe tweak");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "an unrelated safe tweak");
    await until(() => runner.specs.length === specsBefore + 1 && app.machine.mode === "IDLE");
    expect(runner.specs.at(-1)?.userPrompt).toContain("an unrelated safe tweak");
    // Still parked — drain never re-picked the flagged task.
    expect(listPending(app.db)).toHaveLength(1);
    expect(app.taskQueue.list()).toHaveLength(0);
  });

  it("streamer APPROVES via the real HTTP route → continuation to done: history row, review approved, audit chain complete", async () => {
    const specsBefore = runner.specs.length;
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);

    await until(
      () =>
        listBuildHistory(app.db, { limit: 20 }).some(
          (r) => r.title === "flagme give it a facelift" && r.result === "built",
        ) && app.machine.mode === "IDLE",
      15_000,
    );
    // The continuation went through the funnel with the approved-continuation note.
    expect(runner.specs.length).toBe(specsBefore + 1);
    expect(runner.specs.at(-1)?.userPrompt).toContain("reviewed and approved");
    // Review row approved; the FULL audit chain exists — never silent (rail 8):
    // comp02(held) → build_parked_for_review → review_resolved(approved).
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
    const comp02 = listAuditRecords(app.db, { limit: 50, eventType: "comp02_decision" });
    expect(comp02.some((r) => r.decision === "held-for-review" && r.task_id === winnerId)).toBe(
      true,
    );
    const parked = listAuditRecords(app.db, { limit: 50, eventType: "build_parked_for_review" });
    expect(parked.some((r) => r.task_id === winnerId)).toBe(true);
    const resolved = listAuditRecords(app.db, { limit: 50, eventType: "review_resolved" });
    expect(resolved.some((r) => r.decision === "approved" && r.task_id === String(reviewId))).toBe(
      true,
    );
    // Preview rerooted (approve discharge + normal done flow serve the dir again).
    expect(sandbox.starts.length).toBeGreaterThan(startsAtPark);
    // Approval narrated.
    await until(() => sent.some((m) => m.includes("Streamer approved")));
  });
});

// ── INCIDENT REPLAY 2 (20:25:52): pre-build hold gets a console row ──────────

describe("held-review-park e2e: INCIDENT 2 — pre-build hold parks WITH a console row; approve skips the re-screen; reject denies", () => {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 300;
  let planScreens = 0;
  let appRef: AppHandle | null = null;

  const say = (text: string): void => {
    chatter += 1;
    chat.say(String(chatter), `viewer${chatter}`, text);
  };

  beforeAll(async () => {
    runner = markerRunner();
    app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: (candidate) => {
        if (candidate.id.endsWith("-plan") && candidate.text.includes(PRE_HOLD_MARKER)) {
          planScreens += 1;
        }
        return markerClassifier(candidate);
      },
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
    });
    appRef = app;
  }, 30_000);

  afterAll(async () => {
    await appRef?.close();
  });

  it("the pre-build hold PARKS with a console row (the 'console showed nothing' bug is dead) — runner never invoked, zero preview action", async () => {
    const startsBefore = sandbox.starts.length;
    say(`!suggest ${PRE_HOLD_MARKER} build a look-alike thing`);
    say("!suggest filler a");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, `${PRE_HOLD_MARKER} build a look-alike thing`);
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE");

    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    const state = (await res.json()) as {
      review: Array<{ expiresAtMs: number | null; rationale: string }>;
    };
    expect(state.review).toHaveLength(1);
    expect(typeof state.review[0]?.expiresAtMs).toBe("number");
    expect(state.review[0]?.rationale).toBe(HOLD_RATIONALE); // plain — no excerpt
    expect(runner.specs).toHaveLength(0);
    await sleep(50);
    expect(sandbox.starts.length).toBe(startsBefore);
    // The held beat narrated (WR-03 — never silent).
    await until(() => sent.some((m) => m.includes("held for streamer review")));
  });

  it("APPROVE builds WITHOUT re-screening the same text (classify never re-sees the -plan candidate)", async () => {
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    const screensBefore = planScreens;
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE", 15_000);
    // It built — and the marker text's -plan candidate was NEVER re-screened
    // (a re-screen would have re-held it into an infinite park loop).
    expect(planScreens).toBe(screensBefore);
    expect(runner.specs[0]?.userPrompt).toContain(PRE_HOLD_MARKER);
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
  });

  it("REJECT variant: denial narration + review_resolved(rejected) + nothing built", async () => {
    const specsBefore = runner.specs.length;
    say(`!suggest ${PRE_HOLD_MARKER} another borderline`);
    say("!suggest filler b");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, `${PRE_HOLD_MARKER} another borderline`);
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE");
    const reviewId = listPending(app.db)[0]?.id ?? 0;

    const res = await postJson(app.port, `/api/review/${reviewId}/reject`, {});
    expect(res.status).toBe(200);
    expect(getReview(app.db, reviewId)?.status).toBe("rejected");
    const resolved = listAuditRecords(app.db, { limit: 20, eventType: "review_resolved" });
    expect(resolved.some((r) => r.decision === "rejected")).toBe(true);
    await until(() => sent.some((m) => m.includes("didn't pass the second safety check")));
    await sleep(100);
    expect(runner.specs.length).toBe(specsBefore);
    expect(listBuildHistory(app.db, { limit: 20 }).map((r) => r.title)).not.toContain(
      `${PRE_HOLD_MARKER} another borderline`,
    );
  });
});

// ── project-switch hold: holdover semantics ──────────────────────────────────

describe("held-review-park e2e: PROJECT-SWITCH mid-build hold — holdover reroot, survives reject, done discharges", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
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
      galleryPublisher: {
        publishNow: () =>
          Promise.resolve({ status: "published" as const, commitHash: "hash", detail: "ok" }),
        revertLast: () =>
          Promise.resolve({ status: "failed" as const, commitHash: null, detail: "unused" }),
      },
    });
    // Gen 1 active.
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "make the first app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("a held project-switch build reroots at the HOLDOVER dir (previous project back on screen); holdover survives reject; a later done discharges it", async () => {
    const startsBefore = sandbox.starts.length;
    say("!build flagme a brand new app");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme a brand new app");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);

    // Rotation happened; the park's reroot serves the HOLDOVER dir (app-1).
    expect(workspaceRow(app).generation).toBe(2);
    await until(() => sandbox.starts.length === startsBefore + 1);
    expect(sandbox.starts.at(-1)?.dir).toBe("/home/builder/projects/app-1");

    // Reject: the holdover survives (no discharge, no extra reroot).
    const reviewId = listPending(app.db)[0]?.id ?? 0;
    await postJson(app.port, `/api/review/${reviewId}/reject`, {});
    await sleep(100);
    expect(sandbox.starts.length).toBe(startsBefore + 1);

    // A later successful done build discharges the holdover at the ACTIVE dir.
    say("!suggest start the new canvas properly");
    say("!suggest filler three");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "start the new canvas properly");
    await until(() => app.machine.mode === "IDLE" && app.taskQueue.list().length === 0);
    await until(() => sandbox.starts.length === startsBefore + 2);
    expect(sandbox.starts.at(-1)?.dir).toBe("/home/builder/projects/app-2");
  }, 30_000);

  it("APPROVE of a project-switch hold resumes the continuation in the current workspace → done discharges normally", async () => {
    // Park another switch hold (gen 2 → 3, holdover 2).
    const startsBefore = sandbox.starts.length;
    say("!build flagme yet another app");
    say("!suggest filler four");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme yet another app");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    expect(workspaceRow(app).generation).toBe(3);
    await until(() => sandbox.starts.length === startsBefore + 1); // holdover reroot (app-2)

    const reviewId = listPending(app.db)[0]?.id ?? 0;
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);
    await until(
      () =>
        listBuildHistory(app.db, { limit: 20 }).some(
          (r) => r.title === "flagme yet another app" && r.result === "built",
        ) && app.machine.mode === "IDLE",
      15_000,
    );
    // The done build discharged the holdover: reroot at the ACTIVE gen 3 dir.
    await until(() => sandbox.starts.at(-1)?.dir === "/home/builder/projects/app-3");
  }, 30_000);
});

// ── expiry: REVIEW_HOLD_TIMEOUT_SECONDS knob honored, fail-closed decline ────

describe("held-review-park e2e: expiry auto-decline (knob override) — audited, narrated, park KEPT", () => {
  it("REVIEW_HOLD_TIMEOUT_SECONDS=1: the park auto-declines at ~1s with review_expired + denial beat; preview park kept", async () => {
    const restore = setEnv({ REVIEW_HOLD_TIMEOUT_SECONDS: "1" });
    const chat = fakeChatSource();
    const { sent, sink } = capturingSink();
    const sandbox = previewSandbox();
    const runner = markerRunner();
    const app = await createApp({
      dbPath: ":memory:",
      port: 0,
      fakeClassifier: markerClassifier,
      chatSource: chat.source,
      chatSink: sink,
      agentRunner: runner.runner,
      sandboxAdapter: sandbox.adapter,
      devServerProbe: reachableProbe,
    });
    let chatter = 700;
    const say = (text: string): void => {
      chatter += 1;
      chat.say(String(chatter), `viewer${chatter}`, text);
    };
    try {
      // Active project first, then a mid-build tweak hold (preview park).
      say("!suggest make the first app");
      say("!suggest filler one");
      await until(() => app.pool.list().length === 2);
      voteTextToVictory(app, "make the first app");
      await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
      const startsAtPark = sandbox.starts.length;

      say("!suggest flagme sneak a tweak");
      say("!suggest filler two");
      await until(() => app.pool.list().length === 2);
      voteTextToVictory(app, "flagme sneak a tweak");
      await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
      const reviewId = listPending(app.db)[0]?.id ?? 0;

      // The knob-fast timer fires ≈1s later: review_expired + denial beat.
      await until(() => getReview(app.db, reviewId)?.status === "expired-unreviewed", 5_000);
      const expired = listAuditRecords(app.db, { limit: 10, eventType: "review_expired" });
      expect(expired.some((r) => r.task_id === String(reviewId))).toBe(true);
      await until(() => sent.some((m) => m.includes("didn't pass the second safety check")));
      // Never a zombie: the console queue is clean again.
      expect(listPending(app.db)).toHaveLength(0);
      // The tweak preview park is KEPT on expiry (fail-closed — no reroot).
      await sleep(150);
      expect(sandbox.starts.length).toBe(startsAtPark);
      // Nothing was built for the expired hold.
      expect(
        listBuildHistory(app.db, { limit: 20 }).some((r) => r.title === "flagme sneak a tweak"),
      ).toBe(false);
    } finally {
      await app.close();
      restore();
    }
  }, 30_000);

  it("T-2gr-03 recurrence: an approved continuation whose output is STILL flagged re-parks (in-flight screen fully active on resume)", async () => {
    const chat = fakeChatSource();
    const { sink } = capturingSink();
    const runner = markerRunner({ alwaysFlag: true });
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
    let chatter = 800;
    const say = (text: string): void => {
      chatter += 1;
      chat.say(String(chatter), `viewer${chatter}`, text);
    };
    try {
      say("!suggest flagme relentless clone");
      say("!suggest filler one");
      await until(() => app.pool.list().length === 2);
      voteTextToVictory(app, "flagme relentless clone");
      await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
      const firstId = listPending(app.db)[0]?.id ?? 0;

      const res = await postJson(app.port, `/api/review/${firstId}/approve`, {});
      expect(res.status).toBe(200);
      // The resume re-emits flagged output → the in-flight screen re-holds →
      // a FRESH park lands (new review id, first row stays approved).
      await until(
        () => listPending(app.db).length === 1 && (listPending(app.db)[0]?.id ?? 0) !== firstId,
        15_000,
      );
      expect(getReview(app.db, firstId)?.status).toBe("approved");
      expect(app.machine.mode).toBe("IDLE");
      expect(
        listAuditRecords(app.db, { limit: 20, eventType: "build_parked_for_review" }),
      ).toHaveLength(2);
    } finally {
      await app.close();
    }
  }, 30_000);
});

// ── halt matrix ──────────────────────────────────────────────────────────────

describe("held-review-park e2e: HALT matrix — parks survive a halt, approve 409s while HALTED, recovery never resurrects taint", () => {
  const chat = fakeChatSource();
  const { sink } = capturingSink();
  const sandbox = previewSandbox();
  let runner: ReturnType<typeof markerRunner>;
  let app: AppHandle;
  let chatter = 900;
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
    // Active project + a parked TWEAK hold (preview taint armed).
    say("!suggest make the first app");
    say("!suggest filler one");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "make the first app");
    await until(() => runner.specs.length === 1 && app.machine.mode === "IDLE");
    startsAtPark = sandbox.starts.length;

    say("!suggest flagme risky tweak");
    say("!suggest filler two");
    await until(() => app.pool.list().length === 2);
    voteTextToVictory(app, "flagme risky tweak");
    await until(() => listPending(app.db).length === 1 && app.machine.mode === "IDLE", 15_000);
    reviewId = listPending(app.db)[0]?.id ?? 0;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("halt → the park SURVIVES (abortActiveWork never touches it); approve → 409; row stays pending", async () => {
    const haltRes = await postJson(app.port, "/api/halt", {});
    expect(haltRes.status).toBe(200);
    expect(app.machine.mode).toBe("HALTED");
    expect(getReview(app.db, reviewId)?.status).toBe("pending");

    const approveRes = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(approveRes.status).toBe(409);
    expect(getReview(app.db, reviewId)?.status).toBe("pending");
    expect(runner.specs).toHaveLength(2); // seed + incident only — nothing dispatched
  });

  it("halt recovery does NOT resurrect the tainted preview (HALTED-exit reroot skipped under the taint guard)", async () => {
    const recoverRes = await postJson(app.port, "/api/recover", { action: "reset-to-idle" });
    expect(recoverRes.status).toBe(200);
    expect(app.machine.mode).toBe("IDLE");
    await sleep(150);
    expect(sandbox.starts.length).toBe(startsAtPark);
  });

  it("after recovery, approve works: the continuation resumes to done", async () => {
    const res = await postJson(app.port, `/api/review/${reviewId}/approve`, {});
    expect(res.status).toBe(200);
    await until(
      () =>
        listBuildHistory(app.db, { limit: 20 }).some(
          (r) => r.title === "flagme risky tweak" && r.result === "built",
        ) && app.machine.mode === "IDLE",
      15_000,
    );
    expect(getReview(app.db, reviewId)?.status).toBe("approved");
    // Approve discharged the taint: the preview serves the dir again.
    expect(sandbox.starts.length).toBeGreaterThan(startsAtPark);
  });
});

// ── LOCKED structural rails ──────────────────────────────────────────────────

describe("held-review-park structural gates (quick-260717-2gr LOCKED rails)", () => {
  const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

  it("GATE: buildSession.startBuild( has EXACTLY ONE call site in src/main.ts — the continuation rides dispatchBuild", () => {
    const stripped = stripComments(readFileSync(path.join(SRC_ROOT, "main.ts"), "utf8"));
    const calls = stripped.match(/buildSession\.startBuild\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("GATE: the parked continuation dispatch goes through dispatchBuild with resume opts (no parallel entry)", () => {
    const stripped = stripComments(readFileSync(path.join(SRC_ROOT, "main.ts"), "utf8"));
    expect(stripped).toContain("void dispatchBuild(entry.task, entry.provenance");
  });
});
