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
    const halted = latest.mode === "HALTED";
    // D-04: the triage panel REPLACES the normal view while HALTED.
    haltedBanner.hidden = !halted;
    tabs.hidden = halted;
    triageView.hidden = !halted;
    for (const name of Object.keys(views)) {
      views[name].hidden = halted || name !== activeTab;
    }
    if (halted) {
      renderTriage(latest);
      return;
    }
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
