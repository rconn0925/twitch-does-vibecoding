---
phase: quick-260716-1ki
plan: 01
subsystem: gallery-publishing
tags: [github-pages, gallery-index, info-commands, xss-escaping, static-apps]
requires:
  - quick-260711-hak (per-project gallery publisher + GalleryExec/GalleryFs seams)
  - quick-260711-t8k (tier-2 info-command mechanism)
provides:
  - GitHub Pages enablement on every pushed gallery repo (deploy-from-branch, root)
  - Static-app contract in both build system prompts (index.html at root, no build step/backend)
  - Public gallery index site regenerated + pushed to <owner>.github.io on the publisher chain
  - "!apps" chat command + Pages-preferring "!current" reply
affects:
  - src/orchestrator/gallery-publisher.ts (Pages + index publish steps)
  - src/orchestrator/prompt-boundary.ts (both fixed build prompts)
  - src/ingestion/command-parser.ts / narration.ts / main.ts (info tier)
tech-stack:
  added: []
  patterns:
    - never-reject publish step (T-hak-03 idiom reused for doPublishIndex + ensurePagesEnabled)
    - whitelist provenance coarsening replicated from history/server.ts (module-private there)
key-files:
  created:
    - src/orchestrator/gallery-index.ts
    - src/orchestrator/gallery-index.test.ts
  modified:
    - src/orchestrator/gallery-publisher.ts
    - src/orchestrator/gallery-publisher.test.ts
    - src/orchestrator/prompt-boundary.ts
    - src/orchestrator/prompt-boundary.test.ts
    - src/ingestion/command-parser.ts
    - src/ingestion/command-parser.test.ts
    - src/ingestion/narration.ts
    - src/ingestion/narration.test.ts
    - src/ingestion/twitch-chat.test.ts
    - src/main.ts
    - src/overlay/public/commands.html
    - src/overlay/commands-page.test.ts
    - tests/e2e/info-commands.e2e.test.ts
    - tests/e2e/recovery.e2e.test.ts
    - tests/e2e/swap-command.e2e.test.ts
decisions:
  - "Pages enablement runs after each successful PUSH, not at scaffold time (plan-directed deviation from the create-time idea: the create-Pages API 422s when the source branch does not exist on the remote yet); idempotent via 409 tolerance"
  - "publishNow's returned promise now resolves AFTER the chained index publish completes (same PublishResult) — keeps index pushes strictly serialized and test-deterministic; index failure cannot alter the result"
  - "coarsenPublicProvenance exported (not module-private like server.ts's twin) so the whitelist is directly test-pinned"
metrics:
  duration: ~25 min
  completed: 2026-07-16
  tests: 1210 pass (+26 vs 1184 baseline), tsc clean, biome clean (3 pre-existing CSS warnings only)
---

# Quick Task 260716-1ki: Public Playable Gallery Summary

**One-liner:** Every chat-built app is now publicly PLAYABLE — GitHub Pages enabled on each gallery repo after every push, build prompts contract static index.html-at-root apps, a gallery index site (escaped titles, vote|paid|chaos badges, unreviewed-by-humans disclaimer) ships to `<owner>.github.io` on the same never-reject publisher chain, and `!apps`/`!current` link viewers straight to the play URLs.

## What Was Built

### Task 1 — Pages enablement + static-app prompt contract (b720adf)
- `ensurePagesEnabled(repoName, mirrorDir)` in gallery-publisher.ts: reads the actual branch via `git rev-parse --abbrev-ref HEAD` (never hardcoded — fresh inits may be master or main), then `gh api --method POST repos/{owner}/{name}/pages -f source[branch]=<branch> -f source[path]=/` through the GalleryExec seam with the PAT on env only. Called in doPublish immediately after every successful push. 409/already-exists/conflict → debug no-op; any other error → loud warn, NEVER changes the `published` result, NEVER throws.
- Both `BUILD_SYSTEM_PROMPT_SCAFFOLD` and `BUILD_SYSTEM_PROMPT_CONTINUE` gained a static-app contract paragraph (plain static HTML/CSS/JS, index.html at workspace root, no build step/bundler/server-side code/backend/database — served as static files on GitHub Pages). Zero `${}` — the SAND-04 INTERPOLATED_SYSTEM_PROMPT source guard stays green (verified: `${` in prompt-boundary.ts only inside frame() and doc comments).

### Task 2 — Gallery index site (8f26fed)
- NEW pure module `src/orchestrator/gallery-index.ts`: `escapeHtml` (5 metachars, & first), `coarsenPublicProvenance` (whitelist replica of history/server.ts:129 — vote/chaos pass, EVERYTHING else → paid), `listGalleryIndexEntries` (project_repos × build_history, closest-created_at_ms match with lower-id tiebreak, slug/paid fallback, repo-night labels), `renderGalleryIndexHtml` (standalone page, inline CSS, zero JS, fixed `GALLERY_DISCLAIMER`, every dynamic string escaped incl. owner/repoName defense-in-depth).
- Publisher: `GalleryFs.writeFile` added to the seam + defaultFs; optional `indexEntries` dep (absent → index publishing OFF); `doPublishIndex` (never rejects — T-hak-03 idiom) creates/tolerates the `<owner-lowercased>.github.io` repo, mirrors at `data/gallery-mirror/_index-site` (underscore unreachable by sanitizeRepoName), writes the rendered page, commits with the fixed message "update gallery index" + COMMIT_USER identity, pushes with the exact existing credential-helper invocation, then Pages-enables the index repo. Chained inside the publishNow wrapper after a confirmed `published` — same serialization chain, index pushes never interleave with project pushes.
- main.ts `buildGalleryPublisher` wires `indexEntries: () => listGalleryIndexEntries(db)`.

### Task 3 — !apps + Pages-preferring !current (3369e9d)
- `InfoCommandKind` gains `"apps"` (zod enum + tier-2 strict no-arg regex; `!apps x` → null).
- `narrator.infoApps(url)`: fixed copy "Play everything chat has built: <url> — every app live-coded by an AI from chat prompts, unreviewed by humans." (copy-separation scan green — no chance/money words). `infoCurrent` accepts optional `playUrl` and PREFERS it ("play: <pages> · source: <github>"); without playUrl the message is byte-identical to before (pinned).
- main.ts info closure: `playUrlOf` composes `https://<owner-lowercased>.github.io/<repo>/`; kind "apps" → the bare gallery URL; both inherit the per-kind cooldown map + HALTED silence + zero funnel contact automatically.
- Drift gate: `!apps` added to commands.html (info section) and to commands-page.test.ts RECOGNIZED + SAMPLE_MESSAGE.

## Verification

- Full suite: **1210 pass** (baseline 1184 → +26), `npx tsc --noEmit` clean, `npx biome check src` clean (3 pre-existing overlay.css warnings, untouched by this task).
- Invariant suites (prompt-injection boundary incl. zero-interpolation guard, single-funnel, secrets isolation): all green.
- Grep sanity: `GH_TOKEN` appears exactly once in gallery-publisher.ts (the withToken env object); no `${` in any system-prompt constant.
- All new tests run against injected exec/fs/store fakes + in-memory better-sqlite3 — no real git/gh/fs/network.

## Deviations from Plan

**1. [Plan-directed] Pages enablement after push, not in scaffoldRepo** — the plan itself directed this deviation from the task description ("in scaffoldRepo() after gh repo create"): the create-Pages API 422s when the source branch doesn't exist on the remote yet. Implemented exactly as the plan's NOTE specifies.

**2. [Rule 3 - Blocking] Updated pre-existing test fakes/pins for the widened seams** — `GalleryFs` gaining a required `writeFile` broke the fake in tests/e2e/swap-command.e2e.test.ts (one-line addition); the `Narrator` interface gaining `infoApps` broke fakes in src/ingestion/twitch-chat.test.ts and tests/e2e/recovery.e2e.test.ts plus the interface-completeness key list in narration.test.ts; the Pages `gh api` calls required updating four existing assertions that counted/filtered `gh` calls or pinned exact exec-label sequences (now filter on `create` / include the Pages pair); the e2e `!current` pin in tests/e2e/info-commands.e2e.test.ts updated to the new play-first message (anticipated by the plan). All mechanical consequences of the planned interface changes.

**3. [Minor] `coarsenPublicProvenance` exported** rather than module-local so the whitelist is directly test-pinned (the plan's own test spec requires asserting it).

## Known Stubs

None — all surfaces are wired end-to-end against the real db/publisher seams. (Real-world effect awaits live credentials: the actual Pages sites appear on the next real publish with GALLERY_GITHUB_TOKEN set; the PAT may need the Pages API scope — verify on the streaming PC at the next live-deploy.)

## Threat Flags

None — no new network endpoints, auth paths, or schema changes beyond the plan's threat model. All five mitigate-disposition threats (T-1ki-01..05) implemented and test-pinned:
- T-1ki-01: hostile-title test asserts raw bytes absent from rendered HTML
- T-1ki-02: index reads only project_repos + build_history; whitelist coarsening pinned
- T-1ki-03: token-never-in-argv loops cover the Pages + index-push calls
- T-1ki-04: index/Pages failures resolve loudly without altering the publish result (pinned)
- T-1ki-05: all new calls are GalleryExec arg arrays; repo names are sanitized slugs or fixed config

## Self-Check: PASSED

- FOUND: src/orchestrator/gallery-index.ts
- FOUND: src/orchestrator/gallery-index.test.ts
- FOUND: commit b720adf (Task 1)
- FOUND: commit 8f26fed (Task 2)
- FOUND: commit 3369e9d (Task 3)
