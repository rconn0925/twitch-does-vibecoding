// Audience-facing build-history changelog client (HIST-01 / 05-02) — vanilla JS.
//
// Rendering rule (dom-safety invariant, T-05-04): every text node is authored
// via textContent through the el() helper (copied from overlay.js). This file
// assigns NO HTML strings — no innerHTML/outerHTML/insertAdjacentHTML/
// document.write/eval. The suggestion title is chat-derived and UNTRUSTED, so it
// is rendered via textContent AND JS-truncated to 100 chars (CSS ellipsis is the
// backstop). tests/invariants/dom-safety.test.ts auto-scans this file.
//
// Read rule: the ONLY input is GET /api/history on THIS surface's own server,
// which returns the coarse public projection (buildId/title/provenance/result/
// timeLabel grouped into nights). No donor identity, amount, or trigger-type is
// ever fetched or rendered here — the server dropped it at the wire boundary.
//
// Broadcast rule: no stack trace, no HTTP code, no red EVER renders. A failed
// load reads as a calm, non-red "History's taking a break" card.
(() => {
  const root = document.getElementById("history-root");
  const TITLE_MAX = 100; // hard cap on the chat-derived title (05-UI-SPEC)

  // --- tiny DOM helpers (textContent-only, overlay.js el() discipline) -------

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

  // Fixed, orchestrator-authored vocabulary (never chat-derived). Provenance is
  // already coarsened to the 3-value public projection by the server.
  const CHIP = {
    vote: { label: "VOTE", className: "chip-vote" },
    paid: { label: "FREE REIGN", className: "chip-freereign" },
    chaos: { label: "CHAOS PICK", className: "chip-chaos" },
  };
  const RESULT = {
    built: { label: "Built", className: "result-built" },
    refused: { label: "Refused", className: "result-refused" },
    failed: { label: "Failed", className: "result-failed" },
  };

  // --- render ----------------------------------------------------------------

  function renderEntry(entry) {
    const row = el("div", "entry-row");

    const chip = CHIP[entry.provenance] ?? CHIP.vote;
    row.appendChild(el("span", `provenance-chip ${chip.className}`, chip.label));

    // The ONE chat-derived string on the row: textContent-only, 100-char cap.
    row.appendChild(el("span", "entry-title", truncate(entry.title, TITLE_MAX)));

    const result = RESULT[entry.result] ?? RESULT.built;
    const badge = el("span", `result-badge ${result.className}`);
    badge.appendChild(el("span", "result-dot"));
    badge.appendChild(el("span", undefined, result.label));
    row.appendChild(badge);

    row.appendChild(el("span", "entry-time", entry.timeLabel));
    return row;
  }

  function renderNight(night) {
    const group = el("div", "night-group");

    const heading = el("div", "night-heading");
    heading.appendChild(el("h2", "night-label", night.nightLabel));
    heading.appendChild(el("span", "night-count", night.entryCountLabel));
    group.appendChild(heading);

    group.appendChild(el("div", "night-divider"));

    const entries = el("div", "night-entries");
    for (const entry of night.entries ?? []) entries.appendChild(renderEntry(entry));
    group.appendChild(entries);

    if (typeof night.overflowCount === "number" && night.overflowCount > 0) {
      group.appendChild(el("div", "night-overflow", `+${night.overflowCount} more that night`));
    }
    return group;
  }

  function showEmptyState() {
    root.replaceChildren();
    const card = el("div", "state-card");
    card.appendChild(el("h2", "state-heading", "No builds yet"));
    card.appendChild(el("p", "state-body", "Suggest one in chat!"));
    root.appendChild(card);
  }

  function showErrorState() {
    root.replaceChildren();
    const card = el("div", "state-card is-error");
    card.appendChild(el("h2", "state-heading", "History's taking a break"));
    card.appendChild(
      el("p", "state-body", "Couldn't load build history right now. Refresh in a bit."),
    );
    root.appendChild(card);
  }

  // --- pagination state ------------------------------------------------------

  let oldestNightKey = null; // the cursor for the next "Load older nights" call
  let loadOlderWrap = null; // the button wrapper (hidden entirely when no older)

  function removeLoadOlder() {
    if (loadOlderWrap) {
      loadOlderWrap.remove();
      loadOlderWrap = null;
    }
  }

  function renderLoadOlder(hasOlder) {
    removeLoadOlder();
    if (!hasOlder) return; // absent entirely (not disabled) once history is exhausted
    loadOlderWrap = el("div", "load-older-wrap");
    const btn = el("button", "load-older", "Load older nights");
    btn.type = "button";
    btn.addEventListener("click", () => {
      void loadOlder();
    });
    loadOlderWrap.appendChild(btn);
    root.appendChild(loadOlderWrap);
  }

  function appendNights(nights) {
    for (const night of nights) {
      root.appendChild(renderNight(night));
      oldestNightKey = night.nightKey;
    }
  }

  // --- fetch loop ------------------------------------------------------------

  async function fetchPage(before) {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    const res = await fetch(`/api/history${query}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`history ${res.status}`);
    return res.json();
  }

  async function loadFirst() {
    try {
      const page = await fetchPage(null);
      root.replaceChildren();
      oldestNightKey = null;
      const nights = page.nights ?? [];
      if (nights.length === 0) {
        showEmptyState();
        return;
      }
      appendNights(nights);
      renderLoadOlder(page.hasOlder === true);
    } catch {
      showErrorState();
    }
  }

  async function loadOlder() {
    if (!oldestNightKey) return;
    const btn = loadOlderWrap ? loadOlderWrap.querySelector("button") : null;
    if (btn) btn.disabled = true;
    try {
      const page = await fetchPage(oldestNightKey);
      removeLoadOlder();
      appendNights(page.nights ?? []);
      renderLoadOlder(page.hasOlder === true);
    } catch {
      // Non-fatal: keep the already-loaded nights and re-enable the button so a
      // click can retry — never a red error over a page that's already showing.
      if (btn) btn.disabled = false;
    }
  }

  loadFirst();
})();
