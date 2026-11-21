#!/bin/sh
# Trusted container-side lifecycle control. Board may continue using its file controls.
set -eu
BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun --no-env-file "$BIN_DIR/runtime/main.ts" control "$@"
