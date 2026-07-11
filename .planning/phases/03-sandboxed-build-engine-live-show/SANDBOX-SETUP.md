# Sandbox Setup & Go/No-Go — Phase 3 Wave 0

> **VERDICT: ✅ GO — streamer validation performed 2026-07-10; all 5 proofs PASS.**
> This is the Wave 0 (plan 03-01) human-verification gate. The automated code waves (03-02..03-09)
> are built against INJECTED FAKES that model the contract below, so they proceed before this gate.
> **The gate is now closed: real builds are cleared.** The Docker escalation path
> (03-RESEARCH.md §Alternatives / Open Question 4) was not needed.

## Validated Constants (defaults — confirm/adjust during setup)

| Constant | Default | Confirmed value | Notes |
|----------|---------|-----------------|-------|
| `BUILD_DISTRO_NAME` | `vibecoding-build` | `vibecoding-build` | Dedicated build-only distro; never the interactive dev distro |
| `BUILD_DISTRO_USER` | `builder` | `builder` | Unprivileged, empty home (no ~/.ssh, ~/.aws, personal files) |
| `PREVIEW_DEV_SERVER_PORT` | `5555` | `5555` | Fixed dev-server port the app-under-construction binds to |
| `networkingMode` | `NAT (default)` | `NAT` — confirmed, not mirrored | MUST NOT be `mirrored` (would defeat loopback trust) |

These become env vars consumed by `src/orchestrator/sandbox-process.ts` (03-05) and `src/preview/preview-manager.ts` (03-08). The code reads them with the above defaults, so it builds/tests against fakes regardless; real execution uses the confirmed values.

## Setup checklist (Task 1 — human-action)

- [x] WSL2 + dedicated Ubuntu build distro installed (`wsl -l -v` shows it as version 2) — paste output below
- [x] Dedicated unprivileged user created, empty home
- [x] `/etc/wsl.conf` → `[automount] enabled = false` (closes the `/mnt/c` exposure gap structurally) — paste below. Note: `[interop] enabled = false` was ALSO set — added hardening beyond this checklist; the sandbox cannot launch Windows executables.
- [x] `.wslconfig` does NOT enable mirrored networking (NAT stays) — no `%USERPROFILE%\.wslconfig` exists at all, so the NAT default is confirmed.
- [x] One-time `claude login` INSIDE the distro as the build user (its own `~/.claude/`; do NOT copy host's)
- [x] Node.js + npm installed in the distro — Node v24.18.0 + npm 11.16.0 (NodeSource) + Claude Code CLI 2.1.206 (global)
- [x] Host `ANTHROPIC_API_KEY` confirmed UNSET (`echo %ANTHROPIC_API_KEY%` empty) — paste below

```
(recorded 2026-07-10) wsl -l -v: WSL 2.7.10.0, kernel 6.18.33.2-2; distro `vibecoding-build` (Ubuntu 24.04) registered, VERSION 2; it is the ONLY distro.
(recorded 2026-07-10) /etc/wsl.conf (verified by cat):
    [automount]
    enabled = false
    [interop]
    enabled = false
    appendWindowsPath = false
    [user]
    default = builder
(recorded 2026-07-10) Host ANTHROPIC_API_KEY: UNSET in process, User, and Machine scopes (checked via [Environment]::GetEnvironmentVariable in all three scopes).
```

## Proofs (Task 2 — the go/no-go)

| # | Proof | Requirement | Result |
|---|-------|-------------|--------|
| a | `cat /mnt/c/Users/ross/.env` FAILS; `echo test > /etc/passwd` FAILS; `ls /` shows only workspace+minimal | SAND-01 | ✅ PASS |
| b | dev server on `127.0.0.1:5555` reachable from Windows browser; sandbox CANNOT curl host `127.0.0.1:4900`/`4901` | SAND-02 | ✅ PASS |
| c | `wsl.exe --terminate <distro>` kills a deliberately-hung process tree in seconds (tree-kill on the wsl.exe PID alone is NOT enough) | BUILD-04 | ✅ PASS |
| d | a `claude` invocation inside the distro draws on the SAME plan credits as the host — NOT metered per-token. If FALSE → record sandbox-scoped-key fallback decision | A1 (billing) | ✅ PASS |
| e | cold (post-terminate) + warm distro launch latency measured; acceptable for live pacing | latency | ✅ PASS |

```
(recorded 2026-07-10) Proof results:

(a) SAND-01 — PASS. `cat /mnt/c/Users/ross/.env` → "No such file or directory"
    (/mnt/c is an empty stub dir; `mount | grep drvfs` → no drvfs mounts at all);
    `echo test > /etc/passwd` as builder → Permission denied;
    `ls /` shows standard minimal Ubuntu root only.

(b) SAND-02 — PASS. python3 http.server on 5555 inside sandbox; from Windows
    `curl 127.0.0.1:5555/index.html` → correct body "hello-from-sandbox", exit 0
    (OBS browser-source path works); from inside sandbox `curl -m2 127.0.0.1:4900`
    and `:4901` → both exit 7 connection refused (NAT loopback is distro-local;
    structural isolation).
    CAVEAT (recorded honestly): host orchestrator was not running during the test —
    the pass is architectural (NAT), not a live-port probe.

(c) BUILD-04 — PASS. 2-process hung bash loop tree started inside distro;
    `wsl.exe --terminate vibecoding-build` completed in 32 ms (Stopwatch-measured);
    relaunch shows zero surviving processes.

(d) A1 billing — PASS. `claude -p` inside distro as builder returns correct reply
    with NO ANTHROPIC_API_KEY present anywhere → OAuth plan-credit billing, same
    plan as host login; sandbox-scoped-key fallback NOT needed.

(e) latency — PASS. Cold launch (post-terminate) 259 ms, warm exec 66 ms — well
    within live-show pacing.
```

## A1 billing result

- [x] Same plan credits as host (GO on billing), **or**
- [ ] Metered → using sandbox-scoped `SANDBOX_ANTHROPIC_API_KEY` fallback (injected ONLY into the sandbox env, never the host) — 03-05 wires this path

Note: the sandbox-scoped-key fallback is NOT needed — `claude -p` as `builder` returned a correct reply with no `ANTHROPIC_API_KEY` anywhere → OAuth plan-credit billing, same plan as the host login.

## Final verdict

**GO / NO-GO: ✅ GO** — recorded 2026-07-10. Proofs (a), (b), (c) PASS; (d) plan-credit billing confirmed; (e) cold 259 ms / warm 66 ms.
