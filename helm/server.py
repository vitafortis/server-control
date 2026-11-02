#!/usr/bin/env python3
"""Helm hub: the web control plane for one or many servers.

The hub serves the UI, keeps the action library, history, logins and the server registry.
Work happens on agents (agent.py): one built into the hub for the machine it runs on, plus
any number of remote servers whose agents dial out to the hub.

Usage:
  python3 server.py                       # run with ./config.json (created on first start)
  python3 server.py --set-password admin  # add/update a user (enables login)
  python3 server.py --remove-user admin   # remove a user (no users = no login)
"""

import argparse
import getpass
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import agent as core

VERSION = core.VERSION
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DEPLOY_DIR = APP_DIR.parent / "deploy"

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8780,
    "data_dir": "data",
    # username -> pbkdf2 hash. Empty = no login required.
    "users": {},
    "session_hours": 12,
    # Set true when serving over HTTPS (e.g. behind a reverse proxy).
    "secure_cookies": False,
    # false = "locked" mode: saved actions and service controls only; no console, editor or file edits.
    "allow_editing": True,
    # The URL agents use to reach this hub (shown in install commands). Blank = taken from the request.
    "public_url": "",
    # Optional second listener that serves ONLY the agent endpoints (/agent/*), e.g. "0.0.0.0:8781"
    # so LAN agents can connect over plain http while the UI stays on localhost behind your proxy.
    "agent_listen": "",
    # The URL agents should use, shown in install commands, e.g. "http://192.168.1.10:8781".
    # Blank = public_url, else taken from the browser's request.
    "agent_url": "",
    # The hub manages the machine it runs on through a built-in agent.
    "local_agent": {"enabled": True, "name": "", "tags": [], "policy": {}},
    "job_timeout_seconds": 3600,
    # Refuse to listen on a non-loopback address without a login unless this is true.
    "allow_insecure_remote": False,
}

ICON_RE = re.compile(r"^[a-z0-9-]{1,32}$")
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,31}$")
COLORS = {"blue", "green", "amber", "red", "violet", "teal", "pink", "gray"}
MAX_BODY = 4 * 1024 * 1024
MAX_JOB_OUTPUT = core.MAX_JOB_OUTPUT
HISTORY_OUTPUT = 64 * 1024
HISTORY_KEEP = 500
POLL_HOLD = 25          # seconds an agent's long-poll is held open
OFFLINE_AFTER = 60      # no poll for this long = offline
TOKEN_TTL = 3600

SEED_ACTIONS = [
    {"name": "Disk usage", "group": "Diagnostics", "description": "Free space on mounted filesystems",
     "icon": "hard-drive", "color": "blue",
     "interpreter": "bash", "body": "df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h"},
    {"name": "Memory", "group": "Diagnostics", "description": "RAM and swap usage",
     "icon": "memory", "color": "violet", "interpreter": "bash", "body": "free -h"},
    {"name": "Top processes", "group": "Diagnostics", "description": "Busiest processes by CPU",
     "icon": "cpu", "color": "teal", "interpreter": "bash", "body": "ps aux --sort=-%cpu | head -n 15"},
    {"name": "Listening ports", "group": "Diagnostics", "description": "Open TCP/UDP sockets",
     "icon": "network", "color": "amber", "interpreter": "bash", "body": "ss -tulpn 2>/dev/null || netstat -tulpn"},
    {"name": "Failed services", "group": "Diagnostics", "description": "systemd units in a failed state",
     "icon": "circle-alert", "color": "red", "interpreter": "bash", "body": "systemctl --failed --no-pager"},
    {"name": "Tail syslog", "group": "Logs", "description": "Last N lines of the system journal",
     "icon": "file-text", "color": "gray", "interpreter": "bash", "params": ["LINES"],
     "body": "journalctl -n \"${LINES:-100}\" --no-pager 2>/dev/null || tail -n \"${LINES:-100}\" /var/log/syslog"},
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now():
    return time.time()


atomic_write_json = core.atomic_write_json


def sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()


def hash_password(password, iterations=600_000):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        algo, iterations, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(calc.hex(), digest)
    except (ValueError, AttributeError):
        return False


def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def clean_tags(raw):
    if isinstance(raw, str):
        raw = raw.split(",")
    tags = []
    for t in raw or []:
        t = str(t).strip().lower()
        if not t:
            continue
        if not TAG_RE.match(t):
            raise ValueError(f"Invalid tag {t!r}: lowercase letters, digits, - _ .")
        if t not in tags:
            tags.append(t)
    return tags


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Config & storage
# ---------------------------------------------------------------------------

class Config:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.data = json.loads(json.dumps(DEFAULT_CONFIG))
        if self.path.exists():
            with open(self.path) as f:
                loaded = json.load(f)
            # 1.0 configs had use_sudo at the top level; it now belongs to the local agent's policy
            if "use_sudo" in loaded:
                self.data["local_agent"]["policy"].setdefault("use_sudo", loaded.pop("use_sudo"))
            local = loaded.pop("local_agent", {})
            self.data.update(loaded)
            self.data["local_agent"].update(local)
        else:
            self.save()

    def __getitem__(self, key):
        return self.data[key]

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.path, self.data)

    @property
    def auth_enabled(self):
        return bool(self.data.get("users"))

    @property
    def data_dir(self):
        d = Path(self.data["data_dir"])
        if not d.is_absolute():
            d = self.path.parent / d
        return d


class Library:
    """Saved actions, stored in data/library.json."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        if path.exists():
            with open(path) as f:
                self.items = json.load(f)
        else:
            self.items = [self._normalize(seed) for seed in SEED_ACTIONS]
            self._save()

    def _save(self):
        atomic_write_json(self.path, self.items)

    @staticmethod
    def _normalize(raw, existing=None):
        name = str(raw.get("name", "")).strip()
        body = str(raw.get("body", ""))
        if not name:
            raise ValueError("Name is required")
        if not body.strip():
            raise ValueError("Command/script body is required")
        interp = raw.get("interpreter", "bash")
        if interp not in core.INTERPRETERS:
            raise ValueError(f"Unsupported interpreter: {interp}")
        params = raw.get("params") or []
        if isinstance(params, str):
            params = [p.strip() for p in params.split(",") if p.strip()]
        for p in params:
            if not core.ENV_RE.match(p):
                raise ValueError(f"Invalid parameter name: {p!r} (letters, digits, underscore)")
        icon = str(raw.get("icon") or "terminal")
        if not ICON_RE.match(icon):
            raise ValueError("Invalid icon name")
        color = raw.get("color") or "blue"
        if color not in COLORS:
            raise ValueError(f"Unsupported color: {color}")
        timeout = raw.get("timeout")
        timeout = int(timeout) if timeout not in (None, "", 0, "0") else None
        item = dict(existing or {})
        item.update({
            "id": (existing or {}).get("id") or secrets.token_hex(5),
            "name": name[:120],
            "group": str(raw.get("group", "") or "General").strip()[:60] or "General",
            "description": str(raw.get("description", "")).strip()[:300],
            "interpreter": interp,
            "icon": icon,
            "color": color,
            "body": body,
            "params": params,
            # Only servers carrying one of these tags may run it; empty = any server.
            "scope_tags": clean_tags(raw.get("scope_tags")),
            "confirm": bool(raw.get("confirm", False)),
            "danger": bool(raw.get("danger", False)),
            "timeout": timeout,
            "updated": now(),
        })
        item.setdefault("created", now())
        return item

    def list(self):
        with self.lock:
            return list(self.items)

    def get(self, item_id):
        with self.lock:
            return next((i for i in self.items if i["id"] == item_id), None)

    def upsert(self, raw):
        with self.lock:
            existing = next((i for i in self.items if i["id"] == raw.get("id")), None) if raw.get("id") else None
            item = self._normalize(raw, existing)
            if existing:
                self.items[self.items.index(existing)] = item
            else:
                self.items.append(item)
            self._save()
            return item

    def delete(self, item_id):
        with self.lock:
            before = len(self.items)
            self.items = [i for i in self.items if i["id"] != item_id]
            self._save()
            return len(self.items) != before


class State:
    """Small UI state persisted server-side: pinned services, per server."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.data = {"pins": {}}
        if path.exists():
            with open(path) as f:
                self.data.update(json.load(f))
        if "pinned_services" in self.data:  # 1.0: single server
            self.data["pins"].setdefault("local", self.data.pop("pinned_services"))

    def pins(self, server_id):
        return self.data["pins"].get(server_id, [])

    def set_pin(self, server_id, unit, pinned):
        with self.lock:
            pins = set(self.data["pins"].get(server_id, []))
            (pins.add if pinned else pins.discard)(unit)
            self.data["pins"][server_id] = sorted(pins)
            atomic_write_json(self.path, self.data)
            return self.data["pins"][server_id]


# ---------------------------------------------------------------------------
# Servers: connections to agents
# ---------------------------------------------------------------------------

class LocalConn:
    """The hub's own machine, driven in-process through the agent Executor."""
    local = True

    def __init__(self, record, executor):
        self.record = record
        self.executor = executor
        self.version = VERSION

    @property
    def id(self):
        return self.record["id"]

    @property
    def online(self):
        return True

    @property
    def system(self):
        return core.system_info()

    @property
    def policy(self):
        return self.executor.public_policy()

    def request(self, kind, payload, timeout=20):
        try:
            return self.executor.handle(kind, payload)
        except core.PolicyError as e:
            raise ApiError(403, str(e))
        except (ValueError, OSError) as e:
            raise ApiError(400, str(e))

    def start_job(self, job, spec):
        self.executor.start_job(job.id, spec, job.append, job.finish)

    def kill(self, job_id):
        return self.executor.kill(job_id)


class RemoteConn:
    """A remote agent. It long-polls for messages; we queue jobs/requests and wait for its pushes."""
    local = False

    def __init__(self, record):
        self.record = record
        self.cond = threading.Condition()
        self.outbox = []
        self.pending = {}
        self.last_seen = 0
        self.system = {}
        self.policy = {}
        self.version = None
        self.running = []

    @property
    def id(self):
        return self.record["id"]

    @property
    def online(self):
        return now() - self.last_seen < OFFLINE_AFTER

    def send(self, msg):
        with self.cond:
            self.outbox.append(msg)
            self.cond.notify_all()

    def poll(self, body):
        self.last_seen = now()
        self.system = body.get("system") or self.system
        self.policy = body.get("policy") or self.policy
        self.version = body.get("version") or self.version
        self.running = body.get("running") or []
        with self.cond:
            if not self.outbox:
                self.cond.wait(POLL_HOLD)
            msgs, self.outbox = self.outbox, []
        self.last_seen = now()
        return msgs

    def request(self, kind, payload, timeout=20):
        if not self.online:
            raise ApiError(503, f"{self.record['name']} is offline")
        rid = secrets.token_hex(6)
        slot = {"event": threading.Event(), "result": None}
        self.pending[rid] = slot
        self.send({"type": "req", "req_id": rid, "kind": kind, "payload": payload})
        if not slot["event"].wait(timeout):
            self.pending.pop(rid, None)
            raise ApiError(504, f"{self.record['name']} did not answer in time")
        res = slot["result"]
        if not res.get("ok"):
            raise ApiError(400, res.get("error") or "Request failed on the server")
        return res.get("data")

    def reply(self, r):
        slot = self.pending.pop(r.get("req_id"), None)
        if slot:
            slot["result"] = r
            slot["event"].set()

    def start_job(self, job, spec):
        if not self.online:
            job.append(f"{self.record['name']} is offline.\n")
            job.finish(125, "failed")
            return
        self.send({"type": "job", "job_id": job.id, "spec": spec})

    def kill(self, job_id):
        self.send({"type": "kill", "job_id": job_id})
        return True


class Servers:
    """Registry of servers (data/servers.json) and one-time enrollment tokens."""

    def __init__(self, data_dir, config):
        self.path = data_dir / "servers.json"
        self.tokens_path = data_dir / "enroll_tokens.json"
        self.lock = threading.Lock()
        self.records = {}
        self.tokens = []
        if self.path.exists():
            with open(self.path) as f:
                self.records = json.load(f)
        if self.tokens_path.exists():
            with open(self.tokens_path) as f:
                self.tokens = [t for t in json.load(f) if t["expires"] > now()]
        self.conns = {}
        local_cfg = config["local_agent"]
        if local_cfg.get("enabled", True):
            rec = self.records.setdefault("local", {"id": "local", "created": now()})
            rec.update(local=True, hostname=socket.gethostname())
            rec["name"] = local_cfg.get("name") or rec.get("name") or socket.gethostname()
            rec["tags"] = clean_tags(local_cfg.get("tags")) or rec.get("tags", [])
            policy = dict(local_cfg.get("policy") or {})
            policy.setdefault("job_timeout_seconds", config["job_timeout_seconds"])
            self.conns["local"] = LocalConn(rec, core.Executor(policy, data_dir / "agent"))
        else:
            self.records.pop("local", None)
        for sid, rec in self.records.items():
            if sid != "local":
                self.conns[sid] = RemoteConn(rec)
        self._save()

    def _save(self):
        atomic_write_json(self.path, self.records)
        atomic_write_json(self.tokens_path, self.tokens)

    def get(self, sid):
        conn = self.conns.get(sid)
        if not conn:
            raise ApiError(404, "Unknown server")
        return conn

    def summary(self, conn):
        r = conn.record
        return {
            "id": r["id"], "name": r["name"], "hostname": (conn.system or {}).get("hostname") or r.get("hostname"),
            "tags": r.get("tags", []), "local": conn.local, "online": conn.online,
            "last_seen": None if conn.local else (conn.last_seen or None),
            "version": conn.version, "system": conn.system or {}, "policy": conn.policy or {},
            "created": r.get("created"),
        }

    def list(self):
        conns = sorted(self.conns.values(), key=lambda c: (not c.local, c.record["name"].lower()))
        return [self.summary(c) for c in conns]

    def update(self, sid, name=None, tags=None):
        conn = self.get(sid)
        with self.lock:
            if name is not None:
                name = str(name).strip()[:60]
                if not name:
                    raise ValueError("Name is required")
                conn.record["name"] = name
            if tags is not None:
                conn.record["tags"] = clean_tags(tags)
            self._save()
        return self.summary(conn)

    def revoke(self, sid):
        conn = self.get(sid)
        if conn.local:
            raise ApiError(400, "The hub's own server can't be removed (disable local_agent in config instead)")
        with self.lock:
            self.records.pop(sid, None)
            self.conns.pop(sid, None)
            self._save()
        with conn.cond:
            conn.cond.notify_all()

    def new_token(self, name, tags):
        token = secrets.token_urlsafe(24)
        with self.lock:
            self.tokens = [t for t in self.tokens if t["expires"] > now()]
            self.tokens.append({"hash": sha256(token), "expires": now() + TOKEN_TTL,
                                "name": str(name or "").strip()[:60], "tags": clean_tags(tags)})
            self._save()
        return token

    def enroll(self, token, body):
        h = sha256(str(token))
        with self.lock:
            tok = next((t for t in self.tokens if hmac.compare_digest(t["hash"], h) and t["expires"] > now()), None)
            if not tok:
                raise ApiError(401, "Invalid or expired enrollment token")
            self.tokens.remove(tok)
            sid = secrets.token_hex(6)
            key = secrets.token_urlsafe(32)
            try:
                agent_tags = clean_tags(body.get("tags"))
            except ValueError:
                agent_tags = []
            rec = {"id": sid, "name": tok["name"] or str(body.get("name") or body.get("hostname") or sid)[:60],
                   "hostname": str(body.get("hostname", ""))[:255], "tags": clean_tags(tok["tags"] + agent_tags),
                   "key_hash": sha256(key), "created": now()}
            self.records[sid] = rec
            self.conns[sid] = RemoteConn(rec)
            self._save()
        return sid, key, rec["name"]

    def authenticate(self, header):
        if not header or not header.startswith("Bearer "):
            return None
        sid, _, key = header[7:].partition(".")
        conn = self.conns.get(sid)
        if not conn or conn.local or not hmac.compare_digest(conn.record.get("key_hash", ""), sha256(key)):
            return None
        return conn


# ---------------------------------------------------------------------------
# Jobs (hub side: what was asked, where, and everything it printed)
# ---------------------------------------------------------------------------

class HubJob:
    def __init__(self, conn, title, *, source, user, meta=None, run_id=None):
        self.id = secrets.token_hex(6)
        self.run_id = run_id or self.id
        self.server_id = conn.id
        self.server_name = conn.record["name"]
        self.title = title
        self.source = source
        self.user = user
        self.meta = meta or {}
        self.output = ""
        self.status = "running"
        self.exit_code = None
        self.started = now()
        self.finished = None
        self.last_activity = now()
        self.lock = threading.Lock()
        self.on_finish = None

    def append(self, text):
        with self.lock:
            self.last_activity = now()
            if len(self.output) < MAX_JOB_OUTPUT:
                self.output += text[: MAX_JOB_OUTPUT - len(self.output)]

    def finish(self, code, status):
        with self.lock:
            if self.status != "running":
                return
            self.exit_code = code
            self.status = status
            self.finished = now()
        if self.on_finish:
            self.on_finish(self)

    def summary(self):
        return {
            "id": self.id, "run_id": self.run_id, "server_id": self.server_id, "server_name": self.server_name,
            "title": self.title, "source": self.source, "user": self.user, "status": self.status,
            "exit_code": self.exit_code, "started": self.started, "finished": self.finished, "meta": self.meta,
        }


class JobManager:
    def __init__(self, data_dir, servers):
        self.servers = servers
        self.jobs = {}
        self.lock = threading.Lock()
        self.history_path = data_dir / "history.jsonl"
        self.history = []
        if self.history_path.exists():
            with open(self.history_path) as f:
                for line in f:
                    try:
                        self.history.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            self.history = self.history[-HISTORY_KEEP:]
            self._rewrite_history()
        threading.Thread(target=self._sweep, daemon=True).start()

    def _rewrite_history(self):
        tmp = self.history_path.with_suffix(".tmp")
        with open(tmp, "w") as f:
            for h in self.history:
                f.write(json.dumps(h) + "\n")
        os.replace(tmp, self.history_path)

    def record(self, job):
        entry = job.summary()
        out = job.output
        entry["output"] = out if len(out) <= HISTORY_OUTPUT else "[…earlier output trimmed…]\n" + out[-HISTORY_OUTPUT:]
        with self.lock:
            self.history.append(entry)
            with open(self.history_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
            if len(self.history) > HISTORY_KEEP * 1.5:
                self.history = self.history[-HISTORY_KEEP:]
                self._rewrite_history()
        # keep finished jobs in memory briefly so open viewers can finish reading
        threading.Timer(600, lambda: self.jobs.pop(job.id, None)).start()

    def launch(self, conn, title, spec, *, source, user, meta=None, run_id=None):
        job = HubJob(conn, title, source=source, user=user, meta=meta, run_id=run_id)
        job.on_finish = self.record
        with self.lock:
            self.jobs[job.id] = job
        conn.start_job(job, spec)
        return job

    def event(self, conn, title, output, *, source, user, meta=None, status="success"):
        """Record something that happened instantly (e.g. a file save) as a finished job."""
        job = HubJob(conn, title, source=source, user=user, meta=meta)
        job.append(output)
        job.on_finish = self.record
        job.finish(0 if status == "success" else 1, status)
        return job

    def _sweep(self):
        # Fail jobs whose agent went away, so nothing spins forever.
        while True:
            time.sleep(15)
            with self.lock:
                running = [j for j in self.jobs.values() if j.status == "running"]
            for j in running:
                conn = self.servers.conns.get(j.server_id)
                if conn is None:
                    lost = "server was removed"
                elif conn.local:
                    continue
                elif not conn.online and now() - j.last_activity > OFFLINE_AFTER:
                    lost = "lost contact with the server"
                elif conn.online and j.id not in conn.running and now() - j.last_activity > 30:
                    lost = "the agent is no longer running this job (restarted?)"
                else:
                    continue
                j.append(f"\n[{lost}]\n")
                j.finish(None, "failed")

    def agent_output(self, conn, item):
        job = self.get(item.get("job_id"))
        if not job or job.server_id != conn.id:
            return
        if item.get("chunk"):
            job.append(str(item["chunk"]))
        if item.get("done"):
            job.finish(item.get("exit_code"), item.get("status") if item.get("status") in
                       ("success", "failed", "killed") else "failed")

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)

    def find_history(self, job_id):
        with self.lock:
            return next((h for h in reversed(self.history) if h["id"] == job_id), None)

    def recent(self, limit=200):
        with self.lock:
            running = [j.summary() for j in self.jobs.values() if j.status == "running"]
            done = [{k: v for k, v in h.items() if k != "output"} for h in reversed(self.history[-limit:])]
        return running + done


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class App:
    def __init__(self, config):
        self.config = config
        data_dir = config.data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(data_dir, 0o700)
        self.library = Library(data_dir / "library.json")
        self.state = State(data_dir / "state.json")
        self.servers = Servers(data_dir, config)
        self.jobs = JobManager(data_dir, self.servers)
        self.sessions = {}
        self.sessions_lock = threading.Lock()
        self.failed_logins = {}

    def new_session(self, user):
        token = secrets.token_urlsafe(32)
        with self.sessions_lock:
            self.sessions[token] = {"user": user, "expires": now() + self.config["session_hours"] * 3600}
        return token

    def session_user(self, token):
        if not token:
            return None
        with self.sessions_lock:
            s = self.sessions.get(token)
            if not s:
                return None
            if s["expires"] < now() or s["user"] not in self.config["users"]:
                self.sessions.pop(token, None)
                return None
            return s["user"]

    def end_session(self, token):
        with self.sessions_lock:
            self.sessions.pop(token, None)

    def rate_limited(self, ip):
        fails = [t for t in self.failed_logins.get(ip, []) if t > now() - 300]
        self.failed_logins[ip] = fails
        return len(fails) >= 10

    def note_failure(self, ip):
        self.failed_logins.setdefault(ip, []).append(now())


def make_handler(app, agent_only=False):
    cfg = app.config

    class Handler(BaseHTTPRequestHandler):
        server_version = f"Helm/{VERSION}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            p = self.path
            if not (p.startswith("/api/jobs/") or p.startswith("/api/system") or p.startswith("/agent/poll")
                    or p.startswith("/agent/push") or p.startswith("/api/servers")):
                sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}\n")

        # -- plumbing -------------------------------------------------------
        def _cookie_token(self):
            c = SimpleCookie(self.headers.get("Cookie", ""))
            return c["helm_session"].value if "helm_session" in c else None

        def _send(self, status, body, ctype="application/json", headers=None):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ApiError(413, "Request too large")
            raw = self.rfile.read(length) if length else b"{}"
            try:
                return json.loads(raw or b"{}")
            except json.JSONDecodeError:
                raise ApiError(400, "Invalid JSON")

        def _user(self):
            if not cfg.auth_enabled:
                return "local"
            return app.session_user(self._cookie_token())

        def _require_user(self):
            user = self._user()
            if not user:
                raise ApiError(401, "Login required")
            return user

        def _require_editing(self):
            if not cfg["allow_editing"]:
                raise ApiError(403, "Editing is disabled on this hub (locked mode)")

        def _hub_url(self):
            if cfg["agent_url"]:
                return cfg["agent_url"].rstrip("/")
            if cfg["public_url"]:
                return cfg["public_url"].rstrip("/")
            proto = self.headers.get("X-Forwarded-Proto") or "http"
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or f"{cfg['host']}:{cfg['port']}"
            return f"{proto}://{host}"

        # -- dispatch -------------------------------------------------------
        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def _dispatch(self, method):
            url = urlparse(self.path)
            path = url.path
            try:
                if agent_only and not path.startswith("/agent/"):
                    raise ApiError(404, "Not found")
                if path.startswith("/agent/"):
                    return self._agent_api(method, path)
                if not path.startswith("/api/"):
                    if method != "GET":
                        raise ApiError(405, "Method not allowed")
                    return self._static(path)
                # CSRF guard: state-changing requests must carry our custom header,
                # which browsers will not send cross-origin without a CORS preflight.
                if method != "GET" and self.headers.get("X-Helm") != "1":
                    raise ApiError(403, "Missing X-Helm header")
                self._api(method, path, {k: v[0] for k, v in parse_qs(url.query).items()})
            except ApiError as e:
                self._send(e.status, {"error": e.message})
            except core.PolicyError as e:
                self._send(403, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"Unhandled error: {e!r}\n")
                self._send(500, {"error": "Internal server error"})

        def _static(self, path):
            if path in ("/", "/index.html"):
                rel = "index.html"
            elif path.startswith("/static/"):
                rel = path[len("/static/"):]
            elif path == "/favicon.svg":
                rel = "favicon.svg"
            else:
                raise ApiError(404, "Not found")
            target = (STATIC_DIR / rel).resolve()
            if STATIC_DIR not in target.parents or not target.is_file():
                raise ApiError(404, "Not found")
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)

        # -- agent endpoints (bearer auth, no cookies) ----------------------
        def _agent_api(self, method, path):
            if method == "GET" and path == "/agent/agent.py":
                return self._send(200, (APP_DIR / "agent.py").read_bytes(), "text/x-python; charset=utf-8")
            if method == "GET" and path == "/agent/install.sh":
                return self._send(200, (DEPLOY_DIR / "install-agent.sh").read_bytes(), "text/x-shellscript; charset=utf-8")
            if method != "POST":
                raise ApiError(405, "Method not allowed")
            if path == "/agent/enroll":
                ip = self.client_address[0]
                if app.rate_limited(ip):
                    raise ApiError(429, "Too many attempts")
                body = self._body()
                try:
                    sid, key, name = app.servers.enroll(body.get("token", ""), body)
                except ApiError:
                    app.note_failure(ip)
                    raise
                sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] enrolled server {sid} from {ip}\n")
                return self._send(200, {"agent_id": sid, "agent_key": key, "name": name})
            conn = app.servers.authenticate(self.headers.get("Authorization"))
            if not conn:
                raise ApiError(401, "Unknown or revoked agent")
            body = self._body()
            if path == "/agent/poll":
                return self._send(200, {"messages": conn.poll(body)})
            if path == "/agent/push":
                conn.last_seen = now()
                for item in body.get("outputs", []):
                    app.jobs.agent_output(conn, item)
                for r in body.get("replies", []):
                    conn.reply(r)
                return self._send(200, {"ok": True})
            raise ApiError(404, "Unknown endpoint")

        # -- UI API ---------------------------------------------------------
        def _api(self, method, path, query):
            parts = [p for p in path.split("/")[2:] if p]
            route = (method, parts[0] if parts else "")

            if route == ("GET", "session"):
                return self._send(200, {
                    "auth_required": cfg.auth_enabled, "user": self._user(),
                    "allow_editing": cfg["allow_editing"], "version": VERSION,
                    "hostname": socket.gethostname(),
                })
            if route == ("POST", "login"):
                return self._login()
            if route == ("POST", "logout"):
                token = self._cookie_token()
                if token:
                    app.end_session(token)
                return self._send(200, {"ok": True}, headers={
                    "Set-Cookie": "helm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})

            user = self._require_user()

            # -- servers -----------------------------------------------------
            if parts[:1] == ["servers"]:
                if method == "GET" and len(parts) == 1:
                    return self._send(200, {"servers": app.servers.list()})
                if method == "POST" and len(parts) == 2:
                    self._require_editing()
                    body = self._body()
                    return self._send(200, app.servers.update(parts[1], body.get("name"), body.get("tags")))
                if method == "DELETE" and len(parts) == 2:
                    self._require_editing()
                    app.servers.revoke(parts[1])
                    return self._send(200, {"ok": True})
            if route == ("POST", "enroll"):
                self._require_editing()
                body = self._body()
                token = app.servers.new_token(body.get("name"), body.get("tags"))
                hub = self._hub_url()
                return self._send(200, {"token": token, "expires": now() + TOKEN_TTL, "hub_url": hub})
            if route == ("GET", "system"):
                return self._send(200, app.servers.get(query.get("server", "local")).request("system", {}))

            # -- library -----------------------------------------------------
            if parts[:1] == ["library"]:
                if method == "GET" and len(parts) == 1:
                    return self._send(200, {"items": app.library.list()})
                if method == "POST" and len(parts) == 1:
                    self._require_editing()
                    return self._send(200, app.library.upsert(self._body()))
                if method == "DELETE" and len(parts) == 2:
                    self._require_editing()
                    if not app.library.delete(parts[1]):
                        raise ApiError(404, "Action not found")
                    return self._send(200, {"ok": True})
                if method == "POST" and len(parts) == 3 and parts[2] == "run":
                    return self._run_action(parts[1], user)

            # -- console & editor -------------------------------------------
            if route == ("POST", "console"):
                self._require_editing()
                body = self._body()
                script = str(body.get("body", ""))
                if not script.strip():
                    raise ApiError(400, "Nothing to run")
                interp = body.get("interpreter", "bash")
                if interp not in core.INTERPRETERS:
                    raise ApiError(400, "Unsupported interpreter")
                env, args = self._params(body.get("param_names") or [], body.get("params") or {})
                conn = app.servers.get(body.get("server", "local"))
                first = script.strip().splitlines()[0]
                title = str(body.get("title") or "").strip()[:120] or (
                    first[:80] + ("…" if len(first) > 80 or "\n" in script.strip() else ""))
                job = app.jobs.launch(conn, title, {
                    "kind": "script", "interpreter": interp, "body": script, "env": env, "args": args,
                    "timeout": cfg["job_timeout_seconds"],
                }, source=body.get("source") if body.get("source") in ("console", "editor") else "console",
                    user=user, meta={"interpreter": interp, "body": script, "params": env})
                return self._send(200, job.summary())
            if route == ("POST", "check"):
                self._require_editing()
                body = self._body()
                conn = app.servers.get(body.get("server", "local"))
                return self._send(200, conn.request("check", {"interpreter": body.get("interpreter", "bash"),
                                                              "body": str(body.get("body", ""))}, timeout=40))

            # -- jobs --------------------------------------------------------
            if parts[:1] == ["jobs"]:
                if method == "GET" and len(parts) == 1:
                    return self._send(200, {"jobs": app.jobs.recent()})
                if method == "GET" and len(parts) == 2:
                    return self._job_output(parts[1], query)
                if method == "POST" and len(parts) == 3 and parts[2] == "kill":
                    job = app.jobs.get(parts[1])
                    if not job or job.status != "running":
                        raise ApiError(404, "Job not running")
                    conn = app.servers.get(job.server_id)
                    return self._send(200, {"ok": conn.kill(job.id)})

            # -- services ----------------------------------------------------
            if parts[:1] == ["services"]:
                if method == "GET" and len(parts) == 1:
                    sid = query.get("server", "local")
                    data = app.servers.get(sid).request("services", {})
                    data["pinned"] = app.state.pins(sid)
                    return self._send(200, data)
                if method == "POST" and len(parts) == 2 and parts[1] == "pin":
                    body = self._body()
                    sid, unit = str(body.get("server", "local")), str(body.get("unit", ""))
                    app.servers.get(sid)
                    if not core.UNIT_RE.match(unit):
                        raise ApiError(400, "Invalid unit name")
                    return self._send(200, {"pinned": app.state.set_pin(sid, unit, bool(body.get("pinned")))})
                if method == "POST" and len(parts) == 4:
                    return self._service_action(parts[1], parts[2], parts[3], user)

            # -- files -------------------------------------------------------
            if parts[:1] == ["files"]:
                conn = app.servers.get(query.get("server", "local"))
                if method == "GET" and query.get("read"):
                    return self._send(200, conn.request("files.read", {"path": query.get("path", "")}))
                if method == "GET":
                    return self._send(200, conn.request("files.list", {"path": query.get("path", "")}))
                if method == "POST":
                    self._require_editing()
                    body = self._body()
                    res = conn.request("files.write", {"path": body.get("path", ""), "content": body.get("content", ""),
                                                       "mtime": body.get("mtime")}, timeout=40)
                    app.jobs.event(conn, f"Edited {res['path']}", res.get("diff") or "(no changes)\n",
                                   source="file", user=user, meta={"path": res["path"], "backup": res.get("backup")})
                    return self._send(200, res)

            raise ApiError(404, "Unknown endpoint")

        # -- handlers -------------------------------------------------------
        def _login(self):
            if not cfg.auth_enabled:
                return self._send(200, {"user": "local"})
            ip = self.client_address[0]
            if app.rate_limited(ip):
                raise ApiError(429, "Too many failed attempts. Try again in a few minutes.")
            body = self._body()
            username = str(body.get("username", ""))
            stored = cfg["users"].get(username)
            # always do the hashing work so timing doesn't reveal valid usernames
            ok = verify_password(str(body.get("password", "")), stored or hash_password("x", 1000))
            if not (stored and ok):
                app.note_failure(ip)
                time.sleep(0.5)
                raise ApiError(401, "Invalid username or password")
            app.failed_logins.pop(ip, None)
            token = app.new_session(username)
            cookie = (f"helm_session={token}; Path=/; HttpOnly; SameSite=Strict; "
                      f"Max-Age={int(cfg['session_hours'] * 3600)}")
            if cfg["secure_cookies"]:
                cookie += "; Secure"
            return self._send(200, {"user": username}, headers={"Set-Cookie": cookie})

        @staticmethod
        def _params(names, values):
            env, positional = {}, []
            for name in names:
                if not core.ENV_RE.match(str(name)):
                    raise ApiError(400, f"Invalid parameter name {name!r}")
                v = str(values.get(name, ""))
                env[name] = v
                positional.append(v)
            return env, positional

        def _run_action(self, item_id, user):
            item = app.library.get(item_id)
            if not item:
                raise ApiError(404, "Action not found")
            body = self._body()
            targets = body.get("servers") or ["local"]
            if not isinstance(targets, list) or len(targets) > 200:
                raise ApiError(400, "Invalid server list")
            conns = [app.servers.get(str(s)) for s in dict.fromkeys(targets)]
            scope = set(item.get("scope_tags") or [])
            for c in conns:
                if scope and not scope & set(c.record.get("tags", [])):
                    raise ApiError(400, f"“{item['name']}” is limited to servers tagged "
                                        f"{', '.join(sorted(scope))}; {c.record['name']} isn’t")
            env, args = self._params(item.get("params", []), body.get("params") or {})
            spec = {"kind": "script", "interpreter": item["interpreter"], "body": item["body"],
                    "env": env, "args": args, "timeout": item.get("timeout") or cfg["job_timeout_seconds"]}
            run_id = secrets.token_hex(6)
            jobs = [app.jobs.launch(c, item["name"], spec, source="action", user=user, run_id=run_id,
                                    meta={"action_id": item["id"], "params": env}) for c in conns]
            return self._send(200, {"run_id": run_id, "jobs": [j.summary() for j in jobs]})

        def _service_action(self, sid, unit, action, user):
            conn = app.servers.get(sid)
            if not core.UNIT_RE.match(unit):
                raise ApiError(400, "Invalid unit name")
            if action not in core.SERVICE_ACTIONS:
                raise ApiError(400, "Unsupported service action")
            title = f"{action} {unit}" if action in ("logs", "status") else f"systemctl {action} {unit}"
            job = app.jobs.launch(conn, title, {"kind": "service", "unit": unit, "action": action},
                                  source="service", user=user, meta={"unit": unit, "action": action})
            return self._send(200, job.summary())

        def _job_output(self, job_id, query):
            offset = int(query.get("offset") or 0)
            job = app.jobs.get(job_id)
            if job:
                with job.lock:
                    out = job.output[offset:]
                    data = job.summary()
                data.update(output=out, offset=offset + len(out))
                return self._send(200, data)
            entry = app.jobs.find_history(job_id)
            if not entry:
                raise ApiError(404, "Job not found")
            out = entry.get("output", "")[offset:]
            return self._send(200, dict(entry, output=out, offset=offset + len(out)))

    return Handler


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Helm hub: lightweight server control plane")
    ap.add_argument("-c", "--config", default=str(APP_DIR / "config.json"), help="path to config.json")
    ap.add_argument("--host", help="override listen host")
    ap.add_argument("--port", type=int, help="override listen port")
    ap.add_argument("--set-password", metavar="USER", help="create/update a login user and exit")
    ap.add_argument("--remove-user", metavar="USER", help="remove a login user and exit")
    args = ap.parse_args()

    config = Config(args.config)

    if args.set_password:
        pw = getpass.getpass(f"New password for {args.set_password}: ")
        if len(pw) < 8:
            sys.exit("Password must be at least 8 characters.")
        if getpass.getpass("Confirm: ") != pw:
            sys.exit("Passwords do not match.")
        config.data.setdefault("users", {})[args.set_password] = hash_password(pw)
        config.save()
        print(f"User '{args.set_password}' saved. Login is now required.")
        return
    if args.remove_user:
        if config.data.get("users", {}).pop(args.remove_user, None) is None:
            sys.exit(f"No such user: {args.remove_user}")
        config.save()
        print(f"User removed. {'Login still required.' if config.auth_enabled else 'Login is now disabled.'}")
        return

    host = args.host or config["host"]
    port = args.port or config["port"]

    if not config.auth_enabled and not is_loopback(host):
        if not config["allow_insecure_remote"]:
            sys.exit(
                f"Refusing to listen on {host} without a login: anyone who can reach this port could run\n"
                f"commands on every managed server. Either:\n"
                f"  * add a user:      python3 {sys.argv[0]} --set-password admin\n"
                f"  * bind to localhost and use an SSH tunnel / authenticating reverse proxy, or\n"
                f"  * set \"allow_insecure_remote\": true in {config.path} if you really mean it.")
        print("WARNING: listening on a non-loopback address with NO login.", file=sys.stderr)

    app = App(config)
    server = ThreadingHTTPServer((host, port), make_handler(app))
    server.daemon_threads = True
    if config["agent_listen"]:
        a_host, _, a_port = config["agent_listen"].rpartition(":")
        agent_server = ThreadingHTTPServer((a_host or "0.0.0.0", int(a_port)), make_handler(app, agent_only=True))
        agent_server.daemon_threads = True
        threading.Thread(target=agent_server.serve_forever, daemon=True).start()
        print(f"Agent endpoint listening on http://{a_host or '0.0.0.0'}:{a_port} (agent API only, no UI)")
        if not config["agent_url"]:
            print("  Tip: set \"agent_url\" (e.g. http://<this-host-LAN-IP>:" + a_port + ") so install commands point there.",
                  file=sys.stderr)
    mode = "login required" if config.auth_enabled else "no login"
    n = len(app.servers.conns)
    print(f"Helm hub {VERSION} listening on http://{host}:{port}  ({mode}, {n} server{'s' * (n != 1)}, "
          f"data in {config.data_dir})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
