#!/bin/bash
# Start carapa-box with its dependency: egress-proxy.
# Run from the carapa-box project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EGRESS_DIR="$SCRIPT_DIR/egress-proxy"

# 1. Ensure egress-proxy is running
if [ -d "$EGRESS_DIR" ]; then
    if ! docker compose -f "$EGRESS_DIR/docker-compose.yml" -p egress-proxy ps --format json 2>/dev/null | grep -q '"running"'; then
        echo "Starting egress-proxy stack..."
        # Run before-start hook if present
        [ -x "$EGRESS_DIR/before-start.sh" ] && "$EGRESS_DIR/before-start.sh"
        docker compose -f "$EGRESS_DIR/docker-compose.yml" -p egress-proxy up -d
        echo "Egress-proxy started."
    else
        echo "Egress-proxy already running."
    fi
fi

# 2. Start carapa-box
echo "Starting carapa-box..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d "$@"
