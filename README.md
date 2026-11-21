# CarapaBox

A secure sandbox environment for AI agents. Manage Docker Compose stacks through admin-verified configurations via a human-friendly **CLI** or a **Model Context Protocol (MCP)** server.

## Status

**Alpha (v0.1.0).** Interfaces, configuration variables and stack layout can change between 0.x releases without a migration path. Read [`CHANGELOG.md`](CHANGELOG.md) before updating.

- **Supported host:** Linux with Docker Engine. The OpenShell and microVM runners are experimental (see [`docs/multi-host.md`](docs/multi-host.md)).
- **Components:** [CarapaBoard](https://github.com/carapa-ai/carapa-board) is the orchestrator that normally drives the box, and shared agent skills come from [carapa-agent-kit](https://github.com/carapa-ai/carapa-agent-kit). CarapaBrain (objectives engine) is referenced in examples and docs; coming soon.

**Codex plugin:** [Connect local and remote CarapaBox hosts](plugins/carapa-box/README.md) through
native MCP connections, with sandbox-management and operator-administration skills. Python is
required only for the helpers on the Codex operator machine, not on remote controller hosts.

## Architecture

CarapaBox runs in two modes. Both use the same relay path — no config changes needed.

### Host mode (development)

```
┌─────────────────────────────────────────────────────────────────┐
│                          HOST                                   │
│                                                                 │
│  ┌───────────────────────┐      Docker CLI       ┌───────────┐  │
│  │  carapa-box           │◄─────────────────────►│  Docker   │  │
│  │  (bun run start:http) │                       │  Daemon   │  │
│  └───────────────────────┘                       └───────────┘  │
│           ▲ :3100                                      │        │
│           │ MCP (HTTP)                                 │        │
│           │                                            ▼        │
│  ┌────────┴──────────────────────────────────────────────────┐  │
│  │  agent_egress_{project} (per-instance, internal)          │  │
│  │                                                           │  │
│  │  ┌──────────┐ api-relay  ┌─────────────────────────────┐  │  │
│  │  │ AI Agent │───────────►│ squid / api-relay / llama   │  │  │
│  │  │ (no sock)│            │ (dynamically connected)     │  │  │
│  │  └──────────┘            └─────────────────────────────┘  │  │
│  │          ✗ cannot reach other agents' networks            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Container mode (production)

```
┌─────────────────────────────────────────────────────────────────┐
│                           HOST                                  │
│                                                                 │
│  ┌───────────────────────────────────┐          ┌───────────┐   │
│  │  carapa-box container             │  docker  │  Docker   │   │
│  │  (read-only rootfs, cap_drop ALL) │◄────────►│  Daemon   │   │
│  │  docker.sock mounted (r/w)        │  .sock   │           │   │
│  └───────────────────────────────────┘          └───────────┘   │
│           ▲ :3100                                      │        │
│           │                                            │        │
│  bot → api-relay → host.docker.internal:3100           ▼        │
│           │                                                     │
│  ┌────────┴──────────────────────────────────────────────────┐  │
│  │  agent_egress_{project} (per-instance, internal)          │  │
│  │                                                           │  │
│  │  ┌──────────┐ api-relay  ┌─────────────────────────────┐  │  │
│  │  │ AI Agent │───────────►│ squid / api-relay / llama   │  │  │
│  │  │ (no sock)│            │ (dynamically connected)     │  │  │
│  │  └──────────┘            └─────────────────────────────┘  │  │
│  │          ✗ cannot reach other agents' networks            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Why this design?** AI Agents manage sandboxes without direct Docker socket access, eliminating container escape risks. In container mode, carapa-box itself is hardened (read-only rootfs, no capabilities, seccomp + AppArmor) — the Docker socket is the only privileged resource it holds.

## Security Model

- **No arbitrary container creation** - Only pre-defined stacks can be started
- **Admin-managed stacks** - Each stack is a folder with `docker-compose.yml`, `.env`, and optional lifecycle hooks
- **Isolated from Docker socket** - Clients communicate via MCP, not Docker API
- **Bearer token authentication** - Managed via `CARAPA_BOX_API_TOKEN` for the API and `CARAPA_BOX_ADMIN_TOKEN` for the Admin Dashboard (see [SECURITY.md](./SECURITY.md))
- **Trusted control-plane tools** - `sandbox_exec` uses image commands for stacks declaring `x-carapa-command-source: image`; other stacks prefer protected overrides in `/usr/local/stack-cli-bin` before image defaults in `/usr/local/ai-cli-bin`
- **OPA/Rego command policies** - Per-stack `.rego` policies compiled to WASM authorize normalized trusted-tool invocations by service
- **Hot-reloadable network policies** - YAML-based domain allowlists applied to the Squid egress proxy without restart
- **Resource limits** - Stacks can define CPU, memory, and process limits
- **Network isolation** - Each agent instance gets its own internal bridge network (`agent_egress_{project}`); agents cannot see each other. Outbound traffic is routed through an egress proxy with a domain allowlist
- **SSH key isolation** - Git SSH keys never enter sandbox containers; remote git operations run in ephemeral containers via `sandbox_git`
- **Shared ingress** - Optional [HTTP and SSH ingress](docs/ingress.md) exposes sandbox endpoints to approved network clients through one hardened proxy, replacing per-stack port publishing and `portonly` networks while retaining existing nginx HTTPS routing.
- **Private installation data** - Keep live configuration, environment settings, and durable reservations outside development checkouts. See [installation data](docs/installation-data.md).
- **gVisor (runsc) support** - Agent containers can run under gVisor for kernel-level isolation. gVisor intercepts all syscalls in user space — a kernel exploit inside the sandbox never reaches the host kernel. Install with `sudo bash scripts/install-gvisor.sh`, then add `runtime: runsc` to agent services in your stack's `docker-compose.yml`
- **Tamper-resistant audit logs** - Set `LOG_DRIVER=journald` in `.env` to route container logs to the systemd journal, outside the container — a compromised process cannot alter them. Falls back to `json-file` if not set or unsupported. Enable FSS (`journalctl --setup-keys`) for cryptographic sealing

## Prerequisites

CarapaBox requires Docker on the host. Bun is only needed if you are running the service directly on the host (Development mode); for production, running CarapaBox in a container is **strongly recommended**.

- **Docker Engine**: [Install Docker](https://docs.docker.com/engine/install/)
- **Docker Compose**: Must be available as `docker compose` (plugin version recommended)
- **Linux User**: Ensure your user is in the `docker` group (`sudo usermod -aG docker $USER`) so `sudo` is not required for docker commands.
- **Docker DHI login**: Ensure you are logged in to pull DHI base images (`docker login dhi.io`).
- **Docker network pool** (recommended): Each agent instance creates its own bridge network. Docker defaults to `/16` subnets, limiting you to ~31 networks total. For many concurrent agents, add to `/etc/docker/daemon.json` (create if missing), then restart: `sudo systemctl restart docker`

  ```json
  {
    "default-address-pools": [
      { "base": "172.17.0.0/12", "size": 28 }
    ]
  }
  ```

  This allocates `/28` subnets (14 hosts each), allowing ~65k agent networks instead of ~31.

- **journald logging** (recommended): For tamper-resistant audit logs, set `LOG_DRIVER=journald` in your `.env`. This routes container logs to the systemd journal where a compromised container can't alter them. Falls back to `json-file` if not set. Note: some Docker CE builds (e.g., v29.x on Ubuntu 24.04) ship without journald support — check with `dpkg -L docker-ce | grep journal`. If unsupported, leave `LOG_DRIVER` unset

- **Bun Runtime** (Host mode only): [Install Bun](https://bun.sh)
- **OPA CLI** (Host mode only): [Install OPA](https://www.openpolicyagent.org/docs/latest/#running-opa) — needed to compile `.rego` → `.wasm` policies. In container mode, OPA is bundled and policies compile automatically at startup
- **gVisor** (recommended): [Install gVisor](https://gvisor.dev/docs/user_guide/install/) or run `sudo bash scripts/install-gvisor.sh` (verifies checksums; re-run it to update). Provides kernel-level isolation for agent containers via `runtime: runsc`. Not required — agent containers work without it, but strongly recommended for production
- **Agent harnesses** (Claude Code, Codex and others) are not bundled. They run on your own provider subscriptions or API keys; see [API credential relay](#api-credential-relay) and [provider accounts](docs/provider-accounts.md).
- **Agent image**: No prebuilt image is published for the alpha. Build it locally with `stacks/rebuild-agents.sh` (or `stacks/carapa-bot/build.sh`), which builds `carapa-bot:0.1.0` and then scans it for CVEs; the scan needs `trivy` or `docker scout`, or pass `--no-scan` for a development build.

## Guided setup

Use the repository [setup skill](.agent/skills/setup/SKILL.md) for a new or
existing installation. It covers hardened container deployment, host development,
controller authentication, approved mounts, and optional egress/provider setup.
It reuses the existing build and security installers and preserves existing
configuration. Run its read-only inventory from this checkout:

```bash
bash .agent/skills/setup/scripts/inspect-setup.sh
```

On Ubuntu or Debian, install missing host prerequisites with the bundled Bash
script (omit `--install` for a read-only check; add `--mode host` for Bun/OPA):

```bash
bash .agent/skills/setup/scripts/install-prerequisites.sh --install
```

See the [prerequisite guide](.agent/skills/setup/references/prerequisites.md) for
supported platforms, installation scope, and the remaining Docker/registry steps.

After configuring and starting the controller, verify health and authentication:

```bash
bash .agent/skills/setup/scripts/check-controller.sh \
  --url http://127.0.0.1:3100 \
  --token-file /absolute/path/to/secrets/carapa_box_api_token
```

These helpers use Bash, curl, and standard host utilities; Python is not required. The smoke check does not launch containers or
execute agent tools; the [setup references](.agent/skills/setup/references/container-install.md)
cover the remaining deployment and relay checks. Docker operations run on the
operator host, never inside an agent sandbox.

## Quick Start

### Production (Container Mode) — Recommended

Ensures a hardened, read-only environment with seccomp and AppArmor profiles enforced.

```bash
# 1. Choose where to store secrets
export SECRETS_DIR="$HOME/.carapa/secrets"
mkdir -p "${SECRETS_DIR}/box"
mkdir -p "${SECRETS_DIR}/egress"

# 2. Configure
cp .env.example .env
sed -i "s|^SANDBOX_HOST_DIR=.*|SANDBOX_HOST_DIR=$(pwd)|" .env
echo "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" >> .env
nano .env   # review settings

# 3. Configure egress-proxy
cp egress-proxy/.env.example egress-proxy/.env
sed -i "s|^# SECRETS_DIR=.*|SECRETS_DIR=${SECRETS_DIR}|" egress-proxy/.env
nano egress-proxy/.env   # review & set API keys

# 4. Generate missing, separate API and admin tokens (preserves existing credentials)
bash .agent/skills/setup/scripts/ensure-controller-secrets.sh --secrets-dir "${SECRETS_DIR}/box"
# The controller Compose project expects SECRETS_DIR to point directly to this box directory.

# 5. Configure mount allowlist (deny-by-default)
cp config/mount-allowlist.example.yaml config/mount-allowlist.yaml
nano config/mount-allowlist.yaml   # add your workspace directories
cp config/policies/network-base.example.yaml config/policies/network-base.yaml   # domains all sandboxes may reach

# 6. Security
sudo bash security/install-apparmor.sh    # AppArmor profiles for infrastructure services
sudo bash scripts/install-gvisor.sh       # gVisor runtime for agent containers

# 7. Build & Run (policies are compiled automatically on first start)
bash egress-proxy/build.sh
bash build.sh
docker compose up -d
```

### Development (Host Mode)

Runs as a local process for faster iteration. Requires [Bun](https://bun.sh).

```bash
# 1. Install & build
bun install && bun run bundle

# 2. Configure mount allowlist (deny-by-default)
cp config/mount-allowlist.example.yaml config/mount-allowlist.yaml
nano config/mount-allowlist.yaml   # add your workspace directories
cp config/policies/network-base.example.yaml config/policies/network-base.yaml   # domains all sandboxes may reach

# 3. Compile security policies (.rego → .wasm)
bash scripts/compile-policies.sh

# 4. Start the server (HTTP/SSE)
bun run start:http
```

Policy `.rego` sources are versioned; generated `.wasm` files are ignored.
Compile them after cloning or changing policies. The Docker `build.sh` workflow
compiles them automatically; CI compiles and validates the generated binaries.

## Transport Modes

### Stdio (Default)

Used for local MCP clients that spawn the server as a subprocess:

```bash
bun src/index.ts
```

### HTTP/SSE

For Docker containers calling the host MCP server:

```bash
bun src/index.ts --http --port=3100
# equivalent: bun run start:http
```

**REST / HTTP endpoints** (full reference: [`docs/openapi.yaml`](./docs/openapi.yaml)):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check — `status`, `name`, `active_sessions`, `memory`, `uptime` |
| `GET` | `/status` | None | Alias for `/health` |
| `GET` | `/api/admin/info` | AdminToken | System overview (stacks, egress status) |
| `GET` | `/api/admin/stacks` | AdminToken | List all stacks with policy status |
| `GET` | `/api/admin/logs` | AdminToken | Audit log entries (JSONL) |
| `GET/POST` | `/api/admin/config` | AdminToken | Read/write `.env` files |
| `GET` | `/api/admin/stacks/:name/policy` | AdminToken | Read `policy.rego` source for a stack |
| `GET/POST/PUT/DELETE` | `/api/admin/relay-token/:name` | ApiToken or AdminToken | Read, refresh, or remove Board/Mail relay credentials |
| `GET` | `/api/admin/relay-identity/:name` | ApiToken or AdminToken | Resolve a relay identity by name |
| `GET` | `/api/admin/provider-accounts` | ApiToken or AdminToken | List provider accounts and login status |
| `GET` | `/api/admin/provider-accounts/usage`, `/models` | ApiToken or AdminToken | Provider account usage / available models |
| `PATCH` / `DELETE` | `/api/admin/provider-accounts/:id` | ApiToken or AdminToken | Update or remove a provider account (`:id` is a UUID) |
| `POST` | `/api/admin/provider-accounts/order` | ApiToken or AdminToken | Store the manual order of provider accounts |
| `POST` | `/api/admin/provider-accounts/login` | ApiToken or AdminToken | Start a provider login |
| `POST` | `/api/admin/provider-accounts/login/:id/complete` | ApiToken or AdminToken | Submit provider login input |
| `DELETE` | `/api/admin/provider-accounts/login/:id` | ApiToken or AdminToken | Cancel a provider login |
| `GET` | `/api/admin/mcp-connections` | ApiToken or AdminToken | List remote MCP connections — see [MCP connections](docs/mcp-connections.md) |
| `POST` | `/api/admin/mcp-connections/login` | ApiToken or AdminToken | Start an MCP connection login |
| `POST` | `/api/admin/mcp-connections/login/:id/complete` | ApiToken or AdminToken | Submit MCP connection login input |
| `DELETE` | `/api/admin/mcp-connections/login/:id` | ApiToken or AdminToken | Cancel an MCP connection login |
| `POST` | `/api/admin/mcp-connections/revoke` | ApiToken or AdminToken | Revoke an MCP connection |
| `POST` | `/api/admin/tools/:name` | AdminToken | Run `sandbox_start` or `sandbox_stop` for the dashboard (other tool names return 404) |
| `GET` | `/api/tools` | ApiToken | List all registered MCP tools |
| `POST` | `/api/tools/:name` | ApiToken | Invoke a tool via REST |
| `POST` | `/api/browser/attach` | ApiToken (required) | Attach Board to a managed browser (NDJSON stream) — see [browser transport](docs/BROWSER-VIEWER.md) |
| `POST` / `DELETE` | `/api/browser/:viewerId/input`, `/api/browser/:viewerId` | ApiToken (required) | Send viewer input / detach |
| `POST` / `DELETE` | `/api/tmux/attach`, `/exec`, `/resize`, `/detach` | ApiToken (required) | tmux REST + SSE adapter; only with `ENABLE_SANDBOX_TMUX` |
| `GET` | `/admin/*` | None | Admin Dashboard UI |
| `OPTIONS` | any path | None | CORS preflight (204; non-loopback `Origin` gets 403) |
| `POST/GET` | `/` | ApiToken | MCP protocol (SSE negotiation handled by SDK) |

> Auth tokens: `ApiToken` = `CARAPA_BOX_API_TOKEN`, `AdminToken` = `CARAPA_BOX_ADMIN_TOKEN` (must be distinct from `CARAPA_BOX_API_TOKEN`; operator-only admin routes return 503 when absent or identical). The explicitly listed relay-token, relay-identity, provider-account and MCP-connection operations also accept the API token, even without an admin token configured, so Board and the trusted relay need only their existing API credential. Other admin paths and methods remain operator-only. Both tokens are read from secrets files at `SECRETS_DIR/` first, falling back to env vars. `/health`, `/status`, and `/admin/*` are always public. When `CARAPA_BOX_API_TOKEN` is unset, MCP and `/api/tools` requests from local processes are accepted without auth, while browser requests with a non-loopback `Origin` or `Host` header are rejected (403) and CORS preflights from non-loopback origins get no `Access-Control-Allow-Origin`. The browser, tmux (403) and provider-account surfaces fail closed. The controller also refuses to bind a non-loopback address (`--host=` or `MCP_SANDBOX_HOST`) when `CARAPA_BOX_API_TOKEN` is not configured. Use an MCP client library for the MCP endpoint — there are no explicit `/sse` or `/messages` routes. The MCP SDK handles all non-reserved paths.

**Admin Dashboard:** Available at `http://localhost:3100/admin/` when running in HTTP mode.

**From a trusted container** (Board, operator tools — never agent sandboxes):
- `http://host.docker.internal:3100/` (Docker Desktop)
- `http://172.17.0.1:3100/` (Linux bridge network)

## MCP Tools

### Core tools (always available)

| Tool | Description | Parameters |
|------|-------------|------------|
| `sandbox_list` | List available stacks | - |
| `sandbox_ps` | List running sandbox instances | `instance?` |
| `sandbox_start` | Start a stack (hooks, per-instance network, relay token, optional project `.agent/after-start.sh`) | `name`, `instance?`, `env?`, `service?` |
| `sandbox_stop` | Stop a stack: `docker compose down -v` removes containers **and Compose named volumes**; network/IP reservations are retained | `name`, `instance?` |
| `sandbox_status` | Get stack status (JSON) | `name`, `instance?`, `service?`, `checkUpdates?` |
| `sandbox_exec` | Execute a trusted stack override or image-built fallback in a service | `name`, `service`, `command`, `instance?`, `timeout?`, `env?` |
| `sandbox_logs` | Get logs from a service | `name`, `service?`, `tail?`, `instance?` |
| `sandbox_commands` | List available slash commands (skills/commands) in a sandbox | `name`, `service?`, `instance?` |
| `sandbox_ssh` | Get, enable, or disable key-only SSH in a running sandbox | `name`, `instance?`, `action` (`status`/`start`/`stop`) |
| `sandbox_publish_app` | Publish, inspect, or revoke one HTTP app through [shared ingress](docs/ingress.md) | `name`, `id`, `action` (`status`/`publish`/`unpublish`), `instance?`, `service?`, `targetPort?`, `hostname?`, `aliases?` (up to 8 hostnames; the project's admin-configured proxy aliases) |
| `sandbox_proxy_aliases` | Update hostname aliases of a running sandbox's generated nginx route | `name`, `aliases`, `instance?` |
| `sandbox_policy_check` | Dry-run a command against the policy engine without executing it | `name`, `service`, `command`, `instance?` |
| `sandbox_network_policy_reload` | Hot-reload network policies and apply to Squid without restart | - |
| `group_list` | List a directory inside a project's group directory on this box | `folder`, `path?` |
| `group_read` | Read a file inside a project's group directory (base64 data) | `folder`, `path`, `offset?`, `maxBytes?` |
| `group_write` | Write (atomic) or delete a file inside a project's group directory | `folder`, `path`, `data?`, `encoding?`, `remove?` |
| `sandbox_ipc_projects` | List IPC project directories (`<stack>-<instance>`) on this Box | - |
| `sandbox_ipc` | Batch file operations (stat, read, write, ...) on a sandbox's IPC directory | `tree`, `project?`, `name?`, `instance?`, `ops` |
| `sandbox_ipc_sync` | Replicate one IPC subtree with a caller-side replica | `tree`, `project?`, `name?`, `instance?`, `root`, `base`, `push?`, `maxBytes?`, `replicaId?`, `exclude?` |
| `sandbox_relay_token` | Set or clear a per-sandbox relay credential | `name`, `service?`, `value?`, `clear?` |

### Managed Services Tools (core)

Used to manage the life-cycle of the orchestrator's own components (defined in `config/managed-services.yaml`).

| Tool | Description |
|------|-------------|
| `build_service` | Build a managed service image (tags :rollback, then docker build), or queue a host build for `build: host-request` services. |
| `build_service_status` | Report a queued host build (pending, running, succeeded, failed). |
| `restart_service` | Force-recreate a managed Compose service from its current image. |

### Optional tools (enabled via `.env`)

The enable flags are checked for presence only: any non-empty value (even `false`) enables the tool. Leave the variable unset to disable it.

| Tool | Enabled by | Description |
|------|------------|-------------|
| `sandbox_git` | `ENABLE_SANDBOX_GIT=true` | Run git commands using host SSH keys (ephemeral container) |
| `sandbox_worktree` | `ENABLE_SANDBOX_GIT=true` | Manage git worktrees for isolated task branches |
| `sandbox_branch` | `ENABLE_SANDBOX_GIT=true` | Atomic git branch lifecycle: `commit` (stage + commit), `prepare_review` (commit + rebase), `inspect` (optional linked-repository hook), `merge` (merge + cleanup), `archive`/`cleanup` (remove worktree + free preview port without merging), `reject` |
| `sandbox_issues` | `ENABLE_GIT_ISSUES=true` | Read GitLab or GitHub issues: `list`, `get`, `list_comments` (ephemeral container) |

#### Issue tracker credentials

`sandbox_issues` reads GitLab or GitHub issues with a code hosting account
from Provider accounts; there is no separate issue credential file. CarapaBox
picks the account the relay would serve to the project's agent container (the
`service` input, default `agent`) for the Git remote's server: per provider,
the account of the relay client whose `match` patterns cover that container,
else the shared account. A relay client with its own `gitlab`/`github` route,
or an isolated client, gets no shared fallback for that provider. The token is
only sent to the account's own server (GitHub: `api.github.com`, or
`<server>/api/v3` on Enterprise). A GitLab token needs `read_api`; a GitHub
token needs read access to Issues. Tokens never enter Board or a sandbox and are
replaced in Provider accounts when revoked. GitHub lists pull requests among
issues; Board's import skips them.

## Network Security

Each agent instance runs on its own isolated internal bridge network (`agent_egress_{project}`) with no direct internet access. Agents **cannot see or reach each other** — full inter-container communication (ICC) isolation. Services (mail, wa-link) run on a separate shared `agent_egress` network. The egress-proxy containers (squid, api-relay, llama-proxy) are dynamically connected to each per-instance network at start time and disconnected on stop.

```
┌─ agent_egress_bot-alice (internal) ──────────────────────────┐
│                                                              │
│   ┌─────────────┐                                            │
│   │ Agent Alice  │──┐                                        │
│   └─────────────┘   │                                        │
│                     ▼                                        │
│              ┌─────────────┐   ┌─────────────┐               │
│              │ squid proxy │──►│ internet     │               │
│              │ api-relay   │   │ (allowed     │               │
│              │ llama-proxy │   │  domains)    │               │
│              │ playwright  │   └─────────────┘               │
│              └─────────────┘                                 │
└──────────────────────────────────────────────────────────────┘
         ▲ dynamically connected           ▲ dynamically connected
         │                                 │
┌─ agent_egress_bot-bob (internal) ────────┼───────────────────┐
│                                          │                   │
│   ┌─────────────┐                        │                   │
│   │ Agent Bob   │──── same proxies ──────┘                   │
│   └─────────────┘    (can't see Alice)                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌─ agent_egress (shared, internal) ────────────────────────────┐
│  carapa-mail, carapa-wa-link (long-running services)         │
│  Agents reach these via api-relay, not direct DNS            │
└──────────────────────────────────────────────────────────────┘
```

**How it works**: When `startStack()` is called with a project name, it creates `agent_egress_{project}` as an `--internal` bridge, starts the stack on that network, then runs `docker network connect` for the proxy containers. On `stopStack()`, the proxies are disconnected and the network is removed. Orphaned networks are cleaned up at startup.

**Related**: [sandbox-to-host paths](./egress-proxy/README.md#network-topology-and-sandbox-to-host-paths) (api-relay routes, llama-proxy ports and squid `host_services` are three separate routes to the host, and `host_deny_ports` must match non-default Board or carapa-box ports), [isolation between projects](./docs/mount-allowlist.md#isolation-between-projects) (shared vs per-project `AGENT_HOME` and `GROUP_DIR`), and [web tools](./docs/security-policies.md#web-tools) (how sandboxes reach the open web through Board).

### Agent → CarapaBox isolation

Agent containers should **not** have a route to CarapaBox. CarapaBox holds the Docker socket — if an agent could reach it directly, a vulnerability in the MCP/REST request handling could be exploited to gain Docker daemon access. Instead, CarapaBoard manages sandbox lifecycle on behalf of agents via the REST API. Agents only reach the api-relay for inference (provider credentials) and internal services (board API, WhatsApp, mail) — never CarapaBox itself. Do not add a `sandbox-relay` service entry to agent relay-client configs.

### Setup

The egress proxy runs as a shared stack that all agent stacks depend on. **It is started automatically by the host MCP server on first run**, but can be managed manually if needed:

```bash
# Manual management of the egress proxy
cd egress-proxy
cp .env.example .env
bash build.sh
docker compose up -d
```

### Allowed domains

Domain allowlists are managed entirely through YAML policy files:

- **Base domains** (shared by all stacks): `config/policies/network-base.yaml`
- **Per-stack domains**: `stacks/{name}/network-policy.yaml`

Changes are hot-reloaded (~2s debounce) — no restart needed. Each stack can only access base domains plus its own stack-specific domains (enforced via Squid src ACLs). The generated config is written to `generated/squid-generated.conf`.

### API credential relay

The egress proxy includes an `api-relay` service that injects API keys into outbound requests so agent containers never see raw credentials. Agents talk to the relay over HTTP on the internal network; the relay adds the real API key and forwards upstream over HTTPS through Squid.

```
agent container        api-relay              api.anthropic.com
  (no API key)    (holds real key)              (upstream)
       │                  │                        │
       │  HTTP (internal) │   HTTPS (via squid)    │
       ├─────────────────►├───────────────────────►│
       │  no auth header  │  + x-api-key: sk-...   │
       │◄─────────────────┤◄───────────────────────┤
```

**Built-in providers** (path-based routing on port 8080):

| Path prefix | Upstream | Auth header | Status |
|-------------|----------|-------------|--------|
| `/anthropic/...` | `api.anthropic.com` | `Authorization: Bearer` (OAuth) / `x-api-key` (static) | Working via relay |
| `/openai/...` | `api.openai.com` | `Authorization: Bearer` | Ready (needs API key) |
| `/google/...` | `generativelanguage.googleapis.com` | OAuth or API key (`?key=`) | Tested (API key mode). Gemini CLI with OAuth bypasses relay — uses Squid directly |
| `/codex/...` | `chatgpt.com/backend-api/codex/` | `Authorization: Bearer` (ChatGPT OAuth) | Working via relay |
| `/antigravity/...` | `cloudcode-pa.googleapis.com` | Google OAuth ([provider accounts](docs/provider-accounts.md)) | Antigravity ACP/SDK |
| `/openrouter/...` | `openrouter.ai/api` | API key (`openrouter_api_key`) | Ready (needs API key) |
| `/nvidia/...` | `integrate.api.nvidia.com` | API key (`nvidia_api_key`) | Ready (needs API key) |
| `/mistral-eu/...` | `api.eu.mistral.ai` | API key (`mistral_api_key`) | EU-processed only (+10% price) |
| `/mistral-vibe/...` | `api.eu.mistral.ai` | Vibe CLI key (`mistral_vibe_api_key`) | Mistral Vibe harness; plan's Vibe Code usage |

**Provider notes:**
- **Claude Code** — supports `ANTHROPIC_BASE_URL`, works through relay. Requires the `anthropic-beta: oauth-2025-04-20` header for OAuth (injected automatically by relay).
- **Gemini CLI** — OAuth mode hardcodes `cloudcode-pa.googleapis.com` and ignores `GOOGLE_GEMINI_BASE_URL`, so **OAuth cannot go through the relay**. The CLI connects directly via `HTTPS_PROXY` through Squid and handles token refresh internally. Requires `~/.gemini/oauth_creds.json` in the agent container. API key mode supports the relay (see [docs/api-relay-setup.md](./docs/api-relay-setup.md)). Also requires `coreutils` in Alpine (BusyBox `env` lacks the `-S` flag used in the CLI's shebang).
- **Codex** — uses `chatgpt.com/backend-api/codex/` (ChatGPT subscription). Supports base URL override via relay; do **not** place `auth.json` in the container home directory or Codex will bypass the relay. See [docs/api-relay-setup.md](./docs/api-relay-setup.md) for full setup.

**Two auth modes** (per provider, checked in order):

1. **OAuth credentials file** — for Claude Max, Codex (ChatGPT), etc. The relay reads the access_token, injects it into requests, and auto-refreshes on 401. Solves the refresh token race condition when multiple containers share credentials. (Exception: Gemini OAuth bypasses the relay — see above.)
2. **Static API key** — from environment variable. Simplest option for pay-per-use API keys.

**Setup with static API keys:**

1. Store API keys as secrets files (preferred) or in `egress-proxy/.env` (fallback). Only set the providers you use:
   ```bash
   # Preferred: secrets files (invisible in docker inspect and /proc/*/environ)
   echo "sk-ant-..." > "${SECRETS_DIR}/anthropic_api_key"
   echo "sk-..."     > "${SECRETS_DIR}/openai_api_key"
   echo "AIza..."    > "${SECRETS_DIR}/google_api_key"

   # Fallback: env vars in egress-proxy/.env
   # ANTHROPIC_API_KEY=sk-ant-...
   # OPENAI_API_KEY=sk-...
   # GOOGLE_API_KEY=AIza...
   ```

2. Agent stacks point their base URL at the relay instead of the real API:
   ```yaml
   # in agent docker-compose.yml
   environment:
     - ANTHROPIC_API_KEY=placeholder
     - ANTHROPIC_BASE_URL=http://api-relay:8080/anthropic
   ```

3. Add `api-relay` to the agent's `NO_PROXY` list so requests go directly to the relay, not through Squid.

**Setup with OAuth (Claude, Codex, Antigravity):**

1. Configure `PROVIDER_ACCOUNTS_DIR` in both CarapaBox's `.env` and `egress-proxy/.env` (see [provider accounts](docs/provider-accounts.md)).
2. Connect the account in CarapaBoard → **Provider accounts**, as the shared default or for a named relay client. Without Board, use the operator CLI `bun scripts/provider-accounts.ts`.
3. Agent stacks use the same base URL — set `ANTHROPIC_API_KEY=` (empty, to suppress Claude Code's login prompt) and `ANTHROPIC_BASE_URL=http://api-relay:8080/anthropic`. The relay uses the managed OAuth credentials instead of a static key.

The former `CLAUDE_CREDENTIALS_DIR` / `CODEX_CREDENTIALS_DIR` relay settings are retired. Relay clients that need a manually managed file can still reference it with an explicit `credentialFile` under `OAUTH_CLIENT_CREDENTIALS_DIR`, whose relay mount is opt-in (see [API relay setup](docs/api-relay-setup.md)).

The relay handles token refresh automatically: a scheduler checks credentials every minute and refreshes Claude tokens within 30 minutes of expiry (Codex within 5 minutes). When the upstream API returns 401, it uses the refresh_token to obtain a new access_token, writes the updated credentials back to the file, and retries the request. Only one refresh runs at a time (concurrent requests wait for the in-flight refresh to complete), which eliminates the race condition from sharing credentials across containers.

**Squid traffic logging:**

All CONNECT requests through Squid are logged to `docker logs egress-proxy-squid-1`, showing target hosts and response codes. This captures traffic from tools that bypass the relay (e.g., gemini-cli going directly through `HTTPS_PROXY`).

**Adding a new provider:**

1. Add an entry to the `PROVIDERS` object in `egress-proxy/api-relay.mjs`:
   ```js
   myservice: {
     host: 'api.myservice.com',
     envKey: 'MYSERVICE_API_KEY',
     getAuth() {
       const key = readSecret(this.envKey);  // reads /run/secrets/ first, then env var
       if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
       return null;
     },
     refresh: null,
   },
   ```

2. Add a Docker secret in `egress-proxy/docker-compose.yml`:
   ```yaml
   secrets:
     myservice_api_key:
       file: ${SECRETS_DIR}/myservice_api_key
   ```
   And reference it in the `api-relay` service's `secrets:` list.

3. Create the secrets file (preferred) or set the env var (fallback):
   ```bash
   echo "your-api-key" > "${SECRETS_DIR}/myservice_api_key"
   ```

4. Ensure the upstream domain is in the network policy (`config/policies/network-base.yaml` or the relevant `stacks/{name}/network-policy.yaml`).

The relay strips any incoming `authorization` and `x-api-key` headers before forwarding, so agents cannot bypass the relay's credentials. Streaming (SSE) is fully supported.

### Local LLM access (llama-proxy)

Agent containers have no direct route to the host. The `llama-proxy` service in the egress-proxy stack forwards HTTP from the agent's per-instance network to the host via the `hostaccess` bridge, so agents can reach local LLM servers (llama.cpp, Ollama, LiteLLM, etc.) without getting host network access. It also applies request transforms that protect llama.cpp prompt-cache reuse (system-message hoisting, billing-header stripping) and optional per-profile tool filtering from `tool_profiles.jsonc` (see the header of `egress-proxy/llama-proxy.mjs`).

```
agent ──► llama-proxy:PORT ──► host.docker.internal:PORT ──► local LLM server
          (agent_egress_*)      (host_access bridge)
```

The proxy listens on ports `3001`, `8881`, `11434` (Ollama) and `12434`, each forwarded to the same port on `host.docker.internal`. The list is set by `PORTS` in `egress-proxy/docker-compose.yml`; edit it to match your LLM server. Model-management calls for Ollama (`/api/pull`, `/api/delete`, ...) and Docker Model Runner (non-GET requests under `/models`) are blocked for sandboxes on every port. (`LLAMA_PORT` applies only to the legacy `docker-compose-socat.yml` variant.)

**Agent-side configuration:**

1. Add `llama-proxy` to the `NO_PROXY` list in your agent stack's compose, so requests go directly to the proxy instead of through Squid:
   ```yaml
   - NO_PROXY=localhost,127.0.0.1,mcp-relay,api-relay,llama-proxy
   ```

2. Point agent configs at `llama-proxy` instead of `host.docker.internal`:
   ```bash
   # Claude with local LLM (claude-ollama.sh)
   ANTHROPIC_BASE_URL=http://llama-proxy:8881/v1

   # OpenCode config (~/.opencode/opencode.jsonc)
   { "provider": { "llamacpp": { "options": { "baseURL": "http://llama-proxy:8881/v1" } } } }
   ```

## CLI Usage

The project includes a built-in CLI wrapper. You can use full tool names (`sandbox_start`) or shorter aliases (`start`).

```bash
# syntax: bun call <tool|alias> [args...] [-i instance]

# List stacks
bun call list          # alias for sandbox_list

# Start a stack
bun call start openclaw  # alias for sandbox_start

# Status
bun call status openclaw # alias for sandbox_status

# Execute a trusted stack override or image-built fallback
bun call exec carapa-bot agent "carapa-repository-scan /workspace/group 2 node_modules"

# Stop
bun call stop openclaw

# Build stack images (CLI only)
bun call build openclaw

# Stop all running instances (CLI only)
bun call stop-all

# Start a specific instance
bun call sandbox_start openclaw -i <instance_name>
```

<details>
<summary>Optional: Create a shell alias</summary>

To make it even shorter (`mcp sandbox_start ...`), add this to your shell config:

```bash
alias mcp="bun call"
```
</details>

## Parallel Instances

Run multiple copies of the same stack using the `instance` parameter:

```bash
# Start two instances of the same stack
bun call sandbox_start example -i user1
bun call sandbox_start example -i user2

# Execute a trusted tool in a specific instance
bun call sandbox_exec carapa-bot agent "carapa-repository-scan /workspace/group 2 node_modules" -i user1

# Stop specific instance
bun call sandbox_stop example -i user1
```

Each instance gets:
- **Unique Compose project and container names**: `example-user1-sandbox-1`, `example-user2-sandbox-1`
- **Isolated networks**: its own internal `agent_egress_example-user1` bridge (for stacks using the agent network)
- **Independent volumes**: each instance has its own named volumes (removed by `sandbox_stop`)

### Project Overrides

When starting an instance (e.g., `-i user1`), if `docker-compose.override.<stack>-user1.yml` (the full Compose project name, e.g. `docker-compose.override.example-user1.yml`) exists in the stack directory, it will be automatically applied. Use this for per-user customization or resource limits.

### External Networks

Any network marked as `external: true` in `docker-compose.yml` is automatically created on-the-fly before the stack starts. This simplifies setup for shared services like `egress-proxy`.

## Stack Structure

Each stack lives in `stacks/<name>/`:

```
stacks/openclaw/
├── docker-compose.yml     # Required: compose file
├── Dockerfile.*           # Optional: custom images
├── .env                   # Optional: environment variables
├── policy.rego            # Required: OPA/Rego command policy (source)
├── policy.wasm            # Required: compiled policy (run scripts/compile-policies.sh)
├── env-passthrough.yaml   # Optional: env vars callers can inject via sandbox_start
├── network-policy.yaml    # Optional: stack-specific allowed domains (hot-reloaded)
├── before-start.sh        # Optional: runs before docker compose up
├── after-start.sh         # Optional: runs after containers start
├── before-stop.sh         # Optional: runs before docker compose down
└── after-stop.sh          # Optional: runs after containers stop
```

### Project startup hook

Projects can add `.agent/after-start.sh` to the sandbox service's configured
working directory. After each `sandbox_start` (including Board-managed restarts),
CarapaBox runs this optional hook **inside the sandbox**, after the controller's
stack `after-start.sh` and relay-token setup. No per-project controller edits are
needed. For example, a project with an existing Bash app launcher can use:

```sh
#!/bin/sh
exec bash scripts/start-external.sh
```

- The hook runs with `sh`, no arguments, the service's configured working
  directory and user, and its existing container environment. Controller secrets
  and worktree `PROVISION_*` variables are not forwarded.
- `sandbox_start.service` selects the service; the default is `agent`. Stacks
  without an `agent` service skip the hook unless a service is explicitly selected.
- Missing hooks are skipped. A present hook must finish within 120 seconds;
  `timeout` must be available in the image (GNU coreutils or BusyBox). A failure
  or timeout makes `sandbox_start` return an error while leaving the sandbox
  running for diagnosis. Hook output is included in lifecycle logs.
- Reuse an idempotent launcher: start the app detached from the hook, redirect
  its input/output, retain logs and a stop command, check readiness, then return.
  Do not leave a foreground server attached to the hook's output pipes.
- Only the configured checkout is used; worktrees and nested repositories are
  not scanned. A shared workspace's hook can launch its intended child apps.
- When Docker's restart policy brings the sandbox back on its own (host reboot,
  OOM recovery), CarapaBox reruns only this project hook — detected by the
  container's changed start time, both live and in a boot sweep. Stack host hooks
  are not rerun. It is not an app crash supervisor or a browser-preview hook.

Upgrade the controller before relying on this contract. The controller-owned
`stacks/<stack>/after-start.sh` remains a separate hook and retains its behavior.

### Per-stack environment

Each stack has its own `.env` file for stack-specific settings. For agent stacks (e.g. `carapa-bot`), the key variable is:

| Variable | Description |
|----------|-------------|
| `AGENT_HOME` | Host directory bind-mounted as the agent's home (`/home/ubuntu`). Contains CLI settings, shell history, and tool configs (`.claude/`, `.codex/`, `.gemini/`, etc.). Create a dedicated directory per stack — do not point it at your real `$HOME`. Must be in the mount allowlist. |

**Important: OAuth tokens for Claude and Codex must NOT be in `AGENT_HOME`.** Real credentials live only in the provider-accounts directory, which is mounted into the `api-relay` container (and rejected as a sandbox mount) — never into agent containers. This ensures agents cannot read raw OAuth tokens; they access APIs through the relay which injects credentials on their behalf.

**Exception: Gemini CLI** requires `~/.gemini/oauth_creds.json` inside the agent container because it handles OAuth internally and hardcodes `cloudcode-pa.googleapis.com` — the relay cannot intercept or inject credentials for it. See [Google Gemini CLI](./docs/api-relay-setup.md#google-gemini-cli) for details.

```bash
# 1. Copy your CLI config directories (settings, history, keybindings, etc.)
cp -r $HOME/.claude $HOME/.carapa/agent-home/.claude
cp -r $HOME/.codex  $HOME/.carapa/agent-home/.codex
cp -r $HOME/.gemini $HOME/.carapa/agent-home/.gemini  # Gemini needs creds in container

# 2. Remove OAuth credential files from the copies — agents must never see these
#    (Gemini is excluded — it needs oauth_creds.json to authenticate)
rm -f $HOME/.carapa/agent-home/.claude/.credentials.json
rm -f $HOME/.carapa/agent-home/.codex/auth.json

# 3. Set AGENT_HOME in the stack .env
echo "AGENT_HOME=$HOME/.carapa/agent-home" >> stacks/carapa-bot/.env

# 4. Connect the real accounts in CarapaBoard -> Provider accounts
#    (credentials go only to the relay; see docs/provider-accounts.md)
```

You can share one `AGENT_HOME` across multiple agent stacks, or create separate copies per stack if you want isolated settings/history.

The `AGENT_HOME` path (or its parent) must be listed in `config/mount-allowlist.yaml` — see [Mount security](#mount-security) below.

### policy.rego

Authorizes normalized stack overrides and image-built fallback tools for `sandbox_exec` by service, written in [OPA/Rego](https://www.openpolicyagent.org/docs/latest/policy-language/) and compiled to WASM. See [docs/security-policies.md](./docs/security-policies.md) for full details.

After editing, compile with:

```bash
bash scripts/compile-policies.sh
```

**Trusted-tool mode** — restrict the agent service to normalized tools supplied
by the stack's protected `bin/` directory:

```rego
package carapabox.stack.my_stack

import data.carapabox.base
import rego.v1

default allow := false

allow if {
    input.service == "agent"
    count(input.segments) == 1
    regex.match(`^/usr/local/(ai|stack)-cli-bin/[^/[:space:]]+([[:space:]]|$)`, input.command)
}

deny contains reason if { some reason in base.deny }
```

Before policy evaluation, stacks declaring `x-carapa-command-source: image`
resolve bare commands to `/usr/local/ai-cli-bin/<name>`. For other stacks,
`sandbox_exec` checks for a same-name immediate executable in the protected `bin/`. A valid override is normalized to
`/usr/local/stack-cli-bin/<name>`; if no stack entry exists, the name is
normalized to the image-owned `/usr/local/ai-cli-bin/<name>`. Present but
invalid overrides are rejected rather than bypassed. Exact immediate-child
paths in either directory are accepted (stack paths receive the same host
validation). The normalized argv is executed without a shell. The agent
itself can still use its internal tools freely inside the container: this gate
only restricts what the host orchestrator launches through `sandbox_exec`.
`sandbox_exec` stays shell-free and accepts exactly one composite form, the Board's restart-recovery receipt suffix
(`run-agent.sh /workspace/ipc/runs/<id> && : > /workspace/ipc/runs/<id>/.restart-recovery-dispatched`); the box creates
the receipt after a successful exit.

See [docs/security-policies.md](./docs/security-policies.md) for the full policy structure reference, including env passthrough via `env-passthrough.yaml` and network policies via `network-policy.yaml`.

## Managed Services

Managed services are system components (like the Carapa Board UI or the Brain agent) whose deployment lifecycle is controlled by CarapaBox. This allows for automated updates, rollbacks, and health monitoring.

Configuration: `config/managed-services.yaml`
Documentation: [Managed Services Docs](docs/managed-services.md)

## Git Worktrees

The `sandbox_worktree` tool allows agents to work on isolated task branches using Git worktrees. This prevents task cross-contamination and allows multiple instances of the same stack to work on different branches of the same repository simultaneously.

Documentation: [Git Worktrees Docs](docs/git-worktrees.md)

## Available Stacks

| Stack | Description | Documentation |
|-------|-------------|---------------|
| `egress-proxy` | Shared egress proxy (squid + api-relay + llama-proxy) | [README](egress-proxy/README.md) *(infrastructure, not in stacks/)* |
| `carapa-bot` | AI agent sandbox (Claude, Gemini, Codex, etc.) | [README](stacks/carapa-bot/README.md) |
| `example` | Minimal example stack and policy | |

Other Carapa services (Board, Mail, WhatsApp link) are deployed from their own repositories; CarapaBox can build and recreate them as [managed services](#managed-services).

### Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_SANDBOX_PORT` | HTTP server port | `3100` |
| `MCP_SANDBOX_HOST` | HTTP bind address (`--host=` overrides). Non-loopback binds require `CARAPA_BOX_API_TOKEN` | `127.0.0.1` |
| `CARAPA_BOX_API_TOKEN` | Bearer token for MCP/REST API auth. **Read from secrets file** at `SECRETS_DIR/carapa_box_api_token` (falls back to env var) | *(none)* |
| `CARAPA_BOX_ADMIN_TOKEN` | Bearer token for `/api/admin/*` routes. **Read from secrets file** at `SECRETS_DIR/carapa_box_admin_token` (must be distinct from `CARAPA_BOX_API_TOKEN`; admin routes return 503 when absent or identical) | *(none)* |
| `SANDBOX_STACKS_DIR` | Directory containing stack definitions | `./stacks` |
| `ENABLE_SANDBOX_GIT` | Enable `sandbox_git`, `sandbox_worktree`, `sandbox_branch` tools | *(disabled)* |
| `ENABLE_GIT_ISSUES` | Enable `sandbox_issues` tool | *(disabled)* |
| `ENABLE_SANDBOX_TMUX` | Enable the `/api/tmux/*` REST+SSE routes (board shell bridge) | *(disabled)* |
| `AUDIT_LOG_PATH` | Path to audit JSONL log file (rotates at 50 MB, one `.1` backup) | `/var/log/carapabox/audit.jsonl` in the container, otherwise `generated/audit.jsonl` in the project directory (gitignored) |
| `SANDBOX_HOST_DIR` | Absolute host path of this project — required for containerised mode | *(none)* |
| `SSH_KEYS_FOLDER` | Host `.ssh` directory for git remote operations via `sandbox_git` | *(none)* |
| `GIT_REMOTE_PIN_REQUIRED` | When `true`, keyed remote git operations (`sandbox_git` push/fetch/pull/clone/ls-remote, `sandbox_worktree` add/reset fast-forward, `sandbox_branch` merge `autoPush`, linked-repository pushes) are refused with `[SECURITY] remote URL not pinned` unless the caller passes `remoteUrl`. When unset, unpinned operations still run but log `[git] unpinned remote`. Operators enable it after the board passes `remoteUrl`. A given `remoteUrl` (SSH only) is used through a box-owned staging repo, so the agent-writable `.git/config` (`remote.*.url`, `pushurl`, `insteadOf`) never selects the remote. Note: `StrictHostKeyChecking=no` is unchanged (an `accept-new` known_hosts needs a writable box-owned file mounted into the keyed container and was not verified to keep first-contact pushes working). | *(unset)* |
| `IPC_MOUNT` | Host IPC directory for inter-container communication (a stack `.env` value takes precedence) | *(none; falls back to `$CARAPA_DATA_DIR/data/ipc`, then `CARAPA_BOX_IPC_HOST_DIR`)* |
| `LOG_LEVEL` | Controller log level (pino); the one-shot CLI defaults to `warn` | `info` |
| `LOG_COLOR` | Set to `false` to disable colored dev logs (ignored when `NODE_ENV=production`) | *(colored)* |
| `CARAPA_BOX_IPC_DIR` | Path where the IPC tree is mounted inside a containerised Box (set to `/app/ipc` by `docker-compose.yml`); with `CARAPA_BOX_IPC_HOST_DIR` it translates `IPC_MOUNT` | *(none)* |
| `CARAPA_BOX_GROUPS_DIR` | Path where `CARAPA_BOX_GROUPS_ROOT` is mounted inside a containerised Box (`/app/groups` when the root is set); used by `group_*` tools | falls back to `CARAPA_BOX_GROUPS_ROOT` |
| `CARAPA_BOX_BUILTIN_POLICIES_DIR` | Image-baked policy directory; its `base.wasm` is used only when the configured policies directory has none | *(none)* |
| `CARAPA_BOX_APP_ROOT` | Directory holding the `VERSION` and `BUILD_TIME` files reported by `/health` | auto-detected app root |
| `CARAPA_BOX_KIND` | Box kind reported to a hub: `native` or `docker` (any other value is `docker`) | `docker` |
| `CARAPA_HUB_ALLOW_INSECURE` | Set to `1` to allow `ws://` to a non-local hub; trusted private networks only | *(wss:// required)* |
| `CARAPA_COMPOSE_CLI_IMAGE` | Docker CLI image for helper containers that run docker/compose commands | `docker:29.5.3-cli` |
| `SANDBOX_EGRESS_PROXY_DIR` | Override egress-proxy directory path | `./egress-proxy` |
| `DOCKER_GID` | Docker socket group, baked in at build time (container mode) | `999` |
| `BOX_UID` / `BOX_GID` | Controller runtime identity (container mode) | `1000` |
| `ENABLE_NGINX_PROXY`, `NGINX_PROXY_*` | Generated host-nginx routes per running project (see `.env.example`) | *(disabled)* |
| `ENABLE_INGRESS_PROXY`, `INGRESS_*` | Shared HTTP/SSH ingress — see [docs/ingress.md](docs/ingress.md) | *(disabled)* |
| `PROVIDER_ACCOUNTS_DIR`, `PROVIDER_*` | Board-managed provider logins — see [docs/provider-accounts.md](docs/provider-accounts.md) | *(disabled)* |
| `CARAPA_BOX_HOME` and `CARAPA_BOX_*_HOST_DIR` | Private installation directory — see [docs/installation-data.md](docs/installation-data.md) | *(repository-local)* |

`ENABLE_SANDBOX_GIT`, `ENABLE_GIT_ISSUES` and `ENABLE_SANDBOX_TMUX` are checked for presence only: any non-empty value (even `false`) enables the feature.

### Mount Security

CarapaBox validates all host paths used as Docker bind-mount sources (`LOCAL_REPO`, `GROUP_DIR`, `IPC_MOUNT`, `AGENT_HOME`) against `config/mount-allowlist.yaml`. Any path not under an allowed directory is blocked with a `[SECURITY] Mount path blocked` error.

```yaml
# config/mount-allowlist.yaml
allowed:
  - $HOME/projects          # workspace repos (LOCAL_REPO)
  - $HOME/.carapa           # agent homes, secrets, groups (AGENT_HOME, GROUP_DIR)
  - /var/lib/carapa/ipc     # IPC mount
```

Add the parent directories that cover your `AGENT_HOME`, `LOCAL_REPO`, `GROUP_DIR`, and `IPC_MOUNT` paths. Use absolute paths — environment variables are not expanded.

After validation, `sandbox_start` creates/checks the workspace (`LOCAL_REPO`) and per-instance IPC directory as the controller's numeric UID/GID (1000:1000 in the standard deployment). This also covers new repository locations saved in CarapaBoard settings. In container mode, their parent directories must already exist. Existing directories keep their permissions; an unwritable directory fails startup before the running instance is stopped. Custom stacks using another UID/GID need compatible workspace permissions.

See [docs/mount-allowlist.md](./docs/mount-allowlist.md) for implementation details.

## Development

```bash
# Start the server (stdio mode - default)
bun dev

# Start the server (HTTP mode for Docker-to-host)
bun dev:http

# Verify a change: typecheck plus only the tests the branch can affect
bun run verify:changed

# Run tests (Bun, Node.js, Git, OPA CLI, tar, OpenSSL, and local TCP listeners required)
# The full suite stays the manual and pre-release check.
ENABLE_INGRESS_PROXY=false ENABLE_SANDBOX_TMUX=1 CARAPA_BOX_CONFIG_DIR="$PWD/config" bun --no-env-file test

# Opt-in Docker integration tests
bun run test:docker

# Build/Rebuild a specific sandbox stack (Docker)
bun run build <stack_name>
```

`bun run verify:changed` reuses an earlier pass when the working tree, merge-base and verifier scripts are unchanged; set `CARAPA_VERIFY_REUSE=0` to force a fresh run.

The command-policy integration test compiles a temporary fixture with OPA and
evaluates it with the real WASM engine in an isolated process. Set `OPA` to an
executable path if the CLI is not on `PATH`. No installed application stack is
used as a test fixture. The ingress TCP test runs under Node, including when
discovered by `bun test`, so it uses the same networking implementation as the
production ingress proxy.

## Restarts and in-flight tool calls

On SIGTERM the box first drains: new tool calls are refused with "carapa-box is restarting; retry in a few seconds", while running calls (git operations, sandbox restarts, `sandbox_exec`, ...) finish and deliver their response. The HTTP server and hub connection stay open during the drain. The wait is capped by `CARAPA_BOX_SHUTDOWN_DRAIN_MS` (default 120000 ms); with nothing in flight shutdown is immediate. `docker-compose.yml` sets `stop_grace_period: 150s`, so `docker compose up -d --force-recreate carapa-box` may block up to ~2 minutes until in-flight calls finish.

## Daemon Setup (Linux)

Run the server as a background service:

```bash
# Install systemd user service
./install-service.sh

# Start service
systemctl --user start carapa-box

# Check status
systemctl --user status carapa-box
```

## HTTP Usage

The server runs on port `3100` by default. You can connect to it using an MCP client via SSE.

**Connect from an operator container (Docker):**
Use `http://api-relay:8080/sandbox-relay/` as the MCP server URL. This requires a `sandbox-relay` service entry in a **separate, operator-only** `relay-clients/` config — see [Egress Proxy docs](./docs/api-relay-setup.md). Never give agent sandboxes this route (see [Agent → CarapaBox isolation](#agent--carapabox-isolation)).

## Debugging

To list all registered tools and their schemas via the REST adapter:

```bash
curl -s http://localhost:3100/api/tools \
  -H "Authorization: Bearer $CARAPA_BOX_API_TOKEN" | jq '.[].name'
```

## Troubleshooting

More cases: [docs/troubleshooting.md](docs/troubleshooting.md).

### Docker Socket Permission Denied (containerized mode)

If you see `permission denied while trying to connect to the Docker daemon socket` in container logs, the Docker socket GID inside the container doesn't match the host.

1. Check the host's docker socket GID:
   ```bash
   stat -c '%g' /var/run/docker.sock
   ```

2. Set it in `.env`:
   ```bash
   DOCKER_GID=1001   # use the value from step 1
   ```

3. Rebuild (the GID is baked in at build time):
   ```bash
   docker compose build --no-cache && docker compose up -d
   ```

4. Verify inside the image:
   ```bash
   docker run --rm carapa-box:latest id
   # Should show: groups=65532(nonroot),1001(docker)
   ```

**Why this happens:** The Dockerfile creates a `docker` group with the GID from the `DOCKER_GID` build arg (default 999). If the host socket has a different GID (common on Ubuntu where it's often 1001), the container user can't access the socket. The `USER nonroot` directive preserves supplementary group membership — using `USER 65532:65532` would strip it.

### Bun Missing Shared Libraries (build failure)

If the Docker build fails with:
```
Error loading shared library libstdc++.so.6: No such file or directory
```

The controller uses matching, digest-pinned DHI Bun development and runtime
images on Alpine 3.23. Bun is provided at `/usr/local/bin/bun`; no installer or
copied Bun binary is needed. Keep the two base-image versions aligned and retain
the runtime package installation of `libstdc++` and `libgcc` when customizing the
Dockerfile. See [the image audit](docs/DHI-SECURITY-SCAN.md) for pins and validation, and [hardened Dockerfile skill](docs/hardened-dockerfile.md) for hardening other services' images.

### Network Creation Fails on Startup

If you see `[WARN] Could not ensure network "hostaccess"` in logs, this is non-fatal. The warning means the container couldn't create or verify an external Docker network. Common causes:
- Docker socket GID mismatch (see above)
- Network already exists and was created by another user/process

The server continues running — `docker compose up` commands still work because they go through the Docker daemon which has full access.

### Docker Permissions (host mode)
If you see "permission denied" errors when running on the host, ensure your user is in the `docker` group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```
Verify with `docker ps`.

### Port Conflicts
If port `3100` is in use:
1. Edit `.env`
2. Change `MCP_SANDBOX_PORT=3101`
3. Restart service: `systemctl --user restart carapa-box`

### Running Out of Docker Networks

Each agent instance creates its own bridge network. Docker's default pool (`172.17.0.0/16`) only supports ~31 networks with `/16` subnets. When exhausted, you'll see errors like:

```
could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network
```

**Fix: Expand the network pool**

Edit `/etc/docker/daemon.json` (create it if it doesn't exist):

```json
{
  "default-address-pools": [
    { "base": "172.17.0.0/12", "size": 28 }
  ]
}
```

This uses the full `172.16.0.0/12` private range (172.16.x.x – 172.31.x.x) and carves `/28` subnets (14 usable hosts each — plenty for an agent + proxies), giving you ~65,000 possible networks.

**Apply the change:**

```bash
sudo systemctl restart docker
```

> **Warning:** Restarting Docker stops all running containers. Plan for downtime or drain your agents first.

**Verify:**

```bash
# Check the new pool is active
docker info | grep -A5 "Default Address Pools"

# Create a test network to confirm
docker network create test-pool-check && docker network rm test-pool-check
```

**Alternative: Add multiple pools**

If you need to preserve existing network assignments or use multiple private ranges:

```json
{
  "default-address-pools": [
    { "base": "172.17.0.0/12", "size": 28 },
    { "base": "10.0.0.0/8", "size": 24 }
  ]
}
```

Docker tries pools in order, moving to the next when one is exhausted.

**Choosing the right subnet size:**

| Size | Hosts per network | Max networks (from /12) | Use case |
|------|-------------------|------------------------|----------|
| `/28` | 14 | ~65,000 | Agent sandboxes (recommended) |
| `/24` | 254 | ~4,000 | Stacks with many services |
| `/20` | 4,094 | ~256 | Large multi-service stacks |

For CarapaBox, `/28` is ideal — each agent network only needs a handful of containers (agent + dynamically connected proxies).

### Egress Proxy Not Running
If agent stacks fail to start with network errors, ensure the egress proxy is running:
```bash
cd egress-proxy && docker compose up -d
```

### CVE Vulnerabilities in Dependencies

Run `./build.sh` to build and scan for CVEs. If transitive dependencies (e.g., from `@modelcontextprotocol/sdk`) have vulnerabilities with available fixes, add overrides to `package.json`:
```json
{
    "overrides": {
        "hono": "^4.12.4",
        "@hono/node-server": "^1.19.10"
    }
}
```
Then run `bun install` and rebuild.

## License

CarapaBox is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Copyright Regun Software SRL; see [NOTICE](NOTICE). Commercial use requires a separate commercial licence from Regun Software SRL.
