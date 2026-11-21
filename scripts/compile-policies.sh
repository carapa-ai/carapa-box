#!/usr/bin/env bash
# Compiles .rego policy files to .wasm bundles using the OPA CLI.
#
# Usage: bash scripts/compile-policies.sh [--stacks-dir /path/to/stacks]
#
# Requires: opa CLI in PATH or at /tmp/opa
#
# Produces:
#   config/policies/base.wasm   — shared base policy bundle
#   stacks/*/policy.wasm        — per-stack policy bundles (with base as data)
#   egress-proxy/policy.wasm    — egress-proxy policy bundle

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICIES_DIR="$PROJECT_ROOT/config/policies"
STACKS_DIR="$PROJECT_ROOT/stacks"

# Accept --stacks-dir to compile an external stacks directory
# Accept --skip-base to skip recompiling the base policy (e.g. when config is read-only)
SKIP_BASE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --stacks-dir) STACKS_DIR="$2"; shift 2 ;;
        --skip-base) SKIP_BASE=true; shift ;;
        *) shift ;;
    esac
done

# Find opa binary
OPA="${OPA:-}"
if [ -z "$OPA" ]; then
    if command -v opa &>/dev/null; then
        OPA="opa"
    elif [ -x /tmp/opa ]; then
        OPA="/tmp/opa"
    else
        echo "ERROR: opa CLI not found. Install it or set OPA=/path/to/opa"
        echo "  curl -L -o /tmp/opa https://openpolicyagent.org/downloads/v1.14.1/opa_linux_amd64_static && chmod +x /tmp/opa"
        exit 1
    fi
fi

OPA="$(realpath "$(command -v "$OPA")")"

echo "Using OPA: $OPA ($($OPA version 2>/dev/null | head -1 || echo 'unknown version'))"
echo ""

COMPILED=0
FAILED=0

# Compile copies with stable relative filenames so published WASM never embeds
# host checkout paths. Each invocation owns its scratch directory.
POLICY_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/carapa-policy.XXXXXX")"
trap 'rm -rf "$POLICY_BUILD_DIR"' EXIT
if [ -f "$POLICIES_DIR/base.rego" ]; then
    cp "$POLICIES_DIR/base.rego" "$POLICY_BUILD_DIR/base.rego"
fi

# ── Compile base policy ──────────────────────────────────────────────────
if [ "$SKIP_BASE" = true ]; then
    echo "  Skipping base.rego (--skip-base)"
elif [ -f "$POLICIES_DIR/base.rego" ]; then
    echo -n "  Compiling base.rego... "
    if (cd "$POLICY_BUILD_DIR" && "$OPA" build -t wasm \
        -e "carapabox/base/deny" \
        -o "$POLICY_BUILD_DIR/base.tar.gz" \
        base.rego) 2>/dev/null; then
        # OPA versions differ on whether this bundle member is recorded as
        # `policy.wasm` or `/policy.wasm`; the wildcard handles both forms.
        tar -xOf "$POLICY_BUILD_DIR/base.tar.gz" --wildcards '*policy.wasm' > "$POLICY_BUILD_DIR/policy.wasm"
        mv "$POLICY_BUILD_DIR/policy.wasm" "$POLICIES_DIR/base.wasm"
        rm -f "$POLICY_BUILD_DIR/base.tar.gz"
        echo "OK"
        COMPILED=$((COMPILED + 1))
    else
        echo "FAILED"
        rm -f "$POLICY_BUILD_DIR/base.tar.gz"
        FAILED=$((FAILED + 1))
    fi
else
    echo "  Compiling base.rego... FAILED (missing $POLICIES_DIR/base.rego)"
    FAILED=$((FAILED + 1))
fi

# ── Compile stack policies ───────────────────────────────────────────────
compile_stack_policy() {
    local name="$1"
    local dir="$2"
    local rego_path="$dir/policy.rego"

    if [ ! -f "$rego_path" ]; then
        return
    fi

    echo -n "  Compiling $name/policy.rego... "

    # Determine the package name to use as entrypoint
    local pkg
    pkg=$(grep '^package ' "$rego_path" | head -1 | awk '{print $2}' || true)
    if [ -z "$pkg" ]; then
        echo "FAILED (no package declaration)"
        FAILED=$((FAILED + 1))
        return
    fi

    # Convert package name to entrypoint path: carapabox.stack.foo → carapabox/stack/foo
    local entrypoint
    entrypoint=$(echo "$pkg" | tr '.' '/')

    cp "$rego_path" "$POLICY_BUILD_DIR/stack.rego"
    if (cd "$POLICY_BUILD_DIR" && "$OPA" build -t wasm \
        -e "$entrypoint/result" \
        -e "$entrypoint/allow" \
        -e "$entrypoint/deny" \
        -o "$POLICY_BUILD_DIR/policy.tar.gz" \
        base.rego stack.rego) 2>/dev/null; then
        tar -xOf "$POLICY_BUILD_DIR/policy.tar.gz" --wildcards '*policy.wasm' > "$POLICY_BUILD_DIR/policy.wasm"
        mv "$POLICY_BUILD_DIR/policy.wasm" "$dir/policy.wasm"
        rm -f "$POLICY_BUILD_DIR/policy.tar.gz"
        echo "OK"
        COMPILED=$((COMPILED + 1))
    else
        echo "FAILED"
        rm -f "$POLICY_BUILD_DIR/policy.tar.gz"
        FAILED=$((FAILED + 1))
    fi
}

# Process all stacks
if [ -d "$STACKS_DIR" ]; then
    for stack_dir in "$STACKS_DIR"/*/; do
        [ -d "$stack_dir" ] || continue
        name=$(basename "$stack_dir")
        compile_stack_policy "$name" "$stack_dir"
    done
fi

# Process egress-proxy (only when compiling project-internal stacks)
EGRESS_DIR="$PROJECT_ROOT/egress-proxy"
if [ -d "$EGRESS_DIR" ] && [ "$STACKS_DIR" = "$PROJECT_ROOT/stacks" ]; then
    compile_stack_policy "egress-proxy" "$EGRESS_DIR"
fi

echo ""
echo "Done: $COMPILED compiled, $FAILED failed"

if [ $FAILED -gt 0 ]; then
    exit 1
fi
