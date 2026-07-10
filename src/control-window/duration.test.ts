import { afterEach, describe, expect, it } from "vitest";
import {
  amountToDurationSeconds,
  cooldownMs,
  loadDonationDurationConfig,
  loadRedemptionDurationConfig,
} from "./duration.js";

const DONATION = { ratePerUnit: 12, minSeconds: 30, maxSeconds: 300 };

describe("amountToDurationSeconds (D-04 linear+floor+cap)", () => {
  it("returns the floor when amount*rate is below minSeconds", () => {
    // 1 * 12 = 12 < 30 → floor
    expect(amountToDurationSeconds(1, DONATION)).toBe(30);
  });

  it("returns the hard cap for a large amount — never unbounded", () => {
    // 1000 * 12 = 12000, clamped to 300
    expect(amountToDurationSeconds(1000, DONATION)).toBe(300);
  });

  it("returns the linear value for a $5-shaped tip (≈60s)", () => {
    expect(amountToDurationSeconds(5, DONATION)).toBe(60);
  });

  it("never returns NaN or a negative value for hostile amounts", () => {
    expect(amountToDurationSeconds(Number.NaN, DONATION)).toBe(30);
    expect(amountToDurationSeconds(-100, DONATION)).toBe(30);
    expect(amountToDurationSeconds(Number.POSITIVE_INFINITY, DONATION)).toBe(300);
  });
});

describe("duration config env loaders (parse-or-default discipline)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("loadDonationDurationConfig falls back to the documented defaults", () => {
    delete process.env.DONATION_WINDOW_RATE_PER_UNIT;
    delete process.env.DONATION_WINDOW_MIN_SECONDS;
    delete process.env.DONATION_WINDOW_MAX_SECONDS;
    const cfg = loadDonationDurationConfig();
    expect(cfg).toEqual({ ratePerUnit: 12, minSeconds: 30, maxSeconds: 300 });
    // A $5 tip maps to ~60s under the defaults.
    expect(amountToDurationSeconds(5, cfg)).toBe(60);
  });

  it("loadDonationDurationConfig honors env and rejects garbage/negative", () => {
    process.env.DONATION_WINDOW_RATE_PER_UNIT = "20";
    process.env.DONATION_WINDOW_MIN_SECONDS = "not-a-number";
    process.env.DONATION_WINDOW_MAX_SECONDS = "-5";
    const cfg = loadDonationDurationConfig();
    expect(cfg.ratePerUnit).toBe(20);
    expect(cfg.minSeconds).toBe(30); // garbage → default
    expect(cfg.maxSeconds).toBe(300); // negative → default
  });

  it("loadRedemptionDurationConfig is a separate, smaller-scale config", () => {
    delete process.env.REDEMPTION_WINDOW_RATE_PER_UNIT;
    delete process.env.REDEMPTION_WINDOW_MIN_SECONDS;
    delete process.env.REDEMPTION_WINDOW_MAX_SECONDS;
    const cfg = loadRedemptionDurationConfig();
    expect(cfg.minSeconds).toBeGreaterThan(0);
    expect(cfg.maxSeconds).toBeGreaterThan(cfg.minSeconds);
    // channel-points cost is the amount input; a small cost still clears the floor.
    expect(amountToDurationSeconds(1, cfg)).toBe(cfg.minSeconds);
    // A large redemption cost is still capped.
    expect(amountToDurationSeconds(1_000_000, cfg)).toBe(cfg.maxSeconds);
  });

  it("cooldownMs falls back to a positive default and honors env", () => {
    delete process.env.WINDOW_COOLDOWN_SECONDS;
    expect(cooldownMs()).toBeGreaterThan(0);
    process.env.WINDOW_COOLDOWN_SECONDS = "45";
    expect(cooldownMs()).toBe(45_000);
    process.env.WINDOW_COOLDOWN_SECONDS = "garbage";
    expect(cooldownMs()).toBeGreaterThan(0);
  });
});
