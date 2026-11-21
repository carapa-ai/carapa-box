# MCP connections (remote MCP servers with OAuth)

Board can connect a project to an operator-allowlisted remote MCP server through
the admin API. The api-relay performs the OAuth login and holds the tokens;
CarapaBox only passes file-based intents to it and never reads or returns tokens,
authorization codes or secrets.

## Setup

1. Add the server to a relay-clients file (for example `relay-clients/default.json`):

   ```json
   { "services": { "notes": {
       "auth": "mcp-oauth",
       "url": "https://mcp.example.com/mcp",
       "projects": ["my-project"]
   } } }
   ```

   A query string in `url` (for example `?workspace=w`) is kept on every forwarded call,
   merged with the sandbox request's own query; the sandbox cannot override those parameters.

   Only the listed `projects` can log in to or use the service. `projects` are board
   project folders (sandbox instances such as `carapa`), not network names such as
   `carapa-projects-carapa`. The relay resolves a sandbox's network to its instance
   through Box (`GET /api/admin/relay-identity/<name>`) and fails closed with 403 if
   Box is unreachable or does not know it. Projects sharing one sandbox instance
   share its connections.

   **Migration:** replace entries like `carapa-projects-carapa` with `carapa`, then
   log in again for that project (credentials are keyed `<service>--<project>`).
2. Add the MCP server host (and any `authHosts` of its authorization server) to the
   relay-only Squid domain list so the relay, but not sandboxes, can reach them.
3. Set `PROVIDER_ACCOUNTS_DIR` on CarapaBox and the relay (same directory as
   [provider accounts](provider-accounts.md)). Without it every MCP connection
   call fails closed. Files live in `PROVIDER_ACCOUNTS_DIR/mcp`:
   `attempts/<uuid>/{request,callback,revoke}.json` (written by Box) plus
   `credentials/` and `status/` (written only by the relay).

## Admin API

All routes are under `/api/admin/mcp-connections` and accept the Board API token.
Errors are generic.

| Route | Purpose |
| --- | --- |
| `GET /` | Services (`service`, `host`, per-project state) and pending logins |
| `POST /login` `{service, project}` | Start a login; returns `{id}` |
| `POST /login/<uuid>/complete` `{value}` | Submit the pasted callback URL (max 16 KB) |
| `DELETE /login/<uuid>` | Cancel a login |
| `POST /revoke` `{service, project}` | Revoke the stored credential |

## Login failure codes

A failed login lists an `error` code next to `state: "failed"`:

- `untrusted_metadata_host`: a metadata URL points to a host that is not allowed.
- `protected_resource_metadata_unavailable`: the protected-resource metadata could not be fetched.
- `authorization_server_metadata_unavailable`: the authorization-server metadata could not be fetched.
- `issuer_mismatch`: the metadata issuer differs from the expected one.
- `resource_mismatch`: the metadata resource differs from the service URL.
- `invalid_metadata`: the metadata is malformed or lacks required fields.
- `client_registration_unavailable`: the server offers no dynamic client registration.
- `client_registration_failed`: dynamic client registration was rejected.
- `client_secret_missing`: the registered client requires a secret that was not issued.
- `token_request_rejected`: the token endpoint rejected the request.
- `callback_mismatch`: the pasted callback URL or state does not match the login.
- `project_not_allowed`: the project is not listed for the service.
- `unsafe_path`: a stored path was unsafe and was refused.
- `internal_error`: unexpected relay error.

## Paste-back flow

1. Start a login and poll the list until the attempt has an `authorizationUrl`.
2. Open the authorization URL and sign in.
3. The browser is redirected to `http://127.0.0.1:33418/callback?...`, which will
   not load. Copy the final URL from the address bar and submit it as `value`.
4. The relay validates the state, exchanges the code and marks the project
   `connected`. Attempts expire after 15 minutes.

## Sandbox-initiated login

A sandbox can run the whole login for its own project and only hand the sign-in
link to the human. The project always comes from the verified sandbox identity
(never from the body or query); the service must list that project. Responses are
`application/json` with `Cache-Control: no-store`, and these requests are never
forwarded upstream.

| Route | Result |
| --- | --- |
| `GET /<service>/.status` | `{service, project, state, logins, relayCode}`; `logins` are this project's attempts `{id, state, authorizationUrl?, error?, expiresAt}`. `relayCode` is a 12-hex hash of the relay's `mcp-oauth.mjs` and `api-relay.mjs`, so a stale bind mount is visible. |
| `POST /<service>/.login` | `202 {id}`. At most 2 in-flight attempts per service and project, 4 per project across all services, and 12 in total (4 of the 16 global slots stay free for admin-started logins); beyond that `429 {error}` (`login_in_progress` for the per-service limit, `too_many_logins` for the others). |
| `POST /<service>/.login/<id>/complete` | Body `{"value": "<redirect URL>"}` (string, max 16 KB). `202`; `404` for an unknown attempt or another project's; `400` for an invalid value. |

```sh
curl -s -X POST http://api-relay:8080/notes/.login                       # {"id":"..."}
curl -s http://api-relay:8080/notes/.status                              # wait for logins[].authorizationUrl
# the human signs in and copies the final http://127.0.0.1:33418/callback?... URL
curl -s -X POST http://api-relay:8080/notes/.login/<id>/complete -d '{"value":"<url>"}'
curl -s http://api-relay:8080/notes/.status                              # state: connected
```

Who can do what: sandboxes can start, complete and read the status of their own
project. Admins (Box API) can additionally revoke and see all projects. Revoke is
not available to sandboxes. In forward mode these routes go to the hub, which
resolves the project from the forwarded sandbox identity.

## Using the connection in a sandbox

```json
{ "mcpServers": { "notes": { "type": "http", "url": "http://api-relay:8080/notes" } } }
```

The entry value is `{"type":"http","url":"http://api-relay:8080/<service>"}`. The
relay injects the project's bearer token. Streaming responses are subject to the
relay's 120 s idle timeout; an idle MCP stream is closed after 120 s and the
client must reconnect.

## Accepted risks

- An agent can ask the human to sign in, but only for allowlisted services and
  projects, and the consent page is always the service's own.
- Any process inside an allowed project's sandbox can use the token through the
  relay within the scopes that were granted.
- Credentials are protected only by file modes (0600 files, 0700 directories); there
  is no at-rest encryption.
- Client ID Metadata Documents (CIMD) are not supported. Servers must allow dynamic
  client registration or be given a static `clientId`.
