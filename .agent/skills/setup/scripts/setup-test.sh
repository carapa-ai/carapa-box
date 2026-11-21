#!/usr/bin/env bash
# Exercises the actual setup helpers using temporary files and a curl fixture.
set -euo pipefail
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/carapabox-setup-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/repo/egress-proxy" "$fixture/private secrets" "$fixture/bin" "$fixture/tmp"
touch "$fixture/repo/docker-compose.yml"
printf 'SECRETS_DIR="%s/private secrets"\nCARAPA_BOX_API_TOKEN=private-fixture-token\nSANDBOX_HOST_DIR=$(touch %s/executed)\n' "$fixture" "$fixture" > "$fixture/repo/.env"
printf 'SECRETS_DIR="%s/private secrets"\nOPENAI_API_KEY=private-fixture-token\n' "$fixture" > "$fixture/repo/egress-proxy/.env"
printf 'secrets:\n  custom:\n    file: ${SECRETS_DIR}/custom_provider_key\n' > "$fixture/repo/egress-proxy/docker-compose.yml"
printf 'private-fixture-token\n' > "$fixture/private secrets/carapa_box_api_token"
cp -R "$fixture/repo" "$fixture/before"
bash "$scripts/inspect-setup.sh" --repo-root "$fixture/repo" > "$fixture/inventory"
if grep -q 'private-fixture-token' "$fixture/inventory"; then exit 1; fi
grep -q 'SANDBOX_HOST_DIR: <unresolved>' "$fixture/inventory"
grep -q 'custom_provider_key: missing' "$fixture/inventory"
[[ ! -e "$fixture/executed" ]]
diff -qr "$fixture/before" "$fixture/repo" >/dev/null

# A trailing comment after a quoted or unquoted value must not make SECRETS_DIR unresolved.
mkdir -p "$fixture/commented/egress-proxy" "$fixture/commented/secrets"
touch "$fixture/commented/docker-compose.yml"
printf 'private-fixture-token\n' > "$fixture/commented/secrets/carapa_box_api_token"
printf 'SECRETS_DIR="%s/commented/secrets" # prod\n' "$fixture" > "$fixture/commented/.env"
printf 'SECRETS_DIR=%s/commented/secrets # prod\n' "$fixture" > "$fixture/commented/egress-proxy/.env"
bash "$scripts/inspect-setup.sh" --repo-root "$fixture/commented" > "$fixture/commented-inventory"
grep -qF "Controller SECRETS_DIR: $fixture/commented/secrets" "$fixture/commented-inventory"
grep -qF "Egress SECRETS_DIR: $fixture/commented/secrets" "$fixture/commented-inventory"
if grep -q 'set or resolve an absolute SECRETS_DIR' "$fixture/commented-inventory"; then exit 1; fi
grep -q 'controller secret carapa_box_api_token: file ' "$fixture/commented-inventory"
grep -q 'egress secret carapa_box_api_token: file ' "$fixture/commented-inventory"

cat > "$fixture/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
# The token must never appear in a command argument or a verbose response.
for arg in "$@"; do [[ "$arg" != *private-fixture-token* && "$arg" != *admin-fixture-token* ]] || exit 90; done
[[ "$1" == -q ]] || exit 91
count=0
[[ ! -f "$FIXTURE/count" ]] || read -r count < "$FIXTURE/count"
count=$((count + 1))
printf '%s\n' "$count" > "$FIXTURE/count"
header=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output) body=$2; shift 2 ;;
        --header) [[ "$2" != @* ]] || header=${2#@}; shift 2 ;;
        --write-out|--max-time|--max-filesize) shift 2 ;;
        -q|--silent) shift ;;
        http*) url=$1; shift ;;
        *) exit 92 ;;
    esac
done
if [[ "$MODE" == failure ]]; then echo 'private-fixture-token' >&2; exit 7; fi
if [[ "$MODE" == redirect ]]; then printf '302'; exit 0; fi
case "$count" in
    1) [[ -z "$header" && "$url" == */health ]] || exit 93
       printf '{"name":"carapa-box"}' > "$body"; printf '200' ;;
    2) [[ -z "$header" && "$url" == */api/tools ]] || exit 94
       if [[ "$MODE" == insecure ]]; then printf '200'; else printf '401'; fi ;;
    3) [[ -n "$header" && "$url" == */api/tools ]] || exit 95
       grep -q 'Authorization: Bearer setup-invalid-' "$header"
       printf '401' ;;
    4) [[ -n "$header" && "$url" == */api/tools ]] || exit 96
       grep -qx 'Authorization: Bearer private-fixture-token' "$header"
       printf '[{"name":"sandbox_list"}]' > "$body"; printf '200' ;;
    5) [[ -z "$header" && "$url" == */api/admin/stacks ]] || exit 97
       printf '401' ;;
    6) grep -q 'Authorization: Bearer setup-invalid-' "$header"
       printf '401' ;;
    7) grep -qx 'Authorization: Bearer private-fixture-token' "$header"
       if [[ "$MODE" == admin-fallback ]]; then printf '200'; else printf '401'; fi ;;
    8) [[ "$url" == */api/admin/stacks ]] || exit 98
       grep -qx 'Authorization: Bearer admin-fixture-token' "$header"
       printf '[]' > "$body"; printf '200' ;;
    9) [[ "$url" == */api/tools ]] || exit 99
       grep -qx 'Authorization: Bearer admin-fixture-token' "$header"
       printf '401' ;;
    *) exit 100 ;;
esac
CURL
chmod +x "$fixture/bin/curl"
for mode in success insecure redirect failure; do
    rm -f "$fixture/count"
    if PATH="$fixture/bin:$PATH" TMPDIR="$fixture/tmp" FIXTURE="$fixture" MODE="$mode" \
        bash "$scripts/check-controller.sh" --token-file "$fixture/private secrets/carapa_box_api_token" \
        > "$fixture/output" 2>&1; then
        [[ "$mode" == success ]]
        grep -q '^PASS:' "$fixture/output"
        [[ "$(cat "$fixture/count")" == 4 ]]
    else
        [[ "$mode" != success ]]
        grep -q '^FAIL:' "$fixture/output"
        if [[ "$mode" == insecure ]]; then [[ "$(cat "$fixture/count")" == 2 ]]; fi
        if [[ "$mode" == redirect ]]; then [[ "$(cat "$fixture/count")" == 1 ]]; fi
    fi
    if grep -q 'private-fixture-token' "$fixture/output"; then exit 1; fi
    [[ -z "$(ls -A "$fixture/tmp")" ]]
done
printf 'PASS: read-only inventory, authentication checks, redirect refusal, token privacy, and cleanup.\n'

printf 'admin-fixture-token\n' > "$fixture/private secrets/carapa_box_admin_token"
for mode in success admin-fallback; do
    rm -f "$fixture/count"
    if PATH="$fixture/bin:$PATH" TMPDIR="$fixture/tmp" FIXTURE="$fixture" MODE="$mode" \
        bash "$scripts/check-controller.sh" --token-file "$fixture/private secrets/carapa_box_api_token" \
        --admin-token-file "$fixture/private secrets/carapa_box_admin_token" > "$fixture/output" 2>&1; then
        [[ "$mode" == success && "$(cat "$fixture/count")" == 9 ]]
    else
        [[ "$mode" == admin-fallback && "$(cat "$fixture/count")" == 7 ]]
    fi
    if grep -Eq '(private|admin)-fixture-token' "$fixture/output"; then exit 1; fi
    [[ -z "$(ls -A "$fixture/tmp")" ]]
done
printf 'PASS: admin/API separation and rejection of legacy fallback.\n'
