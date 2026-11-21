#!/bin/sh
# ── CarapaBot agent — Build & CVE Scan ───────────────────────────────────
# Run manually to rebuild the image and scan for vulnerabilities.
#
# Usage:
#   ./build.sh            — build the versioned public runtime using Docker cache
#   ./build.sh --alpine   — build the separate DHI Alpine runtime
#   ./build.sh --no-cache — rebuild the image without Docker cache
set -e

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$STACK_DIR"

VERSION="$(cat "$STACK_DIR/VERSION")"
SCAN=1
NO_CACHE=0
ALPINE=0

for arg in "$@"; do
    case "$arg" in
        --alpine)
            ALPINE=1
            ;;
        --update)
            echo 'Harness updates are separate: python3 harness.py update [harness...]' >&2
            exit 1
            ;;
        --no-cache)
            NO_CACHE=1
            ;;
        --no-scan)
            SCAN=0
            ;;
        -h|--help)
            echo 'Usage: build.sh [--alpine] [--no-cache] [--no-scan]'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

DOCKERFILE=Dockerfile
if [ "$ALPINE" -eq 1 ]; then
    DOCKERFILE=Dockerfile.alpine
    # A Debian selection in .env must not silently become a musl runtime.
    CARAPA_BOT_IMAGE="${CARAPA_BOT_IMAGE:-carapa-bot:$VERSION-alpine}"
    export CARAPA_BOT_IMAGE
fi
IMAGE="$(python3 "$STACK_DIR/harness.py" image)"

echo "══════════════════════════════════════════════════════════"
echo "  CarapaBot Agent — Build & CVE Scan"
echo "══════════════════════════════════════════════════════════"

# Build a stable runtime only. This never installs or updates a harness.
set -- --build-arg "CARAPA_BOT_VERSION=$VERSION"
if [ "$ALPINE" -eq 1 ]; then set -- "$@" -f "$DOCKERFILE"; fi
if [ "$NO_CACHE" -eq 1 ]; then set -- "$@" --no-cache; fi
docker build "$@" -t "$IMAGE" .

# ── CVE scan ──────────────────────────────────────────────────────────────
if [ "$SCAN" -eq 1 ]; then
    echo ""
    echo "Scanning $IMAGE for vulnerabilities..."
    if command -v trivy >/dev/null 2>&1; then
        trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$IMAGE"
    elif docker scout version >/dev/null 2>&1; then
        docker scout cves "local://$IMAGE" --only-severity critical,high --exit-code
    else
        echo "No CVE scanner found. Install trivy or docker scout, or explicitly use --no-scan for a development build." >&2
        exit 1
    fi
fi

echo ""
echo "Done."
