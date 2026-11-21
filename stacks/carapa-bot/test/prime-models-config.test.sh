#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
test_home="$(mktemp -d)"
trap 'rm -rf "$test_home"' EXIT
config_dir="$test_home/.prime/agent"
models_file="$config_dir/models.json"
settings_file="$config_dir/settings.json"

mkdir -p "$config_dir"
cp "$root/prime-models.json" "$test_home/expected.json"

cat > "$models_file" <<'JSON'
{
  "theme": "dark",
  "providers": {
    "local-test": {
      "baseUrl": "http://llama-proxy:8080/v1"
    },
    "carapa-codex": {
      "stale": true
    }
  }
}
JSON

cat > "$settings_file" <<'JSON'
{
  "theme": "carapa-test",
  "transport": "websocket"
}
JSON

HOME="$test_home" \
PRIME_AGENT_CODING_AGENT_DIR="$config_dir" \
PRIME_AGENT_MODELS_TEMPLATE="$root/prime-models.json" \
PRIME_AGENT_SETTINGS_TEMPLATE="$root/prime-settings.json" \
CARAPA_SKIP_LOCAL_RESPONDER=1 \
  bash "$root/entrypoint.sh" /bin/true

jq -e '.theme == "dark" and .providers["local-test"].baseUrl == "http://llama-proxy:8080/v1"' \
  "$models_file" >/dev/null
jq -e --slurpfile expected "$test_home/expected.json" \
  '.providers["carapa-codex"] == $expected[0].providers["carapa-codex"]' \
  "$models_file" >/dev/null
jq -e --slurpfile expected "$test_home/expected.json" \
  '.providers["carapa-llama"] == $expected[0].providers["carapa-llama"]' \
  "$models_file" >/dev/null
jq -e '.providers["carapa-codex"].stale == null' "$models_file" >/dev/null
jq -e '
  .providers["carapa-llama"].baseUrl == "http://llama-proxy:8881/v1"
  and .providers["carapa-llama"].api == "openai-completions"
  and .providers["carapa-llama"].models[0].id == "qwen3.8"
  and .providers["carapa-llama"].models[0].contextWindow == 160000
  and .providers["carapa-llama"].models[0].maxTokens == 128000
  and .providers["carapa-llama"].models[0].thinkingLevelMap == {
    "off": null,
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": null,
    "xhigh": "xhigh",
    "max": null
  }
  and .providers["carapa-llama"].models[0].compat.thinkingFormat == "openai"
  and .providers["carapa-llama"].models[0].compat.supportsReasoningEffort == true
' "$models_file" >/dev/null
[ "$(stat -c '%a' "$models_file")" = "600" ]
jq -e '.theme == "carapa-test" and .transport == "sse"' "$settings_file" >/dev/null
[ "$(stat -c '%a' "$settings_file")" = "600" ]

printf '{not-json\n' > "$models_file"
HOME="$test_home" \
PRIME_AGENT_CODING_AGENT_DIR="$config_dir" \
PRIME_AGENT_MODELS_TEMPLATE="$root/prime-models.json" \
PRIME_AGENT_SETTINGS_TEMPLATE="$root/prime-settings.json" \
CARAPA_SKIP_LOCAL_RESPONDER=1 \
  bash "$root/entrypoint.sh" /bin/true

jq -e '
  .providers["carapa-codex"].api == "openai-codex-responses"
  and (.providers["carapa-codex"].apiKey | startswith("eyJ"))
  and .providers["carapa-llama"].models[0].id == "qwen3.8"
' \
  "$models_file" >/dev/null
backup_file="$(compgen -G "${models_file}.invalid.*")"
[ -n "$backup_file" ]
[ "$(stat -c '%a' "$backup_file")" = "600" ]

# Existing containers may still carry an older baked template. The mounted
# launcher must repair the managed relay fields before every Prime process.
jq '
  .theme = "preserved"
  | .providers["carapa-codex"].baseUrl = "http://api-relay:8080/codex/v1"
  | .providers["carapa-codex"].apiKey = "not-a-jwt"
' "$models_file" > "$models_file.drifted"
mv "$models_file.drifted" "$models_file"
HOME="$test_home" PRIME_AGENT_CODING_AGENT_DIR="$config_dir" \
  bun -e 'const { preparePrimeRelay } = await import(process.argv[1]); preparePrimeRelay({ env: process.env });' "$root/bin/runtime/acp/preparations.ts"
jq -e '
  .theme == "preserved"
  and .providers["carapa-codex"].baseUrl == "http://api-relay:8080/codex"
  and .providers["carapa-codex"].api == "openai-codex-responses"
  and .providers["carapa-codex"].authHeader == true
  and (.providers["carapa-codex"].apiKey | startswith("eyJ"))
' "$models_file" >/dev/null
[ "$(stat -c '%a' "$models_file")" = "600" ]

echo "Prime Agent managed model configuration tests passed"
