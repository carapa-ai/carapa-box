#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT

run_entrypoint() {
  HOME="$test_home" \
  OMP_MODELS_TEMPLATE="$root/omp-models.json" \
  OMP_SETTINGS_TEMPLATE="$root/omp-settings.json" \
  OMP_LSP_TEMPLATE="$root/omp-lsp.json" \
  CARAPA_SKIP_LOCAL_RESPONDER=1 \
    bash "$root/entrypoint.sh" /bin/true
}

run_entrypoint

models="$test_home/.omp/agent/models.yml"
settings="$test_home/.omp/agent/config.yml"
lsp="$test_home/.omp/agent/lsp.json"
jq -e '.providers["carapa-llama"].baseUrl == "http://llama-proxy:8881/v1"' "$models" >/dev/null
jq -e '.providers["carapa-codex"].baseUrl == "http://api-relay:8080/codex"' "$models" >/dev/null
jq -e '.startup.setupWizard == false' "$settings" >/dev/null
jq -e '.enabledModels | index("carapa-llama/qwen3.8") != null' "$settings" >/dev/null
jq -e '.servers["typescript-native"].command == "tsc"' "$lsp" >/dev/null
jq -e '.servers.clangd.fileTypes | index(".cu") != null and index(".cuh") != null' "$lsp" >/dev/null

jq '.providers.custom = {baseUrl:"http://custom.invalid/v1",api:"openai-completions",auth:"none",models:[]}' \
  "$models" > "$models.tmp"
mv "$models.tmp" "$models"
jq '.theme = {dark:"custom"}' "$settings" > "$settings.tmp"
mv "$settings.tmp" "$settings"
jq '.idleTimeoutMs = 300000 | .servers.custom = {command:"custom-lsp",fileTypes:[".custom"],rootMarkers:[".git"]}' \
  "$lsp" > "$lsp.tmp"
mv "$lsp.tmp" "$lsp"

run_entrypoint

jq -e '.providers.custom.baseUrl == "http://custom.invalid/v1"' "$models" >/dev/null
jq -e '.providers["carapa-codex"].models | length == 6' "$models" >/dev/null
jq -e '.theme.dark == "custom" and .startup.setupWizard == false' "$settings" >/dev/null
jq -e '.idleTimeoutMs == 300000 and .servers.custom.command == "custom-lsp"' "$lsp" >/dev/null
jq -e '.servers["typescript-native"].args == ["--lsp", "--stdio"]' "$lsp" >/dev/null


printf 'OMP managed configuration tests passed\n'
