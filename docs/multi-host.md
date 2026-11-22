# Multi-host CarapaBox (hub topology)

One CarapaBoard (the **hub**) drives several CarapaBox hosts: the local box on
the hub machine, additional Linux boxes, and Docker-less native runners (for
example a Mac). Only the hub must be reachable; boxes dial out.

```
              Hub host
   ┌─────────────────────────────────────┐
   │ CarapaBoard ── central api-relay    │  provider credentials, single OAuth refresher
   │   ▲ wss /api/boxes/connect  ▲ :RELAY_FORWARDER_PORT (TLS)
   └───┼─────────────────────────┼───────┘
       │ box dials out            │ forwarder dials out (HMAC-signed)
 ┌─────┴──────────────────────────┴──┐   ┌─────────────────────────────────────┐
 │ Linux box: CarapaBox + squid +    │   │ Mac: carapa-runner (native)         │
 │ api-relay (RELAY_MODE=forward)    │   │ Claude Code sandbox (Seatbelt)      │
 │ IPC, groups, repos on this host   │   │ ~/.carapa-runner/{ipc,groups,repos} │
 └───────────────────────────────────┘   └─────────────────────────────────────┘
```

## What lives where

| Data | Owner | How Board sees it |
|---|---|---|
| Sandbox IPC (`runs/`, `sessions/`, uploads, recordings) | the box that runs the project | replica in `DATA_DIR/ipc/<stack>-<instance>` via `sandbox_ipc_sync` |
| Group directory (`AGENTS.md`, artifacts, rules) | the box that runs the project | replica in `GROUPS_DIR/<folder>` (remote boxes only; `logs/`, `session-transcripts/`, `transcripts/`, `recordings/` stay on the hub) |
| Transcripts, database, UI | hub | — |
| Provider credentials | hub (central api-relay) | — |
| Per-sandbox Board credentials | issued by Board, stored on the box that runs the sandbox | pushed with `sandbox_relay_token` |

The replica state (agreed sizes/offsets) is persisted in `DATA_DIR/ipc-replica/`
and `DATA_DIR/group-replica/`, so a Board restart resumes streaming where it
stopped. Completion markers (`exit_code`, `metrics_complete`, `metrics.json`)
are only replicated after the output they finalize.

When the local box shares Board's IPC directory (single host, today's layout),
Box sees Board's `.carapa-board-replica` marker and replication is skipped. If a
containerised local Box cannot see the IPC tree at all, Board also falls back to
that shared layout. Remote boxes must see their tree.

## Hub setup

1. **Board** — unchanged startup. Optional settings:
   - `CARAPA_RELAY_HUB_SECRET` (≥ 16 chars): shared with the central relay for
     `GET /api/relay/forwarders/:boxId`.
2. **Local CarapaBox** — keep it as today, or let it dial the hub too:
   - Box now binds `127.0.0.1` by default (`MCP_SANDBOX_HOST`). The compose file
     sets `0.0.0.0` inside the container. Any non-loopback bind requires
     `CARAPA_BOX_API_TOKEN`, or Box refuses to start.
   - Containerised Box mounts the IPC tree at `/app/ipc` from
     `CARAPA_BOX_IPC_HOST_DIR`, which defaults to `IPC_MOUNT`. Set it only when
     stack `.env` files point `IPC_MOUNT` outside that directory.
3. **Central api-relay** (hub `egress-proxy/.env`):
   ```
   RELAY_FORWARDER_PORT=8443
   RELAY_FORWARDER_TLS_CERT=/run/secrets/relay.crt   # or terminate TLS in front
   RELAY_FORWARDER_TLS_KEY=/run/secrets/relay.key
   CARAPA_RELAY_HUB_SECRET=<same as Board>
   CARAPA_BOARD_URL=https://host.docker.internal:3000  # how the relay reaches Board
   ```
   Publish the forwarder port only (agents keep using `api-relay:8080`), for
   example with a compose override `ports: ["8443:8443"]`, Tailscale or a TLS
   reverse proxy. Requests on that port must carry a valid forwarder signature.
4. **Register boxes** — Board → admin menu → *CarapaBox hosts* → *Register*.
   The connection secret is shown once. Assign projects with *Move project
   here*. Native runners require acknowledging reduced isolation. The main
   project stays on the local box.

## Linux box

`.env` of CarapaBox:

```
CARAPA_HUB_URL=wss://board.example.com
CARAPA_BOX_ID=lab-pc
IPC_MOUNT=/srv/carapa/ipc                    # also mounted into a containerised Box
CARAPA_BOX_GROUPS_ROOT=/srv/carapa/groups    # @group/<folder>
CARAPA_BOX_REPOS_ROOT=/srv/carapa/repos      # @repo/<name>
```

Add the IPC, group and repository roots, plus the agent home of the box's
stacks, to `config/mount-allowlist.yaml`. Project settings with host
paths (`repositoryLocation`, extra mounts) are interpreted on the box that runs
the project.

### Connection secret

Box and its relay both read `CARAPA_HUB_BOX_SECRET` from
`SECRETS_DIR/carapa_hub_box_secret` before the environment. Prefer that file
(mode 0600) to a plain `.env` value. The base Compose files do not mount it,
so add a hub override to each project. Controller,
`~/.carapa-box/box-hub.override.yml` (any path):

```yaml
services:
  carapa-box:
    secrets: [carapa_hub_box_secret]
secrets:
  carapa_hub_box_secret:
    file: ${SECRETS_DIR}/carapa_hub_box_secret
```

Egress, `egress-proxy/docker-compose.override.hub.yml`:

```yaml
services:
  api-relay:
    secrets: [carapa_hub_box_secret]
secrets:
  carapa_hub_box_secret:
    file: ${SECRETS_DIR}/carapa_hub_box_secret
```

The egress override must sit in `egress-proxy/` and be listed in
`COMPOSE_FILE` by a bare `docker-compose*.yml` name. The controller recreates
egress services itself, from its container's `/app/egress-proxy`, and cannot
see other host paths. An absolute path there fails every automatic recreation
with `compose file "…" set by COMPOSE_FILE environment variable` errors in
Box's log. The `*.override.*.yml` name is gitignored.

If the hub name resolves only through the host's `/etc/hosts` or a resolver
Docker does not use, add `extra_hosts: ["board.example.com:<hub IP>"]` to
`carapa-box` and `api-relay` in the same overrides.

Board's browser viewer and shell tab reach the box through its hub connection:
the box replays those requests against its own HTTP API (only `/api/browser/*`
and `/api/tmux/*`, with its own `CARAPA_BOX_API_TOKEN`) and advertises the
`http-tunnel` capability. No inbound port is needed.

`egress-proxy/.env` of that box (forwarder, no provider credentials):

```
RELAY_MODE=forward
CARAPA_RELAY_UPSTREAM=https://board.example.com:8443
CARAPA_BOX_ID=lab-pc
COMPOSE_FILE=docker-compose.yml:docker-compose.override.hub.yml
```

When the hub certificate comes from a private CA, add the CA overlay in both
`.env` files instead of disabling verification. Keep the hub override last:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.ca.yml:<hub override>
CARAPA_CA_CERTIFICATE=/etc/carapa/root.crt
```

### Providers and local models

The forwarder sends every relay request to the hub, which injects the
credentials. A route works only if the hub holds a credential for it:
`/openai/` answers `503 No credentials configured for openai` unless the hub
has an OpenAI API key, while ChatGPT-subscription traffic uses `/codex/`. The
box's relay does not log successfully forwarded requests.

Local model engines are optional and deployment-specific. Skip this without
one. `llama-proxy` forwards its `PORTS` to `UPSTREAM_HOST`, which is
`host.docker.internal` by default. If the engines (llama.cpp, Ollama, vLLM, …)
run on another host such as the hub, point it there in the egress hub override.
Otherwise requests fail with `502 connect ECONNREFUSED`. Also check that
`PORTS` and the harness provider URLs match the ports your engines serve:

```yaml
services:
  llama-proxy:
    environment:
      UPSTREAM_HOST: "<hub IP>"
```

### Agent stacks on the box

The hub's Board does not prepare stacks on remote boxes. Before assigning a
project, on the box:

- install gVisor (`sudo bash scripts/install-gvisor.sh`): `carapa-bot` sets
  `runtime: runsc`, and without it starts fail with
  `unknown or invalid runtime name: runsc`;
- create the stack's `.env` with its `AGENT_HOME`, build the image and install
  harnesses (`stacks/carapa-bot/README.md`, *Installation*). A missing
  `.harness/active/selection.json` fails the start with *Prepare the public
  image and harness selection*;
- give Codex the relay provider in `$AGENT_HOME/.codex/config.toml`
  ([Codex config.toml](api-relay-setup.md#codex-configtoml)). Without it Codex
  calls `api.openai.com` directly and gets `401 Missing bearer`.

### Rotating the connection secret

After *Regenerate* on the hub, the hub drops the box (Box logs
`[hub] Hub revoked this box; not reconnecting until restart`). Replace
`carapa_hub_box_secret`, then restart `carapa-box` and `api-relay`; both read the
secret only at startup. `api-relay` drains in-flight requests for up to its
960-second stop timeout, so close the box's chats first or restart Box
separately before the relay.

Board's browser viewer and shell tab reach the box through its hub connection:
the box replays those requests against its own HTTP API (only `/api/browser/*`
and `/api/tmux/*`, with its own `CARAPA_BOX_API_TOKEN`) and advertises the
`http-tunnel` capability. No inbound port is needed.

`egress-proxy/.env` of that box (forwarder, no provider credentials):

```
RELAY_MODE=forward
CARAPA_RELAY_UPSTREAM=https://board.example.com:8443
CARAPA_BOX_ID=lab-pc
CARAPA_HUB_BOX_SECRET=<connection secret>
```

When the hub certificate comes from a private CA, add the CA overlay in both
`.env` files instead of disabling verification:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.ca.yml
CARAPA_CA_CERTIFICATE=/etc/carapa/root.crt
```

## Mac native runner (`carapa-runner`)

Requirements: Bun, git, Node.js (for `playwright-cli`), tmux (`brew install tmux`,
for Board's shell tab), the harness CLIs you use (e.g. `claude`) on `PATH`, and a
checkout of this repository with `bun install` (the runner reuses
`stacks/carapa-bot/bin` and the pinned `@playwright/cli`).

`~/.carapa-runner/config.json`:

```json
{
  "hubUrl": "wss://board.example.com",
  "boxId": "mac",
  "credentialFile": "/Users/me/.carapa-runner/state/box-secret",
  "relayUpstream": "https://board.example.com:8443",
  "relayPort": 18080,
  "allowedRoots": ["/Users/me/code"],
  "allowedDomains": ["localhost", "127.0.0.1"]
}
```

`bun run runner` fast-forwards the checkout and reinstalls dependencies when the
lockfile changed, then starts; set `RUNNER_AUTO_UPDATE=0` to skip. To update a
running runner, stop it (Ctrl-C) and run `bun run runner` again. The version the
runner reports to the hub is the checkout's git commit. When the hub certificate comes from a private CA, put
its root at `~/.carapa-runner/carapa-root-ca.crt` (or under `CARAPA_RUNNER_ROOT`);
`bun run runner` then sets `NODE_EXTRA_CA_CERTS` to it unless already set (Bun
does not read the macOS keychain). The runner:

- serves the run, IPC, group, git and relay-credential tools over the hub
  socket. Per-task worktrees, branches and app publishing are not supported, so
  use the shared checkout mode for projects placed here;
- serves Board's shell tab over the hub socket (`/api/tmux/*` with the
  `http-tunnel` capability; no listening port). The shell runs in its own
  per-project sandbox host with pty access (started on first use), with the
  same file and network rules as the agent: it starts in the repository and
  cannot write outside the project's directories. Agents get no pty (a pty
  profile opens every `/dev/ttys*`, including your Terminal windows), so they
  cannot use the shell's host. The tmux socket and the pane FIFOs live in
  `<root>/shell/<id>/` (created 0700), under the runner root that agents can
  neither read nor connect to; the root path must keep the socket path under
  macOS's 104-byte limit, or attaching fails with an error. tmux, bash and
  readline read only runner-owned startup files from that directory, never
  `~/.tmux.conf`, `~/.bashrc` or `~/.inputrc` of the agent home (the pane shell
  is `bash --noprofile --rcfile`, not a login shell, started by tmux directly
  and with `default-shell` pinned to `/bin/sh`, so no intermediate zsh reads
  `~/.zshenv` of the agent home). `sandbox_stop` ends the
  pane readers and the tmux server and closes the shell host; so does runner
  shutdown;
- serves Board's browser viewer (`/api/browser/*`) in-process over the hub
  socket, with the same contract as a Linux box (NDJSON stream, input batches,
  `DELETE`; at most 64 viewers). No bearer token is checked: the hub socket
  authenticates Board. An unknown project answers 404, a stopped one 409. The
  trusted `browser-viewer <sessionId>` helper runs inside the project's agent
  sandbox (never the shell host), where the agent's browser daemon sockets under
  `/tmp/cb-<id>` are reachable; the host forwards the viewer's input to its stdin.
  The agent profile allows neither local binding nor loopback TCP, so the helper
  (with `CARAPA_BROWSER_VIEWER_TRANSPORT=unix`) has the Playwright dashboard
  listen on a Unix socket in its private dir under `/tmp/cb-<id>` and connects
  over that socket; containers keep the loopback TCP listener.
  Closing a viewer ends the helper's stdin and kills it after 2.5 s if it has not
  exited; `sandbox_stop` and runner shutdown close the project's viewers;
- keeps projects that were running as running across a runner restart (saved in
  `state/projects.json`; sandbox hosts start on first use). Their agent home is
  refreshed, the relay capability is kept until the next `sandbox_start`, and a
  project whose directories are gone or no longer allowed comes back stopped
  (a warning names it);
- runs `run-agent.sh` natively with `CARAPA_IPC_ROOT`, `CARAPA_GROUP_ROOT` and
  `CARAPA_WORKSPACE_ROOT` mapping the container paths Board sends;
- runs every project process (agent runtime, `stop-agent.sh`, `git`) inside a
  per-project macOS Seatbelt profile from `@anthropic-ai/sandbox-runtime`
  (deny by default). Claude Code's own sandbox covers only its Bash tool, so it
  is not the boundary here and is turned off (Seatbelt cannot nest):
  - reads: the home directory, `/Volumes` and `denyRead` are denied except the
    project's directories, this checkout and the agent toolchain found on
    `PATH` (add more with `allowRead`); the runner's `state/` stays unreadable;
  - writes: the project's repository, group, IPC and agent-home directories
    and temporary space, never the repository's `.git/hooks`, `.git/config`,
    `.vscode` or `.idea`;
  - network: only `127.0.0.1:<relayPort>`; no Apple Events or LaunchServices;
  - one sandbox host per project (started on first use, closed by
    `sandbox_stop`) runs every agent command, because Seatbelt only lets a
    process signal and inspect processes of its own sandbox (warm sessions,
    stops); the shell tab has a second host with the pty profile (see the shell-tab bullet above);
  - `git` runs sandboxed with the agent home, so the user's git credentials
    and remotes are not available (no fetch or push from native projects);
- refuses to start on anything other than macOS (no unconfined fallback);
- translates Board's container-specific environment for each project:
  `api-relay:8080` URLs to the local forwarder and `/tmp/pwcli-*` browser
  daemon directories to the project's `/tmp/cb-<id>` root, the only place its
  sandbox may use Unix sockets; `web_view` thus drives the hub's browser
  sidecar from the Mac, and Board's browser viewer shows that session;
- runs Board's browser tab (`browser-open`) against the hub's browser, never a
  local Chromium: the session descriptor
  (`<root>/ipc/<project>/browser-sessions/<id>.json`) must carry
  `env.PLAYWRIGHT_MCP_CDP_ENDPOINT`, or the tab fails with "Board did not
  provide a remote browser for this Mac project". The tab opens external URLs
  only; previews of apps running on the Mac (no URL, `localhost`, `127.0.0.0/8`,
  `[::1]`, `0.0.0.0` or `http://nginx/`) are not supported yet and fail with
  "Previews of apps running on the Mac are not supported yet; open an external
  URL". Browser sockets and locks live under the project's `/tmp/cb-<id>` root;
- registers Board's MCP server in `<root>/home/<project>/.claude.json` and
  forwards agent model and Board MCP traffic through
  `http://127.0.0.1:<relayPort>/s/<project>/<capability>/…` to the central
  relay. The capability is a per-project secret, new at every `sandbox_start`
  and given only to that project's sandbox, so one project's agent cannot
  claim another project's identity or credentials. Board therefore does not
  write `.mcp.json` for native projects. No Claude login or provider
  credential is stored on the Mac.

## Linux runner with OpenShell sandboxes (`carapa-runner`, `openshell` backend)

> **Experimental.** OpenShell support (Docker and VM drivers, the Brain stack)
> is new and tested on one host only. Configuration, behaviour and the required
> OpenShell version may change without notice; use Docker Compose stacks for
> production work.

The runner can also serve a **Linux** host without Docker Compose stacks: set
`openshell` in its config and every project's agents run in one long-lived
[OpenShell](https://github.com/NVIDIA/OpenShell) sandbox instead of a Seatbelt
profile. It connects as a native box (no per-task worktrees, branches or app
publishing; use the shared checkout mode) and reports isolation `openshell`.
Board still asks you to acknowledge a native box when you assign a project.

Requirements:

- the `openshell` CLI (v0.1.5 or newer) on the runner's `PATH`, signed in to a
  gateway (`openshell status` says *Connected*), and Bun, git and the runner
  checkout as for the Mac runner;
- a sandbox image with `bun`, `git` and the agent runtime's tools, for example
  `carapa-bot-agent:latest`. Its default user must have the same uid as the
  user running the runner (1000 for the `ubuntu` images), or writes to the
  project directories fail;
- a gateway that allows host bind mounts, in its `gateway.toml`:

  ```toml
  [openshell]
  version = 2

  [openshell.drivers.docker]
  allow_driver_config = true
  enable_bind_mounts  = true

  [openshell.drivers.docker.resource_admission]
  enabled = false
  ```

  Save it as `~/.config/openshell/gateway.toml` (the gateway reads it from there)
  and restart the gateway; without `version = 2` it refuses the file.
  The gateway checks bind sources in **its own** filesystem. Run it as a host
  process or user service (not under a private `/tmp`), or, if it runs in a
  container, mount the runner root, the checkout's `stacks/carapa-bot/bin` and
  `src/runner` into it at the same paths. Keep the runner root outside `/tmp`.
  OpenShell sends anonymous telemetry by default. To turn it off, set
  `OPENSHELL_TELEMETRY_ENABLED=false` in the gateway's environment (there is no
  `gateway.toml` key): for the packaged user service, add it to
  `~/.config/openshell/gateway.env` and run
  `systemctl --user restart openshell-gateway`. The gateway passes it on to the
  sandbox supervisors.

`~/.carapa-runner/config.json` (the fields of the Mac runner still apply; the
runner root and `allowedRoots` hold the project directories):

```json
{
  "hubUrl": "wss://board.example.com",
  "boxId": "lab-os",
  "credentialFile": "/home/me/.carapa-runner/state/box-secret",
  "relayUpstream": "https://board.example.com:8443",
  "relayPort": 18080,
  "openshell": {
    "image": "carapa-bot-agent:latest",
    "gateway": "openshell",
    "harnesses": ["claude"],
    "mounts": [
      { "type": "volume", "source": "carapa-harness-live-<id>", "target": "/opt/carapa-harness/bin", "subpath": "bin" },
      { "type": "volume", "source": "carapa-harness-live-<id>", "target": "/opt/carapa-harness-store" }
    ]
  }
}
```

`codexSeed` (a directory such as `AGENT_HOME/.codex`) is copied into every
project's `~/.codex` at start: `config.toml`, the `*.config.toml` profiles and
`models/*.json`, with `/home/ubuntu/.codex` rewritten to the project's home.
Codex needs it for any provider beyond the built-in `relay` one; credentials
such as `auth.json` are never copied. Without it Codex only gets the relay
provider.

`gateway` (a name from `openshell gateway list`) or `gatewayEndpoint` select
the gateway, `cpu` and `memory` limit each sandbox, `relayHost` (default
`host.openshell.internal`) is the name the sandbox uses for the runner, and
`readOnlyPaths` adds directories the sandbox may read. The harness CLIs come
from the harness volume the Docker stacks use; the volume name changes with
each harness release, so update `mounts` and restart the project to pick it up
(the sandbox is recreated when its mounts change). Mounts are read-only unless
`readOnly: false`.

How it works:

- `sandbox_start` creates (or recreates, when mounts or policy changed) the
  project's sandbox, named `cb-<project prefix>-<hash>` (the gateway allows 19
  characters) with the project's repository, group, IPC and agent-home
  directories mounted writable at their host paths, and the runtime commands
  (`stacks/carapa-bot/bin`) and sandbox host read-only. `sandbox_stop` stops it
  but keeps it for the next start.
- Commands run through `openshell sandbox exec`; the same long-lived sandbox
  host as on the Mac keeps one exec per project.
- The sandbox's filesystem policy allows writes only to the project mounts and
  temporary space. Its only network destination is the runner's relay
  forwarder at `host.openshell.internal:<relayPort>`, which carries model and
  Board MCP traffic exactly as on the Mac; direct internet and every other host
  port are refused. No provider credential is stored in the sandbox.
- Board's shell tab runs in the project's sandbox, with the sandbox's tmux.
- Stopping the runner leaves the sandboxes (and a stack's service) running; the
  gateway owns them. It does end what depends on the runner: the relay
  forwarder (the sandbox's only network destination), the published service
  ports, the hub connection, the shell tab's tmux server and any command
  running at that moment. On the next start the runner reuses a sandbox whose
  mounts and policy are unchanged and recreates one whose spec changed.
- Not supported yet: Board's browser viewer, per-task worktrees, and
  `sandbox_network_policy_reload`.

### MicroVM sandboxes (`"driver": "vm"`)

OpenShell's Docker driver runs sandboxes as `runc` containers on the host kernel, and OpenShell's
own confinement (Landlock, seccomp user notification) cannot run under gVisor. Its **VM driver**
runs each sandbox in a libkrun microVM with its own Linux kernel instead, a hardware boundary.
Set `"driver": "vm"` and point `gateway` at a gateway that uses the VM driver.

The gateway (`gateway.toml`, schema version 2; VM is never auto-detected and needs the signing
bundle `openshell-gateway generate-certs` writes):

```toml
[openshell]
version = 2
[openshell.gateway]
bind_address   = "127.0.0.1:17771"
compute_driver = "vm"
[openshell.drivers.vm]
state_dir           = "/home/me/.local/state/openshell-vm/vm-state"
driver_dir          = "/usr/libexec/openshell"
bootstrap_image     = "nvcr.io/nvidia/base/ubuntu:24.04"
vcpus               = 4
mem_mib             = 4096
allow_driver_config = true
enable_bind_mounts  = true
[openshell.drivers.vm.resource_admission]
enabled = false
```

Needs `/dev/kvm` access (group `kvm`) and `mke2fs`, `debugfs`, `e2fsck`
(`openshell-gateway config preflight -- --config gateway.toml --compute-driver vm` checks them).
Run it as a second gateway with its own port and state; generate its certificates with
`XDG_CONFIG_HOME` pointing at a scratch directory, because `generate-certs` also overwrites the CLI
certificates of the default gateway, and register it with `openshell --gateway` metadata under its own name.
The VM supervisor reads the host's `/etc/resolv.conf`: a host without one (DNS served locally, e.g.
dnsmasq) can run the gateway in a private mount namespace that supplies it, without touching `/etc`:
`unshare -m --user --map-user=$(id -u) --map-group=$(id -g) --keep-caps`, an overlay on `/etc` with
`nameserver 127.0.0.1`, then the gateway. Keep the user's uid (not `-r`), or mounted files look root-owned.

What differs from the Docker driver:

- The image is exported with `docker export` into a rootfs archive (cached per image id in
  `<stateDir>/vm`; about 20 s the first time, a few seconds to start afterwards). It carries no image
  environment, so the runner adds the image's `PATH` itself.
- A VM supports **at most 3 bind mounts and no Docker volumes**. The runner mounts the runner
  checkout (read-only), the runner `root` (writable) and the harness volume's host copy (made once per
  volume name with `docker run ... cp`; the 15 GB harness volume takes a minute or two). A volume
  mounted with a `subpath` becomes a symlink in the rootfs into the whole-volume mount, and
  `/usr/local/ai-cli-bin` is one too. Which directories of the root a project may touch is the Landlock
  policy's job: other projects' directories and everything outside the root are unreachable (checked).
- So `stateDir` (set it, or `CARAPA_RUNNER_STATE_DIR`) must lie **outside** `root`, as must the config
  file holding the hub secret, and every project directory (`@group`, `@repo`, extra mounts) must be
  under `root`: `allowedRoots` outside it are refused.
- `cpu`/`memory` are the gateway's `vcpus`/`mem_mib`.

### CarapaBrain on the OpenShell runner

A project whose stack is `carapa-brain` runs the Brain service in its sandbox, as the
container does. Describe the stack under `openshell.stacks`:

```json
"stacks": {
  "carapa-brain": {
    "image": "carapa-brain-openshell:latest",
    "envFile": "/home/me/my-stacks/stacks/carapa-brain/.env",
    "service": { "argv": ["bun", "run", "/app/src/index.ts"], "port": 3111, "hostPort": 3211,
                 "bind": "172.16.0.1", "host": "host.docker.internal" }
  }
}
```

- `image`: OpenShell refuses an image whose working directory the sandbox user cannot
  write, and `carapa-brain` keeps its code in a root-owned `/app`. Build the three-line
  derivative once: `docker build -f docs/openshell-brain.Dockerfile -t carapa-brain-openshell:latest .`
  (rebuild it after each `carapa-brain` release).
- `envFile` and `env`: the stack's settings. Container addresses (`api-relay:8080`,
  `llama-proxy:<port>`) are rewritten to the relay forwarder; provider keys always stay
  the relay-managed placeholders. Board's scoped `CARAPA_BOARD_API_TOKEN` is passed on.
- `service`: `sandbox_start` starts it detached in the sandbox (it survives a runner
  restart; the runner restarts it when it stops answering `health`), starts it in the
  project's repository directory and sets `PORT`, `GROUP_DIR` and the IPC run
  directories to the project's directories. The sandbox has no network, so the runner
  publishes `port` on the host with `openshell forward service` (`bind:hostPort`) and
  reports `host:hostPort` as the `ingress` entry of `sandbox_ps`, where Board already looks
  for a Brain. `bind` must be an address Board can reach (the Docker bridge address works
  for a containerised Board: its `host.docker.internal`); one Brain per box per `hostPort`.
- The runtime commands are also mounted at `/usr/local/ai-cli-bin`, where the Brain
  starts agents (`run-agent.sh`) from.

Not covered: per-objective dashboard servers (ports 3200-3299 inside the sandbox) are not
published.

Known limits: the project's `.git/hooks` and similar files remain writable by
the agent, as in container boxes (the Seatbelt profile denies them); anything
that opens the repository on the host runs them.

## Verification checklist (host)

- Local box: chat turn and task; restart Board mid-turn and confirm output
  resumes and the transcript is complete.
- Second Linux box: connects (green in *CarapaBox hosts*); assign a project;
  run a task; confirm Board MCP and model calls go through forwarder → central
  relay; cut the network mid-run and restore it; stop/cancel work.
- Mac runner: same checks; confirm a write outside the worktree is blocked by
  the sandbox and that `~/.carapa-runner` holds no provider credentials.
- OpenShell runner: same checks; confirm a write outside the project mounts and
  a request to any host but `host.openshell.internal:<relayPort>` are refused
  inside the sandbox, and that Board's model and MCP calls reach the central
  relay through the forwarder.
