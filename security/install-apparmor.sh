#!/bin/bash
# Installs and loads CarapaBox AppArmor profiles into the kernel.
# Usage: sudo bash /workspace/security/install-apparmor.sh
#
# Profiles are copied to /etc/apparmor.d/containers/ and loaded
# via apparmor_parser. Docker references them by profile name
# (e.g. apparmor=carapabox-agent) in compose security_opt.
#
# To unload all profiles:
#   sudo apparmor_parser -R /etc/apparmor.d/containers/apparmor-*

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="/etc/apparmor.d/containers"
PROFILES=(apparmor-agent apparmor-web apparmor-database apparmor-proxy apparmor-controller)

# Check we're running as root
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: must run as root (use sudo)" >&2
  exit 1
fi

# Check apparmor_parser is available
if ! command -v apparmor_parser &>/dev/null; then
  echo "Error: apparmor_parser not found. Install with:" >&2
  echo "  apt install apparmor-utils" >&2
  exit 1
fi

# Create destination directory
mkdir -p "$DEST"

echo "Installing AppArmor profiles..."
for profile in "${PROFILES[@]}"; do
  src="$DIR/$profile"
  if [ ! -f "$src" ]; then
    echo "  ⚠  $profile not found, skipping"
    continue
  fi

  cp "$src" "$DEST/$profile"

  # Symlink into /etc/apparmor.d/ so the profile is auto-loaded on boot.
  # AppArmor's systemd service only loads from the top-level directory.
  ln -sf "$DEST/$profile" "/etc/apparmor.d/$profile"

  if apparmor_parser -r -W "$DEST/$profile" 2>&1; then
    echo "  ✅ $profile loaded"
  else
    echo "  ❌ $profile failed to load" >&2
    exit 1
  fi
done

echo ""
echo "Loaded profiles:"
aa-status 2>/dev/null | grep carapabox || echo "  (none found — check aa-status manually)"
echo ""
echo "Done. Restart containers to apply."
