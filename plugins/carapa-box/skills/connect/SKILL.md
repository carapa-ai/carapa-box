---
name: connect
description: Configure named direct CarapaBox MCP connections in Codex, including authentication and SSH tunnels on Linux or WSL. Use for connecting controllers or repairing connection setup.
---

# Connect CarapaBox

Use this plugin on a Linux/WSL operator host. Read [connection setup](../../references/connections.md).
Reuse the stable installed helper when present; install it only when missing or update it when
needed for a changed helper. Native MCP config must not depend on a versioned plugin cache path.

Inspect the selected Codex configuration and existing operator inventory. Reuse known endpoints,
SSH aliases and credential files. Use one native `carapa_box_<name>` MCP server per controller
(for example `carapa_box_local`); the bare name `carapa_box` is invalid.
The plugin contains skills and helpers, not an MCP server. Tools are exposed under each native
server's namespace; adding a connection may require an MCP reload or a new task.

Use loopback HTTP for a local controller and HTTPS for direct remote access. For SSH-only hosts,
install a named tunnel to remote loopback, start it, and verify authenticated readiness. Register
the public/proxied controller root or `/api/mcp` URL, preserving any proxy prefix.
Sandbox ingress HTTP/SSH ports are application endpoints, not controller MCP endpoints.
For ingress or egress proxy setup, use the operator skill; these proxies do not change the
native MCP registration or its API-token authentication.

For an existing controller, inspect its selected connection/deployment metadata and test its
known HTTP endpoint before considering installation or startup. A Docker socket permission error
or an empty port listing from restricted execution does not establish that the controller is
stopped. Use the environment's approval mechanism for a necessary blocked host check; do not
restart or deploy a controller to resolve limited visibility.

Read credentials through the configured header helper. Never invoke `headers.py` manually in
a model-visible tool call: its stdout intentionally contains the authorization header for Codex.
For authorized first-time setup, use the operator workflow to generate separate API and admin
tokens. Register `--admin-token-file` for operator administration; never reuse the API token for it.
Do not ask for token values in chat. Empty or missing credential files fail connection setup.
The operator inventory's token files are local to the machine running Codex; host checkout paths
refer to the selected local/SSH operator host. Keep credentials outside sandbox mount roots.

Run the helper's `check` command and then discover the native MCP server's tools. Check each
controller separately. HTTP health/tool checks alone do not validate an MCP session or sandbox.
An unreachable remote controller is not a reason to use a different host.

Report the registered name, file locations, and checks without credential values. Distinguish
"registered; HTTP checks passed" from "native MCP tools verified"; use the latter only after
actual native discovery or a read-only MCP call succeeds.

Label the configured URL as the **MCP/API endpoint** and show it as configuration text. It is
authenticated machine access, not a browser preview; do not open it or mark it as a web deliverable.
For a browser link, verify the selected controller's `/admin/` route and label it **Admin dashboard**.
Preserve reverse-proxy prefixes; see the URL guidance in the connection reference. A normal browser
request to the API without a bearer token returns 401 even when Codex can connect successfully.
Disabling/uninstalling the plugin does not remove native MCP registrations or persistent tunnels.
