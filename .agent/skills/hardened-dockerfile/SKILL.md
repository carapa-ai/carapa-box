---
name: hardened-dockerfile
description: >
  Generate security-hardened Dockerfiles with Docker Hardened Images (DHI),
  digest-pinned base images, multi-stage builds, minimal packages, and
  non-root users. Use this skill whenever the user needs a new Dockerfile,
  wants to harden an existing one, is building a container image, asks about
  Docker security best practices, or mentions DHI, distroless, or image
  hardening. Also trigger when the user wants to containerize a service,
  create a Docker image for any runtime (Node.js, Python, PHP, Go, Rust,
  Java, nginx, etc.), or asks how to reduce CVEs in their container images.
---

# Hardened Dockerfile Generator

You generate production-ready, security-hardened Dockerfiles that follow the
CarapaBox security model. Every image you produce is built on Docker Hardened
Images (DHI), pinned by digest, minimized to the smallest useful package set,
and paired with a compose snippet that integrates with the project's existing
seccomp, AppArmor, and read-only filesystem hardening.

## Why this matters

Every binary in a container image is a potential post-exploitation tool. Every
unpinned tag is a supply chain attack vector. Every extra package is CVE surface
area. The goal is images that are:

- **Small** — only what the service needs to run, nothing more
- **Pinned** — reproducible builds, immune to tag mutation attacks
- **Scannable** — built on DHI with SLSA provenance and signed SBOMs
- **Non-root** — UID 1000, no privilege escalation possible
- **Auditable** — clear labels, healthchecks, and single-purpose layers

## Workflow

### 1. Understand the requirement

Ask the user what they're building if not already clear. You need:
- **Runtime**: Node.js, Python, PHP, Go, Rust, Java, nginx, or custom
- **Purpose**: API server, worker, static site, database client, CLI tool, etc.
- **Dependencies**: What packages or libraries are required
- **AI agent(s)**: Which coding agents should be bundled (see section below)
- **Ports**: What the service listens on (if any)
- **Data paths**: Where it reads/writes persistent data

If the user provides an existing Dockerfile, analyze it and produce a hardened
replacement.

### 1b. AI coding agent selection

If the container is a development sandbox or agent workspace (not a pure
runtime service like nginx or MariaDB), ask which AI coding agent(s) to
include. Agents live **inside the same container** as the runtime they operate
on — they need direct filesystem access to the code and direct access to CLI
tools (git, npm, php, python, etc.). Separating the agent into a different
container would add shared-volume complexity and cross-container exec overhead
for zero security benefit.

**In production, install only the agent(s) actually needed** — each adds
binary size and CVE surface. During experimentation it's fine to install
several, but production images should be lean.

**Available agents (npm-based — all require Node.js 18+):**

| Agent | npm package | Binary name |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | `claude` |
| Qwen Code | `@qwen-code/qwen-code` | `qwen-code` |
| Gemini CLI | `@google/gemini-cli` | `gemini` |
| Codex CLI | `@openai/codex` | `codex` |
| OpenCode | `opencode-ai` | `opencode` |

Most agents are npm packages and can share a single install step. Only install
the agent(s) the user selects — ask them to pick 1-2 for production.

**Also include supporting tools when agents are present:**

| Tool | npm package | Why |
|---|---|---|
| ajv-cli | `ajv-cli` | JSON schema validation used by agent tooling |
| openclaw | `openclaw@latest` | Sandbox orchestration CLI |

Installation pattern — install in the **build stage**, copy artifacts to
runtime. All npm agents share one `RUN` and one `COPY`:

```dockerfile
# ── Build stage (full upstream image — has shell + npm) ─────
FROM node:25 AS build

# Install only the selected agent(s) + supporting tools
RUN npm install -g --no-fund \
    @anthropic-ai/claude-code \
    @openai/codex \
    ajv-cli \
    openclaw@latest \
  && npm cache clean --force

# ── Runtime stage (DHI distroless — no shell, no npm) ──────
FROM dhi.io/node:25@sha256:DIGEST

# Copy global node_modules and all bin links from build
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin /usr/local/bin
```

**Important:** The build stage must use a **full upstream image** (e.g.
`node:25`, not `dhi.io/node:25`) because DHI images are distroless and have
no shell or package manager. The `COPY /usr/local/bin` approach copies all
bin symlinks at once — cleaner than listing each binary individually.

For pip-based agents (aider), use a virtual environment in the build stage
and copy it to runtime:

```dockerfile
# Build stage uses full upstream image (has shell + pip)
FROM python:3.13 AS build
RUN python -m venv /opt/aider \
  && /opt/aider/bin/pip install --no-cache-dir aider-chat

# Runtime stage uses DHI distroless (no shell, no pip)
FROM dhi.io/python:3.13@sha256:DIGEST
COPY --from=build /opt/aider /opt/aider
ENV PATH="/opt/aider/bin:$PATH"
```

If the user needs **both** npm-based and pip-based agents in the same image,
use a Node.js DHI base and install Python as a system package in the runtime
stage, then COPY the aider venv from a separate build stage.

**When the container is a pure runtime service** (web server, database, proxy),
skip this section entirely — agents don't belong in those images.

### 1c. CarapaBox agent compatibility

When the image is an **agent workspace** (not a pure runtime service), it must
be compatible with the CarapaBox agent orchestration system. This requires:

**Helper scripts** — mounted read-only at `/usr/local/ai-cli-bin/` (which must
be in `$PATH`). These scripts are **not baked into the image** — they are
bind-mounted from the host via the compose file. The image just needs the PATH
entry and `jq` installed:

| Script | Purpose |
|---|---|
| `run-agent.sh` | Launches agent processes; reads `args.json` + `prompt.txt` from a run directory, writes `output.v1.jsonl` + `output.v1.meta.json`, `exit_code`, and `pid` |
| `stop-agent.sh` | Gracefully kills agent process trees; writes exit code 137 |
| `claude-ollama.sh` | Runs Claude via local Ollama backend |
| `claude-llama.sh` | Runs Claude via local LiteLLM/llama backend |

**Required compose volumes for agent containers:**

```yaml
volumes:
  # Project workspace — agent reads/writes code here
  - ${LOCAL_REPO}:/workspace

  # Helper scripts (run-agent.sh, stop-agent.sh, etc.) — read-only
  - ${AI_CLI_BIN}:/usr/local/ai-cli-bin:ro

  # IPC: per-instance run directories (args, output, exit_code)
  - ${IPC_MOUNT}/${COMPOSE_PROJECT_NAME}:/workspace/ipc

  # Agent home — settings and history (OAuth tokens, .claude, .codex, etc.)
  - ${AGENT_HOME}:/home/ubuntu:rw
```

**Dockerfile requirements for agent compatibility:**

```dockerfile
# ── Build stage (full upstream image — has shell + apt) ─────
FROM debian:trixie-slim AS tools
# jq — required by run-agent.sh for parsing args.json
RUN apt-get update && apt-get install -y --no-install-recommends jq \
  && rm -rf /var/lib/apt/lists/*

# ── Runtime stage (DHI distroless) ──────────────────────────
FROM dhi.io/node:25@sha256:DIGEST
# Copy jq from build stage (can't apt-get install in distroless)
COPY --from=tools /usr/bin/jq /usr/bin/jq
# Ensure ai-cli-bin mount point is in PATH
ENV PATH="/usr/local/ai-cli-bin:$PATH"
```

**Important**: The helper scripts support multiple agent backends via a `case`
statement in `run-agent.sh` — Claude Code (default), Gemini CLI, Codex CLI,
and OpenCode each have their own argument-building logic. The `agentCmd` field
in `args.json` selects which agent to invoke.

### 2. Select the DHI base image

Always use Docker Hardened Images from `dhi.io`. These are **distroless** —
no package managers, minimal or no shell, ~95% fewer CVEs, SLSA Build Level 3
provenance, and signed SBOMs.

**Critical: DHI images have no package managers.** You cannot `apt-get install`
or `apk add` in a DHI image. If your service needs system packages, use a
multi-stage build: install packages in a full upstream image (e.g.
`debian:trixie-slim`, `alpine:3.23`), then COPY the binaries and their shared
libraries into the DHI runtime image.

| Runtime | DHI base image | Shell? | Pkg mgr? | Notes |
|---|---|---|---|---|
| Debian (general) | `dhi.io/debian-base:trixie` | ✅ `/bin/sh` | ❌ | Has shell, no apt-get — can run scripts but not install packages |
| Node.js | `dhi.io/node:25` | ❌ | ❌ | Truly distroless — no shell, no RUN possible. Use exec-form CMD only |
| Bun | `dhi.io/bun:1` | ❌ | ❌ | Truly distroless — same constraints as node |
| Alpine | `dhi.io/alpine-base:3.23` | ✅ `/bin/sh` | ❌ | Has shell, no apk — can run scripts but not install packages |

**Patterns by shell availability:**

**No shell (node:25, bun:1)** — truly distroless:
- No `RUN` commands possible (nothing to execute them)
- No `useradd` — use numeric `USER 1000:1000` instead
- No curl/wget — use the runtime's built-in HTTP client for healthchecks
- HEALTHCHECK must use exec form: `CMD ["node", "-e", "..."]`
- No ca-certificates package needed — Node/Bun have built-in TLS

```dockerfile
FROM dhi.io/node:25@sha256:DIGEST
WORKDIR /app
USER 1000:1000
HEALTHCHECK CMD ["node", "-e", "require('http').get('http://localhost:8080/',r=>{process.exit(r.statusCode<400?0:1)}).on('error',()=>process.exit(1))"]
CMD ["node", "/app/server.mjs"]
```

**Has shell, no package manager (debian-base, alpine-base)** — multi-stage
required for any system packages:
- Can run shell scripts and basic commands
- Cannot install packages — use `COPY --from=build` to bring in binaries
- Must copy shared libraries alongside binaries (use `ldd` in build stage)
- Cannot write to `/etc/passwd` directly — COPY it from the build stage
  (package installs in the build stage create the required users)

```dockerfile
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends squid \
  && rm -rf /var/lib/apt/lists/*

FROM dhi.io/debian-base:trixie@sha256:DIGEST
COPY --from=build /usr/sbin/squid /usr/sbin/squid
COPY --from=build /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
# Copy passwd/group from build stage (squid pkg creates the proxy user)
# DHI /etc/passwd is read-only — COPY overwrites, RUN echo >> fails
COPY --from=build /etc/passwd /etc/passwd
COPY --from=build /etc/group /etc/group
```

### 3. Pin by digest

Every `FROM` line must include a `@sha256:` digest pin with the human-readable
tag in a comment. This prevents tag mutation attacks while keeping the
Dockerfile maintainable.

Format:
```dockerfile
# dhi.io/node:25 — pinned 2026-03-05
FROM dhi.io/node@sha256:abc123...def456 AS build
```

To get the current digest, instruct the user to run:
```bash
docker pull dhi.io/node:25
docker inspect --format='{{index .RepoDigests 0}}' dhi.io/node:25
```

If you don't have the actual digest available, use a placeholder and mark it
clearly:
```dockerfile
# dhi.io/node:25 — UPDATE DIGEST before building
FROM dhi.io/node:25@sha256:REPLACE_WITH_ACTUAL_DIGEST AS build
```

### 4. Use multi-stage builds (when warranted)

Use multi-stage builds when there are **actual build dependencies to discard**.
With DHI distroless images, multi-stage is also required whenever you need
**any system packages** — since DHI images have no package manager, you must
install in a full upstream image and COPY the results.

**When multi-stage is required:**

- DHI runtime + any system packages (apt/apk install → COPY binaries + libs)
- npm install, pip install (build stage → COPY node_modules / venv)
- Compiled languages (go build, cargo build → COPY binary)
- Bundling (webpack, vite → COPY dist/)

**When single-stage is sufficient:**

- Distroless runtime images that need nothing extra (e.g. node:25 with
  bind-mounted app files — no RUN, no packages, no shell needed)
- DHI base images where the runtime is already included and no additional
  system packages are required

```
┌─────────────────────────────────┐
│  Stage 1: build                 │
│  - Full SDK/compiler            │
│  - npm install / pip install    │
│  - Compile, bundle, test        │
├─────────────────────────────────┤
│  Stage 2: runtime               │
│  - Minimal base (slim/distroless)│
│  - COPY --from=build artifacts  │
│  - Non-root USER                │
│  - HEALTHCHECK                  │
└─────────────────────────────────┘
```

For compiled languages (Go, Rust), the runtime stage can be as small as
`dhi.io/debian-base:trixie` with just the binary. For interpreted languages,
use the slim/runtime variant of the DHI image.

### 5. Minimize packages

These rules reduce attack surface:

- **Always** use `--no-install-recommends` with apt-get
- **Always** clean caches in the same `RUN` layer: `rm -rf /var/lib/apt/lists/*`
- **Never** install editors (vim, nano), debugging tools (strace, gdb), or
  network diagnostic tools (netcat, nmap, telnet) in runtime images
- **Never** install wget if curl is available (one HTTP client is enough)
- **Never** leave package managers (pip, npm) in runtime images if not needed
  at runtime — install in the build stage and copy artifacts
- **Question every package** — if the user lists a dependency, include it, but
  ask yourself: "Does this belong in the runtime stage or only in build?"

For each package installed, add a comment block above the `RUN` explaining why.
**Never** put inline `# comments` after `\` continuations — they break the
Dockerfile parser by terminating the line continuation:
```dockerfile
# ca-certificates — TLS certificate validation
# curl             — healthcheck probe
# tini             — PID 1 init for signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/*
```

### 6. Apply security defaults

Every Dockerfile must include:

**Non-root user (UID 1000):**
```dockerfile
RUN groupadd -g 1000 appuser && useradd -m -u 1000 -g appuser -s /bin/sh appuser
USER appuser
```

**HEALTHCHECK:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1
```
Adapt the healthcheck to the service type. For non-HTTP services, use a
process check or TCP probe.

**OCI labels:**
```dockerfile
LABEL org.opencontainers.image.title="service-name" \
      org.opencontainers.image.description="Brief description" \
      org.opencontainers.image.source="https://github.com/org/repo" \
      org.opencontainers.image.version="1.0.0"
```

**No secrets in layers:**
- Never use `ARG` or `ENV` for passwords, API keys, or tokens
- Never `COPY` credential files into the image
- Secrets are injected at runtime via environment variables or mounted files

### 7. Output the CVE scan hook

**Important:** AI agents run inside containers and have no access to the Docker
daemon. CVE scan commands (`docker scout`, `trivy`) must run on the **host**,
not inside the container. The correct integration point is the stack's
`before-start.sh` hook, which executes on the host before `docker compose up`.

After the Dockerfile, always output a `before-start.sh` snippet that the user
can add to their stack's existing hook:

```bash
# ── Add to before-start.sh (runs on host before docker compose up) ──

# Build the image
docker compose build service-name

# Scan for CVEs — fail the start if critical vulnerabilities found
echo "🔍 Scanning image for vulnerabilities..."
if command -v trivy >/dev/null 2>&1; then
  trivy image --severity HIGH,CRITICAL --exit-code 1 service-name:latest
elif docker scout version >/dev/null 2>&1; then
  docker scout cves local://service-name:latest --only-severity critical,high
else
  echo "⚠️  No CVE scanner found. Install trivy or docker scout."
fi
```

Also include a standalone scan command for manual use on the host:

```bash
# Manual scan (run on host, not inside container)
docker scout cves local://image-name:latest
# or
trivy image --severity HIGH,CRITICAL image-name:latest
```

### 8. Output a compose snippet

Generate a `docker-compose.yml` snippet that integrates with the CarapaBox
security model. Use the correct isolation strategy based on the service role:

**Agent containers** use gVisor (`runtime: runsc`) for kernel-level isolation.
gVisor intercepts all syscalls in user space, so seccomp and AppArmor are
redundant and should be omitted.

**Infrastructure services** (web, database, proxy) use seccomp + AppArmor
on the default `runc` runtime:

| Service role | Runtime | seccomp profile | AppArmor profile |
|---|---|---|---|
| Agent / worker / CLI | `runsc` (gVisor) | *not needed* | *not needed* |
| Web server (nginx) | `runc` (default) | `seccomp-web.json` | `carapabox-web` |
| Database (MariaDB, PostgreSQL, MinIO) | `runc` (default) | `seccomp-database.json` | `carapabox-database` |
| Proxy (squid, relay, TCP forwarder) | `runc` (default) | `seccomp-proxy.json` | `carapabox-proxy` |

Agent container template:
```yaml
services:
  agent:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    runtime: runsc

    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
          pids: 2000

    logging:
      driver: journald
      options:
        tag: "carapabox-agent"

    security_opt:
      - no-new-privileges:true
      # seccomp and apparmor are redundant under gVisor
    cap_drop:
      - ALL

    read_only: true
    tmpfs:
      - /tmp:size=64M,nosuid,nodev
      - /run:size=8M,nosuid,nodev

    networks:
      - internal

networks:
  internal:
    driver: bridge
    internal: true
```

Infrastructure service template:
```yaml
services:
  service-name:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped

    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
          pids: 200

    logging:
      driver: journald
      options:
        tag: "carapabox-service"

    security_opt:
      - no-new-privileges:true
      - seccomp:../../security/seccomp-default.json
      - apparmor=carapabox-agent
    cap_drop:
      - ALL

    read_only: true
    tmpfs:
      - /tmp:size=64M,noexec,nosuid,nodev
      - /run:size=8M,nosuid,nodev

    networks:
      - internal

networks:
  internal:
    driver: bridge
    internal: true
```

Adjust resource limits, ports, volumes, tmpfs paths, and network membership
based on the service's actual needs. Only add capabilities that the service
genuinely requires — document the reason for each one.

**Port binding:** When exposing ports, always bind to localhost only:
`"127.0.0.1:HOST_PORT:CONTAINER_PORT"`. Never use `0.0.0.0` or bare
`HOST_PORT:CONTAINER_PORT` which exposes to all interfaces.

**IMPORTANT:** Every service in the compose file — including companion services
like databases, caches, and web servers — MUST have `deploy.resources.limits`
with `cpus`, `memory`, and `pids`. No service may omit PID limits. Use these
defaults as a starting point:

| Service type | pids | memory |
|---|---|---|
| Agent / workspace | 2000 | 8G |
| Application runtime | 200 | 512M |
| Database (MariaDB, Postgres) | 300 | 1G |
| Cache (Redis, Memcached) | 100 | 256M |
| Web server (nginx) | 200 | 256M |
| Proxy / relay | 100 | 128M |

**For agent/workspace containers**, use this extended template with higher
resource limits and the required agent mounts:

```yaml
services:
  agent:
    image: my-agent-image:latest
    user: "1000:1000"
    working_dir: /workspace
    stdin_open: true
    tty: true
    init: true
    restart: unless-stopped

    deploy:
      resources:
        limits:
          cpus: '4.0'
          memory: 8G
          pids: 2000

    runtime: runsc
    logging:
      driver: journald
      options:
        tag: "carapabox-agent"

    security_opt:
      - no-new-privileges:true
      # seccomp and apparmor are redundant under gVisor
    cap_drop:
      - ALL
    cap_add:
      - CHOWN       # file ownership in workspace
      - SETUID       # agent process management
      - SETGID       # agent process management

    read_only: true
    tmpfs:
      - /tmp:size=64M,noexec,nosuid,nodev
      - /var/log:size=8M,nosuid,nodev,uid=1000,gid=1000
      - /run:size=8M,nosuid,nodev,uid=1000,gid=1000

    environment:
      - ANTHROPIC_BASE_URL=http://api-relay:8080/anthropic
      - HTTP_PROXY=http://squid:3128
      - HTTPS_PROXY=http://squid:3128
      - NO_PROXY=localhost,127.0.0.1,api-relay,llama-proxy

    volumes:
      - ${LOCAL_REPO}:/workspace
      - ${AI_CLI_BIN}:/usr/local/ai-cli-bin:ro
      - ${IPC_MOUNT}/${COMPOSE_PROJECT_NAME}:/workspace/ipc
      # Agent home — settings and history (OAuth tokens, .claude, .codex, etc.)
      - ${AGENT_HOME}:/home/ubuntu:rw

    networks:
      - agent_egress

networks:
  agent_egress:
    external: true
    name: agent_egress
```

## Example: Hardening an existing Dockerfile

Given this existing Dockerfile:
```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y bash curl git nodejs npm python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY bridge.js /usr/local/bin/model-bridge
RUN chmod +x /usr/local/bin/model-bridge
RUN groupadd -g 1000 sandbox && useradd -m -u 1000 -g sandbox -s /bin/bash sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
```

Produce:
```dockerfile
# ── Build stage (full upstream image — has shell + apt) ─────
FROM debian:trixie-slim AS build

ENV DEBIAN_FRONTEND=noninteractive

# bash    — interactive shell for sandbox commands
# git     — version control for workspace
# jq      — JSON processing for agent scripts
# python3 — Python runtime for agent scripts
# ripgrep — fast file search for agents
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    git \
    jq \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY bridge.js /tmp/model-bridge

# ── Runtime stage (DHI distroless — no shell, no apt) ───────
# dhi.io/node:25 — UPDATE DIGEST before building
FROM dhi.io/node:25@sha256:REPLACE_WITH_ACTUAL_DIGEST

LABEL org.opencontainers.image.title="openclaw-sandbox" \
      org.opencontainers.image.description="Hardened sandbox for secure code execution"

# Copy system packages from build stage (distroless has no apt-get)
COPY --from=build /usr/bin/bash /usr/bin/bash
COPY --from=build /usr/bin/git /usr/bin/git
COPY --from=build /usr/bin/jq /usr/bin/jq
COPY --from=build /usr/bin/python3 /usr/bin/python3
COPY --from=build /usr/bin/rg /usr/bin/rg
COPY --from=build /usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=build /usr/lib/git-core/ /usr/lib/git-core/

# Model bridge for Docker Model Runner support
COPY --from=build /tmp/model-bridge /usr/local/bin/model-bridge

# Non-root user — numeric UID (no useradd in distroless)
USER 1000:1000
WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "process.exit(0)"]

CMD ["sleep", "infinity"]
```

Key improvements:
- DHI distroless runtime instead of Docker Hub `debian:bookworm-slim`
- Digest pin placeholder (user fills in actual digest)
- Multi-stage build: packages installed in full upstream image, binaries + libs
  copied to distroless runtime via `COPY --from=build`
- `--no-install-recommends` on apt-get (in build stage)
- Every package has a comment explaining why it's needed
- `npm` removed (Node.js runtime is sufficient; npm not needed at runtime)
- Numeric `USER 1000:1000` (no useradd in distroless)
- OCI labels for auditability
- HEALTHCHECK uses node exec form (no shell/curl in distroless)

## Checklist before delivering

Before presenting the Dockerfile to the user, verify:

- [ ] Runtime `FROM` uses `dhi.io/` image with `@sha256:` digest (or placeholder)
- [ ] Build `FROM` uses full upstream image (e.g. `debian:trixie-slim`, `node:25`) — NOT `dhi.io/` (distroless has no shell/pkg mgr)
- [ ] No `RUN apt-get`/`apk add` in the DHI runtime stage — all packages installed in build stage and copied via `COPY --from=build`
- [ ] `--no-install-recommends` on every `apt-get install` (in build stage)
- [ ] Cache cleanup (`rm -rf /var/lib/apt/lists/*`) in same layer as install (in build stage)
- [ ] Every installed package has a comment justifying its inclusion
- [ ] Non-root `USER 1000:1000` (numeric — no useradd in distroless)
- [ ] `HEALTHCHECK` instruction present
- [ ] OCI labels present
- [ ] No secrets in `ARG`, `ENV`, or `COPY` instructions
- [ ] AI agent(s) installed only if sandbox/workspace image (not in pure runtime)
- [ ] Agent binaries installed via multi-stage build (not left with npm/pip in runtime)
- [ ] Only the agent(s) the user requested are included (no extras)
- [ ] Agent images include `PATH="/usr/local/ai-cli-bin:$PATH"` and `jq` for CarapaBox compatibility
- [ ] Agent compose snippet includes required volume mounts (ai-cli-bin, ipc, keys)
- [ ] CVE scan provided as `before-start.sh` hook snippet (host-side, not in-container)
- [ ] Compose snippet uses correct seccomp + AppArmor profile for the role
- [ ] Compose snippet includes `read_only: true`, `cap_drop: ALL`, tmpfs mounts
- [ ] Compose snippet includes `logging:` driver with `max-size` and `max-file` limits
- [ ] Exposed ports bind to `127.0.0.1` only (not `0.0.0.0` or bare port mappings)
