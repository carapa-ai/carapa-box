#!/usr/bin/env bash
# Read-only HTTP smoke check. Requires Bash, curl and ordinary host utilities.
set -euo pipefail
export LC_ALL=C
base_url=http://127.0.0.1:3100
token_file=''
admin_token_file=''
timeout=10
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --url|--token-file|--admin-token-file|--timeout)
            [[ $# -ge 2 ]] || fail "$1 requires a value"
            case "$1" in --url) base_url=$2 ;; --token-file) token_file=$2 ;; --admin-token-file) admin_token_file=$2 ;; --timeout) timeout=$2 ;; esac
            shift 2 ;;
        --help|-h) echo 'Usage: bash check-controller.sh [--url HTTP_ORIGIN] --token-file PATH [--admin-token-file PATH] [--timeout SECONDS]'; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
base_url=${base_url%/}
[[ "$base_url" =~ ^https?://[^/@?#[:space:]]+$ ]] || fail '--url must be an HTTP(S) origin without credentials, path, query or fragment'
[[ "$timeout" =~ ^[0-9]+$ && "$timeout" -gt 0 ]] || fail '--timeout must be a positive number of seconds'
[[ -n "$token_file" && -r "$token_file" && -f "$token_file" ]] || fail 'provide a readable --token-file'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
token=$(cat "$token_file")
[[ "$token" =~ ^[!-~]+$ ]] || fail 'token file must contain one nonempty printable ASCII token'
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/carapabox-check.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# curl reads headers from a private file; the token never enters curl's argv.
printf 'Authorization: Bearer %s\n' "$token" > "$scratch/auth-header"
printf 'Authorization: Bearer setup-invalid-%s\n' "${scratch##*/}" > "$scratch/invalid-header"
if [[ -n "$admin_token_file" ]]; then
    [[ -f "$admin_token_file" && -r "$admin_token_file" ]] || fail 'provide a readable --admin-token-file'
    admin_token=$(cat -- "$admin_token_file")
    [[ "$admin_token" =~ ^[!-~]+$ && "$admin_token" != "$token" ]] || fail 'admin credential must be valid and distinct from API credential'
    printf 'Authorization: Bearer %s\n' "$admin_token" > "$scratch/admin-header"
    unset admin_token
fi
unset token
request() {
    local endpoint=$1 header=${2:-} args=()
    [[ -z "$header" ]] || args=(--header "@$header")
    # ${args[@]+...} keeps an empty array valid under set -u on bash < 4.4 (macOS 3.2).
    # -q disables user curlrc (which could enable redirects or verbose output).
    # Never follow redirects, print response bodies or relay curl error details.
    if ! status=$(curl -q --silent --max-time "$timeout" --max-filesize 1048576 \
        --output "$scratch/body" --write-out '%{http_code}' \
        --header 'Accept: application/json' ${args[@]+"${args[@]}"} "$base_url$endpoint" 2>/dev/null); then
        fail 'HTTP request failed (connection, TLS, timeout or response-size limit)'
    fi
}
request /health
[[ "$status" == 200 ]] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"carapa-box"' "$scratch/body" || fail 'health did not identify CarapaBox'
request /api/tools
[[ "$status" == 401 ]] || fail "missing authentication was not rejected (HTTP $status)"
request /api/tools "$scratch/invalid-header"
[[ "$status" == 401 ]] || fail "invalid authentication was not rejected (HTTP $status)"
request /api/tools "$scratch/auth-header"
[[ "$status" == 200 ]] || fail "authenticated tool listing failed (HTTP $status)"
grep -Eq '"name"[[:space:]]*:[[:space:]]*"sandbox_list"' "$scratch/body" || fail 'authenticated response did not include the sandbox tool registry'
if [[ -n "$admin_token_file" ]]; then
    for header in '' "$scratch/invalid-header" "$scratch/auth-header"; do
        request /api/admin/stacks "$header"
        [[ "$status" == 401 ]] || fail "admin route accepted missing/invalid/API credentials or is unconfigured (HTTP $status)"
    done
    request /api/admin/stacks "$scratch/admin-header"
    [[ "$status" == 200 ]] || fail "authenticated admin request failed (HTTP $status)"
    request /api/tools "$scratch/admin-header"
    [[ "$status" == 401 ]] || fail "API route did not reject the admin credential (HTTP $status)"
    echo 'PASS: separate admin authentication and API/admin isolation.'
fi
echo 'PASS: CarapaBox health, missing/invalid token rejection, and authenticated tool listing.'
echo 'Scope: HTTP smoke check only; no stack or agent tool was executed.'
