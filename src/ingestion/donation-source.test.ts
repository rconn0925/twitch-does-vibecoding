import { describe, expect, it } from "vitest";
import {
  type DonationEventSource,
  type DonationSocket,
  makeDonationSource,
  type TipEvent,
  TipEventSchema,
} from "./donation-source.js";

/**
 * Fake socket.io Socket — zero network. Records emitted messages and lets the
 * test drive the socket's own events ("connect"/"event"/"disconnect"), exactly
 * how socket.io-client would deliver them, so the fail-closed dispatch runs
 * against injected input (D-10).
 */
interface FakeSocket {
  socket: DonationSocket;
  emitted: Array<{ event: string; args: unknown[] }>;
  fire(event: string, ...args: unknown[]): void;
}

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  return {
    socket: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return {};
      },
      emit(event, ...args) {
        emitted.push({ event, args });
        return {};
      },
    },
    emitted,
    fire(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

/** Capturing fake logger — records structured objects passed to warn/error. */
function capturingLogger() {
  const entries: unknown[] = [];
  const record =
    () =>
    (...args: unknown[]) => {
      entries.push(args);
    };
  return { logger: { warn: record(), error: record() }, entries };
}

const VALID_TIP: TipEvent = {
  username: "viewer1",
  displayName: "Viewer1",
  amount: 5,
  currency: "USD",
  message: "build a slot machine",
  tipId: "abc123",
};

describe("TipEventSchema", () => {
  it("accepts a well-formed tip and surfaces the donor message field", () => {
    const parsed = TipEventSchema.safeParse(VALID_TIP);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.message).toBe("build a slot machine");
  });

  it("rejects a tip with a bad currency length or negative amount", () => {
    expect(TipEventSchema.safeParse({ ...VALID_TIP, currency: "US" }).success).toBe(false);
    expect(TipEventSchema.safeParse({ ...VALID_TIP, amount: -1 }).success).toBe(false);
  });
});

describe("makeDonationSource", () => {
  it("emits the jwt authenticate handshake on connect", () => {
    const fake = fakeSocket();
    makeDonationSource(fake.socket, "jwt-token-xyz");
    fake.fire("connect");
    expect(fake.emitted).toEqual([
      { event: "authenticate", args: [{ method: "jwt", token: "jwt-token-xyz" }] },
    ]);
  });

  it("re-authenticates on every reconnect (connect fires again)", () => {
    const fake = fakeSocket();
    makeDonationSource(fake.socket, "jwt-token-xyz");
    fake.fire("connect");
    fake.fire("connect");
    expect(fake.emitted).toHaveLength(2);
  });

  it("dispatches a well-formed tip activity to onTip handlers", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt");
    const received: TipEvent[] = [];
    source.onTip((tip) => received.push(tip));
    fake.fire("event", { type: "tip", data: VALID_TIP });
    expect(received).toEqual([VALID_TIP]);
  });

  it("drops a malformed tip payload without throwing or calling onTip", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt");
    let calls = 0;
    source.onTip(() => calls++);
    expect(() =>
      fake.fire("event", { type: "tip", data: { ...VALID_TIP, currency: "US" } }),
    ).not.toThrow();
    expect(calls).toBe(0);
  });

  it("drops a non-tip activity (e.g. cheer) silently", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt");
    let calls = 0;
    source.onTip(() => calls++);
    fake.fire("event", { type: "cheer", data: { amount: 100 } });
    fake.fire("event", "not even an object");
    fake.fire("event", null);
    expect(calls).toBe(0);
  });

  it("fail-closed: a throwing tip handler is caught and logged, socket stays up", () => {
    const fake = fakeSocket();
    const { logger, entries } = capturingLogger();
    const source = makeDonationSource(fake.socket, "jwt", logger);
    source.onTip(() => {
      throw new Error("handler boom");
    });
    const laterCalls: TipEvent[] = [];
    source.onTip((tip) => laterCalls.push(tip));
    expect(() => fake.fire("event", { type: "tip", data: VALID_TIP })).not.toThrow();
    expect(entries.length).toBeGreaterThan(0);
    // A subsequent tip still dispatches — the socket handler was not killed.
    fake.fire("event", { type: "tip", data: { ...VALID_TIP, tipId: "def456" } });
    expect(laterCalls.map((t) => t.tipId)).toContain("def456");
  });

  it("onReady fires on connect; onDisconnect fires on disconnect (logged as transient)", () => {
    const fake = fakeSocket();
    const { logger, entries } = capturingLogger();
    const source: DonationEventSource = makeDonationSource(fake.socket, "jwt", logger);
    let ready = 0;
    let disconnected = 0;
    source.onReady(() => ready++);
    source.onDisconnect(() => disconnected++);
    fake.fire("connect");
    fake.fire("disconnect", "transport close");
    expect(ready).toBe(1);
    expect(disconnected).toBe(1);
    // The disconnect is logged as a transient warn, never a crash.
    expect(entries.length).toBeGreaterThan(0);
  });
});
