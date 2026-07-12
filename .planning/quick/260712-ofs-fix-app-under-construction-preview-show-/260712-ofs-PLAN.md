---
phase: quick-260712-ofs
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/orchestrator/types.ts
  - src/preview/preview-manager.ts
  - src/preview/preview-manager.test.ts
  - src/preview/server.ts
  - src/preview/server.test.ts
autonomous: true
requirements: [quick-260712-ofs]

must_haves:
  truths:
    - "GET /api/reachable returns reachable:false while the dev server serves python http.server's bare directory-listing page"
    - "GET /api/reachable returns reachable:true when the dev server serves a real app page (200, no directory-listing title)"
    - "Any probe failure (connection refused, timeout, non-200, parse issue) yields reachable:false — never a 500 or error text on the broadcast surface"
    - "The dev-server-supervisor keeps calling the TCP reachable() probe unchanged — process-up semantics preserved"
    - "The preview surface still touches ONLY 127.0.0.1:<devServerPort> and exposes ONLY { reachable, url } (D3-12 isolation held)"
  artifacts:
    - path: "src/orchestrator/types.ts"
      provides: "DevServerProbe.appReady optional method"
      contains: "appReady"
    - path: "src/preview/preview-manager.ts"
      provides: "content-aware appReady() + injectable fetchDevServerBody HTTP seam"
      contains: "appReady"
    - path: "src/preview/server.ts"
      provides: "/api/reachable calls appReady() with reachable() fallback"
      contains: "appReady"
  key_links:
    - from: "src/preview/server.ts"
      to: "probe.appReady"
      via: "GET /api/reachable handler (prefers appReady, falls back to reachable)"
      pattern: "appReady"
    - from: "src/preview/preview-manager.ts"
      to: "devServerUrl"
      via: "injected httpGet seam performing a bounded, timed HTTP GET"
      pattern: "httpGet|fetchDevServerBody"
---

<objective>
Fix the app-under-construction preview (OBS source at 127.0.0.1:4902) so it shows the existing calm "STANDING BY / Setting the stage…" waiting card instead of the sandbox dev server's bare "Directory listing for /" page when no real app has been built yet.

Root cause (given): GET /api/reachable calls the PURE TCP `probe.reachable()`. At boot the supervisor starts a python `http.server` on the empty workspace — TCP-reachable but serving python's "Directory listing for /" HTML. preview.js treats reachable=true as "LIVE" and frames that listing. Reachability is content-blind.

Fix: make the PREVIEW surface's readiness content-aware via a NEW `appReady()` seam that does a bounded, timed HTTP GET to the dev server and returns false when the body is a python directory-listing (or on any failure). The existing TCP `reachable()` is left untouched because the dev-server-supervisor also consumes it and MUST stay TCP-only.

Purpose: Keep the broadcast surface calm and fail-closed — a bare directory listing must never render as "LIVE".
Output: A content-aware readiness path for /api/reachable; TCP reachable() unchanged; tests for real-app / directory-listing / refused / timeout.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md

<interfaces>
<!-- Current seam. Executor: extend, do NOT change reachable()'s meaning. -->

From src/orchestrator/types.ts:
```typescript
export interface DevServerProbe {
  reachable(): Promise<boolean>;
}
```

From src/preview/preview-manager.ts:
```typescript
export const DEFAULT_PREVIEW_DEV_SERVER_PORT = 5555;
export const DEFAULT_PROBE_TIMEOUT_MS = 750;
export type TcpConnectProbe = (port: number, timeoutMs: number) => Promise<boolean>;
export interface PreviewManagerOptions {
  port?: number;
  timeoutMs?: number;
  connect?: TcpConnectProbe;
}
export interface PreviewManager extends DevServerProbe {
  readonly devServerUrl: string; // `http://127.0.0.1:${port}`
  readonly port: number;
}
export function createPreviewManager(options?: PreviewManagerOptions): PreviewManager;
```

From src/preview/server.ts — the only line to change in the handler:
```typescript
app.get("/api/reachable", async (_req, res) => {
  let reachable = false;
  try { reachable = await probe.reachable(); } catch { reachable = false; }
  res.json({ reachable, url: devServerUrl });
});
```

CONSUMERS OF reachable() THAT MUST STAY TCP-ONLY (do not touch):
- src/preview/dev-server-supervisor.ts calls deps.probeReachable() (TCP process-up check)
- src/main.ts:2016 wires probeReachable: () => (opts.devServerProbe ?? previewManager).reachable()
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add content-aware appReady() seam to PreviewManager</name>
  <files>src/orchestrator/types.ts, src/preview/preview-manager.ts, src/preview/preview-manager.test.ts</files>
  <behavior>
    - real-app page (200, normal HTML, no directory-listing title) => appReady() TRUE
    - python directory-listing page (200, body contains `<title>Directory listing for /`, case-insensitive, whitespace-tolerant) => appReady() FALSE
    - injected httpGet rejects (connection refused) => appReady() FALSE (fail-closed)
    - injected httpGet rejects with timeout => appReady() FALSE (fail-closed)
    - httpGet is passed the devServerUrl and the configured timeoutMs (assert via a recording fake)
    - reachable() (TCP) behavior is unchanged — existing preview-manager.test.ts cases still pass
  </behavior>
  <action>
    In src/orchestrator/types.ts: add an OPTIONAL method `appReady?(): Promise<boolean>` to the DevServerProbe interface, documented as the content-aware readiness check the preview page uses (returns false for a bare dev-server directory listing). Keep `reachable()` required and TCP-only in its doc — the supervisor still depends on it. Optional so test fakes and the console-path default that only implement reachable() stay valid.

    In src/preview/preview-manager.ts: add an injected HTTP-body seam mirroring the existing TcpConnectProbe pattern. Define `export type HttpBodyProbe = (url: string, timeoutMs: number) => Promise<string>` — resolves a BOUNDED body prefix on a 200, and REJECTS on non-200 / network error / timeout (the caller fails closed). Add `httpGet?: HttpBodyProbe` to PreviewManagerOptions defaulting to a new real implementation `fetchDevServerBody`.

    Implement `fetchDevServerBody(url, timeoutMs)` using Node 24 global `fetch` with `signal: AbortSignal.timeout(timeoutMs)`; throw if `!res.ok`; read only a bounded prefix of the body (getReader loop that accumulates up to a small byte cap — e.g. 8192 bytes — then cancels the stream; decode with TextDecoder). Never buffer an unbounded app response. The url is devServerUrl which already pins IPv4 `http://127.0.0.1:<port>` (WR-06 address-family match), so do not introduce `localhost`.

    Add `appReady()` to the object returned by createPreviewManager: `try { const body = await httpGet(devServerUrl, timeoutMs); return !/<title>\s*directory listing for/i.test(body); } catch { return false; }`. Fail-closed on every path (mirror reachable()). Leave reachable() exactly as-is (still calls the TCP `connect` seam). PreviewManager already extends DevServerProbe, so appReady is now part of the concrete shape.

    Extend src/preview/preview-manager.test.ts with the <behavior> cases, injecting a fake `httpGet` (never a real socket/network): a fake resolving normal HTML, one resolving python directory-listing HTML, one rejecting with ECONNREFUSED, one rejecting with a timeout error, and a recording fake asserting url+timeout pass-through. Do NOT exercise the real fetchDevServerBody (no network in tests).
  </action>
  <verify>
    <automated>npx vitest run src/preview/preview-manager.test.ts && npm run typecheck</automated>
  </verify>
  <done>appReady() returns false for directory-listing bodies and on any httpGet rejection, true for real-app HTML; reachable() TCP behavior unchanged; typecheck clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: /api/reachable uses appReady() with reachable() fallback</name>
  <files>src/preview/server.ts, src/preview/server.test.ts</files>
  <behavior>
    - probe with appReady() => true, reachable() => false: /api/reachable reports reachable:true (appReady wins)
    - probe with appReady() => false, reachable() => true (directory-listing case): /api/reachable reports reachable:false
    - probe with NO appReady (fake implementing only reachable()): /api/reachable falls back to reachable() — existing tests still pass
    - probe whose appReady() rejects: /api/reachable reports reachable:false with HTTP 200 (never a 500)
    - response body is still exactly { reachable, url } — no extra fields, no error text (D3-12 / T-03-17)
  </behavior>
  <action>
    In src/preview/server.ts, change ONLY the /api/reachable handler: prefer the content-aware check when present, else fall back to TCP reachable(). Use something like `const check = probe.appReady ? probe.appReady.bind(probe) : probe.reachable.bind(probe); reachable = await check();` inside the existing try/catch. Keep the catch → reachable=false and `res.json({ reachable, url: devServerUrl })` untouched. Do NOT add express.json(), any mutation route, or any new response field. Do NOT change the 127.0.0.1 listen host or the loopback Host-allowlist middleware.

    Update the fakeProbe helper in src/preview/server.test.ts so it can optionally supply appReady (keep the reachable-only default so existing cases still exercise the fallback path). Add cases from <behavior>: appReady-wins-true, directory-listing false (appReady false while reachable true), no-appReady fallback, and appReady-rejects → { reachable:false } at HTTP 200. Assert the body shape stays { reachable, url } only.
  </action>
  <verify>
    <automated>npx vitest run src/preview/server.test.ts && npm run typecheck && npm run lint</automated>
  </verify>
  <done>/api/reachable returns appReady()'s result when present, falls back to reachable() when absent, and yields { reachable:false } (HTTP 200, no leaked detail) on any error; lint + typecheck clean.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| dev server → preview host | The preview host reads the dev server's OWN HTTP response body (127.0.0.1:<devServerPort>) — allowed by D3-12; the response is untrusted content but is only pattern-matched, never executed or reflected. |
| preview host → OBS browser source | The broadcast surface. Only { reachable, url } may cross; no error text, no orchestrator state. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-ofs-01 | Information disclosure | /api/reachable response | mitigate | Body stays exactly { reachable, url }; appReady() errors are swallowed to reachable:false (no message, no stack) — preserves T-03-17/T-03-19. |
| T-ofs-02 | Denial of service | httpGet reading dev-server body | mitigate | AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS=750ms) + bounded-prefix read (~8KB cap, stream cancelled) — a slow or huge app response can never stall or exhaust the preview host. |
| T-ofs-03 | Spoofing / rebinding | address family + host | accept/mitigate | httpGet targets devServerUrl (IPv4 127.0.0.1, WR-06); loopback Host-allowlist middleware and 127.0.0.1 listen host are untouched. |
| T-ofs-04 | Tampering (scope creep) | preview isolation (D3-12) | mitigate | No orchestrator coupling added; supervisor's TCP reachable() unchanged; no mutation route / express.json() introduced. |
</threat_model>

<verification>
- `npm test` (vitest run) passes — new appReady cases + all existing preview-manager/server cases green.
- `npm run typecheck` clean (optional appReady, HttpBodyProbe type wire correctly).
- `npm run lint` (biome) clean.
- Manual reasoning: dev-server-supervisor.ts and main.ts:2016 still call reachable() (TCP) — no diff to those files.
</verification>

<success_criteria>
- GET /api/reachable → reachable:false for a python directory-listing body, true for a real app page.
- Any failure (refused / timeout / non-200 / parse) → reachable:false at HTTP 200, never a 500 or error text.
- TCP reachable() and its supervisor consumer are byte-for-byte unchanged.
- Preview surface still exposes only { reachable, url } and touches only 127.0.0.1:<devServerPort>.
- No change to preview.js, the supervisor's probe semantics, or the WSL sandbox scripts.
</success_criteria>

<output>
Create `.planning/quick/260712-ofs-fix-app-under-construction-preview-show-/260712-ofs-SUMMARY.md` when done
</output>
