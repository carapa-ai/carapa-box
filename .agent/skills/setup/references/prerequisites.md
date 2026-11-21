# Host prerequisites

The Bash installer supports Ubuntu and Debian operator hosts. It defaults to a
read-only tool/package check and never installs Python. Run it as the normal
operator account; it uses sudo only for apt and system repository files.

```bash
bash .agent/skills/setup/scripts/install-prerequisites.sh --check
bash .agent/skills/setup/scripts/install-prerequisites.sh --install
```

Use `--mode host` on either command for direct Bun-based development. Container
mode installs missing Docker Engine, Compose/Buildx plugins, AppArmor tools,
curl, Git, OpenSSL, and CA certificates. Host mode adds Bun, OPA, and unzip for
the Bun installer. Already-present tools are reused without automatic upgrades.
The check reports missing prerequisites with a nonzero exit status.

For a fresh Docker installation, the script adds Docker's signed apt repository
using OS-owned distribution metadata and installs the official packages.
Conflicting distro packages are reported, not uninstalled. If Docker already
exists, missing plugins are requested from its existing apt sources using the
names that match its engine: `docker-compose-plugin`/`docker-buildx-plugin` for
Docker CE (`docker-ce-cli`), `docker-compose-v2`/`docker-buildx` for distro
`docker.io`. If the engine is neither, or apt has no candidate for the matching
package (for example an older release without `docker-buildx`), the script exits
with guidance before installing anything; install Compose v2/Buildx manually or
reconcile that installation, not switching engines or removing packages.
Apt is invoked with `--no-upgrade --no-remove`; there is no general system upgrade.
Installation follows Docker's [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
and [Debian](https://docs.docker.com/engine/install/debian/) repository guidance.

Bun is installed with its [official installer](https://bun.com/docs/installation)
as the invoking user. OPA uses the version matching this repository's `build.sh`
default (`v1.14.1`), with an optional `OPA_VERSION=vX.Y.Z` override. The downloaded
OPA binary is checked against its published SHA-256 before installation, following
[OPA installation guidance](https://www.openpolicyagent.org/docs). Host OPA binary
installation supports amd64 and arm64. Add `~/.bun/bin` and `~/.local/bin` to PATH
in future shells if they are not already present.

Package installation may start a newly installed Docker daemon. The script does
not explicitly restart Docker, edit daemon settings, add group members, load
CarapaBox AppArmor profiles, install gVisor, start CarapaBox stacks, or authenticate
to image registries. It refuses installation inside a container. No-op/check
runs do not need sudo or network access.

After installation, verify `docker info` as the actual operator. If the daemon
is stopped or permissions are missing, resolve that separately; choose whether
the operator should receive Docker-group privileges and arrange a new login as
needed. Then run `docker login dhi.io`, load repository AppArmor profiles during
setup, and verify the selected Compose configuration. Installed AppArmor tooling
does not establish that the host kernel supports or enables AppArmor.

On other distributions or operating systems, install prerequisites using the
supported vendor instructions and continue the mode-specific setup manually.
Do not weaken the repository's hardening to bypass an unsupported host.
