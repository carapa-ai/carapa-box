# Security Policies

CarapaBox uses two policy systems for security enforcement:

1. **OPA/Rego trusted-tool policies** — authorize normalized stack-supplied control-plane tools (`sandbox_exec`)
2. **YAML network policies** — control which domains containers can reach (Squid ACLs)

## Prerequisites

| Component | Needs `opa` CLI? | When? |
|-----------|-----------------|-------|
| CarapaBox runtime | No | Loads pre-compiled `.wasm` files at runtime |
| Editing command policies (`.rego`) | Yes | After editing, run `scripts/compile-policies.sh` |
| Editing network policies (`.yaml`) | No | Changes detected and applied automatically |
| CI/CD pipeline | Optional | Only if you validate `.rego` files in CI |

### Installing OPA CLI

**Linux (amd64):**
```bash
curl -L -o ~/.local/bin/opa https://openpolicyagent.org/downloads/v1.14.0/opa_linux_amd64_static
chmod +x ~/.local/bin/opa
```

**Linux (arm64):**
```bash
curl -L -o ~/.local/bin/opa https://openpolicyagent.org/downloads/v1.14.0/opa_linux_arm64_static
chmod +x ~/.local/bin/opa
```

**macOS:**
```bash
brew install opa
```

**Verify:**
```bash
opa version
```

## Command Policies (OPA/Rego)

Trusted-tool policies authorize normalized `sandbox_exec` invocations by service via OPA/Rego compiled to WASM.

### File layout

```
config/policies/
  base.rego          # shared deny rules (injection, interpreters, length limits)
  base.wasm          # compiled

stacks/carapa-bot/
  policy.rego        # service rules for normalized trusted-tool invocations
  policy.wasm        # compiled (run scripts/compile-policies.sh)
```

### How it works

1. CarapaBox parses a single invocation and reads the stack's declared command source
2. Stacks declaring `x-carapa-command-source: image` in their base Compose file resolve bare names to `/usr/local/ai-cli-bin/<name>`. Other stacks retain override lookup. A valid immediate-child override is normalized to `/usr/local/stack-cli-bin/<name>`; if absent, resolution falls back to image-owned `/usr/local/ai-cli-bin/<name>`. Present but invalid overrides fail closed
3. It loads `policy.wasm` and evaluates the normalized command (base deny rules + stack allow rules)
4. It executes the parsed argv directly, without `sh -c`; stacks without `policy.wasm` remain denied

### Editing command policies

1. Edit the `.rego` file (e.g., `stacks/carapa-bot/policy.rego`)
2. Compile:
   ```bash
   bash scripts/compile-policies.sh
   ```
3. Test:
   ```bash
   # Rego unit tests
   opa test config/policies/ stacks/*/policy.rego -v

   # Or use the MCP tool
   sandbox_policy_check name=carapa-bot service=agent command="/usr/local/stack-cli-bin/run-agent.sh --help"
   ```
4. Commit both `.rego` and `.wasm` files

### Policy structure

**Base policy** (`config/policies/base.rego`) — deny rules that apply to all stacks:
- Command length > 8192 bytes
- Shell injection: backticks, `$()`, `$VAR`
- Inline env var assignments (`VAR=val command`)
- Dangerous interpreters + eval flags (`bash -c`, `python -e`, etc.)

**Stack policy** (e.g., `stacks/carapa-bot/policy.rego`) — allow rules:
- Allowlist patterns: specific commands permitted per service
- Inherits all base deny rules

### MCP tools

| Tool | Description |
|------|-------------|
| `sandbox_policy_check` | Dry-run a command — returns allow/deny + matched rule |

## Network Policies (YAML)

Network policies control which domains agent containers can reach via the Squid egress proxy. They are plain YAML files — no compilation needed.

### File layout

```
config/policies/
  network-base.yaml       # domains allowed for all stacks

stacks/carapa-bot/
  network-policy.yaml     # additional domains for this stack (optional)
```

### How it works

1. CarapaBox watches all `network-policy.yaml` and `network-base.yaml` files
2. On change (2s debounce): collects all domains → generates squid.conf → applies via `squid -k reconfigure`
3. On startup: squid entrypoint checks for a generated config and uses it if present

Every allow rule for an allowed domain also carries `!private_dst`, so Squid refuses to connect when the domain resolves to a private, loopback, link-local or cloud-metadata address: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7` and `fe80::/10`. The check runs after DNS resolution and only on requests whose domain and source already matched, so Squid does not resolve arbitrary names. A name that resolves to both public and private addresses is denied. Every `dstdomain` ACL uses `-n`, so IP-literal requests (`CONNECT 1.2.3.4:443`, `GET http://1.2.3.4/`) are denied without reverse DNS lookups and never match a domain ACL. `host.docker.internal` stays reachable through the separate `host_services` rule: it first denies `host_deny_ports` (default `3000, 3100`: Board and carapa-box, which sandboxes reach only through api-relay), then allows `host_ports` (default `3000-9999, 11434`). Both are optional lists in `network-base.yaml`; entries are an integer port or a `low-high` range (1-65535), invalid entries are skipped with a warning, and a list with no valid entry falls back to its default.

> **Admin note — non-default Board or carapa-box ports.** `host_deny_ports` is not auto-detected. The root `docker-compose.yml` publishes carapa-box as `${MCP_SANDBOX_PORT:-3100}` on the host (the container itself is pinned to 3100), and `CARAPA_BOARD_URL` is only set in the egress-proxy env and is often empty. If Board or carapa-box listen on other host ports, set `host_deny_ports` in `network-base.yaml` to those ports. Otherwise they fall inside the `host_ports` range and sandboxes reach them directly through Squid. The other routes from sandboxes to the host (api-relay and llama-proxy) are listed in the [egress-proxy README](../egress-proxy/README.md#network-topology-and-sandbox-to-host-paths).

### Web tools

Board web tools are the intended way for sandboxes to reach the open web. The points below describe **Board behaviour** (verified in the Board repository), not CarapaBox code.

- **URL guard.** Board blocks non-http(s) schemes and loopback, private, container-network and cloud-metadata targets, and re-checks every redirect. `web_view`, `web_fetch_image`, the Board proxy, x-post and grounded search all use it. Residual risks Board names: DNS rebinding, and DNS lookups done by an upstream proxy.
- **Routing through squid.** The guard leaves `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` to the runtime, so an admin can send Board's fetches through an egress proxy. Two CarapaBox requirements apply. Squid has no published host port today (the `squid` service in `egress-proxy/docker-compose.yml` has no `ports:`), so one must be published, bound to a host-only address. Squid also needs a source rule for Board; without it only the sandbox base allowlist (`config/policies/network-base.yaml`) applies to Board's fetches.
- **Per project.** Web tools are the `web` toolset in Board; a project can be configured without them.
- **Browser.** In Docker sandboxes `browser-open` launches a local Chromium inside the sandbox (`stacks/carapa-bot/bin/browser-open`, `localLaunch` in `stacks/carapa-bot/bin/browser-xvfb.cjs`), whose only network exit is squid. A CDP endpoint (`PLAYWRIGHT_MCP_CDP_ENDPOINT`) is used only for native Mac projects, which drive the hub's browser sidecar through the relay (`browser-open`; [multi-host](multi-host.md)).

### Editing network policies

Just edit the YAML file and save. Changes are applied within ~2 seconds.

```yaml
# stacks/carapa-bot/network-policy.yaml
allowed_domains:
  - .example.com
  - api.myservice.io
```

The base policy (`config/policies/network-base.yaml`) contains domains shared across all stacks: AI providers, package managers, dev docs, etc. Per-stack files add to this list.

The base policy may also define `relay_domains`: hosts (e.g. remote MCP / OAuth authorization servers) that only the api-relay container can reach via `CONNECT`. They are removed from the base and per-stack ACLs, and an `http_access deny` for them is placed before every base/stack allow, so wildcard entries such as `.googleapis.com` cannot admit sandboxes. If the relay container IP is unknown the allow rule is omitted and the hosts are denied for everyone. The api-relay SNI bridge on :443 (which reaches squid from the relay's own IP) refuses SNI hosts that match a `relay_domains` entry. It reads the list from `generated/squid-generated.conf`, mounted read-only into the api-relay container (`RELAY_SQUID_CONF`, default `/app/squid-generated.conf`), and fails closed: if it cannot read that file it refuses every SNI tunnel.

The base policy may also define `relay_private_hosts`, for a host the api-relay must reach although it resolves to a private address (e.g. a GitLab that is only reachable over the operator's VPN):

```yaml
relay_private_hosts:
  - host: gitlab.ex.test
    dst: 10.44.0.1/32
```

`host` must be an exact hostname (no wildcard, no leading dot, no IP literal). `dst` must be a single IPv4/IPv6 address or CIDR inside the private ranges that squid otherwise blocks; the name must resolve inside it. Invalid entries are skipped with a warning and never widen into a broader rule. Squid then allows only `CONNECT` on port 443 from the api-relay IPs to that host when it resolves inside `dst`, and denies the host for every other source before any base/stack allow (so a wildcard such as `.ex.test` cannot admit sandboxes). The host is removed from the base and per-stack ACLs. Without known relay IPs only the deny is emitted. Every other private destination stays blocked by `!private_dst`. The api-relay SNI bridge refuses these hosts too, exactly like `relay_domains`, so a sandbox cannot open a raw TLS tunnel from the relay's IP.

### MCP tool

| Tool | Description |
|------|-------------|
| `sandbox_network_policy_reload` | Force reload all network policies and reconfigure squid |

### Verifying

Check the generated config:
```bash
cat egress-proxy/squid-generated.conf
```

Check squid is using it:
```bash
# From the stack administrator's host shell (sandbox_exec has no general PATH surface)
docker compose -f egress-proxy/docker-compose.yml exec squid squid -k check
```

## Environment Passthrough (YAML)

When starting a stack via `sandbox_start`, callers can pass environment variables. The `env-passthrough.yaml` file controls which env var keys are allowed through — all others are silently dropped.

### File location

```
stacks/carapa-bot/env-passthrough.yaml
```

### Format

```yaml
# Environment variables that callers can inject via sandbox_start
allowed_keys:
  - LOCAL_REPO
  - GIT_REPO
  - DEFAULT_BRANCH
  - GROUP_DIR
  - WORKSPACE_PATH
  - COMPOSE_FILE
```

Only keys listed here will be passed to `docker compose up`. This prevents callers from injecting arbitrary env vars that might override security-sensitive settings inside the stack.

### Behavior

- If the file is missing: no env vars pass through (empty object returned)
- If the file exists but `allowed_keys` is empty: same — nothing passes through
- Keys not present in the caller's env are silently skipped
- No compilation or restart needed — read on every `sandbox_start` call

### Keys `sandbox_start` refuses

Caller `env` is also merged into the environment of the controller-side lifecycle hooks (`before-start.sh`, `before-stop.sh`, ...), which run with the controller's own environment. A `sandbox_start` call whose `env` contains a key that makes bash, the dynamic loader or an interpreter load caller-chosen code or config is rejected with a `[SECURITY] sandbox_start env rejected: ...` error and nothing is started. Refused keys: `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `IFS`, `PATH`, `CDPATH`, `GLOBIGNORE`, `PROMPT_COMMAND`, names that are not valid shell identifiers, and (case-insensitive) the prefixes `LD_`, `DYLD_`, `GLIBC_`, `BUN_`, `NODE_`, `NPM_`, `DENO_`, `PYTHON`, `PERL`, `RUBY`, `DOCKER_`, `GIT_` (except `GIT_REPO`), `XDG_`, `JAVA_`, `_JAVA_`, `JDK_JAVA_`, plus `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `SSH_AUTH_SOCK`, `HOME`, `TMPDIR`, `GCONV_PATH`, `NLSPATH`, `LOCPATH`, `HOSTALIASES`, `GOFLAGS`. The same keys are dropped from stack `.env` values before a hook runs.

### Migration

To verify the contents:

```bash
cat stacks/carapa-bot/env-passthrough.yaml
```

## Security model

Mount allowlists compare resolved filesystem paths, including existing symlinks
in both the requested path and the configured roots. New directories beneath
approved roots are allowed; dangling or looping links, inaccessible paths, and
non-directory parents are rejected. Symlinks are resolved before `..` traversal
is evaluated. Provider credential directories and their ancestors remain blocked,
including through aliases or when the credential directory has not been created.
These checks validate the filesystem visible to the controller at check time;
operators must keep mount paths under trusted control until Docker mounts them.

Both systems follow the same principle: **deny by default, allow explicitly**.

```
sandbox_exec request
  │
  ├─ Resolve one stack-supplied executable and parse argv (no shell)
  │    ↓ (invalid path/operator/symlink → reject)
  ├─ OPA base policy: deny injection, interpreters, length
  │    ↓ (if any deny → reject)
  ├─ OPA stack policy: authorize normalized trusted tool for service
  │    ↓ (if no allow → reject)
  └─ Execute trusted-tool argv
       │
       └─ Network request from container
            │
            ├─ Squid ACL: domain in allowed list?
            │    ↓ (if no → block)
            └─ Forward via proxy
```

Command policies are evaluated per-request (WASM, microseconds). Network policies are applied once when the config changes (squid reconfigure). Both produce audit log entries.
