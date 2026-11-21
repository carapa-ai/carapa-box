# Private installation data

Keep installation data outside repositories mounted into development sandboxes.
Versioned examples and policy source remain in the checkout; live operator files
and stable reservations belong to the operator's private installation directory.

```
~/.carapa-box/
  .env
  config/
    mount-allowlist.yaml
    managed-services.yaml
    policies/
      network-base.yaml
      base.wasm
  state/                 # Generated Squid config, network reservations, audit, and relay-tokens.json (directly in the state root)
  ingress/               # Durable ingress reservations and resolved Compose models
```

Set these host settings in the installation `.env` (use absolute paths):

```dotenv
CARAPA_BOX_HOME=/home/youruser/.carapa-box
CARAPA_BOX_ENV_FILE=/home/youruser/.carapa-box/.env
CARAPA_BOX_CONFIG_HOST_DIR=/home/youruser/.carapa-box/config
CARAPA_BOX_STATE_HOST_DIR=/home/youruser/.carapa-box/state
INGRESS_STATE_HOST_DIR=/home/youruser/.carapa-box/ingress
```

A repository `.env` symlink to that private file preserves plain `docker compose`
commands. A development sandbox mounting only the repository cannot follow that
host-only symlink. The installation directory must not itself be sandbox-mounted.
Keep its permissions at 0700 and the `.env` at 0600.

Container mode retains `/app/config` (read-only), `/app/generated` (writable), and
`/app/ingress` (writable). The proxy sees only ingress `runtime`, read-only. Host
mode resolves configuration and generated state from `CARAPA_BOX_HOME`; explicit
`CARAPA_BOX_CONFIG_DIR` and `CARAPA_BOX_STATE_DIR` override those locations.
Without private-directory settings, development retains repository-local defaults.

Set the same `CARAPA_BOX_STATE_HOST_DIR` in `egress-proxy/.env` so independently
started Squid mounts the controller's generated config. Its other deployment
settings and the external nginx routes stay in their existing locations. Secrets
may stay in the existing private secret store; migration must not rotate tokens.

Builds still compile versioned policy source in the repository. `build.sh` also
installs the resulting base WASM policy into the live config directory resolved by
Compose (requires Python 3). Operator network rules and allowlists are not replaced.

## Operator-only deployment directory

Compose trusts every file in the directory it runs in: `docker-compose.yml`,
discovered overrides, and `.env`, which can set `COMPOSE_FILE` and every
`${VAR}` used in mounts. When agents edit this checkout, run the controller from
a private directory instead (the CarapaBoard quick installer uses
`~/.carapa/deploy/carapa-box`):

- Copy `docker-compose.yml` there unchanged and keep the `.env` beside it.
  Re-copy and review after updating the checkout; never `include` or `extends`
  checkout files.
- Set `CARAPA_BOX_SOURCE_DIR` to the checkout. It replaces every `./` path:
  the build contexts, read-only source mounts, and the defaults of the data
  directories above.
- Set `CARAPA_BOX_SECCOMP_DIR` to private copies of `security/seccomp-*.json`.
- Build with `CARAPA_BOX_DEPLOY_DIR=<dir> bash build.sh` so Compose reads the
  private files, then run `docker compose up -d` in that directory.

The controller starts and auto-recreates the egress proxy and runs its
`before-start.sh` hook inside the controller, so the egress Compose project
needs the same protection:

- Copy `egress-proxy/docker-compose.yml`, `before-start.sh`, `squid.conf`,
  `squid-entrypoint.sh`, `policy.rego` and your `tool_profiles.jsonc` into a
  private directory beside the private `security/` directory, and move
  `egress-proxy/.env` there.
- In that `.env`, set `EGRESS_SOURCE_DIR` to the checkout's `egress-proxy`
  (image build contexts and the live service code) and `EGRESS_CONFIG_DIR` to
  the private directory, both as host paths.
- In the controller `.env`, set `CARAPA_BOX_EGRESS_DEPLOY_DIR` to the private
  directory and `CARAPA_BOX_SECCOMP_DIR` to the private `security/`. Compose
  mounts them at `/app/egress-deploy` and `/app/security` (the controller
  AppArmor profile reads only under `/app`), so `../security/seccomp-*.json`
  resolves to the private profiles on the host and in the controller. Code-hash
  auto-recreation and the provider-login helper keep reading the checkout
  (`SANDBOX_EGRESS_PROXY_CODE_DIR`).
- Copy compose changes into the private directory by hand after updating the
  checkout. At startup the controller compares the checkout's and the private
  `docker-compose.yml` for `api-relay`, `llama-proxy` and `squid`, and logs
  `deploy compose drift` warnings when the private copy lacks volumes,
  environment keys or services present in the checkout. `/api/admin/info`
  shows them as `egress_proxy.deploy_drift`. It never edits your file.
- Build the egress images with
  `CARAPA_EGRESS_DEPLOY_DIR=<dir> sh egress-proxy/build.sh`. `build.sh` and
  `before-start.sh` create the secret placeholders in the `SECRETS_DIR` set in
  the `.env` beside the Compose file they use (quotes are stripped), unless
  `SECRETS_DIR` is already in the environment; `build.sh` with
  `CARAPA_BOX_DEPLOY_DIR` compiles the egress policy into the private directory.

For migration, stop the controller before copying generated state, preserve every
reservation and token file, then recreate the controller and Squid using the new
mounts. Restore Squid's existing internal-network addresses after its recreation.
Back up configuration privately and verify ingress reservation hashes and service
health before removing the former live files from the checkout. Ingress state
can remain at its existing private path throughout the migration.
