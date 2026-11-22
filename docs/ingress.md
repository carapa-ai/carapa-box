# Shared sandbox ingress

CarapaBox can provide one dedicated ingress container for all sandbox HTTP and
SSH endpoints. Existing external nginx continues to own hostnames, certificates,
HTTP headers, WebSocket upgrades, and streaming. Ingress forwards TCP bytes to
the approved service inside each sandbox's internal network:

```
Browser → existing nginx (HTTPS) → host:reserved-port → ingress → stack nginx
SSH client                     → host:reserved-port → ingress → sandbox:2222
```

Each published service/target-port pair receives its own stable ingress port.
HTTP and SSH share one operator-configured port pool (22000–22255 by default).
This avoids another HTTP parser and retains all existing nginx behavior.
Stack nginx remains responsible for PHP, static files, and internal worktree
previews. Internal preview addresses do not change.

## Security boundary

- The proxy has no Docker socket, controller credential, provider secret, or
  writable access to its configuration. It runs as UID 65532 with all capabilities
  dropped, a read-only root filesystem, seccomp and AppArmor.
- Listeners bind only to its fixed edge-network IPv4 address. IPv4/IPv6 forwarding
  is explicitly disabled. IPv6 ingress is not supported in this version.
- HTTP sources must match `INGRESS_HTTP_ALLOW_CIDRS`; SSH sources must match
  `INGRESS_SSH_ALLOW_CIDRS`. Every known agent subnet and every network attached
  to the published sandbox is denied **before** those allowlists are considered.
  Use exact nginx/trusted-client addresses where possible; do not use `0.0.0.0/0`.
- The controller refuses routes for projects that still publish container ports
  directly or attach to any non-internal/IPv6 network. It verifies Compose project
  and service ownership. Managed SSH preserves the approved stack's runtime,
  including GPU runtimes such as `nvidia`.
- Backend connections bind to the proxy's address on that project's internal
  network. Docker DNS must resolve the selected container name to the inspected
  IP for every new connection. Changed container identity or configuration closes
  existing forwarded connections. SSH keys and authentication remain in Dropbear.
- A route snapshot expires after 45 seconds. The persistent HTTP controller
  refreshes it every two seconds; the proxy checks it every 500 ms. Missing,
  malformed, or expired configuration closes established sessions and rejects
  new connections. Discovery failure publishes an empty snapshot immediately.
  An isolated proxy restart can restore a still-valid snapshot; recreation is
  repaired by the controller attaching it to the necessary internal networks.

The shared ingress process can reach its connected backends: compromising that
process has a broader impact than compromising one sandbox. The design restricts
normal ingress traffic; it does not claim isolation after proxy compromise.

## Enable and migrate

This is opt-in and requires the persistent CarapaBox HTTP controller. A standalone
CLI process cannot maintain route leases. It can request changes while that
controller is running. Run only one ingress reconciler for one private state
directory. Host-mode controllers are supported with the proxy Compose service
running alongside them.

1. Configure the following in CarapaBox's installation `.env` (addresses below are examples). See [private installation data](installation-data.md) for keeping this file and live config outside the checkout:

   ```dotenv
   ENABLE_INGRESS_PROXY=true
   INGRESS_STATE_HOST_DIR=/home/youruser/.carapa-box/ingress
   INGRESS_PUBLIC_HOST=192.168.1.10
   INGRESS_HTTP_ALLOW_CIDRS=172.18.0.7/32
   INGRESS_SSH_ALLOW_CIDRS=192.168.1.0/24
   INGRESS_PUBLISH_IP=0.0.0.0
   INGRESS_EDGE_SUBNET=172.29.255.0/28
   INGRESS_EDGE_IP=172.29.255.2
   INGRESS_PORT_START=22000
   INGRESS_PORT_END=22255
   ENABLE_NGINX_PROXY=true
   ```

   Use a real, operator-private host directory for `INGRESS_STATE_HOST_DIR`,
   outside every sandbox bind mount (including the CarapaBox source repository).
   The controller only detects overlap with plain bind mounts. Allowlisted
   sandbox mounts are pinned as named Docker volumes, which this check cannot
   see, so you must keep the directory outside every `mount-allowlist.yaml`
   base yourself. Container mode mounts it at `/app/ingress`; host mode uses
   that host directory directly. Do not point it through a symlink into a sandbox
   workspace.

   `INGRESS_PUBLIC_HOST` is the Docker host's LAN address or DNS name, never a
   container address. HTTP sources are the addresses nginx/trusted HTTP clients
   have **as seen by ingress**, which may differ with Docker NAT. If other approved
   services access a published application directly, include their source addresses.
   Keep these allowlists separate from sandbox networks. Choose a free edge subnet
   and port range. Docker rejects conflicting bindings; ingress never falls back
   to a wildcard listener or another port. Publish on a specific host IPv4 address
   if desired, ensuring existing nginx can reach that address. Existing nginx
   routes still use `host.docker.internal`, so the default all-IPv4 host binding
   preserves that path; application allowlists restrict who can enter it.

2. Ensure the generated directory belongs to the controller user, then build and
   start the profile from the CarapaBox repository:

   ```bash
   mkdir -p /home/youruser/.carapa-box/ingress/runtime
   chmod 700 /home/youruser/.carapa-box/ingress
   sudo bash security/install-apparmor.sh
   docker compose --profile ingress up -d --build ingress-proxy carapa-box
   ```

   The proxy stays closed until it receives a valid controller snapshot. Existing
   sandboxes keep their current network attachments until individually recreated.
   Existing installations must reload the updated controller AppArmor profile:
   it grants writes and atomic port-reservation links under `/app/ingress`.

3. Recreate each selected sandbox through the normal CarapaBox stop/start flow.
   CarapaBox resolves the complete Compose configuration, including overrides and
   environment files, then writes a private generated model. It removes `ports`
   and `portonly` from services, removes the `portonly` network definition, and
   attaches published service targets to the per-instance internal network.
   Source stack files are not rewritten. This works with custom stack
   directories mounted read-only in the controller.

   Non-TCP publications and `network_mode`/privileged services are refused rather
   than silently discarded. Other external networks must themselves be internal;
   ingress will report failure instead of exposing a project with a bypass.
   Network aliases, static agent addresses, mounts, runtime hardening, and service
   environments are preserved, including Compose's existing escapes for literal
   dollar signs when the generated configuration is read again.

   If containerized nginx reaches published ports through Docker's userland proxy,
   ingress may see the shared edge gateway instead of nginx's approved address.
   Do not allow that gateway: it also represents other forwarded clients. Attach
   trusted nginx to the external `carapa_ingress_edge` network with a reserved
   static address (for example `172.29.255.3`), add only that `/32` to
   `INGRESS_HTTP_ALLOW_CIDRS`, and set `NGINX_PROXY_INGRESS_HOST=172.29.255.2`
   to match `INGRESS_EDGE_IP`. Persist the attachment in nginx's own Compose
   configuration. This setting applies to ingress routes. A sandbox without
   an ingress Compose model gets no route while ingress is enabled; with ingress
   disabled, routes use published ports on `host.docker.internal`. Never attach sandbox
   services to the edge network. Recreate the controller after environment
   changes. The controller regenerates nginx routes in the background on startup
   and every 60 seconds; sandbox starts and alias changes update them immediately.
   `sandbox_ps` reads registered routes without regenerating them.

4. Existing nginx routes are regenerated to use ingress's reserved ports. Primary
   domains, aliases and `nginx-proxy-routes.json` extra routes continue to work.
   Extra HTTP targets must be declared as published ports in the source Compose
   model (as required by the previous routing mechanism). Retired targets are no
   longer forwarded even though their port reservations remain.

5. Enable SSH through the normal sandbox SSH control. Its response now returns
   the LAN `host`, reserved `port`, and ready-to-use `command`, with `ingress: true`
   and `internalHost` for diagnostics. A successful start waits for the proxy to
   acknowledge the route. Disable kills sandbox SSH sessions and revokes ingress.
   Only an explicit enable publishes the route; a status refresh never reserves a
   port or publishes one, even when a daemon is running inside the sandbox.
   `sandbox_ps` also returns an `ingress` array with service/target/host/port entries.
   Custom hooks that discover endpoints using `docker port` must use this reported
   ingress information after migration; there are deliberately no sandbox port
   publications anymore.

## State, recovery, and rollback

`$INGRESS_STATE_HOST_DIR/ports` holds immutable reservations. They are never automatically
recycled, including after a sandbox is deleted: an old SSH command must not connect
to a different sandbox. If the range fills, extend it in both controller and proxy
configuration and recreate the proxy. Existing reservations cannot be excluded.
Back up the private ingress directory with the controller's state.

Only `$INGRESS_STATE_HOST_DIR/runtime` is mounted in ingress, read-only. Its snapshot
contains addresses and route metadata. The sibling `compose` directory contains
resolved environments and is private (files mode 0600); do not mount it into a
sandbox or ingress. Proxy status is in `/run/ingress-status.json`; its Docker health
check verifies the lease. Controller logs explain rejected routes.

To roll back a project, stop it through CarapaBox, disable ingress in the controller,
remove that project's `$INGRESS_STATE_HOST_DIR/compose/<project>.json`, then start from
the original stack. This restores the original port publishing and `portonly`
behavior, including its previous firewall requirements. Do not delete reservations
to reuse old SSH ports. Leave other projects' generated Compose files in place
until they are also intentionally rolled back.

## Verification

```
bun run typecheck
bun run test:ingress
bun run test:ingress:compose
docker build -t carapa-box-ingress:dev ingress-proxy
bun run test:ingress:docker
```

The Docker test creates uniquely named temporary edge/backend networks, a sandbox
fixture, a config writer and a proxy using the actual hardened image and profiles.
It checks published HTTP, SSH bytes, sandbox ingress denial, active-session
revocation, restart recovery and lease expiry, then removes its fixtures. It does
not modify or attach to any running production sandbox. LAN access from a second
physical host and existing nginx certificate/hostname configuration require a
deployment check on the operator's network.

## Publish an app port at runtime

`sandbox_publish_app` adds an HTTP target to an already migrated sandbox without
changing its approved Compose file or requiring a stack nginx service:

```json
{"name":"carapa-bot","instance":"demo","id":"web","action":"publish","service":"agent","targetPort":3000}
```

Start the app separately on `0.0.0.0:3000`. The controller validates service
ownership, reserves an ingress port, and waits for proxy acknowledgement. The
result contains `enabled`, `ready`, `targetPort`, `port`, `url`, and `ingressUrl`.
With nginx integration enabled it creates a separate generated HTTPS route;
otherwise `url` uses the configured ingress host and reserved HTTP port. Supply
`hostname` to choose a name covered by the installation's DNS and certificate.
The tool does not provision DNS, certificates, authentication, or app processes.
`ready` confirms routing only; verify the application from the intended network.
If a project later takes the publication's hostname, its route wins, and status
reports `routeMissing` with `ready: false` until the app is republished under
another hostname.

Use the same name, instance and ID with `action: "status"` to inspect it or
`action: "unpublish"` to disable it. Revocation waits for the ingress proxy to
remove the route. Configuration is persisted under the private ingress state
root. Enabled publications resume when their sandbox starts again; stopped
sandboxes have no live route. A failed publish disables its new intent. Retry a
failed revocation until acknowledged. Port reservations remain stable and are
never recycled. A target recorded under one publication ID cannot be claimed by
another ID. Static stack targets cannot be changed through this tool.

App ports must be 1024–65535, excluding managed SSH port 2222. All existing
network, ownership, lease, and source-CIDR checks still apply. Client access is
independent of Board login; publish only endpoints intended for those clients.
Sandbox networks remain denied, so an in-sandbox HTTP probe is not an external
reachability test. No host `ports:` mapping or additional container capability
is granted to the app.

Board exposes this through project settings and its project-scoped `publish_app`
and `get_published_app` tools. Board pins the stack, instance, service and
publication ID, and requires editor access to the owner of a shared sandbox.
