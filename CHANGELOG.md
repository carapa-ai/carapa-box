# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-21

First public release.

### Added
- GitHub accounts in Provider accounts (`github` key, server `https://github.com` or GitHub Enterprise): the relay serves the key on `/github/` (to `api.github.com` or `<server>/api/v3`) and read-only clones on `/github-git/` (allowlisted by the route's `gitRepos`), and `sandbox_issues` reads GitHub issues of a github remote
- Linux runner with OpenShell sandboxes (experimental): `os-runner` runs a project's agents in one long-lived OpenShell sandbox when `openshell` is set in its config. The project's directories are mounted at their host paths, writes are limited to them, and the only network destination is the runner's relay forwarder. It connects as a native box with isolation `openshell`; Board's shell tab runs in the sandbox, while the browser viewer and per-task worktrees are not supported yet. See `docs/multi-host.md`
- CarapaBrain on the OpenShell runner (experimental): `openshell.stacks` gives a stack its own image, environment file and a long-lived `service`. The runner starts it detached in the project's sandbox, keeps it healthy, publishes its port on the host with `openshell forward service` and reports it as the `ingress` entry of `sandbox_ps`, so Board's Brain client reaches it without changes. Also: a sandbox stuck in `Error` is replaced instead of started, and Codex WebSockets, Pi's model list and Codex's relay provider are set up in a native agent home. See `docs/multi-host.md`
- MicroVM sandboxes for the OS runner (experimental): `openshell.driver: "vm"` runs each project in an OpenShell libkrun microVM with its own kernel (OpenShell cannot run under gVisor). The runner exports the Docker image as a rootfs archive, copies the harness volume to a host directory, mounts the checkout, the runner root and that copy (the VM driver allows 3 bind mounts) and links the remaining paths in the rootfs. New `stateDir` setting keeps runner state outside the mounted root. See `docs/multi-host.md`
- Graceful shutdown: on SIGTERM the box refuses new tool calls ("carapa-box is restarting") and waits for in-flight ones (up to `CARAPA_BOX_SHUTDOWN_DRAIN_MS`, default 120000); `stop_grace_period: 150s`
- Mac native runner: Board's shell tab works for native projects (tmux over the hub tunnel, `http-tunnel` capability). The tmux server, panes and pane reader run inside the project's Seatbelt sandbox; the runner needs `tmux` on `PATH`
- Mac native runner: Board's browser viewer (`/api/browser/*`) is served in-process over the hub socket, so the session the browser tab started can be watched live with clicks and typing. `browser-viewer` runs inside the project's agent sandbox, where its dashboard listens on a Unix socket under the project's tmp root instead of loopback TCP (which the profile denies; containers are unchanged); closing a viewer ends its stdin and kills it after 2.5 s, and `sandbox_stop` and runner shutdown close the project's viewers. The sandbox host protocol gained opt-in `stdin` (`{id, in}` / `{id, eof}`); other commands keep stdin ignored. Mac-local app previews are still not supported
- Project integrations: a token saved for one sandbox instance (CarapaBoard, Project settings, Integrations) is stored as a Provider account with `scope: "project"`. The relay uses it only for requests from that instance's containers whose method and path match an `allow` rule exactly (`*` matches one segment; trailing-slash rules are distinct). GitLab and GitHub are presets on `/gitlab/` and `/github/`; custom integrations get their own HTTPS route (`auth`: `bearer`, `header`, `basic` or `query`; a query token is redacted from `Location`, `Content-Location`, `Link` and `Refresh` response headers). Strict relay clients reach an integration-only route through their grant, and Squid allows the integration host for the relay only (`relay_integration`). Saving checks GitLab and GitHub tokens, and `PATCH /api/admin/provider-accounts/<id>` can edit an integration's `expiresAt`. See `egress-proxy/README.md`
- API-key provider accounts: Mistral Vibe, Mistral API, OpenRouter, Anthropic API, OpenAI API, Google Gemini API, NVIDIA API, Typesafe / Jev, GitLab and GitHub keys are managed like logins (checked on save, installed at once, served on the route of the same name, per scope or relay client). A key account reports `expiresAt` (manual `YYYY-MM-DD`, or the provider's own for GitLab and GitHub), `expirySource`, `keyCheck` (`valid` or `rejected`) and `keyCheckedAt`, refreshed every 24 hours. `PATCH /api/admin/provider-accounts/<id>` also sets `tier`, `capacity` (1-1000) and `label`, and `POST /api/admin/provider-accounts/order` stores a manual account order
- Several sign-in accounts per provider (Claude, Codex, Antigravity, Muse, Grok, Cursor): the relay keeps a session on one account for 24 hours, puts a new session on the account whose quota resets soonest, and moves a session only when its account is used up (usage window at 100%, Codex `usage_limit_reached`, Claude `rejected`), re-sending the refused request on the next account. Sessions are evicted least-recently-used first so active sessions keep their account. See `docs/provider-accounts.md`
- Subscription usage and account reporting: usage windows for Cursor and Claude's Fable-only weekly limit, usage-limit resets for Claude and Codex, Mistral API and Vibe Code allowances (`mistralBudget`, per managed key), OpenRouter credit balance and model prices, month-to-date Anthropic API spend (`apiSpend`, and `apiSpendByAccount` when an `Anthropic Admin` key is paired with a project's API key), plus `GET /api/admin/provider-accounts/models` listing each account's models
- Optional encryption at rest for the provider account store: set `CARAPA_CREDENTIALS_KEY_FILE` in Box and api-relay to a 32-byte base64 key and every credential, MCP token and PKCE verifier file is sealed with AES-256-GCM (existing plain files are sealed by the relay at start; a named but missing or invalid key stops the relay)
- Cursor provider: Cursor sign-in in Provider accounts (`cursor-agent login`, about 60 days, reconnect when it expires), a relay route and the `cursor-agent` CLI integration; secret scrubbing is limited to text and JSON relay bodies so binary Cursor Connect/protobuf requests are not corrupted
- Mistral Vibe harness (`vibe`, `vibe-acp`) with a `mistral-vibe` relay route, Mistral EU models for Pi, and `mistral-eu` as a relay route; `requestsPerSecond` on a provider in `relay-clients/` paces its requests (including its 429 and 529 retries) and the relay logs what provider 429 and 529 responses say
- Remote MCP servers with OAuth: the api-relay logs in to operator-allowlisted servers (`"auth": "mcp-oauth"` in `relay-clients/`, discovery, dynamic registration, PKCE, refresh), holds the tokens and serves them to the listed projects on `/<service>`. Board manages them through `/api/admin/mcp-connections` (start, complete, list, cancel, revoke), with a paste-back flow for remote installs, and a sandbox can start and check its own project's login with `/<service>/.login` and `/.status`. Remote MCP and authorization-server hosts are reachable by the relay only (`relay_domains`). See `docs/mcp-connections.md`
- Read-only git over HTTPS through the relay: `/gitlab-git/` and `/github-git/` serve clone and fetch with the token injected and a per-client repository allowlist (`gitRepos`), so a sandbox can clone where SSH is blocked; there is no push. Hosts reachable only over a VPN or private network need a `relay_private_hosts` entry in `network-base.yaml`
- Anthropic API route `/anthropic-api/` that always uses the API key (Anthropic's Admin API stays off-limits to sandboxes), and Anthropic API accounts accept a `Workspace ID`
- `CARAPA_BROWSER_HEADED=1` runs the shared browser's Chromium headed on a virtual display (Xvfb) so a person can pass Cloudflare Turnstile checks in Board's browser tab
- `carapa-delegate`, a harness-neutral one-shot subagent command (`--tier fast|balanced|frontier`) in the carapa-bot stack, and `restart-hold` to keep the sandbox from restarting while a long job runs
- Antigravity ACP runtime with mid-turn steering and sub-agent background runs; the carapa-codex relay models gain GPT-6.2 Sol and Astra
- `bun run verify:changed` runs the typecheck and only the tests a branch can affect, and reuses an earlier pass when the tree is unchanged (`CARAPA_VERIFY_REUSE=0` forces a fresh run)
- api-relay / llama-proxy egress services: credential injection, in-flight request counting with SIGTERM drain, upstream cancellation when the client leaves, and client failure when the upstream dies mid-stream
- Managed provider accounts and relay routes for Meta Muse Code and xAI Grok Build, including subscription usage reporting and terminal `grok` / `muse` wrappers through the relay
- Egress services are started at startup when they have no running container, and recreated (only when idle) after bind-mounted code files change
- Ingress proxy for publishing project apps, with an `sandbox-ssh` status check and rejection of app-route hostnames that collide with a project's default hostname
- tmux REST API (`/api/tmux`) with exact session targets and an `error` frame when the SSE stream closes before `init`
- Git worktrees and branches: `sandbox_worktree` with validated branch names and quoted paths, `sandbox_branch` commit/merge lifecycle, project `.agent/worktree-{setup,teardown}.sh` hooks and an `after-start.sh` project hook
- Stack-declared mounts (`stack-mounts.yaml`) pinned through Docker volume subpaths; an unset `GROUP_DIR` mounts the stack's empty folder
- Mac runner: `bun run runner` updates its own checkout before starting and reports the git commit
- `/health` reports the running build (version, git commit, build time, start time), stamped at image build; managed-service deploy builds pass `GIT_COMMIT`
- Provider accounts UI and usage windows for subscription providers
- Docs check that `public/llms.txt` and the README MCP tool table match the runtime tool registry
- Codex / Claude plugin with setup resources for operators
- `NOTICE` file, `RELEASING.md` and `scripts/export-public.sh` for building the public snapshot

### Changed
- `sandbox_issues` reads GitLab issues with a GitLab account from Provider accounts instead of `config/issue-credentials.yaml` and its `tokenSecret` Docker secrets: the account the relay serves to the project's agent container (new `service` input, default `agent`), else the shared GitLab account. The `filter`/`assignee` options are removed. Move each token into Provider accounts, then delete `issue-credentials.yaml` and the secrets
- Host mode without `NGINX_PROXY_DOMAIN` now generates `carapa.box` hostnames, matching the container default. Set `NGINX_PROXY_DOMAIN` explicitly to keep a different domain
- `carapa-runner` is now `os-runner`: `src/runner` is `src/os-runner`, `bun run os-runner` starts it (`bun run runner` still works), its default root is `~/.os-runner` and its variables are `OS_RUNNER_*`. An existing `~/.carapa-runner` and the `CARAPA_RUNNER_*` variables keep working; rename the folder when convenient.
- The relay token store `relay-tokens.json` now lives directly in the state root (`<CARAPA_BOX_STATE_DIR>/relay-tokens.json`) without the extra `state/` subfolder
- The api-relay no longer needs the Board token secret: it is removed from `egress-proxy/docker-compose.yml`, `.env.example` and `before-start.sh`
- The api-relay rate limit for requests to Board is keyed on the effective target instead of the first path segment, and the per-client limit (`RATE_LIMIT_PER_CLIENT`) is keyed on the sandbox identity instead of the shared relay-client config name, so one sandbox can no longer use up another's allowance
- Antigravity CLI is no longer pinned in the harness and is exposed as `agy` (Google's own CLI, interactive, logs in on its own); `agy-sdk` and `agy-acp` wrap the SDK and ACP harness through the relay. Retired Antigravity models are remapped, and an exhausted Antigravity quota shows as fully used and ends the run with a readable failure
- Claude and Codex run costs now include sub-agent spend
- `sandbox_git pull` defaults to `--ff-only`
- `sandbox_branch merge` stops when the auto-commit before the merge fails
- `sandbox_worktree list` returns git's stderr on failure instead of "(no worktrees)"
- `sandbox_branch commit` resolves repos mounted as pinned volume subpaths and explains why a repository path could not be resolved
- Fatal startup errors are logged and exit non-zero
- Host-dev audit log is written to the gitignored `generated/audit.jsonl`, so it never dirties the checkout
- api-relay scrubber no longer redacts ordinary code assignments
- `noUnusedLocals` is enabled in both tsconfigs
- Box image includes `debianutils` so `which` exists in the carapa-bot sandbox

### Removed
- api-relay: the `/sniff/<host>/<path>` debug passthrough and the `RELAY_DEBUG_SNIFF` setting. It forwarded any request to any host through Squid as the relay's source address; `/sniff/...` is now handled like any other unknown route
- The shared `playwright-mcp` container is no longer part of sandbox networking
- `sandbox_versions` tool — version checking is handled by carapa-board directly
- Unused MCP tools `sandbox_websearch`, `sandbox_policy_reload`, `sandbox_policy_list` and `debug_processes`
- `sandbox_tmux_*` MCP tools and the per-MCP-session reader index (the REST `/api/tmux` API stays)
- Uncalled `sandbox_branch` actions (`reject`, `archive`, `cleanup`) and the `message` alias
- Unused `/etc/carapa-box` provisioner files, `PROVISION_ALLOW_PROJECTS` handling and dead helpers (`getServicePorts`, `writeEnvFile`/`stringifyEnv`)
- Root-keyed fetch/pull in `GIT_REPO` mode in `before-start.sh`

### Fixed
- Container mode reloads `nginx_app` when `NGINX_PROXY_CONTAINER` is unset, the same default as host mode and `.env.example`; `docker-compose.yml` defaulted to `nginx_proxy`
- `scripts/install-gvisor.sh` failed with a 404 after gVisor moved its releases to a single tarball. It now downloads `gvisor.tar.bz2`, verifies its SHA-512 and installs `runsc`, `containerd-shim-runsc-v1` and `gvisor-bin/` (nothing is touched on a failed check), reloads Docker instead of restarting it, prints the previous and new `runsc` version so re-running it updates gVisor, and accepts `GVISOR_RELEASE` to pin or roll back. `SECURITY.md` gained an Updating section
- Mac native runner: Board's browser tab starts a session (it failed with `ENOENT … /workspace/ipc/browser-sessions/<id>.json`). The browser scripts map container paths onto the project's native roots (a shared `browser-host.cjs`, same rules as `runtime/roots.ts`), keep their sockets and locks under the project's tmp root, and connect to the hub browser through the descriptor's `PLAYWRIGHT_MCP_CDP_ENDPOINT` instead of launching a local Chromium. Only external URLs open: previews of apps running on the Mac are not supported yet. Linux behaviour is unchanged
- Mac native runner: a runner restart no longer shows every project as stopped. Projects that were running stay running (agent home refreshed, relay capability kept, temp and shell dirs re-created) so the shell tab and relay work without pressing start; a project whose directories are gone or outside `allowedRoots` comes back stopped with a warning
- Mac native runner: Board's shell tab no longer fails with `fork failed: Operation not permitted`. The shell runs in its own per-project sandbox with pty access, so agents keep a profile without a pty (it would open every `/dev/ttys*`). The tmux socket and pane FIFOs move to a runner-owned `<root>/shell/<id>` dir that agents cannot reach, and tmux and the pane shell read only runner-owned startup files (no `~/.tmux.conf`, `.bashrc`, `.zshenv` or `.inputrc` from the agent home; tmux starts the pane shell directly instead of through `$SHELL -c`)
- `sandbox_status` with `checkUpdates` compares the running image with the container's configured image; it reported every container as up to date once its tag had moved to a rebuilt image
- vibe-acp recovers in the same run when Vibe crashes on a string `tools.process.start` argument or is left stuck by a failed turn: it starts a replacement session, answers interrupts that arrive during the restart, and retires a failed retry
- api-relay: one sandbox can no longer freeze or crash the shared relay. Request bodies are capped on every route (`RELAY_MAX_REQUEST_BODY_BYTES`, default 32 MiB, answered with 413 `request_too_large`), a long `?auth...=` string no longer stalls the secret-scrub regex, an aborted request mid-body keeps the worker alive, an SNI bridge hostname with illegal characters is refused, and provider `pathPrefix` can no longer escape through dot segments
- llama-proxy answers 413 for request bodies above `MAX_BODY_BYTES` (default 32 MiB, `0` disables), counts a transformed request's copy against the buffered-body budget `MAX_BUFFERED_BODY_BYTES` (503 `overloaded_error` when exceeded), no longer crashes on a JSON body of `null`, and falls back to the default for an invalid `LOADING_RETRY_ATTEMPTS`
- A silently dead Box-to-hub connection is detected (the box pings every 30 s and drops the connection after two silent intervals) and reconnected
- MCP OAuth logins are capped per service and project (2), per project (4) and in total (12 of 16 slots, the rest stay free for admin-started logins), so one project cannot take every login slot; a rotated token is kept when persisting it fails, and a sandbox gets a clean 401 after its token is revoked
- `build.sh` verifies the OPA binary's SHA-256 before compiling policies with it and re-downloads OPA when `OPA_VERSION` changes
- `sandbox_worktree add` no longer misreads git's exit 128 or 255 as a signal kill (an existing branch now falls back to `worktree add` without `-b`) and fails closed when the worktree listing fails instead of removing an existing directory; `sandbox_branch merge` fails closed when the base branch cannot be resolved instead of deleting an unmerged task branch
- Pinned `git` through `bun call` and `sandbox_*` keeps arguments verbatim, the force marker of `push origin +branch` and `push -u src:dst` upstream, and checks out the remote default branch in a fresh clone
- Project app publications: `status` no longer reports `ready` or a URL after the app's nginx route was evicted; a route cannot claim a hostname another project's route file already serves; sandboxes reach their own published hostnames through Squid
- Several sandbox stability fixes: SSH control routes stay alive on a busy box, `sandbox_ps` no longer reserves SSH ports and rewrites routes on every poll, `.env` values with quotes, comments and `export KEY=` lines are read and saved correctly, and Pi still launches when its `settings.json` is invalid JSON

### Security
- A sandbox can no longer get an inbound SSH route published by starting its own SSH daemon: `sandbox_ps` and other SSH status refreshes only read the operator's enable flag and never reserve an ingress port or write it; only an explicit SSH start (or managed-creation enable) publishes the route
- Squid blocks private, loopback and link-local destinations after DNS resolution, denies CONNECT to ports other than 80 and 443 (for example `github.com:22`), denies Board and Box control-plane ports on `host_services`, and does no reverse DNS for IP literals; the api-relay SNI bridge refuses hosts on `relay_domains`
- Box rejects cross-origin browser requests (a non-loopback `Origin`) to a controller running on loopback without a token
- llama-proxy refuses Ollama model-management endpoints (`/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs`) and Docker Model Runner's management calls from sandboxes with 403; Ollama's pull and push would reach any registry from the host and bypass Squid
- `sandbox_start` hook environments cannot set interpreter variables such as `BUN_OPTIONS`; `sandbox_logs` no longer follows agent-planted symlinks or FIFOs; a sandbox-forwarded request is accepted only for `<container>.agent_egress_<project>` hostnames, which closes a cross-project MCP token leak
- Base policy fails closed: a missing or unloadable `base.wasm` denies instead of allowing
- IPC / group file operations are fd-relative (`openat`/`mkdirat`), never follow swapped symlinks, use no-follow fd reads and re-verified writes; `safe-open` works on macOS
- Sandbox mount sources are pinned through Docker volume subpaths to close the symlink race
- Keyed git never takes its remote URL from agent-writable repo config, never runs repo-config programs next to SSH keys, and validates hook-supplied linked-repo path and base before a keyed push
- `sandbox_start` rejects an invalid `instance` (path traversal), and CSV metacharacters in mount-path env values
- Global `provisioner.env` secrets no longer reach agent-editable worktrees
- Admin config strips `CARAPA_HUB_BOX_SECRET` and suffix-matched secret keys
- api-relay refuses Meta request bodies with a duplicate top-level `model` key, inspects decoded JSON bodies, and refuses WebSocket upgrades and compressed bodies on managed Meta accounts
- `runHook` no longer skips hooks that lack the executable bit (fail-open on read-only stacks)
- Stale session locks and carapa-bot instance records from before a sandbox restart are rejected

## [0.1.0-alpha]

### Added
- MCP server mode with SSE transport for AI agent integration
- HTTP API mode for direct REST access (`bun run start:http` / `bun src/index.ts --http`)
- REST tool adapter: every MCP tool is also reachable via `POST /api/tools/:name`
- Admin API (`/api/admin/*`) — system info, stack listing, audit logs, `.env` read/write, policy source read
- Admin Dashboard UI served at `/admin/`
- OPA/Rego policy engine with WASM compilation for command validation
- Policy management tools: `sandbox_policy_check`, `sandbox_policy_reload`, `sandbox_policy_list`, `sandbox_network_policy_reload`
- Per-stack security policies (allowlists for commands, args, env vars)
- Shell command parsing with pipe/semicolon/operator splitting
- Docker Compose stack lifecycle management (start, stop, restart, build)
- File read/write/edit operations with mount path allowlisting
- Network isolation: per-instance bridge networks, no inter-container communication
- Lifecycle hooks (before-start, after-start, before-stop, after-stop)
- Shadow-tag rollback mechanism for safe deployments
- Health check polling with configurable timeouts
- Pre-start CVE scanning (advisory mode)
- Bearer token authentication (standard `CARAPA_BOX_API_TOKEN` + admin `CARAPA_BOX_ADMIN_TOKEN` tiers)
- Hardened container: non-root (UID 65532), read-only rootfs, seccomp, AppArmor
- Hot-reloadable YAML network policies
- Managed services with environment variable resolution
- `sandbox_branch` tool — atomic git branch lifecycle (`prepare_review`, `merge`, `archive`/`cleanup`, `reject`) enabled by `ENABLE_SANDBOX_GIT=true`
- Pino structured JSON logging throughout

### Security
- Seccomp and AppArmor profiles for container hardening
- Path traversal validation for stack names
- Mount path allowlisting with mtime-based cache invalidation
- Environment variable filtering per policy

### Known Issues
- Claude Code missing `Accept: text/event-stream` header on GET requests (upstream: anthropics/claude-code#34498)
