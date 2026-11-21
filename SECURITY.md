# Security

This document explains how to report a vulnerability, which versions are supported, the known limitations, and the security features of `carapa-box`.

Contents: [Reporting](#reporting-a-vulnerability) · [Supported versions](#supported-versions) · [Known limitations](#known-limitations) · [Overview](#overview)

## Reporting a vulnerability

E-mail `hello@carapa.ai` with the subject prefix `[SECURITY]`. Do not open a public GitHub issue for a vulnerability. GitHub private vulnerability reporting on the repository is also accepted.

## Supported versions

During the alpha, only the latest 0.x release receives security fixes.

## Known limitations

- The controller holds the Docker socket (read-write), so a compromise of the controller is a compromise of the host's Docker.
- gVisor is optional: without `runsc`, agent containers run under the default runtime with the hardening described in this file but share the host kernel.
- With no API token configured, a loopback-bound controller accepts MCP and `/api/tools` calls from any local process, but rejects browser requests (403) that carry a non-loopback `Origin` or a non-loopback `Host` (DNS rebinding), so a web page the operator visits cannot call it.
- Agents run with the permissions their harness is given inside the sandbox; the sandbox, egress proxy and relay are the boundary, not the harness.

---

## Overview

The server provides multiple layers of security:
1. **Bearer Token Authentication** - Controls who can connect to the MCP server
2. **Trusted-tool OPA/Rego Policies** - Authorize normalized stack-supplied control-plane tools per service
3. **gVisor (runsc)** - Kernel-level isolation for agent containers (recommended)
4. **Agent → CarapaBox isolation** - Agents have no network route to CarapaBox (Docker socket protection)

---

## Bearer Token Authentication

When running in HTTP mode, you can require clients to authenticate with a bearer token.

### Setup

1. **Generate a secure token into a secrets file** (preferred):
   ```bash
   openssl rand -hex 32 > "${SECRETS_DIR}/carapa_box_api_token"
   ```
   The server reads from `SECRETS_DIR/carapa_box_api_token` at startup. Falls back to the `CARAPA_BOX_API_TOKEN` env var if the file is not found.

2. **Configure your client** to send the `Authorization` header:
   ```
   Authorization: Bearer your-generated-token-here
   ```

### Behavior

| Scenario | Result |
|----------|--------|
| `CARAPA_BOX_API_TOKEN` not set, loopback bind | Requests from local processes allowed (no auth); requests with a non-loopback `Origin` or `Host` rejected (403) |
| `CARAPA_BOX_API_TOKEN` not set, non-loopback bind | Box refuses to start |
| Token set, valid header | ✅ Request proceeds |
| Token set, missing/invalid header | ❌ 401 Unauthorized |

### Endpoints

- `/health` and `/status` - **Always allowed** (no auth required)
- `OPTIONS` requests - **Always allowed** (CORS preflight)
- All other endpoints - **Require valid token** when `CARAPA_BOX_API_TOKEN` is set

### Client Example (CarapaBot)

```typescript
const sandboxConfig = {
  type: 'http',
  url: "http://host.docker.internal:3100",
  headers: { Authorization: `Bearer ${process.env.CARAPA_BOX_API_TOKEN}` }
};
```

---

## OPA/Rego Command Policies

The `sandbox_exec` control-plane tool executes one trusted stack override under
`/usr/local/stack-cli-bin`, or an image-built default under
`/usr/local/ai-cli-bin`. It does not provide a general shell
or PATH-based command surface. Each stack also defines an OPA/Rego policy that
authorizes normalized trusted-tool invocations per service; policies are
compiled to WebAssembly (`.wasm`) for fast, in-process evaluation.

### Configuration Files

Each stack has a `policy.rego` file (source) and a `policy.wasm` file (compiled). Shared deny rules live in `config/policies/base.rego`.

```
config/policies/
  base.rego          # shared deny rules (injection, interpreters, length limits)
  base.wasm          # compiled

stacks/my-stack/
  policy.rego        # stack-specific allow rules
  policy.wasm        # compiled (run scripts/compile-policies.sh)
```

### Policy Structure

**Base policy** (`config/policies/base.rego`) — deny rules that apply to all stacks:
- Command length > 8192 bytes
- Shell injection: backticks, `$()`, `$VAR`
- Inline env var assignments (`VAR=val command`)
- Dangerous interpreters + eval flags (`bash -c`, `python -e`, etc.)

**Stack policy** (e.g., `stacks/my-stack/policy.rego`) — allow rules:
- Allowlist patterns: specific commands permitted per service
- Inherits all base deny rules

### Behavior

- **Default is deny**: All commands are blocked unless explicitly allowed by the stack's Rego policy. A missing `policy.wasm` means the stack cannot be started.
- Stacks without `policy.wasm` are excluded entirely from `sandbox_list` and cannot be registered.

### Environment Passthrough

Environment variables that callers can inject via `sandbox_start` are controlled by `env-passthrough.yaml` (not the Rego policy). See `docs/security-policies.md` for details.

### Compiling Policies

After editing a `.rego` file, compile it:
```bash
bash scripts/compile-policies.sh
```

Commit both `.rego` and `.wasm` files.

---

## Trusted-tool Mode

`sandbox_exec` only runs trusted control-plane executables. Image-built defaults
remain at `/usr/local/ai-cli-bin`; a stack's optional protected `bin/` is mounted
read-only at `/usr/local/stack-cli-bin` and never shadows that image directory.
For a bare name, a valid immediate-child stack executable wins. With no stack
entry, resolution falls back to the image path without requiring a host file.
A present but invalid override is rejected. Ordinary `PATH`, relative, nested,
traversal, malformed, and alternate absolute paths are not considered.

The stack policy authorizes the normalized trusted-bin shape:

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

See [README.md](./README.md#policyrego) and [docs/security-policies.md](./docs/security-policies.md) for the full policy structure reference.

---

## Automatic Security Protections

The server parses one invocation and rejects shell control operators,
redirections, substitutions, or additional command segments before Rego runs.
Execution uses argv directly rather than `sh -c`.

### 1. Command Chaining and Pipes
Commands containing `|`, `;`, `&&`, or `||` are rejected.

### 2. Redirections
Shell redirections (`>`, `>>`, `<`) are treated as segment separators — each part is evaluated by the OPA policy.
- **Blocked**: `echo "malicious" > ~/.ssh/authorized_keys`

### 3. Subshells and Expansions
To prevent "nesting" dangerous commands inside allowed ones, the following are generally blocked:
- **Subshells**: `$()` and `` `backticks` ``.
- **Variable Expansions**: `$VAR` and `${VAR}`.

**Important Note on Exact Matches**:
Dangerous markers are blocked if they are matched via a **glob** (e.g., `echo *`). However, if an administrator defines an **exact literal match** in the allowlist (e.g., `echo $PATH`), it will be permitted. This allows for specific, trusted usages of variables.

### 4. Inline Environment Variables
Blocking assignments like `PATH=/tmp command` prevents attackers from hijacking the system path to run malicious binaries.

---

## Dangerous Interpreters

Certain binaries are classified as **Dangerous Interpreters** because they can execute arbitrary code passed as arguments. This includes:
`sh`, `bash`, `python`, `php`, `node`, `perl`, `ruby`, `eval`, `exec`, etc.

### Protection for Eval Flags
If an agent uses a "dangerous" flag (like `-r`, `-c`, `-e`, or `--eval`), **globs are disabled**.
- To allow `php -r "code"`, you must have the **exact literal string** in your allowlist.
- A pattern like `php *` will allow `php script.php` but will **block** `php -r "..."`.

---

## gVisor (runsc) — Kernel-Level Isolation

Agent containers run untrusted LLM-generated code. By default they share the host kernel — a kernel exploit inside the sandbox could escape to the host. [gVisor](https://gvisor.dev/) eliminates this by intercepting all syscalls in a user-space kernel written in Go. A kernel exploit inside the sandbox hits gVisor's implementation, not the host kernel.

### Setup

```bash
sudo bash scripts/install-gvisor.sh
```

This downloads the gVisor release tarball, verifies its SHA-512 checksum (a failed download, missing checksum or mismatch aborts before anything is installed), installs `runsc`, `containerd-shim-runsc-v1` and `gvisor-bin/` into `/usr/local/bin`, registers `runsc` as a Docker runtime with `--network=host`, and reloads the Docker daemon.

### Updating

Agent isolation depends on a current `runsc` *and* a patched host kernel. To update gVisor, re-run:

```bash
sudo bash scripts/install-gvisor.sh
```

The script prints the previous and new `runsc` version. Docker is reloaded, not restarted: already-running containers keep the old runtime until they are recreated. Check the host with `runsc --version` and `uname -r` (inside a sandbox gVisor always reports `4.19.0-gvisor`). To pin or roll back, set `GVISOR_RELEASE` (`latest` by default, or `YYYYMMDD.N`):

```bash
sudo GVISOR_RELEASE=20261102.0 bash scripts/install-gvisor.sh
```

### Docker daemon config

The install script registers runsc with `--network=host` in `/etc/docker/daemon.json`:

```json
{
  "runtimes": {
    "runsc": {
      "path": "/usr/local/bin/runsc",
      "runtimeArgs": ["--network=host"]
    }
  }
}
```

**`--network=host` is required.** Without it, gVisor uses its own internal network stack and containers cannot reach other services on Docker networks. This breaks connectivity to `api-relay`, `egress-proxy`, and any other service on shared Docker networks — causing all agent API calls to fail with `EAI_AGAIN` (DNS resolution failure).

If you installed gVisor manually (without the script), verify your `/etc/docker/daemon.json` includes `"runtimeArgs": ["--network=host"]` and restart Docker.

### Usage

Add `runtime: runsc` to agent services in your stack's `docker-compose.yml`:

```yaml
services:
  agent:
    runtime: runsc
    security_opt:
      - no-new-privileges:true
      # seccomp and apparmor are redundant under gVisor —
      # gVisor provides its own syscall filtering
```

Only agent containers need gVisor. Infrastructure services (nginx, mariadb, squid, api-relay) run trusted code and should stay on the default `runc` runtime for full performance.

### Verify

```bash
docker inspect <container> --format '{{.HostConfig.Runtime}}'
# Should return: runsc
```

---

## Agent → CarapaBox Isolation

CarapaBox holds the Docker socket. If an agent could reach CarapaBox directly, a vulnerability in the MCP/REST request handling could be exploited to gain Docker daemon access. To prevent this:

- **Agents have no network route to CarapaBox.** The `sandbox-relay` service is not configured in any agent relay-client config.
- **CarapaBoard manages sandbox lifecycle** on behalf of agents, calling the CarapaBox REST API from the host.
- **Only operator-controlled containers** (IDEs, dev tools) may have `sandbox-relay` access, via a separate relay-client config with a distinct hostname pattern.

Do not add a `sandbox-relay` service entry to agent relay-client configs (`relay-clients/carapa-bot.json`, etc.).

---

## Audit Log Integrity

For tamper-resistant logging, set `LOG_DRIVER=journald` in your `.env` file. This routes all container logs to the systemd journal — outside the container's filesystem — so a compromised container process cannot alter them. If not set, falls back to `json-file` (the Docker default).

**Note:** Some Docker CE builds (e.g., v29.x on Ubuntu 24.04) ship without journald support. Check with `dpkg -L docker-ce | grep journal`. If unsupported, leave `LOG_DRIVER` unset.

### Querying logs

```bash
# View CarapaBox logs
journalctl SYSLOG_IDENTIFIER=carapabox -f

# View api-relay logs
journalctl SYSLOG_IDENTIFIER=carapabox-relay -f

# View squid logs
journalctl SYSLOG_IDENTIFIER=carapabox-squid -f

# Filter by time
journalctl SYSLOG_IDENTIFIER=carapabox --since "1 hour ago"
```

### Forward Secure Sealing (FSS)

For additional tamper resistance, enable FSS in journald — this cryptographically seals log entries so past records cannot be altered even by root:

```bash
sudo journalctl --setup-keys   # generates sealing key pair
```

The internal JSONL audit log (`AUDIT_LOG_PATH`) is still written for the admin dashboard's log viewer. journald provides the tamper-resistant copy.

---

## Best Practices

1. **Deny by default**: All commands are blocked unless explicitly allowed by the stack's Rego policy. No configuration needed — this is the default.
2. **Protect stack `bin/`**: Keep the host directory admin-owned and mount it read-only at `/usr/local/stack-cli-bin`; adding an executable can override a same-name image default and expands the control-plane surface.
3. **Constrain services in Rego**: Authorize the normalized immediate trusted-bin shape only for services that need control-plane wrappers.
4. **Audit Regularly**: Review your `policy.rego` files to ensure only necessary commands are permitted. Recompile with `bash scripts/compile-policies.sh` after any changes.
