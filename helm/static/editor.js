"use strict";
// Code editor for Helm: a <textarea> over a syntax-highlighted <pre>, with line numbers.
// Small regex tokenizers for bash/sh, python, config files, JSON, logs and diffs. No dependencies.

const HL_LIMIT = 400 * 1024; // larger buffers are shown plain

const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function tokenize(text, rules) {
  let out = "";
  let plain = "";
  let i = 0;
  const n = text.length;
  outer: while (i < n) {
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m[0].length) {
        if (plain) { out += escHtml(plain); plain = ""; }
        const c = typeof cls === "function" ? cls(m[0]) : cls;
        out += c ? `<span class="tk-${c}">${escHtml(m[0])}</span>` : escHtml(m[0]);
        i += m[0].length;
        continue outer;
      }
    }
    plain += text[i++];
  }
  return out + escHtml(plain);
}

const words = (s) => new Set(s.split(" "));
const SH_KW = words("if then else elif fi for while until do done case esac in function select return break continue local export readonly declare typeset unset shift exit time");
const SH_BUILTIN = words("echo printf cd pwd read source eval exec set trap test true false wait kill sleep cat grep sed awk cut sort uniq head tail find xargs tee tr wc ls cp mv rm mkdir rmdir chmod chown ln touch systemctl journalctl sudo curl wget tar gzip ssh scp rsync git docker apt apt-get yum dnf apk pip python3 bash sh df du free ps ss netstat ip ping service mount umount date env");
const PY_KW = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case");
const PY_BUILTIN = words("print len range open str int float bool list dict set tuple type isinstance enumerate zip map filter sorted sum min max abs any all repr super self cls input format getattr setattr hasattr object Exception ValueError KeyError OSError");
const CONSTS = words("true false null none yes no on off True False None");

const LANGS = {
  bash: [
    [/(?<=^|[\s;|&(])#.*/my, "com"],
    [/"(?:[^"\\]|\\[\s\S])*"?/y, "str"],
    [/'[^']*'?/y, "str"],
    [/\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?$!*-])/y, "var"],
    [/\$\(\(?|\)\)?|`/y, "op"],
    [/(?<=[\s=])--?[A-Za-z][\w-]*/y, "opt"],
    [/\b\d+\b/y, "num"],
    [/[A-Za-z_][\w.-]*(?=\s*\(\s*\))/y, "fn"],
    [/[A-Za-z_][\w.-]*/y, (w) => (SH_KW.has(w) ? "kw" : SH_BUILTIN.has(w) ? "fn" : "")],
    [/&&|\|\||;;|[|&;<>]+/y, "op"],
  ],
  python: [
    [/#.*/y, "com"],
    [/[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/y, "str"],
    [/@[\w.]+/y, "fn"],
    [/\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y, "num"],
    [/(?<=\b(?:def|class)\s+)[A-Za-z_]\w*/y, "fn"],
    [/[A-Za-z_]\w*/y, (w) => (PY_KW.has(w) ? "kw" : CONSTS.has(w) ? "con" : PY_BUILTIN.has(w) ? "fn" : "")],
  ],
  conf: [
    [/(?<=^|\s)[#;].*/my, "com"],
    [/^[ \t]*\[[^\]\n]+\]/my, "sec"],
    [/^[ \t-]*[A-Za-z_@][\w.\-/@]*(?=[ \t]*[=:]|[ \t]+\S)/my, "key"],
    [/"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?/y, "str"],
    [/\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*)/y, "var"],
    [/\b\d+(?:\.\d+)*[a-zA-Z%]{0,2}\b/y, "num"],
    [/[A-Za-z_]\w*/y, (w) => (CONSTS.has(w) || CONSTS.has(w.toLowerCase()) ? "con" : "")],
  ],
  json: [
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, "key"],
    [/"(?:[^"\\]|\\.)*"?/y, "str"],
    [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, "num"],
    [/\b(?:true|false|null)\b/y, "con"],
  ],
  log: [
    [/^(?:\d{4}-\d\d-\d\d[T ][\d:.,]+(?:Z|[+-]\d\d:?\d\d)?|[A-Z][a-z]{2} [ \d]\d [\d:]{8})/my, "meta"],
    [/\b(?:ERROR|ERR|FATAL|CRIT(?:ICAL)?|FAIL(?:ED|URE)?|PANIC|EMERG|ALERT)\b/iy, "err"],
    [/\b(?:WARN(?:ING)?)\b/iy, "warn"],
    [/\b(?:INFO|NOTICE)\b/y, "info"],
    [/\b(?:DEBUG|TRACE)\b/y, "com"],
    [/\b\d{1,3}(?:\.\d{1,3}){3}\b/y, "num"],
  ],
  diff: [
    [/^(?:\+\+\+|---).*$/my, "meta"],
    [/^@@.*$/my, "sec"],
    [/^\+.*$/my, "add"],
    [/^-.*$/my, "del"],
  ],
  plain: [],
};
LANGS.sh = LANGS.bash;
LANGS.python3 = LANGS.python;

function highlight(text, lang) {
  const rules = LANGS[lang] || [];
  if (!rules.length || text.length > HL_LIMIT) return escHtml(text);
  return tokenize(text, rules);
}

/** Guess a language from a file path and its first line. */
function detectLang(path, text) {
  const name = (path || "").split("/").pop().toLowerCase();
  const first = (text || "").slice(0, 120).split("\n")[0];
  if (first.startsWith("#!")) {
    if (/python/.test(first)) return "python";
    if (/\b(ba|z|da)?sh\b/.test(first)) return "bash";
  }
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (["sh", "bash", "zsh", "bashrc", "profile", "env"].includes(ext) || ["dockerfile", ".bashrc", ".profile"].includes(name)) return "bash";
  if (ext === "py") return "python";
  if (ext === "json") return "json";
  if (["diff", "patch"].includes(ext)) return "diff";
  if (ext === "log" || /^\/var\/log\//.test(path || "") || /\.log\.\d+$/.test(name)) return "log";
  if (["conf", "cfg", "ini", "toml", "yml", "yaml", "service", "timer", "socket", "properties", "cnf", "rules", "list", "network", "netdev"].includes(ext)) return "conf";
  if (/^\/etc\//.test(path || "")) return "conf";
  return "plain";
}

class CodeEditor {
  constructor({ value = "", lang = "bash", readOnly = false, placeholder = "", onChange, onSave, onRun } = {}) {
    this.lang = lang;
    this.onChange = onChange;
    this.onSave = onSave;
    this.onRun = onRun;
    this.el = document.createElement("div");
    this.el.className = "code";
    this.gutter = document.createElement("div");
    this.gutter.className = "code-gutter";
    this.gutterInner = document.createElement("pre");
    this.gutter.append(this.gutterInner);
    const area = document.createElement("div");
    area.className = "code-area";
    this.hl = document.createElement("pre");
    this.hl.className = "code-hl";
    this.hl.setAttribute("aria-hidden", "true");
    this.ta = document.createElement("textarea");
    this.ta.className = "code-ta";
    this.ta.spellcheck = false;
    this.ta.setAttribute("wrap", "off");
    this.ta.setAttribute("autocapitalize", "off");
    this.ta.setAttribute("autocomplete", "off");
    this.ta.setAttribute("aria-label", "Code");
    this.ta.placeholder = placeholder;
    area.append(this.hl, this.ta);
    this.el.append(this.gutter, area);
    this.ta.value = value;
    this.ta.setSelectionRange(0, 0);
    this.setReadOnly(readOnly);
    this._pending = null;
    this.ta.addEventListener("input", () => { this._schedule(); this.onChange && this.onChange(this.value); });
    this.ta.addEventListener("scroll", () => this._sync());
    this.ta.addEventListener("keydown", (e) => this._keys(e));
    this.render();
  }

  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.ta.setSelectionRange(0, 0); this.render(); this.ta.scrollTop = 0; this._sync(); }

  setLang(lang) { this.lang = lang; this.render(); }
  setReadOnly(ro) { this.readOnly = ro; this.ta.readOnly = ro; this.el.classList.toggle("readonly", ro); }
  focus() { this.ta.focus({ preventScroll: true }); }

  render() {
    const v = this.ta.value;
    // A trailing newline needs a visible line so the overlay height matches the textarea's.
    this.hl.innerHTML = highlight(v, this.lang) + (v.endsWith("\n") || !v ? " " : "");
    const lines = v.split("\n").length;
    if (lines !== this._lines) {
      this._lines = lines;
      let s = "";
      for (let i = 1; i <= lines; i++) s += i + "\n";
      this.gutterInner.textContent = s;
    }
    this._sync();
  }

  cursor() {
    const before = this.ta.value.slice(0, this.ta.selectionStart);
    const line = before.split("\n").length;
    return { line, col: before.length - before.lastIndexOf("\n") };
  }

  _schedule() {
    if (this._pending) return;
    const delay = this.ta.value.length > 100000 ? 120 : 0;
    this._pending = setTimeout(() => requestAnimationFrame(() => { this._pending = null; this.render(); }), delay);
  }

  _sync() {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    this.gutterInner.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  _insert(text) {
    // execCommand keeps the browser's undo stack intact; fall back to setRangeText.
    if (!document.execCommand || !document.execCommand("insertText", false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, "end");
      this.ta.dispatchEvent(new Event("input"));
    }
  }

  _indentUnit() { return /^\t/m.test(this.ta.value) ? "\t" : "  "; }

  _keys(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); this.onSave && this.onSave(); return; }
    if (mod && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this.onRun && this.onRun(); return; }
    if (this.readOnly) return;
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      const unit = this._indentUnit();
      const { selectionStart: a, selectionEnd: b, value } = this.ta;
      if (a === b && !e.shiftKey) return this._insert(unit);
      // indent / outdent every selected line
      const start = value.lastIndexOf("\n", a - 1) + 1;
      const block = value.slice(start, b);
      const changed = e.shiftKey
        ? block.replace(/^(\t| {1,2})/gm, "")
        : block.replace(/^/gm, unit);
      this.ta.setSelectionRange(start, b);
      this._insert(changed);
      this.ta.setSelectionRange(start, start + changed.length);
      return;
    }
    if (e.key === "Enter" && !mod && !e.shiftKey) {
      const unit = this._indentUnit();
      let { selectionStart: a, value } = this.ta;
      const start = value.lastIndexOf("\n", a - 1) + 1;
      let line = value.slice(start, a);
      e.preventDefault();
      // a line that closes a block (done, fi, }, else…) steps back out one level
      if (/^[ \t]+(done|fi|esac|[})\]]|else\b|elif\b|except\b|finally\b)/.test(line) && line.startsWith(unit)) {
        this.ta.setSelectionRange(start, start + unit.length);
        if (!document.execCommand || !document.execCommand("delete")) this.ta.setRangeText("", start, start + unit.length, "start");
        a -= unit.length;
        line = line.slice(unit.length);
        this.ta.setSelectionRange(a, a);
      }
      let indent = line.match(/^[ \t]*/)[0];
      if (/(\bthen|\bdo|\{|:|\(|\belse|\bin)\s*$/.test(line) && !/^\s*#/.test(line)) indent += unit;
      this._insert("\n" + indent);
    }
  }
}
