# Hardened Dockerfile Skill

CarapaBox includes an AI skill that generates security-hardened Dockerfiles for
any new service or when hardening existing container images. The skill is
located at `.claude/skills/hardened-dockerfile/SKILL.md` and is automatically
triggered when an agent is asked to create or improve a Dockerfile.

## What it does

The skill instructs AI agents to produce Dockerfiles that follow the CarapaBox
security model. Every generated image includes:

- **DHI base images** from `dhi.io` (Docker Hardened Images) — distroless,
  ~95% fewer CVEs, SLSA Build Level 3 provenance, signed SBOMs
- **Digest pinning** — every `FROM` line uses `@sha256:` to prevent tag
  mutation attacks
- **Multi-stage builds** — build tools and compilers stay out of the runtime
  image
- **Minimal packages** — `--no-install-recommends`, inline comments justifying
  each package, cache cleanup in the same layer
- **Non-root user** — UID 1000, matching host permissions
- **HEALTHCHECK** and **OCI labels** — for monitoring and auditability
- **CVE scan hook** — a `before-start.sh` snippet for the host (not
  in-container, since agents have no Docker daemon access)
- **Compose snippet** — integrates with the existing seccomp, AppArmor, and
  read-only filesystem hardening

## Security checklist items addressed

| Description | How the skill addresses it |
|---|---|
| Migrate to Docker Hardened Images | DHI base image catalog with mapping table |
| Pin images by digest | `@sha256:` on every `FROM` line |
| CVE scanning in build pipeline | `before-start.sh` hook with trivy/scout |
| Minimise installed packages | `--no-install-recommends`, multi-stage, package justification comments |

## When to use it

The skill triggers automatically when you ask an agent to:

- Create a new Dockerfile for any runtime (Node.js, Python, PHP, Go, nginx…)
- Harden or improve an existing Dockerfile
- Containerize a service
- Reduce CVEs in container images
- Anything involving DHI, distroless, or image hardening

You can also invoke it explicitly:

```bash
claude -p "Create a Dockerfile for a Node.js API server on port 3000 with mysql2. Include Claude Code as the AI agent."
```

## Image types

The skill handles two distinct image types:

### Pure runtime services (nginx, MariaDB, proxy)

No AI agents. Minimal image with only the runtime and its dependencies.
Compose snippet uses the appropriate role-specific security profiles:

| Role | Seccomp | AppArmor |
|---|---|---|
| Web server | `seccomp-web.json` | `carapabox-web` |
| Database | `seccomp-database.json` | `carapabox-database` |
| Proxy | `seccomp-proxy.json` | `carapabox-proxy` |

### Agent workspace images

Includes AI coding agents installed via multi-stage build. These images have
additional requirements for CarapaBox compatibility.

**Supported agents:**

| Agent | Package | Install method |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | npm |
| Qwen Code | `@qwen-code/qwen-code` | npm |
| Gemini CLI | `@google/gemini-cli` | npm |
| Codex CLI | `@openai/codex` | npm |
| OpenCode | `opencode-ai` | npm |

All npm-based agents share a single `npm install -g` in the build stage and
a single `COPY --from=build /usr/local/bin` to the runtime stage.

## CarapaBox agent compatibility

Agent workspace images must be compatible with the CarapaBox orchestration
system. The skill automatically includes these requirements:

### PATH and dependencies

```dockerfile
ENV PATH="/usr/local/stack-cli-bin:/usr/local/ai-cli-bin:$PATH"
```

The `jq` package is installed in the runtime image — it's required by
`run-agent.sh` for parsing `args.json`.

### Trusted executables (image defaults and host overrides)

Image-built defaults live at `/usr/local/ai-cli-bin/`. Optional stack scripts
are bind-mounted read-only at `/usr/local/stack-cli-bin/`; that directory comes
first in `PATH`, matching `sandbox_exec` bare-name override precedence.

| Script | Purpose |
|---|---|
| `run-agent.sh` | Launches agent processes from a run directory containing `args.json` + `prompt.txt`. Writes `output.jsonl`, `exit_code`, and `pid`. |
| `stop-agent.sh` | Gracefully kills agent process trees (SIGTERM → SIGKILL fallback). Writes exit code 137. |

`run-agent.sh` supports multiple backends via a `case` statement — the
`agentCmd` field in `args.json` selects which agent to invoke (Claude Code,
Gemini CLI, Codex CLI, or OpenCode).

### Required compose volumes

The skill generates these volume mounts for agent containers:

```yaml
volumes:
  # Project workspace
  - ${LOCAL_REPO}:/workspace

  # Helper scripts (run-agent.sh, stop-agent.sh, etc.)
  - ${STACK_DIR}/bin:/usr/local/stack-cli-bin:ro

  # IPC: per-instance run directories
  - ${IPC_MOUNT}/${COMPOSE_PROJECT_NAME}:/workspace/ipc

  # Agent home — settings and history (OAuth tokens, .claude, .codex, etc.)
  - ${AGENT_HOME}:/home/ubuntu:rw
```

## CVE scanning

Agents run inside containers with no Docker daemon access. CVE scanning must
happen on the **host**, not inside the container. The skill outputs a
`before-start.sh` hook snippet:

```bash
# ── Add to before-start.sh (runs on host before docker compose up) ──
docker compose build service-name

echo "Scanning image for vulnerabilities..."
if command -v trivy >/dev/null 2>&1; then
  trivy image --severity HIGH,CRITICAL --exit-code 1 service-name:latest
elif docker scout version >/dev/null 2>&1; then
  docker scout cves local://service-name:latest --only-severity critical,high
else
  echo "No CVE scanner found. Install trivy or docker scout."
fi
```

## Testing the skill

### Manual test prompts

Run from the host to verify the skill is working:

```bash
# Test 1: Agent workspace image
claude -p "Create a Dockerfile for a Node.js API server that connects to MariaDB. \
  It should run on port 3000 and needs the mysql2 npm package. \
  Include Claude Code as the AI agent."

# Test 2: Harden an existing Dockerfile
claude -p 'Harden this existing Dockerfile:

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y bash curl git nodejs npm python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY bridge.js /usr/local/bin/model-bridge
RUN chmod +x /usr/local/bin/model-bridge
RUN groupadd -g 1000 sandbox && useradd -m -u 1000 -g sandbox -s /bin/bash sandbox
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]'

# Test 3: Pure runtime service (no agents)
claude -p "Create a Dockerfile for a static nginx site that serves a React build \
  from the ./build directory. No AI agents needed — this is a pure runtime service."
```

### What to verify in each output

| Check | Agent image | Runtime image |
|---|---|---|
| `FROM dhi.io/...@sha256:` | Yes | Yes |
| Multi-stage build (`AS build` → `COPY --from=build`) | Yes | Yes |
| `--no-install-recommends` | Yes | Yes |
| Comment per package | Yes | Yes |
| `USER` with UID 1000 | Yes | Yes |
| `HEALTHCHECK` | Yes | Yes |
| OCI labels | Yes | Yes |
| `before-start.sh` CVE scan hook | Yes | Yes |
| `PATH="/usr/local/stack-cli-bin:/usr/local/ai-cli-bin:$PATH"` | Yes | No |
| `jq` installed | Yes | No |
| Agent npm install in build stage | Yes | No |
| Agent compose volumes (stack-cli-bin, ipc) | Yes | No |
| Correct seccomp/AppArmor role | `seccomp-default` / `carapabox-agent` | Role-specific |
| `read_only: true` + `cap_drop: ALL` + tmpfs | Yes | Yes |
| No secrets in image layers | Yes | Yes |

### Automated evaluation

Evals are defined in `.claude/skills/hardened-dockerfile/evals.json` (3 test
cases, 44 assertions total). The skill-creator skill used below comes from
[`carapa-agent-kit`](https://github.com/carapa-ai/carapa-agent-kit) and is not
part of this repository. Run the full eval pipeline:

```bash
claude -p "Use the skill-creator to run evals for the hardened-dockerfile skill. \
  Evals are in .claude/skills/hardened-dockerfile/evals.json. \
  Save results to .claude/skills/hardened-dockerfile-workspace/iteration-2/. \
  Generate a static eval viewer HTML when done."
```

Results are saved to `.claude/skills/hardened-dockerfile-workspace/` organised
by iteration, with grading, timing, and benchmark data.

## File locations

```
.claude/skills/hardened-dockerfile/
├── SKILL.md             # Skill instructions (read by agents)
└── evals.json           # Test cases and assertions

.claude/skills/hardened-dockerfile-workspace/
└── iteration-1/         # Eval results
    ├── eval-0-nodejs-api/
    ├── eval-1-harden-existing/
    └── eval-2-static-nginx/

security/                # Referenced by compose snippets
├── seccomp-default.json
├── seccomp-web.json
├── seccomp-database.json
├── seccomp-proxy.json
├── apparmor-agent
├── apparmor-web
├── apparmor-database
└── apparmor-proxy
```

## Security layering

The generated Dockerfiles and compose snippets integrate with the full
CarapaBox defence-in-depth stack:

```
┌─────────────────────────────────────────────┐
│  Layer 1: Image hardening (this skill)      │
│  DHI base, digest pin, multi-stage,         │
│  minimal packages, non-root, CVE scan       │
├─────────────────────────────────────────────┤
│  Layer 2: gVisor (agent containers)         │
│  User-space kernel, syscall interception    │
│  Replaces layers 3-4 for agent services     │
├─────────────────────────────────────────────┤
│  Layer 3: Seccomp (syscall filtering)       │
│  4 role-based profiles, whitelist approach   │
│  (infrastructure services only w/ gVisor)   │
├─────────────────────────────────────────────┤
│  Layer 4: AppArmor (filesystem/network MAC) │
│  4 role-based profiles, deny-always-wins    │
│  (infrastructure services only w/ gVisor)   │
├─────────────────────────────────────────────┤
│  Layer 5: Read-only root filesystem         │
│  read_only: true + minimal tmpfs mounts     │
├─────────────────────────────────────────────┤
│  Layer 6: Network isolation                 │
│  Per-instance bridges, egress proxy, no ICC │
├─────────────────────────────────────────────┤
│  Layer 7: no-new-privileges                 │
│  Prevents privilege escalation via setuid   │
├─────────────────────────────────────────────┤
│  Layer 8: Agent → CarapaBox isolation       │
│  No network route from agents to Docker     │
│  socket; CarapaBoard proxies all requests   │
└─────────────────────────────────────────────┘
```

Each layer is independent — a failure in one layer is caught by the next.
The hardened Dockerfile skill provides layer 1 (image hardening) and generates
compose snippets that configure layers 2–7. Layer 8 is enforced via
relay-client configuration (no `sandbox-relay` in agent configs).
