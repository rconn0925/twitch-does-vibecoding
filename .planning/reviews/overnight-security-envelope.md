# Overnight Security Envelope Audit — Twitch Does Vibecoding

**Scope:** Safety envelope of the system at HEAD `0a1ae2f`, focused on risk introduced/widened by tonight's changes (`50e7838..HEAD`).
**Mode:** READ-ONLY analysis. No code modified.
**Auditor date:** 2026-07-11.
**Verdict headline:** The build/screen pipeline is well-engineered and fail-closed at the *source* level, but the **live-rendered broadcast surface is entirely unscreened**, and tonight's changes (looser classifier, persistent workspace, straight-to-build, gallery auto-publish) all *widen* the amount of unscreened chat-derived output that reaches air. Do not go live until the render surface has a safety net.

---

## Executive Summary — top 3 to fix before broadcast (ranked)

1. **[CRITICAL] Nothing screens what the app RENDERS on air.** Confirmed in code: the gate screens the prompt text (`build-session.ts:831`) and the code the agent writes (`build-session.ts:577`), but `src/preview/**` iframes the live sandbox dev server (`preview.js:137` `buffer.src = url`) with **zero content screening and no broadcast delay**. A build that is clean at the code level can render a slur, doxx, a remote explicit image, or a phishing clone directly onto the stream. The team already wrote `.planning/design/rendered-output-screening.md` documenting this — it is still a *proposal with no code mitigation*. **Fix before air:** adopt a broadcast delay on the preview source (Option A) so the operator/kill-switch has a window, and add the iframe/CSP lockdown (Option C).

2. **[HIGH] Chat-authored client JS runs in OBS's Chromium at the streamer's IP with no CSP and a permissive iframe sandbox.** `sandbox="allow-scripts allow-forms allow-same-origin"` (`preview.html:33,39`) plus no CSP header anywhere on the preview server (`preview/server.ts` serves `express.static` + one route, no helmet/CSP) means built pages can `fetch()` anywhere, load remote content, prompt geolocation, and beacon out. The WSL2 sandbox network allowlist (`sandbox-process.ts:225`) does **not** constrain this — the rendered page executes host-side, not in the sandbox. **Fix:** strict CSP on dev-server responses (or the framing) + drop `allow-same-origin`. This is the cheap half of the #1 fix.

3. **[HIGH] The looser classifier + persistent workspace multiply what reaches the unscreened render surface.** Tonight's retune (`prompt-boundary.ts:92-122`) is ToS-only and gray-zone-leans-approve; straight-to-build (quick-0iu) removed the research/plan turns; the persistent workspace accumulates state across prompts (`workspace.ts`). Individually reasonable, together they mean *more* approved prompts execute *faster* and *compose over turns* onto a surface with no render-level or cumulative-state check. This is not a separate bug to "fix" so much as the reason #1 is urgent: the only backstop for compositional/rendered violations is a human with a delay window.

Everything else (gallery publisher, MCP lockdown, quota/DoS) is medium-or-lower and mostly fails safe. Details below.

---

## Area 1 — Rendered-output exposure — **CRITICAL (confirmed in code)**

**Confirmed:** the two gate points are both source-level and nothing screens the rendered surface.
- Pre-build screen of the suggestion text: `build-session.ts:831` → `screenBuildPlan` → `comp02.ts`.
- In-flight screen of Write/Edit/NotebookEdit *code text*: `build-session.ts:574-598` → `extractWriteEditText` (`build-session.ts:254`) → `screenOutputBatch`.
- The preview surface just frames the running dev server: `preview.js:137` `loadIntoBuffer(currentUrl)` sets `iframe.src` to `http://127.0.0.1:5555` (`preview-manager.ts:100`). `src/preview/server.ts` and `preview.js` contain **no classifier call, no screenshot, no delay** — by design (`preview/server.ts:16-26` "renders zero chat-derived text" refers only to the *chrome*, not the framed app).

**Failure scenarios that pass both current checks but violate on screen:**
- A build writes `<div>` text containing a slur/doxx/harassment payload. The Write batch is "just text in a div"; the ToS classifier screening a code batch is unlikely to flag benign-looking markup, and even if the payload string is in the batch, the retune leans approve. It renders live.
- `<img src="https://…">` or CSS `background-image:url(https://…)` pulling remote explicit imagery. The written batch is a benign URL. **The sandbox network allowlist does not stop this** — the fetch happens in OBS Chromium (host), not the WSL2 build process. Renders live.
- Time-varying render: the page shows something innocuous on load, then reveals/animates violating content after N seconds client-side. No batch text captures the runtime behavior.

**Evidence:** `build-session.ts:577,831`; `preview.js:79-92,131-148`; `preview/server.ts:52-86`; `sandbox-process.ts:221-233`; `.planning/design/rendered-output-screening.md` (team's own confirmation, status "proposal — needs decision", unmitigated).

**Minimal mitigations (in priority order):**
- **Broadcast delay on the preview source (Option A)** — 15–30s OBS Render Delay filter on the preview browser source, or a lagged second surface if the filter doesn't apply to browser sources. Catches *all* visual violations, pairs with the existing kill switch. This is the real safety net.
- **iframe/CSP lockdown (Option C)** — closes the remote-content and JS-exfil vectors cheaply (see Area 4). Does NOT close locally-rendered text/CSS violations, so it is necessary-but-not-sufficient.
- **Screenshot-and-classify (Option B)** — automated vision check per build; higher effort/cost, misses time-varying renders. Defer past v1.

**Recommendation:** Ship C now + run A on broadcast night with a finger on the kill switch. Add this as a Phase 5 dry-run go-live line item (it is currently absent from the checklist).

---

## Area 2 — Compositional drift — **HIGH (confirmed; no cumulative screen exists)**

**Confirmed:** each screen is per-increment. `screenBuildPlan` screens one suggestion; `screenOutputBatch` screens one Write/Edit batch's *new* text (`extractWriteEditText` only pulls `content`/`new_string`/`new_source`/edit `new_string` — the *delta*, not the resulting whole file, `build-session.ts:254-277`). The persistent workspace (`workspace.ts`) accumulates across builds in continue mode (`build-session.ts:721`), and `markBuilt()` flips to continue after the first `done`. **Nothing ever re-screens the cumulative file state or the composed app.**

**Exploit:** assemble a violating artifact over several individually-innocent prompts. E.g. prompt 1 "build a login page that looks like Twitch" (renders as a generic form — approved), prompt 2 "add the purple Twitch styling and logo" (IP/styling — each batch benign), prompt 3 "make the Submit button POST the username and password to https://collector.example" (a one-line form-action/fetch change — a benign-looking URL in a single batch). No single screen sees a phishing page; the composed result is one. The retune (leans approve, ToS-only) makes each step more likely to pass.

**Evidence:** `build-session.ts:254-277,574-598,721`; `comp02.ts:63-72` (screens only the passed text); `workspace.ts:55-58`.

**Remediation:** Compositional violations are fundamentally a *rendered-whole* problem — the practical mitigation is the Area 1 broadcast delay + operator/kill-switch, not another source screen. If a source-level partial mitigation is wanted: periodically re-screen the full current file set (not just the delta) and/or re-screen the composed suggestion history for a generation. Treat as defense-in-depth behind Area 1.

---

## Area 3 — Looser classifier envelope — **HIGH (confirmed retune; risk is at execution/render, not text)**

**Confirmed retune** (`prompt-boundary.ts:92-122`, commit `b9b0f54`): ToS/CG-only; feasibility/app-ness judgment removed; `DEFAULT IS APPROVE when there is no ToS/CG risk` (rule 2); gray zone leans approve; `held-for-review` restricted to exactly 3 categories (gambling/ip-infringement/misinformation, rule 3); chance-without-stakes explicitly approved (rule 5).

**Prompt classes now approved that create broadcast risk when EXECUTED/RENDERED (distinct from benign text):**
- **Remote-content loaders:** "build a page that shows the image at `<url>`", "make a gallery of these links", "embed this video". Text is benign; the *render* pulls arbitrary remote (possibly explicit/IP-infringing) content onto air. Cross-refs Area 1 + Area 4. Not caught by a ToS-text classifier and not caught at render.
- **Look-alike/credential UIs:** "make a Twitch login screen", "clone the Twitch homepage". Alone these read as benign UI work (the classifier is told not to judge app-ness); the phishing/impersonation risk only materializes when composed (Area 2) and rendered (Area 1).
- **Satire/misinformation on screen:** rule permits "clearly-labeled satire" — but "clearly-labeled" is a *rendered* property the classifier judges from prompt text, not from pixels. A prompt claiming satire that renders as a realistic fake headline passes.

The retune itself is a reasonable *text* policy. The danger is structural: it widens the funnel into a pipeline whose only downstream check is more source-level screening — there is no render check to catch what "leans approve" lets through. **This finding's severity is inseparable from Area 1's being unmitigated.**

**Evidence:** `prompt-boundary.ts:92-122`; `STATE.md` quick-task `260711-0ms` (LIVE eval 57 PASS / 0 SAFETY FAIL — but eval is text-labeled, not render-observed).

**Remediation:** Keep the retune, but do not treat the classifier as the broadcast safety boundary — it never sees the render. Area 1's delay is the compensating control. Optionally re-add a narrow "renders remote/untrusted content" or "credential-input UI" signal as `held-for-review` bait if you want a text-level tripwire.

---

## Area 4 — Chat-authored JS execution surface — **HIGH (confirmed)**

**Confirmed:** the preview iframe is `sandbox="allow-scripts allow-forms allow-same-origin"` (`preview.html:29-41`, both visible and buffer frames). `allow-scripts` + `allow-same-origin` together is the documented weak-sandbox combo. There is **no CSP** on the preview server responses (`preview/server.ts` — `express.static` + `GET /api/reachable` only; no helmet, no `Content-Security-Policy` header) and the framed dev-server (a chat-built app, e.g. a default Vite server) sets none either.

**What the chat-built JS can reach** (it runs in OBS's CEF Chromium / the streamer's browser, at the streamer's public IP, NOT in the sandbox):
- Outbound `fetch`/`XHR`/`WebSocket`/`sendBeacon` to **any** host — trackers, analytics beacons, exfiltration of anything the page can read. The WSL2 `network.allowedDomains` (`sandbox-process.ts:225`) restricts only the *build process's* egress, not the rendered page.
- `navigator.geolocation` and other permission prompts rendered on the broadcast.
- `localStorage`/`IndexedDB` on the dev-server origin (persists across builds on the same origin).
- Because parent (preview server port) and iframe (`127.0.0.1:5555`) are **different origins**, `allow-same-origin` does *not* grant access to the parent preview DOM — so the parent page is protected. The blast radius is confined to the framed app's own origin + arbitrary outbound network. That is still substantial: silent exfil + remote-content loading + IP exposure.

**Realistic blast radius:** an attacker whose build passes the source screens can (a) load remote ToS-violating content onto air (Area 1), (b) beacon the streamer's IP/telemetry to an attacker endpoint, (c) run a cryptominer/CPU spinner in OBS during the stream. No credential theft from the host (empty sandbox env, `/mnt` denied) and no parent-DOM access.

**Evidence:** `preview.html:29-41`; `preview/server.ts:52-86` (no CSP middleware); `preview.js:79-92`; `sandbox-process.ts:221-233` (allowlist scope note).

**Remediation (Option C, low effort):** add a strict CSP to the dev-server framing (`default-src 'self'`, no remote `img/script/connect/media`) and drop `allow-same-origin` (test whether built apps need it — many static builds don't). Decide explicitly whether chat-built apps may load remote images/CDNs at all; fully-local-only is the safest default for v1.

---

## Area 5 — Gallery publisher — **MEDIUM overall**

Reviewed `gallery-publisher.ts` against each requested concern:

- **Command injection via chat-derived title — SAFE (LOW).** Confirmed: every git call goes through `GalleryExec`, an `execFile`-style arg-array seam (`gallery-publisher.ts:63-67`); the type has **no `shell` field**, so `shell: true` is unrepresentable. The chat title is one `argv` element (`gallery-publisher.ts:214-215`), never interpolated into a command line. `sanitizeCommitTitle` (`:109`) is defense-in-depth, not the boundary. Verified as claimed.
- **Path traversal in the workspace copy — SAFE (LOW).** `src`/`dest` are built from `generation`, an internally-generated **integer** (`workspace.ts:47`, `gallery-publisher.ts:196-197`), never chat text. No traversal vector from viewer input.
- **Secrets leakage into commits — LOW-to-MEDIUM.** `workspaceCopyFilter` (`:96-102`) rejects `node_modules` segments and every dot-basename (`.env`/`.git`/`.config`), and the distro's `claude login` credentials live in `/home/builder/.claude/` (outside `app-N`), so they aren't in the copy tree. **Residual — symlink / non-dot secret files:** the filter is *basename*-based. `node:fs.cp` does not dereference symlinks by default, so a symlink is committed *as a symlink* (git stores only the link target path, not the pointed-to content) — this leaks a path string, not file contents. A build that writes a **non-dot** file containing fabricated/sensitive text (e.g. `secrets.txt`) passes the filter and is committed. The filter is adequate for the known dotfile vectors but is not a robust general secrets scanner.
- **Publishing unscreened chat artifacts under the streamer's GitHub identity — MEDIUM (the real exposure).** After each `done` build, the workspace is committed + pushed to `github.com/rconn0925/vibecoding-gallery.git` under the streamer's own git credentials (`gallery-publisher.ts:89,214-216`; `main.ts:1068-1092`). The content passed only *source-level* batch screening — so per Areas 1-3, a rendered/composed violation (or benign-looking remote-loader/phishing code) is now **persisted under Ross's GitHub identity**. Repo visibility is **not enforced in code** — the header comment says "private gallery repo" but nothing sets or verifies visibility; if the repo was created public, violating chat code is public under his name. Recommend: confirm the repo is private, and consider gating publish behind the same broadcast-delay/operator confidence as the render.
- **Failure isolation — SAFE (confirmed, triple-guarded).** `doPublish` wraps everything in try/catch and resolves `{status:"failed"}`, never throws (`:223-228`); `publishNow`'s serialization chain swallows rejections (`:233-238`); the `onBuildDone` seam in build-session runs inside its own try/catch (`build-session.ts:453-460`); main.ts calls it as `void …then().catch()` (`main.ts:1071-1091`). A publish failure cannot disturb finalize, the IDLE transition, or the dequeue. Verified as claimed.

**Net:** the injection/traversal/isolation claims all hold. The meaningful residual is *what* gets published (unscreened artifacts) and *where* (streamer identity, visibility unenforced), not *how*.

---

## Area 6 — MCP lockdown completeness — **LOW (confirmed solid)**

**Confirmed applied to the real build turn.** `sdk-runner.ts:43-52` routes the sandboxed build turn (the only live-pipeline turn) through `assembleSandboxedBuildOptions`, which sets the lockdown triple on the actual `query()` options object: `strictMcpConfig: true`, `mcpServers: {}`, `settings.disableClaudeAiConnectors: true` (`turn-options.ts:65-77`). The unsandboxed fallback (`assembleHostTurnOptions`, `:89-101`) applies the same triple plus `allowedTools:[]`/denylist — and is unreachable from the live pipeline anyway. Each layer is fresh-constructed (`lockdownSettings()` returns a new object per call, `:51-53`), not a shared mutable const.

**Bypass analysis:** `AgentRunSpec` carries no field that could inject an MCP server or re-enable connectors; the systemPrompt is passed by bare reference (SAND-04). The three layers close file/settings-based MCP, in-memory MCP, and auto-fetched claude.ai connectors respectively — the three distinct config sources. No pipeline path constructs build options that skip `turn-options.ts`.

**Residual (low):** the sandboxed agent can still `npm install` from the allowlisted `registry.npmjs.org` / `*.npmjs.org` (`sandbox-process.ts:225`), so a malicious dependency runs arbitrary code *inside the sandbox* — confined by the empty-env allowlist (`sandbox-process.ts:93-104`) and `/mnt` deny, so it can't reach host credentials. But that package's code, if bundled into the built app, executes host-side when rendered (loops back to Area 4). Not an MCP-lockdown hole; noted for completeness. No path found where the sandboxed agent reaches host credentials/network beyond the registry allowlist.

---

## Area 7 — Plan-quota / DoS — **MEDIUM (fails safe, but no budget guard and cost-amplifying)**

**Consumption drivers, confirmed:**
- One Sonnet classification per accepted `!suggest` (`main.ts:772-795` `classifyThenNotify`). Guardrails: per-user intake cooldown (`INTAKE_COOLDOWN_SECONDS` default 60, `main.ts:305-308`) and `INTAKE_MAX_POOLED_PER_USER` (default 1). **There is no global rate limit or budget guard on classification** — N users × their cooldown = unbounded aggregate classify volume.
- Continuous auto-cycle builds (`AutoCycleScheduler`, ~40s suggest + vote cadence, `main.ts:668-709`), each a full Fable build session.
- **In-flight COMP-02 amplification:** `screenOutputBatch` runs a Sonnet classification **synchronously, inline, per Write/Edit batch** inside the consume loop (`build-session.ts:577` `await screenOutputBatch`). A build that writes 30 files = 30 sequential Sonnet round-trips *inside one build turn* (UAT noted ~12s/attempt worst case). This both amplifies plan-credit cost per build and serially slows the build (adds broadcast latency), all under the 900s watchdog.

**Quota-exhaustion behavior — fails safe, no crash:**
- Classifier path: an exhausted-credit `query()` error resolves fail-closed in the gate (D-11) → every suggestion rejected → chat sees the throttled "Suggestion check is backed up" line (`main.ts:783-789`). Safe, but the show silently stops approving/building anything.
- Build turn: `runTurn`/`consumeTurn` catch errors → `outcome:"failed"` → narrated retry/skip decision (`build-session.ts:616-619,787-802`). No crash; graceful degradation.

**Net:** exhaustion is **fail-closed (safe), not a public crash** — good. But there is **no proactive budget guard, no spend cap, no classification rate limit, and no operator warning as credits deplete**. A multi-hour stream will consume heavily (build cadence × per-batch inline classifications × per-suggestion classifications), and the failure mode is "the show quietly stops working." Recommend: a spend/volume guard with an operator-visible warning, and consider batching or bounding the in-flight COMP-02 cadence (the module comment even says cadence "is the orchestrator's call" — currently it fires on *every* batch).

---

## Area 8 — Other live-broadcast risks spotted in the diff

- **[MEDIUM — operational] Dangerous `.env` test knobs that must not reach broadcast.** `INTAKE_MAX_POOLED_PER_USER` is documented set to `10` locally for testing (STATE.md `fast` task) vs default `1` — 10× the per-user pool flood on air. `SE_ACCEPT_TEST_EVENTS=true` routes *simulated* tips into the real control-window pipeline (STATE.md `260710-sfl`, "NEVER enable on broadcast"). Both are strict-string/env-gated and safe by default, but there is no boot-time guard that refuses to start a *broadcast* profile with test knobs enabled. Add a pre-air checklist assertion (or a boot warning banner) for these.
- **[LOW] No broadcast delay anywhere in the system** — every surface is real-time (overlay, preview, builder feed). This is the compensating-control gap behind Areas 1-3; called out separately because it's a *system-wide* property, not just the preview's.
- **[LOW] Gallery repo visibility unenforced** — see Area 5; flagged again because a public repo turns a missed render/compositional violation into a durable public artifact under the streamer's identity.
- **[INFO] Held-for-review plans are dropped, not routed.** `onHeldForReview` only logs (`main.ts:1044-1048`, documented `TODO(D-08)`). This is narrated + audited (not silent) and fails toward *not building* (safe), so it's not a broadcast-safety hole — but it means the one "human, look at this" path the classifier can invoke currently drops the item. Acceptable for v1; noted.

---

## Confirmed-vs-suspected ledger

| Area | Status | Severity |
|------|--------|----------|
| 1. Rendered output unscreened | **Confirmed in code** (+ team's own design doc) | CRITICAL |
| 2. Compositional drift, no cumulative screen | **Confirmed** | HIGH |
| 3. Looser classifier widens funnel into unscreened render | **Confirmed** (retune) | HIGH |
| 4. Chat JS: no CSP, permissive iframe sandbox | **Confirmed** | HIGH |
| 5a. Gallery injection/traversal/isolation | **Confirmed SAFE** | LOW |
| 5b. Unscreened artifacts to streamer GitHub identity | **Confirmed** | MEDIUM |
| 6. MCP lockdown | **Confirmed applied/solid** | LOW |
| 7. Quota: fail-closed but no budget guard | **Confirmed** | MEDIUM |
| 8. Test-knob / delay / repo-visibility operational | **Confirmed** | MEDIUM/LOW |

**Bottom line:** the source-level safety machinery is genuinely strong and fails closed. The unaddressed axis is everything *downstream of the code*: the rendered pixels and client-side execution on air. Ship the iframe/CSP lockdown and run a broadcast delay with the kill switch before night one; treat the render surface as an explicit Phase 5 go-live gate item.
