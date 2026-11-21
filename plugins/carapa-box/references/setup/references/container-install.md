# Container installation

Use [prerequisites.md](prerequisites.md) to install missing host tools on Ubuntu or Debian before continuing.

Run from the authorized CarapaBox repository on the operator's Linux host.
The skill helpers use Bash and standard host utilities; the HTTP check uses curl.
Container deployment also needs Docker with Compose and registry authentication. Check `docker info` and
`docker compose version`. Authenticate with `docker login dhi.io` when needed.
Do not install or restart Docker blindly on a machine already running workloads.

## Configuration

Copy `.env.example` to `.env` only if `.env` does not exist. Reconcile existing
settings rather than overwriting them. Configure:

| Setting | Meaning |
| --- | --- |
| `SANDBOX_HOST_DIR` | Absolute host path of this checkout, used to translate mounts for Docker. |
| `SANDBOX_STACKS_DIR` | Absolute directory of approved stacks; use this checkout's `stacks` unless an existing operator-owned directory is selected. |
| `MCP_SANDBOX_PORT` | Host publication port; default 3100. The container still listens on 3100. |
| `DOCKER_GID` | Actual GID of `/var/run/docker.sock`, obtainable with `stat -c '%g' /var/run/docker.sock`. |
| `SECRETS_DIR` | Host directory containing `carapa_box_api_token` directly, not a parent with another `box/` suffix. |

The root Compose file mounts both `carapa_box_api_token` and `carapa_box_admin_token`.
Generate missing files with the secret helper in `security-and-relay.md` before starting
Compose. Existing deployments upgrading from API-only authentication must add and mount a
distinct admin token before recreating the controller; an unmounted file does not enable it.
Preserve Board's shared API token and endpoint. Never pass the admin token to Board or relays.

Follow `security-and-relay.md` for secret creation, permissions, and the mount
allowlist. Use `docker compose config --quiet` to validate configuration without
printing an expanded environment that may include credentials. Inspect actual
Compose overrides before relying on base-file settings or ports.

## Ingress, egress and runtime files

When HTTP/SSH ingress is requested, follow [proxy operations](proxies.md) for
the root `ingress` profile, private state directory, client CIDRs and workload
migration. The default controller startup below does not start that profile.

For sandbox workloads, prepare `egress-proxy/.env` from its example only if
missing. Set its `SECRETS_DIR` explicitly. Use the same Box API token source for
relay-to-Box authentication; preserve other existing integration tokens. Set
`RELAY_UID`/`RELAY_GID` for the account that owns any refreshable OAuth files.
Choose provider credentials and client routes using `security-and-relay.md`.

Read **all** `secrets.*.file` entries in `egress-proxy/docker-compose.yml` and
create missing optional-provider placeholders in the selected secrets directory.
Do not overwrite any existing file. `egress-proxy/build.sh` currently creates
only a subset of those placeholders, so it is not a complete secret preflight.
An empty optional provider file satisfies Compose but does not authenticate it.

Create missing bind sources as the correct type before Docker can create them
as root-owned directories:

- `generated/`, `generated/audit/`, and `generated/nginx-routes/` are directories.
- `generated/squid-generated.conf` is a file; initialize an absent file empty.
  Squid uses its repository template until a generated policy is available.
- `egress-proxy/tool_profiles.jsonc` is a file; copy
  `egress-proxy/tool_profiles.example.jsonc` only when it is missing.
- `egress-proxy/captures/` is a directory.

Validate write access for the configured service UIDs. The image's default UID is
65532, but the repository Compose file selects `BOX_UID`/`BOX_GID` (default 1000:1000);
inspect the effective service identity. The relay defaults to UID/GID 1000 but accepts overrides. Correct only
necessary runtime paths, never recursively change ownership of an entire
installation or another service's data. `SANDBOX_EGRESS_PROXY_DIR` in a host
`.env` does not change the base Compose bind of `./egress-proxy`.

## Hardening, build, and startup

The base Compose files require `carapabox-controller` and `carapabox-proxy`
AppArmor profiles. Load the repository profiles on a supported host:

```bash
sudo bash security/install-apparmor.sh
```

If AppArmor is unavailable, report the unsupported prerequisite; do not replace
it with `unconfined`. gVisor is optional for agent stacks: use
`scripts/install-gvisor.sh` only when requested and review its Docker restart
implications first. Installing a runtime does not select it for any stack.

Build with the existing scripts, supplying the selected directories explicitly:

```bash
SECRETS_DIR=/absolute/path/to/secrets bash egress-proxy/build.sh
SANDBOX_STACKS_DIR=/absolute/path/to/stacks bash build.sh
```

`build.sh` builds the controller and OPA compiler image, then compiles the base,
stack, and egress policies. Do not assume that starting the controller compiles
policies, or that host shell scripts automatically load `.env` values.
Check the command exit status and generated policy files. Scanner outcomes and
build failures are different; never report an advisory scan as a clean scan.

Validate each Compose project from its own directory, then start the egress
services and controller. Changing CWD matters because egress has its own `.env`:

```bash
(cd egress-proxy && docker compose -p egress-proxy config --quiet && docker compose -p egress-proxy up -d)
docker compose config --quiet
docker compose up -d
```

Use `docker compose ps` and bounded recent logs in each directory, then run
the repository-root controller check command from `SKILL.md`. A Docker healthcheck that only checks PID 1
is not a substitute for the authenticated HTTP check.
