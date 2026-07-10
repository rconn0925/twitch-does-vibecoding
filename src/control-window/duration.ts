/**
 * Amount→duration mapping for paid-influence control windows (D-04).
 *
 * `amountToDurationSeconds` is the pure, config-driven heart of PAID-01/02: a
 * linear map with a FLOOR and a HARD CAP so a large donation can never buy an
 * unbounded window (T-04-07). It performs no I/O — the env-config loaders below
 * follow `round.ts`'s `roundDurationMs()` "parse env or fall back to a documented
 * default, never NaN/negative" discipline, and hand the resulting config to the
 * pure function.
 *
 * The SHAPE (linear-capped + per-donor cooldown) is locked by D-04; the specific
 * constants are streamer-tunable [ASSUMED defaults, flagged for confirmation].
 * This module never imports the gate, the queue, or an RNG (the paid side of the
 * D-08 separation).
 */

/** Linear-with-floor-and-cap config for one trigger type (donation or redemption). */
export interface DurationConfig {
  /** Seconds of window per amount unit (dollars for donations, points for redemptions). */
  ratePerUnit: number;
  /** Minimum window length regardless of amount (floor). */
  minSeconds: number;
  /** Maximum window length regardless of amount (hard cap — prevents monopolizing the show). */
  maxSeconds: number;
}

// [ASSUMED defaults — Claude's judgment, streamer-tunable; flag for confirmation.]
// Donation: a $5 tip ≈ 60s (ratePerUnit 12), a $1 tip still clears a 30s floor,
// and no single tip can exceed a 5-minute (300s) segment.
const DONATION_DEFAULTS: DurationConfig = { ratePerUnit: 12, minSeconds: 30, maxSeconds: 300 };
// Redemption: channel-points cost is the amount input, on its own smaller scale —
// ~1000 points ≈ 30s, capped at 2 minutes so points windows stay shorter than tips.
const REDEMPTION_DEFAULTS: DurationConfig = {
  ratePerUnit: 0.03,
  minSeconds: 30,
  maxSeconds: 120,
};
// Per-donor cooldown (D-04) — a SEPARATE guard from the one-active-window rule.
const DEFAULT_COOLDOWN_SECONDS = 120;

/**
 * Linear-with-floor-and-cap: duration = clamp(amount * rate, min, max).
 *
 * Pure and hostile-input-safe: NaN (no valid amount) collapses to the floor;
 * a negative amount collapses to the floor; an absurdly large / +Infinity amount
 * clamps to the hard cap. The clamp is written explicitly because Math.max(NaN, x)
 * is NaN in JS. Never returns NaN, never returns unbounded.
 */
export function amountToDurationSeconds(amount: number, cfg: DurationConfig): number {
  const raw = amount * cfg.ratePerUnit;
  if (Number.isNaN(raw) || raw < cfg.minSeconds) return cfg.minSeconds;
  if (raw > cfg.maxSeconds) return cfg.maxSeconds;
  return raw;
}

/** Parse a positive number from env, or fall back to a documented default (never NaN/negative). */
function parseEnvNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** D-04 donation window config from env (DONATION_WINDOW_*), with documented defaults. */
export function loadDonationDurationConfig(): DurationConfig {
  return {
    ratePerUnit: parseEnvNumber(
      process.env.DONATION_WINDOW_RATE_PER_UNIT,
      DONATION_DEFAULTS.ratePerUnit,
    ),
    minSeconds: parseEnvNumber(
      process.env.DONATION_WINDOW_MIN_SECONDS,
      DONATION_DEFAULTS.minSeconds,
    ),
    maxSeconds: parseEnvNumber(
      process.env.DONATION_WINDOW_MAX_SECONDS,
      DONATION_DEFAULTS.maxSeconds,
    ),
  };
}

/** D-04 channel-points redemption window config from env (REDEMPTION_WINDOW_*); reward.cost is the amount input. */
export function loadRedemptionDurationConfig(): DurationConfig {
  return {
    ratePerUnit: parseEnvNumber(
      process.env.REDEMPTION_WINDOW_RATE_PER_UNIT,
      REDEMPTION_DEFAULTS.ratePerUnit,
    ),
    minSeconds: parseEnvNumber(
      process.env.REDEMPTION_WINDOW_MIN_SECONDS,
      REDEMPTION_DEFAULTS.minSeconds,
    ),
    maxSeconds: parseEnvNumber(
      process.env.REDEMPTION_WINDOW_MAX_SECONDS,
      REDEMPTION_DEFAULTS.maxSeconds,
    ),
  };
}

/** Per-donor cooldown in milliseconds (WINDOW_COOLDOWN_SECONDS env, default 120s). */
export function cooldownMs(): number {
  return parseEnvNumber(process.env.WINDOW_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS) * 1_000;
}
