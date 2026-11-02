#!/usr/bin/env bash
# Install (or upgrade) Helm as a systemd service.
#   sudo ./deploy/install.sh
# Code goes to /opt/helm, config + data to /etc/helm (kept across upgrades).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"

install -d -m 755 /opt/helm
cp -r "$SRC/helm/server.py" "$SRC/helm/agent.py" "$SRC/helm/static" /opt/helm/
install -d -m 755 /opt/deploy && cp "$SRC/deploy/install-agent.sh" /opt/deploy/
install -d -m 700 /etc/helm

if [[ ! -f /etc/helm/config.json ]]; then
  cat > /etc/helm/config.json <<'EOF'
{
  "host": "127.0.0.1",
  "port": 8780,
  "data_dir": "/etc/helm/data",
  "users": {},
  "session_hours": 12,
  "secure_cookies": false,
  "allow_editing": true,
  "public_url": "",
  "agent_listen": "",
  "agent_url": "",
  "local_agent": {"enabled": true, "name": "", "tags": [], "policy": {}},
  "job_timeout_seconds": 3600,
  "allow_insecure_remote": false
}
EOF
  chmod 600 /etc/helm/config.json
  echo "Created /etc/helm/config.json"
fi

install -m 644 "$SRC/deploy/helm.service" /etc/systemd/system/helm.service
systemctl daemon-reload
systemctl enable helm >/dev/null 2>&1

if python3 -c 'import json,sys; sys.exit(0 if json.load(open("/etc/helm/config.json")).get("users") else 1)'; then
  systemctl restart helm
  echo "Helm restarted."
else
  echo
  read -r -p "Create an admin login now? [Y/n] " ans
  if [[ ! "$ans" =~ ^[Nn] ]]; then
    python3 /opt/helm/server.py --config /etc/helm/config.json --set-password admin
  fi
  systemctl restart helm
fi

PORT=$(python3 -c 'import json; print(json.load(open("/etc/helm/config.json"))["port"])')
HOST=$(python3 -c 'import json; print(json.load(open("/etc/helm/config.json"))["host"])')
echo
echo "Helm is running on http://$HOST:$PORT"
if [[ "$HOST" == "127.0.0.1" ]]; then
  echo "It only listens on localhost. From your machine:  ssh -L $PORT:localhost:$PORT $(hostname)"
  echo "or set \"host\": \"0.0.0.0\" in /etc/helm/config.json (login required) and: systemctl restart helm"
fi
echo "Logs: journalctl -u helm -f"
