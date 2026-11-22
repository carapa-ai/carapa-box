# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-22

First public release.

### Added
- MCP server over stdio and Streamable HTTP, an HTTP API mode (`bun run start:http`) and a REST adapter that exposes every MCP tool on `POST /api/tools/:name`
- Docker Compose stack lifecycle (start, stop, restart, build) with before-start, after-start, before-stop and after-stop hooks, health check polling and a `:rollback` image tag before each deploy
- File read, write and edit within allowlisted mount paths; stack-declared mounts (`stack-mounts.yaml`)
- Git worktrees and branches: `sandbox_worktree`, the `sandbox_branch` lifecycle (`commit`, `prepare_review`, `inspect`, `merge`; enabled by `ENABLE_SANDBOX_GIT=true`) and project `.agent/worktree-{setup,teardown}.sh` and `after-start.sh` hooks
- `sandbox_issues` reads GitLab and GitHub issues with the project's provider account
- OPA/Rego policies compiled to WASM validate commands against per-stack allowlists for commands, arguments and environment variables (`sandbox_policy_check`); YAML network policies reload without a restart (`sandbox_network_policy_reload`)
- Per-instance bridge networks with no inter-container communication
- Ingress proxy for publishing project apps, and inbound SSH routes the operator enables per sandbox
- Admin API (`/api/admin/*`) and an admin dashboard at `/admin/`
- Bearer-token authentication with two tiers: `CARAPA_BOX_API_TOKEN` and the admin `CARAPA_BOX_ADMIN_TOKEN`
- `/health` reports the running build (version, git commit, build time, start time)
- Graceful shutdown: on SIGTERM the box refuses new tool calls and waits for in-flight ones (up to `CARAPA_BOX_SHUTDOWN_DRAIN_MS`, default 120000)
- Egress stack: Squid as the only outbound path, an api-relay that injects credentials so sandboxes never hold provider keys, and llama-proxy for local model engines. Box starts the egress services when they are not running
- Sign-in provider accounts (Claude, Codex, Antigravity, Muse, Grok, Cursor), several per provider: the relay keeps a session on one account and moves it only when that account's quota is used up. See `docs/provider-accounts.md`
- API-key provider accounts: Mistral Vibe, Mistral API, OpenRouter, Anthropic API, OpenAI API, Google Gemini API, NVIDIA API, Typesafe / Jev, GitLab and GitHub. Keys are checked on save and every 24 hours, and their expiry is reported
- Usage and spend reporting: subscription usage windows and resets, Mistral allowances, OpenRouter credit and month-to-date Anthropic API spend
- Project integrations: a token saved for one project is served only to that project's containers and only for the method and path pairs on its `allow` list. GitLab and GitHub are presets; custom HTTPS integrations use bearer, header, basic or query auth. See `egress-proxy/README.md`
- Remote MCP servers with OAuth: the relay logs in to operator-allowlisted servers, holds the tokens and serves them to the listed projects. See `docs/mcp-connections.md`
- Read-only git over HTTPS through the relay (`/gitlab-git/`, `/github-git/`) with a per-client repository allowlist, for sandboxes where SSH is blocked; there is no push
- Per-provider request pacing (`requestsPerSecond` in `relay-clients/`)
- Optional encryption at rest for the provider account store (`CARAPA_CREDENTIALS_KEY_FILE`, AES-256-GCM)
- CarapaBot agent stack with installable harnesses: Claude Code, Codex, Pi, Oh My Pi, OpenCode, Cursor, Antigravity, Grok Build, Muse Code, Mistral Vibe, Prime Agent and Hermes, all reaching their providers through the relay
- Shared browser for agents and Board's browser tab; `CARAPA_BROWSER_HEADED=1` runs it headed on a virtual display so a person can pass Cloudflare Turnstile checks
- `carapa-delegate` for one-shot subagents (`--tier fast|balanced|frontier`) and `restart-hold` to keep a sandbox from restarting during a long job
- Hub mode: a box connects to a CarapaBoard hub and uses the hub's provider accounts. See `docs/multi-host.md`
- Mac native runner: agents run in a per-project Seatbelt sandbox, with Board's shell tab (needs `tmux`) and live browser viewer; `bun run runner` updates its own checkout
- Linux runner with OpenShell sandboxes (experimental), including CarapaBrain services and libkrun microVMs (`openshell.driver: "vm"`). See `docs/multi-host.md`
- Agent-guided setup: CarapaBoard's setup skill for Box and Board together, or this repository's skill (`/setup` in Claude Code) and Codex plugin for CarapaBox alone
- `uninstall.sh` (in `.agent/skills/setup/scripts/`) removes the controller, egress proxy, controller-started stacks and the host-mode systemd user service. Images, install state and secrets are removed only on request; group directories, agent homes and CarapaBoard data are never removed. It prints the plan unless `--yes`
- CVE scanning of built images and before a stack starts (report-only)

### Security
- Hardened containers: non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, and role-based seccomp and AppArmor profiles. The bundled agent stack runs under gVisor (`runtime: runsc`)
- Docker Hardened Images (DHI) base images, pinned by digest
- Policies fail closed: a missing or unloadable `base.wasm` denies
- Squid blocks private, loopback and link-local destinations after DNS resolution, allows CONNECT only to ports 80 and 443, and denies the Board and Box control-plane ports
- llama-proxy refuses Ollama and Docker Model Runner model-management endpoints from sandboxes, so model pulls cannot bypass Squid
- Sandbox mount sources are pinned through Docker volume subpaths, and IPC and group file operations never follow swapped symlinks
- Keyed git never takes its remote URL or helper programs from agent-writable repository config
- A sandbox's requests are accepted only for its own project's egress hostname, and its inbound SSH route is published only when the operator enables it
- A controller on loopback without a token rejects cross-origin browser requests
- Secrets are kept out of agent-editable worktrees and admin config responses; path traversal in stack and instance names is rejected; environment variables are filtered per policy

### Known Issues
- Controller image: 3 HIGH findings without a fixed release: CVE-2026-41567 and CVE-2026-42306 (`github.com/docker/docker`, vendored by Buildx) and CVE-2026-78661 (`golang.org/x/net` in Compose; fixed in 0.62.0, not yet in a Compose release)
- CarapaBot Debian runtime: 792 HIGH/CRITICAL findings, none with a fixed version (see `stacks/carapa-bot/SECURITY-SCAN.md`). The optional Alpine runtime (`./build.sh --alpine`) scans with 0 HIGH/CRITICAL, but its Chromium 149 is older than the Debian runtime's 156
- OpenShell runner: the browser viewer and per-task worktrees are not supported yet
- Mac native runner: Mac-local app previews are not supported yet
