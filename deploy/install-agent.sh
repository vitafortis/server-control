#!/usr/bin/env bash
# Install helm-agent on a server and register it with a Helm hub.
# The hub's "Add server" dialog gives you the exact command, e.g.:
#   curl -fsSL https://helm.example.com/agent/install.sh | sudo bash -s -- https://helm.example.com <TOKEN> --tags web
# Options after the token are passed to `agent.py --enroll` (--name, --tags, --ca-file, --insecure-http).
set -euo pipefail

HUB="${1:-}"; TOKEN="${2:-}"
if [[ -z "$HUB" || -z "$TOKEN" ]]; then
  echo "usage: install-agent.sh <hub-url> <enroll-token> [--name NAME] [--tags a,b]" >&2
  exit 2
fi
shift 2
if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }

install -d -m 755 /opt/helm-agent
TMP="$(mktemp)"
if command -v curl >/dev/null; then curl -fsSL "$HUB/agent/agent.py" -o "$TMP"
else python3 -c 'import sys,urllib.request; open(sys.argv[2],"wb").write(urllib.request.urlopen(sys.argv[1]).read())' "$HUB/agent/agent.py" "$TMP"; fi
python3 -m py_compile "$TMP"
install -m 755 "$TMP" /opt/helm-agent/agent.py
rm -f "$TMP"

python3 /opt/helm-agent/agent.py --config /etc/helm-agent/agent.json --enroll "$HUB" "$TOKEN" "$@"

cat > /etc/systemd/system/helm-agent.service <<'EOF'
[Unit]
Description=Helm agent (managed by a Helm hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 -u /opt/helm-agent/agent.py --config /etc/helm-agent/agent.json
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now helm-agent >/dev/null 2>&1
systemctl restart helm-agent
echo
echo "helm-agent is running. Logs: journalctl -u helm-agent -f"
echo "Policy (what the hub may do here): /etc/helm-agent/agent.json → \"policy\"; restart helm-agent after editing."
