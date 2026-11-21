#!/bin/sh
# Run in the sandbox PID namespace; never infer liveness from Board's PIDs.
set -eu
BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun --no-env-file "$BIN_DIR/runtime/prune-ipc.ts" "$@"
