import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAOS_MODE_CHANGED } from "../shared/events.js";
import { ChaosModeController } from "./mode.js";

const DURATION_MS = 300_000;

function makeController(overrides: {
  onActivated?: (endsAtMs: number) => void;
  onExpired?: () => void;
  now?: () => number;
  durationMs?: number;
}) {
  return new ChaosModeController({
    durationMs: overrides.durationMs ?? DURATION_MS,
    onActivated: overrides.onActivated,
    onExpired: overrides.onExpired,
    now: overrides.now,
  });
}

describe("ChaosModeController — activate() opens the window (quick-260711-ly4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("activate() sets the absolute deadline and fires onActivated exactly once with endsAtMs", () => {
    const now = vi.fn(() => 1_000_000);
    const onActivated = vi.fn();
    const c = makeController({ now, onActivated });
    expect(c.snapshot()).toBeNull();
    c.activate();
    expect(c.snapshot()).toEqual({ endsAtMs: 1_000_000 + DURATION_MS });
    expect(onActivated).toHaveBeenCalledExactlyOnceWith(1_000_000 + DURATION_MS);
  });

  it("a second activate() while already live is an idempotent no-op (no re-arm, no second onActivated)", () => {
    const now = vi.fn(() => 2_000_000);
    const onActivated = vi.fn();
    const c = makeController({ now, onActivated });
    c.activate();
    const firstEndsAt = c.snapshot()?.endsAtMs;
    now.mockReturnValue(2_050_000); // clock advanced — a re-arm would move the deadline
    c.activate();
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(c.snapshot()?.endsAtMs).toBe(firstEndsAt); // deadline unchanged
  });

  it("emits CHAOS_MODE_CHANGED on activation", () => {
    const changed = vi.fn();
    const c = makeController({});
    c.on(CHAOS_MODE_CHANGED, changed);
    c.activate();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("ChaosModeController — expiry auto-revert (RS3-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expiry clears the active window, fires onExpired once, and emits CHAOS_MODE_CHANGED", () => {
    const onExpired = vi.fn();
    const changed = vi.fn();
    const c = makeController({ onExpired });
    c.on(CHAOS_MODE_CHANGED, changed);
    c.activate();
    expect(c.snapshot()).not.toBeNull();
    changed.mockClear();

    vi.advanceTimersByTime(DURATION_MS);
    expect(c.snapshot()).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);

    // No second firing later.
    vi.advanceTimersByTime(DURATION_MS * 2);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("a fresh activation after expiry works end-to-end (auto-revert then re-arm)", () => {
    const onActivated = vi.fn();
    const c = makeController({ onActivated });
    c.activate();
    vi.advanceTimersByTime(DURATION_MS);
    c.activate();
    expect(onActivated).toHaveBeenCalledTimes(2);
    expect(c.snapshot()).not.toBeNull();
  });
});

describe("ChaosModeController — clear() (HALT semantics, RS3-04)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clear() wipes the active window and fires NO onExpired (halt is not an expiry)", () => {
    const onExpired = vi.fn();
    const c = makeController({ onExpired });
    c.activate();
    c.clear();
    expect(c.snapshot()).toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
    // Timer is cancelled — nothing fires later.
    vi.advanceTimersByTime(DURATION_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
    // After a clear, a fresh activate() re-opens the window cleanly.
    c.activate();
    expect(c.snapshot()).not.toBeNull();
  });

  it("clear() with no active window is a safe no-op that still emits CHAOS_MODE_CHANGED", () => {
    const changed = vi.fn();
    const c = makeController({});
    c.on(CHAOS_MODE_CHANGED, changed);
    c.clear();
    expect(c.snapshot()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("clear() emits CHAOS_MODE_CHANGED when a window was live", () => {
    const changed = vi.fn();
    const c = makeController({});
    c.on(CHAOS_MODE_CHANGED, changed);
    c.activate();
    changed.mockClear();
    c.clear();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("ChaosModeController — snapshot shape + dispose (WR-05 symmetry)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("snapshot() is null before activation and exactly { endsAtMs } while active", () => {
    const now = () => 42_000;
    const c = makeController({ now });
    expect(c.snapshot()).toBeNull();
    c.activate();
    expect(c.snapshot()).toEqual({ endsAtMs: 42_000 + DURATION_MS });
    expect(Object.keys(c.snapshot() ?? {})).toEqual(["endsAtMs"]);
  });

  it("dispose() cancels the expiry timer (no onExpired after shutdown)", () => {
    const onExpired = vi.fn();
    const c = makeController({ onExpired });
    c.activate();
    c.dispose();
    vi.advanceTimersByTime(DURATION_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
