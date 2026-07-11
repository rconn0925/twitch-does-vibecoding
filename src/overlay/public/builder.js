// Builder-view page client (quick-x7d) — vanilla JS, no framework.
//
// Rendering rule (T-02-19 / T-x7d-03, stored-XSS on the BROADCAST surface):
// every wire string — the build title, activity paths, code snippets — renders
// via textContent ONLY through the same el() helper as overlay.js/queue.js.
// This file never assigns HTML strings to the DOM; wire strings are opaque
// plain text, JS-truncated with the CSS caps as the backstop. The server
// already guarantees every line is fixed orchestrator copy or COMP-02-approved
// content — this client defends in depth anyway.
//
// Broadcast rules (D2-18): on ws disconnect the last render freezes and
// reconnection retries silently with backoff — no error text ever. This page
// is push-driven only: no countdowns, no timers, no syntax highlighting.
(() => {
  const feedPanel = document.getElementById("feed-panel");

  // Defensive JS caps behind the server-side authoritative caps.
  const LINE_MAX = 120;
  const SNIPPET_MAX = 200;

  // CLOSED kind → class map. An unknown kind renders NOTHING (fail closed
  // client-side too — the wire vocabulary is fixed at 5 kinds).
  const KIND_CLASS = {
    title: "ai-title",
    stage: "ai-stage",
    "stage-warn": "ai-stage ai-warn",
    activity: "ai-activity",
    snippet: "ai-snippet",
  };

  /** Latest OverlayState from the ws push (full state every message). */
  let latest = null;

  // --- tiny DOM helpers (textContent-only construction, from overlay.js) ---

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** JS-side truncation with an ellipsis; the CSS clamp is the backstop. */
  function truncate(text, max) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function renderFeed(state) {
    feedPanel.replaceChildren();
    feedPanel.appendChild(el("div", "ai-label", "THE AI"));
    const feed = Array.isArray(state.builderFeed) ? state.builderFeed : [];
    if (feed.length === 0) {
      feedPanel.appendChild(el("div", "ai-empty", "standing by…"));
      return;
    }
    for (const line of feed) {
      const className = KIND_CLASS[line.kind];
      if (!className) continue; // unknown kind → skip entirely (fail closed)
      const max = line.kind === "snippet" ? SNIPPET_MAX : LINE_MAX;
      feedPanel.appendChild(el("div", className, truncate(line.text, max)));
    }
    // Pin the newest line visible — after every push AND the on-connect full
    // replay (the panel's overflow clips at the top/oldest edge).
    feedPanel.scrollTop = feedPanel.scrollHeight;
  }

  function handleState(state) {
    latest = state;
    renderFeed(latest);
  }

  // Hand-rolled ws reconnect with backoff (overlay.js/queue.js pattern): full
  // state arrives on connect, then a push on every change. OBS scene-switch
  // reloads take this exact path — a fresh connect() reconstructs the whole
  // feed from the first message. Broadcast rule: on disconnect freeze the
  // last render, retry silently — no error text ever.
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
