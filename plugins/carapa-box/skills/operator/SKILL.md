---
name: operator
description: Install, repair, upgrade, or configure CarapaBox on an authorized local or SSH Linux operator host, including stacks, policies, mounts, ingress and egress proxies, and credentials. Does not bypass sandbox execution policy.
---

# Administer CarapaBox

Read the selected connection's entry using the helper `list` command. Confirm its SSH alias,
host checkout path and deployment mode from the actual host; URLs come from native Codex MCP
configuration. Use local commands for a local host and the selected SSH alias for a remote host.
Keep host selection explicit in commands and reports. An inventory entry is context, not permission
for unrelated changes, secret rotation, workload deletion, or Docker daemon restarts.

For installation, repair, prerequisites, and mounts, read the packaged canonical
[CarapaBox setup workflow](../../references/setup/SKILL.md). Its referenced scripts and guides
are included here. When it shows `.agent/skills/setup/...`, use the packaged equivalent under
this plugin's `references/setup/`; pass `--repo-root /absolute/host/checkout` to its inspector.
When operating remotely, stage only the required helper scripts in a private temporary directory
on the selected host, execute there, and remove that staging directory afterward. Repository
scripts such as `build.sh` run from the selected host checkout; do not upload a local `.env`.
Inspect the target checkout's current README, Compose files and scripts when versions differ.

For ingress setup/migration, HTTP or SSH exposure, egress allowlists, provider routing,
or proxy recovery, read [proxy operations](../../references/setup/references/proxies.md).
Inspect the selected host's deployed support before enabling features. Proxy changes affect
shared infrastructure; preserve existing workloads and use scoped service operations. Native
MCP remains connected directly to the controller, independently of sandbox proxy traffic.

Reuse the existing build, policy compilation and service installers. Preserve operator-owned
stacks and existing configuration. Hardened container mode is the default; choose host mode for
development. Read-only bind mounts mean configuration changes often belong on the host, followed
by the appropriate controller recreation or policy reload. Do not disable hardening to make a
write succeed. Base Compose publishes on all host interfaces: for a new SSH-only installation,
configure loopback-only publication before startup while accounting for any existing Board/relay
access requirements. Do not change a live installation's bindings without that scope.

For admin information, provider-account operations or writable admin configuration, use the helper's
`admin` command described in [connections](../../references/connections.md). Provide JSON payloads
through private files. Tokens remain file references, and secret-bearing responses are redacted.
Save audit logs privately for scoped inspection; avoid dumping arbitrary logs into chat.

## Upgrades

Inspect the deployed revision, dirty checkout, Compose overrides/systemd unit, active workloads,
and configuration first. Record the current revision and image IDs and preserve a rollback image
tag before replacing a locally built image. Select the user-requested revision; if none is specified,
resolve and report the repository's intended release before building. Preserve local edits; resolve
conflicts without resetting the checkout. Do not replace secrets or custom stacks.

Prepare the selected revision and validate its configuration/policies using existing scripts. Build
before restarting the controller. Recreate only the selected controller and requested infrastructure;
do not use an unscoped stop-all, volume prune, or Docker restart. Check health, rejection of absent
and invalid credentials, authenticated tool discovery, and native MCP reconnection after replacement.
Document the exact old revision/image and commands to restore the prior deployment. A failed check
does not authorize destroying workloads or repeating an uncertain mutation.

Report host, revision, configuration locations, changes, checks, and remaining prerequisites.
Installing this plugin or its local helpers does not authorize deploying/upgrading a controller.
