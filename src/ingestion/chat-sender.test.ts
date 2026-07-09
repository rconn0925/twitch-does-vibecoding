import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSender } from "./chat-sender.js";

interface SinkCall {
  broadcasterId: string;
  text: string;
}

function fakeSink() {
  const calls: SinkCall[] = [];
  return {
    calls,
    sink: {
      sendChatMessage: (broadcasterId: string, text: string): Promise<unknown> => {
        calls.push({ broadcasterId, text });
        return Promise.resolve();
      },
    },
  };
}

function fakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createChatSender — delivery", () => {
  it("send() resolves after the sink was called once with (broadcasterId, text)", async () => {
    const { calls, sink } = fakeSink();
    const sender = createChatSender({ sink, broadcasterId: "b123" });
    await sender.send("hi");
    expect(calls).toEqual([{ broadcasterId: "b123", text: "hi" }]);
  });

  it("messages send in FIFO order", async () => {
    const { calls, sink } = fakeSink();
    const sender = createChatSender({ sink, broadcasterId: "b123" });
    await Promise.all([sender.send("first"), sender.send("second"), sender.send("third")]);
    expect(calls.map((c) => c.text)).toEqual(["first", "second", "third"]);
  });

  it("truncates messages longer than 500 chars before the sink is called", async () => {
    const { calls, sink } = fakeSink();
    const sender = createChatSender({ sink, broadcasterId: "b123" });
    await sender.send("x".repeat(600));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("x".repeat(500));
    // Exactly 500 passes through untouched.
    await sender.send("y".repeat(500));
    expect(calls[1]?.text).toBe("y".repeat(500));
  });
});

describe("createChatSender — rate budget (D2-08)", () => {
  it("with intervalCap 2 / intervalMs 1000, the third rapid send waits for the interval", async () => {
    vi.useFakeTimers();
    const { calls, sink } = fakeSink();
    const sender = createChatSender({
      sink,
      broadcasterId: "b123",
      intervalCap: 2,
      intervalMs: 1000,
    });

    const sends = [sender.send("m1"), sender.send("m2"), sender.send("m3")];

    // Let the queue start work without advancing the clock: two go out.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.text)).toEqual(["m1", "m2"]);
    expect(sender.pending).toBeGreaterThanOrEqual(1);

    // The third is only delivered after the interval elapses.
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.map((c) => c.text)).toEqual(["m1", "m2"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => c.text)).toEqual(["m1", "m2", "m3"]);

    await Promise.all(sends);
    expect(sender.pending).toBe(0);
  });
});

describe("createChatSender — fail-closed", () => {
  it("a rejecting sink does NOT propagate: send() resolves and the failure is logged", async () => {
    const logger = fakeLogger();
    const sink = {
      sendChatMessage: (): Promise<unknown> => Promise.reject(new Error("helix 500")),
    };
    const sender = createChatSender({
      sink,
      broadcasterId: "b123",
      // biome-ignore lint/suspicious/noExplicitAny: minimal structural fake logger
      logger: logger as any,
    });
    await expect(sender.send("hello")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
