#!/usr/bin/env python3
"""helm-agent: does the work on a server managed by a Helm hub.

It dials OUT to the hub over HTTPS (long-poll), so the server needs no open port.
The agent's own policy (agent.json) is a hard ceiling on what the hub may ask for:
a hub cannot run scripts, touch services or edit files that this server's policy forbids.

Usage:
  python3 agent.py --enroll https://helm.example.com <TOKEN> [--name web-1] [--tags web,prod]
  python3 agent.py                      # run (normally under systemd as helm-agent.service)

The hub imports this file too: its built-in local agent uses the same Executor.
Standard library only.
"""

import argparse
import codecs
import difflib
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.2.0"

INTERPRETERS = {"bash": "bash", "sh": "sh", "python3": "python3"}
SERVICE_ACTIONS = {"start", "stop", "restart", "reload", "enable", "disable", "status", "logs"}
UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._:\\-]*\.service$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")
MAX_JOB_OUTPUT = 2 * 1024 * 1024
MAX_FILE_VIEW = 2 * 1024 * 1024
MAX_DIR_ENTRIES = 5000
BACKUPS_KEEP = 10

DEFAULT_POLICY = {
    # Run scripts sent by the hub (saved actions and the console). false = services/files only.
    "allow_scripts": True,
    "allow_services": True,
    "allow_files": True,
    "allow_file_writes": True,
    # Folders the hub may browse/edit (symlinks are resolved before checking).
    "file_roots": ["/etc", "/opt", "/srv", "/var/log"],
    # Prefix systemctl/journalctl with `sudo -n` when the agent isn't root.
    "use_sudo": False,
    "job_timeout_seconds": 3600,
    # Let the hub repoint this agent to another hub address (e.g. a new IP). The agent checks
    # that the new address answers with this same agent key before it switches.
    "allow_hub_change": True,
}


class PolicyError(Exception):
    """The request is valid but this server's policy forbids it."""


def now():
    return time.time()


def atomic_write_json(path, data, mode=0o600):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------

class Proc:
    """One running command. Output and completion are reported through callbacks."""

    def __init__(self, argv, *, on_output, on_finish, env=None, timeout=None, cleanup=None):
        self.argv = argv
        self.env = env
        self.timeout = timeout
        self.cleanup = cleanup
        self.on_output = on_output
        self.on_finish = on_finish
        self.proc = None
        self.killed = False
        self.done = False
        self.sent = 0

    def start(self):
        try:
            self.proc = subprocess.Popen(
                self.argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                env=self.env, start_new_session=True, cwd=os.path.expanduser("~"),
            )
        except OSError as e:
            self._emit(f"Failed to start: {e}\n")
            self._finish(127)
            return
        threading.Thread(target=self._pump, daemon=True).start()
        if self.timeout:
            t = threading.Timer(self.timeout, self._on_timeout)
            t.daemon = True
            t.start()

    def _emit(self, text):
        if not text or self.sent > MAX_JOB_OUTPUT:
            return
        self.sent += len(text)
        if self.sent > MAX_JOB_OUTPUT:
            text = text[: len(text) - (self.sent - MAX_JOB_OUTPUT)] + "\n[output truncated]\n"
        self.on_output(text)

    def _pump(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        fd = self.proc.stdout.fileno()
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            self._emit(ANSI_RE.sub("", decoder.decode(chunk)))
        self._emit(decoder.decode(b"", final=True))
        self._finish(self.proc.wait())

    def _finish(self, code):
        self.done = True
        if self.cleanup:
            try:
                self.cleanup()
            except OSError:
                pass
        status = "killed" if self.killed else ("success" if code == 0 else "failed")
        self.on_finish(code, status)

    def _on_timeout(self):
        if not self.done:
            self._emit(f"\n[timed out after {self.timeout}s]\n")
            self.kill()

    def kill(self):
        if not self.proc or self.done:
            return False
        self.killed = True
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return False

        def force():
            if not self.done:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        threading.Timer(5, force).start()
        return True


# ---------------------------------------------------------------------------
# System info & services
# ---------------------------------------------------------------------------

_cpu_sample = {"t": None}


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def system_info():
    info = {"hostname": socket.gethostname(), "agent_version": VERSION}
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            info["os"] = line.split("=", 1)[1].strip('"')
    up = _read("/proc/uptime").split()
    info["uptime"] = float(up[0]) if up else None
    try:
        info["load"] = list(os.getloadavg())
    except OSError:
        info["load"] = None
    info["cpus"] = os.cpu_count()
    mem = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) * 1024 if v.strip() else 0
    if mem:
        info["mem_total"] = mem.get("MemTotal", 0)
        info["mem_used"] = mem.get("MemTotal", 0) - mem.get("MemAvailable", mem.get("MemFree", 0))
    try:
        st = os.statvfs("/")
        info["disk_total"] = st.f_blocks * st.f_frsize
        info["disk_used"] = (st.f_blocks - st.f_bfree) * st.f_frsize
    except OSError:
        pass
    stat = _read("/proc/stat").splitlines()
    if stat and stat[0].startswith("cpu "):
        vals = [int(x) for x in stat[0].split()[1:]]
        idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)
        prev = _cpu_sample["t"]
        _cpu_sample["t"] = (idle, total)
        if prev and total > prev[1]:
            info["cpu"] = round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)
    return info


def list_services():
    if not shutil.which("systemctl") or not Path("/run/systemd/system").exists():
        return {"available": False, "services": []}
    units = {}
    try:
        out = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"],
            capture_output=True, text=True, timeout=15).stdout
        for line in out.splitlines():
            parts = line.replace("●", "").split(None, 4)
            if len(parts) >= 4 and parts[0].endswith(".service"):
                units[parts[0]] = {"unit": parts[0], "load": parts[1], "active": parts[2], "sub": parts[3],
                                   "description": parts[4] if len(parts) > 4 else "", "enabled": None}
        out = subprocess.run(
            ["systemctl", "list-unit-files", "--type=service", "--no-pager", "--plain", "--no-legend"],
            capture_output=True, text=True, timeout=15).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].endswith(".service") and not parts[0].endswith("@.service"):
                u = units.setdefault(parts[0], {"unit": parts[0], "load": "loaded", "active": "inactive",
                                                "sub": "dead", "description": "", "enabled": None})
                u["enabled"] = parts[1]
    except (subprocess.SubprocessError, OSError) as e:
        return {"available": False, "error": str(e), "services": []}
    return {"available": True, "services": sorted(units.values(), key=lambda u: u["unit"].lower())}


# ---------------------------------------------------------------------------
# Executor: everything the hub can ask this server to do, gated by policy
# ---------------------------------------------------------------------------

class Executor:
    def __init__(self, policy, work_dir):
        self.policy = dict(DEFAULT_POLICY, **(policy or {}))
        self.work_dir = Path(work_dir)
        self.tmp_dir = self.work_dir / "tmp"
        self.backup_dir = self.work_dir / "backups"
        for d in (self.work_dir, self.tmp_dir, self.backup_dir):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)
        self.procs = {}
        self.lock = threading.Lock()

    def public_policy(self):
        return dict(self.policy)

    # -- jobs -----------------------------------------------------------------
    def start_job(self, job_id, spec, on_output, on_finish):
        """Validate `spec` against policy and start it. Errors are reported as a failed job."""
        def finish(code, status):
            with self.lock:
                self.procs.pop(job_id, None)
            on_finish(code, status)

        try:
            argv, env, timeout, cleanup = self._build(spec)
        except (PolicyError, ValueError) as e:
            on_output(f"Refused by {socket.gethostname()}: {e}\n")
            on_finish(126, "failed")
            return
        proc = Proc(argv, on_output=on_output, on_finish=finish, env=env, timeout=timeout, cleanup=cleanup)
        with self.lock:
            self.procs[job_id] = proc
        proc.start()

    def _build(self, spec):
        kind = spec.get("kind")
        limit = self.policy["job_timeout_seconds"]
        if kind == "script":
            if not self.policy["allow_scripts"]:
                raise PolicyError("this server does not allow running scripts")
            interp = spec.get("interpreter", "bash")
            if interp not in INTERPRETERS:
                raise ValueError(f"unsupported interpreter {interp!r}")
            exe = shutil.which(INTERPRETERS[interp])
            if not exe:
                raise ValueError(f"{interp} is not installed")
            path = self.tmp_dir / f"{secrets.token_hex(8)}.script"
            body = str(spec.get("body", ""))
            with open(path, "w") as f:
                f.write(body if body.endswith("\n") else body + "\n")
            os.chmod(path, 0o700)
            env = dict(os.environ)
            for k, v in (spec.get("env") or {}).items():
                if ENV_RE.match(k):
                    env[k] = str(v)
            env["HELM"] = "1"
            positional = [str(a) for a in spec.get("args") or []]
            timeout = min(int(spec.get("timeout") or limit), limit)
            return [exe, str(path), *positional], env, timeout, lambda: path.unlink(missing_ok=True)
        if kind == "service":
            if not self.policy["allow_services"]:
                raise PolicyError("this server does not allow service control")
            unit, action = spec.get("unit", ""), spec.get("action", "")
            if not UNIT_RE.match(unit):
                raise ValueError("invalid unit name")
            if action not in SERVICE_ACTIONS:
                raise ValueError("unsupported service action")
            if action == "logs":
                argv = ["journalctl", "-u", unit, "-n", "200", "--no-pager"]
            elif action == "status":
                argv = ["systemctl", "status", unit, "--no-pager", "-l"]
            else:
                argv = ["systemctl", action, unit]
            if self.policy["use_sudo"]:
                argv = ["sudo", "-n", *argv]
            return argv, None, 120, None
        raise ValueError(f"unknown job kind {kind!r}")

    def kill(self, job_id):
        with self.lock:
            proc = self.procs.get(job_id)
        return proc.kill() if proc else False

    def running(self):
        with self.lock:
            return list(self.procs)

    def kill_all(self):
        with self.lock:
            procs = list(self.procs.values())
        for p in procs:
            p.kill()

    # -- requests (synchronous) -----------------------------------------------
    def handle(self, kind, payload):
        if kind == "system":
            return system_info()
        if kind == "services":
            if not self.policy["allow_services"]:
                raise PolicyError("this server does not allow service control")
            return list_services()
        if kind == "files.list":
            return self.files_list(payload.get("path") or "")
        if kind == "files.read":
            return self.files_read(payload.get("path", ""))
        if kind == "files.write":
            return self.files_write(payload.get("path", ""), payload.get("content", ""), payload.get("mtime"))
        if kind == "check":
            return self.check_syntax(payload.get("interpreter", "bash"), payload.get("body", ""))
        raise ValueError(f"unknown request {kind!r}")

    # -- files ----------------------------------------------------------------
    def _roots(self):
        return [os.path.realpath(r) for r in self.policy["file_roots"]]

    def _resolve(self, path):
        if not self.policy["allow_files"]:
            raise PolicyError("this server does not allow file access")
        if not isinstance(path, str) or not path.startswith("/"):
            raise ValueError("path must be absolute")
        real = os.path.realpath(path)
        for root in self._roots():
            if real == root or real.startswith(root.rstrip("/") + "/"):
                return real
        raise PolicyError("outside the folders this server allows (file_roots)")

    def files_list(self, path):
        if not path:
            roots = []
            for r in self.policy["file_roots"]:
                real = os.path.realpath(r)
                if os.path.isdir(real):
                    roots.append({"name": r, "path": real, "type": "dir"})
            return {"path": "", "roots": True, "entries": roots,
                    "writable": self.policy["allow_file_writes"]}
        real = self._resolve(path)
        if not os.path.isdir(real):
            raise ValueError("not a directory")
        entries = []
        with os.scandir(real) as it:
            for e in it:
                if len(entries) >= MAX_DIR_ENTRIES:
                    break
                try:
                    st = e.stat(follow_symlinks=True)
                    is_dir = e.is_dir(follow_symlinks=True)
                except OSError:
                    st, is_dir = None, False
                entries.append({
                    "name": e.name, "path": os.path.join(real, e.name),
                    "type": "dir" if is_dir else "file", "link": e.is_symlink(),
                    "size": st.st_size if st and not is_dir else None,
                    "mtime": st.st_mtime if st else None,
                })
        entries.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
        return {"path": real, "entries": entries, "truncated": len(entries) >= MAX_DIR_ENTRIES}

    def files_read(self, path):
        real = self._resolve(path)
        if os.path.isdir(real):
            raise ValueError("that is a directory")
        st = os.stat(real)
        with open(real, "rb") as f:
            if st.st_size > MAX_FILE_VIEW:
                f.seek(st.st_size - MAX_FILE_VIEW)
            raw = f.read(MAX_FILE_VIEW)
        result = {"path": real, "size": st.st_size, "mtime": str(st.st_mtime_ns),
                  "truncated": st.st_size > MAX_FILE_VIEW, "binary": False, "utf8": True}
        if b"\0" in raw[:8192]:
            result.update(binary=True, content="", writable=False)
            return result
        try:
            result["content"] = raw.decode("utf-8")
        except UnicodeDecodeError:
            result["content"] = raw.decode("utf-8", "replace")
            result["utf8"] = False
        result["writable"] = (self.policy["allow_file_writes"] and os.access(real, os.W_OK)
                              and not result["truncated"] and result["utf8"])
        return result

    def files_write(self, path, content, mtime):
        real = self._resolve(path)
        if not self.policy["allow_file_writes"]:
            raise PolicyError("this server does not allow editing files")
        if not os.path.isfile(real):
            raise ValueError("file does not exist")
        st = os.stat(real)
        if st.st_size > MAX_FILE_VIEW:
            raise ValueError("file is too large to edit here")
        if str(st.st_mtime_ns) != str(mtime):
            raise ValueError("the file changed on disk since you opened it; reload and try again")
        with open(real, "rb") as f:
            old = f.read().decode("utf-8")
        # Backups live in the agent's own folder, never beside the file: a stray copy in a
        # directory like sites-enabled/ or cron.d/ would be picked up as live config.
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safe = real.strip("/").replace("/", "__")
        backup = self.backup_dir / f"{safe}.{stamp}"
        shutil.copy2(real, backup)
        os.chmod(backup, 0o600)
        olds = sorted(self.backup_dir.glob(f"{safe}.*"))
        for b in olds[:-BACKUPS_KEEP]:
            b.unlink(missing_ok=True)
        # Write in place so owner, mode, hard links and SELinux labels are kept.
        with open(real, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        diff = "".join(difflib.unified_diff(
            old.splitlines(keepends=True), content.splitlines(keepends=True),
            fromfile=f"a{real}", tofile=f"b{real}"))
        return {"path": real, "mtime": str(os.stat(real).st_mtime_ns), "backup": str(backup), "diff": diff}

    # -- syntax check -----------------------------------------------------------
    def check_syntax(self, interpreter, body):
        if not self.policy["allow_scripts"]:
            raise PolicyError("this server does not allow running scripts")
        if interpreter not in INTERPRETERS:
            raise ValueError("unsupported interpreter")
        path = self.tmp_dir / f"{secrets.token_hex(8)}.check"
        path.write_text(body if body.endswith("\n") else body + "\n")
        try:
            results = []
            if interpreter == "python3":
                argv = [sys.executable, "-c",
                        "import ast,sys; ast.parse(open(sys.argv[1]).read(), 'script')", str(path)]
            else:
                argv = [INTERPRETERS[interpreter], "-n", str(path)]
            r = subprocess.run(argv, capture_output=True, text=True, timeout=15)
            out = (r.stdout + r.stderr).replace(str(path), "script")
            results.append({"tool": f"{interpreter} syntax", "ok": r.returncode == 0, "output": out.strip()})
            if interpreter in ("bash", "sh") and shutil.which("shellcheck"):
                r = subprocess.run(["shellcheck", "-f", "gcc", "-s", interpreter, str(path)],
                                   capture_output=True, text=True, timeout=30)
                out = r.stdout.replace(str(path), "script")
                results.append({"tool": "shellcheck", "ok": r.returncode == 0, "output": out.strip()})
            return {"ok": all(x["ok"] for x in results), "results": results}
        finally:
            path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# The daemon: enroll once, then long-poll the hub
# ---------------------------------------------------------------------------

class HubClient:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ctx = ssl.create_default_context(cafile=cfg.get("ca_file") or None)

    def post(self, path, body, timeout=40, auth=True, base=None):
        data = json.dumps(body).encode()
        req = urllib.request.Request((base or self.cfg["hub_url"]).rstrip("/") + path, data=data, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": f"helm-agent/{VERSION}"})
        if auth:
            req.add_header("Authorization", f"Bearer {self.cfg['agent_id']}.{self.cfg['agent_key']}")
        with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
            return json.loads(r.read() or b"{}")


class Agent:
    def __init__(self, cfg_path):
        self.cfg_path = Path(cfg_path)
        with open(self.cfg_path) as f:
            self.cfg = json.load(f)
        self.executor = Executor(self.cfg.get("policy"), self.cfg.get("work_dir", "/var/lib/helm-agent"))
        self.client = HubClient(self.cfg)
        self.outbox = {"outputs": [], "replies": []}
        self.out_lock = threading.Lock()
        self.out_event = threading.Event()

    # outputs are batched and pushed by one thread so a chatty job doesn't mean one request per line
    def _queue(self, key, item):
        with self.out_lock:
            self.outbox[key].append(item)
        self.out_event.set()

    def _pusher(self):
        while True:
            self.out_event.wait()
            time.sleep(0.2)
            with self.out_lock:
                batch, self.outbox = self.outbox, {"outputs": [], "replies": []}
                self.out_event.clear()
            for attempt in range(5):
                try:
                    self.client.post("/agent/push", batch, timeout=30)
                    break
                except (urllib.error.URLError, OSError, ValueError) as e:
                    log(f"push failed ({e}); retrying")
                    time.sleep(min(2 ** attempt, 15))

    def _handle(self, msg):
        t = msg.get("type")
        if t == "job":
            jid = msg["job_id"]
            self.executor.start_job(
                jid, msg.get("spec") or {},
                on_output=lambda text: self._queue("outputs", {"job_id": jid, "chunk": text}),
                on_finish=lambda code, status: self._queue(
                    "outputs", {"job_id": jid, "done": True, "exit_code": code, "status": status}))
        elif t == "kill":
            self.executor.kill(msg.get("job_id"))
        elif t == "req":
            def work():
                try:
                    if msg.get("kind") == "set_hub":
                        data = self.set_hub((msg.get("payload") or {}).get("url"))
                    else:
                        data = self.executor.handle(msg.get("kind"), msg.get("payload") or {})
                    reply = {"req_id": msg["req_id"], "ok": True, "data": data}
                except (PolicyError, ValueError, OSError) as e:
                    reply = {"req_id": msg["req_id"], "ok": False, "error": str(e)}
                self._queue("replies", reply)
            threading.Thread(target=work, daemon=True).start()

    def set_hub(self, url):
        """Switch to another address for the same hub, asked for by the hub itself."""
        if not self.executor.policy.get("allow_hub_change", True):
            raise PolicyError("this server does not allow changing its hub address remotely")
        url = check_hub_url(url, self.cfg.get("insecure_http"))
        verify_hub(self.client, self.cfg, url)
        old = self.cfg["hub_url"]
        self.cfg["hub_url"] = url
        atomic_write_json(self.cfg_path, self.cfg)
        log(f"hub address changed: {old} -> {url}")
        return {"hub_url": url, "previous": old}

    def _shutdown(self, signum, _frame):
        # Jobs run in their own process groups (so Stop can kill a whole tree); take them down with us.
        log(f"signal {signum}: stopping {len(self.executor.running())} running job(s)")
        self.executor.kill_all()
        sys.exit(0)

    def run(self):
        signal.signal(signal.SIGTERM, self._shutdown)
        signal.signal(signal.SIGINT, self._shutdown)
        threading.Thread(target=self._pusher, daemon=True).start()
        log(f"helm-agent {VERSION} connecting to {self.cfg['hub_url']} as {self.cfg.get('name')}")
        backoff, connected = 1, False
        while True:
            try:
                resp = self.client.post("/agent/poll", {
                    "version": VERSION, "system": system_info(), "hub_url": self.cfg["hub_url"],
                    "policy": self.executor.public_policy(), "running": self.executor.running(),
                }, timeout=45)
                if not connected:
                    log("connected")
                    connected = True
                backoff = 1
                for msg in resp.get("messages", []):
                    self._handle(msg)
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    log("hub rejected this agent's key (revoked?). Re-enroll with --enroll.")
                    time.sleep(60)
                else:
                    log(f"hub error {e.code}; retrying in {backoff}s")
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                connected = False
            except (urllib.error.URLError, OSError, ValueError) as e:
                if connected or backoff == 1:
                    log(f"hub unreachable ({e}); retrying")
                connected = False
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


LAN_SUFFIXES = (".lan", ".local", ".home", ".internal", ".home.arpa", ".localdomain")


def is_lan_host(host):
    """True for addresses that stay on a private network: RFC 1918/ULA/link-local IPs,
    single-label hostnames and common LAN suffixes."""
    host = host.strip("[]").lower()
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return "." not in host or host.endswith(LAN_SUFFIXES)


def check_hub_url(url, insecure_http=False):
    """Normalize a hub URL; plain http is only allowed to private/LAN addresses unless insecure_http."""
    url = str(url or "").strip().rstrip("/")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"not a hub URL: {url!r} (expected http(s)://host[:port])")
    if parts.scheme == "http" and not insecure_http and not is_lan_host(parts.hostname):
        raise ValueError("refusing plain http to a public address: the agent key would travel unencrypted. "
                         "Use the hub's https:// URL, its LAN address, or --insecure-http if you really mean it.")
    return url


def verify_hub(client, cfg, url):
    """Make sure `url` reaches the same hub: it must accept this agent's key."""
    try:
        resp = client.post("/agent/ping", {}, timeout=15, base=url)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise ValueError(f"{url} does not know this agent's key (a different hub?)")
        if e.code == 404:
            raise ValueError(f"{url} has no /agent/ping (not a Helm hub, or one older than 1.2)")
        raise ValueError(f"{url} answered {e.code} (is that the Helm hub's address?)")
    except (urllib.error.URLError, OSError) as e:
        raise ValueError(f"cannot reach {url}: {getattr(e, 'reason', e)}")
    if resp.get("agent_id") != cfg.get("agent_id"):
        raise ValueError(f"{url} answered as a different hub")


def set_hub_cli(cfg_path, url, insecure_http, ca_file, no_check):
    """agent.py --set-hub: repoint an enrolled agent from the server itself (e.g. the hub moved)."""
    cfg_path = Path(cfg_path)
    if not cfg_path.exists():
        sys.exit(f"No config at {cfg_path}. Enroll first: agent.py --enroll <hub-url> <token>")
    with open(cfg_path) as f:
        cfg = json.load(f)
    if insecure_http:
        cfg["insecure_http"] = True
    if ca_file:
        cfg["ca_file"] = ca_file
    try:
        url = check_hub_url(url, cfg.get("insecure_http"))
    except ValueError as e:
        sys.exit(f"Not changed: {e}")
    if not no_check:
        try:
            verify_hub(HubClient(cfg), cfg, url)
        except ValueError as e:
            sys.exit(f"Not changed: {e}\nUse --no-check to save it anyway (e.g. the hub isn't up yet).")
    old = cfg.get("hub_url")
    cfg["hub_url"] = url
    atomic_write_json(cfg_path, cfg)
    print(f"Hub address: {old} -> {url}")
    if shutil.which("systemctl") and subprocess.run(["systemctl", "is-active", "--quiet", "helm-agent"]).returncode == 0:
        subprocess.run(["systemctl", "restart", "helm-agent"], check=False)
        print("Restarted helm-agent.")
    else:
        print("Restart the agent to use it: systemctl restart helm-agent")


def enroll(cfg_path, hub_url, token, name, tags, insecure_http, ca_file):
    try:
        hub_url = check_hub_url(hub_url, insecure_http)
    except ValueError as e:
        sys.exit(f"Refusing to enroll: {e}")
    if hub_url.startswith("http://"):
        log(f"Using plain http to {urllib.parse.urlsplit(hub_url).hostname}. Traffic is unencrypted on your network.")
    cfg_path = Path(cfg_path)
    cfg = {}
    if cfg_path.exists():
        with open(cfg_path) as f:
            cfg = json.load(f)
    cfg.update(hub_url=hub_url.rstrip("/"), name=name or socket.gethostname())
    if ca_file:
        cfg["ca_file"] = ca_file
    if insecure_http:
        cfg["insecure_http"] = True
    cfg.setdefault("work_dir", "/var/lib/helm-agent")
    cfg.setdefault("policy", dict(DEFAULT_POLICY))
    client = HubClient(cfg)
    try:
        resp = client.post("/agent/enroll", {
            "token": token, "name": cfg["name"], "tags": tags, "hostname": socket.gethostname(),
            "version": VERSION, "policy": cfg["policy"],
        }, auth=False)
    except urllib.error.HTTPError as e:
        sys.exit(f"Enrollment failed: {e.code} {e.read().decode(errors='replace')}")
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"Cannot reach hub at {hub_url}: {e}")
    cfg.update(agent_id=resp["agent_id"], agent_key=resp["agent_key"], name=resp.get("name") or cfg["name"])
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(cfg_path.parent, 0o700)
    atomic_write_json(cfg_path, cfg)
    print(f"Enrolled as '{cfg['name']}' ({resp['agent_id']}). Config: {cfg_path}")


def main():
    ap = argparse.ArgumentParser(description="helm-agent: managed-server daemon for a Helm hub")
    ap.add_argument("-c", "--config", default="/etc/helm-agent/agent.json")
    ap.add_argument("--enroll", nargs=2, metavar=("HUB_URL", "TOKEN"), help="register with a hub and exit")
    ap.add_argument("--name", help="display name (default: hostname)")
    ap.add_argument("--tags", default="", help="comma-separated tags, e.g. web,prod")
    ap.add_argument("--ca-file", help="CA bundle for a hub with a private certificate")
    ap.add_argument("--set-hub", metavar="HUB_URL", help="change the hub address of an enrolled agent and exit")
    ap.add_argument("--no-check", action="store_true", help="with --set-hub: save without testing the new address")
    ap.add_argument("--insecure-http", action="store_true", help="allow plain http to a public address")
    args = ap.parse_args()
    if args.set_hub:
        set_hub_cli(args.config, args.set_hub, args.insecure_http, args.ca_file, args.no_check)
        return
    if args.enroll:
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        enroll(args.config, args.enroll[0], args.enroll[1], args.name, tags, args.insecure_http, args.ca_file)
        return
    if not Path(args.config).exists():
        sys.exit(f"No config at {args.config}. Enroll first: agent.py --enroll <hub-url> <token>")
    Agent(args.config).run()


if __name__ == "__main__":
    main()
