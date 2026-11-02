"use strict";
/* global icon, ACTION_ICONS, ACTION_COLORS, CodeEditor, detectLang, highlight */

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(s) {
  if (s == null) return "";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const hr = Math.floor(m / 60);
  return hr < 48 ? `${hr}h ${m % 60}m` : `${Math.floor(hr / 24)}d ${hr % 24}h`;
}
function fmtAgo(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const pct = (a, b) => (b ? (100 * a) / b : 0);

// Job status → label, badge icon, glow colour, dot.
const STATUS = {
  running: { label: "Running", icon: "loader", glow: "g-blue", dot: "dot-running" },
  success: { label: "Success", icon: "check", glow: "g-green", dot: "dot-ok" },
  failed: { label: "Failed", icon: "circle-alert", glow: "g-red", dot: "dot-failed" },
  killed: { label: "Stopped", icon: "square", glow: "g-amber", dot: "dot-warn" },
};
const statusOf = (job) => STATUS[job && job.status] || null;

function badge(job) {
  const st = statusOf(job) || { label: job.status, icon: "clock" };
  const label = job.status === "failed" && job.exit_code != null ? `Exit ${job.exit_code}` : st.label;
  return h("span", { class: `badge ${job.status}` }, icon(st.icon, job.status === "running" ? "spin" : ""), label);
}
function setBadge(el, job) { el.replaceWith(Object.assign(badge(job), { id: el.id })); }

/** Glow classes for a framed element, by job state. */
function glowFor(job, base) {
  const st = statusOf(job);
  return `${base} ${st ? st.glow : "g-gray"} ${job && job.status === "running" ? "breathe" : ""}`;
}

function toast(msg, kind = "", action) {
  const ic = kind === "ok" ? "check" : kind === "error" ? "circle-alert" : "activity";
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, icon(ic), h("span", {}, msg),
    action && h("button", { class: "btn btn-ghost btn-sm", onclick: () => { action.fn(); t.remove(); } }, action.label));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 4500);
}

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsJson(k, fallback) { try { return JSON.parse(lsGet(k)) ?? fallback; } catch (e) { return fallback; } }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* insecure context */ }
  const ta = h("textarea", { style: "position:fixed;opacity:0" }, text);
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: { "X-Helm": "1" }, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/${path}`, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && path !== "login") {
    showLogin();
    throw new Error("Session expired — please sign in again");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const q = (params) => new URLSearchParams(params).toString();

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  session: null,
  library: [],
  jobs: [],
  servers: [],
  server: lsGet("helm-server") || "local",
  services: null,
  serviceFilter: lsGet("helm-svc-filter") || "pinned",
  serverFilter: "all",
  actionGroup: lsGet("helm-action-group") || "all",
  view: "actions",
  hash: "",
  running: new Map(), // job id -> summary
  drawer: null, // { jobs: [...], active: id }
  edit: null,
  editDraft: null,
  files: null,
  guard: null, // () => true when the current view has unsaved changes
};

const serverById = (id) => S.servers.find((s) => s.id === id);
const current = () => serverById(S.server) || S.servers[0];
const multi = () => S.servers.length > 1;

// ---------------------------------------------------------------------------
// boot / auth
// ---------------------------------------------------------------------------
async function boot() {
  try {
    S.session = await api("GET", "session");
  } catch (e) {
    document.body.textContent = "Cannot reach Helm.";
    return;
  }
  $("#login-host").textContent = S.session.hostname;
  if (S.session.auth_required && !S.session.user) showLogin();
  else showApp();
}

function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  closeDrawer();
  $("#login-form [name=username]").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $("#login-error");
  err.hidden = true;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  try {
    await api("POST", "login", { username: f.username.value, password: f.password.value });
    f.password.value = "";
    S.session = await api("GET", "session");
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "logout").catch(() => {});
  showLogin();
});

let started = false;
async function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  const authed = S.session.auth_required;
  $("#logout-btn").hidden = !authed;
  $("#side-user").hidden = !authed;
  if (authed) {
    $("#side-avatar").textContent = (S.session.user || "?").slice(0, 1);
    $("#side-user-name").textContent = S.session.user;
  }
  $("#version").textContent = `v${S.session.version}`;
  $$("[data-edit-only]").forEach((el) => (el.hidden = !S.session.allow_editing));
  await Promise.all([loadServers(), loadLibrary(), loadJobs()]);
  if (!started) {
    started = true;
    refreshSystem();
    setInterval(refreshSystem, 5000);
    setInterval(loadServers, 10000);
  }
  route();
}

// ---------------------------------------------------------------------------
// router, unsaved-changes guard, sidebar
// ---------------------------------------------------------------------------
const VIEWS = ["actions", "servers", "services", "files", "console", "history", "edit"];

async function onHashChange() {
  if (S.guard && S.guard() && location.hash !== S.hash) {
    const target = location.hash;
    history.replaceState(null, "", S.hash || "#actions");
    const ok = await confirmDialog({ title: "Discard unsaved changes?", message: "You have edits that haven’t been saved.",
      confirmLabel: "Discard", confirmIcon: "trash", danger: true });
    if (!ok) return;
    S.guard = null;
    location.hash = target;
    return;
  }
  route();
}
window.addEventListener("hashchange", onHashChange);
window.addEventListener("beforeunload", (e) => { if (S.guard && S.guard()) { e.preventDefault(); e.returnValue = ""; } });

function route() {
  const [base, arg] = (location.hash.slice(1) || "actions").split("/");
  let view = VIEWS.includes(base) ? base : "actions";
  if ((view === "console" || view === "edit") && !S.session.allow_editing) view = "actions";
  S.view = view;
  S.hash = location.hash || "#actions";
  S.guard = null;
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  setSidebar(false);
  $("#main").scrollTop = 0;
  if (view === "actions") renderActions();
  if (view === "servers") renderServers();
  if (view === "services") loadServices();
  if (view === "files") renderFiles();
  if (view === "history") loadJobs().then(renderHistory);
  if (view === "console") renderConsole();
  if (view === "edit") renderEdit(arg || "new");
}

function setSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#sidebar-scrim").hidden = !open;
}
$("#sidebar-open").addEventListener("click", () => setSidebar(true));
$("#sidebar-close").addEventListener("click", () => setSidebar(false));
$("#sidebar-scrim").addEventListener("click", () => setSidebar(false));

/** Sidebar "Recent runs": running first, then the latest finished, each glowing by state. */
function renderSideRuns() {
  const running = [...S.running.values()];
  const ids = new Set(running.map((j) => j.id));
  const list = [...running, ...S.jobs.filter((j) => !ids.has(j.id))].slice(0, 8);
  const root = $("#side-runs");
  if (!list.length) {
    root.replaceChildren(h("div", { class: "side-empty" }, "Nothing has run yet."));
    return;
  }
  root.replaceChildren(...list.map((j) => {
    const st = statusOf(j);
    const state = j.status === "running" ? "Running…"
      : j.status === "failed" ? `Failed${j.exit_code != null ? ` · exit ${j.exit_code}` : ""}`
      : (st ? st.label : j.status);
    const sub = [multi() && j.server_name, state, j.status !== "running" && fmtAgo(j.started)].filter(Boolean).join(" · ");
    return h("button", { class: glowFor(j, "side-run glow-sm"), title: `${j.title} — ${j.server_name || ""}`,
      onclick: () => { setSidebar(false); openDrawer(j); } },
      h("span", { class: `dot ${st ? st.dot : ""}` }),
      h("span", { class: "side-run-text" },
        h("span", { class: "side-run-title" }, j.title),
        h("span", { class: `side-run-sub t-${j.status}` }, sub)));
  }));
}

// ---------------------------------------------------------------------------
// servers: list, switcher, header stats
// ---------------------------------------------------------------------------
async function loadServers() {
  if ($("#app-view").hidden) return;
  try { S.servers = (await api("GET", "servers")).servers; } catch (e) { return; }
  if (!serverById(S.server) && S.servers.length) selectServer(S.servers[0].id, true);
  const online = S.servers.filter((s) => s.online).length;
  $("#nav-servers").textContent = S.servers.length > 1 ? `${online}/${S.servers.length}` : "";
  renderSwitcher();
  if (S.view === "servers") renderServers();
}

function selectServer(id, quiet) {
  if (id === S.server && !quiet) return;
  S.server = id;
  lsSet("helm-server", id);
  renderSwitcher();
  if (quiet) return;
  $("#stats").replaceChildren();
  refreshSystem();
  if (S.view === "services") { S.services = null; loadServices(); }
  if (S.view === "files") renderFiles();
  if (S.view === "console") renderConsole();
  if (S.view === "edit") updateEditTarget();
}

function serverDot(s) { return s && s.online ? "dot-ok" : ""; }

function renderSwitcher() {
  const s = current();
  if (!s) return;
  $("#switcher-dot").className = `dot ${serverDot(s)}`;
  $("#host-name").textContent = s.name;
  const meta = s.online
    ? [s.system.os, s.system.uptime != null && `up ${fmtDuration(s.system.uptime)}`].filter(Boolean).join(" · ")
    : `offline${s.last_seen ? ` · last seen ${fmtAgo(s.last_seen)}` : ""}`;
  $("#host-meta").textContent = meta || s.hostname || "";
  $("#server-switcher").classList.toggle("single", !multi());
  const pop = $("#switcher-pop");
  pop.replaceChildren(
    ...S.servers.map((x) => h("button", { role: "menuitemradio", "aria-checked": String(x.id === S.server),
      class: x.id === S.server ? "on" : "", onclick: () => { pop.hidden = true; selectServer(x.id); } },
      h("span", { class: `dot ${serverDot(x)}` }),
      h("span", { class: "sw-name" }, x.name),
      x.local && h("span", { class: "badge" }, "hub"),
      ...x.tags.slice(0, 2).map((t) => h("span", { class: "badge" }, t)))),
    h("div", { class: "menu-sep" }),
    h("button", { onclick: () => { pop.hidden = true; location.hash = "servers"; } }, icon("globe"), "Manage servers"));
}
$("#server-switcher").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#switcher-pop");
  $$(".menu-pop").forEach((p) => p !== pop && (p.hidden = true));
  pop.hidden = !pop.hidden;
});

async function refreshSystem() {
  if ($("#app-view").hidden) return;
  const s = current();
  if (!s) return;
  if (!s.online) {
    $("#stats").replaceChildren(h("span", { class: "badge" }, icon("wifi-off"), "Offline"));
    return;
  }
  let sys;
  try { sys = await api("GET", `system?${q({ server: s.id })}`); } catch (e) { return; }
  if (s.id !== S.server) return;
  s.system = sys;
  const stat = (label, value, p) => {
    const cls = p >= 90 ? "crit" : p >= 75 ? "warn" : "";
    return h("div", { class: "stat" },
      h("div", { class: "stat-top" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value)),
      p != null && h("div", { class: `meter ${cls}` }, h("i", { style: `width:${Math.min(100, p)}%` })));
  };
  const stats = [];
  if (sys.cpu != null) stats.push(stat("CPU", `${sys.cpu}%`, sys.cpu));
  if (sys.load) stats.push(stat("Load", sys.load[0].toFixed(2), pct(sys.load[0], sys.cpus || 1)));
  if (sys.mem_total) stats.push(stat("Mem", fmtBytes(sys.mem_used), pct(sys.mem_used, sys.mem_total)));
  if (sys.disk_total) stats.push(stat("Disk", `${Math.round(pct(sys.disk_used, sys.disk_total))}%`, pct(sys.disk_used, sys.disk_total)));
  $("#stats").replaceChildren(...stats);
  document.title = `${s.name} · Helm`;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function loadLibrary() {
  S.library = (await api("GET", "library")).items;
}

async function loadJobs() {
  try { S.jobs = (await api("GET", "jobs")).jobs; } catch (e) { /* toast elsewhere */ }
  renderSideRuns();
}

/** The latest run of an action, across every server it ran on, with an overall status. */
function lastRunFor(actionId) {
  const all = [...S.running.values(), ...S.jobs];
  const latest = all.filter((j) => j.meta && j.meta.action_id === actionId).sort((a, b) => b.started - a.started)[0];
  if (!latest) return null;
  const seen = new Set();
  const jobs = all.filter((j) => j.run_id === latest.run_id && !seen.has(j.id) && seen.add(j.id));
  const status = jobs.some((j) => j.status === "running") ? "running"
    : jobs.some((j) => j.status === "failed") ? "failed"
    : jobs.some((j) => j.status === "killed") ? "killed" : "success";
  return { ...latest, status, jobs };
}

$("#action-search").addEventListener("input", renderActions);
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || !$("#modal").hidden) return;
  const search = { actions: "#action-search", services: "#service-search", history: "#history-search" }[S.view];
  if (!search) return;
  e.preventDefault();
  $(search).focus();
});

function pill(label, count, pressed, onclick, dotClass) {
  return h("button", { type: "button", class: "pill", "aria-pressed": String(pressed), onclick },
    dotClass && h("span", { class: `dot ${dotClass}` }), label, count != null && h("span", { class: "n" }, count));
}

function renderActions() {
  const query = $("#action-search").value.trim().toLowerCase();
  const groups = new Map();
  for (const a of S.library) groups.set(a.group, (groups.get(a.group) || 0) + 1);
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  if (S.actionGroup !== "all" && !groups.has(S.actionGroup)) S.actionGroup = "all";
  const setGroup = (g) => { S.actionGroup = g; lsSet("helm-action-group", g); renderActions(); };
  $("#action-pills").replaceChildren(
    pill("All", S.library.length, S.actionGroup === "all", () => setGroup("all")),
    ...groupNames.map((g) => pill(g, groups.get(g), S.actionGroup === g, () => setGroup(g))));
  $("#action-pills").hidden = groupNames.length < 2;
  const failing = S.library.filter((a) => lastRunFor(a.id)?.status === "failed").length;
  $("#actions-sub").replaceChildren(`${S.library.length} action${S.library.length === 1 ? "" : "s"}`,
    failing ? h("span", { style: "color:var(--danger)" }, ` · ${failing} failed last run`) : "",
    " · click a tile to run it");

  const items = S.library.filter((a) =>
    (S.actionGroup === "all" || a.group === S.actionGroup) &&
    (!query || [a.name, a.description, a.group, a.body, ...(a.scope_tags || [])].some((s) => (s || "").toLowerCase().includes(query))));
  const root = $("#action-groups");
  if (!S.library.length) {
    root.replaceChildren(emptyState("zap", "No actions yet",
      S.session.allow_editing ? "Write a script in the editor, or run something in the Console and save it." : "Nothing has been configured on this hub.",
      S.session.allow_editing && h("a", { class: "btn btn-primary btn-sm", href: "#edit/new" }, icon("plus"), "New action")));
    return;
  }
  if (!items.length) {
    root.replaceChildren(emptyState("search", "No matches", `Nothing matches “${query}”.`));
    return;
  }
  const byGroup = new Map();
  for (const a of items) {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group).push(a);
  }
  root.replaceChildren(...[...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) =>
    h("section", { class: "group" },
      h("h2", { class: "group-title" }, name, h("span", { class: "n" }, list.length)),
      h("div", { class: "tiles" }, list.sort((a, b) => a.name.localeCompare(b.name)).map(actionTile)))));
}

function emptyState(ic, title, body, action) {
  return h("div", { class: "empty" }, h("span", { class: "empty-icon" }, icon(ic, ic === "loader" ? "spin" : "")),
    h("p", { class: "empty-title" }, title), body && h("p", { class: "empty-body" }, body), action);
}

function tileIcon(a, small) {
  return h("span", { class: `tile-icon ${small ? "tile-icon-sm" : ""} c-${a.color || "blue"}` }, icon(a.icon || "terminal"));
}

function actionTile(a) {
  const last = lastRunFor(a.id);
  const st = statusOf(last);
  const running = last && last.status === "running";
  const where = last && last.jobs.length > 1 ? `${last.jobs.length} servers` : last ? last.server_name : "";
  return h("div", { class: `${glowFor(last, "tile glow")} c-${a.color || "blue"} ${a.danger ? "danger" : ""}` },
    h("button", { class: "tile-hit", title: `Run “${a.name}”`, onclick: () => runAction(a) },
      tileIcon(a),
      h("span", { class: "tile-name" }, a.name),
      a.description && h("span", { class: "tile-desc" }, a.description),
      h("span", { class: "tile-foot" },
        running
          ? h("span", { class: "tile-run" }, icon("loader", "spin"), "Running")
          : h("span", { class: "tile-run" }, icon("play"), a.danger ? "Run…" : "Run"),
        a.params && a.params.length > 0 && h("span", { class: "badge" }, `${a.params.length} param${a.params.length > 1 ? "s" : ""}`),
        (a.scope_tags || []).length > 0 && h("span", { class: "badge", title: "Only on servers tagged " + a.scope_tags.join(", ") }, icon("tag"), a.scope_tags.join(", ")))),
    last && h("span", { class: "tile-status", title: `${st ? st.label : last.status}${where ? " · " + where : ""} · ${fmtAgo(last.started)}` },
      h("span", { class: `dot ${st ? st.dot : ""}` })),
    last && !running && h("button", { class: "tile-last btn btn-ghost btn-sm", title: "View last run",
      onclick: () => openDrawer(last.jobs) }, fmtAgo(last.started)),
    S.session.allow_editing && h("div", { class: "tile-tools" },
      h("a", { class: "btn btn-ghost btn-icon btn-sm", title: "Edit", "aria-label": `Edit ${a.name}`, href: `#edit/${a.id}` }, icon("pencil")),
      h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Duplicate", "aria-label": `Duplicate ${a.name}`,
        onclick: () => openEditor({ ...a, id: null, name: `${a.name} (copy)` }) }, icon("copy"))));
}

function eligibleServers(a) {
  const scope = a.scope_tags || [];
  return S.servers.filter((s) => !scope.length || s.tags.some((t) => scope.includes(t)));
}

async function runAction(a) {
  const eligible = eligibleServers(a);
  if (!eligible.length) return toast(`No server is tagged ${a.scope_tags.join(" or ")}`, "error");
  const online = eligible.filter((s) => s.online);
  const hasParams = a.params && a.params.length > 0;
  let choice;
  if (eligible.length === 1 && !hasParams && !a.confirm && !a.danger) {
    if (!online.length) return toast(`${eligible[0].name} is offline`, "error");
    choice = { servers: [eligible[0].id], params: {} };
  } else {
    choice = await runDialog(a, eligible);
    if (!choice) return;
  }
  try {
    const res = await api("POST", `library/${a.id}/run`, choice);
    res.jobs.forEach((j) => trackJob(j));
    openDrawer(res.jobs);
  } catch (e) { toast(e.message, "error"); }
}

/** One dialog for everything a run needs: parameter values, target servers, confirmation. */
function runDialog(a, eligible) {
  const remembered = lsJson(`helm-params-${a.id}`, {});
  const online = eligible.filter((s) => s.online);
  let selected = new Set(lsJson(`helm-targets-${a.id}`, []).filter((id) => online.some((s) => s.id === id)));
  if (!selected.size) {
    const cur = online.find((s) => s.id === S.server) || online[0];
    if (cur) selected.add(cur.id);
  }
  const boxes = new Map();
  const sync = () => {
    boxes.forEach((cb, id) => (cb.checked = selected.has(id)));
    count.textContent = `${selected.size} selected`;
    submitLabel.textContent = selected.size > 1 ? `Run on ${selected.size} servers` : "Run";
  };
  const count = h("span", { class: "muted small" });
  const submitLabel = h("span", {}, "Run");
  const tags = [...new Set(eligible.flatMap((s) => s.tags))].sort();
  const targetSection = eligible.length > 1 && h("div", { class: "field" },
    h("div", { class: "label-row" }, h("span", { class: "label" }, "Run on"), count),
    h("div", { class: "pills pills-tight" },
      pill("All online", online.length, false, () => { selected = new Set(online.map((s) => s.id)); sync(); }),
      ...tags.map((t) => pill(t, online.filter((s) => s.tags.includes(t)).length, false, () => {
        const withTag = online.filter((s) => s.tags.includes(t)).map((s) => s.id);
        const all = withTag.every((id) => selected.has(id));
        withTag.forEach((id) => (all ? selected.delete(id) : selected.add(id)));
        sync();
      }, "dot-tag")),
      pill("None", null, false, () => { selected.clear(); sync(); })),
    h("div", { class: "target-list" }, eligible.map((s) => {
      const cb = h("input", { type: "checkbox", disabled: !s.online, onchange: (e) => {
        e.target.checked ? selected.add(s.id) : selected.delete(s.id);
        sync();
      } });
      boxes.set(s.id, cb);
      return h("label", { class: `target ${s.online ? "" : "off"}` }, cb,
        h("span", { class: `dot ${serverDot(s)}` }),
        h("span", { class: "target-name" }, s.name),
        h("span", { class: "target-host" }, s.online ? s.hostname || "" : "offline"),
        ...s.tags.map((t) => h("span", { class: "badge" }, t)));
    })));
  setTimeout(sync);
  return modal({
    title: a.name,
    size: eligible.length > 1 ? "" : "sm",
    body: [
      a.description && h("p", { class: "confirm-desc", style: "margin-bottom:.875rem" }, a.description),
      ...(a.params || []).map((p) => h("label", { class: "field" }, h("span", { class: "label mono" }, p),
        h("input", { class: "input", name: p, value: remembered[p] || "", autocomplete: "off" }))),
      targetSection,
      (a.confirm || a.danger) && h("div", { class: "confirm-cmd" }, a.body),
    ],
    buttons: [
      { label: "Cancel", value: null },
      { label: submitLabel, icon: "play", primary: !a.danger, danger: a.danger, submit: true },
    ],
    onSubmit: (form) => {
      const params = {};
      for (const p of a.params || []) params[p] = form.elements[p].value;
      lsSet(`helm-params-${a.id}`, JSON.stringify(params));
      const servers = eligible.length > 1 ? [...selected] : [eligible[0].id];
      if (!servers.length) throw new Error("Pick at least one server");
      if (eligible.length === 1 && !eligible[0].online) throw new Error(`${eligible[0].name} is offline`);
      lsSet(`helm-targets-${a.id}`, JSON.stringify(servers));
      return { servers, params };
    },
  });
}

function lookPicker(a, onChange) {
  let chosenIcon = a.icon || "terminal";
  let chosenColor = a.color || "blue";
  const hiddenIcon = h("input", { type: "hidden", name: "icon", value: chosenIcon });
  const hiddenColor = h("input", { type: "hidden", name: "color", value: chosenColor });
  const changed = () => { hiddenIcon.value = chosenIcon; hiddenColor.value = chosenColor; onChange && onChange(chosenIcon, chosenColor); };
  const iconBtns = ACTION_ICONS.map((name) => h("button", {
    type: "button", class: "icon-opt", role: "radio", title: name, "aria-label": name, "aria-checked": String(name === chosenIcon),
    onclick: (e) => {
      chosenIcon = name;
      iconBtns.forEach((b) => b.setAttribute("aria-checked", String(b === e.currentTarget)));
      changed();
    },
  }, icon(name)));
  const colorBtns = ACTION_COLORS.map((c) => h("button", {
    type: "button", class: `color-opt c-${c}`, role: "radio", title: c, "aria-label": c, "aria-checked": String(c === chosenColor),
    onclick: (e) => {
      chosenColor = c;
      colorBtns.forEach((b) => b.setAttribute("aria-checked", String(b === e.currentTarget)));
      changed();
    },
  }));
  return h("div", { class: "field" },
    h("span", { class: "label" }, "Icon & colour"),
    h("div", { class: "icon-grid", role: "radiogroup", "aria-label": "Icon" }, iconBtns),
    h("div", { class: "color-row", role: "radiogroup", "aria-label": "Colour" }, colorBtns),
    hiddenIcon, hiddenColor);
}

// ---------------------------------------------------------------------------
// script editor (full page)
// ---------------------------------------------------------------------------
const NEW_SCRIPT = "#!/usr/bin/env bash\n# Runs on each server you pick. Parameters arrive as env vars ($NAME) and as $1, $2…\nset -euo pipefail\n\n";

function openEditor(draft, { fromConsole = false } = {}) {
  S.editDraft = { ...draft, fromConsole };
  if (location.hash === "#edit/new") renderEdit("new");
  else location.hash = "edit/new";
}

function renderEdit(id) {
  let item;
  if (id === "new") {
    item = { group: "General", icon: "terminal", color: "blue", interpreter: "bash", body: NEW_SCRIPT, ...(S.editDraft || {}) };
    S.editDraft = null;
  } else {
    item = S.library.find((a) => a.id === id);
    if (!item) { toast("That action no longer exists", "error"); location.hash = "actions"; return; }
    item = { ...item };
  }
  const form = $("#edit-form");
  const groups = [...new Set(S.library.map((x) => x.group))].sort();
  const editor = new CodeEditor({
    value: item.body || "", lang: item.interpreter || "bash", placeholder: "echo hello",
    onChange: () => markDirty(), onSave: () => saveEdit(), onRun: () => testRunEdit(),
  });
  S.edit = { id: item.id || null, editor, job: null, stop: null };

  form.replaceChildren(
    h("div", { class: "side-section" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Name"),
        h("input", { class: "input", name: "name", value: item.name || "", required: true, placeholder: "Restart web stack" })),
      h("div", { class: "field-row" },
        h("label", { class: "field" }, h("span", { class: "label" }, "Group"),
          h("input", { class: "input", name: "group", value: item.group || "", list: "group-list", placeholder: "General" }),
          h("datalist", { id: "group-list" }, groups.map((g) => h("option", { value: g })))),
        h("label", { class: "field" }, h("span", { class: "label" }, "Timeout (s)"),
          h("input", { class: "input", name: "timeout", type: "number", min: "0", value: item.timeout || "", placeholder: "Default" }))),
      h("label", { class: "field" }, h("span", { class: "label" }, "Description"),
        h("input", { class: "input", name: "description", value: item.description || "", placeholder: "What does this do?" }))),
    h("div", { class: "side-section" },
      lookPicker(item, (ic, color) => { drawEditIcon(ic, color); markDirty(); })),
    h("div", { class: "side-section" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Parameters"),
        h("input", { class: "input mono-input", name: "params", value: (item.params || []).join(", "), placeholder: "SERVICE, LINES" }),
        h("span", { class: "hint-text" }, "Asked for at run time. Available as $SERVICE (and $1, $2…). Passed as environment variables, never pasted into the script.")),
      h("label", { class: "field" }, h("span", { class: "label" }, "Only on servers tagged"),
        h("input", { class: "input mono-input", name: "scope_tags", value: (item.scope_tags || []).join(", "), placeholder: "any server" }),
        h("span", { class: "hint-text" }, `Tags in use: ${[...new Set(S.servers.flatMap((s) => s.tags))].join(", ") || "none yet"}`)),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "confirm", checked: !!item.confirm }), "Ask for confirmation before running"),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "danger", checked: !!item.danger }), "Destructive (red, always confirms)")),
    h("p", { class: "form-error", id: "edit-error", hidden: true }),
    item.id && h("div", { class: "side-section side-danger" },
      h("button", { type: "button", class: "btn btn-danger-outline btn-sm", onclick: deleteEdit }, icon("trash"), "Delete action")));
  form.oninput = () => markDirty();
  form.onsubmit = (e) => { e.preventDefault(); saveEdit(); };

  $("#edit-code").replaceChildren(editor.el);
  $("#edit-interp").value = item.interpreter || "bash";
  $("#edit-interp").onchange = () => { editor.setLang($("#edit-interp").value); markDirty(); };
  const pos = () => { const c = editor.cursor(); $("#edit-pos").textContent = `Ln ${c.line}, Col ${c.col}`; };
  ["keyup", "click", "focus"].forEach((ev) => editor.ta.addEventListener(ev, pos));
  pos();
  drawEditIcon(item.icon, item.color);
  $("#edit-out").hidden = true;
  S.edit.saved = editSnapshot();
  if (item.fromConsole) S.edit.saved = null; // a console draft starts unsaved
  S.guard = () => S.edit && S.edit.saved !== editSnapshot();
  markDirty();
  updateEditTarget();
  setTimeout(() => (item.id ? editor.focus() : $("#edit-form [name=name]").focus()));
}

function drawEditIcon(ic, color) {
  $("#edit-icon").replaceWith(Object.assign(tileIcon({ icon: ic, color }, true), { id: "edit-icon" }));
}

function editValues() {
  const f = $("#edit-form").elements;
  return {
    id: S.edit.id || undefined, name: f.name.value, group: f.group.value, description: f.description.value,
    icon: f.icon.value, color: f.color.value, body: S.edit.editor.value, interpreter: $("#edit-interp").value,
    timeout: f.timeout.value, params: f.params.value, scope_tags: f.scope_tags.value,
    confirm: f.confirm.checked, danger: f.danger.checked,
  };
}
const editSnapshot = () => JSON.stringify(editValues());

function markDirty() {
  if (!S.edit) return;
  const dirty = S.edit.saved !== editSnapshot();
  const name = $("#edit-form [name=name]").value.trim();
  $("#edit-heading").replaceChildren(name || (S.edit.id ? "Untitled" : "New action"),
    dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes" }) : "");
}

function updateEditTarget() {
  const s = current();
  if (!s || S.view !== "edit") return;
  $("#edit-sub").textContent = `Check and Test run use ${s.name}${s.online ? "" : " (offline)"} · switch servers above`;
}

async function saveEdit() {
  if (!S.edit) return;
  const err = $("#edit-error");
  err.hidden = true;
  try {
    const saved = await api("POST", "library", editValues());
    const isNew = !S.edit.id;
    S.edit.id = saved.id;
    await loadLibrary();
    S.edit.saved = editSnapshot();
    markDirty();
    if (isNew) {
      history.replaceState(null, "", `#edit/${saved.id}`);
      S.hash = location.hash;
    }
    toast(`Saved “${saved.name}”`, "ok", { label: "Actions", fn: () => (location.hash = "actions") });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    toast(e.message, "error");
  }
}

async function deleteEdit() {
  const name = $("#edit-form [name=name]").value;
  const ok = await confirmDialog({ title: `Delete “${name}”?`, message: "This can’t be undone.", confirmLabel: "Delete", confirmIcon: "trash", danger: true });
  if (!ok) return;
  try {
    await api("DELETE", `library/${S.edit.id}`);
    await loadLibrary();
    S.guard = null;
    S.edit = null;
    toast(`Deleted “${name}”`);
    location.hash = "actions";
  } catch (e) { toast(e.message, "error"); }
}

function showEditOutput(title) {
  const out = $("#edit-out");
  out.hidden = false;
  $("#edit-out-title").textContent = title;
  $("#edit-out-term").textContent = "";
  $("#edit-out-time").textContent = "";
  $("#edit-out-kill").hidden = true;
  if (S.edit.stop) { S.edit.stop(); S.edit.stop = null; }
  return out;
}
$("#edit-out-close").addEventListener("click", () => { $("#edit-out").hidden = true; });
$("#edit-out-kill").addEventListener("click", () => S.edit?.job && api("POST", `jobs/${S.edit.job.id}/kill`).catch(() => {}));

async function checkEdit() {
  const s = current();
  const out = showEditOutput(`Syntax check on ${s.name}`);
  out.className = "term-frame glow-inset edit-out g-blue breathe";
  setBadge($("#edit-out-status"), { status: "running" });
  try {
    const res = await api("POST", "check", { server: s.id, interpreter: $("#edit-interp").value, body: S.edit.editor.value });
    const text = res.results.map((r) => `${r.ok ? "✓" : "✗"} ${r.tool}${r.output ? "\n" + r.output : r.ok ? ": no problems found" : ""}`).join("\n\n");
    $("#edit-out-term").textContent = text;
    const status = res.ok ? "success" : "failed";
    out.className = `term-frame glow-inset edit-out ${STATUS[status].glow}`;
    setBadge($("#edit-out-status"), { status });
    if (!res.results.some((r) => r.tool === "shellcheck") && $("#edit-interp").value !== "python3") {
      $("#edit-out-term").append("\n\nTip: install shellcheck on the server for deeper checks.");
    }
  } catch (e) {
    $("#edit-out-term").textContent = e.message;
    out.className = "term-frame glow-inset edit-out g-red";
    setBadge($("#edit-out-status"), { status: "failed" });
  }
}
$("#edit-check").addEventListener("click", checkEdit);
$("#edit-save").addEventListener("click", saveEdit);
$("#edit-run").addEventListener("click", () => testRunEdit());

async function testRunEdit() {
  if (!S.edit) return;
  const s = current();
  if (!s.online) return toast(`${s.name} is offline`, "error");
  const v = editValues();
  const names = v.params.split(",").map((p) => p.trim()).filter(Boolean);
  let params = {};
  if (names.length) {
    params = await modal({
      title: "Test run", size: "sm",
      body: names.map((p) => h("label", { class: "field" }, h("span", { class: "label mono" }, p),
        h("input", { class: "input", name: p, value: lsJson("helm-test-params", {})[p] || "" }))),
      buttons: [{ label: "Cancel", value: null }, { label: `Run on ${s.name}`, icon: "play", primary: true, submit: true }],
      onSubmit: (form) => {
        const out = {};
        names.forEach((p) => (out[p] = form.elements[p].value));
        lsSet("helm-test-params", JSON.stringify({ ...lsJson("helm-test-params", {}), ...out }));
        return out;
      },
    });
    if (!params) return;
  }
  try {
    const job = await api("POST", "console", {
      server: s.id, body: v.body, interpreter: v.interpreter, param_names: names, params,
      source: "editor", title: `Test: ${v.name || "untitled"}`,
    });
    S.edit.job = job;
    trackJob(job);
    const out = showEditOutput(`${job.title} · ${s.name}`);
    S.edit.stop = streamJob(job, $("#edit-out-term"), (j) => {
      out.className = glowFor(j, "term-frame glow-inset edit-out");
      setBadge($("#edit-out-status"), j);
      $("#edit-out-kill").hidden = j.status !== "running";
      $("#edit-out-time").textContent = j.finished ? fmtDuration(j.finished - j.started) : "";
    });
    out.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) { toast(e.message, "error"); }
}

// ---------------------------------------------------------------------------
// servers page
// ---------------------------------------------------------------------------
$("#add-server").addEventListener("click", () => addServerDialog());

function renderServers() {
  const all = S.servers;
  const online = all.filter((s) => s.online).length;
  const tags = [...new Set(all.flatMap((s) => s.tags))].sort();
  const set = (f) => { S.serverFilter = f; renderServers(); };
  $("#server-pills").replaceChildren(
    pill("All", all.length, S.serverFilter === "all", () => set("all")),
    pill("Online", online, S.serverFilter === "online", () => set("online"), "dot-ok"),
    pill("Offline", all.length - online, S.serverFilter === "offline", () => set("offline")),
    ...tags.map((t) => pill(t, all.filter((s) => s.tags.includes(t)).length, S.serverFilter === `tag:${t}`, () => set(`tag:${t}`), "dot-tag")));
  $("#servers-sub").textContent = `${all.length} server${all.length === 1 ? "" : "s"} · ${online} online. Agents dial out to this hub; no inbound ports needed.`;
  let list = all;
  if (S.serverFilter === "online") list = all.filter((s) => s.online);
  if (S.serverFilter === "offline") list = all.filter((s) => !s.online);
  if (S.serverFilter.startsWith("tag:")) list = all.filter((s) => s.tags.includes(S.serverFilter.slice(4)));
  const root = $("#servers-body");
  if (!list.length) {
    root.replaceChildren(emptyState("globe", "No servers here", "Add a server to install helm-agent on it.",
      S.session.allow_editing && h("button", { class: "btn btn-primary btn-sm", onclick: () => addServerDialog() }, icon("plus"), "Add server")));
    return;
  }
  root.replaceChildren(h("div", { class: "tiles tiles-wide" }, list.map(serverTile)));
}

function serverTile(s) {
  const sys = s.system || {};
  const meter = (label, value, p) => h("div", { class: "mini-stat" },
    h("div", { class: "stat-top" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value)),
    h("div", { class: `meter ${p >= 90 ? "crit" : p >= 75 ? "warn" : ""}` }, h("i", { style: `width:${Math.min(100, p || 0)}%` })));
  const pol = s.policy || {};
  const limits = [!pol.allow_scripts && "no scripts", !pol.allow_files && "no files",
    pol.allow_files && !pol.allow_file_writes && "files read-only", !pol.allow_services && "no services"].filter(Boolean);
  const go = (view) => { selectServer(s.id); location.hash = view; };
  return h("div", { class: `tile glow server-tile ${s.online ? "g-green" : "g-gray"} ${s.online ? "c-green" : "c-gray"}` },
    h("button", { class: "tile-hit", title: `Open ${s.name}`, onclick: () => go("services") },
      h("span", { class: `tile-icon ${s.online ? "c-green" : "c-gray"}` }, icon(s.online ? "server" : "wifi-off")),
      h("span", { class: "tile-name" }, s.name),
      h("span", { class: "tile-desc" }, s.online ? (sys.os || s.hostname || "") : `offline${s.last_seen ? " · last seen " + fmtAgo(s.last_seen) : " · never connected"}`),
      s.online && h("span", { class: "mini-stats" },
        meter("CPU", sys.cpu != null ? `${sys.cpu}%` : "—", sys.cpu),
        meter("Mem", sys.mem_total ? `${Math.round(pct(sys.mem_used, sys.mem_total))}%` : "—", pct(sys.mem_used, sys.mem_total)),
        meter("Disk", sys.disk_total ? `${Math.round(pct(sys.disk_used, sys.disk_total))}%` : "—", pct(sys.disk_used, sys.disk_total))),
      h("span", { class: "tile-foot" },
        s.local && h("span", { class: "badge badge-primary" }, "hub"),
        ...s.tags.map((t) => h("span", { class: "badge" }, icon("tag"), t)),
        ...limits.map((l) => h("span", { class: "badge badge-warning", title: "Set by this server’s agent policy" }, icon("lock"), l)))),
    h("span", { class: "tile-status" }, h("span", { class: `dot ${serverDot(s)}` })),
    s.id === S.server && h("span", { class: "tile-last", style: "pointer-events:none" }, "selected"),
    S.session.allow_editing && h("div", { class: "tile-tools" },
      h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Files", "aria-label": `Files on ${s.name}`, onclick: () => go("files") }, icon("folder")),
      h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Rename / tags", "aria-label": `Edit ${s.name}`, onclick: () => editServerDialog(s) }, icon("pencil")),
      !s.local && h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Remove", "aria-label": `Remove ${s.name}`, onclick: () => removeServer(s) }, icon("trash"))));
}

function editServerDialog(s) {
  return modal({
    title: `Edit ${s.name}`, size: "sm",
    body: [
      h("label", { class: "field" }, h("span", { class: "label" }, "Name"), h("input", { class: "input", name: "name", value: s.name, required: true })),
      h("label", { class: "field" }, h("span", { class: "label" }, "Tags"),
        h("input", { class: "input mono-input", name: "tags", value: s.tags.join(", "), placeholder: "web, prod" }),
        h("span", { class: "hint-text" }, "Use tags to run actions on groups of servers and to limit where an action may run.")),
    ],
    buttons: [{ label: "Cancel", value: null }, { label: "Save", icon: "save", primary: true, submit: true }],
    onSubmit: async (form) => {
      await api("POST", `servers/${s.id}`, { name: form.elements.name.value, tags: form.elements.tags.value });
      await loadServers();
      toast("Server updated", "ok");
      return true;
    },
  });
}

async function removeServer(s) {
  const ok = await confirmDialog({
    title: `Remove ${s.name}?`, confirmLabel: "Remove", confirmIcon: "trash", danger: true,
    message: "Its agent key is revoked immediately and it disappears from Helm. To bring it back, enroll it again. (The agent keeps running on the server until you stop it: systemctl disable --now helm-agent.)",
  });
  if (!ok) return;
  try {
    await api("DELETE", `servers/${s.id}`);
    await loadServers();
    toast(`Removed ${s.name}`);
  } catch (e) { toast(e.message, "error"); }
}

/** Mirrors agent.py's is_lan_host: private IPs, single-label hosts and LAN suffixes. */
function isLanUrl(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch (e) { return false; }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "localhost") return true;
  if (/^(::1|f[cd][0-9a-f]{2}:|fe80:)/.test(host)) return true;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
  return !host.includes(".") || /\.(lan|local|home|internal|home\.arpa|localdomain)$/.test(host);
}

function addServerDialog() {
  const known = new Set(S.servers.map((s) => s.id));
  let watcher = null;
  const stage2 = h("div", { hidden: true });
  const stage1 = h("div", {},
    h("p", { class: "confirm-desc", style: "margin-bottom:.875rem" },
      "Helm creates a one-time install command. Run it as root on the new server: it installs helm-agent, registers it with this hub, and starts it. The agent connects out to the hub, so the server needs no open ports."),
    h("div", { class: "field-row" },
      h("label", { class: "field" }, h("span", { class: "label" }, "Name (optional)"), h("input", { class: "input", name: "name", placeholder: "its hostname" })),
      h("label", { class: "field" }, h("span", { class: "label" }, "Tags (optional)"), h("input", { class: "input mono-input", name: "tags", placeholder: "web, prod" }))));
  const codeBox = (text) => h("div", { class: "cmd-box" }, h("pre", {}, text),
    h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: async (e) => {
      const ok = await copyText(text);
      e.currentTarget.replaceChildren(icon(ok ? "check" : "copy"), ok ? "Copied" : "Copy failed");
    } }, icon("copy"), "Copy"));
  const p = modal({
    title: "Add a server",
    body: [stage1, stage2],
    buttons: [{ label: "Close", value: null }, { label: "Create install command", icon: "key", primary: true, submit: true }],
    onSubmit: async (form) => {
      if (!stage2.hidden) return "keep-open";
      const res = await api("POST", "enroll", { name: form.elements.name.value, tags: form.elements.tags.value });
      const hub = res.hub_url;
      const oneLiner = `curl -fsSL ${hub}/agent/install.sh | sudo bash -s -- ${hub} ${res.token}`;
      const manual = `curl -fsSLo agent.py ${hub}/agent/agent.py\nsudo python3 agent.py --enroll ${hub} ${res.token}\nsudo python3 agent.py   # or install deploy/install-agent.sh's systemd unit`;
      stage1.hidden = true;
      stage2.hidden = false;
      stage2.replaceChildren(
        h("p", { class: "label" }, "Run on the new server (as root):"),
        codeBox(oneLiner),
        h("details", { class: "manual" }, h("summary", {}, "Prefer to look before you pipe to bash?"), codeBox(manual)),
        h("p", { class: "hint-text" }, `The token works once and expires ${new Date(res.expires * 1000).toLocaleTimeString()}. `,
          hub.startsWith("http://") && !isLanUrl(hub)
            ? h("strong", { style: "color:var(--warning)" }, "This is a public plain-http URL, so agents will refuse to enroll. Use HTTPS, or set agent_url to the hub’s LAN address.")
            : hub.startsWith("http://") ? "Plain http on your private network: fine for a LAN, but traffic isn’t encrypted." : ""),
        h("div", { class: "waiting" }, icon("loader", "spin"), "Waiting for the server to connect…"));
      $("#modal-foot button[type=submit]").hidden = true;
      watcher = setInterval(async () => {
        await loadServers();
        const fresh = S.servers.find((s) => !known.has(s.id));
        if (fresh) {
          clearInterval(watcher);
          stage2.querySelector(".waiting").replaceChildren(icon("check"), `${fresh.name} connected`);
          stage2.querySelector(".waiting").classList.add("ok");
          toast(`${fresh.name} connected`, "ok", { label: "Open", fn: () => { selectServer(fresh.id); location.hash = "services"; } });
        }
      }, 2000);
      return "keep-open";
    },
  });
  p.then(() => { clearInterval(watcher); loadServers(); });
}

// ---------------------------------------------------------------------------
// services
// ---------------------------------------------------------------------------
$("#service-search").addEventListener("input", renderServices);
$("#services-refresh").addEventListener("click", loadServices);

async function loadServices() {
  const s = current();
  if (!S.services || S.services.server !== s.id) $("#services-body").replaceChildren(emptyState("loader", `Loading services on ${s.name}…`));
  const btn = $("#services-refresh svg");
  btn?.classList.add("spin");
  try {
    const data = await api("GET", `services?${q({ server: s.id })}`);
    if (s.id !== S.server) return;
    S.services = { ...data, server: s.id };
  } catch (e) {
    if (s.id !== S.server) return;
    S.services = null;
    $("#service-pills").replaceChildren();
    $("#services-body").replaceChildren(emptyState(s.online ? "circle-alert" : "wifi-off", `Can’t load services on ${s.name}`, e.message));
    return;
  } finally {
    btn?.classList.remove("spin");
  }
  renderServices();
}

function svcState(s) {
  if (s.active === "active") return { glow: "g-green", dot: "dot-ok", badge: "badge-success", icon: "on" };
  if (s.active === "failed") return { glow: "g-red", dot: "dot-failed", badge: "badge-danger", icon: "bad" };
  if (["activating", "deactivating", "reloading"].includes(s.active)) return { glow: "g-amber breathe", dot: "dot-warn", badge: "badge-warning", icon: "" };
  return { glow: "g-gray", dot: "", badge: "", icon: "" };
}

function renderServices() {
  const root = $("#services-body");
  const data = S.services;
  const server = current();
  if (!data) return;
  if (!data.available) {
    $("#service-pills").replaceChildren();
    $("#services-sub").textContent = server.name;
    root.replaceChildren(emptyState("server", `systemd isn’t available on ${server.name}`,
      data.error || "This server doesn’t appear to run systemd, so service controls are off. Actions, Files and the Console still work."));
    return;
  }
  const pinned = new Set(data.pinned);
  const all = data.services;
  const counts = {
    pinned: all.filter((s) => pinned.has(s.unit)).length,
    running: all.filter((s) => s.active === "active").length,
    failed: all.filter((s) => s.active === "failed").length,
    all: all.length,
  };
  const setFilter = (f) => { S.serviceFilter = f; lsSet("helm-svc-filter", f); renderServices(); };
  $("#service-pills").replaceChildren(
    pill("Pinned", counts.pinned, S.serviceFilter === "pinned", () => setFilter("pinned")),
    pill("Running", counts.running, S.serviceFilter === "running", () => setFilter("running"), "dot-ok"),
    pill("Failed", counts.failed, S.serviceFilter === "failed", () => setFilter("failed"), counts.failed ? "dot-failed" : ""),
    pill("All", counts.all, S.serviceFilter === "all", () => setFilter("all")));
  $("#services-sub").replaceChildren(`${server.name} · ${counts.all} services · ${counts.running} running`,
    counts.failed ? h("span", { style: "color:var(--danger)" }, ` · ${counts.failed} failed`) : "");

  const query = $("#service-search").value.trim().toLowerCase();
  let list = all;
  if (S.serviceFilter === "pinned") list = list.filter((s) => pinned.has(s.unit));
  if (S.serviceFilter === "running") list = list.filter((s) => s.active === "active");
  if (S.serviceFilter === "failed") list = list.filter((s) => s.active === "failed");
  if (query) list = list.filter((s) => s.unit.toLowerCase().includes(query) || s.description.toLowerCase().includes(query));
  list = [...list].sort((a, b) => (pinned.has(b.unit) - pinned.has(a.unit)) || a.unit.localeCompare(b.unit));

  if (!list.length) {
    root.replaceChildren(S.serviceFilter === "pinned" && !query
      ? emptyState("pin", "No pinned services", `Switch to All and pin the services you manage most on ${server.name}.`,
        h("button", { class: "btn btn-secondary btn-sm", onclick: () => setFilter("all") }, icon("list"), "Show all"))
      : emptyState("search", "No matching services"));
    return;
  }

  const rows = list.map((s) => {
    const st = svcState(s);
    const active = s.active === "active";
    const isPinned = pinned.has(s.unit);
    const short = s.unit.replace(/\.service$/, "");
    return h("div", { class: `svc glow-sm ${st.glow}` },
      h("button", { class: `btn btn-ghost btn-icon btn-sm svc-pin ${isPinned ? "on" : ""}`, title: isPinned ? "Unpin" : "Pin",
        "aria-label": `${isPinned ? "Unpin" : "Pin"} ${short}`, "aria-pressed": String(isPinned),
        onclick: () => togglePin(s.unit, !isPinned) }, icon("pin")),
      h("span", { class: `svc-icon ${st.icon}` }, icon("server")),
      h("div", { class: "svc-main" },
        h("div", { class: "svc-name" }, h("span", { class: `dot ${st.dot}` }), short),
        h("div", { class: "svc-desc", title: s.description }, s.description || "—")),
      h("div", { class: "svc-state" },
        h("span", { class: `badge ${st.badge}` }, s.sub && s.sub !== s.active ? `${s.active} · ${s.sub}` : s.active),
        s.enabled && h("span", { class: "badge" }, s.enabled)),
      h("div", { class: "svc-actions" },
        active
          ? h("button", { class: "btn btn-secondary btn-sm", title: "Restart", onclick: () => serviceAction(s, "restart") }, icon("rotate-cw"), h("span", { class: "label-text" }, "Restart"))
          : h("button", { class: "btn btn-success btn-sm", title: "Start", onclick: () => serviceAction(s, "start") }, icon("play"), h("span", { class: "label-text" }, "Start")),
        active && h("button", { class: "btn btn-danger btn-sm", title: "Stop", onclick: () => serviceAction(s, "stop") }, icon("square"), h("span", { class: "label-text" }, "Stop")),
        serviceMenu(s)));
  });
  root.replaceChildren(h("div", { class: "svc-list" }, rows),
    h("p", { class: "svc-count" }, `Showing ${list.length} of ${all.length}`));
}

function serviceMenu(s) {
  const pop = h("div", { class: "menu-pop", hidden: true, role: "menu" });
  const item = (label, action, ic, danger) => h("button", { role: "menuitem", class: danger ? "danger" : "",
    onclick: () => { pop.hidden = true; serviceAction(s, action); } }, icon(ic), label);
  pop.append(
    item("Status", "status", "activity"),
    item("Logs (last 200 lines)", "logs", "file-text"),
    item("Reload config", "reload", "refresh-cw"),
    s.enabled === "enabled" ? item("Disable at boot", "disable", "toggle-left", true) : item("Enable at boot", "enable", "toggle-right"));
  const btn = h("button", { class: "btn btn-ghost btn-icon btn-sm", "aria-label": "More actions", "aria-haspopup": "menu", onclick: (e) => {
    e.stopPropagation();
    $$(".menu-pop").forEach((p) => p !== pop && (p.hidden = true));
    pop.hidden = !pop.hidden;
  } }, icon("ellipsis"));
  return h("div", { class: "menu" }, btn, pop);
}
document.addEventListener("click", () => $$(".menu-pop").forEach((p) => (p.hidden = true)));

async function togglePin(unit, pinned) {
  try {
    S.services.pinned = (await api("POST", "services/pin", { server: S.server, unit, pinned })).pinned;
    renderServices();
  } catch (e) { toast(e.message, "error"); }
}

async function serviceAction(s, action) {
  const server = current();
  if (action === "stop" || action === "disable") {
    const ok = await confirmDialog({
      title: `${action === "stop" ? "Stop" : "Disable"} ${s.unit} on ${server.name}?`,
      message: action === "stop" ? "The service will stay stopped until it’s started again." : "It won’t start automatically at boot.",
      confirmLabel: action === "stop" ? "Stop" : "Disable", confirmIcon: action === "stop" ? "square" : "toggle-left", danger: true,
    });
    if (!ok) return;
  }
  try {
    const job = await api("POST", `services/${encodeURIComponent(server.id)}/${encodeURIComponent(s.unit)}/${action}`);
    trackJob(job, () => { if (S.view === "services") loadServices(); });
    if (action === "status" || action === "logs") openDrawer(job);
    else toast(`${action} ${s.unit} on ${server.name}…`, "", { label: "Output", fn: () => openDrawer(job) });
  } catch (e) { toast(e.message, "error"); }
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
function renderFiles() {
  const s = current();
  if (!S.files || S.files.server !== s.id) {
    S.files = { server: s.id, dir: lsGet(`helm-files-${s.id}`) || "", roots: [], file: null, editor: null };
  }
  $("#files-sub").textContent = `Browse and edit files on ${s.name}, inside the folders its agent allows.`;
  if (!S.files.file) $("#files-viewer").replaceChildren(emptyState("file", "No file open", "Pick a file on the left. Config files, scripts and logs are highlighted."));
  loadDir(S.files.dir);
  S.guard = () => S.files && S.files.file && S.files.editor && S.files.file.content !== S.files.editor.value;
}

async function loadDir(path) {
  const s = current();
  const list = $("#files-list");
  list.replaceChildren(emptyState("loader", "Loading…"));
  let res;
  try {
    res = await api("GET", `files?${q({ server: s.id, path })}`);
  } catch (e) {
    if (path) { lsSet(`helm-files-${s.id}`, ""); return loadDir(""); }
    list.replaceChildren(emptyState(s.online ? "lock" : "wifi-off", "Can’t browse files", e.message));
    $("#files-crumbs").replaceChildren();
    return;
  }
  if (s.id !== S.server) return;
  if (res.roots) S.files.roots = res.entries.map((r) => r.path);
  S.files.dir = res.path;
  lsSet(`helm-files-${s.id}`, res.path);
  renderCrumbs(res.path);
  const rows = [];
  if (res.path) {
    const root = S.files.roots.find((r) => res.path === r);
    const parent = root ? "" : res.path.replace(/\/[^/]+$/, "") || "/";
    rows.push(h("button", { class: "file-row", onclick: () => loadDir(parent) }, icon("arrow-left"), h("span", { class: "file-name" }, root ? "All folders" : ".."), h("span"), h("span")));
  }
  if (!res.entries.length) rows.push(h("div", { class: "file-empty" }, res.roots ? "No allowed folders exist on this server." : "Empty folder"));
  for (const e of res.entries) {
    const open = S.files.file && S.files.file.path === e.path;
    rows.push(h("button", { class: `file-row ${open ? "active" : ""} ${e.type}`, title: e.path,
      onclick: () => (e.type === "dir" ? loadDir(e.path) : openFile(e.path)) },
      icon(e.type === "dir" ? "folder" : "file"),
      h("span", { class: "file-name" }, res.roots ? e.name : e.name, e.link ? h("span", { class: "file-link" }, " ↪") : ""),
      h("span", { class: "file-size" }, e.size != null ? fmtBytes(e.size) : ""),
      h("span", { class: "file-time" }, e.mtime ? fmtAgo(e.mtime) : "")));
  }
  if (res.truncated) rows.push(h("div", { class: "file-empty" }, "Showing the first 5000 entries."));
  list.replaceChildren(...rows);
}

function renderCrumbs(path) {
  const crumbs = [h("button", { class: "crumb", onclick: () => loadDir("") }, icon("folder"), "Allowed folders")];
  if (path) {
    const root = S.files.roots.filter((r) => path === r || path.startsWith(r.replace(/\/$/, "") + "/")).sort((a, b) => b.length - a.length)[0] || "/";
    crumbs.push(icon("chevron-right"), h("button", { class: "crumb", onclick: () => loadDir(root) }, root));
    let acc = root.replace(/\/$/, "");
    for (const seg of path.slice(acc.length).split("/").filter(Boolean)) {
      acc += "/" + seg;
      const target = acc;
      crumbs.push(icon("chevron-right"), h("button", { class: "crumb", onclick: () => loadDir(target) }, seg));
    }
  }
  $("#files-crumbs").replaceChildren(...crumbs);
}

async function openFile(path) {
  if (S.guard && S.guard()) {
    const ok = await confirmDialog({ title: "Discard unsaved changes?", message: `${S.files.file.path} has edits that haven’t been saved.`,
      confirmLabel: "Discard", confirmIcon: "trash", danger: true });
    if (!ok) return;
  }
  const s = current();
  const viewer = $("#files-viewer");
  viewer.replaceChildren(emptyState("loader", "Opening…"));
  let f;
  try {
    f = await api("GET", `files?${q({ server: s.id, path, read: 1 })}`);
  } catch (e) {
    viewer.replaceChildren(emptyState("circle-alert", "Can’t open file", e.message));
    return;
  }
  S.files.file = f;
  $$("#files-list .file-row").forEach((r) => r.classList.toggle("active", r.title === f.path));
  if (f.binary) {
    S.files.editor = null;
    viewer.replaceChildren(fileFrame(f, null, emptyState("file", "Binary file", `${fmtBytes(f.size)} · not shown`)));
    return;
  }
  const lang = detectLang(f.path, f.content);
  const editable = f.writable && S.session.allow_editing;
  const editor = new CodeEditor({ value: f.content, lang, readOnly: !editable,
    onChange: () => updateFileDirty(), onSave: () => editable && saveFile() });
  S.files.editor = editor;
  viewer.replaceChildren(fileFrame(f, editor, null, lang, editable));
  if (lang === "log" || f.truncated) requestAnimationFrame(() => { editor.ta.scrollTop = editor.ta.scrollHeight; });
}

function fileFrame(f, editor, body, lang, editable) {
  const reasons = [];
  if (f.truncated) reasons.push(`showing the last ${fmtBytes(2 * 1024 * 1024)}`);
  if (!f.utf8) reasons.push("not UTF-8");
  if (!f.binary && !f.writable && !f.truncated && f.utf8) reasons.push("read-only");
  if (f.writable && !S.session.allow_editing) reasons.push("hub is locked");
  const actions = [];
  if (editor && (lang === "bash" || lang === "python") && S.session.allow_editing) {
    actions.push(h("button", { class: "btn btn-secondary btn-sm", title: "Create an action from this file", onclick: () =>
      openEditor({ name: f.path.split("/").pop(), body: editor.value, interpreter: lang === "python" ? "python3" : "bash", icon: "file-text" }, { fromConsole: true }) },
    icon("zap"), "Make action"));
  }
  actions.push(h("button", { class: "btn btn-secondary btn-sm", title: "Reload from disk", onclick: () => openFile(f.path) }, icon("refresh-cw"), "Reload"));
  if (editable) actions.push(h("button", { class: "btn btn-primary btn-sm", id: "file-save", onclick: saveFile }, icon("save"), "Save"));
  return h("div", { class: "term-frame code-frame file-frame" },
    h("div", { class: "term-chrome" },
      icon(f.binary ? "file" : "file-text"),
      h("span", { class: "term-title", title: f.path }, f.path, h("span", { id: "file-dirty" })),
      lang && h("span", { class: "chip" }, lang),
      h("span", { class: "chip" }, fmtBytes(f.size)),
      ...reasons.map((r) => h("span", { class: "chip chip-warn" }, icon("lock"), r)),
      ...actions),
    editor ? h("div", { class: "code-host" }, editor.el) : body);
}

function updateFileDirty() {
  const dirty = S.guard && S.guard();
  const el = $("#file-dirty");
  if (el) el.replaceChildren(dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes" }) : "");
}

async function saveFile() {
  const s = current();
  const f = S.files.file;
  const content = S.files.editor.value;
  const btn = $("#file-save");
  if (btn) btn.disabled = true;
  try {
    const res = await api("POST", `files?${q({ server: s.id })}`, { path: f.path, content, mtime: f.mtime });
    f.mtime = res.mtime;
    f.content = content;
    updateFileDirty();
    toast(`Saved ${f.path.split("/").pop()} on ${s.name}`, "ok", res.diff ? { label: "Diff", fn: () => diffDialog(f.path, res) } : null);
    loadJobs();
  } catch (e) {
    toast(e.message, "error", /changed on disk/.test(e.message) ? { label: "Reload", fn: () => { f.content = S.files.editor.value; openFile(f.path); } } : null);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function diffDialog(path, res) {
  const pre = h("pre", { class: "code-hl diff-view" });
  pre.innerHTML = highlight(res.diff, "diff");
  return modal({
    title: `Changes to ${path.split("/").pop()}`,
    body: [pre, res.backup && h("p", { class: "hint-text" }, `Previous version backed up on the server at ${res.backup}`)],
    buttons: [{ label: "Close", primary: true, submit: true }],
  });
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------
let consoleEditor = null;
let consoleJob = null;
let consoleStop = null;

function renderConsole() {
  const s = current();
  if (!consoleEditor) {
    consoleEditor = new CodeEditor({ value: lsGet("helm-console") || "", lang: "bash", placeholder: "systemctl status nginx",
      onChange: (v) => lsSet("helm-console", v), onRun: runConsole });
    $("#console-code").replaceChildren(consoleEditor.el);
    $("#console-interp").onchange = () => consoleEditor.setLang($("#console-interp").value);
  }
  $("#console-sub").textContent = `Runs on ${s.name}${s.online ? "" : " (offline)"}. Keep what works by saving it as an action.`;
  consoleEditor.focus();
}

$("#console-run").addEventListener("click", runConsole);
$("#console-save").addEventListener("click", () => {
  const body = consoleEditor.value.trim() ? consoleEditor.value : consoleJob?.meta?.body || "";
  if (!body.trim()) return toast("Write a command first", "error");
  openEditor({ body, interpreter: $("#console-interp").value, icon: "terminal", color: "blue" }, { fromConsole: true });
});
$("#console-kill").addEventListener("click", () => consoleJob && api("POST", `jobs/${consoleJob.id}/kill`).catch(() => {}));

async function runConsole() {
  const body = consoleEditor.value;
  if (!body.trim()) return;
  const s = current();
  try {
    const job = await api("POST", "console", { server: s.id, body, interpreter: $("#console-interp").value });
    consoleJob = job;
    trackJob(job);
    const out = $("#console-out");
    out.hidden = false;
    $("#console-term").textContent = "";
    $("#console-title").textContent = `${job.title} · ${s.name}`;
    if (consoleStop) consoleStop();
    consoleStop = streamJob(job, $("#console-term"), (j) => {
      out.className = glowFor(j, "term-frame console-out glow-inset");
      setBadge($("#console-status"), j);
      $("#console-kill").hidden = j.status !== "running";
      $("#console-time").textContent = j.finished ? fmtDuration(j.finished - j.started) : "";
    });
  } catch (e) { toast(e.message, "error"); }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------
$("#history-search").addEventListener("input", renderHistory);

function sourceIcon(j) {
  if (j.source === "service") return "server";
  if (j.source === "console") return "terminal";
  if (j.source === "editor") return "pencil";
  if (j.source === "file") return "file-text";
  const a = j.meta?.action_id && S.library.find((x) => x.id === j.meta.action_id);
  return a ? a.icon : "zap";
}

function renderHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const list = S.jobs.filter((j) => !query || [j.title, j.user, j.server_name].some((x) => (x || "").toLowerCase().includes(query)));
  const root = $("#history-list");
  if (!list.length) {
    root.replaceChildren(h("div", { style: "padding:1rem" }, emptyState(query ? "search" : "history", query ? "No matches" : "Nothing has run yet")));
    return;
  }
  root.replaceChildren(...list.map((j) => h("button", { class: "list-row", onclick: () => openDrawer(j) },
    badge(j),
    h("div", { style: "min-width:0" },
      h("div", { class: "list-title" }, j.title),
      h("div", { class: "list-sub" }, [j.server_name, j.user, j.finished && j.source !== "file" && fmtDuration(j.finished - j.started)].filter(Boolean).join(" · "))),
    h("span", { class: "badge src" }, icon(sourceIcon(j)), j.source),
    h("span", { class: "list-time", title: new Date(j.started * 1000).toLocaleString() }, fmtAgo(j.started)))));
}

// ---------------------------------------------------------------------------
// jobs: tracking + streaming
// ---------------------------------------------------------------------------
function trackJob(job, onDone) {
  S.running.set(job.id, job);
  renderSideRuns();
  const poll = async () => {
    try {
      const j = await api("GET", `jobs/${job.id}?offset=999999999`);
      if (j.status === "running") return setTimeout(poll, 1000);
      S.running.delete(job.id);
      await loadJobs();
      if (S.view === "actions") renderActions();
      if (S.view === "history") renderHistory();
      if (S.drawer) renderRunTabs();
      if (onDone) onDone(j);
      const watching = S.drawer?.jobs.some((x) => x.id === job.id) || consoleJob?.id === job.id || S.edit?.job?.id === job.id;
      if (!watching) {
        toast(`${j.title} on ${j.server_name} — ${STATUS[j.status].label.toLowerCase()}`, j.status === "success" ? "ok" : "error",
          { label: "Output", fn: () => openDrawer(j) });
      }
    } catch (e) { S.running.delete(job.id); renderSideRuns(); }
  };
  setTimeout(poll, 800);
  if (S.view === "actions") renderActions();
}

/** Stream a job's output into `term`. Returns a cancel function. */
function streamJob(job, term, onUpdate) {
  let offset = 0;
  let cancelled = false;
  let timer = null;
  const tick = async () => {
    if (cancelled) return;
    let j;
    try { j = await api("GET", `jobs/${job.id}?offset=${offset}`); } catch (e) {
      term.append(`\n[${e.message}]\n`);
      return;
    }
    if (cancelled) return;
    if (j.output) {
      const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
      term.append(j.output);
      if (atBottom) term.scrollTop = term.scrollHeight;
    }
    offset = j.offset;
    onUpdate(j);
    if (j.status === "running") timer = setTimeout(tick, 400);
    else if (!term.textContent) term.textContent = "(no output)";
    else if (j.source === "file") term.innerHTML = highlight(term.textContent, "diff");
  };
  tick();
  return () => { cancelled = true; clearTimeout(timer); };
}

// ---------------------------------------------------------------------------
// run drawer (one tab per server)
// ---------------------------------------------------------------------------
let drawerStop = null;
const drawer = $("#run-drawer");

function openDrawer(jobOrJobs) {
  let jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
  if (jobs.length === 1 && jobs[0].run_id) {
    const seen = new Set();
    const siblings = [...S.running.values(), ...S.jobs].filter((j) => j.run_id === jobs[0].run_id && !seen.has(j.id) && seen.add(j.id));
    if (siblings.length > 1) jobs = siblings;
  }
  const first = Array.isArray(jobOrJobs) ? (jobs.find((j) => j.status === "failed") || jobs[0]) : jobOrJobs;
  S.drawer = { jobs, active: first.id };
  $("#drawer-backdrop").hidden = false;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  showDrawerJob(first);
}

function jobState(id) {
  return S.running.get(id) || S.jobs.find((j) => j.id === id) || S.drawer.jobs.find((j) => j.id === id);
}

function renderRunTabs() {
  const tabs = $("#run-tabs");
  if (!S.drawer || S.drawer.jobs.length < 2) { tabs.hidden = true; return; }
  tabs.hidden = false;
  const jobs = S.drawer.jobs.map((j) => jobState(j.id) || j);
  const done = jobs.filter((j) => j.status !== "running").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  tabs.replaceChildren(
    h("span", { class: "run-summary" }, `${done}/${jobs.length} done`, failed ? h("span", { style: "color:var(--danger)" }, ` · ${failed} failed`) : ""),
    ...jobs.map((j) => {
      const st = statusOf(j);
      return h("button", { role: "tab", class: `run-tab ${j.id === S.drawer.active ? "active" : ""}`, "aria-selected": String(j.id === S.drawer.active),
        onclick: () => { S.drawer.active = j.id; showDrawerJob(j); } },
        h("span", { class: `dot ${st ? st.dot : ""}` }), j.server_name);
    }));
}

function showDrawerJob(job) {
  if (drawerStop) drawerStop();
  const action = job.meta?.action_id && S.library.find((a) => a.id === job.meta.action_id);
  const look = action || (job.source === "service" ? { icon: "server", color: "green" }
    : job.source === "file" ? { icon: "file-text", color: "teal" } : { icon: "terminal", color: "gray" });
  $("#run-icon").replaceWith(Object.assign(tileIcon(look, true), { id: "run-icon" }));
  $("#run-title").textContent = job.title;
  $("#run-sub").textContent = "";
  $("#run-term").textContent = "";
  renderRunTabs();
  drawerStop = streamJob(job, $("#run-term"), (j) => {
    $("#run-frame").className = glowFor(j, "term-frame term-fill glow-inset");
    setBadge($("#run-status"), j);
    $("#run-kill").hidden = j.status !== "running";
    $("#run-rerun").hidden = j.status === "running" || !action;
    $("#run-rerun").onclick = () => action && runAction(action);
    const bits = [j.server_name, new Date(j.started * 1000).toLocaleString(), j.user];
    if (j.finished && j.source !== "file") bits.push(fmtDuration(j.finished - j.started));
    if (j.meta?.params && Object.keys(j.meta.params).length) {
      bits.push(Object.entries(j.meta.params).map(([k, v]) => `${k}=${v}`).join(" "));
    }
    $("#run-sub").textContent = bits.filter(Boolean).join(" · ");
    const known = S.drawer?.jobs.find((x) => x.id === j.id);
    if (known && known.status !== j.status) { Object.assign(known, { status: j.status, exit_code: j.exit_code }); renderRunTabs(); }
  });
}

function closeDrawer() {
  if (drawerStop) drawerStop();
  drawerStop = null;
  S.drawer = null;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  $("#drawer-backdrop").hidden = true;
}
$("#run-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
$("#run-kill").addEventListener("click", () => S.drawer && api("POST", `jobs/${S.drawer.active}/kill`).catch((e) => toast(e.message, "error")));

// ---------------------------------------------------------------------------
// modal
// ---------------------------------------------------------------------------
let modalResolve = null;

function modal({ title, body, buttons, onSubmit, size }) {
  const root = $("#modal");
  const form = $("#modal-form");
  $(".modal", root).classList.toggle("modal-sm", size === "sm");
  $("#modal-title").textContent = title;
  const errorEl = h("p", { class: "form-error", hidden: true });
  $("#modal-body").replaceChildren(...body.filter(Boolean), errorEl);

  return new Promise((resolve) => {
    if (modalResolve) modalResolve(null);
    const done = (v) => { root.hidden = true; modalResolve = null; resolve(v); };
    modalResolve = done;

    $("#modal-foot").replaceChildren(...buttons.filter(Boolean).map((b) => {
      const cls = b.primary ? "btn-primary" : b.danger === "outline" ? "btn-danger-outline" : b.danger ? "btn-danger" : "btn-secondary";
      return h("button", { type: b.submit ? "submit" : "button", class: `btn ${cls}`, onclick: b.submit ? null : () => done(b.value) },
        b.icon && icon(b.icon), b.label);
    }));

    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = $("button[type=submit]", form);
      submit.disabled = true;
      errorEl.hidden = true;
      try {
        const v = onSubmit ? await onSubmit(form) : true;
        if (v !== "keep-open") done(v);
      } catch (ex) {
        errorEl.textContent = ex.message;
        errorEl.hidden = false;
      } finally {
        submit.disabled = false;
      }
    };
    root.hidden = false;
    const first = $("input:not([type=checkbox]):not([type=hidden]), textarea", $("#modal-body"));
    (first || $("button[type=submit]", form))?.focus();
  });
}

function confirmDialog({ title, message, code, confirmLabel = "Confirm", confirmIcon, danger = false }) {
  return modal({
    title, size: "sm",
    body: [h("p", { class: "confirm-desc" }, message), code && h("div", { class: "confirm-cmd" }, code)],
    buttons: [{ label: "Cancel", value: false }, { label: confirmLabel, icon: confirmIcon, primary: !danger, danger, submit: true }],
    onSubmit: () => true,
  });
}

$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal" || e.target.closest("[data-close]")) modalResolve && modalResolve(null);
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("#modal").hidden) {
    if (S.view === "edit") { e.preventDefault(); saveEdit(); }
    else if (S.view === "files" && $("#file-save")) { e.preventDefault(); saveFile(); }
    return;
  }
  if (e.key !== "Escape") return;
  if (!$("#modal").hidden) modalResolve && modalResolve(null);
  else if (drawer.classList.contains("open")) closeDrawer();
  else setSidebar(false);
});

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
function drawThemeToggle() {
  const dark = document.documentElement.dataset.theme !== "light";
  $("#theme-toggle").replaceChildren(icon(dark ? "sun" : "moon"));
}
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  lsSet("helm-theme", next);
  drawThemeToggle();
});
drawThemeToggle();

boot();
