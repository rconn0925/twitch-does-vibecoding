# Design: screening the LIVE-RENDERED preview (the #1 broadcast-safety gap)

**Status:** proposal — needs Ross's decision (the options differ in show *feel*, which is your call, not mine).
**Written:** 2026-07-11 overnight, for morning review.

## The gap (confirmed in code)

The compliance gate has two points, both **source-level**:
- `screenBuildPlan` — screens the incoming suggestion *text* (build-session.ts:831)
- `screenOutputBatch` — screens the *code* the agent writes, i.e. Write/Edit/NotebookEdit text (build-session.ts:577)

Nothing screens what the app **renders** when the preview iframes the sandbox dev server onto the broadcast (`src/preview/public/preview.js` sets `iframe.src = devServerUrl`; nothing in `src/preview/**` screens content).

**Why that's the headline risk:** code can be clean at the source level and violate Twitch ToS *on screen*. Examples that pass both current checks but render badly live:
- HTML that displays attacker-chosen text (slur, doxx, harassment) — the file write is "just text in a div"
- `<img src="https://…">` / CSS `background-image` pulling remote explicit imagery — the write is a benign URL
- A page that renders something innocuous for the agent but animates/reveals something else client-side
- Compositional: several innocent tweaks assemble a phishing clone of a real login page

Secondary, same surface: the preview iframe is `sandbox="allow-scripts allow-forms allow-same-origin"`. `allow-scripts` + `allow-same-origin` **together** is the documented sandbox-escape combo, and there is **no CSP** on the framed content — so chat-authored JS runs in OBS's Chromium at your IP and can `fetch()` anywhere (trackers, beacons, exfil of anything the page can see).

## Options (pick one; they trade show-feel against safety)

### Option A — Broadcast delay on the preview (simplest, strong)
Insert an N-second delay (e.g. 15–30s) between the sandbox dev server and what the *broadcast* preview shows. You (or a lightweight auto-check) get an N-second window to catch bad renders before they hit air. Twitch already runs streams with delay; this is the industry-standard answer to "live uncontrolled surface."
- **Pros:** dead simple, catches EVERYTHING (visual, not just code), no AI-judgment gap. Also gives your kill switch time to act before bad frames air.
- **Cons:** changes the show's feel — chat sees results N seconds after they happen; reduces the "instant" magic. Needs an operator glance or a screenshot-check to use the window.
- **Effort:** medium. A second "broadcast preview" surface that lags the live one, or an OBS-side delay filter on just the preview source (OBS has a per-source Render Delay filter — could be zero-code: add a Video Delay/Render Delay filter to the preview browser source. Verify it applies to browser sources).

### Option B — Screenshot-and-classify the rendered page (automated, AI-judged)
Headless-render the app in the sandbox, screenshot it after each build (and/or periodically), run the screenshot through a vision classifier for ToS content before the broadcast preview swaps to the new build.
- **Pros:** automated, no operator burden, screens the actual pixels.
- **Cons:** adds latency per build; vision-classify has its own false-neg/false-pos rate; more infra (headless browser in the sandbox, a vision call per build — more plan cost); doesn't catch *time-varying* renders (something that changes 10s after load).
- **Effort:** high.

### Option C — Lock down the iframe + CSP (mitigates the JS/network surface, NOT the visual gap)
Drop `allow-same-origin` (or `allow-scripts`, depending on what built apps need) and add a strict CSP on the dev-server responses (no remote `img`/`script`/`connect`). Kills remote-image ToS content and outbound exfil.
- **Pros:** cheap, closes the network/JS blast radius and the remote-image vector.
- **Cons:** does NOT address locally-rendered violating content (attacker text, local CSS). Also may break legit builds that fetch a CDN or load an image — which for a "build me an app" show might be common. Partial fix.
- **Effort:** low.

## Recommendation

**Ship C now (cheap, no downside to the format) AND adopt A for broadcast (the real safety net).** C shrinks the blast radius immediately at near-zero cost; A is the honest answer to "an uncontrolled surface is live on air" and pairs perfectly with your existing kill switch (the delay window is when you'd hit it). B is over-engineering for v1 — revisit if you want to remove the operator from the loop later.

Concretely for night one: add the OBS Render Delay filter to the preview source (verify it works on browser sources — if not, build the lagged second surface), tighten the iframe sandbox + add a dev-server CSP, and keep your finger near the kill switch during the delay window.

**Decision needed from you:** (1) A, B, C, or a mix? (2) If A, what delay length and do you want a manual operator check or an automated screenshot-check in the window? (3) For C, are chat-built apps allowed to load remote images/CDNs at all, or is fully-local-only acceptable? Once you pick, I'll build it.

## Note
This gap is NOT on the existing go-live gate checklist — that list covers "does the loop work," not "is the live rendered surface safe." It should become a Phase 5 dry-run line item regardless of which option you choose.
