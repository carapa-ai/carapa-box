# Direct connections

Operator-machine prerequisites: Linux/WSL with Python 3.11+, Python venv/pip, and Codex supporting
`http_headers_helper`. SSH tunnels also need OpenSSH and a running systemd user manager
(enable systemd in WSL if unavailable). Controllers run on Linux. Remote controller hosts do
not need Python: setup/administration use their existing Bash, Docker and host utilities over
SSH. Python and tomlkit run only on the machine configuring Codex's MCP connections.
No Node gateway is installed.

Check for the stable launcher at `~/.local/share/carapa-box-plugin/bin/carapa-box-plugin` first
(or the previously selected custom prefix). Reuse a working installation. From the installed
plugin directory, install helpers when missing or update them for a changed helper:

```bash
python3 scripts/install_helpers.py
```

This installs a private Python environment with pinned `tomlkit` (to preserve TOML comments and
unrelated settings) and a launcher at `~/.local/share/carapa-box-plugin/bin/carapa-box-plugin`.
Use that absolute launcher path below or add its `bin` directory to PATH. Updating the helper
installation preserves Codex configuration and inventory. Custom `--prefix` paths are supported.
The install downloads the pinned dependency; it does not start services or write MCP config.

## Register controllers

```bash
carapa-box-plugin connection carapa_box_local \
  --url http://127.0.0.1:3100 \
  --token-file /home/operator/.secrets/box/local-api-token \
  --admin-token-file /home/operator/.secrets/box/local-admin-token \
  --repo-root /home/operator/carapa-box --mode container

carapa-box-plugin connection carapa_box_production \
  --url https://box.example.com \
  --token-file /home/operator/.secrets/box/production-api-token \
  --admin-token-file /home/operator/.secrets/box/production-admin-token \
  --ssh-alias production-box --repo-root /srv/carapa-box --mode container
```

During authorized controller setup, use the packaged `setup/scripts/ensure-controller-secrets.sh`
helper (under `references/`) to generate independent API and admin token files. Existing controller
credentials are reused, never generated or rotated by connection registration. Provision the
operator's local credential references privately, with restrictive permissions.

`--admin-token-file` supplies a separate operator credential for admin requests; it is never sent
as an MCP header. Without that option, MCP still works but the helper's `admin` command refuses
requests. Identical API/admin credentials are rejected. The controller must load the separate
admin token; merely creating an unmounted file does not enable it. `check` also verifies admin
access and cross-token rejection when the admin reference is configured.

For existing deployments, provision and mount a distinct admin token during an authorized upgrade,
then update the connection with `--admin-token-file` and `--update`. Preserve the API token shared
with Board/relays. New controller code disables admin routes if the admin token is absent or
identical to the API token. Only reloading/recreating the selected controller activates its new
credential configuration; installing the plugin does not deploy that change.

By default, registrations go to `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`). Metadata goes
to `~/.config/carapa-box-plugin/hosts.json`. Override with global `--config` and `--inventory`
options **before** the subcommand. Use `--update` to change an existing named connection; tool
policies/timeouts and unrelated servers are retained. Remove a managed tunnel before changing its
URL or SSH alias. Unknown/invalid credentials fail closed.

```bash
carapa-box-plugin list
carapa-box-plugin check carapa_box_local
```

Native configuration contains the server URL and an `http_headers_helper` command pointing to
stable installed files. Its output is consumed privately by Codex; never run that command to
display it. It reads the token on invocation and emits an Authorization header. Connections default
to optional (`required = false`), with 20-second startup and 300-second tool timeouts. Reload MCP or
start a new task after editing registrations. Codex's existing tool approval policies remain in force.

Health/admin helpers accept controller root URLs or `/api/mcp`, including reverse-proxy prefixes.
They verify TLS and do not follow redirects. Run native MCP discovery afterward to verify sessions.
An MCP endpoint reachable only from another execution host needs configuration and helpers on that
host; this plugin's header helper targets connections made by the local Codex process.

## Connection reports and browser URLs

The native MCP URL is machine-facing configuration. Both the controller root and `/api/mcp`
accept authenticated MCP traffic; neither is a browser dashboard. Show this URL as code with an
explicit MCP/API label, and do not open or mark it as a browser preview. Browser navigation does
not use Codex's header helper, so an unauthenticated request returns 401.

For a human-facing link, remove a trailing `/api/mcp` from the configured URL, retain any proxy
prefix, and append `/admin/`. For example, `http://127.0.0.1:3100/api/mcp` corresponds to the
dashboard `http://127.0.0.1:3100/admin/`; `https://host.example/box/api/mcp` corresponds to
`https://host.example/box/admin/`. Verify that the route serves the dashboard before offering
it; proxy redirects may need operator configuration. The dashboard has its own token login.
Never put token values in links or browser preview configuration.

Report registration, HTTP authentication checks, and native MCP discovery separately. The helper's
`check` command proves HTTP access but does not establish a native MCP session. If the server's
tools are not yet available, report that native verification is pending reload/new-task pickup.

## SSH-only controllers

Use a dedicated unused local port for each tunnel. Configure and verify the SSH alias/known_hosts
using the normal operator SSH flow first; the service uses batch authentication and never accepts
unknown host keys automatically. Use an identity usable noninteractively or make the appropriate
SSH agent environment available to the systemd user manager.

```bash
carapa-box-plugin connection carapa_box_private \
  --url http://127.0.0.1:13100 \
  --token-file /home/operator/.secrets/box/private-api-token \
  --ssh-alias private-box --repo-root /srv/carapa-box --mode container
carapa-box-plugin tunnel carapa_box_private install --remote-port 3100
carapa-box-plugin tunnel carapa_box_private start
carapa-box-plugin tunnel carapa_box_private status
carapa-box-plugin tunnel carapa_box_private stop
carapa-box-plugin tunnel carapa_box_private remove
```

`install` writes only the named unit and inventory metadata. `start` enables it and checks service
state plus controller authentication. The SSH process reconnects through systemd after failure.
`stop` disables it; `remove` disables/removes only that managed unit and its inventory metadata.
Keep user services alive beyond logout only when desired, using the host's normal lingering setup.
A startup timeout leaves the unit enabled for reconnects; inspect or stop it explicitly.

## Admin API and removal

```bash
carapa-box-plugin admin carapa_box_production --path /api/admin/info
carapa-box-plugin admin carapa_box_production --path '/api/admin/config?file=root'
carapa-box-plugin admin carapa_box_production --method POST \
  --path '/api/admin/config?file=root' --body-file /private/reviewed-config.json
carapa-box-plugin admin carapa_box_production --path /api/admin/logs \
  --output-file /private/box-audit.json
```

These commands use the existing admin API; the helper is not a proxy or a new server. Read current
controller docs before constructing provider/relay operations. Secret fields are redacted in JSON
output. `--output-file` saves the full response privately, so use it only for intended operator
storage outside sandbox mounts. Audit responses require a file because they contain free-form text.
Do not echo secret-bearing files. Mutations are never retried by this helper.

Native connections and tunnel services are independent of the plugin. To remove a connection,
remove its tunnel first (if present), then use `codex mcp remove <server-name>` and delete only that
host's inventory entry. Credential files are retained until the operator explicitly removes them.
Disabling/uninstalling the plugin leaves these resources intact.
