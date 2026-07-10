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
  const votePanel = document.getElementById("vote-panel");
  const queueStrip = document.getElementById("queue-strip");

  /** Latest OverlayState from the ws push (full state every message). */
  let latest = null;
  /** Closed round snapshot held for the 8-second winner beat, or null. */
  let winnerBeatRound = null;
  let winnerBeatTimer = null;

  const VOTE_TITLE_MAX = 80;
  const QUEUE_TITLE_MAX = 60;
  const WINNER_BEAT_MS = 8000;
  const FINAL_COUNTDOWN_MS = 10000;

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

  function renderQueue(state) {
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

  // --- vote panel (lower-left; visible while a round is open or the winner beat runs) ---

  function voteHint(candidateCount) {
    return candidateCount === 2 ? "type !vote 1 or 2" : "type !vote 1, 2 or 3";
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

  function renderVotePanel() {
    votePanel.replaceChildren();
    const liveRound = latest?.round?.status === "open" ? latest.round : null;
    // A newly opened round always outranks a lingering winner beat.
    const beatActive = liveRound === null && winnerBeatRound !== null;
    const round = liveRound || winnerBeatRound;
    if (!round) {
      votePanel.hidden = true;
      return;
    }
    votePanel.hidden = false;

    const header = el("div", "vote-header");
    if (beatActive) {
      header.appendChild(el("h1", "vote-title", "Round over"));
    } else {
      header.appendChild(el("h1", "vote-title", "VOTE NOW"));
      // Countdown is computed CLIENT-side from endsAtMs on a 1s tick,
      // resynced on every push — the server never streams timer frames.
      const remaining = roundRemainingMs(round);
      const countdown = el("span", "vote-countdown", formatRemaining(remaining));
      if (!round.frozen && remaining <= FINAL_COUNTDOWN_MS) {
        countdown.classList.add("countdown-final");
      }
      header.appendChild(countdown);
    }
    votePanel.appendChild(header);

    if (!beatActive) {
      votePanel.appendChild(el("p", "vote-hint", voteHint(round.candidates.length)));
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

  // --- master render + push handling ---

  function renderAll() {
    if (!latest) return;
    renderPill(latest);
    renderQueue(latest);
    renderVotePanel();
  }

  function handleState(state) {
    latest = state;
    if (state.round && state.round.status === "closed" && state.round.winnerOption !== null) {
      startWinnerBeat(state.round);
    }
    renderAll();
  }

  // 1s countdown tick: re-render the vote panel while a round runs so the
  // clock stays honest between pushes. A frozen round re-renders to the same
  // held remainingMs — the display simply stops moving (D2-16 honesty).
  setInterval(() => {
    if (latest?.round?.status === "open" || winnerBeatRound !== null) {
      renderVotePanel();
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
