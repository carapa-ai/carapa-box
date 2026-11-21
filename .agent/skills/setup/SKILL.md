---
name: setup
description: Install, configure, resume, or verify CarapaBox on its operator host. Use for container or host-mode installation, mount allowlists, controller authentication, ingress and egress proxies, relay prerequisites, and setup troubleshooting. Does not configure CarapaBoard project pipelines or launch arbitrary agent tasks.
---

# CarapaBox Setup

Take an authorized local CarapaBox checkout to a configured, authenticated
controller. Prefer the repository's hardened container deployment on Linux;
use host mode when the user wants development. Reuse existing build, security,
and service installers rather than maintaining a second implementation.

This skill is for an operator working on CarapaBox. Sandbox agents do not get
Docker access. If execution is inside an agent sandbox or the Docker control
boundary is unavailable, prepare and validate the configuration and give the
operator the exact remaining host commands; do not claim a deployment occurred.
A request to create or improve this skill does not authorize running an install.

## 1. Inspect and choose the installation scope

Run the bundled inspector from any CWD:

```bash
bash .agent/skills/setup/scripts/inspect-setup.sh --repo-root /absolute/path/to/carapa-box
```

It reads selected configuration and file metadata, never prints secret values,
and does not change files or contact Docker. Read the checkout's `README.md`,
`.env.example`, selected Compose files, `SECURITY.md`, and applicable instructions.
Current implementation wins when older setup prose disagrees with it.

Determine whether this is a fresh setup, an incomplete setup, or an existing
installation. Preserve existing tokens, stack definitions, provider configuration,
Compose overrides, and allowlist entries. Do not rerun a reset/reinstall path
just because a prerequisite is missing.

Resolve only missing decisions: container versus host mode, the controller port,
absolute stack/IPC/agent-home paths, and which providers or optional integrations
are actually needed. Use known configuration and prior user choices. Do not ask
for secret values in chat; use operator-owned files or the provider's auth flow.

## 2. Install missing host prerequisites

Read [references/prerequisites.md](references/prerequisites.md). On an Ubuntu or
Debian operator host, check first and install missing components when setup is
authorized:

```bash
bash .agent/skills/setup/scripts/install-prerequisites.sh --check
bash .agent/skills/setup/scripts/install-prerequisites.sh --install
```

Add `--mode host` for Bun/OPA development prerequisites. A failed check means
prerequisites are missing; it does not authorize removing a conflicting Docker
installation. Preserve the existing engine. Registry login, privileged profile
loading, daemon starts/restarts, and Docker-group access remain distinct steps.

## 3. Configure the selected mode

- **Container mode:** follow [references/container-install.md](references/container-install.md).
- **Host development mode:** follow [references/host-install.md](references/host-install.md).
- Read [references/security-and-relay.md](references/security-and-relay.md) before
  changing credentials, approved mount roots, network access, or relay clients.
- For ingress HTTP/SSH exposure or egress proxy operations, follow
  [references/proxies.md](references/proxies.md), including migration and recovery.

Make the needed local configuration concrete before requesting any missing
permission. Within an authorized installation, carry out ordinary preparation,
builds, startup, and checks without repeated approval. Explain the actual scope
before a required privileged operation. Docker daemon restarts, replacement of
existing secrets, broad ownership changes, and destruction of running workloads
are not implicit installation steps.

Do not disable AppArmor, seccomp, policy checks, or authentication to make setup
pass. Stop at the specific unsupported host prerequisite while completing
unaffected preparation. Keep host-nginx, Git/SSH, gVisor, and provider setup scoped
to the user's selected capabilities.

## 4. Verify the boundary

Use Docker only from the authorized operator host to inspect service state and
recent logs. Run the bundled HTTP smoke check against the configured controller:

```bash
bash .agent/skills/setup/scripts/check-controller.sh \
  --url http://127.0.0.1:3100 \
  --token-file /absolute/path/to/secrets/carapa_box_api_token \
  --admin-token-file /absolute/path/to/secrets/carapa_box_admin_token
```

It verifies CarapaBox health, rejection of missing and invalid API tokens, an authenticated tool listing, and separation between API and admin access. It never launches a stack or executes an agent tool.
A healthy process alone is insufficient: if unauthenticated API access succeeds,
setup fails. The check takes a secret-file path, not a token argument, and does
not print response bodies or credentials on failure.

For ingress, verify the lease and the selected HTTP/SSH route from an approved client.
For egress and relay use, verify the selected destination/provider/client route separately. For an
agent stack, validate its approved mounts, compiled policy, credentials boundary,
and image first; launch a disposable instance only if that smoke test is within
the user's scope. Do not claim agent, provider, or egress isolation coverage from
the controller HTTP check alone.

## 5. Report and hand off

Report the selected mode, controller URL, configuration/secret file locations
(without values), enabled optional features, checks actually run, and remaining
prerequisites. Include exact commands for unfinished host actions. Configuration
changes remain uncommitted unless the user requested a commit.

Shared project skills remain owned by CarapaBoard's setup bundle. When installing
Board alongside Box, use Board's setup skill and synchronization helper for
`AGENT_HOME`; do not create another canonical copy of its distributed skills here.
