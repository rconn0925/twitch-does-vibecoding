import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAOS_MODE_CHANGED } from "../shared/events.js";
import { ChaosModeController, type ChaosVoteResult } from "./mode.js";

const THRESHOLD = 3;
const DURATION_MS = 300_000;

function makeController(overrides: {
  onActivated?: (votes: number, endsAtMs: number) => void;
  onExpired?: () => void;
  now?: () => number;
  thresholdVotes?: number;
  durationMs?: number;
}) {
  return new ChaosModeController({
    thresholdVotes: overrides.thresholdVotes ?? THRESHOLD,
    durationMs: overrides.durationMs ?? DURATION_MS,
    onActivated: overrides.onActivated,
    onExpired: overrides.onExpired,
    now: overrides.now,
  });
}

describe("ChaosModeController — unique-user tally + activation threshold (RS3-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts unique users below the threshold and reports count/threshold", () => {
    const c = makeController({});
    expect(c.vote("u1")).toEqual({ kind: "counted", count: 1, threshold: THRESHOLD });
    expect(c.vote("u2")).toEqual({ kind: "counted", count: 2, threshold: THRESHOLD });
    expect(c.snapshot()).toBeNull();
  });

  it("ignores duplicate votes from the same user — the count never advances", () => {
    const c = makeController({});
    expect(c.vote("u1")).toEqual({ kind: "counted", count: 1, threshold: THRESHOLD });
    expect(c.vote("u1")).toEqual({ kind: "duplicate" });
    expect(c.vote("u1")).toEqual({ kind: "duplicate" });
    // A distinct user is still needed — the dupe never pushed us to 2.
    expect(c.vote("u2")).toEqual({ kind: "counted", count: 2, threshold: THRESHOLD });
    expect(c.snapshot()).toBeNull();
  });

  it("the threshold-th UNIQUE user activates: result carries votes + endsAtMs, tally resets", () => {
    const now = vi.fn(() => 1_000_000);
    const onActivated = vi.fn();
    const c = makeController({ now, onActivated });
    c.vote("u1");
    c.vote("u2");
    const result = c.vote("u3");
    expect(result).toEqual({
      kind: "activated",
      votes: 3,
      endsAtMs: 1_000_000 + DURATION_MS,
    });
    expect(onActivated).toHaveBeenCalledExactlyOnceWith(3, 1_000_000 + DURATION_MS);
    expect(c.snapshot()).toEqual({ endsAtMs: 1_000_000 + DURATION_MS });
  });

  it("emits CHAOS_MODE_CHANGED on activation", () => {
    const changed = vi.fn();
    const c = makeController({});
    c.on(CHAOS_MODE_CHANGED, changed);
    c.vote("u1");
    c.vote("u2");
    expect(changed).not.toHaveBeenCalled();
    c.vote("u3");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("votes while active are silent no-ops (already-active)", () => {
    const c = makeController({});
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
    expect(c.vote("u4")).toEqual({ kind: "already-active" });
    expect(c.vote("u1")).toEqual({ kind: "already-active" });
  });
});

describe("ChaosModeController — expiry auto-revert (RS3-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function activate(c: ChaosModeController): void {
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
  }

  it("expiry clears the active window, fires onExpired once, and emits CHAOS_MODE_CHANGED", () => {
    const onExpired = vi.fn();
    const changed = vi.fn();
    const c = makeController({ onExpired });
    c.on(CHAOS_MODE_CHANGED, changed);
    activate(c);
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

  it("tally stays reset after expiry — the next vote counts from 1", () => {
    const c = makeController({});
    activate(c);
    vi.advanceTimersByTime(DURATION_MS);
    expect(c.vote("u1")).toEqual({ kind: "counted", count: 1, threshold: THRESHOLD });
  });

  it("a fresh activation after expiry works end-to-end (auto-revert then re-arm)", () => {
    const onActivated = vi.fn();
    const c = makeController({ onActivated });
    activate(c);
    vi.advanceTimersByTime(DURATION_MS);
    activate(c);
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

  it("clear() wipes the tally AND the active window and fires NO onExpired (halt is not an expiry)", () => {
    const onExpired = vi.fn();
    const c = makeController({ onExpired });
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
    c.clear();
    expect(c.snapshot()).toBeNull();
    expect(onExpired).not.toHaveBeenCalled();
    // Timer is cancelled — nothing fires later.
    vi.advanceTimersByTime(DURATION_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
    // The tally is wiped too: a returning user counts from 1.
    expect(c.vote("u1")).toEqual({ kind: "counted", count: 1, threshold: THRESHOLD });
  });

  it("clear() wipes a mid-tally count with no active window", () => {
    const c = makeController({});
    c.vote("u1");
    c.vote("u2");
    c.clear();
    expect(c.vote("u1")).toEqual({ kind: "counted", count: 1, threshold: THRESHOLD });
  });

  it("clear() emits CHAOS_MODE_CHANGED", () => {
    const changed = vi.fn();
    const c = makeController({});
    c.on(CHAOS_MODE_CHANGED, changed);
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
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
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
    expect(c.snapshot()).toEqual({ endsAtMs: 42_000 + DURATION_MS });
    expect(Object.keys(c.snapshot() ?? {})).toEqual(["endsAtMs"]);
  });

  it("dispose() cancels the expiry timer (no onExpired after shutdown)", () => {
    const onExpired = vi.fn();
    const c = makeController({ onExpired });
    c.vote("u1");
    c.vote("u2");
    c.vote("u3");
    c.dispose();
    vi.advanceTimersByTime(DURATION_MS * 2);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("a custom threshold is honored exactly", () => {
    const c = makeController({ thresholdVotes: 1 });
    const result: ChaosVoteResult = c.vote("solo");
    expect(result.kind).toBe("activated");
  });
});
