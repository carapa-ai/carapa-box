# Host development installation

Use [prerequisites.md](prerequisites.md) to install missing host tools on Ubuntu or Debian before continuing.

Use host mode when the user explicitly wants a local CarapaBox process for
development. Docker still belongs only to CarapaBox's operator host. Host mode
requires Bun and the OPA CLI as well as Docker/Compose for sandbox operations.

1. Inspect existing `.env`, the selected port, and whether a container or systemd
   service already owns it. Do not start a second controller against the same
   port or stop an existing deployment without that being in the user's scope.
2. Install dependencies with `bun install --frozen-lockfile` and run
   `bun run bundle` when the bundled CLI is needed. If the lockfile fails,
   report the discrepancy instead of regenerating dependencies during setup.
3. Provision the separate Box API and admin tokens using the bundled secret helper, configure
   their directory via `SECRETS_DIR` in `.env`, and configure the selected
   `SANDBOX_STACKS_DIR`, audit location, and `config/mount-allowlist.yaml` as
   described in `security-and-relay.md`. Mount mapping variables such as
   `SANDBOX_HOST_DIR` describe containerized controller translation; do not
   blindly carry container-only path mappings into a host process.
4. Compile policies for the selected directory:

   ```bash
   bash scripts/compile-policies.sh --stacks-dir /absolute/path/to/stacks
   ```

5. Run `bun run start:http` from the repository root in a persistent terminal.
   Use `bun run dev:http` only when watch mode is wanted. Run the bundled
   authenticated controller check against its configured port.

For a systemd user service, inspect `install-service.sh` first and run it from
this repository only when persistent service installation is requested. It writes
and enables `~/.config/systemd/user/carapa-box.service`; it does not start it.
Preserve any customized service before replacement. Then start the service with
`systemctl --user start carapa-box` and check bounded journal output.

The relay and sandbox infrastructure remain separate prerequisites for actual
agent runs. Follow the container reference's egress setup and the selected
provider guide when needed. A host HTTP smoke check alone does not validate them.
For ingress, use [proxy operations](proxies.md): run its Compose service alongside
the persistent host controller, with the same private state directory and port pool.
