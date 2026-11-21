# Ingress and egress operations

Use this guide for proxy installation, configuration, upgrades, recovery, and
sandbox connectivity problems on the selected controller host. Inspect that
host's current `docs/ingress.md`, root Compose, `egress-proxy/docker-compose.yml`,
overrides, and deployed revision before applying commands. Older controllers
may not support ingress. Run host administration locally or through the selected
SSH alias; sandbox lifecycle and approved execution use that controller's native tools.

| Component | Purpose | Configuration and control |
| --- | --- | --- |
| Ingress | Approved clients reach sandbox HTTP/SSH endpoints | Root Compose `ingress` profile; controller `INGRESS_*` settings and private state |
| External nginx | HTTPS, hostnames, certificates, WebSockets and streaming | Existing nginx deployment plus controller `NGINX_PROXY_*` settings |
| Egress Squid | Sandbox outbound domain allowlists | `config/policies/network-base.yaml`, selected stack `network-policy.yaml`, generated Squid config |
| Egress API relay | Selected provider routes and credential injection | Egress `.env`, effective relay-client directory, provider accounts and secret-file references |
| Egress llama-proxy | Access to host LLM endpoints and tool profiles | Egress Compose and `tool_profiles.jsonc` |

The plugin's direct MCP connection authenticates to the controller. Neither proxy
is an MCP gateway. Controller SSH tunnels and sandbox SSH ingress are separate
resources. Keep the admin token in the controller/operator boundary; ingress
requires no credentials or Docker socket, and relay clients receive only their
required credentials, never the admin token.

## Enable or change ingress

Ingress is opt-in. It requires a persistent HTTP controller refreshing route
leases; a temporary CLI process cannot replace it. Run one reconciler per private
state directory. Confirm the deployed feature before recommending migration.

1. Inspect active workloads, existing nginx routes, host port bindings, Docker
   subnets and the requested client access. Choose `INGRESS_PUBLIC_HOST` as the
   Docker host's reachable IPv4 address or DNS name. Inspect separate
   `INGRESS_HTTP_ALLOW_CIDRS` and `INGRESS_SSH_ALLOW_CIDRS`: use approved sources
   as seen by the proxy, accounting for Docker NAT. Both must be explicit. Agent
   subnets and published sandbox networks are denied before these allowlists.
   Do not resolve a denial with `0.0.0.0/0` or an added sandbox network.
2. Configure `ENABLE_INGRESS_PROXY`, a free `INGRESS_EDGE_SUBNET`/`INGRESS_EDGE_IP`,
   `INGRESS_PUBLISH_IP`, and a matching `INGRESS_PORT_START`/`INGRESS_PORT_END`
   in controller and proxy (default pool 22000–22255). Publication defaults to
   all host IPv4 interfaces; preserve the operator's exposure choice and verify
   nginx can reach the selected binding. IPv6 ingress is unsupported.
3. Set `INGRESS_STATE_HOST_DIR` to a real absolute operator-private directory
   outside every sandbox mount, including source checkouts mounted in sandboxes.
   Create its `runtime` subdirectory; ensure the controller UID can write state
   and the proxy UID can read the runtime snapshot. Container mode maps state
   to `/app/ingress`; host mode uses the host path via `INGRESS_STATE_DIR` or
   `INGRESS_STATE_HOST_DIR`. Only `runtime` is mounted read-only in the proxy.
   Keep sibling `compose` files private: they contain resolved environments.
4. Validate root Compose with `docker compose --profile ingress config --quiet`.
   Load the checkout's updated AppArmor profiles using the existing installer;
   older controller profiles can deny state writes and port-reservation links.
   Build the ingress image and updated controller before replacement. In container
   mode, start/recreate only the selected `ingress-proxy` and `carapa-box` services
   with the `ingress` profile. In host mode, run only the proxy Compose service
   alongside the selected persistent HTTP process. Preserve seccomp, read-only
   mounts, dropped capabilities, and disabled IP forwarding.
5. Migrate only selected sandboxes through their normal stop/start workflow when
   that interruption is in scope. Migration resolves Compose into private state,
   removes direct port publishing and `portonly`, and retains source stacks
   unchanged, including read-only custom stack directories. Other non-internal
   networks, IPv6 networks, non-TCP publications and unsupported privileged or
   `network_mode` services require operator resolution; do not bypass refusal.
6. For browser access, preserve existing nginx HTTPS and hostname configuration.
   `ENABLE_NGINX_PROXY` controls generated nginx routes. Extra HTTP targets must
   have published ports declared in the source Compose model. Query `sandbox_ps`
   for `url`/`urls` and its `ingress` endpoints; do not discover migrated endpoints
   with `docker port`. Enable sandbox SSH with `sandbox_ssh`, then use the returned
   `host`, `port`, and `command`. `internalHost` is diagnostic, not a LAN endpoint.

Verify a fresh lease and route acknowledgement using proxy health,
`/run/ingress-status.json`, bounded controller/proxy logs and native sandbox status.
Check the intended hostname/HTTP route or SSH command from an approved client.
A healthy lease with no routes does not prove a sandbox is reachable. Check a
denied source and revocation when an authorized disposable test permits it;
report LAN access unverified if no client on that network was tested.

Missing or expired snapshots close existing sessions and reject new connections
(currently 45-second leases); discovery failure clears routes immediately.
For unavailable routes, inspect the controller, lease, private directory mapping,
proxy edge IP, source CIDRs, backend health and internal network attachments.
Port conflicts require fixing the chosen binding or configuration, not a silent
alternative port. Proxy recreation is repaired by controller reconciliation;
verify acknowledgement before reporting recovery. Never hand-edit runtime snapshots.

Back up private ingress state and preserve `ports` reservations, even for deleted
sandboxes. Ports are not recycled: old SSH commands must not reach other workloads.
If exhausted, extend the pool consistently and recreate the proxy without excluding
existing reservations. For rollback, follow the selected revision's ingress guide:
stop the selected project, disable controller ingress, remove only its generated
`compose/<project>.json`, and restart from its source stack. Disabling ingress is
controller-wide and affects other published workloads; account for them first.
Retain other projects' generated files and all reservations.

## Configure or recover egress

Follow [container installation](container-install.md) for bind sources, service
UIDs, build scripts and optional secret placeholders; follow
[security and relay](security-and-relay.md) for provider onboarding. Inspect
actual client configs: older egress README examples describe obsolete agent
`sandbox-relay` access. Do not add a controller route to an agent client.

Use the egress directory's own `.env` and Compose overrides. Its project name is
`egress-proxy`; inspect and target its `squid`, `api-relay`, or `llama-proxy` service,
for example `(cd /selected/checkout/egress-proxy && docker compose -p egress-proxy ps)`.
The controller attempts auto-start, but that is not proof of health. These services
are shared by sandboxes: account for active traffic before replacement. Start only
missing required services; avoid project-wide `down` for a single proxy repair.

Edit the effective host policy source, not generated Squid configuration or a
read-only container mount. Current network allowlists use YAML, despite some older
tool descriptions mentioning Rego. Discover and use `sandbox_network_policy_reload`
on the selected server to regenerate and apply Squid ACLs. Check its result: writing
config without a successful Squid reconfigure does not prove the policy is active.
It does not touch command (execution) policies: the old `sandbox_policy_reload` tool
was removed in 0.1.0. A recompiled `policy.wasm` is picked up automatically, because
the loaded bundle is cached by file modification time.

Preserve unrelated domains, provider routes, OAuth files and local model profiles.
Use the selected component's documented reload mechanism (llama tool profiles accept
SIGHUP); code, dependencies, environment and mount changes may instead need a scoped
restart, rebuild or recreation. Inspect the deployed code before choosing. Recheck
per-instance internal network attachments after service recreation; let CarapaBox
manage them rather than giving a sandbox host networking or a direct internet path.

Verify an approved destination through Squid and a denied destination using approved
sandbox tools or an authorized disposable fixture. Check the selected provider/model
through its actual relay route, keeping credentials and capture contents out of chat.
Separate domain denial, missing client route, provider authentication failure and
local-model reachability. A controller health check or successful ingress request
does not validate outbound access or credential isolation.
