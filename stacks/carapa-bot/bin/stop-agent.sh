#!/bin/sh
# Stable CarapaBox trusted-command entrypoint for the TypeScript runtime.
set -eu

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$BIN_DIR:$PATH"
export PATH

exec bun --no-env-file "$BIN_DIR/runtime/main.ts" stop "$@"
