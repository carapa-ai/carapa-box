#!/bin/sh
# ── Git ssh — Build & CVE Scan ─────────────────────────────────────
# Run manually to rebuild all images and scan for vulnerabilities.
#
# Usage: cd egress-proxy && ./build.sh
set -e

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$STACK_DIR"

echo "══════════════════════════════════════════════════════════"
echo "  Git ssh — Build & CVE Scan"
echo "══════════════════════════════════════════════════════════"

# ── Build all images ────────────────────────────────────────────────────
echo ""
echo "Building hardened images..."
docker build -t carapa/git-ssh .

# ── CVE scan function ───────────────────────────────────────────────────
scan_image() {
  local image="$1"
  echo ""
  echo "Scanning $image for vulnerabilities..."
  if command -v trivy >/dev/null 2>&1; then
    trivy image --severity HIGH,CRITICAL --exit-code 1 "$image"
  elif docker scout version >/dev/null 2>&1; then
    docker scout cves "local://$image" --only-severity critical,high
  else
    echo "No CVE scanner found. Install trivy or docker scout."
    echo "  Manual scan: trivy image --severity HIGH,CRITICAL $image"
    return 0
  fi
}

# ── Scan each service image ─────────────────────────────────────────────
scan_image "carapa/git-ssh:latest"

echo ""
echo "Done."
