# Sandbox Setup & Go/No-Go — Phase 3 Wave 0

> **VERDICT: ⏳ PENDING — streamer validation not yet performed.**
> This is the Wave 0 (plan 03-01) human-verification gate. The automated code waves (03-02..03-09)
> are built against INJECTED FAKES that model the contract below, so they proceed before this gate.
> **No REAL build may execute until the verdict below reads GO.** A NO-GO on isolation or veto
> escalates to the Docker path (03-RESEARCH.md §Alternatives / Open Question 4).

## Validated Constants (defaults — confirm/adjust during setup)

| Constant | Default | Confirmed value | Notes |
|----------|---------|-----------------|-------|
| `BUILD_DISTRO_NAME` | `vibecoding-build` | _pending_ | Dedicated build-only distro; never the interactive dev distro |
| `BUILD_DISTRO_USER` | `builder` | _pending_ | Unprivileged, empty home (no ~/.ssh, ~/.aws, personal files) |
| `PREVIEW_DEV_SERVER_PORT` | `5555` | _pending_ | Fixed dev-server port the app-under-construction binds to |
| `networkingMode` | `NAT (default)` | _pending_ | MUST NOT be `mirrored` (would defeat loopback trust) |

These become env vars consumed by `src/orchestrator/sandbox-process.ts` (03-05) and `src/preview/preview-manager.ts` (03-08). The code reads them with the above defaults, so it builds/tests against fakes regardless; real execution uses the confirmed values.

## Setup checklist (Task 1 — human-action)

- [ ] WSL2 + dedicated Ubuntu build distro installed (`wsl -l -v` shows it as version 2) — paste output below
- [ ] Dedicated unprivileged user created, empty home
- [ ] `/etc/wsl.conf` → `[automount] enabled = false` (closes the `/mnt/c` exposure gap structurally) — paste below
- [ ] `.wslconfig` does NOT enable mirrored networking (NAT stays)
- [ ] One-time `claude login` INSIDE the distro as the build user (its own `~/.claude/`; do NOT copy host's)
- [ ] Node.js + npm installed in the distro
- [ ] Host `ANTHROPIC_API_KEY` confirmed UNSET (`echo %ANTHROPIC_API_KEY%` empty) — paste below

```
[ paste: wsl -l -v ]
[ paste: /etc/wsl.conf ]
[ paste: echo %ANTHROPIC_API_KEY% ]
```

## Proofs (Task 2 — the go/no-go)

| # | Proof | Requirement | Result |
|---|-------|-------------|--------|
| a | `cat /mnt/c/Users/ross/.env` FAILS; `echo test > /etc/passwd` FAILS; `ls /` shows only workspace+minimal | SAND-01 | ⏳ pending |
| b | dev server on `127.0.0.1:5555` reachable from Windows browser; sandbox CANNOT curl host `127.0.0.1:4900`/`4901` | SAND-02 | ⏳ pending |
| c | `wsl.exe --terminate <distro>` kills a deliberately-hung process tree in seconds (tree-kill on the wsl.exe PID alone is NOT enough) | BUILD-04 | ⏳ pending |
| d | a `claude` invocation inside the distro draws on the SAME plan credits as the host — NOT metered per-token. If FALSE → record sandbox-scoped-key fallback decision | A1 (billing) | ⏳ pending |
| e | cold (post-terminate) + warm distro launch latency measured; acceptable for live pacing | latency | ⏳ pending |

```
[ paste verbatim command output + PASS/FAIL for each proof (a)-(e) ]
```

## A1 billing result

- [ ] Same plan credits as host (GO on billing), **or**
- [ ] Metered → using sandbox-scoped `SANDBOX_ANTHROPIC_API_KEY` fallback (injected ONLY into the sandbox env, never the host) — 03-05 wires this path

## Final verdict

**GO / NO-GO:** ⏳ _pending — set to GO only after proofs (a), (b), (c) PASS and (d)/(e) are recorded._
