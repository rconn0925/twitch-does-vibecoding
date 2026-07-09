// Operator console client — vanilla JS, no framework (UI-SPEC design system).
//
// Rendering rule (T-01-04, stored-XSS mitigation): ALL server-sourced text is
// rendered via textContent, never via HTML string interpolation. Suggestion
// text is attacker-controlled in later plans; this file sets the pattern.
(() => {
  const pills = document.querySelectorAll(".pill");
  const haltedBanner = document.getElementById("halted-banner");
  const haltButton = document.getElementById("halt-button");
  const reasonRow = document.getElementById("reason-row");
  const disconnected = document.getElementById("disconnected");

  function render(snapshot) {
    for (const pill of pills) {
      const isActive = pill.dataset.mode === snapshot.mode;
      pill.classList.toggle("active", isActive);
      // Pill labels are static markup; assert the mode string via textContent only.
      if (isActive && pill.textContent !== snapshot.mode) {
        pill.textContent = snapshot.mode;
      }
    }
    haltedBanner.hidden = snapshot.mode !== "HALTED";
    if (snapshot.mode !== "HALTED") {
      reasonRow.hidden = true;
    }
  }

  async function postHalt(body) {
    try {
      await fetch("/api/halt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // State (or the lack of a transition) arrives over the ws push; the
      // disconnected banner covers the failure case.
    }
  }

  // Single click, no confirmation modal (D-03 puts friction only on the hotkey).
  haltButton.addEventListener("click", () => {
    void postHalt({});
    // Optional one-tap reason capture (D-18) — shown after the fact, never blocking:
    // the halt request is already on the wire.
    reasonRow.hidden = false;
  });

  for (const button of reasonRow.querySelectorAll(".reason-tag")) {
    button.addEventListener("click", () => {
      const tag = button.dataset.tag;
      if (tag) {
        void postHalt({ reasonTag: tag });
      }
      reasonRow.hidden = true;
    });
  }

  // Hand-rolled ws reconnect with backoff (CLAUDE.md overlay pattern):
  // full state arrives on connect, then a push on every state:changed.
  let attempts = 0;
  function connect() {
    const socket = new WebSocket(`ws://${location.host}`);
    socket.addEventListener("open", () => {
      attempts = 0;
      disconnected.hidden = true;
    });
    socket.addEventListener("message", (event) => {
      try {
        render(JSON.parse(event.data));
      } catch {
        // Malformed frame: ignore; the next push resyncs the full state.
      }
    });
    socket.addEventListener("close", () => {
      disconnected.hidden = false;
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
