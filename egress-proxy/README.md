# Egress Proxy Stack

The egress proxy is a shared infrastructure stack that provides secure internet access and API credential injection for all agent sandboxes.

## Services

Internal service WebSockets are disabled by default. A service may explicitly
enable path prefixes with `"websocketPaths": ["/api/web-browser/sessions/"]`.
Board uses that route for per-run browser CDP connections. The relay applies the
same client selection and service credential injection as HTTP, preserves the
separate `X-Carapa-Browser-Token` capability header, and connects directly to the
configured service without Squid. Query strings and encoded paths are rejected
on these routes; callers cannot supply an upstream host. Provider WebSockets
continue using their existing Squid transport.

| Service | Purpose | Port |
|---------|---------|------|
| `squid` | Forward proxy with domain allowlist | 3128 |
| `api-relay` | API credential injection (Anthropic, OpenAI, etc.) | 8080 |
| `llama-proxy` | HTTP forwarder for local LLM with cache-stability transforms | 8881, 11434 |

## Architecture

Agent containers run on an internal `agent_egress` network and services (mail, wa-link) on `egress_proxy` — both with `internal: true`. Neither has direct internet access. Outbound traffic must go through Squid or the API relay, which bridge both networks.

### Network topology and sandbox-to-host paths

```
┌─────────────────────────────────────────────────────────────┐
│  agent_egress (internal: true)                              │
│                                                             │
│  carapa-bot ──→ api-relay:8080/{board-api,mcp-relay}/...    │
│       │──────→ llama-proxy:{3001,8881,11434,12434}          │
│       │──────→ squid:3128 ──→ host.docker.internal:<port>   │
│       ✗                                                     │
│  no direct route/DNS for host.docker.internal               │
└──────────────────────┬──────────────────────────────────────┘
                       │  (api-relay, llama-proxy and squid are on
                       ↓   the hostaccess network)
              ┌─────────────────┐
              │  host           │  Board :3000, carapa-box :3100,
              │                 │  local LLMs, dev servers
              └─────────────────┘
```

A sandbox container is on `agent_egress` only — no `extra_hosts` and no `hostaccess` network — so it cannot resolve `host.docker.internal` or route to the host itself. Three proxy containers are also on the `hostaccess` network and can, and each gives sandboxes a different reach:

| Path | Defined in | What a sandbox can reach |
|------|------------|--------------------------|
| **api-relay routes** | `relay-clients/*.json` `services` entries; api-relay has `hostaccess` and `extra_hosts: host.docker.internal:host-gateway` (`docker-compose.yml`) | Only the hosts and ports of the services configured for that client. The shipped `relay-clients/carapa-bot.json` routes `/mcp-relay` and `/board-api` to Board (`CARAPA_BOARD_HOST:CARAPA_BOARD_PORT`, default `host.docker.internal:3000`) with the API key injected by the relay. |
| **llama-proxy ports** | `llama-proxy` service in `docker-compose.yml`: `hostaccess`, `extra_hosts: host.docker.internal:host-gateway`, `PORTS: "3001,8881,11434,12434"` | Those four ports on the host, for any sandbox on `agent_egress`: local LLM servers (llama.cpp, Ollama) and the FreeLLMAPI endpoint on 3001, which gets its credential injected. |
| **squid `host_services`** | `generateSquidConf` in `src/network-policy.ts` (default `squid.conf`) | Plain HTTP and `CONNECT` from any sandbox to `host.docker.internal` on `host_ports` (default `3000-9999` and `11434`) **minus** `host_deny_ports` (default `3000` and `3100`), which squid denies first. The range is wide on purpose: one stack is reused across projects, each with its own dev-server ports. |

api-relay is therefore **not** the only path to the host. It is the only path to Board (3000) and carapa-box (3100) by default, because squid denies those two ports and llama-proxy does not forward them.

> **Admin note — Board or carapa-box on non-default host ports.** `host_deny_ports` is not auto-detected. The root `docker-compose.yml` publishes carapa-box as `${MCP_SANDBOX_PORT:-3100}` on the host, and `CARAPA_BOARD_URL` is only set in the egress-proxy env and is often empty. If Board or carapa-box listen on other host ports, set `host_deny_ports` in `config/policies/network-base.yaml` to those ports (keep the defaults you still use). Otherwise they fall inside the `host_ports` range and sandboxes can reach them directly through squid, bypassing api-relay auth injection and audit logging. See [Network Policies](../docs/security-policies.md#network-policies-yaml).

carapa-box is not routed to sandboxes at all in the shipped relay-client configs. A `sandbox-relay` service entry (`bot → api-relay:8080/sandbox-relay/... → host.docker.internal:3100`) belongs only in a separate, operator-only relay-client config — see the security note under [Relay clients](#relay-clients) and never add it to an agent config.

api-relay also runs an SNI bridge on :443 for CLIs that ignore `https_proxy` (`SNI_BRIDGE_PORT`, `0` disables). It tunnels only hosts matching `SNI_ALLOWED_SUFFIXES` (default Google API hosts) through squid, and refuses any host listed under `relay_domains`, read from the mounted `generated/squid-generated.conf` (`RELAY_SQUID_CONF`); if that file is unreadable it refuses every SNI tunnel.

### Switching carapa-box between container and host mode

Both modes use the same `host.docker.internal:3100` path — no relay-clients changes needed.

| Mode | How to run | relay-clients change |
|------|-----------|---------------------|
| **Container** | Set `SANDBOX_HOST_DIR` in root `.env`, then `docker compose up -d` from project root | None |
| **Host debug** | `docker compose down` from project root, then `bun run start:http` | None |

## Setup

1. Copy `.env.example` to `.env`.
2. Configure your API keys or OAuth credential paths.
3. Start the stack (usually auto-started by the host):
   ```bash
   cd egress-proxy
   docker compose -f docker-compose.yml -p egress-proxy up -d
   ```

   The Compose **project name is `egress-proxy`** (containers are named
   `egress-proxy-api-relay-1`, etc.). Running `docker compose` from the
   carapa-box root or without `-p egress-proxy` will not find these services.

   The relay code directory `api-relay/` is bind-mounted; after an edit,
   `docker compose … kill -s SIGHUP api-relay` loads it in place (see below).
   `llama-proxy.mjs` is bind-mounted too — edit and
   `docker compose … restart llama-proxy`; rebuild an image only when its
   Dockerfile or Node runtime deps change.

## Llama Proxy

`llama-proxy` is an HTTP forwarder between agent sandboxes and the host's local LLM (llama.cpp / Ollama). Unlike the socat-based forwarder it replaces, it parses request bodies and applies cache-stability + profile transforms before forwarding.

Supported request shapes:
- Anthropic `/v1/messages` — tools `{name, description, input_schema}` (Claude Code, Claude Agent SDK)
- OpenAI `/v1/chat/completions` — tools `{type:"function", function:{name, ...}}` (opencode, ai-sdk clients)
- OpenAI `/v1/responses` — Responses API payloads (`instructions`, `input`) (llama.cpp Responses adapter)

Blocked endpoints (every listen port): `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs` and `/api/blobs/*` get a `403` with a plain-text body before the request body is read, and never reach the upstream. Ollama's pull/push connect from the host to any registry named in the model, which would bypass squid. Matching ignores the query string, case and a trailing slash, and applies percent-decoding, `.`/`..` resolution and `//` collapsing first. All other paths are forwarded unchanged.

Local llama.cpp servers reuse prefix KV-cache across requests — but only if the prefix bytes are identical. Two things would otherwise defeat this for Claude Code / Claude Agent SDK clients: a per-call `cch=` hash inside a system block, and a bulky `tools[]` array that the agent only partially needs. Both are stripped here.

### Transforms

| Transform | Trigger | Effect |
|---|---|---|
| `hoist-openai-system-messages` | Multiple or late `system` entries in `/v1/chat/completions` `body.messages[]` | Combines system content into one leading `system` message. Developer entries pass through unchanged for templates that support late developer guidance. |
| `hoist-openai-responses-system-messages` | Multiple or late `system` items in `/v1/responses` `body.input[]` | Combines system content into `body.instructions` and removes those items from `input[]` before llama.cpp’s Responses-to-Chat-Completions conversion. Developer items pass through unchanged. |
| `strip-billing-header` | `body.system[]` block whose text starts with `x-anthropic-billing-header` | Drops that block. The block carries a per-call `cch=` hash that would otherwise change the cached prefix on every request. |
| `strip-tools-by-profile` | `body.model` matches a key in `tool_profiles.jsonc` | Filters `body.tools[]` to the profile's allow-list (trailing-`*` entries match by prefix). If the profile declares a `model`, also rewrites `body.model` to that upstream id so Ollama can serve it. |
| `reject-cloud-model` | `body.model` starts with `claude-` after the profile pass | Short-circuits with a 404 (`not_found_error`). Used to silence Claude Code's hardcoded haiku background calls (title gen, context summarization) without an Ollama round trip. |

A cheap `Buffer.indexOf` pre-check skips JSON parsing entirely on traffic that triggers neither transform (plain Ollama / OpenAI-chat passthrough).

Body limits (the proxy container has 128M and the transform holds ~5 copies of a body):

| Env | Default | Effect |
|---|---|---|
| `MAX_BODY_BYTES` | `33554432` (32 MiB) | Larger request bodies get `413` (`connection: close`) and never reach the upstream. `0` disables the cap (rollback). |
| `MAX_BUFFERED_BODY_BYTES` | `50331648` (48 MiB) | Global budget of request-body bytes buffered across all in-flight requests. A request whose `Content-Length`, or streamed size so far, exceeds the remaining budget gets `503` (`overloaded_error`, `connection: close`) and is never forwarded; a declared `Content-Length` over `MAX_BODY_BYTES` gets `413` instead, even when it also exceeds the budget (a chunked stream can exhaust the budget and get `503` before it crosses `MAX_BODY_BYTES`). A transformed request also counts its re-serialized copy against the budget (`503` if the received body plus the copy no longer fit). A request holds its bytes until its response closes (finished, errored or aborted). `0` disables the budget (rollback). |
| `TRANSFORM_MAX_BYTES` | `8388608` (8 MiB) | Bodies above this are forwarded byte-identical, skipping the pre-check and JSON parse. `0` disables the skip. |

Bodies that are not a JSON object (`null`, arrays, primitives) and bodies whose transform throws are forwarded unchanged; the upstream answers with its own error.

### Tool Profiles

A profile is a named tool allow-list. The profile is referenced by setting `body.model` to the profile name — every Anthropic-format request already carries `model` at the head, so no extra plumbing is needed. Profiles are **local-LLM-only by design**: setting `model: "research"` against the real Anthropic API would be rejected upstream.

Schema in `tool_profiles.jsonc` (JSONC: `//` and `/* */` comments and trailing commas allowed):

```jsonc
{
  "research": {
    // Optional: real upstream model id. llama.cpp ignores it; Ollama requires it.
    "model": "gemma4:e2b",
    "allow": [
      "Read", "Grep", "Glob", "WebFetch", "WebSearch", "AskUserQuestion", "TodoWrite",
      "mcp__carapa-board__*"   // trailing-* = prefix match (keeps all carapa-board MCP tools)
    ]
  }
}
```

The file is bind-mounted read-only into the container at `/app/tool_profiles.jsonc`. The path is overridable via the `TOOL_PROFILES_PATH` env var. Missing or invalid file → transform stays off; the proxy still runs.

The file is auto-reloaded on change (debounced 150 ms; the proxy re-attaches the watcher after editor atomic-rename saves). You can still force a reload with `SIGHUP`:

```bash
docker compose -f docker-compose.yml -p egress-proxy kill --signal=HUP llama-proxy
```

Startup logs the loaded profile names:

```
tool_profiles: loaded 1 profile(s) (research)
```

### Wiring a profile end-to-end

The proxy alone does not pick the profile — something upstream has to set `body.model` to the profile name. In carapa-board, that's done by adding an entry to `board_agents.jsonc` with `model: "<profile>"` and pointing `ANTHROPIC_BASE_URL` at this proxy. A stage's `workerAgent` then selects that entry. See `carapa-board/docs/SPEC.md` §Configuration for the board side.

Optionally pair with the CLI's own subagent mechanism (Claude Code's `--agent <name>` loads `.claude/agents/<name>.md` for role shaping) — the two layers are independent and compose.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORTS` | `8880,11434` | Comma-separated listen ports; each forwards to the upstream on the same port. |
| `UPSTREAM_HOST` | `host.docker.internal` | Where to forward. |
| `TOOL_PROFILES_PATH` | `/app/tool_profiles.jsonc` | Profile config file (JSON or JSONC). |
| `LOG_REQUESTS` | off | One log line per request, including applied transforms. |
| `LLAMA_DEBUG` | off | Dump every request to `CAPTURE_DIR` for inspection. Implies `LOG_REQUESTS`. |
| `CAPTURE_DIR` | `/app/captures` | Where dumps go (apparmor allow-lists `/app/**` for writes). |
| `LOADING_RETRY_ATTEMPTS` | `10` | Retries on upstream **503** (fixed 5s between attempts). A non-integer or negative value falls back to `10`. |
| `LOADING_RETRY_DELAY_MS` | `5000` | Wait between retries; `Retry-After` wins if larger. |

### Verifying transforms

Set `LLAMA_DEBUG=1`, run a request, then inspect `captures/`:

- `*.body.in` — original request body (only written when transforms changed it)
- `*.body` — body after transforms
- `*.json` — metadata: `transform.applied[]`, `tools_in[]` (original tool names before strip), response status, timings

In capture mode every body is JSON-parsed (even those that trigger no transform) so `tools_in` lands in the metadata for every request, including plain opencode/Ollama passthrough.

Example after a `research`-profiled Claude Code request:

```json
"tools_in": ["Bash", "Read", "Edit", "Write", "...", "mcp__carapa-board__send_message"],
"transform": {
  "applied": [
    "strip-billing-header(-1)",
    "strip-tools(profile=research,kept=8/35) rewrite-model(profile=research→gemma4:e2b)"
  ],
  "changed": true
}
```

Body shrank 104 KB → 41 KB (27 tool schemas removed). On the second call with the same prefix, llama.cpp's checkpoint logic restored 9526 of 9566 tokens from cache, leaving only 36 to prefill (≈99.6 % hit).

## Graceful Drain and `/_inflight`

`api-relay` and `llama-proxy` count in-flight work: HTTP requests (until the response closes), upgraded WebSocket connections and SNI-bridged TCP connections (api-relay) until the socket closes.

- `GET /_inflight` returns `{"inflight":N,"draining":bool}`; api-relay adds `"codeHash"`, the sha256 of the code its serving worker loaded. Loopback clients only (others get 403); the request itself is not counted. It is served on api-relay's main listener and llama-proxy's first port in `PORTS`, before routing and auth, in every mode.
- On `SIGTERM`/`SIGINT` the service logs `[drain] start inflight=N`, stops accepting new connections, closes idle keep-alive sockets, waits for in-flight work to finish, logs `[drain] done` and exits 0. With nothing in flight it exits at once (api-relay first waits up to 5 s for connections it already accepted to send their request). A second signal is ignored.
- `RELAY_DRAIN_TIMEOUT_MS` (default `900000`, 15 min) caps the wait; on expiry the remaining count is logged and the process exits 0.
- `stop_grace_period: 16m` in `docker-compose.yml` keeps Docker from SIGKILLing before the cap.

## In-Place Relay Reload

api-relay's main process is a supervisor that runs the relay in one cluster worker. `SIGHUP` starts a new worker, which loads the current `api-relay/` code from disk. When all its listeners are up it takes the new connections, and the old worker drains its open requests as above. No connection is refused or reset, including one accepted just before the drain that has not sent its request yet; the old worker closes only idle keep-alive sockets that already carried a request, and it does not exit until such waiting connections have sent their request and got the response (at most 5 s). If the new worker fails to start, the old one keeps serving and the supervisor logs `new worker failed to start`. `SIGTERM` drains every worker, then the supervisor exits.

At startup CarapaBox compares the hash of `egress-proxy/api-relay/` with the relay's `codeHash` and sends `SIGHUP` when they differ. The whole directory is mounted rather than single files: a file bind mount keeps the inode it was created with, so a file that git replaced would otherwise stay stale in the container.

A change to a service's compose definition (volumes, env, ports, image) is applied by recreating that service, instead of reloading, on the next box restart; the box hashes the service from `docker compose config --format json` and compares it with the container's `carapa.egress.definition-hash` label (a container without the label is only logged, never recreated for this reason). A private deployment copy of `docker-compose.yml` (`docs/installation-data.md`) must be updated by hand first, because the box hashes the file it actually runs.

## File-Based Secrets

API keys and service tokens can be stored as files instead of environment variables. This is the recommended approach — secrets mounted via Docker Compose `secrets:` live on a tmpfs and are invisible in `docker inspect` and `/proc/*/environ`.

### How it works

1. Write each secret to `secrets/<name>` (lowercase, underscored):
   ```bash
   echo "sk-ant-..." > secrets/anthropic_api_key
   echo "sk-..."     > secrets/openai_api_key
   ```
2. Docker Compose mounts the files at `/run/secrets/<name>` inside the api-relay container.
3. The relay's `readSecret()` function checks the file first, then falls back to the env var.

Empty files are treated as "not set" — the relay falls through to the environment variable. This means you can migrate one key at a time.

### Available secrets

| Secret file | Env var fallback | Used by |
|-------------|-----------------|---------|
| `anthropic_api_key` | `ANTHROPIC_API_KEY` | Anthropic provider |
| `openai_api_key` | `OPENAI_API_KEY` | OpenAI provider |
| `google_api_key` | `GOOGLE_API_KEY` | Google provider |
| `gitlab_pat` | `GITLAB_PAT` | GitLab (default client) |
| `carapa_box_api_token` | `CARAPA_BOX_API_TOKEN` | Sandbox service token |
| `carapa_wa_link_token` | `CARAPA_WA_LINK_TOKEN` | WhatsApp link token |
| `carapa_mail_token` | `CARAPA_MAIL_TOKEN` | Mail service token |

### Migration

No breaking changes — env vars still work. To migrate:

1. Write the secret value to `secrets/<name>`
2. Remove the corresponding line from `.env`
3. Restart: `docker compose up -d`

The `secrets/` directory is defined in .env as `SECRETS_DIR`

## Secret Scrubbing

The API relay automatically scrubs known secret patterns from outbound request bodies before they reach upstream LLM providers. This prevents credential exfiltration via prompt injection — if an agent is tricked into including a secret in its API call, the relay redacts it before it leaves the network.

### How it works

Every text or JSON request body with identity encoding is scanned against a list of regex patterns; other bodies (binary such as Connect/protobuf, compressed, or not valid UTF-8) pass through unchanged, because rewriting them would corrupt their framing. Any match is replaced with `[REDACTED]` and the event is logged:

```
[scrub] client-1 -> anthropic: redacted 2 secret(s)
```

### Detected patterns

| Pattern | Example |
|---------|---------|
| OpenAI / Stripe secret keys | `sk-abc123...` |
| Anthropic API keys | `sk-ant-abc123...` |
| Stripe publishable keys | `pk-abc123...` |
| AWS access keys | `AKIA...` |
| GitHub PATs | `ghp_...` |
| GitLab PATs | `glpat-...` |
| npm tokens | `npm_...` |
| Slack bot tokens | `xoxb-...` |
| Database connection strings | `postgres://user:pass@host/db` |
| Environment variable assignments | `API_KEY=value`, `SECRET=value`, etc. |

### Configuration

Scrubbing is **enabled by default**. To disable it (not recommended), set in your `.env`:

```
SCRUB_SECRETS=0
```

### Limitations

- Only scans request bodies, not headers or query parameters (headers are already stripped and replaced by the relay's own auth injection).
- Regex-based — novel or obfuscated secret formats may not be caught.
- Adds negligible overhead per request (single-pass string replacement).

## Rate Limiting

The API relay enforces sliding-window rate limits on all forwarded requests (providers and internal services). This prevents runaway agents from flooding upstream APIs and slows potential data exfiltration.

Two levels are enforced per request:

| Scope | Default | Purpose |
|-------|---------|---------|
| Per-sandbox per-provider | 100 req/min | Prevents a single sandbox from monopolizing a provider. Keyed on the sandbox identity (client hostname), so sandboxes matching one relay-client config each get their own bucket |
| Global per-provider | 300 req/min | Protects upstream API rate limits across all agents |

When a limit is hit, the relay returns `429 Too Many Requests` with a JSON body and `Retry-After` header:

```json
{ "error": "Too Many Requests", "scope": "per-client", "provider": "anthropic", "retryAfter": 12 }
```

Blocked requests are logged:

```
[rate-limit] BLOCKED my-bot -> anthropic (per-client: 100/60s, retry in 12s)
```

### Configuration

Set in `egress-proxy/.env` (all optional — defaults apply if unset):

```bash
RATE_LIMIT_PER_CLIENT=100   # max requests per sandbox per provider per window
RATE_LIMIT_GLOBAL=300       # max requests per provider per window (all clients)
RATE_LIMIT_WINDOW_S=60      # sliding window size in seconds
```

Body limit (the api-relay container has 512M, and a buffered body is held about three times):

| Env | Default | Effect |
|---|---|---|
| `RELAY_MAX_REQUEST_BODY_BYTES` | `33554432` (32 MiB) | Cap for every request body the relay buffers: provider, internal-service, MCP OAuth and antigravity routes. A `Content-Length` above the cap is rejected before any body is read; a chunked body that crosses it while streaming is dropped. Either way the client gets `413` (JSON `request_too_large`, `connection: close`) and nothing reaches the upstream. A value that is not a positive integer uses the default. |

## Relay Clients

Per-client configuration files in `relay-clients/` control which providers and internal services each bot can access. The relay identifies clients by reverse-DNS of their Docker container hostname.

| File | Matches | Purpose |
|------|---------|---------|
| `default.json` | All clients (fallback) | OAuth credentials for Anthropic, Codex |
| `carapa-bot.json` | `carapa-bot-main-agent-1*` | Internal services: mcp-relay |
| `carapa-board.json` | `carapa-board-carapaboard-agent-1*` | Internal services: mcp-relay, carapa-wa-link, carapa-mail |

> **Security: no `sandbox-relay` in agent configs.** Agent containers should **not** have a `sandbox-relay` service entry in their relay-client config. Giving agents a route to CarapaBox means a compromised agent could exploit a vulnerability in the MCP/REST layer to reach the Docker socket. CarapaBoard manages sandbox lifecycle on behalf of agents — agents never need to call CarapaBox directly. Only operator-controlled containers (IDEs, dev tools) should have `sandbox-relay` access, via a separate relay-client config with a distinct hostname pattern.

### Internal services

Internal services are defined under the `services` key in client configs. Unlike external providers (routed through Squid), internal services use plain HTTP directly between containers.

```json
{
    "services": {
        "mcp-relay": {
            "host": "host.docker.internal",
            "port": 3000,
            "auth": "apikey"
        }
    }
}
```

The bot accesses the service via `http://api-relay:8080/mcp-relay/...`. The relay resolves the service config, injects the per-project agent token CarapaBoard registered for that container in CarapaBox's relay-token store, and forwards the request. CarapaBoard services have no shared fallback token: a container without a registered token gets no CarapaBoard access. Other services may name an `envKey` secret instead.

### Read-only git over HTTPS (`/gitlab-git/`, `/github-git/`)

Squid only allows CONNECT to port 443, so a sandbox cannot reach GitLab over SSH. The relay serves **read-only** smart-HTTP git (clone and fetch) for the `gitlab` provider at `/gitlab-git/<repo-path>.git/...`. It uses the same upstream host and token as `/gitlab/`; the token never enters the sandbox. There is no push.

The route is off unless the client's `gitlab` provider lists `gitRepos` (`default.json` has none). `*` matches exactly one path segment; every other segment must match exactly:

```json
{ "providers": { "gitlab": { "auth": "apikey", "envKey": "GITLAB_PAT", "envHost": "GITLAB_HOST_URL", "gitRepos": ["group/*", "group2/repo"] } } }
```

Only `GET <repo>.git/info/refs?service=git-upload-pack` and `POST <repo>.git/git-upload-pack` are forwarded. Everything else (`git-receive-pack`, LFS, other paths or methods, repos outside `gitRepos`, clients without `gitRepos`) gets 403. The relay drops the client's `Authorization`, `PRIVATE-TOKEN` and `Cookie` headers and sends `Authorization: Basic base64("oauth2:<token>")`. Request and response bodies are streamed. The token needs the `read_repository` scope.

In the sandbox, point git at the relay (Composer VCS repositories shell out to git, so they follow it):

```bash
git config --global url."http://api-relay:8080/gitlab-git/".insteadOf "ssh://git@<host>:<port>/"
```

`/github-git/<owner>/<repo>.git/...` works the same way for the `github` provider, with its own `gitRepos` list on the `github` route. The relay sends the clone to the account's server (`github.com`, or the Enterprise server; not the API host) with `Authorization: Basic base64("x-access-token:<token>")`. The token needs read access to Contents.

```json
{ "providers": { "github": { "auth": "apikey", "gitRepos": ["org/*"] } } }
```

```bash
git config --global url."http://api-relay:8080/github-git/".insteadOf "git@github.com:"
git config --global url."http://api-relay:8080/github-git/".insteadOf "https://github.com/"
```

A managed GitHub account (Provider accounts) supplies the token and hosts; a relay client that declares its own `github` route like this also needs a client-scoped GitHub account, since the relay never gives a client with its own route the shared key.

### Project integrations

An application in a sandbox that must call another service with a token (for example, create GitLab issues) uses a **project integration**: a token saved for one sandbox instance in CarapaBoard under Project settings → Integrations. Box stores it with the other Provider accounts (`scope: "project"`), together with the instance's container names, which it reads from the running instance, and the API calls the token may serve:

```json
{ "scope": "project", "provider": "custom", "route": "crm", "host": "api.crm.example", "pathPrefix": "/v2",
  "auth": { "type": "header", "name": "x-api-key" }, "project": { "stack": "demo-site", "instance": "demo-app" },
  "containers": ["demo-site-demo-app-nginx-1", "demo-site-demo-app-php84-1"], "allow": [{ "method": "POST", "path": "/contacts" }] }
```

The application calls `http://api-relay:8080/<route>/...`. The relay uses the token only when the request comes from one of those containers (the name before the first dot of its hostname) **and** its method and path, without the query, match a rule exactly; `*` stands for one path segment (never an empty one). A rule may end in `/` (`/contacts/`, or `/` alone), which matches only a request path with that trailing slash; `/contacts` and `/contacts/` are different rules. No other empty segment (`//`) is allowed. Rule paths are relative to the route, and the relay adds the base path (`/crm/contacts` → `https://api.crm.example/v2/contacts`). Requests forwarded from another box never use an integration. A client with `isolation: "strict"` reaches an integration-only route (one the client does not define) through its own grant: the strict route check does not refuse it, the grant's rules decide which calls pass, and any other call gets 403. A strict client still has no access to a route it has neither configured nor been granted. A grant does not restrict routes the client already has configured: on `/gitlab/` or `/github/`, a call no rule allows keeps the client's ordinary key.

`auth` says how the token is sent: `bearer` (`Authorization: Bearer`), `header` with a lowercase `name`, `basic` with a `username`, or `query` with a parameter `name`. The relay drops whatever the application sent in that place. A query token is added after the request is logged. Because an upstream may redirect and keep the query (a trailing-slash redirect, for example), the relay replaces the token, raw or percent-encoded, with `[REDACTED]` in the `Location`, `Content-Location`, `Link` and `Refresh` response headers; the status code and other headers are unchanged. Response bodies are not rewritten, so an API that echoes the request URL in its body can still expose a query token to the application. Prefer `header`, `bearer` or `basic` auth where the API supports it.

- **GitLab and GitHub** are presets on the existing `/gitlab/` and `/github/` routes (`PRIVATE-TOKEN`; `Authorization: Bearer` to the API host). A call no rule allows keeps the client's ordinary key, and Box checks the token and reads its expiry when it is saved. Use a GitLab project access token (Reporter, `api` scope) or a fine-grained GitHub token limited to the repository. Integrations are never used for `/gitlab-git/` or `/github-git/`.
- **Custom** integrations take a route name of their own (not a built-in route or one a relay client defines) and an HTTPS base URL on port 443. A call no rule allows is refused with 403. Box cannot check such a token when it is saved.

Box adds each integration's host to squid as an allow rule for the relay's source only (`relay_integration`), unless a base or relay domain already covers it. Unlike `relay_domains`, this denies nobody else; private addresses stay blocked.

A GitLab on a private network (e.g. only reachable over a VPN) needs a `relay_private_hosts` entry (`host` and exact `dst`) in `network-base.yaml`; otherwise squid denies the relay's upstream CONNECT. See `docs/security-policies.md`.

### Adding a relay-client for a new stack

When a new agent stack needs access to internal services (MCP, sandbox, etc.) or custom provider credentials, you must create a relay-client config:

1. Create `relay-clients/<stack-name>.json` with a `match` array containing the container hostname pattern(s)
2. Add `services` and/or `providers` entries as needed
3. Config files are **hot-reloaded** (~500ms) — no restart needed

The `match` patterns are matched against the reverse-DNS hostname of the Docker container. Use `docker inspect <container> --format '{{.Config.Hostname}}'` to find the exact hostname. Without a matching relay-client, the container falls back to `default.json` which only has external provider credentials — internal services like `mcp-relay` and `sandbox-relay` will return "Unknown provider or service".

## More Information

- See [API Relay Setup](../docs/api-relay-setup.md) for detailed provider configuration.
- Domain allowlists are managed via YAML policy files: `config/policies/network-base.yaml` (shared) and per-stack `stacks/{name}/network-policy.yaml`. Changes are hot-reloaded (~2s) — no restart needed. The generated config is written to `generated/squid-generated.conf`.
