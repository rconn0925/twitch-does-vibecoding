// Public OBS overlay client — vanilla JS, no framework (UI-SPEC contract).
//
// Rendering rule (T-02-19, stored-XSS on the BROADCAST surface): all
// chat-derived strings — candidate titles, queue titles — render via
// textContent only, through the same el() helper the operator console uses.
// This file never assigns HTML strings to the DOM; titles are opaque plain
// text truncated to 80 chars (vote rows) / 60 chars (queue chips).
//
// Broadcast rules (D2-18): no error text EVER renders here. On ws disconnect
// the last render freezes and reconnection retries silently with backoff.
// Empty states are silent absence — no placeholder text on stream.
(() => {
  const statePill = document.getElementById("state-pill");
  const phaseBanner = document.getElementById("phase-banner");
  const votePanel = document.getElementById("vote-panel");
  const queueStrip = document.getElementById("queue-strip");

  // The build-status panel (PRES-02/04) reuses the vote panel's lower-left
  // slot — VOTING_ROUND and BUILD_IN_PROGRESS are mutually exclusive modes, so
  // the two panels never render at once. index.html ships the three Phase 2
  // blocks; this fourth block is created here (textContent-only, never
  // innerHTML) and appended once, so no HTML markup is authored anywhere.
  const buildPanel = document.createElement("section");
  buildPanel.className = "build-panel";
  buildPanel.id = "build-panel";
  buildPanel.hidden = true;
  document.body.appendChild(buildPanel);

  // The free-reign window banner (PAID-01/02) anchors the previously-unused
  // top-left corner. Like the build panel it's created here (textContent-only,
  // never innerHTML) and appended once, so no HTML markup is authored anywhere.
  // It is driven by state.controlWindow — NOT the pill — so it persists across
  // the FREE_REIGN_WINDOW → BUILD_IN_PROGRESS transition while the donor's build
  // runs, and collapses silently on expiry/revoke (banner independence rule).
  const banner = document.createElement("section");
  banner.className = "free-reign-banner";
  banner.id = "free-reign-banner";
  banner.hidden = true;
  document.body.appendChild(banner);

  /** Latest OverlayState from the ws push (full state every message). */
  let latest = null;
  /** Closed round snapshot held for the 8-second winner beat, or null. */
  let winnerBeatRound = null;
  let winnerBeatTimer = null;
  /** The "done" BuildStatusView held for the 8-second BUILT IT beat, or null. */
  let doneBeat = null;
  let doneBeatTimer = null;
  /**
   * The last real pipeline step seen (researching/planning/building). The
   * failed/refused stages carry no step of their own, so the stepper freezes
   * at this remembered step rather than jumping (UI-SPEC "freeze at current").
   */
  let lastActiveStage = null;

  const VOTE_TITLE_MAX = 80;
  const QUEUE_TITLE_MAX = 60;
  const BUILD_TITLE_MAX = 80;
  // Donor display name is attacker-controlled (StreamElements displayName /
  // EventSub user_name) — JS-truncated to 24 chars, CSS ellipsis is the backstop
  // (T-04-12). The donation message text is never rendered here at all.
  const DONOR_NAME_MAX = 24;
  const WINNER_BEAT_MS = 8000;
  const FINAL_COUNTDOWN_MS = 10000;

  // Fixed, orchestrator-authored copy — never chat-derived, so always safe.
  // quick-0iu straight-to-build: the pipeline has ONE step (Build). The legacy
  // researching/planning keys stay mapped to step 0 so a restored/late legacy
  // stage value renders the single step sanely (vocabulary tolerated, never
  // emitted by the live pipeline).
  const BUILD_STEPS = [{ key: "build", label: "Build" }];
  const STAGE_STEP_INDEX = { researching: 0, planning: 0, building: 0 };
  const STAGE_CAPTION = {
    researching: "Digging into the idea",
    planning: "Drafting the build plan",
    building: "Writing the code",
    done: "Live on screen now",
    failed: "Regrouping…",
    refused: "Skipping this one",
  };
  // failed/refused caption is amber (honest but calm) — never red on stream.
  const AMBER_STAGES = new Set(["failed", "refused"]);

  // quick-ur2 command layer C: the CLIENT-side chip label for a candidate's
  // CandidateKind. The enum string is the ONLY thing on the wire; this fixed
  // lookup composes the human label. An unknown/missing kind yields undefined →
  // NO chip (fail closed) — we never build a chip for an unrecognized kind.
  const KIND_CHIP = {
    "project-switch": "NEW",
    suggestion: "TWEAK",
    swap: "SWAP",
    revert: "REVERT",
  };

  // --- tiny DOM helpers (textContent-only construction, from console.js) ---

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** JS-side truncation with an ellipsis; CSS nowrap/ellipsis is the backstop. */
  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  /** m:ss from a millisecond remainder, floored at 0:00. */
  function formatRemaining(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  /** Remaining ms: the frozen remainder while frozen (display holds), else clock math. */
  function roundRemainingMs(round) {
    if (round.frozen && round.remainingMs !== null) return round.remainingMs;
    return round.endsAtMs - Date.now();
  }

  // --- state pill (top-right, the only permanent element) ---

  const PILL_VARIANTS = {
    STANDBY: "pill-standby",
    "VOTING OPEN": "pill-voting",
    BUILDING: "pill-building",
    "ON HOLD": "pill-onhold",
    // The two Phase 4 words. FREE REIGN carries the violet paid-control dot;
    // CHAOS carries a slate-50 white dot — paid and chaos NEVER share a visual
    // identity (04-UI-SPEC, mirrors D-08). Violet is paid-only, everywhere.
    "FREE REIGN": "pill-freereign",
    CHAOS: "pill-chaos",
  };

  function renderPill(state) {
    statePill.replaceChildren();
    const variant = PILL_VARIANTS[state.pill] || "pill-standby";
    statePill.className = `state-pill ${variant}`;
    statePill.appendChild(el("span", "pill-dot"));
    statePill.appendChild(el("span", "pill-text", state.pill));
    statePill.hidden = false;
  }

  // --- queue strip (bottom-right, hidden entirely when empty) ---

  // Scene-level opt-out: `?nextup=off` suppresses the strip for scenes that
  // already show the dedicated what's-coming page (/queue) — frees the
  // bottom-right band for a full-height chat column. Display-only; the
  // queue itself is unaffected.
  const NEXTUP_OFF = new URLSearchParams(location.search).get("nextup") === "off";

  function renderQueue(state) {
    if (NEXTUP_OFF) {
      queueStrip.hidden = true;
      return;
    }
    queueStrip.replaceChildren();
    const nextUp = Array.isArray(state.nextUp) ? state.nextUp.slice(0, 3) : [];
    if (nextUp.length === 0) {
      queueStrip.hidden = true;
      return;
    }
    queueStrip.hidden = false;
    queueStrip.appendChild(el("span", "queue-label", "NEXT UP"));
    for (const title of nextUp) {
      queueStrip.appendChild(el("span", "queue-chip", truncate(title, QUEUE_TITLE_MAX)));
    }
  }

  // --- free-reign banner (top-left; mounted whenever a control window is active) ---

  // Coarse by design: donor display name + m:ss countdown ONLY. No amount, no
  // currency, no donation message — those never cross onto the public wire
  // (server sends {donorDisplayName,endsAtMs} only; T-04-13). On expiry/revoke
  // the server pushes controlWindow:null and this collapses silently — no
  // "expired"/"revoked" text, no red, ever (T-04-14). The countdown ticks
  // client-side from the absolute endsAtMs (the server never streams timer
  // frames), resynced on every push, exactly like the vote countdown.
  // Three-state priority (quick-rs3): FREE REIGN (paid window, unchanged) >
  // CHAOS MODE (chat-activated timed window, slate-50 white dot — NEVER
  // violet, which stays exclusively paid-control per D2-18) > DEMOCRATIC MODE.
  // Chaos expiry/server-null collapses to DEMOCRATIC silently — no "expired"
  // text, no red, ever (the T-04-14 rule extended to the chaos badge).
  function renderBanner() {
    banner.replaceChildren();
    const cw = latest?.controlWindow ?? null;
    banner.hidden = false;
    if (!cw) {
      const chaos = latest?.chaosMode ?? null;
      // The client-side clock can pass endsAtMs before the server's expiry
      // push lands — the > check keeps the badge honest in that gap.
      if (chaos && chaos.endsAtMs > Date.now()) {
        // Class hygiene: each branch removes the other branches' classes.
        banner.classList.remove("banner-democratic");
        banner.classList.add("banner-chaos");
        banner.appendChild(el("span", "banner-dot"));
        banner.appendChild(el("span", "banner-label", "CHAOS MODE"));
        const chaosRemaining = chaos.endsAtMs - Date.now();
        const chaosCountdown = el("span", "banner-countdown", formatRemaining(chaosRemaining));
        // Amber for the final 10 seconds — the free-reign pattern, never red.
        if (chaosRemaining <= FINAL_COUNTDOWN_MS) {
          chaosCountdown.classList.add("countdown-final");
        }
        banner.appendChild(chaosCountdown);
        return;
      }
      // Persistent mode badge (Ross, 2026-07-11): the banner never collapses —
      // no active window means the show is in its default chat-voted mode.
      // Fixed copy only; the free-reign no-expiry/no-red rules (T-04-14) hold.
      banner.classList.remove("banner-chaos");
      banner.classList.add("banner-democratic");
      banner.appendChild(el("span", "banner-dot"));
      banner.appendChild(el("span", "banner-label", "DEMOCRATIC MODE"));
      return;
    }
    banner.classList.remove("banner-democratic");
    banner.classList.remove("banner-chaos");

    banner.appendChild(el("span", "banner-dot"));
    banner.appendChild(el("span", "banner-label", "FREE REIGN"));
    // The ONE chat-derived string on the banner: textContent-only via el(),
    // JS-truncated to 24 chars (CSS ellipsis is the backstop) — T-04-12.
    banner.appendChild(el("span", "banner-donor", truncate(cw.donorDisplayName, DONOR_NAME_MAX)));

    const remaining = cw.endsAtMs - Date.now();
    const countdown = el("span", "banner-countdown", formatRemaining(remaining));
    // Amber for the final 10 seconds — consistent with the vote countdown,
    // never red (reuses the shared .countdown-final rule).
    if (remaining <= FINAL_COUNTDOWN_MS) {
      countdown.classList.add("countdown-final");
    }
    banner.appendChild(countdown);

    // quick-ur2 T5: a fixed muted usage hint telling the donor HOW to spend
    // their window. FREE-REIGN-only: the DEMOCRATIC and CHAOS branches above
    // both return before reaching here, so this appends solely while a control
    // window is active. Fixed, orchestrator-authored copy — NO amount, NO
    // donation-message text ever rides here (T-04-12/13 hold).
    banner.appendChild(el("span", "banner-hint", "!build or !suggest — straight to the queue"));
  }

  // --- vote panel (lower-left; visible while a round is open or the winner beat runs) ---

  // A2 (quick-t5k) how-to-vote line, fixed copy, never chat-derived. Up to 3
  // options the explicit list reads best ("type !vote 1 / !vote 2 / !vote 3");
  // above 3 the per-option list would overflow the 900px banner, so it
  // compresses to the range form ("type !vote 1–5") — quick-l2a.
  function voteHint(candidateCount) {
    if (candidateCount > 3) {
      return `type !vote 1–${candidateCount}`;
    }
    const options = [];
    for (let i = 1; i <= candidateCount; i += 1) {
      options.push(`!vote ${i}`);
    }
    return `type ${options.join(" / ")}`;
  }

  /** The option number of the UNIQUE current leader, or null when tied/zero. */
  function leaderOption(round) {
    if (round.totalVotes === 0) return null;
    let best = null;
    let bestVotes = -1;
    let tied = false;
    for (const entry of round.candidates) {
      if (entry.votes > bestVotes) {
        best = entry.option;
        bestVotes = entry.votes;
        tied = false;
      } else if (entry.votes === bestVotes) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  function candidateRow(entry, round, beatActive, leader) {
    const row = el("div", "vote-row");
    if (beatActive) {
      row.classList.add(entry.option === round.winnerOption ? "vote-row-winner" : "vote-row-loser");
    }

    const top = el("div", "vote-row-top");
    const badge = el("span", "vote-badge", String(entry.option));
    if (!beatActive && entry.option === leader) badge.classList.add("vote-badge-leader");
    top.appendChild(badge);
    top.appendChild(
      el("span", "vote-candidate-title", truncate(entry.candidate.text, VOTE_TITLE_MAX)),
    );
    // quick-ur2: kind chip (NEW/TWEAK/SWAP/REVERT) from the closed enum already
    // on the wire (entry.candidate.kind). Fail-closed: an unknown/missing kind
    // yields no label → no chip. textContent-only via el().
    const kindLabel = KIND_CHIP[entry.candidate.kind];
    if (kindLabel) {
      top.appendChild(el("span", "kind-chip", kindLabel));
    }
    if (beatActive && entry.option === round.winnerOption) {
      top.appendChild(el("span", "winner-label", "WINNER"));
    }
    top.appendChild(el("span", "vote-count", String(entry.votes)));
    row.appendChild(top);

    const track = el("div", "tally-track");
    const fill = el("div", "tally-fill");
    // 0 total votes -> every bar empty (never divide by zero).
    fill.style.width = round.totalVotes > 0 ? `${(entry.votes / round.totalVotes) * 100}%` : "0%";
    track.appendChild(fill);
    row.appendChild(track);
    return row;
  }

  // --- phase banner (top-center; participation guidance + countdown) ---

  // A2 (quick-t5k, repositioned): the how-to-participate guidance lives on a
  // dedicated top-center banner — "SUGGESTIONS OPEN — type !suggest …" while
  // the auto-cycle collects, "VOTE NOW — type !vote 1 / !vote 2 …" while a
  // round runs. Same Dominant backing panel (no bare text over video), same
  // countdown classes, silent-absent outside both phases (D2-18). Countdown
  // ticks CLIENT-side from the pushed absolute deadline — the server never
  // streams per-second frames (same contract as the vote clock). The banner is
  // independent of the lower-left slot, so guidance stays visible while a
  // concurrent build occupies the build panel.
  function renderPhaseBanner() {
    phaseBanner.replaceChildren();
    const liveRound = latest?.round?.status === "open" ? latest.round : null;
    if (liveRound) {
      phaseBanner.hidden = false;
      const remaining = roundRemainingMs(liveRound);
      const countdown = el("span", "phase-countdown", formatRemaining(remaining));
      if (!liveRound.frozen && remaining <= FINAL_COUNTDOWN_MS) {
        countdown.classList.add("countdown-final");
      }
      // Two-row banner: title + live timer on top, participation hint below.
      const top = el("div", "phase-toprow");
      top.appendChild(el("span", "phase-title", "VOTE NOW"));
      top.appendChild(countdown);
      phaseBanner.appendChild(top);
      phaseBanner.appendChild(el("span", "phase-hint", voteHint(liveRound.candidates.length)));
      return;
    }
    const sp = latest?.suggestPhase ?? null;
    if (sp) {
      phaseBanner.hidden = false;
      const remaining = sp.endsAtMs - Date.now();
      const countdown = el("span", "phase-countdown", formatRemaining(remaining));
      if (remaining <= FINAL_COUNTDOWN_MS) {
        countdown.classList.add("countdown-final");
      }
      // Two-row banner (Ross 2026-07-12): "Suggestions open:" + timer on the top
      // row, then the vague participation nudge below. Chat has many commands now
      // (see the on-screen COMMANDS panel), so the hint names none. Fixed copy —
      // never chat-derived.
      const top = el("div", "phase-toprow");
      top.appendChild(el("span", "phase-title", "Suggestions open:"));
      top.appendChild(countdown);
      phaseBanner.appendChild(top);
      phaseBanner.appendChild(el("span", "phase-hint", "type a command to jump in"));
      return;
    }
    phaseBanner.hidden = true;
  }

  function renderVotePanel() {
    votePanel.replaceChildren();
    const liveRound = latest?.round?.status === "open" ? latest.round : null;
    // Slot precedence (quick-t5k reconciliation point 2): a LIVE round owns the
    // shared lower-left slot even while a build runs — concurrent rounds must
    // stay votable on screen; the pill still reads BUILDING. Without a live
    // round, the build panel keeps the slot while a build is live or the BUILT
    // IT beat runs.
    if (!liveRound && buildPanelActive()) {
      votePanel.hidden = true;
      return;
    }
    // A newly opened round always outranks a lingering winner beat.
    const beatActive = liveRound === null && winnerBeatRound !== null;
    const round = liveRound || winnerBeatRound;
    if (!round) {
      votePanel.hidden = true;
      return;
    }
    votePanel.hidden = false;
    // Compact spacing above 5 rows (quick-l2a): the default ROUND_MAX_OPTIONS
    // is 5 and fits at full size; a custom knob above 5 tightens the rows so
    // the panel never collides with the top-banner band at 1080p.
    votePanel.classList.toggle("vote-panel-compact", round.candidates.length > 5);

    // The participation guidance (title / how-to / countdown) lives on the
    // top-center phase banner (renderPhaseBanner) — while a round runs this
    // panel is tallies only. The 8s winner beat keeps its "Round over" header.
    if (beatActive) {
      const header = el("div", "vote-header");
      header.appendChild(el("h1", "vote-title", "Round over"));
      votePanel.appendChild(header);
    }

    const leader = beatActive ? null : leaderOption(round);
    const rows = el("div", "vote-rows");
    for (const entry of round.candidates) {
      rows.appendChild(candidateRow(entry, round, beatActive, leader));
    }
    votePanel.appendChild(rows);
  }

  function startWinnerBeat(closedRound) {
    winnerBeatRound = closedRound;
    if (winnerBeatTimer) clearTimeout(winnerBeatTimer);
    winnerBeatTimer = setTimeout(() => {
      winnerBeatRound = null;
      winnerBeatTimer = null;
      renderVotePanel(); // beat over -> panel collapses
    }, WINNER_BEAT_MS);
  }

  // --- build-status panel (lower-left; reuses the vote-panel slot) ---

  // Which stepper step (0..BUILD_STEPS.length-1) is active; BUILD_STEPS.length
  // means all steps complete (done). failed/refused carry no step of their
  // own -> freeze at the last real step.
  function effectiveStepIndex(stage) {
    if (stage === "done") return BUILD_STEPS.length;
    if (stage === "failed" || stage === "refused") {
      return lastActiveStage !== null ? STAGE_STEP_INDEX[lastActiveStage] : 0;
    }
    const idx = STAGE_STEP_INDEX[stage];
    return idx === undefined ? 0 : idx;
  }

  // The build panel is mounted while a non-done build is live OR the 8s BUILT
  // IT beat runs. A "done" stage shows ONLY through the beat, never as a static
  // panel, so a lingering done buildStatus can't pin the panel open forever.
  function buildPanelActive() {
    if (doneBeat !== null) return true;
    const bs = latest?.buildStatus ?? null;
    return bs !== null && bs.stage !== "done";
  }

  function renderBuildPanel() {
    buildPanel.replaceChildren();
    // Slot precedence (quick-t5k): a LIVE concurrent round owns the shared
    // lower-left slot — the build story stays on the BUILDING pill until the
    // round closes (pill precedence, reconciliation point 2).
    if (latest?.round?.status === "open") {
      buildPanel.hidden = true;
      return;
    }
    const beatActive = doneBeat !== null;
    const bs = beatActive ? doneBeat : (latest?.buildStatus ?? null);
    if (!bs || (!beatActive && bs.stage === "done")) {
      buildPanel.hidden = true;
      return;
    }
    buildPanel.hidden = false;

    const header = el("div", "build-header");
    header.appendChild(el("h1", "build-title", beatActive ? "BUILT IT" : "NOW BUILDING"));
    // Provenance chip (PAID-01/02/CHAOS-01): fixed orchestrator-authored copy
    // (never chat-derived) telling viewers HOW this build was picked. An absent
    // source defaults to "vote" → no chip (Wave-1 made source optional). Violet
    // "FREE REIGN" for a paid/redemption window instruction; neutral "CHAOS
    // PICK" for a random pick; nothing for a normal vote winner.
    const source = bs.source ?? "vote";
    if (source === "donation" || source === "channel_points") {
      header.appendChild(el("span", "provenance-chip chip-freereign", "FREE REIGN"));
    } else if (source === "chaos") {
      header.appendChild(el("span", "provenance-chip chip-chaos", "CHAOS PICK"));
    }
    buildPanel.appendChild(header);

    // The ONE chat-derived string on this panel: textContent-only via el(),
    // JS-truncated to 80 chars (CSS ellipsis is the backstop) — T-03-15.
    buildPanel.appendChild(el("div", "build-task", truncate(bs.title, BUILD_TITLE_MAX)));

    const stepper = el("div", "build-stepper");
    const activeIndex = effectiveStepIndex(bs.stage);
    BUILD_STEPS.forEach((step, i) => {
      if (i > 0) stepper.appendChild(el("div", "build-connector"));
      const stepEl = el("div", "build-step");
      let stateClass;
      if (activeIndex === BUILD_STEPS.length || i < activeIndex) stateClass = "step-complete";
      else if (i === activeIndex) stateClass = "step-active";
      else stateClass = "step-upcoming";
      stepEl.classList.add(stateClass);
      stepEl.appendChild(el("span", "build-step-badge"));
      stepEl.appendChild(el("span", "build-step-label", step.label));
      stepper.appendChild(stepEl);
    });
    buildPanel.appendChild(stepper);

    const caption = el("div", "build-caption", STAGE_CAPTION[bs.stage] || "");
    if (AMBER_STAGES.has(bs.stage)) caption.classList.add("build-caption-amber");
    buildPanel.appendChild(caption);
  }

  function startDoneBeat(doneStatus) {
    doneBeat = doneStatus;
    if (doneBeatTimer) clearTimeout(doneBeatTimer);
    doneBeatTimer = setTimeout(() => {
      doneBeat = null;
      doneBeatTimer = null;
      // Beat over -> the build panel collapses; the vote panel may reclaim the
      // slot on the next push (pill has already flipped to STANDBY server-side).
      renderAll();
    }, WINNER_BEAT_MS);
  }

  function clearDoneBeat() {
    if (doneBeatTimer) clearTimeout(doneBeatTimer);
    doneBeatTimer = null;
    doneBeat = null;
  }

  // --- master render + push handling ---

  function renderAll() {
    if (!latest) return;
    renderPill(latest);
    renderQueue(latest);
    renderBanner();
    renderBuildPanel();
    renderVotePanel();
    renderPhaseBanner();
  }

  function handleState(state) {
    latest = state;
    if (state.round && state.round.status === "closed" && state.round.winnerOption !== null) {
      startWinnerBeat(state.round);
    }
    const bs = state.buildStatus;
    if (bs) {
      if (bs.stage === "done") {
        // Kick off the 8s celebratory beat (mirrors the winner beat). The
        // server may null buildStatus right after as the pill flips to STANDBY;
        // the beat is held client-side so BUILT IT stays up the full 8s.
        startDoneBeat(bs);
      } else {
        // A live (non-done) build supersedes any lingering done beat and
        // records the last real pipeline step for the failed/refused freeze.
        clearDoneBeat();
        if (bs.stage === "researching" || bs.stage === "planning" || bs.stage === "building") {
          lastActiveStage = bs.stage;
        }
      }
    }
    renderAll();
  }

  // 1s countdown tick: re-render the phase banner while a round runs OR a
  // suggestion phase is collecting (quick-t5k A2 — both countdowns tick
  // client-side between pushes) so the clock stays honest between pushes.
  // A frozen round re-renders to the same held remainingMs — the display
  // simply stops moving (D2-16 honesty).
  setInterval(() => {
    if (latest?.round?.status === "open" || latest?.suggestPhase) {
      renderPhaseBanner();
    }
    // Keep the banner countdown honest between pushes while a window is active
    // (it ticks even after the pill flips to BUILDING — banner independence).
    if (latest?.controlWindow) {
      renderBanner();
    }
    // Keep the CHAOS MODE m:ss countdown honest between pushes (quick-rs3).
    // When the client clock passes endsAtMs before the server's expiry push
    // lands, renderBanner's `endsAtMs > Date.now()` branch check already falls
    // through to DEMOCRATIC — honest without red or "expired" copy.
    if (latest?.chaosMode) {
      renderBanner();
    }
  }, 1000);

  // Hand-rolled ws reconnect with backoff (console.js pattern, minus the
  // banner): full state arrives on connect, then a push on every change.
  // OBS scene-switch reloads take this exact path — a fresh connect()
  // reconstructs the whole UI from the first message.
  let attempts = 0;
  function connect() {
    const socket = new WebSocket(`ws://${location.host}`);
    socket.addEventListener("open", () => {
      attempts = 0;
    });
    socket.addEventListener("message", (event) => {
      try {
        handleState(JSON.parse(event.data));
      } catch {
        // Malformed frame: ignore; the next push resyncs the full state.
      }
    });
    socket.addEventListener("close", () => {
      // Broadcast rule: freeze the last render, retry silently. No error
      // text, no disconnected banner — the console is where errors show.
      const delay = Math.min(500 * 2 ** attempts, 8000);
      attempts += 1;
      setTimeout(connect, delay);
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }
  connect();
})();
