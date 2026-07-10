# Stream-Night Dry Run — Phase 5 Go-Live Gate (05-03)

> **VERDICT: ⏳ PENDING — dry run not yet performed.**
> This is the v1 finish-line human gate (success criteria 2/3/4). Everything buildable in Phases 1–5
> was built against injected fakes or behind earlier deferred gates; this runbook is the ONE
> end-to-end rehearsal on a low-stakes **test channel** that ties them together and proves the format
> is ready for the first real stream night with **zero compliance incidents**.
> **Do not run a real stream night until the verdict below reads GO.** A NO-GO records the failing
> check; fix it and re-run the affected section.

## The rehearsal, in one line

Suggest → filter → vote → build → live preview, plus a real small donation window, a chaos round, a
kill-switch against a genuinely in-progress build, and an audit + changelog review — all on a test
channel, ending in a recorded GO / NO-GO.

---

## Section 1 — Preconditions (both earlier human gates must read GO first)

The dry run exercises the two deferred human gates end-to-end, so they must be cleared **before** it starts.

- [ ] **Phase 3 Wave 0 — WSL2 go/no-go = GO** in `.planning/phases/03-sandboxed-build-engine-live-show/SANDBOX-SETUP.md`
  (real proofs: (a) filesystem-escape isolation, (b) dev-server-only exposure on 127.0.0.1:5555, (c) `wsl.exe --terminate` kills a hung tree, (d) A1 billing recorded, (e) launch latency acceptable).
- [ ] **Phase 4 live gate = GO** in `.planning/phases/04-paid-influence-chaos-mode/04-LIVE-GATE.md`
  (StreamElements account + JWT bound; `channel:read:redemptions` broadcaster re-auth done; a custom channel-points reward created; a real tip + a real redemption smoke-tested; Bits AUP / chargeback claims manually re-read).

**If either is NOT GO, the dry run is BLOCKED.** Record which precondition is blocking and stop here.

```
[ Phase 3 Wave 0 verdict:  GO / NO-GO — link ]
[ Phase 4 live gate verdict: GO / NO-GO — link ]
```

## Section 2 — Test-channel setup (human-action)

- [ ] A **low-stakes test channel / account** (NOT the main channel) is live.
- [ ] The app is running; open all four surfaces: the **operator console** (private), the **overlay** (add as an OBS browser source), the **app-under-construction preview**, and the new **/history changelog** page.
- [ ] Host `ANTHROPIC_API_KEY` confirmed UNSET (plan-credit billing) unless the Wave-0 A1 result dictated the sandbox-scoped key fallback.
- [ ] A **small real tip** is ready to send through the donation platform, and the custom channel-points reward is redeemable.

*Resume signal for the first checkpoint: type `preconditions GO` once both earlier gates read GO and the test channel + app are ready — or describe what is still NO-GO / blocked.*

## Section 3 — Full-loop rehearsal (suggest → filter → vote → build → preview)

- [ ] `!suggest <a benign idea>` → it **enters the candidate pool**. `!suggest <a clearly disallowed idea>` → chat gets **category-level rejection feedback** (never silent, no raw echo of the disallowed text).
- [ ] Start a **timed vote round** → the **overlay** shows the live tally + countdown; `!vote 1/2/3` registers one vote per viewer, a revote overrides.
- [ ] The round closes → the **winner is announced in chat** and **queues through the compliance gate** (not a second path).
- [ ] The **sandboxed build** runs (research → plan → COMP-02 re-screen → build); the overlay stepper advances; the **app-under-construction preview** renders the sandbox dev server.
- [ ] On completion the overlay shows the done beat and the build appears on **/history** with a `VOTE` chip.

## Section 4 — Paid window + chaos round

- [ ] Send the **real small donation** → a **free-reign window** opens. On the **overlay** the banner shows **donor display-name + countdown ONLY — no amount, no message, no trigger type**. (The console may show the amount; the broadcast must not.)
- [ ] During the window, issue a build instruction → it **passes the same gate** and is **vetoable**; it **builds** (window stays open for its full duration, D-12).
- [ ] Redeem the **channel-points reward** → a smaller window opens the same way.
- [ ] Toggle **chaos mode** on the console → the system **randomly picks** the next task from the already-filtered pool and **builds it with no vote**; the overlay/history shows a `CHAOS PICK` chip. Toggle chaos off → the vote loop resumes.
- [ ] Confirm nothing on the broadcast couples payment to chance (paid = violet/guaranteed, chaos = neutral/random — never the same identity).

## Section 5 — Kill switch vs. a GENUINELY in-progress build

- [ ] Start a build and **wait until it is truly mid-session** (an agent turn actually running in the sandbox — not just queued).
- [ ] Trigger the **veto / Halt Everything** (console button and/or the panic hotkey).
- [ ] Confirm the build **aborts cleanly within seconds** (the `wsl.exe --terminate` teardown fires), the machine reaches **HALTED immediately**, there is **NO false "BUILT IT"** on the overlay, and **NO row is added to the changelog** for the killed build (the `finalizeAborted` path writes a teardown record, never a `build_history` row).
- [ ] Recover from HALTED and confirm the loop resumes normally.

## Section 6 — Audit + changelog review

- [ ] Open the **audit page** → confirm **zero unfiltered inputs reached an agent** (every candidate has a gate decision) and **every rejection produced chat feedback**.
- [ ] Open the **/history changelog** → confirm the night's completed builds appear with the **correct provenance chips** (VOTE / FREE REIGN / CHAOS PICK) and **honest results** (Built / Refused / Failed — calm amber, no red).
- [ ] Confirm the changelog shows **NO pre-gate / rejected-at-intake text** and **NO donor identity or amount** — it is safe to screen-share.
- [ ] Log any anomaly in the **Known Limitation Log** (below).

## Known Limitation Log (dry run)

| # | What happened | Section | Severity | Follow-up |
|---|---------------|---------|----------|-----------|
| _(none yet)_ | | | | |

## Final verdict

**GO / NO-GO:** ⏳ _pending — set to GO only after sections 3–6 all pass on the test channel with both preconditions (Section 1) already GO._

```
[ record: GO — v1 is dry-run-ready for the first real stream night ]
[    or:  NO-GO: <failing check> — fixed, re-run section <N> ]
[ dry-run date / test channel / operator: ______ ]
```

*Resume signal for the final checkpoint: type `GO` (all checks pass — v1 is dry-run-ready) or `NO-GO: <failing check>`.*
