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

/** Flatten a capturingLogger's recorded arg arrays into one searchable string. */
function loggedText(entries: unknown[]): string {
  return entries.map((args) => JSON.stringify(args)).join("\n");
}

/** A well-formed SE dashboard simulator envelope (event:test shape, NOT the real `event` shape). */
const VALID_TEST_ENVELOPE = {
  listener: "tip-latest",
  event: { name: "fake_donator", amount: 25, message: "build a slot machine" },
};

describe("makeDonationSource — flag-gated event:test (SE simulator) path", () => {
  it("(a) flag off: event:test payloads are completely ignored — no options", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt");
    let calls = 0;
    source.onTip(() => calls++);
    expect(() => fake.fire("event:test", VALID_TEST_ENVELOPE)).not.toThrow();
    expect(calls).toBe(0);
  });

  it("(a) flag off: event:test payloads are completely ignored — acceptTestEvents: false", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt", undefined, { acceptTestEvents: false });
    let calls = 0;
    source.onTip(() => calls++);
    expect(() => fake.fire("event:test", VALID_TEST_ENVELOPE)).not.toThrow();
    expect(calls).toBe(0);
  });

  it("(b) flag on: a simulated tip flows through the real pipeline to onTip, loudly logged", () => {
    const fake = fakeSocket();
    const { logger, entries } = capturingLogger();
    const source = makeDonationSource(fake.socket, "jwt", logger, { acceptTestEvents: true });
    const received: TipEvent[] = [];
    source.onTip((tip) => received.push(tip));
    fake.fire("event:test", VALID_TEST_ENVELOPE);
    expect(received).toHaveLength(1);
    const tip = received[0];
    expect(tip?.username).toBe("fake_donator");
    expect(tip?.displayName).toBe("fake_donator");
    expect(tip?.amount).toBe(25);
    expect(tip?.currency).toBe("USD");
    expect(tip?.message).toBe("build a slot machine");
    expect(tip?.tipId).toMatch(/^se-test-/);
    expect(loggedText(entries)).toContain("SE TEST EVENT accepted — SE_ACCEPT_TEST_EVENTS is ON");
  });

  it("(b2) flag on: explicit currency and _id are honored, not clobbered by defaults", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt", undefined, { acceptTestEvents: true });
    const received: TipEvent[] = [];
    source.onTip((tip) => received.push(tip));
    fake.fire("event:test", {
      listener: "tip-latest",
      event: { name: "fake_donator", amount: 25, message: "hi", currency: "EUR", _id: "abc" },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.currency).toBe("EUR");
    expect(received[0]?.tipId).toBe("abc");
  });

  it("(c) flag on: malformed payloads are dropped fail-closed (no throw, no onTip, logged)", () => {
    const fake = fakeSocket();
    const { logger, entries } = capturingLogger();
    const source = makeDonationSource(fake.socket, "jwt", logger, { acceptTestEvents: true });
    let calls = 0;
    source.onTip(() => calls++);
    const malformed: unknown[] = [
      { listener: "tip-latest", event: { amount: 25 } }, // missing name
      { listener: "tip-latest", event: { name: "x", amount: -5 } }, // negative amount
      { listener: "tip-latest", event: { name: "x", amount: "25" } }, // string amount
      { listener: "tip-latest", event: "not an object" }, // event not an object
      { listener: 42, event: { name: "x", amount: 1 } }, // listener not a string
      null,
      "not even an object",
    ];
    for (const payload of malformed) {
      expect(() => fake.fire("event:test", payload)).not.toThrow();
    }
    expect(calls).toBe(0);
    // Structurally-unrecognized payloads are logged (fail-closed but loud).
    expect(loggedText(entries)).toContain(
      "SE TEST EVENT dropped — unrecognized event:test payload shape",
    );
  });

  it("(c) flag on: a recognized non-tip listener is dropped SILENTLY (mirrors real cheer drop)", () => {
    const fake = fakeSocket();
    const { logger, entries } = capturingLogger();
    const source = makeDonationSource(fake.socket, "jwt", logger, { acceptTestEvents: true });
    let calls = 0;
    source.onTip(() => calls++);
    const entriesBefore = entries.length;
    fake.fire("event:test", { listener: "follow-latest", event: { name: "f", amount: 0 } });
    expect(calls).toBe(0);
    expect(entries.length).toBe(entriesBefore); // silent — no drop warn for non-tip listeners
  });

  it("(c2) flag on: a normalized-but-invalid candidate still fails the REAL TipEventSchema pipeline", () => {
    const fake = fakeSocket();
    const source = makeDonationSource(fake.socket, "jwt", undefined, { acceptTestEvents: true });
    let calls = 0;
    source.onTip(() => calls++);
    // currency "EU" (2 letters) passes the envelope schema but MUST be rejected
    // by TipEventSchema via the shared dispatchTipActivity pipeline (R2).
    expect(() =>
      fake.fire("event:test", {
        listener: "tip-latest",
        event: { name: "x", amount: 5, currency: "EU" },
      }),
    ).not.toThrow();
    expect(calls).toBe(0);
  });

  it("(d) flag on: construction immediately logs the TEST MODE warning; flag off does not", () => {
    const on = capturingLogger();
    const fakeOn = fakeSocket();
    makeDonationSource(fakeOn.socket, "jwt", on.logger, { acceptTestEvents: true });
    expect(loggedText(on.entries)).toContain(
      "TEST MODE: simulated StreamElements events will open real control windows — NEVER enable during a broadcast",
    );

    const off = capturingLogger();
    const fakeOff = fakeSocket();
    makeDonationSource(fakeOff.socket, "jwt", off.logger);
    expect(loggedText(off.entries)).not.toContain("TEST MODE");
  });
});
