#!/bin/sh
# Stable CarapaBox trusted-command entrypoint for the TypeScript runtime.
set -eu

if [ -d /opt/carapa-harness-store ] && [ ! -f /opt/carapa-harness-store/current ]; then
  echo 'run-agent: migrate the harness selection to a stable store before starting this sandbox' >&2
  exit 1
fi

# Pin once around the entire run, including detached workers and their tools.
if [ -x /opt/carapa-harness/bin/carapa-harness-exec ] && [ -z "${CARAPA_HARNESS_SNAPSHOT:-}" ]; then
  exec /opt/carapa-harness/bin/carapa-harness-exec "$0" "$@"
fi

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$BIN_DIR:$PATH"
export PATH
export BASH_ENV="$BIN_DIR/bash-env.sh"

if [ "${1:-}" = "--exec" ]; then
  [ -n "${2:-}" ] || { echo "run-agent: usage: run-agent.sh --exec <run-dir>" >&2; exit 1; }
  exec bun --no-env-file "$BIN_DIR/runtime/main.ts" execute "$2"
fi
exec bun --no-env-file "$BIN_DIR/runtime/main.ts" run "$@"
