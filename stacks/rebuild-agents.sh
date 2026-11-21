#!/bin/sh
# Rebuild the public CarapaBot runtime image (harness installation is separate) and scan it.
# Accepts the same options as carapa-bot/build.sh.
set -eu

STACKS_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$STACKS_DIR/carapa-bot/build.sh" "$@"
