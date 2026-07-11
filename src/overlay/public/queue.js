// What's-coming page client (quick-v4e) — vanilla JS, no framework.
//
// Rendering rule (T-02-19, stored-XSS on the BROADCAST surface): all
// chat-derived strings — pool suggestion texts, suggester usernames, queue
// task texts — render via textContent ONLY through the same el() helper as
// overlay.js. This file never assigns HTML strings to the DOM; strings are
// opaque plain text, JS-truncated with the CSS ellipsis as the backstop.
//
// Broadcast rules (D2-18): on ws disconnect the last render freezes and
// reconnection retries silently with backoff — no error text ever. This page
// is push-driven only: no countdowns, no timers.
(() => {
  const poolPanel = document.getElementById("pool-panel");
  const queuePanel = document.getElementById("queue-panel");

  // 80-char text cap (the main overlay's vote-row pattern); 24-char username
  // cap (the donor-name precedent for attacker-controlled names, T-04-12).
  const TEXT_MAX = 80;
  const USER_MAX = 24;
  const QUEUE_MAX = 10;

  /** Latest OverlayState from the ws push (full state every message). */
  let latest = null;

  // --- tiny DOM helpers (textContent-only construction, from overlay.js) ---

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

  // --- suggestion pool section (top panel) ---

  function renderPool(state) {
    poolPanel.replaceChildren();
    poolPanel.appendChild(el("div", "wc-label", "SUGGESTION POOL"));
    const pool = Array.isArray(state.pool) ? state.pool : [];
    if (pool.length === 0) {
      poolPanel.appendChild(el("div", "wc-empty", "waiting for suggestions…"));
      return;
    }
    for (const item of pool) {
      // Stacked layout (440px panel): suggestion text on its own line, the
      // suggester's name muted underneath — both too wide to share a row.
      const row = el("div", "wc-row wc-row-stacked");
      row.appendChild(el("span", "wc-text", truncate(item.text, TEXT_MAX)));
      if (item.username !== null && item.username !== undefined) {
        row.appendChild(el("span", "wc-user", truncate(item.username, USER_MAX)));
      }
      poolPanel.appendChild(row);
    }
  }

  // --- up-next section (bottom panel: full build queue with positions) ---

  function renderQueue(state) {
    queuePanel.replaceChildren();
    queuePanel.appendChild(el("div", "wc-label", "UP NEXT"));
    const queue = Array.isArray(state.queue) ? state.queue.slice(0, QUEUE_MAX) : [];
    if (queue.length === 0) {
      queuePanel.appendChild(el("div", "wc-empty", "queue is empty"));
      return;
    }
    queue.forEach((text, index) => {
      const row = el("div", "wc-row");
      row.appendChild(el("span", "wc-pos", String(index + 1)));
      row.appendChild(el("span", "wc-text", truncate(text, TEXT_MAX)));
      queuePanel.appendChild(row);
    });
  }

  function handleState(state) {
    latest = state;
    renderPool(latest);
    renderQueue(latest);
  }

  // Hand-rolled ws reconnect with backoff (overlay.js pattern): full state
  // arrives on connect, then a push on every change. OBS scene-switch reloads
  // take this exact path — a fresh connect() reconstructs the whole UI from
  // the first message. Broadcast rule: on disconnect freeze the last render,
  // retry silently — no error text ever.
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
