#!/bin/sh
# ── Egress Proxy — Build & CVE Scan ─────────────────────────────────────
# Run manually to rebuild all images and scan for vulnerabilities.
#
# Usage: cd egress-proxy && ./build.sh
set -e

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$STACK_DIR"

echo "══════════════════════════════════════════════════════════"
echo "  Egress Proxy — Build & CVE Scan"
echo "══════════════════════════════════════════════════════════"

# ── Ensure secret placeholders exist ──────────────────────────────────
# Docker Compose secrets require the source file to exist.
# Create empty placeholders for any missing ones.
# Take the names from the Compose file that is built and started, so a newly
# declared secret cannot leave a missing source file. Compose reads SECRETS_DIR
# from the .env next to that file, so placeholders must land where it looks.
COMPOSE_FILE_PATH="${CARAPA_EGRESS_DEPLOY_DIR:-$STACK_DIR}/docker-compose.yml"
if [ -z "$SECRETS_DIR" ]; then
    ENV_FILE="$(dirname "$COMPOSE_FILE_PATH")/.env"
    if [ -f "$ENV_FILE" ]; then
        # Last assignment wins, as in Compose; drop CR, `export `, quotes and
        # the inline comment of an unquoted value.
        SECRETS_DIR=$(sed -n -e '/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}SECRETS_DIR[=]/ s/^[^=]*=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')
        case "$SECRETS_DIR" in
            \"*) SECRETS_DIR=$(printf '%s' "$SECRETS_DIR" | sed 's/^"\([^"]*\)".*$/\1/') ;;
            \'*) SECRETS_DIR=$(printf '%s' "$SECRETS_DIR" | sed "s/^'\([^']*\)'.*\$/\1/") ;;
            *) SECRETS_DIR=$(printf '%s' "$SECRETS_DIR" | sed 's/[[:space:]][[:space:]]*#.*$//; s/[[:space:]]*$//') ;;
        esac
    fi
    SECRETS_DIR="${SECRETS_DIR:-$HOME/.secrets/egress}"
fi
mkdir -p "$SECRETS_DIR"
for SECRET in $(sed -n 's|^ *file: *\${SECRETS_DIR}/\([A-Za-z0-9_.-]*\) *$|\1|p' "$COMPOSE_FILE_PATH"); do
    if [ ! -f "$SECRETS_DIR/$SECRET" ]; then
        touch "$SECRETS_DIR/$SECRET"
        echo "  Created empty placeholder: $SECRETS_DIR/$SECRET"
    fi
done

# ── Build all images ────────────────────────────────────────────────────
# CARAPA_EGRESS_DEPLOY_DIR: operator-only directory holding the deployment
# docker-compose.yml and .env. Unset keeps this directory's Compose project.
echo ""
echo "Building hardened images..."
if [ -n "${CARAPA_EGRESS_DEPLOY_DIR:-}" ]; then
    docker compose -f "$CARAPA_EGRESS_DEPLOY_DIR/docker-compose.yml" build
else
    docker compose build
fi

# ── CVE scan function ───────────────────────────────────────────────────
# Report-only, like build.sh: findings are printed and never fail the build.
# A scan that could not run is called out so it is not mistaken for a clean one.
scan_image() {
  local image="$1"
  echo ""
  echo "Scanning $image for vulnerabilities..."
  if command -v trivy >/dev/null 2>&1; then
    trivy image --severity HIGH,CRITICAL "$image" \
      || echo "WARNING: trivy could not scan $image; no report for this image"
  elif docker scout version >/dev/null 2>&1; then
    docker scout cves "local://$image" --only-severity critical,high \
      || echo "WARNING: docker scout could not scan $image; no report for this image"
  else
    echo "No CVE scanner found. Install trivy or docker scout."
    echo "  Manual scan: trivy image --severity HIGH,CRITICAL $image"
    return 0
  fi
}

# ── Scan each service image ─────────────────────────────────────────────
scan_image "carapa/egress-proxy-squid:latest"
scan_image "carapa/egress-proxy-api-relay:latest"
scan_image "carapa/egress-proxy-llama-proxy:latest"

echo ""
echo "Done."
