# Helm

A lightweight control plane for your servers. Think OliveTin plus the useful 10% of Webmin, with a friendlier UI in the ·modern look (Orbital / Atrium / Debrief).

```
 Browser ──HTTPS──▶  Helm hub (server.py)            helm-agent (agent.py) on each server
                     • UI, logins, history            • runs scripts, services, files
                     • action library            ◀─── • dials OUT to the hub (long-poll HTTPS)
                     • server registry                • its own policy caps what the hub may do
                     • built-in agent for its own host
```

- **Actions**: saved scripts (bash, sh, python3) shown as one-click tiles. Run one on a single server, several, or every server with a tag; output streams live, one tab per server. Actions can take parameters, ask for confirmation, be marked destructive, or be limited to certain tags.
- **Script editor**: a full-page editor with syntax highlighting, line numbers and auto-indent. **Check** runs `bash -n` / Python parsing, plus `shellcheck` when it's installed on the server. **Test run** runs what's in the editor on the selected server before you save. Ctrl+S saves.
- **Servers**: every managed machine as a tile glowing by status, with live CPU, memory and disk. *Add server* gives you a one-time install command.
- **Services**: systemd units on the selected server: start, stop, restart, reload, enable/disable, status, logs. Pins are kept per server.
- **Files**: browse, view and edit files inside each server's allowed folders, with highlighting for configs, scripts, JSON, logs and diffs. Every save keeps a backup and records a diff in History.
- **Console**: run anything on the selected server; *Save as action* sends it to the editor.
- **History**: every run and file edit, with where, who, how long, and the full output.
- **Pretty / Raw output**: any output Helm recognizes gets a *Pretty* view with meters, cards and tables: `df` (used vs free per mount), `free` (used / cache / free), `uptime` and `top` (load as a share of the server's CPUs, CPU and memory bars), and column output such as `ps`, `ss` or `docker ps` (with bars for % columns). One click switches back to the raw terminal output, and Helm remembers your choice.

No dependencies: Python 3.8+ standard library and static HTML/CSS/JS. Geist fonts and Lucide icons are bundled. No build step.

## Quick start (one machine)

```bash
python3 helm/server.py                        # http://127.0.0.1:8780, manages this machine
python3 helm/server.py --set-password admin   # add a login (then required)
```

Install as a service with `sudo ./deploy/install.sh`. It puts code in `/opt/helm` and config and data in `/etc/helm`, kept across upgrades.

## Adding servers

1. Make the hub reachable by the servers: over **HTTPS** through your reverse proxy (`public_url`), or over plain http on your LAN (`agent_listen` + `agent_url`, see below).
2. In Helm, open **Servers → Add server** (optionally give it a name and tags). You get a one-time command, valid for an hour:
   ```bash
   curl -fsSL https://helm.example.com/agent/install.sh | sudo bash -s -- https://helm.example.com <token>
   ```
   It downloads `agent.py` from the hub to `/opt/helm-agent`, enrolls it (swapping the token for a per-server key in `/etc/helm-agent/agent.json`), and starts `helm-agent.service`. The dialog also shows a manual alternative if you'd rather not pipe to bash.
3. The server appears in Helm as soon as the agent connects.

The agent only makes outbound HTTPS requests. Managed servers need **no open ports**, and it works behind NAT. Agents reconnect on their own after a hub restart.

### Changing the hub address

The hub's IP or port changed, or you want to switch an agent between the LAN address and the Pangolin URL:

- **From Helm** (the agent is still connected): on the server's tile, click the link icon and enter the new address. You can apply it to every online server at once. Each agent first checks that the new address reaches this same hub, by testing it with its own key, and keeps the old address if it doesn't. Do this *before* moving the hub. Each tile shows the address its agent uses.
- **On the server** (the agent can no longer reach the hub):
  ```bash
  sudo python3 /opt/helm-agent/agent.py --set-hub http://192.168.1.20:8781
  ```
  It runs the same check, saves the address to `/etc/helm-agent/agent.json`, and restarts `helm-agent`. Add `--no-check` to save it while the hub is down.

The same http/https rule as enrollment applies. To stop the hub from changing an agent's address remotely, set `allow_hub_change: false` in that agent's policy.

**Removing** a server (trash icon on its tile) revokes its key immediately. Stop the agent on the box with `systemctl disable --now helm-agent`.

## Behind Pangolin (or another proxy), with agents on your LAN

Browsers go through Pangolin over HTTPS with its login; agents talk to the hub directly over plain http on your LAN.

```json
{
  "host": "127.0.0.1",
  "port": 8780,
  "agent_listen": "0.0.0.0:8781",
  "agent_url": "http://192.168.1.10:8781"
}
```

- **UI** (`host`/`port`): point the Pangolin resource at it. Keep `127.0.0.1` if Newt runs on the same machine. If Newt runs elsewhere, bind the LAN IP and keep a Helm login on, since the UI is then reachable on your LAN without going through Pangolin.
- **Agent port** (`agent_listen`): serves *only* `/agent/*` (enroll, poll, push, the installer). The UI and `/api` return 404 there. Agents authenticate with their own keys, so this port needs no Helm login.
- **`agent_url`**: what *Add server* puts in the install command, here the hub's LAN address.
- Agents accept plain `http://` automatically when the hub address is private: RFC 1918 / ULA / link-local IPs, single-label hostnames, and `.lan`, `.local`, `.home`, `.internal`, `.home.arpa`. For a public hostname they still require HTTPS, unless you pass `--insecure-http`. Over http the agent key and job output cross your LAN unencrypted.
- Agents outside your LAN can enroll through Pangolin's HTTPS URL instead. Pangolin's login page would block them, so add a rule on the resource that bypasses auth for the path `/agent/*`. The agent endpoints have their own authentication.

## Agent policy: each server decides what the hub may do

`/etc/helm-agent/agent.json` → `"policy"` (restart `helm-agent` after editing). For the hub's own machine it's `local_agent.policy` in the hub config.

| key | default | |
|---|---|---|
| `allow_scripts` | `true` | Run scripts sent by the hub (actions, console, test runs). `false` = services and files only. |
| `allow_services` | `true` | systemd control |
| `allow_files` / `allow_file_writes` | `true` / `true` | Browse and view / edit files |
| `file_roots` | `/etc /opt /srv /var/log` | The only folders the hub can see. Symlinks are resolved before checking. |
| `use_sudo` | `false` | Prefix systemctl/journalctl with `sudo -n` when the agent isn't root (see `deploy/helm.sudoers`) |
| `job_timeout_seconds` | `3600` | Hard cap on any job here |
| `allow_hub_change` | `true` | Let the hub repoint this agent to another hub address (it must answer with this agent's key) |

The hub can't override these. A compromised or misconfigured hub can only do what each server's own policy allows. The Servers page shows each server's limits.

## Hub configuration (`config.json`)

| key | default | |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8780` | Where the hub listens |
| `public_url` | `""` | The hub's external URL; blank = taken from the request |
| `agent_listen` | `""` | Extra agent-only listener, e.g. `0.0.0.0:8781` (see Pangolin above) |
| `agent_url` | `""` | URL put in install commands; blank = `public_url` |
| `users` | `{}` | Managed with `--set-password` / `--remove-user`. Empty = no login. |
| `allow_editing` | `true` | `false` = **locked mode**: no console, editor or file edits; people can only run saved actions and service controls |
| `local_agent` | enabled | `{enabled, name, tags, policy}` for the hub's own machine |
| `session_hours`, `secure_cookies`, `job_timeout_seconds`, `allow_insecure_remote`, `data_dir` | | as before |

## Files: how edits stay safe

- Saves are refused if the file changed on disk since you opened it.
- The previous version is copied to the agent's own folder (`/var/lib/helm-agent/backups`, last 10 per file). It's **never** copied next to the file, where a stray `.bak` in `sites-enabled/` or `cron.d/` would be loaded as live config.
- Files are written in place, so owner, mode, hard links and SELinux labels are kept.
- Files over 2 MB, binary files and non-UTF-8 files are view-only. Big logs show their last 2 MB.

## Security notes

- Treat access to the hub like root SSH access to every managed server. Use a login, HTTPS (`secure_cookies: true`), and locked mode where appropriate.
- The hub refuses to listen on a non-loopback address with no users, unless you set `allow_insecure_remote`.
- Agent keys are stored hashed on the hub; enrollment tokens are single-use and expire after 1 hour. Agents use plain http only to private/LAN addresses, unless you pass `--insecure-http`.
- Parameter values reach scripts as environment variables (and `$1…`), never spliced into script text.
- Logins: PBKDF2 hashes, per-IP rate limiting, `HttpOnly; SameSite=Strict` cookies, an `X-Helm` header required on every state-changing request, and a strict CSP.

## Gauges from your own scripts

Print `::metric` lines and the Pretty view shows them as gauge cards. The rest of the output is still shown below them.

```bash
echo "::metric CPU temp: $(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))/95 °C warn=70 crit=85"
echo "::metric Queue depth: $(redis-cli llen jobs)"
echo "::metric Cache hit: 97.5 % warn=90 crit=80"     # crit below warn = low is bad
```

Format: `::metric <label>: <value>[/<max>] [unit] [warn=N] [crit=N]`. A `/max` or a `%` unit draws a bar. Cards stay neutral unless you give `warn`/`crit`.

## Theming

All colors, fonts and radii are CSS variables in `helm/static/theme.css`, the ·modern palette shared with Orbital. Dark by default; the sun/moon button toggles light.

## Layout

```
helm/server.py            hub: UI API, auth, library, history, server registry
helm/agent.py             agent: executor + daemon (the hub imports it for its own host)
helm/static/              index.html, app.js, editor.js (editor + highlighter), icons.js, app.css, theme.css, fonts/
deploy/install.sh         hub installer / upgrader
deploy/install-agent.sh   agent installer (served by the hub at /agent/install.sh)
deploy/helm.service       hub systemd unit
deploy/helm.sudoers       rules for running hub or agent unprivileged
```
