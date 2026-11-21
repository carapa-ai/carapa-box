---
name: sandboxes
description: Manage sandboxes on connected local or remote CarapaBox controllers using native MCP tools. Use for lifecycle, logs, approved execution, Git/worktrees, SSH, HTTP ingress endpoints, and egress policy inspection.
---

# Manage CarapaBox sandboxes

Resolve the intended controller from the user's request, established task context, and named
native MCP connections. When multiple hosts match an ambiguous mutation, ask which host.
Keep the controller server name distinct from the sandbox `instance`/Compose project name.
Use that server's tool namespace consistently, even when another host has a sandbox with the same name.

Discover the selected server's tools and schemas. Call its native `sandbox_*` tools directly;
there is no gateway or generic plugin invocation tool. Optional Git, issue, web search, and tmux
capabilities depend on that controller's configuration. Do not infer availability from another host.

Inspect approved stacks and current instances before creating or stopping workloads. Use the
existing instance name when continuing work. Sandbox repository and mount paths belong to the
controller host; a remote operation does not upload the operator's local checkout.

For a new sandbox, follow [creation setup](../../references/sandbox-creation.md) before
`sandbox_start`. Resolve the stack template, instance name, required inputs and permitted host
directories first. Ask for project/data folders in user-facing terms, with concrete choices when
known, rather than exposing environment-variable names or discovering prerequisites by repeated
start attempts. Read-only operator inspection can establish these prerequisites; lifecycle and
workload execution still use this controller's native MCP tools.

On a mount denial, inspect the effective allowlist and map any container configuration path to its
host source. Propose the exact required directories or verified allowed alternatives. Never suggest
allowing the operator's entire home, and do not change the user's chosen folders silently. Route
required configuration work through the operator skill and complete authorized preparation.

Use policy inspection and available-command tools when an execution fails authorization.
`sandbox_exec` runs trusted stack/image tools, not an unrestricted shell. Do not work around a
policy denial with Docker or SSH into the workload. Use the operator skill only for requested
administration of the controller host or its approved stack configuration.

Preserve the native result/error and report the controller and sandbox in the outcome. Use bounded
logs. Do not automatically replay a mutation after a connection loss: inspect the intended host's
state first because the original operation may have completed. Never silently fall back to a
different controller or launch another controller process through the legacy local CLI.

For tmux, keep every follow-up on the originating controller and MCP session. Do not turn optional
feature flags on merely to satisfy discovery. Connection setup is handled by the connect skill;
host installation/upgrades are handled by the operator skill.

For HTTP access, use `sandbox_ps` results: prefer the reported nginx `url`/`urls` for browser
links and use the `ingress` entries for published service endpoints. For SSH, discover and use
`sandbox_ssh` with `status`, `start`, or `stop`; report its returned command after successful
start. With ingress enabled, use its public `host` and reserved `port`, not `internalHost` or
the service's internal port 2222. Check result errors and route readiness before claiming access.
Without ingress, do not imply that an internal endpoint is reachable from a remote client.

When the user requests external access to a new app port, discover
`sandbox_publish_app`. Use a stable publication `id` with the selected stack
`name` and `instance`; `action: publish` also takes `service`, `targetPort`, and
an optional `hostname`. The app must already listen on a reachable container
interface, normally `0.0.0.0`. This works on agent-only stacks with migrated
ingress, without adding Compose ports or a project nginx container. Use
`action: status` to inspect the exact returned URL and `action: unpublish` to
revoke it. Readiness confirms ingress acknowledgement, not application health,
DNS, TLS, or internet reachability. Verify from an authorized client network;
ingress deliberately denies sandbox-origin traffic. Publication does not start
the app, provision DNS/certificates, or add Board authentication. For Board-managed
projects, prefer Board's project-scoped publishing tools or External app access
settings so Board retains the configuration and sandbox binding.

Ingress provisioning or migration and egress policy/relay changes belong to the operator
workflow in [proxy operations](../../references/setup/references/proxies.md). Inspect effective
configuration when access fails; do not publish extra sandbox ports or broaden allowlists as
a workaround. Use the selected server's `sandbox_network_policy_reload` after an authorized
network policy change, and verify application of the change separately from execution policy.
