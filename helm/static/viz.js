/* Helm "pretty" output: turns common command output into meters, cards and tables.
 *   df            -> one meter per mount (used of size, free)
 *   free          -> stacked RAM bar (used / cache / free) + swap
 *   uptime, top   -> load cards (scaled to the server's CPU count), CPU and memory bars
 *   ps, ss, ...   -> sortable-looking table, % columns get inline bars
 *   ::metric      -> your own gauges:  ::metric Label: value[/max] [unit] [warn=N] [crit=N]
 * Viz.render(text, {cpus}) returns an element, or null when nothing is recognized
 * (the UI then offers only the raw view). */
const Viz = (() => {
  const el = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids.flat()) if (k != null && k !== false && k !== "") e.append(k);
    return e;
  };

  // -- numbers ---------------------------------------------------------------
  const POW = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  /** "15Gi" / "20G" / "512M" / "0B" / "1234" -> number (unitless values are multiplied by `base`). */
  function parseSize(s, base = 1) {
    const m = /^(-?[\d.]+)\s*([KMGTPE]?)(i?B?)$/i.exec(String(s).trim().replace(",", "."));
    if (!m) return NaN;
    const unit = m[2].toUpperCase();
    return parseFloat(m[1]) * (unit ? 1024 ** POW[unit] : m[3] ? 1 : base);
  }
  function fmtBytes(n) {
    if (!isFinite(n)) return "—";
    const u = ["B", "K", "M", "G", "T", "P"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
  }
  const isNum = (s) => /^-?[\d.,]+\s*(%|[KMGTPE]i?B?|[KMGTPE])?$/i.test(String(s).trim()) && /\d/.test(s);
  const clamp = (p) => Math.max(0, Math.min(100, p || 0));
  const level = (p) => (p >= 90 ? "crit" : p >= 75 ? "warn" : "");

  // -- building blocks -------------------------------------------------------
  /** A bar. segs: [{p, cls?, title?}] for stacked; or a single percentage. */
  function bar(segs, lvl) {
    if (typeof segs === "number") segs = [{ p: segs }];
    return el("div", `vz-bar ${lvl ?? level(segs.reduce((a, s) => a + (s.cls ? 0 : s.p), 0))}`,
      segs.map((s) => Object.assign(el("i", s.cls || ""), { style: `width:${clamp(s.p)}%`, title: s.title || "" })));
  }
  function row(label, sub, right, barEl) {
    return el("div", "vz-row",
      el("div", "vz-row-top", el("span", "vz-label", label), sub && el("span", "vz-sub", sub), el("span", "vz-val", right)),
      barEl);
  }
  function card(label, value, foot, p, lvl) {
    return el("div", `vz-card ${p != null ? lvl ?? level(p) : ""}`,
      el("div", "vz-card-label", label), el("div", "vz-card-value", value),
      p != null && bar(p, lvl), foot && el("div", "vz-card-foot", foot));
  }
  const section = (title, ...kids) => el("section", "vz-section", title && el("h4", "vz-title", title), ...kids);
  const legend = (...items) => el("div", "vz-legend", items.filter(Boolean).map(([cls, text]) => el("span", "", el("i", cls), text)));

  // -- ::metric lines --------------------------------------------------------
  const METRIC_RE = /^::metric\s+(.+?):\s*(-?[\d.]+)\s*(?:\/\s*([\d.]+))?\s*(.*)$/;
  /** Colors are opt-in: warn=/crit= in the metric's own units. crit below warn means "low is bad". */
  function metricLevel(v, warn, crit) {
    if (warn == null && crit == null) return "";
    const lowBad = warn != null && crit != null && crit < warn;
    const past = (t) => t != null && (lowBad ? v <= t : v >= t);
    return past(crit) ? "crit" : past(warn) ? "warn" : "";
  }
  function metrics(lines) {
    const cards = lines.map((l) => METRIC_RE.exec(l.trim())).filter(Boolean).map(([, label, v, max, tail]) => {
      const value = parseFloat(v);
      const opt = {};
      const unit = tail.replace(/\b(warn|crit)=(-?[\d.]+)/g, (_, k, n) => { opt[k] = parseFloat(n); return ""; }).trim();
      const p = max ? (100 * value) / parseFloat(max) : unit === "%" ? value : null;
      const shown = `${v}${unit === "%" ? "%" : unit ? " " + unit : ""}`;
      return card(label, shown, max ? `of ${max}${unit && unit !== "%" ? " " + unit : ""}` : "", p, metricLevel(value, opt.warn, opt.crit));
    });
    return cards.length ? section("", el("div", "vz-cards", cards)) : null;
  }

  // -- header helpers --------------------------------------------------------
  const MERGE = ["Mounted on", "Local Address:Port", "Peer Address:Port", "Local Address", "Foreign Address", "PID/Program name", "Peer Address"];
  function headerCols(line) {
    const t = line.trim().split(/\s+/);
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const two = `${t[i]} ${t[i + 1]}`;
      if (MERGE.includes(two)) { out.push(two); i++; } else out.push(t[i]);
    }
    return out;
  }
  /** Split a row into n columns; the last column keeps its spaces (COMMAND, Mounted on...). */
  function splitRow(line, n) {
    const f = line.trim().split(/\s+/);
    if (f.length <= n) return f;
    return [...f.slice(0, n - 1), f.slice(n - 1).join(" ")];
  }

  // -- df --------------------------------------------------------------------
  function df(lines) {
    if (!/^Filesystem\s/.test(lines[0]) || !/Mounted on\s*$/.test(lines[0])) return null;
    const cols = headerCols(lines[0]);
    const idx = (re) => cols.findIndex((c) => re.test(c));
    const iSize = idx(/^(Size|\d+[KM]?-blocks|Total)$/i), iUsed = idx(/^Used$/), iAvail = idx(/^Avail(able)?$/), iPct = idx(/^(Use%|Capacity)$/), iType = idx(/^Type$/);
    if (iSize < 0 || iUsed < 0 || iAvail < 0) return null;
    const blk = /^(\d+)([KM]?)-blocks$/i.exec(cols[iSize]);
    const base = blk ? parseInt(blk[1], 10) * (blk[2] ? 1024 ** POW[blk[2].toUpperCase()] : 1) : 1;
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i];
      if (line.trim().split(/\s+/).length === 1 && lines[i + 1]) line += " " + lines[++i]; // long device names wrap
      const f = splitRow(line, cols.length);
      if (f.length < cols.length) continue;
      const size = parseSize(f[iSize], base), used = parseSize(f[iUsed], base), avail = parseSize(f[iAvail], base);
      const p = iPct >= 0 && /\d/.test(f[iPct]) ? parseFloat(f[iPct]) : size ? (100 * used) / (used + avail) : null;
      const show = (raw, n) => (base > 1 ? fmtBytes(n) : raw);
      rows.push(row(f[f.length - 1], [f[0], iType >= 0 && f[iType]].filter(Boolean).join(" · "),
        p == null ? show(f[iSize], size) : `${Math.round(p)}% · ${show(f[iUsed], used)} of ${show(f[iSize], size)} · ${show(f[iAvail], avail)} free`,
        p == null ? null : bar(p)));
    }
    return rows.length ? section("Disk usage", el("div", "vz-rows", rows)) : null;
  }

  // -- free ------------------------------------------------------------------
  function free(lines) {
    const head = lines[0].trim().split(/\s+/);
    if (head[0] !== "total" || !head.includes("used") || !head.includes("free")) return null;
    const out = [];
    for (const line of lines.slice(1)) {
      const m = /^\s*(Mem|Swap|Low|High|Total):\s+(.*)$/.exec(line);
      if (!m) continue;
      const vals = m[2].trim().split(/\s+/);
      const raw = Object.fromEntries(head.map((k, i) => [k, vals[i]]).filter(([, v]) => v != null));
      const n = (k) => parseSize(raw[k] ?? "0");
      const total = n("total");
      if (!total) { out.push(row(m[1], "", "none", null)); continue; }
      if (m[1] === "Mem") {
        const cache = raw["buff/cache"] != null ? n("buff/cache") : n("buffers") + n("cached") || 0;
        const used = n("used");
        const pu = (100 * used) / total, pc = (100 * cache) / total;
        out.push(row("Memory", "", `${raw.used} used · ${raw.available ?? raw.free} available of ${raw.total}`,
          bar([{ p: pu, title: `used ${raw.used}` }, { p: pc, cls: "soft", title: `buff/cache ${raw["buff/cache"] ?? ""}` }], level(pu))));
        out.push(legend(["", `used ${raw.used}`], ["soft", `cache ${raw["buff/cache"] ?? fmtBytes(cache)}`], ["none", `free ${raw.free}`]));
      } else {
        const p = (100 * n("used")) / total;
        out.push(row(m[1], "", `${raw.used} of ${raw.total}`, bar(p)));
      }
    }
    return out.length ? section("Memory", el("div", "vz-rows", out)) : null;
  }

  // -- load (uptime, top's first line) ---------------------------------------
  const LOAD_RE = /load averages?:\s*([\d.,]+)[,\s]+([\d.,]+)[,\s]+([\d.,]+)/;
  function loadCards(line, ctx) {
    const m = LOAD_RE.exec(line);
    if (!m) return null;
    const cpus = ctx.cpus || 0;
    const up = /\bup\s+(.+?),\s+\d+\s+users?/.exec(line) || /\bup\s+(.+?),\s+load/.exec(line);
    const users = /(\d+)\s+users?/.exec(line);
    const loads = m.slice(1).map((v) => parseFloat(v.replace(",", ".")));
    return el("div", "vz-cards",
      ["1 min", "5 min", "15 min"].map((label, i) => card(`Load · ${label}`, loads[i].toFixed(2),
        cpus ? `${Math.round((100 * loads[i]) / cpus)}% of ${cpus} CPU${cpus > 1 ? "s" : ""}` : "", cpus ? (100 * loads[i]) / cpus : null)),
      up && card("Uptime", up[1].replace(/\s+/g, " ").trim(), users ? `${users[1]} user${users[1] === "1" ? "" : "s"} logged in` : ""));
  }
  function uptime(lines, ctx) {
    if (lines.length > 2 || !LOAD_RE.test(lines[0])) return null;
    return section("Load", loadCards(lines[0], ctx));
  }

  // -- top -b summary --------------------------------------------------------
  function top(lines, ctx) {
    const cpuLine = lines.find((l) => /^%?Cpu\(s\)/.test(l));
    if (!cpuLine || !/^top\s+-/.test(lines[0])) return null;
    const pairs = (l) => Object.fromEntries([...l.matchAll(/([\d.]+)[\s%]+([a-z/]+(?: Mem)?)/gi)].map((x) => [x[2].toLowerCase(), parseFloat(x[1])]));
    const kids = [loadCards(lines[0], ctx)];
    const c = pairs(cpuLine);
    const busy = 100 - (c.id ?? 100);
    kids.push(el("div", "vz-rows",
      row("CPU", "", `${busy.toFixed(1)}% busy`, bar([{ p: c.us || 0, title: `user ${c.us}%` }, { p: c.sy || 0, cls: "alt", title: `system ${c.sy}%` },
        { p: busy - (c.us || 0) - (c.sy || 0), cls: "soft", title: "other (nice, iowait, irq, steal)" }], level(busy))),
      legend(["", `user ${c.us ?? 0}%`], ["alt", `system ${c.sy ?? 0}%`], ["soft", `iowait ${c.wa ?? 0}%`], ["none", `idle ${c.id ?? 0}%`])));
    const unit = (l) => (/^(\w)iB/.exec(l) || [])[1] || "K";
    for (const l of lines) {
      const m = /^(\w)iB (Mem|Swap)\s*:/.exec(l);
      if (!m) continue;
      const v = pairs(l);
      const mul = 1024 ** POW[unit(l)];
      const total = v.total * mul, used = v.used * mul;
      if (!total) continue;
      if (m[2] === "Mem") {
        const cache = (v["buff/cache"] || 0) * mul;
        kids.push(el("div", "vz-rows", row("Memory", "", `${fmtBytes(used)} used of ${fmtBytes(total)}`,
          bar([{ p: (100 * used) / total }, { p: (100 * cache) / total, cls: "soft", title: `buff/cache ${fmtBytes(cache)}` }], level((100 * used) / total)))));
      } else {
        kids.push(el("div", "vz-rows", row("Swap", "", `${fmtBytes(used)} of ${fmtBytes(total)}`, bar((100 * used) / total))));
      }
    }
    const tasks = lines.find((l) => /^Tasks:/.test(l));
    if (tasks) kids.push(el("div", "vz-note", tasks.replace(/\s+/g, " ")));
    return section("System", ...kids);
  }

  // -- generic tables (ps, ss, netstat, lsblk, docker ps...) -----------------
  function table(lines) {
    if (lines.length < 2) return null;
    const cols = headerCols(lines[0]);
    if (cols.length < 2 || cols.some((c) => c.length > 24 || isNum(c)) || /[.!?]$/.test(lines[0].trim())) return null;
    const n = cols.length;
    const rows = lines.slice(1).map((l) => splitRow(l, n));
    const fit = rows.filter((r) => r.length >= n - 1).length;
    if (fit / rows.length < 0.8) return null;
    const numeric = cols.map((_, i) => rows.filter((r) => r[i] != null && isNum(r[i])).length >= 0.8 * rows.length);
    if (!numeric.some(Boolean)) return null;
    const pctCol = cols.map((c, i) => numeric[i] && /%/.test(c));
    const shown = rows.slice(0, 1000);
    const max = cols.map((_, i) => (pctCol[i] ? Math.max(100, ...shown.map((r) => parseFloat(r[i]) || 0)) : 0));
    const t = el("table", "vz-table",
      el("thead", "", el("tr", "", cols.map((c, i) => el("th", numeric[i] ? "num" : "", c)))),
      el("tbody", "", shown.map((r) => el("tr", "", cols.map((_, i) => {
        const v = r[i] ?? "";
        if (pctCol[i] && isNum(v)) {
          const p = (100 * parseFloat(v)) / max[i];
          return el("td", "num pct", el("span", "", v), bar(p, level(parseFloat(v))));
        }
        const td = el("td", numeric[i] ? "num" : i === n - 1 ? "wide" : "", v);
        if (v.length > 40) td.title = v;
        return td;
      })))));
    return section("", el("div", "vz-table-wrap", t),
      rows.length > shown.length && el("div", "vz-note", `Showing ${shown.length} of ${rows.length} rows. Switch to Raw for all.`));
  }

  const DETECTORS = [df, free, top, uptime, table];

  function block(lines, ctx) {
    // Allow up to two lead-in lines (e.g. "== Disks ==") before a recognizable table.
    for (let k = 0; k <= Math.min(2, lines.length - 2); k++) {
      for (const d of DETECTORS) {
        const hit = d(lines.slice(k), ctx);
        if (hit) return [k ? el("div", "vz-heading", lines.slice(0, k).join("\n")) : null, hit];
      }
    }
    if (lines.length === 1 && LOAD_RE.test(lines[0])) return [uptime(lines, ctx)];
    return null;
  }

  function render(text, ctx = {}) {
    if (!text || text.length > 400000) return null;
    const all = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").split("\n");
    const metricLines = all.filter((l) => l.trim().startsWith("::metric "));
    const rest = all.filter((l) => !l.trim().startsWith("::metric "));
    const parts = [];
    let found = false;
    const m = metrics(metricLines);
    if (m) { parts.push(m); found = true; }
    const blocks = [];
    let cur = [];
    for (const l of rest) {
      if (l.trim()) cur.push(l);
      else if (cur.length) { blocks.push(cur); cur = []; }
    }
    if (cur.length) blocks.push(cur);
    for (const b of blocks) {
      const hit = block(b, ctx);
      if (hit) { found = true; parts.push(...hit.filter(Boolean)); }
      else parts.push(el("pre", "vz-raw", b.join("\n")));
    }
    return found ? el("div", "vz-body", parts) : null;
  }

  return { render, parseSize };
})();
