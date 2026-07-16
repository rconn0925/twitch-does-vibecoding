// App-under-construction preview client — vanilla JS, no framework (UI-SPEC).
//
// Isolation contract (PRES-03 / D3-12, hard rules):
//  - This page holds ZERO orchestrator connection: no WebSocket, no orchestrator
//    HTTP call. Its ONLY dynamic input is GET /api/reachable on THIS surface's
//    own server, which returns just { reachable, url } — a boolean plus the
//    fixed dev-server URL. No task title, no pipeline stage, no queue, no
//    chat-derived text is ever fetched or rendered here.
//  - The iframe's src is the dev-server URL and nothing else (the transient
//    "about:blank" below is only the double-buffer blanking step, never content).
//
// Rendering rule (dom-safety invariant): every text node is authored via
// textContent through setText() — the same textContent-only discipline as
// overlay.js's el() helper. This file assigns no HTML strings, uses no
// innerHTML/insertAdjacentHTML/document.write/eval.
//
// Broadcast rule: no error text EVER renders. An unreachable dev server is a
// normal, expected between-builds condition — it reads as a calm amber
// "STANDING BY" with a friendly placeholder, never a browser error page, never
// an HTTP code, never red.
(() => {
  const reachabilityEl = document.getElementById("reachability");
  const statusTitle = document.getElementById("status-title");
  const statusLabel = document.getElementById("status-label");
  const placeholder = document.getElementById("placeholder");
  const placeholderHeadline = document.getElementById("placeholder-headline");
  const placeholderSubline = document.getElementById("placeholder-subline");

  const POLL_INTERVAL_MS = 2000; // reachability poll cadence (UI-SPEC ~2s)
  const REFRESH_INTERVAL_MS = 5000; // live app-frame auto-refresh (UI-SPEC 5s)

  // --- fit-to-frame scaling --------------------------------------------------
  // The OBS source is only ~540px tall — an unusually short viewport that forces
  // almost any real app to scroll (a scrollbar viewers can't use, content below
  // the fold). Instead of framing the app at the cramped source size, frame it
  // at a standard laptop viewport (1280x768 — the 5:3 aspect of the 900x540
  // source) and scale that down to fill the source. Apps are built for
  // laptop-sized screens (and now told to be single-screen / 100vh), so they fit
  // 768 logical px with no scrollbar. Scale is recomputed from the ACTUAL stage
  // size, so it adapts if the source is resized.
  // 1500x900 keeps the source's exact 5:3 aspect (so the frame fills edge-to-edge
  // with no letterbox bars) while giving the app a tall, real viewport — enough
  // vertical headroom that a single-screen app fits with no scrollbar.
  const DESIGN_W = 1500;
  const DESIGN_H = 900;
  function applyFitScale() {
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    if (w === 0 || h === 0) return;
    const scale = Math.min(w / DESIGN_W, h / DESIGN_H);
    document.documentElement.style.setProperty("--fit-scale", String(scale));
  }
  applyFitScale();
  window.addEventListener("resize", applyFitScale);

  // Fixed on-stream copy (UI-SPEC §Copywriting). Static labels only — nothing
  // here is derived from chat or orchestrator state.
  const TITLE = "APP UNDER CONSTRUCTION";
  const LABEL_LIVE = "LIVE";
  const LABEL_STANDING_BY = "STANDING BY";

  // Calm waiting states. Which one shows is decided by LOCAL reachability
  // history ONLY (never orchestrator input): before the dev server has ever
  // answered this session it's "starting up"; once it has answered and later
  // goes quiet it's "between builds". FAILED is defined for completeness but is
  // not auto-selected — distinguishing a crash from a normal gap would require
  // orchestrator state the preview is forbidden to hold (D3-12).
  const WAITING = {
    STARTING_UP: {
      headline: "Setting the stage…",
      subline: "The build environment is starting up.",
    },
    BETWEEN_BUILDS: { headline: "Between builds", subline: "Next one's coming right up." },
    FAILED: { headline: "Reworking this one", subline: "Back in a moment." },
  };

  // --- tiny DOM helper (textContent-only, overlay.js el() discipline) ---

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  // --- double-buffered app frame (flash-free auto-refresh) ------------------

  let visible = document.getElementById("app-frame");
  let buffer = document.getElementById("app-frame-buffer");

  // Cache-busting value. OBS/CEF caches the app-under-construction's page by
  // its URL, and a JS-initiated iframe navigation to the SAME fixed dev-server
  // URL (127.0.0.1:5555) is served from that cache — so a NEW build published
  // on the same URL would keep rendering the PREVIOUS app on stream even though
  // the server now serves fresh content (OBS "refresh (no cache)" only bypasses
  // cache for THIS document, not the JS-driven iframe load). A unique query
  // param per load forces CEF to refetch, so the frame always shows what the
  // dev server serves right now. http.server ignores the query and still serves
  // the directory's index.html.
  //
  // Confirmed failure mode (live, 2026-07-16 — quick-k3x): a bare counter
  // restarted at 0 every page session, while CEF's DISK cache persisted across
  // OBS "refresh (no cache)" reloads — so a fresh session's `?_cb=1`, `?_cb=2`…
  // replayed the exact URLs a PREVIOUS session cached back when the OLD app
  // was live, and the "bust" served the stale app straight from cache (OBS
  // showed app-5 while 5555 verifiably served app-6). Date.now() makes the
  // value globally unique across page sessions, so no session can ever
  // re-request a URL any prior session cached; the counter stays as an
  // intra-session tiebreaker for same-millisecond refreshes.
  let cacheBust = 0;
  function frameUrl(url) {
    const sep = url.indexOf("?") === -1 ? "?" : "&";
    return `${url}${sep}_cb=${Date.now()}-${++cacheBust}`;
  }

  function swapFrames() {
    visible.classList.add("app-frame-buffer");
    visible.setAttribute("aria-hidden", "true");
    buffer.classList.remove("app-frame-buffer");
    buffer.removeAttribute("aria-hidden");
    const prev = visible;
    visible = buffer;
    buffer = prev;
  }

  // Load `url` into the hidden buffer, then swap on load so the viewer never
  // sees a white reload flash. Blanking first forces a fresh load even when the
  // buffer already holds this exact URL (assigning an identical src won't
  // reload). The blank load is ignored by the guard — only the real URL swaps.
  let awaitingSwap = false;
  function loadIntoBuffer(url) {
    awaitingSwap = true;
    buffer.onload = () => {
      // Ignore the transient blank load; only the real dev-server URL swaps.
      if (buffer.src === "about:blank") return;
      if (!awaitingSwap) return;
      awaitingSwap = false;
      swapFrames();
    };
    buffer.src = "about:blank";
    const target = frameUrl(url);
    window.setTimeout(() => {
      buffer.src = target;
    }, 0);
  }

  // --- reachability chrome + placeholder ------------------------------------

  function showLive() {
    reachabilityEl.classList.add("is-live");
    reachabilityEl.classList.remove("is-standing-by");
    setText(statusLabel, LABEL_LIVE);
    placeholder.hidden = true;
  }

  function showStandingBy(state) {
    reachabilityEl.classList.add("is-standing-by");
    reachabilityEl.classList.remove("is-live");
    setText(statusLabel, LABEL_STANDING_BY);
    setText(placeholderHeadline, state.headline);
    setText(placeholderSubline, state.subline);
    placeholder.hidden = false;
  }

  // --- state machine driven purely by reachability --------------------------

  let currentUrl = null;
  let hasBeenReachable = false;
  let wasReachable = false;
  let refreshTimer = null;

  function startRefreshLoop() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setInterval(() => {
      if (currentUrl) loadIntoBuffer(currentUrl);
    }, REFRESH_INTERVAL_MS);
  }

  function stopRefreshLoop() {
    if (refreshTimer === null) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function applyReachability(reachable, url) {
    if (reachable) {
      const urlChanged = url && url !== currentUrl;
      // A false→true transition means the dev server (re)appeared — the
      // orchestrator re-roots it at each generation change (new project,
      // project switch, swap), and a fresh build lands its files behind the
      // SAME fixed URL. Force a reload on that transition so the just-finished
      // build shows immediately, instead of waiting for (or being stranded by)
      // the cached frame. Paired with frameUrl()'s cache-bust so the refetch
      // actually returns the new app, never the stale cached one.
      const relaunched = !wasReachable;
      if (!hasBeenReachable || urlChanged || relaunched) {
        // First contact, a new dev-server URL, or a relaunch: (re)frame it.
        currentUrl = url || currentUrl;
        if (currentUrl) loadIntoBuffer(currentUrl);
      }
      hasBeenReachable = true;
      wasReachable = true;
      showLive();
      startRefreshLoop();
    } else {
      wasReachable = false;
      stopRefreshLoop();
      // Local-only state selection: never been up → starting up; was up before
      // → between builds. No orchestrator input, ever.
      showStandingBy(hasBeenReachable ? WAITING.BETWEEN_BUILDS : WAITING.STARTING_UP);
    }
  }

  async function poll() {
    let reachable = false;
    let url = currentUrl;
    try {
      const res = await fetch("/api/reachable", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        reachable = data.reachable === true;
        if (typeof data.url === "string") url = data.url;
      }
    } catch {
      // Fail closed: a failed poll reads as "not up yet", never an error on
      // stream. The next poll resyncs.
      reachable = false;
    }
    applyReachability(reachable, url);
  }

  // Initial chrome: title is static; start in STANDING BY / starting-up until
  // the first poll lands (never a blank or red state on first paint).
  setText(statusTitle, TITLE);
  showStandingBy(WAITING.STARTING_UP);

  poll();
  window.setInterval(poll, POLL_INTERVAL_MS);
})();
