#!/bin/bash
# ── CarapaBox controller pre-start hook ──────────────────────────────────
# Runs on the HOST before `docker compose up` to scan the controller image
# for known CVEs.  Uses docker scout or trivy — whichever is available.
#
# Exit code is always 0 (advisory only) so the stack still starts.
set -e

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$STACK_DIR"

# CARAPA_BOX_DEPLOY_DIR: operator-only directory holding the deployment
# docker-compose.yml and .env (see docs/installation-data.md). Unset keeps the
# repository Compose project.
COMPOSE=(docker compose)
if [[ -n "${CARAPA_BOX_DEPLOY_DIR:-}" ]]; then
    COMPOSE+=(-f "$CARAPA_BOX_DEPLOY_DIR/docker-compose.yml")
fi
# Host source of a carapa-box mount target, as resolved by Compose.
compose_mount() {
    "${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print(next(v["source"] for v in c["services"]["carapa-box"]["volumes"] if v["target"] == sys.argv[1]))' "$1"
}

echo "══════════════════════════════════════════════════════════"
echo "  Carapa-Box — Build & CVE Scan"
echo "══════════════════════════════════════════════════════════"

# ── Build all images ────────────────────────────────────────────────────
BUILD_ARGS=""
SCAN=true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-cache) BUILD_ARGS="--no-cache"; shift ;;
        --no-scan)  SCAN=false; shift ;;
        *) break ;;
    esac
done

export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 999)"

# ── Pre-fetch OPA binary on the host ─────────────────────────────────────
# Downloading from inside the Dockerfile's `RUN curl` step is brittle:
# Alpine/musl's resolver inside BuildKit's network namespace frequently
# fails on GitHub's release-assets CDN. Pre-fetching here means the build
# only needs a working host network (already verified by everything else
# you've done to get here), and the binary becomes a normal build artifact
# cached by your filesystem instead of by Docker's layer cache.
OPA_VERSION="${OPA_VERSION:-v1.14.1}"
OPA_CACHE_DIR="$STACK_DIR/.cache/opa"
case "$(uname -m)" in
    x86_64|amd64) HOST_OPA_ARCH=amd64 ;;
    aarch64|arm64) HOST_OPA_ARCH=arm64 ;;
    *) echo "Unsupported host arch: $(uname -m)" >&2; exit 1 ;;
esac
# The version is part of the cached filename so a bumped OPA_VERSION never
# reuses a binary downloaded for an older release.
[[ "$OPA_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "OPA_VERSION must be a release such as v1.14.1" >&2; exit 1; }
OPA_BIN_NAME="opa_${OPA_VERSION}_linux_${HOST_OPA_ARCH}_static"
OPA_BIN="$OPA_CACHE_DIR/$OPA_BIN_NAME"

mkdir -p "$OPA_CACHE_DIR"
if [[ ! -s "$OPA_BIN" ]]; then
    echo ""
    echo "Fetching OPA ${OPA_VERSION} (${HOST_OPA_ARCH}) to .cache/opa/ ..."
    OPA_URL="https://openpolicyagent.org/downloads/${OPA_VERSION}/opa_linux_${HOST_OPA_ARCH}_static"
    curl -fSL --retry 3 --retry-delay 5 "$OPA_URL" -o "${OPA_BIN}.tmp"
    curl -fSL --retry 3 --retry-delay 5 "${OPA_URL}.sha256" -o "${OPA_BIN}.sha256.tmp"
    # Same check as .agent/skills/setup/scripts/install-prerequisites.sh.
    read -r opa_expected _ < "${OPA_BIN}.sha256.tmp" || opa_expected=""
    opa_actual=$(sha256sum "${OPA_BIN}.tmp"); opa_actual=${opa_actual%% *}
    rm -f "${OPA_BIN}.sha256.tmp"
    if [[ ! "$opa_expected" =~ ^[a-fA-F0-9]{64}$ || "$opa_actual" != "$opa_expected" ]]; then
        rm -f "${OPA_BIN}.tmp"
        echo "OPA checksum verification failed for ${OPA_URL}" >&2
        exit 1
    fi
    mv "${OPA_BIN}.tmp" "$OPA_BIN"
    chmod +x "$OPA_BIN"
fi
# Make the path predictable for the Dockerfile COPY regardless of host arch.
# The Dockerfile reads `.cache/opa/opa` — symlink the right binary there.
ln -sfn "$OPA_BIN_NAME" "$OPA_CACHE_DIR/opa"

echo ""
echo "Building hardened images...${BUILD_ARGS:+ (no cache)} (DOCKER_GID=$DOCKER_GID)"
export GIT_COMMIT="$(git -C "$STACK_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
"${COMPOSE[@]}" build $BUILD_ARGS

# Build the OPA compiler image from the opa-compiler stage (separate from runtime)
OPA_IMAGE="carapa-box-opa:latest"
echo ""
echo "Building OPA compiler image..."
docker build --target opa-compiler -t "$OPA_IMAGE" \
    --build-arg OPA_VERSION="$OPA_VERSION" \
    $BUILD_ARGS .

IMAGE="carapa-box:latest"

# ── Compile OPA policies (.rego → .wasm) ──────────────────────────────
# Runs in a temporary container using the opa-compiler stage (OPA + bash only).
# The runtime image (carapa-box) does NOT contain OPA — keeps it CVE-clean.
echo ""
echo "Compiling OPA policies (.rego → .wasm)..."
EGRESS_DIR="$STACK_DIR/egress-proxy"
if [[ -n "${CARAPA_BOX_DEPLOY_DIR:-}" ]]; then
    STACKS_DIR="${SANDBOX_STACKS_DIR:-$(compose_mount /app/stacks)}"
    # Operator-only egress project (CARAPA_BOX_EGRESS_DEPLOY_DIR) keeps its own policy.
    egress_deploy="$(compose_mount /app/egress-deploy)"
    [[ "$egress_deploy" == /dev/null ]] || EGRESS_DIR="$egress_deploy"
else
    STACKS_DIR="${SANDBOX_STACKS_DIR:-$STACK_DIR/stacks}"
fi
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
docker run --rm \
    --user "$HOST_UID:$HOST_GID" \
    --tmpfs /tmp:exec \
    -v "$STACK_DIR/config:/app/config" \
    -v "$STACKS_DIR:/app/stacks" \
    -v "$EGRESS_DIR:/app/egress-proxy" \
    "$OPA_IMAGE" \
    bash /app/scripts/compile-policies.sh

# Ensure .wasm files are readable by the configured non-root container user.
chmod a+r \
    "$STACK_DIR/config/policies/base.wasm" \
    "$STACKS_DIR"/*/policy.wasm \
    "$EGRESS_DIR/policy.wasm" 2>/dev/null || true

# Deploy the newly compiled base policy into the configured live directory.
# Compose resolves .env and host paths without sourcing shell code from .env.
LIVE_CONFIG_DIR="$(compose_mount /app/config)"
if [[ "$LIVE_CONFIG_DIR" != "$STACK_DIR/config" && "$(realpath "$LIVE_CONFIG_DIR")" != "$(realpath "$STACK_DIR/config")" ]]; then
    install -m 644 "$STACK_DIR/config/policies/base.wasm" "$LIVE_CONFIG_DIR/policies/base.wasm"
fi

# ── CVE scan ──────────────────────────────────────────────────────────
echo ""
if [[ "$SCAN" == false ]]; then
    echo "Skipping CVE scan (--no-scan)"
elif command -v docker &>/dev/null && docker scout version &>/dev/null 2>&1; then
    echo "Scanning $IMAGE for CVEs..."
    docker scout cves "$IMAGE" --only-severity critical,high 2>/dev/null || true
elif command -v trivy &>/dev/null; then
    echo "Scanning $IMAGE for CVEs..."
    trivy image "$IMAGE" --severity CRITICAL,HIGH 2>/dev/null || true
else
    echo "  (no CVE scanner found — install docker scout or trivy)"
fi
