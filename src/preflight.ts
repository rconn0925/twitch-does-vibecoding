/**
 * Broadcast-safety preflight (overnight security review, finding #8).
 *
 * Test/tuning knobs that are handy for solo dev are DANGEROUS if they reach a
 * live broadcast: a raised per-user pool cap lets one chatter flood the vote, a
 * near-zero intake cooldown removes flood protection, and the StreamElements
 * simulated-event flag opens REAL control windows from a dashboard button. None
 * of these can crash the show, so nothing stopped them reaching air — this
 * surfaces a LOUD warning at boot so "I left test values in" is caught before
 * the stream, not during it. It only warns (never refuses to boot): a streamer
 * may legitimately want a non-default value, and refusing to start would be its
 * own live-show footgun.
 */

export interface BroadcastSafetyWarning {
  key: string;
  value: string;
  message: string;
}

/** Pure: inspect the relevant env and return one warning per unsafe knob. */
export function collectBroadcastSafetyWarnings(
  env: Record<string, string | undefined>,
): BroadcastSafetyWarning[] {
  const warnings: BroadcastSafetyWarning[] = [];

  // SE_ACCEPT_TEST_EVENTS=true routes StreamElements DASHBOARD simulated tips
  // through the real pipeline — a test click opens a REAL free-reign window.
  if (env.SE_ACCEPT_TEST_EVENTS === "true") {
    warnings.push({
      key: "SE_ACCEPT_TEST_EVENTS",
      value: "true",
      message:
        "StreamElements SIMULATED events are being accepted — a dashboard test tip opens a REAL control window. NEVER leave this on during a broadcast.",
    });
  }

  // INTAKE_MAX_POOLED_PER_USER > 1 lets a single chatter hold several pool
  // slots (raised to fill a vote round solo while testing). On a live audience
  // it lets one person dominate the suggestion pool.
  const perUser = Number.parseFloat(env.INTAKE_MAX_POOLED_PER_USER ?? "");
  if (Number.isFinite(perUser) && perUser > 1) {
    warnings.push({
      key: "INTAKE_MAX_POOLED_PER_USER",
      value: String(env.INTAKE_MAX_POOLED_PER_USER),
      message:
        "One viewer may hold more than one pooled suggestion — a single chatter can dominate the pool. Set to 1 for a live audience.",
    });
  }

  // A very low intake cooldown removes per-user flood protection (dropped to 1s
  // for solo testing). Warn under 5s — a live show wants the ~60s default.
  const cooldown = Number.parseFloat(env.INTAKE_COOLDOWN_SECONDS ?? "");
  if (Number.isFinite(cooldown) && cooldown > 0 && cooldown < 5) {
    warnings.push({
      key: "INTAKE_COOLDOWN_SECONDS",
      value: String(env.INTAKE_COOLDOWN_SECONDS),
      message:
        "Per-user !suggest cooldown is very low — flood protection is effectively off. Restore ~60s for a live audience.",
    });
  }

  return warnings;
}
