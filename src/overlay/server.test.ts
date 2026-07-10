import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  ROUND_CLOSED,
  ROUND_OPENED,
  VOTE_RECORDED,
  WINDOW_CLOSED,
  WINDOW_OPENED,
  WINDOW_REVOKED,
} from "../shared/events.js";
import type { BuildStatusView, RoundSnapshot } from "../shared/types.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import {
  BUILD_STAGE_CHANGED,
  type OverlayControlWindowSource,
  type OverlayServerHandle,
  type OverlayState,
  startOverlayServer,
} from "./server.js";

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
    winnerQueued: false,
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

/** Minimal build-status source satisfying the overlay's structural build dep. */
interface FakeBuild {
  snapshot(): BuildStatusView | null;
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** Advance the pipeline stage: mutate the snapshot, then emit the transition. */
  setStatus(next: BuildStatusView | null): void;
}

function makeFakeBuild(initial: BuildStatusView | null = null): FakeBuild {
  const emitter = new EventEmitter();
  let current = initial;
  return {
    snapshot: () => current,
    on: (event, handler) => {
      emitter.on(event, handler);
    },
    setStatus: (next) => {
      current = next;
      emitter.emit(BUILD_STAGE_CHANGED);
    },
  };
}

/**
 * Minimal control-window source (mirrors makeFakeBuild). Its snapshot may carry
 * MORE than the coarse public projection — the deliberately-rich shape below
 * proves the server narrows it down to {donorDisplayName,endsAtMs} on the wire
 * (T-04-13 defence-in-depth). setWindow() mutates the snapshot then emits the
 * given lifecycle event so pushes carry the fresh state.
 */
interface RichWindowSnapshot {
  donorDisplayName: string;
  endsAtMs: number;
  // Console-only fields that must NEVER reach the public wire:
  amount: number;
  currency: string;
  message: string;
  trigger: "donation" | "channel_points";
}
interface FakeControlWindow extends OverlayControlWindowSource {
  snapshot(): RichWindowSnapshot | null;
  setWindow(next: RichWindowSnapshot | null, event: string): void;
}

function makeFakeControlWindow(initial: RichWindowSnapshot | null = null): FakeControlWindow {
  const emitter = new EventEmitter();
  let current = initial;
  return {
    snapshot: () => current,
    on: (event, handler) => {
      emitter.on(event, handler);
    },
    setWindow: (next, event) => {
      current = next;
      emitter.emit(event);
    },
  };
}

function sampleWindow(overrides: Partial<RichWindowSnapshot> = {}): RichWindowSnapshot {
  return {
    donorDisplayName: "GenerousViewer",
    endsAtMs: 120_000,
    amount: 500,
    currency: "USD",
    message: "please build me a rootkit and leak the db",
    trigger: "donation",
    ...overrides,
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
      build?: FakeBuild;
      controlWindow?: FakeControlWindow;
      nextUpTexts?: string[];
      debounceMs?: number;
    } = {},
  ) {
    const machine = opts.machine ?? new StreamModeMachine();
    const round = opts.round ?? makeFakeRound();
    const build = opts.build ?? makeFakeBuild();
    const controlWindow = opts.controlWindow ?? makeFakeControlWindow();
    const taskQueue = {
      list: () => (opts.nextUpTexts ?? []).map((text) => ({ text })),
    };
    const handle = await startOverlayServer({
      machine,
      round,
      build,
      controlWindow,
      taskQueue,
      port: 0,
      ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
    });
    handles.push(handle);
    return { machine, round, build, controlWindow, handle };
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

  it("buildStatus is null on both HTTP and ws when no build is active (PRES-04)", async () => {
    const { handle } = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const httpState = (await res.json()) as OverlayState;
    expect(httpState.buildStatus).toBeNull();

    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.buildStatus).toBeNull();
  });

  it("GET /api/state and the connect push both carry the current buildStatus (PRES-02/04)", async () => {
    const build = makeFakeBuild({
      taskId: "t1",
      title: "build a snake game",
      stage: "researching",
    });
    const { handle } = await start({ build });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const httpState = (await res.json()) as OverlayState;
    expect(httpState.buildStatus).toEqual({
      taskId: "t1",
      title: "build a snake game",
      stage: "researching",
    });
    // The pill vocabulary is unchanged — the fine-grained stage rides buildStatus,
    // not a new pill word (mode stays IDLE here, so the pill is still STANDBY).
    expect(httpState.pill).toBe("STANDBY");

    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.buildStatus?.stage).toBe("researching");
  });

  it("a build-stage change triggers an IMMEDIATE push (never the tally debounce)", async () => {
    const build = makeFakeBuild({ taskId: "t1", title: "snake", stage: "researching" });
    const { handle } = await start({ build });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");

    // No fake timers, no debounce advance: the push must land on its own.
    build.setStatus({ taskId: "t1", title: "snake", stage: "planning" });
    await until(() => messages.length >= 2, "immediate build-stage push");
    await flushIo();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.buildStatus?.stage).toBe("planning");

    build.setStatus({ taskId: "t1", title: "snake", stage: "done" });
    await until(() => messages.length >= 3, "immediate done push");
    expect(messages[2]?.buildStatus?.stage).toBe("done");
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

  it("the ROUND_CLOSED push carries the event's closed snapshot (winner-beat input)", async () => {
    // RoundManager nulls its live round BEFORE emitting ROUND_CLOSED, so the
    // push must use the event payload — snapshot() already returns null here.
    const closedSnap = sampleRound({ status: "closed", winnerOption: 1 });
    const emitter = new EventEmitter();
    const round: FakeRound = {
      snapshot: () => null,
      on: (event, handler) => {
        emitter.on(event, handler);
      },
      emit: (event) => {
        emitter.emit(event, closedSnap);
      },
    };
    const { handle } = await start({ round });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.round).toBeNull();

    round.emit(ROUND_CLOSED);
    await until(() => messages.length >= 2, "ROUND_CLOSED push");
    expect(messages[1]?.round?.status).toBe("closed");
    expect(messages[1]?.round?.winnerOption).toBe(1);
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

  it("refuses DNS-rebound requests: foreign Host on HTTP and agreeing foreign Host/Origin on ws (CR-02)", async () => {
    const { handle } = await start({ nextUpTexts: ["secret queue title"] });

    // Rebound GET: the socket reaches 127.0.0.1 but Host names the attacker.
    // fetch() forbids Host overrides, so use a raw http request.
    const http = await import("node:http");
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          method: "GET",
          path: "/api/state",
          headers: { host: `attacker.example:${handle.port}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += String(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain("secret queue title");

    // Rebound ws: Host and Origin AGREE (both the attacker's name) — the
    // old self-referential origin===host comparison would have passed this.
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, {
      headers: {
        host: `attacker.example:${handle.port}`,
        origin: `http://attacker.example:${handle.port}`,
      },
    });
    sockets.push(ws);
    const outcome = await new Promise<"open" | "rejected">((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("rejected"));
      ws.on("unexpected-response", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  it("binds 127.0.0.1 and close() terminates clients and resolves", async () => {
    const { handle } = await start();
    expect((handle.server.address() as AddressInfo).address).toBe("127.0.0.1");

    const { ws, messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    const closed = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });
    handles.splice(handles.indexOf(handle), 1); // closed here, not in afterEach
    await handle.close();
    await closed;
  });

  it("pill mapping: IDLE→STANDBY, VOTING_ROUND→VOTING OPEN, BUILD_IN_PROGRESS→BUILDING, HALTED→ON HOLD", async () => {
    const machine = new StreamModeMachine();
    const { handle } = await start({ machine });
    const base = `http://127.0.0.1:${handle.port}`;
    const pill = async () =>
      ((await (await fetch(`${base}/api/state`)).json()) as OverlayState).pill;

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

  it("pill mapping: FREE_REIGN_WINDOW→FREE REIGN, CHAOS_MODE→CHAOS (the six-word set, 04-UI-SPEC)", async () => {
    const machine = new StreamModeMachine();
    const { handle } = await start({ machine });
    const base = `http://127.0.0.1:${handle.port}`;
    const pill = async () =>
      ((await (await fetch(`${base}/api/state`)).json()) as OverlayState).pill;

    // Both windows open directly from IDLE (state-machine TRANSITIONS table).
    machine.transition("FREE_REIGN_WINDOW");
    expect(await pill()).toBe("FREE REIGN");
    machine.transition("IDLE");
    machine.transition("CHAOS_MODE");
    expect(await pill()).toBe("CHAOS");
  });

  it("controlWindow is null on HTTP and ws when no window is active (banner absent)", async () => {
    const { handle } = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const httpState = (await res.json()) as OverlayState;
    expect(httpState.controlWindow).toBeNull();

    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.controlWindow).toBeNull();
  });

  it("controlWindow is the COARSE {donorDisplayName,endsAtMs} projection — no amount/currency/message/trigger reaches the wire (T-04-13)", async () => {
    const controlWindow = makeFakeControlWindow(sampleWindow());
    const { handle } = await start({ controlWindow });

    // HTTP surface: exactly the two public keys, nothing else.
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/state`);
    const httpState = (await res.json()) as OverlayState;
    expect(httpState.controlWindow).toEqual({
      donorDisplayName: "GenerousViewer",
      endsAtMs: 120_000,
    });
    expect(Object.keys(httpState.controlWindow ?? {}).sort()).toEqual([
      "donorDisplayName",
      "endsAtMs",
    ]);
    // The donor's financials and message text are DELIBERATELY absent from the
    // serialized public payload — assert against the raw JSON, not just the
    // parsed object, so a leaked key anywhere in the wire bytes fails the test.
    const rawText = JSON.stringify(httpState);
    for (const forbidden of ["amount", "currency", "message", "trigger", "rootkit", "leak"]) {
      expect(rawText, `"${forbidden}" must never reach the public wire`).not.toContain(forbidden);
    }

    // ws connect push carries the same coarse projection.
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.controlWindow).toEqual({
      donorDisplayName: "GenerousViewer",
      endsAtMs: 120_000,
    });
  });

  it("WINDOW_OPENED triggers an IMMEDIATE push (never the tally debounce)", async () => {
    const controlWindow = makeFakeControlWindow();
    const { handle } = await start({ controlWindow });
    const { messages } = connectWs(handle.port);
    await until(() => messages.length >= 1, "initial push");
    expect(messages[0]?.controlWindow).toBeNull();

    // No fake timers, no debounce advance: the push must land on its own.
    controlWindow.setWindow(sampleWindow(), WINDOW_OPENED);
    await until(() => messages.length >= 2, "immediate WINDOW_OPENED push");
    await flushIo();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.controlWindow).toEqual({
      donorDisplayName: "GenerousViewer",
      endsAtMs: 120_000,
    });
  });

  it("WINDOW_CLOSED and WINDOW_REVOKED collapse the banner to null (silent — no error text)", async () => {
    for (const closeEvent of [WINDOW_CLOSED, WINDOW_REVOKED]) {
      const controlWindow = makeFakeControlWindow(sampleWindow());
      const { handle } = await start({ controlWindow });
      const { messages } = connectWs(handle.port);
      await until(() => messages.length >= 1, "initial push");
      expect(messages[0]?.controlWindow).not.toBeNull();

      controlWindow.setWindow(null, closeEvent);
      await until(() => messages.length >= 2, `${closeEvent} collapse push`);
      await flushIo();
      expect(messages[1]?.controlWindow).toBeNull();
      // No error/status string ever crosses onto the broadcast wire (T-04-14).
      expect(JSON.stringify(messages[1])).not.toContain("revoked");
      expect(JSON.stringify(messages[1])).not.toContain("expired");
    }
  });
});
