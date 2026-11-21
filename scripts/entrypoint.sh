#!/bin/bash
# CarapaBox container entrypoint.
# Verifies OPA policies are pre-compiled, then starts the server.
# Policy compilation happens at build time (build.sh), not here —
# all mounts are read-only at runtime.
set -e

# ── Verify pre-compiled policies ─────────────────────────────────────────
missing=0

BASE_WASM="/app/config/policies/base.wasm"
BUILTIN_WASM="${CARAPA_BOX_BUILTIN_POLICIES_DIR:-}/base.wasm"
if [ -f "/app/config/policies/base.rego" ] && [ ! -f "$BASE_WASM" ] && [ ! -f "$BUILTIN_WASM" ]; then
  echo "[entrypoint] ERROR: base.wasm missing — every command will be denied (base.missing) until you run build.sh to compile policies"
  missing=$((missing + 1))
fi

STACKS_DIR="${SANDBOX_STACKS_DIR:-/app/stacks}"
if [ -d "$STACKS_DIR" ]; then
  for rego in "$STACKS_DIR"/*/policy.rego; do
    [ -f "$rego" ] || continue
    wasm="${rego%.rego}.wasm"
    if [ ! -f "$wasm" ]; then
      echo "[entrypoint] WARNING: $(basename "$(dirname "$rego")")/policy.wasm missing"
      missing=$((missing + 1))
    fi
  done
fi

EGRESS_DIR="${SANDBOX_EGRESS_PROXY_DIR:-/app/egress-proxy}"
if [ -f "$EGRESS_DIR/policy.rego" ] && [ ! -f "$EGRESS_DIR/policy.wasm" ]; then
  echo "[entrypoint] WARNING: egress-proxy/policy.wasm missing"
  missing=$((missing + 1))
fi

if [ "$missing" -gt 0 ]; then
  echo "[entrypoint] $missing policy .wasm file(s) missing. Run: bash build.sh"
else
  echo "[entrypoint] All policies pre-compiled."
fi

# ── Start the server ─────────────────────────────────────────────────────
exec "$@"
