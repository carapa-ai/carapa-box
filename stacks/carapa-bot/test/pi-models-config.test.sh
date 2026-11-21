#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
test_home="$(mktemp -d)"
trap 'rm -rf "$test_home"' EXIT
config_dir="$test_home/.pi/agent"
models_file="$config_dir/models.json"
settings_file="$config_dir/settings.json"

mkdir -p "$config_dir"
printf '%s\n' '{"theme":"dark","packages":["npm:pi-mcp-adapter","npm:keep-me",{"source":"npm:pi-mcp-adapter@2.10.0"},{"source":"npm:keep-too"}]}' > "$settings_file"
cat > "$models_file" <<'JSON'
{
  "theme": "dark",
  "providers": {
    "user-provider": {
      "baseUrl": "http://example.invalid/v1"
    },
    "llama-proxy": {
      "stale": true,
      "models": [{"id": "qwen3.6"}]
    }
  }
}
JSON

HOME="$test_home" \
PI_CODING_AGENT_DIR="$config_dir" \
PI_MODELS_TEMPLATE="$root/pi-models.json" \
PRIME_AGENT_MODELS_TEMPLATE=/nonexistent \
PRIME_AGENT_SETTINGS_TEMPLATE=/nonexistent \
CARAPA_SKIP_LOCAL_RESPONDER=1 \
  bash "$root/entrypoint.sh" /bin/true

jq -e '
  .theme == "dark"
  and .providers["user-provider"].baseUrl == "http://example.invalid/v1"
  and .providers["llama-proxy"].stale == null
  and .providers["llama-proxy"].baseUrl == "http://llama-proxy:8881/v1"
  and .providers["llama-proxy"].api == "openai-responses"
  and .providers["llama-proxy"].models[0].id == "qwen3.8"
  and .providers["llama-proxy"].models[0].reasoning == true
  and .providers["llama-proxy"].models[0].contextWindow == 160000
  and .providers["llama-proxy"].models[0].maxTokens == 128000
  and .providers["llama-proxy"].models[0].thinkingLevelMap == {
    "off": null,
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": null,
    "xhigh": "xhigh",
    "max": null
  }
  and .providers["llama-proxy"].models[0].compat.thinkingFormat == "openai"
  and .providers["llama-proxy"].models[0].compat.supportsReasoningEffort == true
  and ([.providers["llama-proxy"].models[].id] | index("qwen3.6") == null)
  and ([.providers["llama-proxy"].models[].id] | index("coder") != null)
  and .providers["carapa-codex"].baseUrl == "http://api-relay:8080/codex"
  and .providers["carapa-codex"].api == "openai-codex-responses"
  and .providers["carapa-codex"].authHeader == true
  and ([.providers["carapa-codex"].models[].id] | index("gpt-6.1-sol") != null)
  and ([.providers["carapa-codex"].models[].id] | index("gpt-6.1-terra") != null)
  and ([.providers["carapa-codex"].models[].id] | index("gpt-6-luna") != null)
  and .providers.anthropic == {"baseUrl": "http://api-relay:8080/anthropic-api"}
' "$models_file" >/dev/null
jq -e '.transport == "websocket" and .theme == "dark" and .packages == ["npm:keep-me", {"source": "npm:keep-too"}]' "$settings_file" >/dev/null
[ "$(stat -c '%a' "$models_file")" = "600" ]
[ "$(stat -c '%a' "$settings_file")" = "600" ]

printf '{not-json\n' > "$models_file"
HOME="$test_home" \
PI_CODING_AGENT_DIR="$config_dir" \
PI_MODELS_TEMPLATE="$root/pi-models.json" \
PRIME_AGENT_MODELS_TEMPLATE=/nonexistent \
PRIME_AGENT_SETTINGS_TEMPLATE=/nonexistent \
CARAPA_SKIP_LOCAL_RESPONDER=1 \
  bash "$root/entrypoint.sh" /bin/true

jq -e '
  .providers["llama-proxy"].models[0].id == "qwen3.8"
  and .providers["carapa-codex"].models[5].id == "gpt-6-luna"
' "$models_file" >/dev/null
backup_file="$(compgen -G "${models_file}.invalid.*")"
[ -n "$backup_file" ]
[ "$(stat -c '%a' "$backup_file")" = "600" ]

# Valid JSON with a malformed packages value must warn and continue, not abort.
for malformed in '{"packages":"x"}' '{"packages":{"a":1}}' '{"packages":[1]}' '{"packages":[{"source":1}]}'; do
  printf '%s\n' "$malformed" > "$settings_file"
  HOME="$test_home" \
  PI_CODING_AGENT_DIR="$config_dir" \
  PI_MODELS_TEMPLATE="$root/pi-models.json" \
  PRIME_AGENT_MODELS_TEMPLATE=/nonexistent \
  PRIME_AGENT_SETTINGS_TEMPLATE=/nonexistent \
  CARAPA_SKIP_LOCAL_RESPONDER=1 \
    bash "$root/entrypoint.sh" /bin/true
  jq -e --argjson original "$malformed" '.transport == "websocket" and .packages == $original.packages' "$settings_file" >/dev/null
  [ -z "$(compgen -G "${config_dir}/.settings.json.tmp.*" || true)" ]
  [ -z "$(compgen -G "${settings_file}.??????" || true)" ]
done

echo "Pi managed model configuration tests passed"
