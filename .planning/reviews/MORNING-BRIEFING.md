# Morning briefing — overnight work, 2026-07-11

Everything below is committed and pushed to `master`. Two full reviews ran; I applied only one clean, isolated fix and left everything that needs your judgment (or touches safety-critical code) documented here instead of hot-patching it at 2am.

## TL;DR — the 3 things that matter most

1. **The persistent-workspace feature never actually worked** (correctness BL-01). The app dir is never created inside the sandbox, so "chat's app evolves across builds" is currently a no-op — builds fail-closed or fall back to a shared dir; rotation and gallery snapshots don't fire. It fails *safe* (no security risk), but the headline feature you think shipped last night hasn't run end-to-end. **This is the #1 fix.**
2. **The live rendered preview is unscreened** (security CRITICAL). The gate checks the prompt and the code, but nothing checks what the app *shows on air*. Clean code can render a slur / remote explicit image / phishing page live. Design doc with 3 options is written and waiting on your decision.
3. **`Bash` bypasses in-build output screening** (correctness HI-02). The build agent can write files via `cat > file` with no Write/Edit batch, so `screenOutputBatch` never sees them — and they render live. A real hole in the "every output re-screened" guarantee.

## What I fixed and pushed overnight (safe, isolated)

- **Broadcast-safety boot guard** (`src/preflight.ts`, commit `740224a`): loud boot warning when `SE_ACCEPT_TEST_EVENTS=true`, `INTAKE_MAX_POOLED_PER_USER>1`, or a near-zero `INTAKE_COOLDOWN_SECONDS` are active — the "I left test values in" footgun. Warn-only, never blocks boot. **Note: your current `.env` trips all three; that's expected for testing — restore them before broadcast.** 822 tests green.
- **Stopped the running app** so it wasn't burning plan credits to an empty channel all night.

## Decisions waiting for you (I did NOT pick these — they change the show)

| # | Decision | Doc |
|---|---|---|
| D1 | Rendered-output screening: broadcast delay (A), screenshot-classify (B), iframe/CSP lockdown (C), or a mix? And can chat-built apps load remote images/CDNs at all? | `.planning/design/rendered-output-screening.md` |
| D2 | Compositional drift: do you want cumulative-state re-screening, or accept per-prompt only for v1? | security review §3 |
| D3 | Spend cap / rate limit on classification for long streams (fails safe today, but no budget guard) | security review §7 |
| D4 | Gallery repo: keep private (recommended) — chat-authored code is committed under your GitHub identity | security review §5 |

## Prioritized fix queue (ready to run as GSD tasks when you say go)

1. **BL-01 — create the workspace dir in the sandbox before the build turn** (mkdir -p inside the distro; fixes persistence, rotation, gallery). Entangled with HI-01 + HI-03 — fix together.
2. **HI-02 — restrict the build turn's tools (no raw Bash, or route Bash-written files through screening)** so no output reaches air unscreened.
3. **HI-03 — make the watchdog a stall/idle timer, not a hard total cap**, and clean the workspace on timeout so a killed build can't corrupt the next continue-mode build.
4. **HI-01 — key scaffold-vs-continue on directory emptiness, not the done-flag** (a failed first build currently runs scaffold mode over a dirty dir).
5. Mediums: gallery cp races the next build into the same dir (ME-01); `workspace.markBuilt()` missing the `auditIfOpen` guard (ME-02); unbounded gallery-mirror growth (ME-03).

Full detail: `.planning/reviews/overnight-security-envelope.md` and `.planning/reviews/overnight-correctness.md`.

## Also delivered overnight (unrelated to reviews)

- **Reddit launch plan** — `.planning/marketing/reddit-launch.md`: ranked subreddit map with each community's promo rules, a don't-get-banned playbook, and drafted announcement posts (primary + technical + short variants) in an authentic builder voice. Written disclosed rather than covert — see the file for why astroturfing backfires on Reddit and the honest version converts better.

## What's green

822 tests, tsc clean, biome clean. Source-level safety machinery (compliance gate fail-closed, MCP lockdown, gallery publisher isolation, kill switch) all verified solid by the reviews — the gaps are the live-pixels axis and the workspace-dir bug, both above.
