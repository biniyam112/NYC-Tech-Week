const state = {
  all: [],
  view: "board",
  search: "",
  priorityFilter: null,
  signals: JSON.parse(localStorage.getItem("wo-signals") || "{}"),
};

const $ = (id) => document.getElementById(id);

const STATUS_ORDER = [
  "backlog", "to do", "todo", "open", "scheduled",
  "in progress", "active", "blocked", "in review", "on hold",
  "done", "completed", "closed", "resolved",
];

const STATUS_COLORS = {
  open: "#f5a524", "to do": "#f5a524", todo: "#f5a524", backlog: "#9aa4b2",
  "in progress": "#4d8df6", active: "#4d8df6", blocked: "#f0506e",
  done: "#2bd99f", completed: "#2bd99f", closed: "#2bd99f", resolved: "#2bd99f",
};

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function priorityClass(p) {
  const s = (p || "").toLowerCase();
  if (/crit|urgent|p1|emergenc/.test(s)) return "critical";
  if (/high|p2/.test(s)) return "high";
  if (/med|moderate|p3|normal/.test(s)) return "medium";
  return "low";
}

function priorityLabel(p) {
  const c = priorityClass(p);
  return { critical: "Critical", high: "High", medium: "Medium", low: "Low" }[c];
}

function isOverdue(wo) {
  if (!wo.dueDate) return false;
  const due = new Date(wo.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return due < new Date() && !/done|closed|complete|resolved/i.test(wo.status);
}

function bucket(wo) {
  const s = (wo.status || "").toLowerCase();
  if (isOverdue(wo)) return "overdue";
  if (/progress|active|working|dispatch/.test(s)) return "in progress";
  if (/done|closed|complete|resolved/.test(s)) return "done";
  return "open";
}

function statusColor(wo) {
  if (wo.statusColor && /^#?[0-9a-f]{3,8}$/i.test(wo.statusColor))
    return wo.statusColor.startsWith("#") ? wo.statusColor : `#${wo.statusColor}`;
  return STATUS_COLORS[(wo.status || "").toLowerCase()] || "#9aa4b2";
}

function fmtDate(d) {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return esc(d);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

function locName(wo) { return wo.location?.locationName || wo.location?.address || null; }

function prioBars(p) {
  const c = priorityClass(p);
  return `<span class="prio-bars ${c}" title="${priorityLabel(p)} priority"><i></i><i></i><i></i></span>`;
}

const svg = {
  asset: '<svg viewBox="0 0 16 16" class="ico"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 6h4v4H6z"/></svg>',
  loc: '<svg viewBox="0 0 16 16" class="ico"><path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8Z"/><circle cx="8" cy="6" r="1.6"/></svg>',
  clock: '<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>',
  tag: '<svg viewBox="0 0 16 16" class="ico"><path d="M2.5 7.5 8 2l5.5 5.5L8 13Z"/><circle cx="6" cy="6" r="0.8"/></svg>',
};

// ---------- data ----------
async function load() {
  setConn("loading", "Connecting…");
  $("refresh").classList.add("spin");
  try {
    const res = await fetch("/api/workorders?limit=200");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || JSON.stringify(data.details || data));
    state.all = data.workOrders || [];
    setConn("ok", `Live · ${state.all.length} work orders`);
    renderAll();
  } catch (err) {
    setConn("err", "Connection error");
    showError(err.message);
  } finally {
    $("refresh").classList.remove("spin");
  }
}

function setConn(cls, text) {
  $("conn-dot").className = `conn-dot ${cls}`;
  $("conn-text").textContent = text;
}

function showError(msg) {
  const html = `<div class="empty-state">
    <svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="6"/><path d="M8 5v3M8 11h.01"/></svg>
    <div><strong>Could not load work orders</strong></div>
    <div class="muted">${esc(msg)}</div>
  </div>`;
  $("board-view").innerHTML = html;
  $("list-view").innerHTML = html;
}

// ---------- filtering ----------
function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.all.filter((w) => {
    if (state.priorityFilter && priorityClass(w.priority) !== state.priorityFilter) return false;
    if (q) {
      const hay = `${w.title} ${w.asset?.name || ""} ${locName(w) || ""} ${w.status}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------- render ----------
function renderAll() {
  updateMetrics();
  if (state.view === "board") renderBoard();
  else renderList();
}

function updateMetrics() {
  $("m-total").textContent = state.all.length;
  $("m-open").textContent = state.all.filter((w) => bucket(w) === "open").length;
  $("m-progress").textContent = state.all.filter((w) => bucket(w) === "in progress").length;
  $("m-overdue").textContent = state.all.filter((w) => bucket(w) === "overdue").length;
  $("nav-count").textContent = state.all.length;
  const byPrio = (c) => state.all.filter((w) => priorityClass(w.priority) === c).length;
  $("pc-crit").textContent = byPrio("critical");
  $("pc-high").textContent = byPrio("high");
  $("pc-med").textContent = byPrio("medium");
  $("pc-low").textContent = byPrio("low");
}

function cardHtml(w) {
  const idx = state.all.indexOf(w);
  const due = fmtDate(w.dueDate);
  const over = isOverdue(w);
  return `<div class="card prio-${priorityClass(w.priority)}" data-idx="${idx}">
    <div class="card-top">${prioBars(w.priority)}<span class="chip">${esc(priorityLabel(w.priority))}</span></div>
    <p class="card-title">${esc(w.title || "Untitled work order")}</p>
    <div class="card-meta">
      ${w.asset?.name ? `<div class="meta-row">${svg.asset}<span>${esc(w.asset.name)}</span></div>` : ""}
      ${locName(w) ? `<div class="meta-row">${svg.loc}<span>${esc(locName(w))}</span></div>` : ""}
    </div>
    <div class="card-foot">
      ${due ? `<span class="due-chip ${over ? "overdue" : ""}">${svg.clock}${esc(due)}</span>` : `<span class="due-chip muted">No due date</span>`}
      ${w.assignee?.name ? `<span class="avatar" title="${esc(w.assignee.name)}">${esc(initials(w.assignee.name))}</span>` : ""}
    </div>
  </div>`;
}

function initials(name) {
  const m = String(name).match(/\d+/);
  if (m) return m[0];
  return name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("");
}

function renderBoard() {
  const rows = filtered();
  $("result-count").textContent = `${rows.length} of ${state.all.length}`;
  if (!rows.length) return renderEmpty("board-view");

  const groups = new Map();
  rows.forEach((w) => {
    const key = w.status || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  });
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a.toLowerCase());
    const ib = STATUS_ORDER.indexOf(b.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  $("board-view").innerHTML = keys
    .map((key) => {
      const list = groups.get(key);
      const color = statusColor(list[0]);
      return `<div class="board-col">
        <div class="col-head">
          <span class="col-dot" style="background:${color}"></span>
          <span class="col-title">${esc(key)}</span>
          <span class="col-count">${list.length}</span>
        </div>
        <div class="col-cards">${list.map(cardHtml).join("")}</div>
      </div>`;
    })
    .join("");
  attachCardHandlers("board-view");
}

function renderList() {
  const rows = filtered();
  $("result-count").textContent = `${rows.length} of ${state.all.length}`;
  if (!rows.length) return renderEmpty("list-view");

  $("list-view").innerHTML = `<table class="wo-table">
    <thead><tr>
      <th style="width:38%">Title</th><th>Status</th><th>Priority</th>
      <th>Asset</th><th>Location</th><th>Due</th>
    </tr></thead>
    <tbody>${rows.map((w) => {
      const idx = state.all.indexOf(w);
      const due = fmtDate(w.dueDate);
      return `<tr data-idx="${idx}">
        <td><div class="row-title">${prioBars(w.priority)}${esc(w.title || "Untitled")}</div></td>
        <td><span class="status-chip"><span class="sdot" style="background:${statusColor(w)}"></span>${esc(w.status || "—")}</span></td>
        <td><span class="chip">${esc(priorityLabel(w.priority))}</span></td>
        <td>${esc(w.asset?.name || "—")}</td>
        <td>${esc(locName(w) || "—")}</td>
        <td class="${isOverdue(w) ? "overdue" : "muted"}">${due ? esc(due) : "—"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
  attachCardHandlers("list-view");
}

function renderEmpty(target) {
  $(target).innerHTML = `<div class="empty-state">
    <svg viewBox="0 0 16 16" class="ico"><path d="M3 4h10v9H3z"/><path d="M3 7h10"/></svg>
    <div>No work orders match your filters</div>
  </div>`;
}

function attachCardHandlers(target) {
  $(target).querySelectorAll("[data-idx]").forEach((el) =>
    el.addEventListener("click", () => openDrawer(state.all[Number(el.dataset.idx)]))
  );
}

// ---------- drawer ----------
let activeWo = null;
function openDrawer(wo) {
  activeWo = wo;
  $("drawer-status").innerHTML = `<span class="sdot" style="background:${statusColor(wo)}"></span>${esc(wo.status || "—")}`;
  const due = fmtDate(wo.dueDate);
  $("drawer-content").innerHTML = `
    <h2>${esc(wo.title || "Untitled work order")}</h2>
    <div style="display:flex;gap:8px;align-items:center">${prioBars(wo.priority)}<span class="chip">${esc(priorityLabel(wo.priority))} priority</span></div>
    <p class="desc">${esc(wo.description || "No description provided.")}</p>
    <div class="kv-grid">
      <div class="kv"><span class="k">${svg.asset}Asset</span><span class="v">${esc(wo.asset?.name || "—")}</span></div>
      <div class="kv"><span class="k">${svg.loc}Location</span><span class="v">${esc(locName(wo) || "—")}</span></div>
      <div class="kv"><span class="k">${svg.tag}Type</span><span class="v">${esc(wo.type || wo.serviceCategory || "—")}</span></div>
      <div class="kv"><span class="k">${svg.clock}Due</span><span class="v ${isOverdue(wo) ? "" : ""}">${due ? esc(due) : "—"}</span></div>
      <div class="kv"><span class="k">${svg.clock}Created</span><span class="v">${fmtDate(wo.createdAt) ? esc(fmtDate(wo.createdAt)) : "—"}</span></div>
      <div class="kv"><span class="k">Assignees</span><span class="v">${esc(wo.assignee?.name || "Unassigned")}</span></div>
      <div class="kv"><span class="k">ID</span><span class="v" style="font-family:monospace;font-size:11px">${esc(wo.id || "—")}</span></div>
    </div>`;
  $("drawer-input").value = "";
  $("drawer-copilot").hidden = true;
  $("drawer-copilot").innerHTML = "";
  loadDrawerSignals(wo.id);
  $("drawer").hidden = false;
  $("drawer-backdrop").hidden = false;
}
function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-backdrop").hidden = true;
  activeWo = null;
}

// Show previously captured field signals for this work order.
async function loadDrawerSignals(workOrderId) {
  const list = $("signal-list");
  list.innerHTML = "";
  try {
    const res = await fetch(`/api/signals?workOrderId=${encodeURIComponent(workOrderId)}`);
    const { signals } = await res.json();
    if (!signals?.length) return;
    list.innerHTML = `<li style="background:none;border:none;padding:8px 0 4px;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Captured field signals (${signals.length})</li>` +
      signals.map((s) => {
        const closure = s.closureStatus ? ` · <span style="color:var(--accent)">${esc(s.closureStatus)}</span>` : "";
        return `<li>${esc(s.text)}<span class="ts">${esc(new Date(s.createdAt).toLocaleString())}${closure}</span></li>`;
      }).join("");
  } catch { /* ignore */ }
}

// ---------- Copilot pipeline (Challenge 02) ----------
const svgX = {
  brain: '<svg viewBox="0 0 16 16" class="ico"><path d="M6 2a2 2 0 0 0-2 2 2 2 0 0 0-1 3.7A2 2 0 0 0 4 11a2 2 0 0 0 2 2"/><path d="M10 2a2 2 0 0 1 2 2 2 2 0 0 1 1 3.7A2 2 0 0 1 12 11a2 2 0 0 1-2 2"/></svg>',
  globe: '<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>',
  shield: '<svg viewBox="0 0 16 16" class="ico"><path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" class="ico"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  check: '<svg viewBox="0 0 16 16" class="ico"><path d="M3 8.5l3 3 7-7"/></svg>',
};

async function runCopilot({ text, location, workOrderId }, container) {
  container.hidden = false;
  container.innerHTML = `<div class="loading-row"><span class="spinner"></span> Structuring signal, enriching with NYC public data…</div>`;
  let result;
  try {
    const res = await fetch("/api/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, location, workOrderId }),
    });
    result = await res.json();
    if (!res.ok) throw new Error(result.error || "Copilot failed");
  } catch (err) {
    container.innerHTML = `<div class="cop-banner escalate">${esc(err.message)}</div>`;
    return;
  }
  // Create a real CriticalAsset work order from the report (unless this Copilot
  // run was launched from an existing work order).
  let createdWO = null;
  if (!workOrderId) {
    try {
      const cRes = await fetch("/api/workorders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structured: result.structured, workflow: result.workflow, text }),
      });
      const cJson = await cRes.json();
      if (cRes.ok) createdWO = cJson.workOrder;
    } catch { /* non-fatal */ }
  }

  // Persist as a field signal for the closure loop, linked to the new WO.
  let signalId = null;
  try {
    const saveRes = await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workOrderId: createdWO?.id ?? workOrderId ?? null,
        text,
        structured: result.structured,
        workflow: result.workflow,
      }),
    });
    const saved = await saveRes.json();
    signalId = saved.signal?.id;
  } catch { /* non-fatal */ }

  container.innerHTML = copilotHtml(result, signalId, createdWO);
  wireClosure(container, signalId);

  // Refresh the board so the newly created work order shows up live.
  if (createdWO) load();
}

function copilotHtml(r, signalId, createdWO) {
  const s = r.structured, w = r.workflow, e = r.enrichment;
  const banner = w.escalate
    ? `<div class="cop-banner escalate">${svgX.shield}<span>Escalate — ${esc(w.escalationReasons.join(" · "))}</span></div>`
    : `<div class="cop-banner ok">${svgX.check}<span>Standard workflow — no escalation triggers detected</span></div>`;
  const createdBanner = createdWO
    ? `<div class="cop-banner ok">${svgX.check}<span>Work order created in CriticalAsset · <code style="font-size:11px">${esc(createdWO.id)}</code></span></div>`
    : "";

  return `<div class="cop">
    ${createdBanner}
    ${banner}

    <div class="cop-section">
      <h4>${svgX.brain} AI-structured issue</h4>
      <div class="cop-fields">
        <div class="cop-field"><span class="l">Issue type</span><span class="v">${esc(s.issueType)}</span></div>
        <div class="cop-field"><span class="l">Location</span><span class="v">${esc(s.location)}</span></div>
        <div class="cop-field"><span class="l">Severity</span><span class="v sev-${esc(s.severity)}">${esc(s.severity)}</span></div>
        <div class="cop-field"><span class="l">Urgency</span><span class="v">${esc(s.urgency)}</span></div>
        <div class="cop-field"><span class="l">Recurring</span><span class="v">${s.recurring ? "Yes — prior fixes didn't hold" : "Not indicated"}</span></div>
        <div class="cop-field"><span class="l">Evidence</span><span class="v">${esc(s.evidenceQuality)}</span></div>
      </div>
      <div class="cop-field" style="margin-top:10px"><span class="l">Likely asset categories</span>
        <div class="cop-tags">${s.assetCategories.map((t) => `<span class="cop-tag">${esc(t)}</span>`).join("")}</div></div>
    </div>

    <div class="cop-section">
      <h4>${svgX.arrow} Rewritten work order</h4>
      <div class="cop-clean">${esc(w.cleanedWorkOrder)}</div>
    </div>

    <div class="cop-section">
      <h4>${svgX.globe} NYC public-data enrichment <span class="src-badge">LIVE</span></h4>
      ${(e.sources || []).filter((src) => !src.error).map((src) => `
        <div class="cop-source">
          <div class="src-name">${esc(src.source)}</div>
          <div class="src-meaning">${esc(src.operationalMeaning)}</div>
        </div>`).join("")}
    </div>

    <div class="cop-section">
      <h4>${svgX.shield} Compliance / obligations</h4>
      <div class="cop-tags">${w.complianceImplications.map((c) => `<span class="cop-tag">${esc(c)}</span>`).join("")}</div>
    </div>

    <div class="cop-section">
      <h4>${svgX.arrow} Recommended workflow</h4>
      <div class="cop-fields" style="margin-bottom:10px">
        <div class="cop-field"><span class="l">Assign to</span><span class="v">${esc(w.assignmentGroup)}</span></div>
        <div class="cop-field"><span class="l">Severity / urgency</span><span class="v">${esc(w.severity)} · ${esc(w.urgency)}</span></div>
      </div>
      <span class="l" style="font-size:11.5px;color:var(--text-3)">Next actions</span>
      <ol class="cop-list">${w.suggestedNextActions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>
      ${w.evidenceChecklist.length ? `<span class="l" style="font-size:11.5px;color:var(--text-3)">Still missing</span>
      <ul class="cop-list">${w.evidenceChecklist.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
    </div>

    <div class="cop-section">
      <h4>${svgX.check} Student-facing message</h4>
      <div class="cop-student">"${esc(w.studentStatusMessage)}"</div>
    </div>

    ${signalId ? `<div class="cop-section closure" data-signal="${signalId}">
      <h4>${svgX.check} Closure verification loop</h4>
      <div class="closure-q">${esc(w.closureQuestion)}</div>
      <div class="closure-btns">
        <button class="closure-btn fixed" data-status="fixed">Fixed</button>
        <button class="closure-btn still" data-status="still">Still happening</button>
        <button class="closure-btn worse" data-status="worse">Worse</button>
      </div>
    </div>` : ""}

    <div class="cop-engine">Structured by: ${esc(s.engine)}</div>
  </div>`;
}

function wireClosure(container, signalId) {
  if (!signalId) return;
  container.querySelectorAll(".closure-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const status = btn.dataset.status;
      const box = btn.closest(".closure");
      box.innerHTML = `<div class="loading-row"><span class="spinner"></span> Updating work order…</div>`;
      try {
        await fetch(`/api/signals/${signalId}/closure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch { /* ignore */ }
      const msg = {
        fixed: "Marked resolved. The reporter is notified and the work order can be verified for closure.",
        still: "Flagged as unresolved — work order kept open and bumped in priority. False-closure prevented.",
        worse: "Escalated — condition is worsening. Routed for urgent re-dispatch.",
      }[status];
      box.innerHTML = `<h4>${svgX.check} Closure verification loop</h4><div class="closure-result">${esc(msg)}</div>`;
    })
  );
}

// Intake modal
function openIntake() {
  $("intake-result").hidden = true;
  $("intake-result").innerHTML = "";
  $("intake-text").value = "";
  $("intake-loc").value = "";
  $("intake-modal").hidden = false;
  $("intake-backdrop").hidden = false;
  setTimeout(() => $("intake-text").focus(), 50);
}
function closeIntake() {
  $("intake-modal").hidden = true;
  $("intake-backdrop").hidden = true;
}

// ---------- events ----------
$("refresh").addEventListener("click", load);
$("search").addEventListener("input", (e) => { state.search = e.target.value; renderAll(); });
$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeIntake(); } });

// Intake modal
$("new-report").addEventListener("click", openIntake);
$("intake-close").addEventListener("click", closeIntake);
$("intake-backdrop").addEventListener("click", closeIntake);
$("intake-examples").querySelectorAll(".qchip").forEach((c) =>
  c.addEventListener("click", () => { $("intake-text").value = c.dataset.text; $("intake-text").focus(); })
);
$("intake-run").addEventListener("click", () => {
  const text = $("intake-text").value.trim();
  if (!text) { $("intake-text").focus(); return; }
  runCopilot({ text, location: $("intake-loc").value.trim() || null, workOrderId: null }, $("intake-result"));
});

// Drawer Copilot
$("drawer-run").addEventListener("click", () => {
  const text = $("drawer-input").value.trim() || activeWo?.description || activeWo?.title || "";
  if (!text) return;
  runCopilot({ text, location: locName(activeWo), workOrderId: activeWo?.id }, $("drawer-copilot"));
});

$("view-toggle").querySelectorAll(".seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view;
    $("view-toggle").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $("board-view").hidden = state.view !== "board";
    $("list-view").hidden = state.view !== "list";
    renderAll();
  })
);

document.querySelectorAll(".filter-link").forEach((link) =>
  link.addEventListener("click", () => {
    const p = link.dataset.priority;
    state.priorityFilter = state.priorityFilter === p ? null : p;
    document.querySelectorAll(".filter-link").forEach((l) =>
      l.classList.toggle("selected", l.dataset.priority === state.priorityFilter)
    );
    renderAll();
  })
);

load();
