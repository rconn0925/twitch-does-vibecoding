import { describe, expect, it } from "vitest";
import { collectBroadcastSafetyWarnings } from "./preflight.js";

describe("collectBroadcastSafetyWarnings", () => {
  it("returns no warnings for broadcast-safe defaults", () => {
    expect(
      collectBroadcastSafetyWarnings({
        INTAKE_MAX_POOLED_PER_USER: "1",
        INTAKE_COOLDOWN_SECONDS: "60",
        // SE_ACCEPT_TEST_EVENTS absent
      }),
    ).toEqual([]);
  });

  it("returns no warnings for a fully empty env (all defaults apply)", () => {
    expect(collectBroadcastSafetyWarnings({})).toEqual([]);
  });

  it("warns when SE_ACCEPT_TEST_EVENTS is exactly 'true'", () => {
    const w = collectBroadcastSafetyWarnings({ SE_ACCEPT_TEST_EVENTS: "true" });
    expect(w).toHaveLength(1);
    expect(w[0]?.key).toBe("SE_ACCEPT_TEST_EVENTS");
  });

  it("does NOT warn on non-'true' SE_ACCEPT_TEST_EVENTS values (strict match)", () => {
    for (const v of ["TRUE", "1", "yes", ""]) {
      expect(collectBroadcastSafetyWarnings({ SE_ACCEPT_TEST_EVENTS: v })).toEqual([]);
    }
  });

  it("warns when a user may hold more than one pooled suggestion", () => {
    const w = collectBroadcastSafetyWarnings({ INTAKE_MAX_POOLED_PER_USER: "10" });
    expect(w.map((x) => x.key)).toContain("INTAKE_MAX_POOLED_PER_USER");
  });

  it("does not warn at the safe value of 1", () => {
    expect(collectBroadcastSafetyWarnings({ INTAKE_MAX_POOLED_PER_USER: "1" })).toEqual([]);
  });

  it("warns on a near-zero intake cooldown but not on a healthy one", () => {
    expect(
      collectBroadcastSafetyWarnings({ INTAKE_COOLDOWN_SECONDS: "1" }).map((x) => x.key),
    ).toContain("INTAKE_COOLDOWN_SECONDS");
    expect(collectBroadcastSafetyWarnings({ INTAKE_COOLDOWN_SECONDS: "60" })).toEqual([]);
  });

  it("surfaces all active unsafe knobs at once (the exact current test .env)", () => {
    const w = collectBroadcastSafetyWarnings({
      INTAKE_COOLDOWN_SECONDS: "1",
      INTAKE_MAX_POOLED_PER_USER: "10",
      SE_ACCEPT_TEST_EVENTS: "true",
    });
    expect(w.map((x) => x.key).sort()).toEqual([
      "INTAKE_COOLDOWN_SECONDS",
      "INTAKE_MAX_POOLED_PER_USER",
      "SE_ACCEPT_TEST_EVENTS",
    ]);
  });
});
