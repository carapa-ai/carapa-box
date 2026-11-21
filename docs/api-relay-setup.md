# API Relay Setup

The api-relay is an HTTP and WebSocket proxy that keeps API credentials out of
agent containers. Agents send requests to
`http://api-relay:8080/<provider>/...` (or the corresponding `ws://` URL)
over the agent's per-instance internal network (`agent_egress_{project}`). The relay strips any incoming auth
headers, injects the real credential, and forwards the request upstream
through Squid.

## Shared OAuth lifecycle and optional client isolation

Claude and Codex use one OAuth manager inside `api-relay.mjs`. There is no
separate auth service or `provider-auth.mjs` deployment dependency. Importing the
module is side-effect-free; the executable entry point starts the relay.

The manager enumerates OAuth credential files from global environment settings,
`relay-clients/default.json`, and every named client/provider/service configuration.
It does not scan `AGENT_HOME` or arbitrary credential directories. Canonical paths
deduplicate shared files and symlink aliases; conflicting provider formats are
rejected. The scheduler runs at startup and every minute, with up to four
concurrent checks. Claude renews within 30 minutes of expiry; Codex within five.
Request-time checks cover tokens already due at the time of an HTTP request or
WebSocket handshake. HTTP/SSE and WebSocket handshakes share one bounded refresh
and retry after a 401, including HTTP 401s reached after throttle backoff.

Refresh calls have a 20-second deadline and per-credential exponential failure
backoff (5 seconds up to 5 minutes). Access tokens that remain valid can still be
used during transient refresh failures. Rotated credentials are written using a
private, fsynced temporary file and atomic rename, preserving unrelated metadata.
Mount credential **directories** read-write; a single-file bind mount is not
compatible with atomic replacement. Locks coalesce refreshes inside one relay
process, and rereads detect a competing writer's newer tokens. This is not a
distributed lock: use one refresh-owning relay per credential file and avoid
simultaneous host CLI refreshes of the same file.

### Shared mode (default)

Existing default credentials and wildcard client mappings continue to work.
Multiple agents can share one OAuth file and therefore one refresh lifecycle.
This does not require credentials to be inside their shared `AGENT_HOME`.

### Strict client mode (opt-in)

1. Set `RELAY_REQUIRE_KNOWN_CLIENTS=1` in the relay's `.env`. This setting stays
   enabled even if a private client configuration is deleted. Every client using
   that relay must then have an **exact** container-name mapping, including
   shared-account clients; wildcard-only mappings no longer authorize callers.
   Identity comes from Docker reverse DNS, not a client-supplied HTTP header.
   Both full DNS names and exact container names before the first dot are accepted.
2. Optionally set `OAUTH_CLIENT_CREDENTIALS_DIR` to a host directory **outside all
   sandbox home/workspace mounts**, and uncomment its volume line in
   `egress-proxy/docker-compose.yml`, which mounts it read-write only into the
   relay at `/app/credentials/clients`. Recreate the relay to add this mount.
3. Add a named client configuration, for example:

```json
{
  "match": ["carapa-bot-private-agent-1"],
  "isolation": "strict",
  "providers": {
    "codex": {
      "auth": "oauth",
      "credentialFile": "/app/credentials/clients/private/codex/auth.json"
    },
    "anthropic": {
      "auth": "oauth",
      "credentialFile": "/app/credentials/clients/private/claude/.credentials.json"
    }
  },
  "services": {
    "mcp-relay": {
      "host": "host.docker.internal",
      "port": 3000,
      "auth": "apikey"
    }
  }
}
```

Strict clients inherit neither default provider credentials nor default service
routes. Missing credentials fail; they never fall back to a shared account.
Unrecognized or ambiguous identities and unconfigured routes return 403. Debug
implicit MCP route fallbacks are unavailable in strict mode. An
isolated OAuth file cannot also be configured for another client or a default.
Explicitly configured API keys remain administrator-controlled; selecting the
same key in multiple profiles still shares that upstream account.

Configuration changes are watched and polled. An invalid reload disables
credential routing until corrected instead of silently dropping an isolated
profile; invalid startup configuration prevents startup. Deleting a private
profile leaves its now-unregistered client denied by the independent allowlist
setting. Credential files must also remain inaccessible to sandbox containers.

For full filesystem/history isolation, use separate `AGENT_HOME`, session/state,
and workspace mounts as well (a shared `AGENT_HOME` lets any project that uses it
change files the others run; see
[Isolation between projects](mount-allowlist.md#isolation-between-projects)). Separate files containing copies of one rotating
OAuth session are not independent credentials; use separately authenticated
sessions/accounts. This change provides relay credential separation, not an
automatic migration of sandbox homes or account setup.

Antigravity ACP OAuth now uses the same lifecycle through `/antigravity`, with
native login/onboarding in a separate Box-managed worker and Gemini/CCPA
translation in the relay. The `/google` API-key route is unchanged. See
[Board-managed provider accounts](provider-accounts.md) for setup and login.

## Architecture

```
Agent container              agent_egress_{project} network                Internet
┌───────────────┐    HTTP   ┌─────────────┐   CONNECT/TLS  ┌────────┐
│  claude/codex │──────────→│  api-relay  │───────────────→│  Squid │──→ upstream API
│  (no creds)   │           │  :8080      │                │  :3128 │
└───────────────┘           └─────────────┘                └────────┘
```

Agents never see raw API keys or OAuth tokens.

WebSocket upgrades use the same provider routing, per-client configuration,
credential injection, rate limits, and Squid CONNECT allowlist as HTTP
requests. For example, the Codex Responses socket is exposed inside an agent
container as `ws://api-relay:8080/codex/responses` and forwarded to
`wss://chatgpt.com/backend-api/codex/responses`.

## Request body limit

The relay buffers each provider, internal-service, MCP OAuth and antigravity
request body so it can scrub secrets, log and retry. `RELAY_MAX_REQUEST_BODY_BYTES`
(in the relay's `.env`) caps that body; the default is `33554432` (32 MiB). A
request whose `Content-Length` exceeds the cap is rejected before any body is
read, and a chunked body that crosses the cap while streaming is dropped. Both
get `413` with a JSON `request_too_large` error and `connection: close`, and
nothing is forwarded. A value that is not a positive integer uses the default.

## Squid domain allowlist

The relay forwards upstream over HTTPS via Squid (`:3128`). Squid only allows
CONNECT tunnels to approved domains — add a new upstream host here before
wiring a new api-relay provider.

**Do not edit `egress-proxy/squid.conf` for day-to-day changes.** CarapaBox
generates the live config from YAML policy files:

| File | Purpose |
|------|---------|
| `config/policies/network-base.yaml` | Domains allowed for **all** stacks (AI providers, package managers, etc.) |
| `stacks/{name}/network-policy.yaml` | Extra domains for one stack only (source-restricted ACLs) |

CarapaBox watches these files and writes `generated/squid-generated.conf`,
then applies it with `squid -k reconfigure` (~2s debounce; skipped if unchanged).
The squid container bind-mounts that file and prefers it over
`egress-proxy/squid.conf` (mounted as `squid.conf.tpl`), which is only used
when the generated file is missing or empty (e.g. first boot before CarapaBox
has run).

To allow a new upstream API (example: NVIDIA):

1. Add the hostname to `config/policies/network-base.yaml` under
   `allowed_domains`.
2. Save — CarapaBox hot-reloads automatically, or call the
   `reload_network_policies` MCP tool / restart CarapaBox.
3. Confirm: `grep integrate.api.nvidia.com generated/squid-generated.conf`

See [security-policies.md](./security-policies.md) for the full network-policy
reference.

---

| Route          | Upstream host                      | Auth method          | Status   |
|----------------|------------------------------------|----------------------|----------|
| `/anthropic/`  | `api.anthropic.com`                | OAuth or API key     | Tested   |
| `/codex/`      | `chatgpt.com/backend-api/codex/`   | ChatGPT OAuth        | Tested   |
| `/openai/`     | `api.openai.com`                   | API key              | Untested |
| `/google/`     | `generativelanguage.googleapis.com`| API key     | Tested   |
| `/openrouter/` | `openrouter.ai/api/`               | API key              | Tested   |
| `/nvidia/`     | `integrate.api.nvidia.com`         | API key              | Tested |
| `/mistral-eu/` | `api.eu.mistral.ai`                | API key              | Tested |
| `/mistral-vibe/` | `api.eu.mistral.ai`              | Vibe CLI key         | Tested |

---

## Anthropic (Claude Code)

### Auth: OAuth (recommended)

1. Connect a Claude account in CarapaBoard → **Provider accounts**, as the
   shared default or for a named relay client (see
   [provider accounts](provider-accounts.md); without Board, use
   `bun scripts/provider-accounts.ts`). The relay reads the managed credential
   file, refreshes the token when `expiresAt` is within 30 minutes, and retries
   once after an upstream 401 as a fallback. Rotated tokens are written back to
   the account directory.

2. Place a **dummy `.credentials.json`** in the agent keys folder so
   Claude Code detects an OAuth session but the real token never leaves
   the host. The relay overwrites the auth header anyway:

   ```json
   {
     "claudeAiOauth": {
       "accessToken": "sk-ant-oat01-DUMMY",
       "refreshToken": "sk-ant-ort01-DUMMY",
       "expiresAt": 1772324404815,
       "scopes": [
         "user:inference",
         "user:mcp_servers",
         "user:profile",
         "user:sessions:claude_code"
       ],
       "subscriptionType": "max",
       "rateLimitTier": "default_claude_max_5x"
     },
     "organizationUuid": "<org-id>"
   }
   ```

   Save as `$AGENT_HOME/.claude/.credentials.json`. Without this
   file, Claude Code won't start in OAuth mode and won't send requests
   through `ANTHROPIC_BASE_URL`.

3. In `carapa-bot/docker-compose.yml`, the agent gets:
   ```yaml
   environment:
     - ANTHROPIC_API_KEY=placeholder
     - ANTHROPIC_BASE_URL=http://api-relay:8080/anthropic
   ```

### Auth: static API key

Preferred: connect the key in CarapaBoard → **Provider accounts** (provider
**Anthropic API (key)**); Box checks it, stores it in the account store and the relay serves
it on `/anthropic-api/`, for all projects or one. See [provider accounts](provider-accounts.md).
The secret below remains the fallback for scopes without a managed key.

Set `ANTHROPIC_API_KEY=sk-ant-...` in `egress-proxy/.env` instead. The
relay injects it as `x-api-key` header.

---

## OpenAI Codex CLI (ChatGPT subscription)

Codex CLI with a ChatGPT subscription uses `chatgpt.com` (not
`api.openai.com`). The relay handles the translation.

### Prerequisites

1. Connect a Codex account in CarapaBoard → **Provider accounts** (device-code
   login; see [provider accounts](provider-accounts.md)).

2. **Remove auth.json from the agent keys folder** (the one mounted as
   `$HOME` inside the container). This is critical — if Codex CLI finds
   an auth.json in `~/.codex/`, it enters ChatGPT mode and hardcodes
   the endpoint to `chatgpt.com`, bypassing the relay for inference
   requests.

### egress-proxy configuration

Set `PROVIDER_ACCOUNTS_DIR` in `egress-proxy/.env` to the same directory as in
CarapaBox's `.env`. The relay reads the managed Codex credentials and injects:
- `Authorization: Bearer <access_token>`
- `chatgpt-account-id: <account_id>`

The relay refreshes the access token through `auth.openai.com` when its JWT is
within five minutes of expiry, and retries once after an upstream 401 as a
fallback. Rotated access and refresh tokens are written back to the managed
credential file.

### carapa-bot configuration

In `carapa-bot/docker-compose.yml`:
```yaml
environment:
  - OPENAI_API_KEY=sk-proj-relay-placeholder-00000000000000000000000000000000
```

A fake but well-formatted API key is required so Codex CLI accepts it
and enters API-key mode (rather than showing the signup/login screen).

### Codex config.toml

Place this at `$AGENT_HOME/.codex/config.toml` (which is mounted
as `~/.codex/config.toml` inside the container):

```toml
forced_login_method = "api"

model_provider = "relay"

[model_providers.relay]
name = "relay"
base_url = "http://api-relay:8080/codex"
wire_api = "responses"
```

Key settings:
- **`forced_login_method = "api"`** — forces Codex into API-key mode,
  preventing it from attempting ChatGPT OAuth login.
- **`model_provider = "relay"`** — selects the custom provider defined
  below.
- **`base_url`** — all requests (inference + usage) go to the relay,
  which prepends `/backend-api/codex` and forwards to `chatgpt.com`.
- **`wire_api = "responses"`** — use the responses wire format (required
  for chatgpt.com backend).

### Important: no auth.json in container

The agent keys folder (`$AGENT_HOME`) is mounted as `/home/ubuntu`
in the container. Make sure there is **no** `.codex/auth.json` in that
folder — only `config.toml` should exist:

```
$AGENT_HOME/
  .codex/
    config.toml    ← routes requests through relay
    (NO auth.json) ← must not exist, otherwise Codex hardcodes chatgpt.com
```

If Codex detects a ChatGPT auth.json, it ignores the custom provider's
`base_url` for inference and sends requests directly to `chatgpt.com`
through Squid — bypassing the relay entirely. Only side requests like
`/wham/usage` honor the custom `base_url` in ChatGPT mode.

---

## Google Gemini CLI

### Why OAuth cannot go through the relay

The Gemini CLI uses two completely different Google APIs depending on the
auth method, and they are not interchangeable:

| | `generativelanguage.googleapis.com` | `cloudcode-pa.googleapis.com` |
|---|---|---|
| **Auth** | API key (`?key=`) | OAuth (`cloud-platform` scope) |
| **Request format** | `/v1beta/models/{model}:generateContent` | codeAssist SDK (different paths) |
| **Used when** | `GEMINI_API_KEY` is set | `selectedType: "oauth-personal"` |

The OAuth token's scopes (`cloud-platform`) are rejected by
`generativelanguage.googleapis.com` (returns 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`),
and the `/v1beta/models/...` paths return 404 on `cloudcode-pa.googleapis.com`.

Additionally, in OAuth mode the CLI:
- Hardcodes `cloudcode-pa.googleapis.com` — ignores `GOOGLE_GEMINI_BASE_URL`
- Handles token refresh internally via `google-auth-library`
- Requires `~/.gemini/oauth_creds.json` in the agent's home directory

**Result:** Only API key auth can be proxied through the relay. OAuth must
go through Squid directly with credentials inside the container.

### Auth: OAuth (direct, bypasses relay)

1. Log in to Gemini CLI on the **host**:
   ```
   gemini auth login
   ```
   This creates `~/.gemini/oauth_creds.json` with `access_token`,
   `refresh_token`, and `expiry_date`.

2. Place `oauth_creds.json` in the agent's home directory
   (`$AGENT_HOME/.gemini/oauth_creds.json`). The CLI reads this file
   and refreshes the token automatically via `google-auth-library`.

3. The agent container needs:
   ```yaml
   environment:
     - HTTP_PROXY=http://squid:3128
     - HTTPS_PROXY=http://squid:3128
   ```
   Do **not** set `GEMINI_API_KEY` or `GOOGLE_GEMINI_BASE_URL`.

4. Ensure Squid allows `oauth2.googleapis.com` (token refresh) and
   `cloudcode-pa.googleapis.com` (inference).

5. The Dockerfile must include `coreutils` (BusyBox `env` lacks the
   `-S` flag needed by the gemini CLI's shebang):
   ```dockerfile
   RUN apk add --no-cache coreutils
   ```

In this mode, credentials live inside the container and the relay is not
involved. The CLI handles token refresh automatically.

### Auth: API key (via relay)

Preferred: connect the key in CarapaBoard → **Provider accounts** (provider
**Google Gemini API (key)**); Box checks it, stores it in the account store and the relay serves
it on `/google/`, for all projects or one. See [provider accounts](provider-accounts.md).
The secret below remains the fallback for scopes without a managed key.

1. Get a free API key from [aistudio.google.com](https://aistudio.google.com).

2. Set the API key in `egress-proxy/.env`:
   ```
   GOOGLE_API_KEY=AIza...
   ```
   Prefer the relay's `google_api_key` Docker secret for deployment. The relay
   injects `x-goog-api-key` and strips incoming Google key headers and `key`
   query parameters before logging/forwarding. It does not forward a client key.

3. In the agent's `docker-compose.yml`:
   ```yaml
   environment:
     - GEMINI_API_KEY=placeholder-relay
     - GOOGLE_GEMINI_BASE_URL=http://api-relay:8080/google
   ```

4. **Remove `HTTP_PROXY` / `HTTPS_PROXY`** from the agent container, or
   unset them in `run-agent.sh` for the gemini case. The Gemini CLI does
   **not** respect `NO_PROXY` — it routes all requests through the proxy,
   including requests to internal services like `api-relay`.

   This Gemini CLI caveat is not the Antigravity SDK/ACP path: the installed
   Antigravity runtimes honor `GOOGLE_GEMINI_BASE_URL` and `NO_PROXY`. CarapaBot
   adds the relay hostname to both `NO_PROXY` and `no_proxy`, retaining Squid
   for other egress. Both Antigravity API-key harnesses use a dummy key and no
   OAuth file. ACP's optional `oauth-personal` profile is separate and is not
   credential-injected by this Google API-key route.

5. **Delete `~/.gemini/oauth_creds.json`** from the agent's home directory.
   If the CLI finds OAuth credentials there, it enters OAuth mode and
   ignores both `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`.

6. The CLI validates `GOOGLE_GEMINI_BASE_URL` and rejects `http://` URLs
   unless the hostname is `localhost`. `run-agent.sh` works around this by
   starting a socat forwarder (`localhost:8080 → api-relay:8080`) and
   rewriting the URL. This requires `socat` in the Dockerfile.

7. The CLI persists `security.auth.selectedType` in
   `~/.gemini/settings.json`. If a previous OAuth login set it to
   `"oauth-personal"`, the CLI ignores `GEMINI_API_KEY`. `run-agent.sh`
   patches this to `"gemini-api-key"` automatically.

### Per-client configuration

Use `relay-clients/` config files to assign different Gemini auth per
container. Example `relay-clients/your-project.json`:
```json
{
  "match": ["your-project-*"],
  "providers": {
    "google": { "auth": "apikey", "envKey": "GOOGLE_API_KEY" }
  }
}
```

Containers without a matching config fall back to `default.json`, then to
the global provider settings.

Squid-tunnelled providers now verify upstream TLS (certificate and hostname) by default; set `"verifyTls": false` on a provider entry to turn this off for a self-signed upstream.

---

## NVIDIA (integrate.api.nvidia.com)

OpenAI-compatible chat completions at `integrate.api.nvidia.com/v1/chat/completions`.

### Setup

Preferred: connect the key in CarapaBoard → **Provider accounts** (provider
**NVIDIA API (key)**); Box checks it, stores it in the account store and the relay serves
it on `/nvidia/`, for all projects or one. See [provider accounts](provider-accounts.md).
The secret below remains the fallback for scopes without a managed key.

1. Get an API key from [build.nvidia.com](https://build.nvidia.com).

2. Store the key as a file-based secret (recommended):
   ```
   echo -n 'nvapi-...' > ${SECRETS_DIR}/nvidia_api_key
   ```
   Or set `NVIDIA_API_KEY=nvapi-...` in `egress-proxy/.env`.

3. Restart the egress-proxy stack so api-relay picks up the secret.

On upstream **429** (rate limit) or **529** (overloaded), api-relay retries up to
3 times (configurable via `OVERLOAD_RETRY_ATTEMPTS`), waiting
`max(Retry-After, exponential backoff)` between attempts
(`OVERLOAD_RETRY_DELAY_MS`, default 1s → 2s → 4s).

### Usage

Point any OpenAI-compatible client at the relay:

```
http://api-relay:8080/nvidia/v1
```

Example: `POST /nvidia/v1/chat/completions` with body
`{"model":"google/diffusiongemma-26b-a4b-it","messages":[...]}`.

For CarapaBoard chat/observer LLM profiles, see `llm:nvidia-diffusiongemma-26b`
in `data/board_agents.jsonc`.

---

## Mistral, EU only (api.eu.mistral.ai)

OpenAI-compatible chat completions at `api.eu.mistral.ai/v1/chat/completions`.
`api.mistral.ai` is Mistral's global default and does not promise EU processing,
so the relay route `/mistral-eu/` is fixed to the regional host `api.eu.mistral.ai`
(about 10% above standard prices), and Squid allows no other Mistral host.

### Setup

Preferred: connect the key in CarapaBoard → **Provider accounts** (provider
**Mistral API (key)**); Box checks it, stores it in the account store and the relay serves
it on `/mistral-eu/`, for all projects or one. See [provider accounts](provider-accounts.md).
The secret below remains the fallback for scopes without a managed key.

1. Create an API key in the Mistral console.
2. `echo -n '<key>' > ${SECRETS_DIR}/mistral_api_key`, or set `MISTRAL_API_KEY` in
   `egress-proxy/.env`.
3. The `mistral_api_key` compose secret is already declared in this repository's
   compose files; restart api-relay after creating the file.

### Usage

```
http://api-relay:8080/mistral-eu/v1
```

Reasoning models (Large 4 and others) return `content` as an array of `thinking`
and `text` chunks instead of a string; clients must handle that. Some models
(for example GLM 5.3 Flash) need a higher Mistral plan tier than the free one.

## Mistral Vibe (vibe-acp harness)

The `vibe-acp` harness runs Mistral Vibe through the relay route `/mistral-vibe/`.
It uses a **Vibe CLI key**, which Mistral bills to the plan's included Vibe Code
usage (Le Chat Pro or Team), not to the API allowance that `/mistral-eu/` uses.
The route is a client-config provider in `relay-clients/default.json`, fixed to
the EU host like `/mistral-eu/`.

### Setup

Connect the key in Board under **Provider accounts** (provider **Mistral Vibe**;
see [Board-managed provider accounts](provider-accounts.md)). A key there can
also serve only chosen projects. The Compose secret below remains the fallback:

1. In the Mistral console open **Code → Vibe CLI** and create a key.
2. `echo -n '<key>' > ${SECRETS_DIR}/mistral_vibe_api_key`.
3. The `mistral_vibe_api_key` compose secret is declared in this repository's
   compose files; recreate api-relay after creating the file.

Sandboxes get the placeholder key `carapa-relay` and `VIBE_*` settings that point
Vibe at `http://api-relay:8080/mistral-vibe/v1` and turn off its telemetry,
connectors, experiments and update checks. Vibe still asks `chat.mistral.ai`
for organisation-managed settings; Squid refuses that host.

Vibe 3.1.0 crashes a turn when the model calls `tools.process.start` in
`run_typescript` with a plain string instead of an object (a validation error
mentioning `RustAcceptedApplyResult`). The runner then restarts Vibe, reloads
the session and sends one correction prompt in the same run; the output shows a
restart notice. A second crash in the same run fails it. The model is also told
up front to pass an object, such as `tools.process.start({ command: '...' })`.

## Pacing a provider's requests

Set `requestsPerSecond` on a provider in `relay-clients/` when its account limits
how fast requests may start:

```json
"mistral-eu": {
  "auth": "apikey",
  "envKey": "MISTRAL_API_KEY",
  "requestsPerSecond": 1
}
```

The relay then queues HTTP requests for that provider route, from every client
and including its own 429 and 529 retries. A value below 1 is allowed: `0.5` means
one request every two seconds. Waiting requests log `paced, waiting <ms>`, and a
client that disconnects while waiting never reaches the provider. The queue limits
when requests start, not how many run at once or how many tokens they use, and it
does not cover WebSocket connections. An invalid value makes the whole relay
configuration invalid, like any other invalid field.

Each throttled provider response logs its rate-limit headers and error text:

```bash
docker logs egress-proxy-api-relay-1 2>&1 | grep "upstream 429"
```

---

## Request flow summary

### Claude Code
```
Claude Code → http://api-relay:8080/anthropic/v1/messages
  → relay injects Bearer token (OAuth) or x-api-key (static)
  → CONNECT api.anthropic.com:443 via Squid
  → https://api.anthropic.com/v1/messages
```

### Codex CLI (via relay)
```
Codex CLI → http://api-relay:8080/codex/v1/responses
  → relay prepends /backend-api/codex → /backend-api/codex/v1/responses
  → relay injects Bearer token + chatgpt-account-id
  → CONNECT chatgpt.com:443 via Squid
  → https://chatgpt.com/backend-api/codex/v1/responses
```

### Gemini CLI (API key, via relay)
```
Gemini CLI → http://api-relay:8080/google/v1beta/models/gemini-2.5-flash:generateContent
  → relay appends ?key=AIza...
  → CONNECT generativelanguage.googleapis.com:443 via Squid
  → https://generativelanguage.googleapis.com/v1beta/models/...?key=AIza...
```

### Gemini CLI (OAuth, direct — bypasses relay)
```
Gemini CLI → HTTPS_PROXY=squid:3128
  → CONNECT oauth2.googleapis.com:443 (token refresh)
  → CONNECT cloudcode-pa.googleapis.com:443 (inference)
  (relay not involved — credentials live in container)
```

### NVIDIA (via relay)
```
Client → http://api-relay:8080/nvidia/v1/chat/completions
  → relay injects Authorization: Bearer <NVIDIA_API_KEY>
  → CONNECT integrate.api.nvidia.com:443 via Squid
  → https://integrate.api.nvidia.com/v1/chat/completions
```
