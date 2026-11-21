# CarapaBox for Codex

Manage multiple local and remote Linux CarapaBox controllers using direct native MCP connections.
The plugin adds connection, sandbox, and operator skills. It runs no gateway and bundles no MCP
server: each controller remains a named server in your own Codex configuration.

## Install

From a CarapaBox checkout:

```bash
bun run plugin:build
codex plugin marketplace add /absolute/path/to/carapa-box
codex plugin add carapa-box@personal
```

The repository marketplace is named `personal` by the scaffold; its absolute location distinguishes
it from any user marketplace. Inspect the repository marketplace name before installation if it
has been customized. Start a new Codex task to pick up the skills. Do not edit installed cache files.

Follow [connection setup](references/connections.md) to install stable helpers, provision local
credential-file references, and register controllers. No controller or tunnel starts during plugin
installation. Supports Linux/WSL operators with Python 3.11+; SSH tunnels require a systemd user
manager and OpenSSH. HTTPS connections do not require systemd. Python is needed only on the
machine running these Codex connection helpers; remote CarapaBox hosts do not need Python.

Example requests: “Connect my local and production CarapaBox hosts”, “List sandboxes on production”,
“Create a disposable instance on local”, or “Upgrade the controller on private-box”. Host operations
use existing CarapaBox scripts through local shell or SSH. Sandbox operations use native MCP tools.

The operator and setup skills cover both [ingress and egress proxies](references/setup/references/proxies.md):
HTTP/SSH publication and migration, nginx integration, outbound domain policies, provider relays,
upgrades and recovery. Try “Configure ingress for sandbox web and SSH access on local” or
“Diagnose the egress proxy on production”. Proxy configuration remains on the selected host;
installing the plugin does not enable either proxy or migrate running sandboxes.

## Development and distribution

`scripts/package-plugin.py` synchronizes the canonical `.agent/skills/setup` resources into
`references/setup`. Edit the canonical originals, then rebuild; do not maintain generated copies
independently. `--output /new/directory/carapa-box` exports the complete plugin for installation
outside this checkout. The source checkout is not required to load its skills or install helpers.
An operator checkout on the selected controller host is needed for controller builds/upgrades.

Run `bun run plugin:test` for helper/packaging tests and `bun run plugin:test:docker` for explicit
Docker integration tests. Docker tests use two disposable nested daemons and separate stack trees;
they never mount the host Docker socket into a controller or access operator stacks. Test image
downloads/builds are confined to test resources. The suite cleans up its named containers/volumes.

The Docker suite needs cached `carapa-box:latest` and `alpine:latest` images, `docker:29.4.3-dind`,
the repository's `.cache/opa/opa` compiler, and a systemd user manager. Set
`CARAPA_PLUGIN_CONTROLLER_IMAGE`, `CARAPA_PLUGIN_DIND_IMAGE`, or `CARAPA_PLUGIN_OPA` for alternative
test artifacts. It bundles the current controller source into the cached runtime image, tests two
separate Docker daemons, and creates only uniquely named temporary tunnel services. The optional
suite needs privilege to run nested Docker; it never installs a production controller.

Plugin removal does not remove native MCP registrations, token files, or persistent SSH tunnels.
See the connection guide for targeted cleanup.
