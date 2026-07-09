/**
 * Global panic hotkey: double-tap-within-2s debounce (D-01, D-03).
 *
 * This module contains NO uiohook-napi import. The native hook is an injected
 * dependency (KeyEventSource) so vitest never loads native code; only
 * src/main.ts's entrypoint path performs the real (guarded) import.
 */

/** D-03: the second tap must land within this window to trigger the halt. */
export const DOUBLE_TAP_WINDOW_MS = 2000;

/**
 * F13 by default: F13-F24 exist on macro pads / remappable keyboards and
 * nothing on Windows binds them OS-wide (RESEARCH.md: avoid keys with
 * OS/OBS-wide bindings).
 */
export const DEFAULT_PANIC_KEY = "F13";

/** Minimal structural logger — pino's Logger satisfies this. */
export interface PanicLogger {
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

export interface DoubleTapDetector {
  /** Feed one panic-key press. Callers pass a timestamp in tests; defaults to Date.now(). */
  tap(nowMs?: number): void;
}

/**
 * Pure debounce state machine (RESEARCH.md Pattern 4), separated from the
 * native binding so it is unit-testable with fake timestamps.
 *
 * States: disarmed -> (tap) -> armed -> (tap within window) -> FIRE + disarmed.
 * A tap outside the window re-arms; a fire fully resets, so an immediate
 * third tap only re-arms and can never re-trigger (D-03).
 */
export function createDoubleTapDetector(windowMs: number, onFire: () => void): DoubleTapDetector {
  let armedAtMs: number | null = null;
  return {
    tap(nowMs: number = Date.now()): void {
      if (armedAtMs !== null && nowMs - armedAtMs <= windowMs) {
        armedAtMs = null; // reset BEFORE firing: a throwing onFire can't leave us armed
        onFire();
        return;
      }
      armedAtMs = nowMs;
    },
  };
}

/** The subset of uIOhook this module needs — uiohook-napi's uIOhook satisfies it. */
export interface KeyEventSource {
  on(event: "keydown", handler: (e: { keycode: number }) => void): unknown;
  off(event: "keydown", handler: (e: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

export interface StartHotkeyOptions {
  /** Key name from PANIC_HOTKEY env; unknown names fall back to F13 with a warning. */
  key?: string | undefined;
  onPanic: () => void;
  logger: PanicLogger;
  /** The global hook (real: uIOhook). Injected so tests never touch native code. */
  hook: KeyEventSource;
  /** Key-name -> keycode map (real: UiohookKey). */
  keyMap: Record<string, number>;
}

export interface HotkeyHandle {
  /** The key name actually armed (after any fallback). */
  key: string;
  stop(): void;
}

export function startHotkeyListener(opts: StartHotkeyOptions): HotkeyHandle {
  const requested = opts.key ?? DEFAULT_PANIC_KEY;
  let name = requested;
  let keycode = opts.keyMap[requested];
  if (typeof keycode !== "number") {
    opts.logger.warn(
      { requested },
      "unknown PANIC_HOTKEY %s — falling back to %s",
      requested,
      DEFAULT_PANIC_KEY,
    );
    name = DEFAULT_PANIC_KEY;
    keycode = opts.keyMap[DEFAULT_PANIC_KEY];
    if (typeof keycode !== "number") {
      throw new Error(`key map has no ${DEFAULT_PANIC_KEY} entry — cannot arm panic hotkey`);
    }
  }
  const panicKeycode = keycode;

  const detector = createDoubleTapDetector(DOUBLE_TAP_WINDOW_MS, opts.onPanic);
  // Other keys are ignored entirely: they neither arm nor reset the timer (D-03).
  const onKeydown = (e: { keycode: number }): void => {
    if (e.keycode === panicKeycode) {
      detector.tap();
    }
  };

  opts.hook.on("keydown", onKeydown);
  opts.hook.start();

  return {
    key: name,
    stop(): void {
      opts.hook.off("keydown", onKeydown);
      opts.hook.stop();
    },
  };
}
