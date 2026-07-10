import { describe, expect, it } from "vitest";
import {
  isMissingRedemptionScopeError,
  makeRedemptionSource,
  REDEMPTION_SCOPE,
  type RedemptionEvent,
  RedemptionEventSchema,
  toCandidate,
} from "./redemption-source.js";
import { TWITCH_SCOPES } from "./twitch-auth.js";

const VALID_REDEMPTION: RedemptionEvent = {
  id: "redemption-1",
  broadcaster_user_id: "1000",
  user_id: "2000",
  user_login: "viewer1",
  user_name: "Viewer1",
  user_input: "build a pomodoro timer",
  status: "unfulfilled",
  reward: { id: "reward-9", title: "Direct a build", cost: 500 },
  redeemed_at: "2026-07-10T05:00:00Z",
};

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

describe("RedemptionEventSchema", () => {
  it("accepts a well-formed snake_case redemption payload", () => {
    expect(RedemptionEventSchema.safeParse(VALID_REDEMPTION).success).toBe(true);
  });

  it("rejects a payload missing user_input or with a non-numeric reward cost", () => {
    const { user_input: _drop, ...noInput } = VALID_REDEMPTION;
    expect(RedemptionEventSchema.safeParse(noInput).success).toBe(false);
    expect(
      RedemptionEventSchema.safeParse({
        ...VALID_REDEMPTION,
        reward: { ...VALID_REDEMPTION.reward, cost: "free" },
      }).success,
    ).toBe(false);
  });
});

describe("makeRedemptionSource", () => {
  it("dispatches a valid redemption fed through handleRaw to onRedemption handlers", () => {
    const source = makeRedemptionSource();
    const received: RedemptionEvent[] = [];
    source.onRedemption((r) => received.push(r));
    source.handleRaw(VALID_REDEMPTION);
    expect(received).toEqual([VALID_REDEMPTION]);
  });

  it("drops a malformed payload without throwing or calling onRedemption", () => {
    const source = makeRedemptionSource();
    let calls = 0;
    source.onRedemption(() => calls++);
    expect(() => source.handleRaw({ id: "x", not: "a redemption" })).not.toThrow();
    expect(() => source.handleRaw(null)).not.toThrow();
    expect(() => source.handleRaw("garbage")).not.toThrow();
    expect(calls).toBe(0);
  });

  it("fail-closed: a throwing handler is caught and logged, listener stays up", () => {
    const { logger, entries } = capturingLogger();
    const source = makeRedemptionSource(logger);
    source.onRedemption(() => {
      throw new Error("handler boom");
    });
    const later: RedemptionEvent[] = [];
    source.onRedemption((r) => later.push(r));
    expect(() => source.handleRaw(VALID_REDEMPTION)).not.toThrow();
    // The throwing handler does not starve the second handler (per-handler isolation).
    expect(later).toEqual([VALID_REDEMPTION]);
    expect(entries.length).toBeGreaterThan(0);
    // A subsequent redemption still dispatches — the listener was not killed.
    source.handleRaw({ ...VALID_REDEMPTION, id: "redemption-2" });
    expect(later.map((r) => r.id)).toContain("redemption-2");
  });
});

describe("toCandidate", () => {
  it("maps a redemption into a channel_points SuggestionCandidate", () => {
    const candidate = toCandidate(VALID_REDEMPTION);
    expect(candidate.source).toBe("channel_points");
    expect(candidate.kind).toBe("suggestion");
    expect(candidate.text).toBe("build a pomodoro timer");
    // Stable donor identifier (user_id), not the mutable/spoofable display name.
    expect(candidate.twitchUsername).toBe("2000");
    expect(candidate.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof candidate.submittedAtMs).toBe("number");
  });

  it("gives each candidate a distinct id", () => {
    expect(toCandidate(VALID_REDEMPTION).id).not.toBe(toCandidate(VALID_REDEMPTION).id);
  });
});

describe("channel:read:redemptions scope (D-02 SCOPE CORRECTION)", () => {
  it("REDEMPTION_SCOPE is present in TWITCH_SCOPES (kept in sync)", () => {
    expect(REDEMPTION_SCOPE).toBe("channel:read:redemptions");
    expect([...TWITCH_SCOPES]).toContain(REDEMPTION_SCOPE);
  });
});

describe("isMissingRedemptionScopeError (loud degraded-state primitive, 04-08/04-05)", () => {
  it("recognizes a scope-name error and a 401/403 scope error", () => {
    expect(isMissingRedemptionScopeError(new Error("missing scope channel:read:redemptions"))).toBe(
      true,
    );
    expect(isMissingRedemptionScopeError(new Error("401 Unauthorized: scope required"))).toBe(true);
    expect(isMissingRedemptionScopeError("403 Forbidden — required scope not granted")).toBe(true);
  });

  it("does not flag an unrelated error (no false-positive degraded state)", () => {
    expect(isMissingRedemptionScopeError(new Error("socket timeout"))).toBe(false);
    expect(isMissingRedemptionScopeError(undefined)).toBe(false);
    expect(isMissingRedemptionScopeError(null)).toBe(false);
  });
});
