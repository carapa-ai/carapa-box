#!/bin/sh
# ── Egress proxy pre-start hook ─────────────────────────────────────────
# Runs on the HOST before `docker compose up`.
# Only checks that all required images exist — building is done
# once via `./build.sh` or the auto-build in main().
#
# Usage: cd egress-proxy && ./before-start.sh
set -e

# ── Ensure secret placeholders exist ──────────────────────────────────
# Docker Compose secrets require the source file to exist.
# Create empty placeholders for any missing secret files so stacks
# start cleanly even when not all API keys are configured.
# Take the names from the Compose file, so a newly declared secret cannot
# leave a missing source file (same derivation as build.sh). Compose reads
# SECRETS_DIR from the .env next to that file.
COMPOSE_FILE_PATH="$(cd "$(dirname "$0")" && pwd)/docker-compose.yml"
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
        echo "Created empty placeholder: $SECRETS_DIR/$SECRET"
    fi
done

# ── Check required images ─────────────────────────────────────────────
MISSING=0
for IMAGE in carapa/egress-proxy-squid:latest carapa/egress-proxy-api-relay:latest carapa/egress-proxy-llama-proxy:latest; do
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo "ERROR: Image '$IMAGE' not found." >&2
        MISSING=1
    fi
done

if [ "$MISSING" -eq 1 ]; then
    echo "Build images first:  cd egress-proxy && ./build.sh" >&2
    exit 1
fi
