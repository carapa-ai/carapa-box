# Authentication, mounts, and relay

For ingress client allowlists, private route state, egress policy reloads and
proxy verification, also read [proxy operations](proxies.md).

## Controller secrets

Use a dedicated host directory outside all agent mount roots. During authorized setup,
provision separate API and admin credentials with the bundled helper:

```bash
bash .agent/skills/setup/scripts/ensure-controller-secrets.sh --secrets-dir /absolute/path/to/secrets
```

The helper generates independent random tokens in `carapa_box_api_token` and
`carapa_box_admin_token`, using mode 0600 for new files. It preserves existing credentials,
creates only missing files, and rejects empty, invalid, or identical credentials. Never print
token values or pass them as command-line arguments. Resolve invalid existing files through
an authorized rotation; do not overwrite them during setup.

The API credential is for MCP and sandbox API clients such as Board. The admin credential is
for `/api/admin/*` and the dashboard login. Admin access has no API-token fallback: it is
disabled when the admin token is missing or identical to the API token. Mount both files into
the controller, but give Board/relay clients only the API token. For the plugin, register the
local operator's admin credential reference with `--admin-token-file`; never use it in MCP headers.
Remote setup runs this Bash helper on the selected controller host and provisions the operator's
credential files privately. It does not require Python on the remote controller.

The actual container process must be able to read the mounted secret. Local
Compose file-backed secrets may retain the source file's UID/GID and permissions;
a host-user-owned mode-0600 file is not automatically readable by a different service UID.
Inspect `BOX_UID`/`BOX_GID` and Compose overrides rather than assuming the image's default UID.
Use a scoped group/ACL or other operator-approved provisioning that grants only
the controller and required relay account access. Inspect current ownership and
permissions; do not apply recursive chmod/chown or world-readable secret rules.
Keep the containing host directory private. File-backed secrets are not automatically
encrypted and are not a substitute for filesystem access control.

For Board integration, point both services at the same intended API credential
or provision matching files securely. Do not silently rotate it. The bundled
checker reads a token file without exposing the value in argv or output.

## Mount allowlist and stack boundaries

CarapaBox reads `config/mount-allowlist.yaml`. For a fresh configuration, start
with an empty `allowed: []` and add only the absolute directories required by the
selected stack: repository, agent home, group data, and IPC. Preserve existing
entries. Variables such as `$HOME` are not expanded. Never allow `/` or the
operator's entire home just to get a stack running. Review
`docs/mount-allowlist.md` from the repository root.

The agent home is a dedicated host directory mounted as `/home/ubuntu`; it is
not the operator's real home. Keep provider OAuth tokens and provisioning secrets
outside it when the selected harness supports relay injection. Remote Git SSH
keys belong to the Git sidecar boundary, not agent mounts. CarapaBox owns Docker;
do not grant Board, Brain, Mail, WaLink, or agents its socket or control credentials.

Configure only requested optional tools (`ENABLE_SANDBOX_GIT`, issue tools,
search, tmux, nginx). A feature flag alone does not supply its credentials,
network routing, or a compiled stack policy. Stack implementations are maintained
in the operator's stack source; do not edit release/security copies in parallel.

## Egress and provider onboarding

Use the repository's `docs/api-relay-setup.md`, `egress-proxy/README.md`, actual
Compose file, and `relay-clients/*.json`. Read only the selected provider's setup.
Preserve existing routes and provider settings. OAuth directories mounted into
the relay may require write access for refresh. Some harnesses need an in-sandbox
login; follow the documented provider exception rather than copying all of the
operator's CLI configuration into agent home.

Distinguish:

- Provider routes, which inject upstream credentials.
- Board MCP routes, which identify the current project/persona.
- CarapaBox control routes, which belong to trusted operator/controller clients.

Do not add `sandbox-relay` to agent client configurations to make setup work.
Current agent clients have no CarapaBox control route; older README examples may
show an obsolete topology. Agent networks stay internal and outbound domains
remain allowlisted. Do not broaden allowlists to `*` or restart Docker to resolve
a single missing provider route.

Shared skills are distributed by CarapaBoard's setup bundle. If Board is part of
this installation, invoke its synchronization script against the selected
`AGENT_HOME`. Box should not carry or maintain a duplicate shared skill bundle.
