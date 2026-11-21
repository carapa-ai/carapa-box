# Board-managed provider accounts

CarapaBoard's **Provider accounts** admin screen starts native Claude, Codex,
and Antigravity ACP login in a disposable CarapaBox-owned container. The
container has a new private profile, no workspace, no shared agent home, no
existing credentials, no Docker socket, and no agent-network attachment.
Provider consent/MFA still happens in your browser; it is not automated away.

## One-time operator setup

1. Create an absolute host directory outside **every** sandbox home/workspace
   mount, owned by the Box controller and relay user, mode `0700`. Set
   `PROVIDER_ACCOUNTS_DIR` to that same path in both CarapaBox's `.env` and
   `egress-proxy/.env`. Box and relay need directory read/write access for
   atomic replacement. `PROVIDER_LOGIN_UID` defaults to the Box process UID/GID
   and must match its owner. New sandbox mounts that overlap this directory are rejected;
   existing mounts must also be checked before choosing its location.
   **UID alignment matters:** Compose runs Box as `1000:1000` by default,
   matching the relay. Leave `PROVIDER_LOGIN_UID` unset to use that identity
   for login workers too. For a different owner, set `BOX_UID` / `BOX_GID` and
   the relay's `RELAY_UID` / `RELAY_GID` consistently. Compose also applies
   Box's identity to its writable tmpfs mounts; Docker socket access retains
   the separate `DOCKER_GID` supplementary group. The standalone image retains
   its nonroot default; use an explicit matching user outside Compose.
   When migrating an existing Box installation from UID 65532, align ownership
   of its `generated` state/output, audit logs, and configured `NGINX_PROXY_DIR`
   before recreating **only** Box. Preserve existing contents and private modes;
   do not make credentials world-readable or recursively change sandbox homes.
   Box and relay must also be able to read their existing configuration and
   credential files. Host-mode Box should run as the same directory owner.
2. Reuse the existing `CARAPA_BOX_API_TOKEN` shared by Board, Box, and the
   trusted relay. No additional provider-login token or secret mount is needed.
   Board requires a human administrator and a signed enrolled device; Box
   requires its existing infrastructure authentication and rejects account
   management when no token is configured. Never expose the Box token through
   sandbox mounts, agent configuration, or an agent-accessible Box relay route.
   These specific provider-account endpoints accept the API token even when a
   separate `CARAPA_BOX_ADMIN_TOKEN` is configured for operator administration.
   Board does not need that admin credential; other admin endpoints remain restricted.
3. Set Box's `PROVIDER_RELAY_CLIENTS_DIR` to the actual **relay-clients
   directory**, including that last directory component. It is read-only to
   Box. The relay's existing `RELAY_CLIENTS_DIR` setting refers to its parent.
   They must resolve to the same client configuration files.
4. Set `PROVIDER_LOGIN_IMAGE` to the trusted public runtime (default
   `carapa-bot:0.1.0`) and `PROVIDER_LOGIN_HARNESS_VOLUME` to the volume reported
   by `python3 stacks/carapa-bot/harness.py status`. Install the requested native
   CLIs first; the login worker mounts that volume read-only. Antigravity needs
   `antigravity-acp`. Select a compatible volume again after a runtime upgrade.
   An explicitly configured self-contained image can omit the volume. Images are never pulled by a
   login request. `PROVIDER_LOGIN_NETWORK` defaults to `egress_proxy`, and
   `PROVIDER_LOGIN_PROXY` to `http://squid:3128`; configure these for your topology.
   The existing Google/OpenAI/Anthropic egress allowlist is still required.
5. Reload the updated `security/apparmor-controller` profile using the existing
   AppArmor installation procedure. Rebuild/recreate Box and api-relay to add the mounts; rebuild/recreate Board for
   its UI/backend. Do not restart working agent containers.

For Antigravity ACP/SDK, select the OAuth relay route in the agent environment:

```json
{
  "ANTIGRAVITY_ACP_AUTH_METHOD": "gemini-api-key",
  "GOOGLE_GEMINI_BASE_URL": "http://api-relay:8080/antigravity"
}
```

`gemini-api-key` describes the **sandbox-to-relay** protocol: the harness supplies
its dummy key. The relay uses Google OAuth upstream. Do **not** select native
`oauth-personal` in the agent or mount `acp_token.json` there. The existing
`/google` API-key route is unchanged. Start a new conversation when changing
the endpoint/auth identity. This does not automatically edit Board's agent
catalog or upgrade running sandboxes.

## Using the screen

Open the sidebar administration menu → **Provider accounts**. Choose the
provider, an account label, and either **Shared default** or an existing named
relay client, then **Connect**. Connect always adds an account. To sign an
existing account in again, use **Reconnect** on its row: the old credentials
remain active until the new login completes. Several sign-in accounts of one
provider for the same scope share that provider's route; see
[Several accounts for one provider](#several-accounts-for-one-provider).

- Codex: open the verification URL and approve its device code. Requires a CLI
  with app-server `chatgptDeviceCode` support and device login enabled for the
  account. No localhost forwarding is needed.
- Claude: open the Claude subscription sign-in URL and paste the authorization
  code into Board if prompted. Uses `claude auth login --claudeai`, not a
  non-refreshable setup-token substitute.
- Antigravity: approve Google OAuth. On a remote installation, the browser's
  final `http://127.0.0.1:.../` page may fail to load. Paste that **complete URL**
  into Board. Box forwards it only to the exact loopback endpoint and OAuth
  state advertised by that attempt, inside the login container. Native ACP
  performs account eligibility/onboarding before credentials are installed.
- Cursor: open the `cursor.com/loginDeepControl` link and approve the sign-in;
  `cursor-agent login` in the login container polls for the result. The login
  lasts about 60 days and has no renewal without an API key: reconnect when
  it expires.

- API keys: **Mistral Vibe**, **Mistral API**, **OpenRouter**, **Anthropic
  API**, **OpenAI API**, **Google Gemini API**, **NVIDIA API**, **Typesafe /
  Jev**, **GitLab** and **GitHub** have no sign-in. Paste the key into the form and choose
  **Save key**. Box checks it with a call that needs a valid key (Mistral
  `GET /v1/models` on the EU host, OpenRouter `GET /api/v1/key`, Anthropic and
  OpenAI `GET /v1/models`, Gemini `GET /v1beta/models`, NVIDIA's NGC
  `POST /v3/keys/get-caller-info` because its model list is public, Typesafe
  `POST /v1/systemone`, GitLab `GET /api/v4/personal_access_tokens/self`,
  GitHub `GET /user`) and
  installs it at once; a refused key is not saved. Each key serves the relay
  route of the same name (`/mistral-vibe/`, `/mistral-eu/`, `/openrouter/`,
  `/anthropic-api/`, `/openai/`, `/google/`, `/nvidia/`, `/jev/`, `/gitlab/`,
  `/github/`) for
  the chosen scope, so a second plan seat can serve chosen projects through a
  named client. A managed key replaces that route's Compose secret; the secret
  still serves scopes without a managed key. A client-specific key keeps the
  route's host, path prefix and pacing but not the shared route's
  `extraHeaders`, which belong to the shared key. To replace a key, choose
  **Reconnect** and paste the new one. Box deletes the replaced key's file (it
  is not kept as rollback material like a replaced login); revoke the old key
  in the provider's console as well. A missing key file fails the request; it
  never falls back to another key.
- A GitLab token also names its server (**GitLab URL**, `https://` and no
  path). That host replaces the route's `GITLAB_HOST_URL` for the account's
  scope, so a project can use another GitLab server; Squid must allow that host.
  For the read-only git route (`/gitlab-git/`, see `egress-proxy/README.md`) the
  key also needs the `read_repository` scope.
- A GitHub token names its server too (**GitHub URL**, `https://github.com` or
  a GitHub Enterprise Server). The relay sends `/github/` requests to its REST
  API (`api.github.com`, or `<server>/api/v3` on Enterprise) with
  `Authorization: Bearer`, and `/github-git/` clones to the server itself. A
  fine-grained token needs read access to Issues (issue import) and Contents
  (cloning); a classic token needs `repo` for private repositories.
- Board's issue import and `sandbox_issues` use these code hosting accounts:
  the account for the repository's server that the relay serves to the
  project's agent container (see the README's issue tracker section). Like
  the relay, Box matches client patterns against the network-qualified
  container hostname Docker reports (`<container>.<network>`, one per network
  the running agent container is attached to; the first that matches a client
  decides), and falls back to the bare container name. Whether matching is
  exact comes from `RELAY_REQUIRE_KNOWN_CLIENTS` in the relay's
  `egress-proxy/.env` (read by Box) or `requireKnownClients` in the
  relay-clients defaults; `RELAY_REQUIRE_KNOWN_CLIENTS` in Box's own
  environment no longer influences this.
- Anthropic API keys that are not scoped to one workspace need its **Workspace
  ID** (`wrkspc_…`, Claude Console → Workspaces); Anthropic refuses them
  otherwise, and Box says so. The ID is stored with the account (it is not
  secret) and sent as `anthropic-workspace-id` on every `/anthropic-api/` request.
- **Anthropic Admin** takes an admin key (`sk-ant-admin…`), checked with
  `GET /v1/organizations/me`. It never becomes a relay route: the relay reads
  it only for the API spend report. It pairs with the Anthropic API account of
  the same scope (and client), so a project can bring its own organisation's
  admin key. Each admin key's month-to-date organisation spend is reported per
  account (`apiSpendByAccount`). The shared admin key also replaces the `ANTHROPIC_ADMIN_KEY`
  secret for the default spend (`apiSpend`).

Login sessions expire after 15 minutes. Cancel removes only that temporary
worker/profile; it does not revoke or overwrite an existing account. Native
provider output is not sent to Board or Docker logs. Only validated sign-in
instructions/status are exposed. Submitted codes are private, single-use input
files and never command arguments. The screen requires a signed request from
an enrolled human administrator's device; it is not exposed as an agent tool.

## Storage, refresh, and isolation

`accounts.json` holds non-secret binding metadata; `credentials/<uuid>.json`
holds private native-format credentials. A reconnect installs a new credential
file and atomically switches the binding. Prior credential files are retained
as private rollback material, are not part of the managed refresh registry,
and are never mounted into login workers. Operators may remove obsolete files
after confirming they are not referenced. Files referenced explicitly by a
relay-client `credentialFile` (for example under `OAUTH_CLIENT_CREDENTIALS_DIR`)
are left unchanged and still refreshed. The former `CLAUDE_CREDENTIALS_DIR` /
`CODEX_CREDENTIALS_DIR` relay settings are retired.

Each login keeps Box-owned metadata in `attempts/<id>/attempt.json`. Only
`attempts/<id>/profile/` is mounted into the login worker, as its home, so
worker output cannot change Box's record of the login. Box ignores and removes
any attempt that does not match this layout.

Upgrade note: logins in progress while upgrading Box from an earlier version
are cancelled and must be started again.

Box resumes installation from completed login profiles after a restart. Board
can restart at any time; existing relay refresh and agent runs do not depend on
it. Run only one Box account controller and one refresh-owning relay per account
directory. The operator CLI (`bun scripts/provider-accounts.ts`) uses the same
controller but must not run concurrently with a running Box account controller.

Shared managed accounts override that provider's default; explicit per-client
routes still take precedence. Client-specific accounts override only the named
client/provider. For **hard separation**, first configure strict clients and
`RELAY_REQUIRE_KNOWN_CLIENTS=1` as described in [API relay setup](api-relay-setup.md).
The UI reports existing isolation; selecting a shared/wildcard client does not
turn it into a strictly isolated sandbox. Separate OAuth logins and filesystem
mounts are required for genuine separation; copying one rotating session is not
an independent account. A deleted client mapping makes the managed registry
invalid rather than falling back to shared credentials.

Antigravity extends the common OAuth lifecycle with Google's refresh format,
backend discovery, request wrapping, and incremental SSE response unwrapping.
ACP's API-key mode splits Gemini model variants into a base model and thinking
level. The `/antigravity` relay restores the OAuth variant ID for Gemini 3.x
Flash and Gemini 3.1 Pro preview while preserving the request's thinking settings.
Already-qualified model IDs pass through unchanged; no fallback model is chosen.
The `/google` API-key route and Board's model bindings are unaffected.
Only Gemini generate/streamGenerateContent is supported on `/antigravity`;
arbitrary CCPA operations are not exposed. The relay validates TLS and selects
only the native consumer/enterprise backend hosts, never a client-supplied host.

Cursor's `/cursor` route forwards every Connect call of the CLI to
`api2.cursor.sh` with the managed login. Sandboxes point the CLI there with
`CURSOR_API_ENDPOINT` and `network.useHttp1ForAgent`, which keeps agent traffic
on that endpoint over HTTP/1.1 instead of Cursor's HTTP/2 agent hosts. The relay
answers the CLI's telemetry itself with an empty message and never forwards
it: `AnalyticsService` and `MetricsService` calls, `ReportAiCodeChangeMetrics`,
and OpenTelemetry `/v1/traces`, `/v1/logs` and `/v1/metrics`, and a non-Cursor endpoint also turns off the CLI's
separate metrics upload.

`Connected` indicates a currently usable cached credential; `Waiting for relay
refresh` indicates an expired or native refresh-only credential. It is not a
guarantee that a provider will accept a revoked session; reconnect if renewal
continues to fail. No live account login is performed by automated tests.

## Encryption at rest (optional)

Set `CARAPA_CREDENTIALS_KEY_FILE` in both CarapaBox and api-relay to a file
holding a random 32-byte key (base64), normally a Compose secret. Every secret
file in the account store is then sealed with AES-256-GCM: installed logins and
API keys (`credentials/`), MCP tokens (`mcp/credentials/`) and MCP PKCE
verifiers (`attempt-secret.json`). A file's path relative to the store is
authenticated with it, so a sealed file copied over another account's fails to
open. Status, usage and registry files hold no secrets and stay readable.

- The relay seals every existing plain file at start, before its first refresh,
  and both services keep reading plain files, so turning it on needs no
  separate migration. Box's own writes are sealed from then on.
- A key that is named but missing or not 32 bytes stops the relay (and Box's
  account controller) instead of writing secrets in the clear.
- Files outside the store, such as a relay-client `credentialFile` another tool
  may read, are never sealed.
- A login worker's own result file stays plain for the seconds between sign-in
  and installation; Box deletes it with the attempt.

Where the key comes from is the operator's choice. On a host with a TPM 2.0
chip, seal it with `systemd-creds encrypt --with-key=tpm2` and unlock it at boot
into a tmpfs file before Docker starts, for example with a oneshot systemd
unit ordered `Before=docker.service` that runs `systemd-creds decrypt` into
`/run/carapa/credentials.key`. Then a backup or a copied disk
cannot open the store. Anyone who can run Docker on the host can still read the
unlocked key, so this protects copies of the data, not a compromised operator
account. Keep an offline copy of the key: without it, every provider must be
connected again.

## Several accounts for one provider

Sign-in providers (Claude, Codex, Antigravity, Muse, Grok, Cursor) accept more
than one account for the same scope, for example a personal and a business
ChatGPT subscription. API-key providers keep one key per scope. The relay then
chooses the account per session:

- **A session keeps its account.** The session is the id the CLI sends
  (`session-id` for Codex, `x-claude-code-session-id` for Claude Code) within
  its sandbox; a client that sends neither counts as one session per sandbox.
  The choice is remembered for 24 hours after the session's last request and
  survives a relay reload (`quota/sessions.json`).
- **A new session takes the account that resets soonest**, among the accounts
  that still have quota: allowance that would be lost at the reset is used
  first. The reset compared is the latest one among the account's usage
  windows, normally the weekly one. Accounts without a usage reading count as
  unused, and equal accounts follow the list order.
- **A session moves only when its account is used up**: a usage window at
  100%, or the provider refusing a request because the plan's limit is reached
  (Codex `usage_limit_reached`, Claude `anthropic-ratelimit-unified-status:
  rejected`). That refused request is sent again on the next account, so the
  agent sees no error. The session then stays on the new account. When every
  account is used up, the session stays where it is and the provider's answer
  is returned. Ordinary rate limits (a plain 429) never change the account.
- An account whose sign-in cannot be used (login required, renewal failing) is
  passed over.

Box records each account's usage windows in `quota/<credential id>.json`
whenever usage is read, and reads usage every 5 minutes while a provider has
several accounts. A window that fills between two readings is therefore
noticed within 5 minutes for providers whose refusal the relay does not
recognise, and for WebSocket traffic, whose frames the relay does not inspect.
A session that changes account loses the provider's prompt cache once.

## Removing an account

**Edit → Remove account** on the account's row
(`DELETE /api/admin/provider-accounts/<id>`, Board API token) deletes the
account, its stored sign-in or key, its usage readings and any open login for
it. The response has the same shape as `GET /api/admin/provider-accounts`. The
relay stops using the account within seconds: sessions on it continue on
another account of the same provider and scope, and when it was the only one,
the route falls back to what it used before the account existed (a Compose
secret, or no credentials). Nothing is revoked at the provider; sign the
session out or revoke the key there as well.

## Tier and capacity estimates

`PATCH /api/admin/provider-accounts/<id>` (Board API token) sets the admin's
estimate for an account, for example `{ "tier": "max 5x", "capacity": 500 }`.
`tier` is free text (1–40 characters after trimming). `capacity` is an integer
from 1 to 1000 giving the account's size relative to the others, such as about
100 for Claude Pro or 1 for a free tier. Send `null` to clear a field; omitted
fields are unchanged. The same PATCH can rename the account with `label`, for
example `{ "label": "claude max 20x" }`. A label is a string of 1–80 characters
after trimming; it cannot be cleared, only replaced, so `null`, an empty or
blank string, and a non-string are rejected. The response is the updated
listing entry, and `GET /api/admin/provider-accounts` returns the label, tier
and capacity. These are admin estimates, not measurements, and a re-login keeps
the tier and capacity. A re-login uses the label entered in the login form. The
relay ignores an invalid value in `accounts.json` and never uses either field
for routing.

## Key expiry

Box tracks when each API-key account (inference providers, GitLab and GitHub)
expires or has stopped working, so Board can warn the admin in time. None of it
changes `state`: a key account stays `connected` while its key file exists,
even when its key is expired or rejected. OAuth and sign-in accounts report
`loginRequired` themselves and refuse an expiry date.

- **Manual expiry.** `PATCH /api/admin/provider-accounts/<id>` accepts
  `{ "expiresAt": "2026-12-31" }`, a calendar date `YYYY-MM-DD` (UTC; the key is
  usable through the end of that day). `null` clears it and an omitted field is
  unchanged. The same applies to project integrations (GitLab, GitHub and custom). The key login (`POST /api/admin/provider-accounts/login`) takes the
  same optional `expiresAt`. Saving a key again for an existing account (Reconnect)
  replaces the manual expiry with the one supplied; none supplied clears it, so a
  new key never inherits the old key's date. An invalid date, or any date on a
  sign-in account, is refused with a message for the admin. The date is stored
  in `accounts.json`; the relay ignores an invalid value there.
- **Provider-reported expiry.** GitLab reports it in `expires_at` of
  `GET /api/v4/personal_access_tokens/self` (`null` when the token never
  expires). GitHub reports it in the `github-authentication-token-expiration`
  response header of `GET /user`; a token without the header has no known expiry.
  Other providers report none.
- **Listing fields.** Each key account in `GET /api/admin/provider-accounts`
  (and the PATCH response) gains, when known: `expiresAt` (`YYYY-MM-DD`),
  `expirySource` (`provider` or `manual`; the provider's date wins over the
  manual one), `keyCheck` (`valid` or `rejected`) and `keyCheckedAt` (epoch
  milliseconds). They are absent until the first check or manual value. The key
  itself is never returned or logged.
- **Daily check.** Saving a key fills `keyCheck` and the provider's expiry from
  the check it already makes. Box then checks every key account that has a key
  file once shortly after startup and every 24 hours, one account at a time,
  with the account's workspace ID and server. A valid answer stores `valid` and
  the provider's expiry (a token that never expires clears an earlier provider
  date); a refusal stores `rejected`. An unreachable provider or a missing
  workspace ID (`unavailable`, `needsWorkspace`) leaves the previous values
  untouched, so a network error never marks a key rejected. Results are kept in
  memory only and are recomputed after a restart; deleting an account drops its
  entry.

## Account order

`POST /api/admin/provider-accounts/order` (Board API token) stores the admin's
manual order of the account list, for example `{ "ids": ["<id>", "<id>"] }`.
`ids` must be every current account id exactly once; a missing, unknown or
duplicate id, a different length, or a non-array is rejected with HTTP 400
("The account list changed; reload and try again") and `accounts.json` stays
unchanged. On success the response has the same shape as
`GET /api/admin/provider-accounts`, listed in the new order. A re-login or a
key re-save keeps the account's position; a new account is added last. The
order never affects routing.

## Subscription usage

`GET /api/admin/provider-accounts/usage` (Board API token) returns, per managed
account, the plan's usage windows (`label`, `usedPercent`, `resetsAt`) for
Claude (`api.anthropic.com/api/oauth/usage`), Codex
(`chatgpt.com/backend-api/wham/usage`) and Antigravity (the account's native
Cloud Code backend, `v1internal:fetchAvailableModels`, grouped by shared quota)
and Cursor (`DashboardService/GetCurrentPeriodUsage`: billing-cycle total, Auto
and API shares of the included usage). These are the endpoints each vendor's
CLI uses; they are undocumented and may change, so failures are reported as a
per-account `error` and never change the login state. Results are cached for 60
seconds, use the relay-refreshed access token read-only, and are never fetched
for a credential the relay has not yet refreshed. Box needs egress to those hosts; set `PROVIDER_USAGE_PROXY` (for example
`http://squid:3128`) if Box reaches the internet only through the proxy.

OpenRouter is prepaid credits: the usage response carries a separate `credits` object
(`totalCredits`, `totalUsage`, `remaining` in US dollars, `fetchedAt`) for the
shared default's key: a managed shared OpenRouter key, else the
`OPENROUTER_API_KEY` secret. When that key is configured and
`PROVIDER_ACCOUNTS_DIR` is set, it reads `openrouter.ai/api/v1/credits` through
the proxy every 5 minutes and records the balance in `usage/openrouter.json`
beside the managed accounts. Box only reads that file; `credits` is omitted
until the relay has recorded one. The relay also reads OpenRouter's public model
list (`openrouter.ai/api/v1/models`) once an hour and records each model's price
in `usage/openrouter-prices.json`; Box returns it as `openRouterPrices`
(`models` keyed by OpenRouter model id, with `name`, `input`, `output` and
`cacheRead` in US dollars per million tokens).

Mistral's plan allowances come from Mistral billing
(`api.mistral.ai/v1/billing/budget`; the EU host has no billing endpoint). When
the Vibe CLI key is mounted as the `mistral_vibe_api_key` secret, Box reads it
directly every 5 minutes and returns `mistralBudget`, shaped like an account's
usage: one window for the API allowance and one for the Vibe Code allowance
(`usedPercent`, `resetsAt`, and a label with the amount used and the monthly
budget). It is omitted when no key is mounted, and when a managed Mistral
account exists: each managed Mistral key then reports the same two windows as
that account's usage, so every seat shows its own allowances.

## Account models

`GET /api/admin/provider-accounts/models` (Board API token) returns, per managed
account, the models the subscription currently offers (`id`, and where the
provider reports them `name`, `contextSize`, `maxOutputTokens`, `reasoning`,
`defaultReasoning`, `inputs`, `minClientVersion`) for Claude
(`api.anthropic.com/v1/models`), Codex (`chatgpt.com/backend-api/codex/models`,
hidden helper models omitted) and Antigravity (the same `fetchAvailableModels`
call as usage, internal helper models omitted). Grok and
Muse report an `error`; Board reads their models from the harness instead. The
same read-only token rules and proxy apply as for usage; lists are cached for 10
minutes and errors for 60 seconds.
