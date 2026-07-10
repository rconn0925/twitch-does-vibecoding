// Operator console client — vanilla JS, no framework (UI-SPEC design system).
//
// Rendering rule (T-01-16, stored-XSS mitigation): ALL dynamic strings —
// suggestion text, usernames, classifier rationales — render via textContent.
// Suggestion text is attacker-authored by design; this file never assigns
// HTML strings to the DOM and has zero confirmation modals (UI-SPEC
// destructive-confirmation contract: the only friction anywhere in the
// kill-switch system is the hotkey's own double-tap, D-03).
(() => {
  const pills = document.querySelectorAll(".pill");
  const haltedBanner = document.getElementById("halted-banner");
  const haltButton = document.getElementById("halt-button");
  const reasonRow = document.getElementById("reason-row");
  const disconnected = document.getElementById("disconnected");
  const tabs = document.getElementById("tabs");
  const tabButtons = tabs.querySelectorAll(".tab");
  const views = {
    review: document.getElementById("view-review"),
    queue: document.getElementById("view-queue"),
    audit: document.getElementById("view-audit"),
  };
  const triageView = document.getElementById("view-triage");
  const queueContent = document.getElementById("queue-content");
  const auditContent = document.getElementById("audit-content");
  const filterEvent = document.getElementById("filter-event");
  const filterDecision = document.getElementById("filter-decision");
  const filterLimit = document.getElementById("filter-limit");
  const devForm = document.getElementById("dev-form");
  const devUsername = document.getElementById("dev-username");
  const devText = document.getElementById("dev-text");
  const devFeedback = document.getElementById("dev-feedback");
  const roundPanel = document.getElementById("round-panel");
  const buildPanel = document.getElementById("build-panel");
  const windowPanel = document.getElementById("window-panel");
  const twitchPill = document.getElementById("twitch-pill");
  const twitchError = document.getElementById("twitch-error");
  const donationsPill = document.getElementById("donations-pill");
  const donationsError = document.getElementById("donations-error");

  /** Latest ConsoleState snapshot from the ws push. */
  let latest = null;
  let activeTab = "review";
  /** Where the next one-tap reason tag should land (D-18). */
  let reasonContext = { kind: "halt", targetId: null };

  // --- tiny DOM helpers (textContent-only construction) ---

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function emptyState(heading, body) {
    const box = el("div", "empty-state");
    box.appendChild(el("h3", "empty-heading", heading));
    box.appendChild(el("p", "empty-body", body));
    return box;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Terse errors only; a missing body is fine.
    }
    return { res, data };
  }

  // --- optional one-tap reason tags (D-18) — never blocking ---

  function showReasonRow(context) {
    reasonContext = context;
    reasonRow.hidden = false;
  }

  async function sendReasonTag(context, tag) {
    // The action already took effect; these are append-only follow-up rows.
    if (context.kind === "halt") {
      await postJson("/api/halt", { reasonTag: tag });
      return;
    }
    if (context.kind === "veto" && context.targetId) {
      await postJson(`/api/tasks/${encodeURIComponent(context.targetId)}/veto`, { reasonTag: tag });
      return;
    }
    if (context.kind === "skip" && context.targetId) {
      await postJson(`/api/tasks/${encodeURIComponent(context.targetId)}/skip`, { reasonTag: tag });
      return;
    }
    if (context.kind === "revoke-window") {
      // The window already closed on the first click; this appends the tag,
      // never blocking (the server acknowledges it after the window is gone).
      await postJson("/api/control-window/revoke", { reasonTag: tag });
      return;
    }
    if (context.kind === "reject" && context.targetId) {
      await postJson(`/api/review/${encodeURIComponent(context.targetId)}/reject`, {
        reasonTag: tag,
      });
    }
  }

  for (const tagButton of reasonRow.querySelectorAll(".reason-tag")) {
    tagButton.addEventListener("click", () => {
      const tag = tagButton.dataset.tag;
      if (tag) {
        void sendReasonTag(reasonContext, tag);
      }
      reasonRow.hidden = true;
    });
  }

  // Single click, no confirmation modal (D-03 puts friction only on the hotkey).
  haltButton.addEventListener("click", () => {
    void postJson("/api/halt", {});
    showReasonRow({ kind: "halt", targetId: null });
  });

  // --- status bar ---

  function renderPills(snapshot) {
    for (const pill of pills) {
      const isActive = pill.dataset.mode === snapshot.mode;
      pill.classList.toggle("active", isActive);
    }
  }

  // --- Twitch connection indicator + UI-SPEC error copy (plan 02-04) ---

  function renderTwitch(snapshot) {
    const status = snapshot.twitch || "unauthorized";
    if (status === "connected") {
      twitchPill.textContent = "Twitch: connected";
      twitchPill.className = "status-pill status-approved";
    } else if (status === "disconnected") {
      twitchPill.textContent = "Twitch: reconnecting";
      twitchPill.className = "status-pill status-held";
    } else if (status === "missing-scope") {
      // 04-02 degraded state: the token lacks channel:read:redemptions, so
      // channel-points windows can't subscribe — amber, loud, never silent.
      twitchPill.textContent = "Twitch: missing channel-points scope";
      twitchPill.className = "status-pill status-held";
    } else {
      twitchPill.textContent = "Twitch: not authorized";
      twitchPill.className = "status-pill status-rejected";
    }

    twitchError.replaceChildren();
    if (status === "disconnected") {
      twitchError.appendChild(el("h2", "error-heading", "Twitch connection lost"));
      twitchError.appendChild(
        el(
          "p",
          "error-body",
          "Reconnecting automatically (no action needed). Votes sent during the gap can't be recovered; the tally resumes from the last saved state.",
        ),
      );
      twitchError.hidden = false;
    } else if (status === "missing-scope") {
      twitchError.appendChild(
        el("h2", "error-heading", "Channel-points windows need a re-authorization"),
      );
      twitchError.appendChild(
        el(
          "p",
          "error-body",
          "Visit /auth/start to grant the new permission. Chat, voting, and builds still work.",
        ),
      );
      twitchError.hidden = false;
    } else if (status === "unauthorized") {
      twitchError.appendChild(el("h2", "error-heading", "Twitch login expired"));
      twitchError.appendChild(
        el(
          "p",
          "error-body",
          "Re-authorize at /auth/start to reconnect chat. Rounds can't run until this is fixed.",
        ),
      );
      twitchError.hidden = false;
    } else {
      twitchError.hidden = true;
    }
  }

  // --- Donation-feed indicator (04-RESEARCH OQ1: never a silent tip-feed loss) ---

  function renderDonations(snapshot) {
    const status = snapshot.donations || "unconfigured";
    if (status === "connected") {
      donationsPill.textContent = "Donations: connected";
      donationsPill.className = "status-pill status-approved";
    } else if (status === "reconnecting") {
      donationsPill.textContent = "Donations: reconnecting";
      donationsPill.className = "status-pill status-held";
    } else {
      // "not configured" is an expected pre-setup state — amber, not red; the
      // show runs fine without a donation feed (channel points still work).
      donationsPill.textContent = "Donations: not configured";
      donationsPill.className = "status-pill status-held";
    }

    donationsError.replaceChildren();
    if (status === "reconnecting") {
      donationsError.appendChild(el("h2", "error-heading", "Donation feed disconnected"));
      donationsError.appendChild(
        el(
          "p",
          "error-body",
          "Reconnecting automatically. Tips sent during the gap can't open windows retroactively — check StreamElements if this persists. Voting and builds are unaffected.",
        ),
      );
      donationsError.hidden = false;
    } else {
      // 'not configured' shows the pill only — no error box (expected pre-setup).
      donationsError.hidden = true;
    }
  }

  // --- Round panel (D2-01: streamer-triggered rounds, UI-SPEC copy verbatim) ---

  /** m:ss from a millisecond remainder, floored at 0:00. */
  function formatRemaining(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  /** Remaining ms for a round: frozen remainder while frozen, else clock math. */
  function roundRemainingMs(round) {
    if (round.frozen && round.remainingMs !== null) return round.remainingMs;
    return round.endsAtMs - Date.now();
  }

  /** UI-SPEC disabled-reason copy, or null when Start Round is allowed. */
  function roundDisabledReason(snapshot) {
    if (snapshot.round && snapshot.round.status === "open") {
      return `Round in progress — ${formatRemaining(roundRemainingMs(snapshot.round))} left.`;
    }
    // D-05 precedence: no vote runs while chaos mode is on (checked before the
    // generic non-IDLE reason so the copy names chaos, not "current mode: CHAOS_MODE").
    if (snapshot.chaos) {
      return "Voting is off while chaos mode is on.";
    }
    if (snapshot.mode !== "IDLE") {
      return `Rounds can only start from Standby (current mode: ${snapshot.mode}).`;
    }
    if (snapshot.pool.length < 2) {
      return `Need at least 2 approved candidates to start a round (have ${snapshot.pool.length}).`;
    }
    return null;
  }

  /** Transient message from a rejected round-start / chaos-toggle (cleared on next render). */
  let roundStartError = null;

  async function startRound() {
    const { res, data } = await postJson("/api/round/start", {});
    if (!res.ok) {
      // The server's terse 409 copy ("Can't start a round …") — never a stack trace.
      roundStartError = data?.error ? data.error : "Round could not start.";
      renderAll();
    }
    // Success needs no handling here: the ws push triggered by ROUND_OPENED
    // re-renders the whole panel with the live round.
  }

  /** CHAOS-01 / D-05 chaos-toggle disabled reason, or null when the toggle is allowed. */
  function chaosDisabledReason(snapshot) {
    // Chaos-on can ALWAYS be turned off — the toggle is the same mode-change control.
    if (snapshot.chaos) return null;
    // D-05 precedence order: a live window outranks chaos; chaos only starts from IDLE.
    if (snapshot.controlWindow) {
      return "A free-reign window is active — it takes precedence.";
    }
    if (snapshot.mode !== "IDLE") {
      return `Chaos can only start from Standby (current mode: ${snapshot.mode}).`;
    }
    return null;
  }

  async function toggleChaos() {
    const { res, data } = await postJson("/api/chaos/toggle", {});
    if (!res.ok) {
      // Precedence backstop: the server's terse 409 (the button is also disabled).
      roundStartError = data?.error ? data.error : "Chaos mode couldn't toggle.";
      renderAll();
    }
    // Success re-renders via the ws push (CHAOS_TOGGLED → state push).
  }

  function renderRound(snapshot) {
    roundPanel.replaceChildren();
    const round = snapshot.round;

    if (round && round.status === "open") {
      // Countdown is computed CLIENT-side from endsAtMs (resynced on every ws
      // push); the server never streams per-second timer frames.
      const remaining = roundRemainingMs(round);
      roundPanel.appendChild(
        el(
          "h2",
          "section-title round-countdown",
          `Round open — ${formatRemaining(remaining)} left`,
        ),
      );
      const list = el("ol", "round-candidates");
      for (const entry of round.candidates) {
        const item = el("li", "round-candidate");
        item.appendChild(el("span", "round-candidate-text", entry.candidate.text));
        item.appendChild(el("span", "round-votes", `${entry.votes} votes`));
        list.appendChild(item);
      }
      roundPanel.appendChild(list);
    } else if (snapshot.pool.length === 0) {
      roundPanel.appendChild(
        emptyState(
          "Candidate pool is empty",
          "Waiting for !suggest ideas from chat. Approved ideas appear here.",
        ),
      );
    } else {
      roundPanel.appendChild(
        emptyState(
          "No round running",
          `${snapshot.pool.length} candidates ready. Start a round when the show's ready for one.`,
        ),
      );
    }

    // Single click, no modal — round start is not destructive (UI-SPEC).
    const reason = roundDisabledReason(snapshot);
    const start = button("Start Round", "button-accent", () => {
      void startRound();
    });
    start.disabled = Boolean(reason);
    roundPanel.appendChild(start);
    if (reason) {
      roundPanel.appendChild(el("p", "round-reason", reason));
    }

    // Chaos-mode toggle lives in the round panel — it swaps the same selection
    // concern Start Round owns (CHAOS-01). Accent (a forward, non-destructive
    // mode change), 44px, single click, no modal. D-05 precedence surfaced below.
    const chaosReason = chaosDisabledReason(snapshot);
    const chaosToggle = button(
      snapshot.chaos ? "Disable Chaos Mode" : "Enable Chaos Mode",
      "button-accent",
      () => {
        void toggleChaos();
      },
    );
    chaosToggle.disabled = Boolean(chaosReason);
    roundPanel.appendChild(chaosToggle);
    if (chaosReason) {
      roundPanel.appendChild(el("p", "round-reason", chaosReason));
    }
    if (snapshot.chaos) {
      roundPanel.appendChild(
        el(
          "p",
          "panel-body chaos-on-line",
          "Chaos mode on — the next task is a random pick from the approved pool. No vote runs.",
        ),
      );
    }

    if (roundStartError) {
      roundPanel.appendChild(el("p", "round-reason", roundStartError));
      roundStartError = null;
    }
  }

  // 1s countdown tick: re-render the round panel while a round is live so the
  // heading and disabled-reason clock stay honest between ws pushes.
  setInterval(() => {
    if (!latest || latest.mode === "HALTED") return;
    if (latest.round && latest.round.status === "open" && !latest.round.frozen) {
      renderRound(latest);
    }
    // Keep the free-reign window countdown honest between ws pushes (PAID-04).
    if (latest.controlWindow) {
      renderWindowPanel(latest);
    }
  }, 1000);

  // --- Build awareness + failed/refused decision surface (BUILD-03 / D3-09) ---
  //
  // The console shows the honest word ("Build failed" / "declined") — the public
  // overlay stays coarse (amber only, T-03-16). Retry = accent (recovery action);
  // Skip = neutral secondary (a routine pacing decision, NEVER destructive-red).

  async function retryBuild(id) {
    await postJson(`/api/tasks/${encodeURIComponent(id)}/retry`, {});
    // Success re-animates via the next ws push (BUILD_STAGE_CHANGED → state push).
  }

  async function skipTask(id) {
    await postJson(`/api/tasks/${encodeURIComponent(id)}/skip`, {});
    // Optional one-tap reason tag (reuses the D-18 reason-row), never blocking.
    showReasonRow({ kind: "skip", targetId: id });
  }

  const BUILD_STAGES = [
    ["researching", "Researching"],
    ["planning", "Planning"],
    ["building", "Building"],
  ];

  function renderBuildProgress(build) {
    buildPanel.appendChild(el("h2", "section-title", `Building: ${build.title}`));
    const activeIndex = BUILD_STAGES.findIndex(([key]) => key === build.stage);
    const row = el("div", "build-stages");
    BUILD_STAGES.forEach(([, label], i) => {
      const item = el("span", "build-stage");
      const dot = el("span", "build-dot");
      if (i < activeIndex) dot.classList.add("build-dot-done");
      else if (i === activeIndex) dot.classList.add("build-dot-active");
      item.appendChild(dot);
      item.appendChild(el("span", "build-stage-label", label));
      row.appendChild(item);
    });
    buildPanel.appendChild(row);
  }

  function renderBuildDecision(build) {
    const refused = build.stage === "refused";
    // "Needs a decision" amber pill — reuses the held-for-review amber, distinct
    // from the destructive-red reject/veto (a failed build is not a ToS incident).
    buildPanel.appendChild(el("span", "status-pill status-held", "Needs a decision"));
    buildPanel.appendChild(
      el(
        "h2",
        "section-title build-decision-heading",
        refused ? "Build agent declined this one" : "Build failed — retry or skip?",
      ),
    );
    buildPanel.appendChild(
      el(
        "p",
        "panel-body",
        refused
          ? "The model wouldn't build this task. Retry rarely helps here; Skip moves on to the next."
          : "Automatic retry already used. Retry runs the build again from the plan; Skip drops this task and moves on.",
      ),
    );
    buildPanel.appendChild(el("p", "card-text", build.title));
    const actions = el("div", "card-actions");
    actions.appendChild(
      button("Retry Build", "button-accent", () => {
        void retryBuild(build.taskId);
      }),
    );
    actions.appendChild(
      button("Skip Task", "button-neutral", () => {
        void skipTask(build.taskId);
      }),
    );
    buildPanel.appendChild(actions);
  }

  function renderBuild(snapshot) {
    buildPanel.replaceChildren();
    const build = snapshot.build;
    if (!build) {
      buildPanel.hidden = true;
      return;
    }
    buildPanel.hidden = false;
    if (build.decisionPending) {
      renderBuildDecision(build);
    } else {
      renderBuildProgress(build);
    }
  }

  // --- Control-window panel + Revoke (PAID-04) ---
  //
  // The console shows the FULL honest detail the overlay hides: donor name
  // (untruncated — the console is private), trigger, and the amount→duration
  // ledger math (amountLabel). Hidden-not-empty like the build panel. D-11
  // framing: the window is an OPEN sponsored build slot, never private control.

  async function revokeWindow() {
    // Single click, NO confirmation modal (D-03: friction only on the hotkey).
    await postJson("/api/control-window/revoke", {});
    // Optional one-tap reason tag (reuses the D-18 reason row), never blocking.
    showReasonRow({ kind: "revoke-window", targetId: null });
  }

  function renderWindowPanel(snapshot) {
    windowPanel.replaceChildren();
    const window_ = snapshot.controlWindow;
    if (!window_) {
      windowPanel.hidden = true;
      return;
    }
    windowPanel.hidden = false;

    // Countdown computed CLIENT-side from endsAtMs (resynced on every ws push);
    // the server never streams per-second timer frames (reuses formatRemaining).
    const remaining = window_.endsAtMs - Date.now();
    windowPanel.appendChild(
      el(
        "h2",
        "section-title round-countdown",
        `Free-reign window — ${formatRemaining(remaining)} left`,
      ),
    );

    // Donor line — untruncated, textContent-only (attacker-controlled string).
    const triggerLabel = window_.trigger === "donation" ? "donation" : "channel points";
    windowPanel.appendChild(
      el("p", "window-donor", `${window_.donorDisplayName} — ${triggerLabel}`),
    );

    // Mapping line — the honest PAID-04 amount→duration math the overlay hides.
    windowPanel.appendChild(el("p", "window-mapping", window_.amountLabel));

    windowPanel.appendChild(
      button("Revoke Window", "button-destructive", () => {
        void revokeWindow();
      }),
    );
  }

  // --- Needs Review (D-05: per-item approve/reject, no interruption) ---

  async function resolveReview(id, action) {
    await postJson(`/api/review/${encodeURIComponent(String(id))}/${action}`, {});
    if (action === "reject") {
      showReasonRow({ kind: "reject", targetId: String(id) });
    }
  }

  function renderReview(snapshot) {
    const view = views.review;
    view.replaceChildren();
    view.appendChild(el("h2", "section-title", "Needs Review"));
    if (snapshot.review.length === 0) {
      view.appendChild(
        emptyState(
          "Nothing waiting for review",
          "Escalated suggestions land here between rounds. Nothing needs your attention right now.",
        ),
      );
      return;
    }
    for (const item of snapshot.review) {
      const card = el("article", "card");
      const head = el("div", "card-head");
      head.appendChild(el("span", "status-pill status-held", item.category));
      head.appendChild(el("span", "card-user", item.twitchUsername || "unknown"));
      card.appendChild(head);
      card.appendChild(el("p", "card-text", item.text));
      card.appendChild(el("p", "card-rationale", item.rationale));
      const actions = el("div", "card-actions");
      actions.appendChild(
        button("Approve", "button-accent", () => {
          void resolveReview(item.id, "approve");
        }),
      );
      actions.appendChild(
        button("Reject", "button-destructive", () => {
          void resolveReview(item.id, "reject");
        }),
      );
      card.appendChild(actions);
      view.appendChild(card);
    }
  }

  // --- Active Queue (per-task veto + read-only pool + dev submit) ---

  async function vetoTask(id) {
    await postJson(`/api/tasks/${encodeURIComponent(id)}/veto`, {});
    showReasonRow({ kind: "veto", targetId: id });
  }

  function taskRow(text, username) {
    const row = el("div", "task-row");
    const info = el("div", "task-info");
    info.appendChild(el("p", "card-text", text));
    info.appendChild(el("span", "card-user", username || "unknown"));
    row.appendChild(info);
    return row;
  }

  function renderQueue(snapshot) {
    queueContent.replaceChildren();
    queueContent.appendChild(el("h2", "section-title", "Active Queue"));
    if (snapshot.queue.length === 0 && snapshot.pool.length === 0) {
      queueContent.appendChild(
        emptyState("Queue is empty", "Waiting for the next round to start."),
      );
      return;
    }
    if (snapshot.queue.length > 0) {
      queueContent.appendChild(el("h3", "group-title", "Queued tasks"));
      for (const task of snapshot.queue) {
        const row = taskRow(task.text, task.twitchUsername);
        row.appendChild(
          button("Veto Task", "button-destructive", () => {
            void vetoTask(task.id);
          }),
        );
        queueContent.appendChild(row);
      }
    }
    if (snapshot.pool.length > 0) {
      queueContent.appendChild(el("h3", "group-title", "Pre-screened pool (read-only)"));
      for (const entry of snapshot.pool) {
        const row = taskRow(entry.candidate.text, entry.candidate.twitchUsername);
        row.appendChild(el("span", "status-pill status-approved", "approved"));
        queueContent.appendChild(row);
      }
    }
  }

  async function submitDev() {
    devFeedback.hidden = true;
    const { res } = await postJson("/api/dev/submit", {
      username: devUsername.value || "dev",
      text: devText.value,
    });
    if (res.status === 409) {
      // D-02 refusal, shown inline — no toast, no modal.
      devFeedback.textContent =
        "Submission refused — the stream is halted. Nothing was classified or queued.";
      devFeedback.hidden = false;
      return;
    }
    if (!res.ok) {
      devFeedback.textContent = "Submission rejected — text must be 1–2000 characters.";
      devFeedback.hidden = false;
      return;
    }
    devText.value = "";
  }

  devForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDev();
  });

  // --- HALTED triage takeover (D-04: triage-then-choose, nothing auto-resumes) ---

  async function recoverWith(action, errorBox) {
    const { res, data } = await postJson("/api/recover", { action });
    if (!res.ok) {
      // UI-SPEC invalid force-transition error state; the server's message is
      // the verbatim "Can't transition to {state} from {state}" copy.
      errorBox.replaceChildren();
      errorBox.appendChild(el("h3", "error-heading", data?.error ? data.error : "Recovery failed"));
      errorBox.appendChild(
        el("p", "error-body", "Choose one of the valid recovery actions below."),
      );
      errorBox.hidden = false;
    }
    // WR-05: no reason-tag follow-up after discard-and-resume. The server's
    // recover() already wrote the veto audit row for the discarded active
    // task; surfacing the veto reason row here would POST
    // /api/tasks/:id/veto for a task that was never queued, appending a
    // SECOND bare veto row — one discard would double-count in the ledger.
  }

  function triageGroup(title) {
    const group = el("div", "triage-group");
    group.appendChild(el("h3", "group-title", title));
    return group;
  }

  function renderTriage(snapshot) {
    triageView.replaceChildren();
    const frozen = snapshot.haltContext ? snapshot.haltContext.frozen : null;

    triageView.appendChild(el("h2", "section-title", "Halt triage"));
    triageView.appendChild(
      el("p", "panel-body", "Everything is frozen. Nothing resumes until you pick an action."),
    );

    // D3-10 veto-abort confirmation: a halt during a build aborted the in-flight
    // sandboxed agent session. The state already flipped to HALTED (decoupled
    // from teardown, D-02); this line reports best-effort teardown, never blocks.
    if (frozen?.mode === "BUILD_IN_PROGRESS") {
      triageView.appendChild(
        el(
          "p",
          "panel-body build-abort-line",
          "Build aborted — tearing down the sandbox. Sandbox stopped. Safe to continue.",
        ),
      );
    }

    // D2-16: a halt froze the round mid-flight — show what Resume/Discard mean for it.
    if (snapshot.round?.frozen) {
      triageView.appendChild(
        el(
          "p",
          "panel-body round-frozen-line",
          `Round frozen at ${formatRemaining(snapshot.round.remainingMs || 0)} remaining — ${snapshot.round.totalVotes} votes recorded. Resume continues the round; Discard cancels it and returns candidates to the pool.`,
        ),
      );
    }

    const groups = el("div", "triage-groups");
    const inflight = triageGroup("In-flight task");
    inflight.appendChild(el("p", "card-text", frozen?.activeTaskId ? frozen.activeTaskId : "None"));
    groups.appendChild(inflight);

    const queued = triageGroup("Queued tasks");
    if (snapshot.queue.length > 0) {
      for (const task of snapshot.queue) {
        queued.appendChild(el("p", "card-text", task.text));
      }
    } else if (frozen && frozen.queuedTaskIds.length > 0) {
      for (const id of frozen.queuedTaskIds) {
        queued.appendChild(el("p", "card-text", id));
      }
    } else {
      queued.appendChild(el("p", "card-text", "None"));
    }
    groups.appendChild(queued);

    const prior = triageGroup("Prior mode");
    prior.appendChild(el("p", "card-text", frozen ? frozen.mode : "unknown"));
    groups.appendChild(prior);
    triageView.appendChild(groups);

    const errorBox = el("div", "triage-error");
    errorBox.hidden = true;
    triageView.appendChild(errorBox);

    // Exactly three equally-weighted recovery buttons — no default, no
    // pre-selection (D-04). Focus stays wherever the operator left it.
    const actions = el("div", "triage-actions");
    actions.appendChild(
      button("Resume", "button-accent triage-button", () => {
        void recoverWith("resume", errorBox);
      }),
    );
    actions.appendChild(
      button("Discard Task & Resume", "button-accent triage-button", () => {
        void recoverWith("discard-and-resume", errorBox);
      }),
    );
    actions.appendChild(
      button("Reset to Idle", "button-accent triage-button", () => {
        void recoverWith("reset-to-idle", errorBox);
      }),
    );
    triageView.appendChild(actions);
  }

  // --- Audit Log (COMP-05: filterable decisions + vetoes with triggering input) ---

  function decisionPillClass(decision) {
    if (decision === "approved") return "status-pill status-approved";
    if (decision === "held-for-review") return "status-pill status-held";
    return "status-pill status-rejected";
  }

  async function renderAudit() {
    const params = new URLSearchParams();
    params.set("limit", filterLimit.value);
    if (filterEvent.value) params.set("eventType", filterEvent.value);
    if (filterDecision.value) params.set("decision", filterDecision.value);
    let rows = [];
    try {
      const res = await fetch(`/api/audit?${params.toString()}`);
      if (!res.ok) return;
      rows = await res.json();
    } catch {
      return; // the disconnected banner covers transport failures
    }
    auditContent.replaceChildren();
    if (rows.length === 0) {
      auditContent.appendChild(
        emptyState("No matching records", "Try widening your date range or clearing a filter."),
      );
      return;
    }
    const table = el("table", "audit-table");
    const thead = el("thead");
    const headRow = el("tr");
    const headers = [
      "Time",
      "Event",
      "Source",
      "User",
      "Suggestion",
      "Decision",
      "Category",
      "Rationale",
      "Mode",
    ];
    for (const label of headers) {
      headRow.appendChild(el("th", "audit-th", label));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      tr.appendChild(el("td", "audit-td", new Date(row.created_at_ms).toLocaleString()));
      tr.appendChild(el("td", "audit-td", row.event_type));
      tr.appendChild(el("td", "audit-td", row.source));
      tr.appendChild(el("td", "audit-td", row.twitch_username || ""));
      tr.appendChild(el("td", "audit-td audit-text", row.suggestion_text || ""));
      const decisionCell = el("td", "audit-td");
      if (row.decision) {
        decisionCell.appendChild(el("span", decisionPillClass(row.decision), row.decision));
      }
      tr.appendChild(decisionCell);
      tr.appendChild(el("td", "audit-td", row.category || ""));
      tr.appendChild(el("td", "audit-td audit-text", row.rationale || ""));
      tr.appendChild(el("td", "audit-td", row.stream_mode));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    auditContent.appendChild(table);
  }

  for (const filter of [filterEvent, filterDecision, filterLimit]) {
    filter.addEventListener("change", () => {
      void renderAudit();
    });
  }

  // --- view switching + master render ---

  for (const tabButton of tabButtons) {
    tabButton.addEventListener("click", () => {
      activeTab = tabButton.dataset.view;
      for (const other of tabButtons) {
        other.classList.toggle("active", other === tabButton);
      }
      renderAll();
    });
  }

  function renderAll() {
    if (!latest) return;
    renderPills(latest);
    renderTwitch(latest);
    renderDonations(latest);
    const halted = latest.mode === "HALTED";
    // D-04: the triage panel REPLACES the normal view while HALTED.
    haltedBanner.hidden = !halted;
    tabs.hidden = halted;
    triageView.hidden = !halted;
    roundPanel.hidden = halted;
    buildPanel.hidden = halted;
    windowPanel.hidden = halted; // renderWindowPanel manages visibility when not halted
    for (const name of Object.keys(views)) {
      views[name].hidden = halted || name !== activeTab;
    }
    if (halted) {
      renderTriage(latest);
      return;
    }
    renderBuild(latest);
    renderWindowPanel(latest);
    renderRound(latest);
    if (activeTab === "review") renderReview(latest);
    if (activeTab === "queue") renderQueue(latest);
    if (activeTab === "audit") void renderAudit();
  }

  // Hand-rolled ws reconnect with backoff (CLAUDE.md overlay pattern):
  // full state arrives on connect, then a push on every mutation.
  let attempts = 0;
  function connect() {
    const socket = new WebSocket(`ws://${location.host}`);
    socket.addEventListener("open", () => {
      attempts = 0;
      disconnected.hidden = true;
    });
    socket.addEventListener("message", (event) => {
      try {
        latest = JSON.parse(event.data);
        renderAll();
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
