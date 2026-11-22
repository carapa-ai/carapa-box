#!/usr/bin/env bash
# Exercises uninstall.sh against a fixture checkout and a fake docker CLI.
set -euo pipefail
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/carapabox-uninstall-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
repo="$fixture/repo" secrets="$fixture/secrets"
mkdir -p "$repo/egress-proxy" "$repo/config/policies" "$repo/generated/audit" "$repo/stacks/demo" \
    "$secrets" "$fixture/ipc/demo" "$fixture/groups/demo" "$fixture/bin" "$fixture/home"
printf 'secrets:\n  api:\n    file: ${SECRETS_DIR}/carapa_box_api_token\n' > "$repo/docker-compose.yml"
printf 'secrets:\n  k:\n    file: ${SECRETS_DIR}/openai_api_key\n' > "$repo/egress-proxy/docker-compose.yml"
mkdir -p "$fixture/accounts/credentials"
printf 'private-fixture-token\n' > "$fixture/accounts/credentials/a.json"
printf 'SECRETS_DIR=%s # private\nIPC_MOUNT=%s/ipc\nCARAPA_BOX_GROUPS_ROOT=%s/groups\nCARAPA_BOX_STATE_HOST_DIR=$(touch %s/executed)\nPROVIDER_ACCOUNTS_DIR=%s/accounts\n' \
    "$secrets" "$fixture" "$fixture" "$fixture" "$fixture" > "$repo/.env"
mkdir -p "$fixture/private"
printf 'SECRETS_DIR="%s"\n' "$secrets" > "$fixture/private/egress.env"
ln -s "$fixture/private/egress.env" "$repo/egress-proxy/.env"   # private-installation symlink
printf 'private-fixture-token\n' > "$secrets/carapa_box_api_token"
printf 'private-fixture-token\n' > "$secrets/openai_api_key"
printf 'unrelated\n' > "$secrets/keep_me"
touch "$repo/config/mount-allowlist.yaml" "$repo/config/policies/base.wasm" "$repo/stacks/demo/.env" "$repo/stacks/demo/compose.yml"

# Fake docker: one controller-launched stack with a container, network and volume.
cat > "$fixture/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIXTURE/docker.log"
case "$*" in
    "ps -a --filter label=com.docker.compose.project --format"*) printf 'demo-x\t/app/stacks/demo\negress-proxy\t/app/egress-proxy\nboard\t/elsewhere/board\n' ;;
    "ps -aq --filter label=com.docker.compose.project=demo-x") echo c1 ;;
    "inspect --format {{.Config.Image}} c1") echo demo-image:latest ;;
    "network ls --filter name=agent_egress_ --format {{.Name}}") echo agent_egress_demo-x ;;
    "network ls -q --filter label=com.docker.compose.project=demo-x") echo n1 ;;
    "volume ls -q --filter label=com.docker.compose.project=demo-x") echo v1 ;;
    "image inspect demo-image:latest") exit 0 ;;
    "volume ls -q --filter label=ai.carapa.harness-store") echo hv1 ;;
    "image inspect "*) exit 1 ;;
esac
DOCKER
chmod +x "$fixture/bin/docker"
export FIXTURE=$fixture PATH="$fixture/bin:$PATH" HOME="$fixture/home"

# Dry run: prints the plan, removes nothing, never evaluates .env or prints secrets.
cp -R "$repo" "$fixture/before"
bash "$scripts/uninstall.sh" --repo-root "$repo" --images --state --secrets > "$fixture/plan"
diff -qr "$fixture/before" "$repo" >/dev/null
[[ -f "$secrets/carapa_box_api_token" && -d "$fixture/ipc" && ! -e "$fixture/executed" ]]
if grep -q private-fixture-token "$fixture/plan"; then exit 1; fi
grep -q 'project demo-x' "$fixture/plan"
grep -q 'project egress-proxy' "$fixture/plan"
if grep -q 'project board' "$fixture/plan"; then exit 1; fi
if grep -qE '^(rm|network rm|volume rm|rmi)' "$fixture/docker.log"; then exit 1; fi
grep -q 'Dry run: nothing changed' "$fixture/plan"

# Default scope touches only Docker resources.
bash "$scripts/uninstall.sh" --repo-root "$repo" --yes > /dev/null
grep -qx 'rm -f c1' "$fixture/docker.log"
grep -qx 'network rm n1' "$fixture/docker.log"
grep -qx 'volume rm v1' "$fixture/docker.log"
if grep -q '^rmi' "$fixture/docker.log"; then exit 1; fi
[[ -f "$repo/.env" && -f "$secrets/openai_api_key" && -d "$fixture/accounts" ]]
if grep -qx 'volume rm hv1' "$fixture/docker.log"; then exit 1; fi

# Full scope: declared secrets and generated state go; unrelated files and groups stay.
: > "$fixture/docker.log"
bash "$scripts/uninstall.sh" --repo-root "$repo" --images --state --secrets --yes > "$fixture/out"
grep -qx 'rmi demo-image:latest' "$fixture/docker.log"
grep -qx 'volume rm hv1' "$fixture/docker.log"
[[ ! -e "$fixture/accounts" ]]
[[ ! -e "$secrets/carapa_box_api_token" && ! -e "$secrets/openai_api_key" && -f "$secrets/keep_me" ]]
[[ ! -e "$repo/.env" && ! -e "$repo/egress-proxy/.env" && ! -e "$repo/generated" ]]
[[ ! -e "$repo/config/mount-allowlist.yaml" && ! -e "$repo/config/policies/base.wasm" && ! -e "$repo/stacks/demo/.env" ]]
[[ -f "$repo/stacks/demo/compose.yml" && -d "$fixture/groups/demo" && ! -e "$fixture/ipc" ]]
[[ ! -e "$fixture/executed" && ! -L "$repo/egress-proxy/.env" && ! -e "$fixture/private/egress.env" ]]
grep -q "CARAPA_BOX_GROUPS_ROOT=$fixture/groups" "$fixture/out"
grep -q "kept non-empty $secrets" "$fixture/out"

# Quick-installer layout: egress deployed outside the controller directory.
deploy="$fixture/deploy"; mkdir -p "$deploy/box/egress-proxy-unused" "$deploy/egress"
printf 'secrets: {}\n' > "$deploy/box/docker-compose.yml"
printf 'secrets:\n  k:\n    file: ${SECRETS_DIR}/openai_api_key\n' > "$deploy/egress/docker-compose.yml"
printf 'SECRETS_DIR=%s/egress-secrets\n' "$fixture" > "$deploy/egress/.env"
mkdir -p "$fixture/egress-secrets"; printf 'x\n' > "$fixture/egress-secrets/openai_api_key"
bash "$scripts/uninstall.sh" --repo-root "$deploy/box" --egress-dir "$deploy/egress" --secrets --state --yes > /dev/null
[[ ! -e "$fixture/egress-secrets/openai_api_key" && ! -e "$deploy/egress/.env" ]]

# --host refuses to mix with user scopes or to run unprivileged.
if bash "$scripts/uninstall.sh" --repo-root "$repo" --host --state 2>/dev/null; then exit 1; fi
if [[ $EUID -ne 0 ]] && bash "$scripts/uninstall.sh" --repo-root "$repo" --host 2>/dev/null; then exit 1; fi
echo 'uninstall-test: ok'
