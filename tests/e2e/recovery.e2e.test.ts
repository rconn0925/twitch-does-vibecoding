import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/audit/db.js";
import type { ChatMessageSink } from "../../src/ingestion/chat-sender.js";
import {
  type ChatEventSource,
  type ChatMessageEvent,
  startTwitchChat,
} from "../../src/ingestion/twitch-chat.js";
import { createApp } from "../../src/main.js";
import type { RoundSnapshot } from "../../src/shared/types.js";

/**
 * Failure-mode e2e (plan 02-06 Task 2): the phase's success criterion 5 and
 * INFRA-02 as executable specs, on FILE-BACKED SQLite — durability is the
 * whole point, so :memory: is banned here.
 *
 *  1. Crash-restart mid-round: acknowledged votes survive; the winner counts
 *     votes from BOTH lives of the process (D2-14).
 *  2. Expired-during-downtime: restore() closes the round immediately and the
 *     winner still reaches the queue via the funnel.
 *  3. Halt-freeze across restart: frozen_remaining_ms persists and the app
 *     re-enters HALTED at boot, so the D-04 recovery triage stays reachable —
 *     Resume re-arms the exact remainder, Reset-to-Idle discards with an
 *     audit row and repools the candidates (D2-16 + CR-01 fix).
 *  4. Disconnect/reconcile: an EventSub ready after a gap re-syncs the
 *     in-memory tally from the round_votes ledger — a REAL db-vs-memory
 *     comparison, proven by mutating the ledger between the events.
 *
 * Honest limitation (T-02-24, accepted): votes typed during a genuine
 * connectivity gap are unrecoverable — EventSub has no replay. Only votes
 * ACKNOWLEDGED (written through to SQLite) are covered by these guarantees;
 * docs/OPERATIONS.md documents this for the operator.
 */

type AppHandle = Awaited<ReturnType<typeof createApp>>;

let app: AppHandle | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const APPROVE_ALL = () =>
  ({ decision: "approved", category: null, rationale: "test: approved" }) as const;

function fakeChatSource() {
  const messageHandlers: ((e: ChatMessageEvent) => void)[] = [];
  const readyHandlers: ((userId: string, sessionId: string) => void)[] = [];
  const disconnectHandlers: ((userId: string, error?: Error) => void)[] = [];
  const source: ChatEventSource = {
    onChannelChatMessage(_broadcasterId, _userId, handler) {
      messageHandlers.push(handler);
      return {};
    },
    onUserSocketReady(handler) {
      readyHandlers.push(handler);
      return {};
    },
    onUserSocketDisconnect(handler) {
      disconnectHandlers.push(handler);
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
    ready(): void {
      for (const handler of readyHandlers) handler("999", "session-1");
    },
    disconnect(): void {
      for (const handler of disconnectHandlers) handler("999", new Error("gone"));
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

function baseUrl(handle: AppHandle): string {
  return `http://127.0.0.1:${handle.port}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("until(): condition not met before timeout");
    await sleep(25);
  }
}

interface StateBody {
  mode: string;
  twitch: string;
  pool: Array<{ candidate: { text: string } }>;
  queue: Array<{ text: string }>;
  round: RoundSnapshot | null;
}

async function getState(handle: AppHandle): Promise<StateBody> {
  const res = await fetch(`${baseUrl(handle)}/api/state`);
  expect(res.status).toBe(200);
  return (await res.json()) as StateBody;
}

/** Session bootstrap: fake chat + capturing sink + approving classifier over one db file. */
async function startSession(dbPath: string) {
  const chat = fakeChatSource();
  const { sent, sink } = capturingSink();
  const handle = await createApp({
    dbPath,
    port: 0,
    fakeClassifier: APPROVE_ALL,
    chatSource: chat.source,
    chatSink: sink,
  });
  app = handle;
  return { handle, chat, sent };
}

/** Pool two candidates through the real chat path and open a round. */
async function poolTwoAndOpenRound(handle: AppHandle, chat: ReturnType<typeof fakeChatSource>) {
  chat.say("101", "alice", "!suggest build a snake game");
  chat.say("102", "bob", "!suggest build a pomodoro timer");
  await until(async () => ((await getState(handle)).pool.length === 2 ? true : undefined));
  const started = await postJson(`${baseUrl(handle)}/api/round/start`, {});
  expect(started.status).toBe(200);
}

describe("crash-restart mid-round (success criterion 5, D2-14)", () => {
  it("kill mid-round → restart restores the exact round; the winner counts votes from BOTH process lives", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "recovery-crash-"));
    const dbPath = path.join(tempDir, "audit.db");

    // ── Life 1: open a round, record 3 vote events (one is a revote). ──
    const a = await startSession(dbPath);
    await poolTwoAndOpenRound(a.handle, a.chat);
    a.chat.say("301", "erin", "!vote 1");
    a.chat.say("302", "frank", "!vote 2");
    a.chat.say("302", "frank", "!vote 1"); // revote: frank moves 2 → 1
    const before = await until(async () => {
      const state = await getState(a.handle);
      return state.round?.totalVotes === 2 ? state : undefined;
    });
    const roundBefore = before.round as RoundSnapshot;
    expect(roundBefore.candidates.map((c) => c.votes)).toEqual([2, 0]);

    // "Crash": close the process WITHOUT closing the round — the rounds row
    // stays 'open' and every acknowledged vote is already in round_votes.
    await a.handle.close();
    app = null;

    // ── Life 2: same db file. restore() runs before any surface listens. ──
    const b = await startSession(dbPath);
    const restored = await getState(b.handle);
    expect(restored.round?.roundId).toBe(roundBefore.roundId);
    // The tally is EXACTLY what was acknowledged before the kill.
    expect(restored.round?.totalVotes).toBe(2);
    expect(restored.round?.candidates.map((c) => c.votes)).toEqual([2, 0]);
    // Remaining time is plausible: the persisted deadline is unchanged and
    // still in the future (the round did not restart from zero).
    expect(restored.round?.endsAtMs).toBe(roundBefore.endsAtMs);
    expect(restored.round ? restored.round.endsAtMs : 0).toBeGreaterThan(Date.now());
    expect(restored.mode).toBe("VOTING_ROUND");

    // One more vote in life 2, then close: the winner (option 1, 2 votes)
    // is decided by life-1 votes — nothing acknowledged was silently lost.
    b.chat.say("303", "grace", "!vote 2");
    await until(async () =>
      (await getState(b.handle)).round?.totalVotes === 3 ? true : undefined,
    );
    b.handle.round.closeRound();

    const after = await getState(b.handle);
    expect(after.round).toBeNull();
    expect(after.queue).toHaveLength(1);
    expect(after.queue[0]?.text).toBe("build a snake game"); // option 1 wins 2–1
    expect(after.pool.map((p) => p.candidate.text)).toContain("build a pomodoro timer");
  });
});

describe("round expired during downtime (D2-14)", () => {
  it("restore() closes an already-expired round immediately and the winner is enqueued via the funnel", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "recovery-expired-"));
    const dbPath = path.join(tempDir, "audit.db");

    const a = await startSession(dbPath);
    await poolTwoAndOpenRound(a.handle, a.chat);
    a.chat.say("401", "erin", "!vote 2");
    await until(async () =>
      (await getState(a.handle)).round?.totalVotes === 1 ? true : undefined,
    );
    await a.handle.close();
    app = null;

    // Simulate downtime outlasting the round: push the persisted deadline
    // into the past while the process is down.
    const db = openDb(dbPath);
    db.prepare("UPDATE rounds SET ends_at_ms = ? WHERE status = 'open'").run(Date.now() - 10_000);
    db.close();

    const b = await startSession(dbPath);
    const state = await getState(b.handle);
    // The round closed during restore — before the console served a request.
    expect(state.round).toBeNull();
    expect(state.mode).toBe("IDLE");
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.text).toBe("build a pomodoro timer"); // option 2 won
    expect(state.pool.map((p) => p.candidate.text)).toContain("build a snake game");

    // The close is audited like any live close (COMP-05).
    const res = await fetch(`${baseUrl(b.handle)}/api/audit?limit=50&eventType=round_closed`);
    const rows = (await res.json()) as Array<{ event_type: string }>;
    expect(rows).toHaveLength(1);
  });
});

describe("halt-freeze across restart (D2-16 + D2-14 + CR-01)", () => {
  /** Halt mid-round, kill the process, restart on the same db. Returns the frozen facts. */
  async function haltThenRestart() {
    const dbPath = path.join(tempDir as string, "audit.db");

    const a = await startSession(dbPath);
    await poolTwoAndOpenRound(a.handle, a.chat);
    a.chat.say("501", "erin", "!vote 1");
    await until(async () =>
      (await getState(a.handle)).round?.totalVotes === 1 ? true : undefined,
    );
    const roundId = (await getState(a.handle)).round?.roundId as number;

    // Halt mid-round: the kill switch freezes the round synchronously (D2-16).
    const halted = await postJson(`${baseUrl(a.handle)}/api/halt`, {});
    expect(halted.status).toBe(200);
    const frozenState = await getState(a.handle);
    expect(frozenState.mode).toBe("HALTED");
    expect(frozenState.round?.frozen).toBe(true);
    const frozenRemainingMs = frozenState.round?.remainingMs as number;
    expect(frozenRemainingMs).toBeGreaterThan(0);

    // The remainder is PERSISTED, not just in memory.
    const persisted = a.handle.db
      .prepare("SELECT frozen_remaining_ms FROM rounds WHERE status = 'open'")
      .get() as { frozen_remaining_ms: number | null };
    expect(persisted.frozen_remaining_ms).toBe(frozenRemainingMs);

    await a.handle.close();
    app = null;

    // Restart: the frozen round restores AND the app re-enters HALTED, so
    // the D-04 recovery triage (resume vs discard) is reachable — the
    // streamer's halt survives the restart; nothing auto-resumes (CR-01).
    const b = await startSession(dbPath);
    const restored = await getState(b.handle);
    expect(restored.mode).toBe("HALTED");
    expect(restored.round?.roundId).toBe(roundId);
    expect(restored.round?.frozen).toBe(true);
    expect(restored.round?.remainingMs).toBe(frozenRemainingMs);
    expect(restored.round?.totalVotes).toBe(1);

    return { b, roundId, frozenRemainingMs };
  }

  it("triage RESUME after restart: the round unfreezes with its exact remainder and keeps accepting votes", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "recovery-freeze-resume-"));
    const { b, roundId } = await haltThenRestart();

    // Start Round is refused while the frozen round is loaded — it can no
    // longer be silently overwritten (CR-01 round-active guard; HALTED here).
    const startAttempt = await postJson(`${baseUrl(b.handle)}/api/round/start`, {});
    expect(startAttempt.status).toBe(409);

    // Triage picks Resume: back to VOTING_ROUND, the frozen remainder re-arms.
    const recovered = await postJson(`${baseUrl(b.handle)}/api/recover`, { action: "resume" });
    expect(recovered.status).toBe(200);
    const resumed = await getState(b.handle);
    expect(resumed.mode).toBe("VOTING_ROUND");
    expect(resumed.round?.roundId).toBe(roundId);
    expect(resumed.round?.frozen).toBe(false);
    expect(resumed.round ? resumed.round.endsAtMs : 0).toBeGreaterThan(Date.now());

    // The resumed round is LIVE: pre-halt votes counted, new votes land.
    b.chat.say("502", "frank", "!vote 2");
    const after = await until(async () => {
      const state = await getState(b.handle);
      return state.round?.totalVotes === 2 ? state : undefined;
    });
    expect(after.round?.candidates.map((c) => c.votes)).toEqual([1, 1]);
  });

  it("triage DISCARD after restart: audited discard, candidates repool, votes stay, a fresh round starts cleanly", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "recovery-freeze-discard-"));
    const { b, roundId } = await haltThenRestart();

    // Triage picks Reset to Idle: HALTED→IDLE discards the frozen round.
    const recovered = await postJson(`${baseUrl(b.handle)}/api/recover`, {
      action: "reset-to-idle",
    });
    expect(recovered.status).toBe(200);
    const state = await getState(b.handle);
    expect(state.mode).toBe("IDLE");
    expect(state.round).toBeNull();

    // The candidates are repooled, not lost.
    expect(state.pool.map((p) => p.candidate.text).sort()).toEqual([
      "build a pomodoro timer",
      "build a snake game",
    ]);

    // The row is resolved (not deleted, D-02) and the discard is audited.
    const row = b.handle.db
      .prepare("SELECT status, frozen_remaining_ms FROM rounds WHERE id = ?")
      .get(roundId) as { status: string; frozen_remaining_ms: number | null };
    expect(row.status).toBe("discarded");
    const auditRes = await fetch(`${baseUrl(b.handle)}/api/audit?limit=50&eventType=round_closed`);
    const auditRows = (await auditRes.json()) as Array<{ decision: string | null }>;
    expect(auditRows.some((r) => r.decision === "discarded")).toBe(true);
    // The acknowledged vote stays in the ledger — nothing is deleted.
    const votes = b.handle.db
      .prepare("SELECT COUNT(*) AS c FROM round_votes WHERE round_id = ?")
      .get(roundId) as { c: number };
    expect(votes.c).toBe(1);

    // The exit is real: a fresh round starts immediately over the repooled
    // candidates — no stranded 'open' row, no orphaned state (CR-01).
    const started = await postJson(`${baseUrl(b.handle)}/api/round/start`, {});
    expect(started.status).toBe(200);
    const after = await getState(b.handle);
    expect(after.round?.status).toBe("open");
    expect(after.round?.roundId).not.toBe(roundId);
  });
});

describe("EventSub disconnect → ready reconciliation (INFRA-02, D2-14)", () => {
  it("a ready after a gap re-syncs the in-memory tally from the round_votes ledger", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "recovery-reconcile-"));
    const dbPath = path.join(tempDir, "audit.db");

    const a = await startSession(dbPath);
    await poolTwoAndOpenRound(a.handle, a.chat);
    a.chat.say("601", "erin", "!vote 1");
    await until(async () =>
      (await getState(a.handle)).round?.totalVotes === 1 ? true : undefined,
    );
    const roundId = (await getState(a.handle)).round?.roundId as number;

    // The gap begins: the console pill goes honest immediately.
    a.chat.disconnect();
    expect((await getState(a.handle)).twitch).toBe("disconnected");

    // Mutate the LEDGER while memory is unaware — the durable ground truth
    // gains a vote the in-memory tally never saw.
    a.handle.db
      .prepare(
        `INSERT INTO round_votes (round_id, twitch_user_id, option_index, voted_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(roundId, "602", 2, Date.now());
    // Memory still shows the stale tally: reconciliation has a real job to do.
    expect((await getState(a.handle)).round?.totalVotes).toBe(1);

    // (Re)connect: reconcile compares db vs memory and re-syncs from SQLite.
    a.chat.ready();
    const reconciled = await until(async () => {
      const state = await getState(a.handle);
      return state.round?.totalVotes === 2 ? state : undefined;
    });
    expect(reconciled.twitch).toBe("connected");
    expect(reconciled.round?.roundId).toBe(roundId);
    expect(reconciled.round?.candidates.map((c) => c.votes)).toEqual([1, 1]);

    // The reconciled round is still LIVE: a fresh chat vote lands normally.
    a.chat.say("603", "grace", "!vote 2");
    const after = await until(async () => {
      const state = await getState(a.handle);
      return state.round?.totalVotes === 3 ? state : undefined;
    });
    expect(after.round?.candidates.map((c) => c.votes)).toEqual([1, 2]);
  });

  it("logs both transitions with the RESEARCH.md wording and runs reconcile on ready (INFRA-02 observability)", () => {
    // startTwitchChat accepts an injected logger — createApp's internal pino
    // is not injectable, so the exact log-line contract is proven here at the
    // listener seam with the same fake source the e2e composition uses.
    const chat = fakeChatSource();
    const logged: Array<{ level: string; msg: string }> = [];
    let reconcileRuns = 0;

    const handle = startTwitchChat({
      source: chat.source,
      broadcasterUserId: "999",
      intake: { check: () => ({ ok: true }), registerAccepted() {} },
      submit: () => ({ accepted: true, id: "noop" }),
      round: { recordVote: () => true },
      narrator: {
        roundOpened() {},
        roundClosed() {},
        feedback() {},
        error() {},
        buildPickedUp() {},
        stagePlanning() {},
        stageBuilding() {},
        buildDone() {},
        buildRefused() {},
        buildRetryingOnce() {},
        buildDeciding() {},
        buildRetryChosen() {},
        buildSkipped() {},
        comp02Rejected() {},
        buildHeld() {},
        buildVetoed() {},
        windowOpenedDonation() {},
        windowOpenedChannelPoints() {},
        windowDeniedActive() {},
        windowDeniedCooldown() {},
        windowDeniedNotIdle() {},
        instructionRejected() {},
        instructionHeld() {},
        instructionAccepted() {},
        instructionQueued() {},
        window30sLeft() {},
        windowExpired() {},
        windowRevoked() {},
        chaosOn() {},
        chaosOff() {},
        chaosPick() {},
        suggestionsOpen() {},
        stillCollecting() {},
        buildQueueFull() {},
      },
      reconcile: () => {
        reconcileRuns += 1;
      },
      logger: {
        info: (_obj, msg) => logged.push({ level: "info", msg: msg ?? "" }),
        warn: (_obj, msg) => logged.push({ level: "warn", msg: msg ?? "" }),
        error: (_obj, msg) => logged.push({ level: "error", msg: msg ?? "" }),
      },
    });

    chat.disconnect();
    expect(logged).toContainEqual({
      level: "warn",
      msg: "EventSub socket disconnected — twurple will auto-reconnect",
    });
    expect(reconcileRuns).toBe(0); // reconcile runs on READY, never on disconnect

    chat.ready();
    expect(logged).toContainEqual({
      level: "info",
      msg: "EventSub socket (re)connected and ready",
    });
    expect(reconcileRuns).toBe(1);

    handle.stop();
  });
});
