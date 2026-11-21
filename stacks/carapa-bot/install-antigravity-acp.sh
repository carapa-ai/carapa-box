#!/bin/sh
# Explicit setup only. Installs Google's official Antigravity CLI release (its `acp`
# command is the ACP server). harness/install.py resolves the release and passes the
# SHA-256 GitHub publishes for it; the archive is verified before extraction.
set -eu
version=${ANTIGRAVITY_ACP_VERSION:?release tag required}
archive_sha=${ANTIGRAVITY_ACP_SHA256:?archive SHA-256 required}
case "$(uname -m)" in
  x86_64) archive_arch=linux_x64 ;;
  aarch64|arm64) archive_arch=linux_arm64 ;;
  *) echo "Antigravity ACP: unsupported architecture" >&2; exit 1 ;;
esac
destination=${ANTIGRAVITY_ACP_DESTINATION:-/opt/carapa-harness/antigravity-acp}
[ ! -e "$destination" ] || { echo "Refusing to overwrite an installed ACP runtime" >&2; exit 1; }
install_tmp=$(mktemp -d)
trap 'rm -rf "$install_tmp"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  "https://github.com/google-antigravity/antigravity-cli/releases/download/$version/agy_cli_$archive_arch.tar.gz" \
  --output "$install_tmp/runtime.tar.gz"
printf '%s  %s\n' "$archive_sha" "$install_tmp/runtime.tar.gz" | sha256sum --check --status
mkdir "$install_tmp/payload"
# Extract only the expected regular output, never archive-provided paths.
tar -xzOf "$install_tmp/runtime.tar.gz" antigravity > "$install_tmp/payload/antigravity"
test -s "$install_tmp/payload/antigravity"
chmod 755 "$install_tmp/payload/antigravity"
mkdir -p "$(dirname "$destination")"
mv "$install_tmp/payload" "$destination"
