#!/usr/bin/env bash
# Provision distinct controller credentials without overwriting existing secrets.
set -euo pipefail
umask 077
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ $# == 2 && "$1" == --secrets-dir && "$2" == /* ]] || fail 'Usage: bash ensure-controller-secrets.sh --secrets-dir /absolute/path'
secrets_dir=$2
command -v openssl >/dev/null || fail 'openssl is required'
mkdir -p -- "$secrets_dir"
api_file=$secrets_dir/carapa_box_api_token
admin_file=$secrets_dir/carapa_box_admin_token
for target in "$api_file" "$admin_file"; do
    if [[ -e "$target" || -L "$target" ]]; then
        [[ -f "$target" && -r "$target" && -s "$target" ]] || fail "Existing credential is empty or unreadable: $target"
        value=$(cat -- "$target")
        [[ "$value" =~ ^[!-~]+$ ]] || fail "Existing credential is invalid: $target"
        unset value
    fi
done
scratch=''
trap '[[ -z "$scratch" ]] || rm -f -- "$scratch"' EXIT
for target in "$api_file" "$admin_file"; do
    if [[ ! -e "$target" ]]; then
        scratch=$(mktemp "$secrets_dir/.carapabox-token.XXXXXX")
        openssl rand -hex 32 > "$scratch"
        # Publish atomically without replacing a credential created by another operator.
        ln -- "$scratch" "$target" || fail "Credential appeared during setup; inspect and rerun: $target"
        rm -f -- "$scratch"
        scratch=''
        printf 'Created credential file: %s\n' "$target"
    fi
done
if [[ "$(cat -- "$api_file")" == "$(cat -- "$admin_file")" ]]; then
    fail 'API and admin tokens are identical; provision a distinct admin token through an authorized rotation. Existing files were preserved.'
fi
echo 'PASS: API and admin credentials are present and distinct. Existing credentials and permissions were preserved.'
