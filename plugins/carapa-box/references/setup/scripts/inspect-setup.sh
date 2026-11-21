#!/usr/bin/env bash
# Read-only setup inventory. Never source .env or read secret contents.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
fail() { printf 'inspect-setup: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root) [[ $# -ge 2 ]] || fail '--repo-root requires a path'; repo_root=$2; shift 2 ;;
        --help|-h) echo 'Usage: bash inspect-setup.sh [--repo-root PATH]'; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
[[ -f "$repo_root/docker-compose.yml" ]] || fail 'repository must contain docker-compose.yml'
repo_root="$(cd "$repo_root" && pwd -P)"

# A quoted value ends at the first closing quote that leaves nothing or a
# whitespace-preceded comment, which is dropped. An unquoted value loses a
# whitespace-preceded `#...` comment. Mirrors parseEnvFile in stack-service.ts.
strip_env_comment() {
    local value=$1 quote rest i
    quote=${value:0:1}
    if [[ "$quote" == \" || "$quote" == \' ]]; then
        for ((i = 1; i < ${#value}; i++)); do
            [[ "${value:i:1}" == "$quote" ]] || continue
            rest=${value:i+1}
            if [[ -z "$rest" || "$rest" =~ ^[[:space:]]+# ]]; then
                printf '%s' "${value:0:i+1}"
                return 0
            fi
        done
        printf '%s' "$value"
        return 0
    fi
    value=${value%%[[:space:]]#*}
    printf '%s' "${value%"${value##*[![:space:]]}"}"
}
# Only extract explicitly requested non-secret keys. Quoting is unwrapped as
# data; interpolation and shell expressions are never evaluated.
env_value() {
    local file=$1 key=$2 line value='' pattern
    [[ -r "$file" ]] || return 0
    pattern="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$"
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ $pattern ]]; then
            value=${BASH_REMATCH[2]}
            value="${value#"${value%%[![:space:]]*}"}"
            value="${value%"${value##*[![:space:]]}"}"
            value=$(strip_env_comment "$value")
            if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
                value=${value:1:${#value}-2}
            elif [[ "$value" == *[[:space:]]* || "$value" == *\"* || "$value" == *\'* ]]; then
                value='<unresolved>'
            fi
            if [[ "$value" == *'$'* || "$value" == *'`'* ]]; then value='<unresolved>'; fi
        fi
    done < "$file"
    printf '%s' "$value"
}
file_state() {
    local label=$1 path=$2 kind='missing' detail=''
    if [[ -e "$path" ]]; then
        kind=file
        [[ ! -d "$path" ]] || kind=directory
        [[ ! -S "$path" ]] || kind=socket
        [[ ! -f "$path" || -s "$path" ]] || kind=empty-file
        detail=$(stat -c 'uid=%u gid=%g mode=%a' "$path" 2>/dev/null || stat -f 'uid=%u gid=%g mode=%Lp' "$path" 2>/dev/null || true)
    fi
    printf '%s: %s %s\n' "$label" "$kind" "$detail"
}
printf 'Repository: %s\nPlatform: %s\n' "$repo_root" "$(uname -s)"
for command_name in docker bun opa curl openssl apparmor_parser; do
    if command -v "$command_name" >/dev/null 2>&1; then state=available; else state=missing; fi
    printf 'Tool %s: %s\n' "$command_name" "$state"
done
file_state 'Docker socket' /var/run/docker.sock
for key in SECRETS_DIR SANDBOX_STACKS_DIR SANDBOX_HOST_DIR MCP_SANDBOX_PORT DOCKER_GID; do
    printf 'Controller %s: %s\n' "$key" "$(env_value "$repo_root/.env" "$key")"
done
for key in SECRETS_DIR RELAY_UID RELAY_GID; do
    printf 'Egress %s: %s\n' "$key" "$(env_value "$repo_root/egress-proxy/.env" "$key")"
done
for file in .env egress-proxy/.env config/mount-allowlist.yaml config/policies/base.wasm \
    egress-proxy/policy.wasm generated/audit generated/nginx-routes generated/squid-generated.conf \
    egress-proxy/tool_profiles.jsonc egress-proxy/captures; do
    file_state "$file" "$repo_root/$file"
done
for scope in controller egress; do
    env_file="$repo_root/.env"
    [[ "$scope" != egress ]] || env_file="$repo_root/egress-proxy/.env"
    secret_dir=$(env_value "$env_file" SECRETS_DIR)
    if [[ "$secret_dir" != /* ]]; then
        printf '%s secrets: set or resolve an absolute SECRETS_DIR\n' "$scope"
        continue
    fi
    names=(carapa_box_api_token)
    [[ "$scope" != controller ]] || names+=(carapa_box_admin_token)
    if [[ "$scope" == egress && -r "$repo_root/egress-proxy/docker-compose.yml" ]]; then
        names=()
        pattern='file:[[:space:]]*\$\{SECRETS_DIR\}/([a-z0-9_]+)'
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" =~ $pattern ]]; then names+=("${BASH_REMATCH[1]}"); fi
        done < "$repo_root/egress-proxy/docker-compose.yml"
    fi
    for name in "${names[@]}"; do file_state "$scope secret $name" "$secret_dir/$name"; done
done
echo 'Scope: files only; overrides, process environment, Docker state, token validity and service-UID access are not verified.'
