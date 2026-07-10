import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ROUND_CLOSED, ROUND_OPENED, VOTE_RECORDED } from "../shared/events.js";
import type { RoundSnapshot } from "../shared/types.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import { type OverlayServerHandle, type OverlayState, startOverlayServer } from "./server.js";

/**
 * Overlay server behavior (plan 02-05, D2-17/D2-18):
 *  - full state on ws connect (OBS scene-switch reload reconstruction)
 *  - immediate pushes for lifecycle events; 300ms-debounced tally pushes
 *  - a physically read-only HTTP surface: zero mutation routes
 *  - localhost-only bind + the console's ws Origin check
 *  - public pill vocabulary only — never the word HALTED on stream
 */

function sampleRound(overrides: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    roundId: 1,
    status: "open",
    frozen: false,
    candidates: [
      {
        option: 1,
        candidate: {
          id: "c1",
          source: "chat",
          kind: "suggestion",
          twitchUsername: "viewer1",
          text: "build a snake game",
          submittedAtMs: 1_000,
        },
        result: { decision: "approved", category: null, rationale: "fine" },
        votes: 2,
      },
      {
        option: 2,
        candidate: {
          id: "c2",
          source: "chat",
          kind: "suggestion",
          twitchUsername: "viewer2",
          text: "build a paint app",
          submittedAtMs: 2_000,
        },
        result: { decision: "approved", category: null, rationale: "fine" },
        votes: 1,
      },
    ],
    openedAtMs: 10_000,
    endsAtMs: 70_000,
    remainingMs: null,
    winnerOption: null,
    tiebreak: false,
    totalVotes: 3,
    ...overrides,
  };
}

/** Minimal round-event source satisfying the overlay's structural round dep. */
interface FakeRound {
  snapshot(): RoundSnapshot | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string): void;
}

function makeFakeRound(snap: RoundSnapshot | null = null): FakeRound {
  const emitter = new EventEmitter();
  return {
    snapshot: () => snap,
    on: (event, handler) => {
      emitter.on(event, handler);
    },
    emit: (event) => {
      emitter.emit(event, snap);
    },
  };
}

/** Yield to the event loop so socket I/O lands (setImmediate is never faked). */
async function flushIo(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("overlay server (read-only broadcast surface)", () => {
  const handles: OverlayServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const ws of sockets.splice(0)) {
      ws.terminate();
    }
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
  });

  async function start(
    opts: {
      machine?: StreamModeMachine;
      round?: FakeRound;
      nextUpTexts?: string[];
      debounceMs?: number;
    } = {},
  ) {
    const machine = opts.machine ?? new StreamModeMachine();
    const round = opts.round ?? makeFakeRound();
    const taskQueue = {
      list: () => (opts.nextUpTexts ?? []).map((text) => ({ text })),
    };
    const handle = await startOverlayServer({
      machine,
      round,
      taskQueue,
      port: 0,
      ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
    });
    handles.push(handle);
    return { machine, round, handle };
  }

  /** Connect a ws client and collect every parsed push into `messages`. */
  function connectWs(port: number, origin?: string): { ws: WebSocket; messages: OverlayState[] } {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}`,
      origin !== undefined ? { headers: { origin } } : {},
    );
    sockets.push(ws);
    const messages: OverlayState[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(String(data)) as OverlayState);
    });
    return { ws, messages };
  }

  it("a connecting client receives ONE full-state message immediately (D2-18 reload safety)", async () => {
    const round = makeFakeRound(sampleRound());
    const { handle } = await start({ round, nextUpTexts: ["queued idea"] });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial full-state push");
    await flushIo();
    expect(messages).toHaveLength(1);
    const state = messages[0];
    expect(state?.pill).toBe("STANDBY");
    expect(state?.round?.roundId).toBe(1);
    expect(state?.round?.candidates).toHaveLength(2);
    expect(state?.nextUp).toEqual(["queued idea"]);
  });

  it("nextUp carries at most the first 3 queue texts", async () => {
    const { handle } = await start({ nextUpTexts: ["one", "two", "three", "four"] });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const state = (await res.json()) as OverlayState;
    expect(state.nextUp).toEqual(["one", "two", "three"]);
  });

  it("ROUND_OPENED, ROUND_CLOSED and STATE_CHANGED each push immediately", async () => {
    const round = makeFakeRound(sampleRound());
    const { machine, handle } = await start({ round });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");

    round.emit(ROUND_OPENED);
    await until(() => messages.length >= 2, "ROUND_OPENED push");

    round.emit(ROUND_CLOSED);
    await until(() => messages.length >= 3, "ROUND_CLOSED push");

    machine.transition("VOTING_ROUND");
    await until(() => messages.length >= 4, "STATE_CHANGED push");
    expect(messages[3]?.pill).toBe("VOTING OPEN");
  });

  it("five rapid VOTE_RECORDED emissions produce exactly ONE push after the debounce window", async () => {
    const round = makeFakeRound(sampleRound());
    const { handle } = await start({ round });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 5; i++) {
      round.emit(VOTE_RECORDED);
    }
    await flushIo();
    // Nothing yet: tally pushes are debounced, never per-vote (T-02-22).
    expect(messages).toHaveLength(1);

    vi.advanceTimersByTime(299);
    await flushIo();
    expect(messages).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await until(() => messages.length >= 2, "debounced tally push");
    await flushIo();
    expect(messages).toHaveLength(2);

    // The window collapsed all five events; no trailing extras arrive.
    vi.advanceTimersByTime(1_000);
    await flushIo();
    expect(messages).toHaveLength(2);
  });

  it("GET /api/state mirrors the overlay state; every mutation method 404s (D2-17)", async () => {
    const { handle } = await start();
    const base = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as OverlayState;
    expect(state.pill).toBe("STANDBY");
    expect(state.round).toBeNull();
    expect(state.nextUp).toEqual([]);

    // No mutation routes exist AT ALL — the strongest read-only control.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/api/state", "/api/halt", "/", "/anything"]) {
        const attempt = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "DELETE" ? undefined : "{}",
        });
        expect(attempt.status, `${method} ${path} must 404`).toBe(404);
      }
    }
  });

  it("serves the static overlay page", async () => {
    const { handle } = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("rejects ws upgrades with a foreign Origin; accepts no-Origin and same-origin", async () => {
    const { handle } = await start();

    const foreign = connectWs(handle.port, "http://evil.example");
    const foreignOutcome = await new Promise<"open" | "rejected">((resolve) => {
      foreign.ws.on("open", () => resolve("open"));
      foreign.ws.on("error", () => resolve("rejected"));
      foreign.ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(foreignOutcome).toBe("rejected");

    const sameOrigin = connectWs(handle.port, `http://127.0.0.1:${handle.port}`);
    await until(() => sameOrigin.messages.length >= 1, "same-origin full-state push");

    const noOrigin = connectWs(handle.port);
    await until(() => noOrigin.messages.length >= 1, "no-origin full-state push");
  });

  it("binds 127.0.0.1 and close() terminates clients and resolves", async () => {
    const { handle } = await start();
    expect((handle.server.address() as AddressInfo).address).toBe("127.0.0.1");

    const { ws, messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    const closed = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });
    await handle.close();
    await closed;
  });

  it("pill mapping: IDLE→STANDBY, VOTING_ROUND→VOTING OPEN, BUILD_IN_PROGRESS→BUILDING, HALTED→ON HOLD", async () => {
    const machine = new StreamModeMachine();
    const { handle } = await start({ machine });
    const base = `http://127.0.0.1:${handle.port}`;
    const pill = async () => ((await (await fetch(`${base}/api/state`)).json()) as OverlayState).pill;

    expect(await pill()).toBe("STANDBY");
    machine.transition("VOTING_ROUND");
    expect(await pill()).toBe("VOTING OPEN");
    machine.transition("BUILD_IN_PROGRESS");
    expect(await pill()).toBe("BUILDING");
    machine.forceTransition("HALTED", {
      source: "console",
      reasonTag: null,
      frozen: machine.snapshot(),
    });
    const halted = await pill();
    expect(halted).toBe("ON HOLD");
    // The internal word never leaks to the broadcast payload (D2-18).
    expect(halted).not.toContain("HALTED");
  });
});
