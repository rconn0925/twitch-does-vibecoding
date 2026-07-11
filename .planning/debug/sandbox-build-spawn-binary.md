---
status: awaiting_human_verify
trigger: "Sandboxed build turn fails: WSL2 sandbox adapter passes the SDK's host-resolved claude.exe into the distro where it cannot exist (automount off) or run (interop off); every real build reaches stage 'building' then fails closed"
created: 2026-07-11
updated: 2026-07-11
---

# Debug: sandboxed build turn fails to launch inside WSL2

## Symptoms

- **Expected:** After a vote, the build turn spawns Claude Code INSIDE the vibecoding-build distro (via the SDK spawnClaudeCodeProcess hook → wsl.exe wrapper) and builds the app; preview at 4902 comes alive.
- **Actual:** Research and planning host turns succeed (real model time, plan-billed). Build turn throws immediately at spawn, retries once, throws again → stage "failed" (fail-closed path works). No code ever written in the sandbox.
- **Errors:** SDK ReferenceError: "Claude Code native binary at C:\Users\ross\Projects\twitch-does-vibecoding\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe exists but failed to launch. This usually means the binary does not match this system's libc…" — thrown at ChildProcess exit inside sdk.mjs on the HOST. The libc message is a misdiagnosis: the wsl.exe child exits nonzero because a Windows path/binary can't resolve (automount off) or execute (interop off) inside the distro.
- **Timeline:** First-ever real build attempts (2026-07-11 ~03:25–03:28, taskIds 59eee21e / 2953fde0). Never worked live — all 733 tests run against injected fakes; this is the first real WSL2 integration exercise (the exact CR-03 human-gate gap).
- **Reproduction:** Deterministic. Any round winner reaching the build stage. Live retest: app runs with auto-cycle; two differently-worded !suggest in chat → vote → build within ~90s.

## Evidence

- timestamp: 2026-07-11T03:28Z — app log: `agent turn threw — failing closed` ×2 with the ReferenceError above; stages researching→planning→building→failed for task 2953fde0; earlier task 59eee21e was refused at plan re-screen (unrelated, gate working).
- timestamp: 2026-07-11T03:40Z — code read: src/orchestrator/sandbox-process.ts:124-131 — adapter spawn = `wsl.exe -d <distro> -u <user> -- <opts.command> ...opts.args` with opts.command passed VERBATIM from the SDK hook (= host claude.exe path).
- timestamp: 2026-07-11T03:41Z — distro state: vibecoding-build Running; /usr/bin/claude (CLI 2.1.206) present, logged in as builder on plan credits (SANDBOX-SETUP proof d PASS); automount AND interop disabled in /etc/wsl.conf.
- timestamp: 2026-07-11T03:41Z — sdk-runner.ts:71-75: sandboxed build turn sets options.spawnClaudeCodeProcess = spec.spawnClaudeCodeProcess; buildSandboxOptions() sets enabled + failIfUnavailable + network allowlist + /mnt deny.
- timestamp: 2026-07-11 — sdk.mjs spawn site read (minified line 88): `let oa=YK(a),ia=oa?a:n,sa=oa?[...i,...W]:[...i,a,...W],Fu={command:ia,args:sa,cwd:o,env:c,signal}` — native-binary mode: command=claude.exe path, args=flags only; node mode: command=node executable, args=[...nodeExecArgs, cli.js path, ...flags]. env `c` = {...process.env}+SDK vars (host secrets inside — must keep ignoring opts.env). cwd = host path. With spawnClaudeCodeProcess set, SDK skips auto --debug-file (no host log path in args). implication: adapter must strip node-exec prefix through cli.js in node mode, keep flags verbatim, and never forward opts.env.
- timestamp: 2026-07-11 — sdk.d.ts:6475-6516: SpawnOptions={command,args,cwd?,env,signal}; SpawnedProcess needs stdin/stdout/killed/exitCode/kill/on — node ChildProcess satisfies; adapter's default pipe stdio is fine.
- timestamp: 2026-07-11 — sdk-runner.ts build turn sets NO cwd/plugins/settings paths → opts.cwd = host process.cwd() only; args carry no host filesystem paths besides the command/cli.js itself. implication: mapping command + dropping cwd (→ --cd ~) is sufficient; flags pass through verbatim.
- timestamp: 2026-07-11 — tests/invariants/secrets-isolation.test.ts scans ONLY src/orchestrator/sandbox-process.ts for env spreads (`...process.env|...opts.env|...deps.env`) and host-secret identifiers — a named allowlist of Windows system vars (SystemRoot etc.) for the wsl.exe host-side process does not violate the invariant regexes, but must be written as explicit key picks, never a spread.
- timestamp: 2026-07-11 — LIVE RETEST #1 (post-fix): full real round (dev submits → gate approved both → round 3 → winner queued → researching → planning → building). Spawn no longer throws — no ReferenceError, no "agent turn threw". Turn now ends via a proper SDK result message: building → failed in ~1.6s with retry (fail-closed intact).
- timestamp: 2026-07-11 — host-side probe (.debug-sandbox-probe.mts, real adapter + real query()): SPAWN_OPTS confirmed native-binary mode (host claude.exe + flags incl. --settings '{"sandbox":{...}}'); child boots INSIDE distro and stderr says: "Error: sandbox required but unavailable: bubblewrap (bwrap) not installed, socat not installed ... sandbox.failIfUnavailable is set — refusing to start without a working sandbox." exit 1 → result subtype error_during_execution. implication: adapter translation FIXED (CLI boots + streams); remaining blocker is the flagged blind spot — the distro lacks the CLI sandbox deps. Remedy: install bubblewrap+socat in vibecoding-build (strengthens the sandbox; failIfUnavailable stays true).
- timestamp: 2026-07-11 — installed bubblewrap 0.9.0 + socat 1.8.0 in vibecoding-build as root (apt). Probe rerun: system init cwd=/home/builder INSIDE distro, assistant replied "ok", result subtype success, exit 0, plan-billed (rate_limit_event seven_day utilization 0.3).
- timestamp: 2026-07-11 — LIVE RETEST #2 (app-driven): POST /api/tasks/f2205281/retry → stage building SUSTAINED; distro ps shows PID 9158 `/usr/bin/claude --output-format stream-json --input-format stream-json --settings {"sandbox":{...}}` + socat sandbox proxy running as builder. The engine is building the round winner inside WSL2.

## Current Focus

hypothesis: CONFIRMED and FIXED — see reasoning_checkpoint + Resolution
next_action: "Await human confirmation (checkpoint returned). On 'confirmed fixed': archive session, commit src/orchestrator/sandbox-process.ts + sandbox-process.test.ts (code) and debug file + SANDBOX-SETUP.md (docs), append knowledge base entry. Known follow-ups for Ross: (1) WR-07 per-turn watchdog (DEFAULT_TURN_TIMEOUT_MS = 5min, build-session.ts:202) aborted an otherwise-progressing real build — consider raising for build turns; build-session.ts is owned by the concurrent executor right now, do not touch from this session. (2) Builder account's claude.ai MCP connectors (HubSpot etc.) are reachable from build turns inside the distro — consider strictMcpConfig or disabling connectors on the builder account."

reasoning_checkpoint:
  hypothesis: "createSandboxAdapter.spawn() performs zero host→distro translation of the SDK spawn contract. Primary observed failure: it sets the WINDOWS-side child env to {PATH:'/usr/bin:/bin'}, so node cannot resolve 'wsl.exe' → spawn ENOENT → SDK 'error' handler fires its launch-failure heuristic → misleading 'binary exists but failed to launch (libc)' ReferenceError. wsl.exe never started. Beneath it, three more launch-fatal gaps: verbatim host claude.exe command (exit 127 in distro), `--` shell form mangling backslashes/JSON args, and the allowlist env never reaching the Linux process (no WSLENV)."
  confirming_evidence:
    - "Experiment A (exact current spawn shape): spawn wsl.exe ENOENT — child never launches; deterministic repro of the observed error path"
    - "Follow-up (valid wsl spawn + verbatim host claude.exe via `--`): exit 127, bash: 'C:Usersross...claude.exe: command not found' (backslashes eaten by shell)"
    - "Experiment C (mapped form: absolute-findable wsl.exe, --cd ~, --exec /usr/bin/env PATH=/usr/bin:/bin /usr/bin/claude --version): exit 0, prints '2.1.206 (Claude Code)' — distro CLI version-matched to SDK 0.3.206"
    - "Experiment D: JSON-shaped arg survives --exec byte-for-byte (jsonIntact:true)"
    - "Experiment E: /usr/bin/env injection sets PATH+key inside distro; host Windows env probe does NOT cross (WSLENV empty); HOME=/home/builder preserved (claude login store reachable)"
    - "Experiment B2: wsl.exe runs fine with a completely EMPTY Windows-side env — zero host env needs to cross"
  falsification_test: "If A had launched wsl.exe (no ENOENT), the env-PATH layer would be disproven; if C failed nonzero, the mapping design would be wrong. Neither occurred."
  fix_rationale: "Translate every SpawnOptions field at the single SAND-03 funnel: spawn absolute %SystemRoot%\\System32\\wsl.exe (no PATH dependence, verified present) with EMPTY Windows env (strictly stronger isolation than today); map cwd → --cd (opts.cwd when POSIX-absolute, else ~); use --exec (argv-verbatim, no shell); inject the existing buildSandboxEnv allowlist Linux-side via /usr/bin/env KEY=VAL; map command host claude.exe OR node+cli.js → /usr/bin/claude keeping SDK flags verbatim. Addresses the launch mechanism itself, not the symptom message."
  blind_spots: "CLI-side sandbox settings (enabled+failIfUnavailable → bubblewrap in distro) only exercised at live retest; SDK transport flags beyond --version assumed portable (same-numbered CLI 2.1.206 in distro); stdin/stdout stream-json handshake unproven until live retest."

## Constraints

- sandbox-process.ts is the ONLY process-sandboxing code (SAND-03 single-funnel); fix belongs there
- buildSandboxEnv allowlist and buildSandboxOptions (enabled/failIfUnavailable/network allowlist//mnt deny) must NOT be weakened
- Suite stays green (733) + add regression test for the command mapping; gate: npx vitest run && npx tsc --noEmit && npx biome check .
- halt.ts / kill-switch untouched; wsl.exe --terminate teardown semantics preserved
- Known-good environment facts: distro claude works interactively (`claude -p` verified); stale claude PID 6585 + python3 http.server 5555 running inside distro (harmless)

## Eliminated

- hypothesis: "distro/claude broken or not logged in" — eliminated 2026-07-11: `claude -p "Reply with exactly: ok"` returned "ok" inside the distro as builder (SANDBOX-SETUP proof d).
- hypothesis: "genuine musl/glibc mismatch of the win32 binary" — eliminated: the binary is win32-x64 on a Windows host; the message fires from the generic launch-failure heuristic, and the actual spawn is wrapped through wsl.exe into Linux where the Windows path/binary is definitionally unusable.

## Resolution

root_cause: "createSandboxAdapter.spawn() (src/orchestrator/sandbox-process.ts) passes the SDK spawn contract into WSL2 untranslated, with four launch-fatal gaps: (1) the Linux allowlist env {PATH:'/usr/bin:/bin'} is set as the WINDOWS child env, so node's PATH lookup cannot find wsl.exe → spawn ENOENT (the observed failure — the SDK's error handler then misreports it as a claude.exe libc launch failure); (2) opts.command (host claude.exe / node.exe+cli.js) is passed verbatim into a distro with automount+interop off → exit 127; (3) the `--` form routes through the distro shell, mangling backslashes and JSON args → must be --exec; (4) the allowlist env never reaches the Linux process (no WSLENV) and opts.cwd is untranslatable. SECONDARY (unmasked by the fix): the distro lacked the CLI's sandbox dependencies (bubblewrap + socat), so failIfUnavailable:true correctly refused every turn until they were installed."
fix: "sandbox-process.ts now translates the SDK launch contract field-by-field: spawns absolute %SystemRoot%\\System32\\wsl.exe (resolveWslExePath) with an EMPTY Windows-side env (strictly stronger isolation — nothing of the host env exists in the child); maps opts.cwd → --cd (POSIX-absolute passthrough, else ~); uses --exec for byte-exact argv (no distro shell); injects the buildSandboxEnv allowlist Linux-side via /usr/bin/env KEY=VAL; substitutes config.distroClaudePath (/usr/bin/claude, env-overridable via BUILD_DISTRO_CLAUDE_PATH) for the host claude.exe or node+cli.js prefix, passing SDK CLI flags verbatim (extractCliFlags drops the node-exec prefix through cli.js). terminate() also uses the absolute wsl.exe path."
verification: "Gate green: npx vitest run 757/757 (incl. rewritten sandbox-process.test.ts), tsc --noEmit clean, biome clean; secrets-isolation invariant intact. LIVE: probe query() through the real adapter → system init cwd=/home/builder inside distro, 'ok' result success, plan-billed. App-driven: real round (dev submits → gate → round 3 → winner → research → plan → build) — building stage SUSTAINED with /usr/bin/claude + socat sandbox proxy visible in distro ps; engine wrote /home/builder/demos/compliment-button/index.html (original 'no code ever written in sandbox' symptom gone). Terminal 'failed' after 300s was the pre-existing WR-07 per-turn watchdog aborting a live progressing turn — turn-budget policy, not the spawn bug. Environment remedy applied: bubblewrap 0.9.0 + socat installed in vibecoding-build (failIfUnavailable stays true); documented in SANDBOX-SETUP.md."
files_changed: [src/orchestrator/sandbox-process.ts, src/orchestrator/sandbox-process.test.ts, .planning/phases/03-sandboxed-build-engine-live-show/SANDBOX-SETUP.md]
