import { describe, expect, it, vi } from "vitest";
import { openDb } from "../audit/db.js";
import { listAuditRecords } from "../audit/record.js";
import { armPanicHotkey } from "../main.js";
import { StreamModeMachine } from "../state-machine/stream-mode.js";
import {
  createDoubleTapDetector,
  DEFAULT_PANIC_KEY,
  DOUBLE_TAP_WINDOW_MS,
  type KeyEventSource,
  startHotkeyListener,
} from "./hotkey.js";

/**
 * Test double for uIOhook. The real uiohook-napi native module must NEVER be
 * loaded in any test's import graph — hotkey.ts takes the hook as an injected
 * dependency, and only src/main.ts's entrypoint path imports the native module.
 */
class FakeHook implements KeyEventSource {
  handlers = new Set<(e: { keycode: number }) => void>();
  startCalls = 0;
  stopCalls = 0;

  on(_event: "keydown", handler: (e: { keycode: number }) => void): void {
    this.handlers.add(handler);
  }

  off(_event: "keydown", handler: (e: { keycode: number }) => void): void {
    this.handlers.delete(handler);
  }

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  press(keycode: number): void {
    for (const handler of [...this.handlers]) {
      handler({ keycode });
    }
  }
}

const KEY_MAP: Record<string, number> = { F13: 91, F14: 92, A: 30 };

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createDoubleTapDetector (pure debounce, D-03)", () => {
  it("a single tap never fires", () => {
    const onFire = vi.fn();
    const detector = createDoubleTapDetector(DOUBLE_TAP_WINDOW_MS, onFire);
    detector.tap(0);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("a second tap within the 2000ms window fires exactly once", () => {
    const onFire = vi.fn();
    const detector = createDoubleTapDetector(DOUBLE_TAP_WINDOW_MS, onFire);
    detector.tap(0);
    detector.tap(2000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a second tap at 2001ms does NOT fire and re-arms instead", () => {
    const onFire = vi.fn();
    const detector = createDoubleTapDetector(DOUBLE_TAP_WINDOW_MS, onFire);
    detector.tap(0);
    detector.tap(2001);
    expect(onFire).not.toHaveBeenCalled();
    // The 2001ms tap re-armed: a follow-up within its window fires.
    detector.tap(3000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("after a fire the state resets — an immediate third tap does not re-trigger", () => {
    const onFire = vi.fn();
    const detector = createDoubleTapDetector(DOUBLE_TAP_WINDOW_MS, onFire);
    detector.tap(0);
    detector.tap(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    // Third tap immediately after the fire: must only ARM, never fire.
    detector.tap(1001);
    expect(onFire).toHaveBeenCalledTimes(1);
    // ...but two fresh taps trigger again.
    detector.tap(1500);
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});

describe("startHotkeyListener", () => {
  it("double-tapping the panic key fires onPanic exactly once", () => {
    const hook = new FakeHook();
    const onPanic = vi.fn();
    startHotkeyListener({ onPanic, logger: fakeLogger(), hook, keyMap: KEY_MAP });
    expect(hook.startCalls).toBe(1);
    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).toHaveBeenCalledTimes(1);
  });

  it("keydowns of other keys are ignored and do not reset the arm timer", () => {
    const hook = new FakeHook();
    const onPanic = vi.fn();
    startHotkeyListener({ onPanic, logger: fakeLogger(), hook, keyMap: KEY_MAP });
    // Other keys alone never arm: a lone panic tap after them must not fire.
    hook.press(KEY_MAP.A as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).not.toHaveBeenCalled();
    // Armed by the panic tap above; an interleaved other-key press does not
    // disturb the armed state — the second panic tap still fires.
    hook.press(KEY_MAP.A as number);
    hook.press(KEY_MAP.F14 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).toHaveBeenCalledTimes(1);
  });

  it("respects an explicit key option (PANIC_HOTKEY)", () => {
    const hook = new FakeHook();
    const onPanic = vi.fn();
    const handle = startHotkeyListener({
      key: "F14",
      onPanic,
      logger: fakeLogger(),
      hook,
      keyMap: KEY_MAP,
    });
    expect(handle.key).toBe("F14");
    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).not.toHaveBeenCalled();
    hook.press(KEY_MAP.F14 as number);
    hook.press(KEY_MAP.F14 as number);
    expect(onPanic).toHaveBeenCalledTimes(1);
  });

  it("stop() detaches the listener", () => {
    const hook = new FakeHook();
    const onPanic = vi.fn();
    const handle = startHotkeyListener({ onPanic, logger: fakeLogger(), hook, keyMap: KEY_MAP });
    handle.stop();
    expect(hook.handlers.size).toBe(0);
    expect(hook.stopCalls).toBe(1);
    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).not.toHaveBeenCalled();
  });

  it("unknown PANIC_HOTKEY value falls back to F13 with a warning", () => {
    const hook = new FakeHook();
    const onPanic = vi.fn();
    const logger = fakeLogger();
    const handle = startHotkeyListener({
      key: "NOT_A_KEY",
      onPanic,
      logger,
      hook,
      keyMap: KEY_MAP,
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(handle.key).toBe(DEFAULT_PANIC_KEY);
    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(onPanic).toHaveBeenCalledTimes(1);
  });
});

describe("armPanicHotkey (main.ts wiring — native import injected, never loaded here)", () => {
  it("arms the hotkey, logs the armed message, and a double-tap halts with source hotkey", async () => {
    const hook = new FakeHook();
    const machine = new StreamModeMachine();
    const db = openDb(":memory:");
    const logger = fakeLogger();
    const handle = await armPanicHotkey({
      machine,
      haltDeps: { db },
      logger,
      loadUiohook: async () => ({ uIOhook: hook, UiohookKey: KEY_MAP }),
    });
    expect(handle).not.toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("panic hotkey armed"),
      expect.anything(),
    );

    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(machine.mode).toBe("HALTED");
    const rows = listAuditRecords(db, { limit: 10, eventType: "halt" });
    expect(rows.some((r) => r.source === "hotkey")).toBe(true);
    db.close();
  });

  it("survives a native hook import failure with a loud error — console halt path stays alive", async () => {
    const machine = new StreamModeMachine();
    const db = openDb(":memory:");
    const logger = fakeLogger();
    const handle = await armPanicHotkey({
      machine,
      haltDeps: { db },
      logger,
      loadUiohook: async () => {
        throw new Error("prebuilt binary missing");
      },
    });
    expect(handle).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("PANIC HOTKEY UNAVAILABLE"),
    );
    expect(machine.mode).toBe("IDLE");
    db.close();
  });

  it("a double-tap while already HALTED does not overwrite the frozen triage snapshot", async () => {
    const hook = new FakeHook();
    const machine = new StreamModeMachine();
    machine.transition("VOTING_ROUND");
    const db = openDb(":memory:");
    const logger = fakeLogger();
    await armPanicHotkey({
      machine,
      haltDeps: { db },
      logger,
      loadUiohook: async () => ({ uIOhook: hook, UiohookKey: KEY_MAP }),
    });

    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(machine.mode).toBe("HALTED");
    expect(machine.snapshot().haltContext?.frozen.mode).toBe("VOTING_ROUND");

    // Panic again while HALTED: the D-04 triage snapshot must survive intact.
    hook.press(KEY_MAP.F13 as number);
    hook.press(KEY_MAP.F13 as number);
    expect(machine.snapshot().haltContext?.frozen.mode).toBe("VOTING_ROUND");
    db.close();
  });
});
