#!/bin/bash
# ── Install gVisor (runsc) as a Docker runtime ──────────────────────────
# Installs runsc, containerd-shim-runsc-v1 and gvisor-bin/ from Google's
# release tarball, after verifying its SHA-512 checksum. Safe to re-run to
# update (prints the previous and new version). Requires sudo for Docker
# daemon config + reload.
#
# Usage: sudo bash scripts/install-gvisor.sh
#        sudo GVISOR_RELEASE=YYYYMMDD.N bash scripts/install-gvisor.sh  # pin / roll back
#
# After install, use `runtime: runsc` in docker-compose.yml for any
# service that should run under gVisor isolation (typically agent containers).
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64)  ARCH="x86_64" ;;
    aarch64) ARCH="aarch64" ;;
    *)
        echo "Error: unsupported architecture: $ARCH"
        exit 1
        ;;
esac

GVISOR_RELEASE="${GVISOR_RELEASE:-latest}"
if [[ ! "$GVISOR_RELEASE" =~ ^(latest|[0-9]{8}(\.[0-9]+)?)$ ]]; then
    echo "Error: invalid GVISOR_RELEASE '${GVISOR_RELEASE}' (use 'latest' or e.g. 20261102.0)"
    exit 1
fi

INSTALL_DIR="/usr/local/bin"
URL="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${ARCH}"

echo "══════════════════════════════════════════════════════════"
echo "  gVisor (runsc) — Install"
echo "══════════════════════════════════════════════════════════"

# ── Check prerequisites ─────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "Error: run with sudo"
    exit 1
fi

if ! command -v docker &>/dev/null; then
    echo "Error: docker not found"
    exit 1
fi

# ── Download + verify the release tarball ──────────────────────────────
# Nothing in INSTALL_DIR, the Docker config or the daemon is touched until
# the checksum passes and the tarball holds everything we install.
if [[ -x "${INSTALL_DIR}/runsc" ]]; then
    echo ""
    echo "  runsc previous: $("${INSTALL_DIR}/runsc" --version 2>&1 | head -1 || true)"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir "${WORK_DIR}/dl" "${WORK_DIR}/x"

echo ""
echo "Downloading gVisor ${GVISOR_RELEASE} for ${ARCH}..."
for f in gvisor.tar.bz2 gvisor.tar.bz2.sha512; do
    if ! curl -fsSL "${URL}/${f}" -o "${WORK_DIR}/dl/${f}"; then
        echo "Error: download failed: ${URL}/${f}"
        exit 1
    fi
done

echo "Verifying SHA-512 checksum..."
if ! (cd "${WORK_DIR}/dl" && sha512sum -c gvisor.tar.bz2.sha512); then
    echo "Error: checksum verification failed; nothing was installed"
    exit 1
fi

tar -xjf "${WORK_DIR}/dl/gvisor.tar.bz2" -C "${WORK_DIR}/x" --no-same-owner
if [[ ! -f "${WORK_DIR}/x/runsc" || ! -f "${WORK_DIR}/x/containerd-shim-runsc-v1" || ! -d "${WORK_DIR}/x/gvisor-bin" ]]; then
    echo "Error: tarball must contain runsc, containerd-shim-runsc-v1 and gvisor-bin/; nothing was installed"
    exit 1
fi

# runsc looks for gvisor-bin/ next to its own binary. Replace it as a whole
# so no stale sidecars from an older release remain.
echo "Installing into ${INSTALL_DIR}..."
install -m 0755 "${WORK_DIR}/x/runsc" "${INSTALL_DIR}/runsc"
install -m 0755 "${WORK_DIR}/x/containerd-shim-runsc-v1" "${INSTALL_DIR}/containerd-shim-runsc-v1"
rm -rf "${INSTALL_DIR}/gvisor-bin"
cp -rp "${WORK_DIR}/x/gvisor-bin" "${INSTALL_DIR}/gvisor-bin"

# ── Register runtime with Docker ───────────────────────────────────────
# --network=host is required so gVisor containers can reach Docker
# networks (bridge, overlay, etc.). Without it, runsc uses its own
# network stack and containers cannot reach other services on Docker
# networks (e.g. api-relay on the egress_proxy network).
echo ""
echo "Registering runsc runtime with Docker..."
"${INSTALL_DIR}/runsc" install -- --network=host

# ── Restart Docker daemon ───────────────────────────────────────────────
echo ""
echo "Reloading Docker daemon..."
systemctl reload docker

# ── Verify ──────────────────────────────────────────────────────────────
echo ""
echo "Verifying..."
RUNSC_VERSION="$("${INSTALL_DIR}/runsc" --version 2>&1 | head -1)"
echo "  runsc new: ${RUNSC_VERSION}"

if docker run --rm --runtime=runsc hello-world &>/dev/null; then
    echo "  docker --runtime=runsc: OK"
else
    echo "  docker --runtime=runsc: FAILED"
    echo "  Check: docker run --rm --runtime=runsc hello-world"
    exit 1
fi

echo ""
echo "Done. Add 'runtime: runsc' to agent services in docker-compose.yml."
echo ""
echo "Example:"
echo "  services:"
echo "    agent:"
echo "      runtime: runsc"
echo "      # seccomp and apparmor are redundant under gVisor"
