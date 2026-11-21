#!/bin/bash
# Cursor agent shell tools block until localhost:3100 accepts connections.
# demo-app and php stacks satisfy this via CarapaBrain; plain carapa-bot does not.
# Bind a no-op HTTP responder so headless `agent --print` runs complete.
set -e

start_rootless_sshd() {
  /bin/bash /usr/local/ai-cli-bin/ssh-control.sh init ||
    echo "WARNING: sandbox SSH could not start; see /tmp/carapa-ssh/daemon.log" >&2
}

configure_pi_models() {
  local template="${PI_MODELS_TEMPLATE:-/usr/local/share/carapa/pi-models.json}"
  local config_dir="${PI_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.pi/agent}"
  local models_file="${config_dir}/models.json"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object" and (.providers | type == "object")' "$template" >/dev/null; then
    echo "Pi model template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.models.json.tmp.XXXXXX")"

  if [ -e "$models_file" ]; then
    if jq -e 'type == "object" and ((.providers // {}) | type == "object")' "$models_file" >/dev/null 2>&1; then
      # Preserve unrelated providers and user settings, but replace the
      # managed llama.cpp provider so stale local model definitions disappear.
      if ! jq -s '
        .[0] as $current
        | .[1] as $managed
        | $current + {
            providers: (($current.providers // {}) + $managed.providers)
          }
      ' "$models_file" "$template" > "$temporary"; then
        rm -f "$temporary"
        return 1
      fi
    else
      backup="$(mktemp "${models_file}.invalid.XXXXXX")"
      cp "$models_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up invalid Pi model config to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi

  chmod 600 "$temporary"
  mv "$temporary" "$models_file"
}

configure_pi_settings() {
  local config_dir="${PI_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.pi/agent}"
  local settings_file="${config_dir}/settings.json"
  local temporary backup

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.settings.json.tmp.XXXXXX")"
  if [ -e "$settings_file" ]; then
    if jq -e 'type == "object"' "$settings_file" >/dev/null 2>&1; then
      # Pi applies this transport only to its Codex Responses provider. The
      # api-relay supports WebSocket upgrades; llama-proxy providers continue
      # to use their HTTP OpenAI-compatible transports.
      # pi-mcp-adapter comes from the harness volume. A stale copy listed in
      # packages (e.g. an old npm install in AGENT_HOME) would shadow it, so
      # drop that entry and keep every other package.
      # Entries that are neither strings nor objects with a string source are
      # kept untouched, as is a non-array packages value.
      jq '. + {transport: "websocket"}
        | if (.packages | type) == "array" then
            .packages |= map(select(
              ((if type == "string" then .
                elif type == "object" and (.source | type) == "string" then .source
                else "" end)
                | test("(^|/|npm:)pi-mcp-adapter(@[^/]+)?/?$")) | not))
          else . end' "$settings_file" > "$temporary" || {
        rm -f "$temporary"
        return 1
      }
    else
      backup="$(mktemp "${settings_file}.invalid.XXXXXX")"
      cp "$settings_file" "$backup"
      chmod 600 "$backup"
      printf '%s\n' '{"transport":"websocket"}' > "$temporary"
      echo "Backed up invalid Pi settings to $backup" >&2
    fi
  else
    printf '%s\n' '{"transport":"websocket"}' > "$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$settings_file"
}

drop_pi_harness_adapter_package() {
  local pi_settings="$HOME/.pi/agent/settings.json"
  local pi_temporary

  [ -f "$pi_settings" ] || return 0
  pi_temporary="$(mktemp "${pi_settings}.XXXXXX")"
  # A non-array packages value (or non-string/object entry) is left as is.
  jq '.packages = (
      (.packages // [])
      | if type == "array" then
          map(select((if type == "string" then .
            elif type == "object" and (.source | type) == "string" then .source
            else "" end) != "/opt/carapa-harness/harnesses/pi/lib/node_modules/pi-mcp-adapter"))
        else . end)' "$pi_settings" > "$pi_temporary" || {
    rm -f "$pi_temporary"
    return 1
  }
  mv "$pi_temporary" "$pi_settings"
}

configure_prime_models() {
  local template="${PRIME_AGENT_MODELS_TEMPLATE:-/usr/local/share/carapa/prime-models.json}"
  local config_dir="${PRIME_AGENT_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.prime/agent}"
  local models_file="${config_dir}/models.json"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object" and (.providers | type == "object")' "$template" >/dev/null; then
    echo "Prime Agent model template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.models.json.tmp.XXXXXX")"

  if [ -e "$models_file" ]; then
    if jq -e 'type == "object" and ((.providers // {}) | type == "object")' "$models_file" >/dev/null 2>&1; then
      # Preserve user settings and unrelated providers, but replace the managed
      # relay provider completely so stale model definitions cannot survive.
      if ! jq -s '
        .[0] as $current
        | .[1] as $managed
        | $current + {
            providers: (($current.providers // {}) + $managed.providers)
          }
      ' "$models_file" "$template" > "$temporary"; then
        rm -f "$temporary"
        return 1
      fi
    else
      backup="$(mktemp "${models_file}.invalid.XXXXXX")"
      cp "$models_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up invalid Prime Agent model config to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi

  chmod 600 "$temporary"
  mv "$temporary" "$models_file"
}

configure_prime_settings() {
  local template="${PRIME_AGENT_SETTINGS_TEMPLATE:-/usr/local/share/carapa/prime-settings.json}"
  local config_dir="${PRIME_AGENT_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.prime/agent}"
  local settings_file="${config_dir}/settings.json"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object"' "$template" >/dev/null; then
    echo "Prime Agent settings template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.settings.json.tmp.XXXXXX")"
  if [ -e "$settings_file" ]; then
    if jq -e 'type == "object"' "$settings_file" >/dev/null 2>&1; then
      if ! jq -s '.[0] + .[1]' "$settings_file" "$template" > "$temporary"; then
        rm -f "$temporary"
        return 1
      fi
    else
      backup="$(mktemp "${settings_file}.invalid.XXXXXX")"
      cp "$settings_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up invalid Prime Agent settings to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi

  chmod 600 "$temporary"
  mv "$temporary" "$settings_file"
}

configure_omp_models() {
  local template="${OMP_MODELS_TEMPLATE:-/usr/local/share/carapa/omp-models.json}"
  local config_dir="${PI_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.omp/agent}"
  local models_file="${config_dir}/models.yml"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object" and (.providers | type == "object")' "$template" >/dev/null; then
    echo "OMP model template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.models.yml.tmp.XXXXXX")"
  if [ -e "$models_file" ]; then
    if jq -e 'type == "object" and ((.providers // {}) | type == "object")' "$models_file" >/dev/null 2>&1; then
      jq -s '
        .[0] as $current
        | .[1] as $managed
        | $current + {providers: (($current.providers // {}) + $managed.providers)}
      ' "$models_file" "$template" > "$temporary"
    else
      backup="$(mktemp "${models_file}.pre-carapa.XXXXXX")"
      cp "$models_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up non-JSON OMP model config to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$models_file"
}

configure_omp_settings() {
  local template="${OMP_SETTINGS_TEMPLATE:-/usr/local/share/carapa/omp-settings.json}"
  local config_dir="${PI_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.omp/agent}"
  local settings_file="${config_dir}/config.yml"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object"' "$template" >/dev/null; then
    echo "OMP settings template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.config.yml.tmp.XXXXXX")"
  if [ -e "$settings_file" ]; then
    if jq -e 'type == "object"' "$settings_file" >/dev/null 2>&1; then
      jq -s '.[0] * .[1]' "$settings_file" "$template" > "$temporary"
    else
      backup="$(mktemp "${settings_file}.pre-carapa.XXXXXX")"
      cp "$settings_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up non-JSON OMP settings to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$settings_file"
}

configure_omp_lsp() {
  local template="${OMP_LSP_TEMPLATE:-/usr/local/share/carapa/omp-lsp.json}"
  local config_dir="${PI_CODING_AGENT_DIR:-${HOME:-/home/ubuntu}/.omp/agent}"
  local lsp_file="${config_dir}/lsp.json"
  local temporary backup

  [ -r "$template" ] || return 0
  if ! jq -e 'type == "object" and (.servers | type == "object")' "$template" >/dev/null; then
    echo "OMP LSP template is invalid: $template" >&2
    return 1
  fi

  mkdir -p "$config_dir"
  temporary="$(mktemp "${config_dir}/.lsp.json.tmp.XXXXXX")"
  if [ -e "$lsp_file" ]; then
    if jq -e 'type == "object" and ((.servers // {}) | type == "object")' "$lsp_file" >/dev/null 2>&1; then
      # Preserve user-defined servers and global LSP options while replacing
      # the Carapa-managed definitions with the image-tested versions.
      jq -s '
        .[0] as $current
        | .[1] as $managed
        | $current + {servers: (($current.servers // {}) + $managed.servers)}
      ' "$lsp_file" "$template" > "$temporary"
    else
      backup="$(mktemp "${lsp_file}.pre-carapa.XXXXXX")"
      cp "$lsp_file" "$backup"
      chmod 600 "$backup"
      cp "$template" "$temporary"
      echo "Backed up invalid OMP LSP config to $backup" >&2
    fi
  else
    cp "$template" "$temporary"
  fi
  chmod 600 "$temporary"
  mv "$temporary" "$lsp_file"
}

configure_pi_models
configure_pi_settings ||
  echo "WARNING: could not configure Pi settings; continuing with the existing file" >&2
drop_pi_harness_adapter_package ||
  echo "WARNING: could not clean Pi packages in $HOME/.pi/agent/settings.json; continuing" >&2
configure_prime_models
configure_prime_settings
configure_omp_models
configure_omp_settings
configure_omp_lsp
start_rootless_sshd

# Optional mounted CA: extend the public system roots without modifying the
# read-only image. Child Node, Python, curl and Chromium processes inherit it.
if [ -n "${CARAPA_CA_FILE:-}" ]; then
  test -r "$CARAPA_CA_FILE" || { echo "Cannot read CARAPA_CA_FILE" >&2; exit 1; }
  mkdir -p /tmp/carapa-certs
  cat /etc/ssl/certs/ca-certificates.crt "$CARAPA_CA_FILE" > /tmp/carapa-certs/ca-bundle.crt
  export NODE_EXTRA_CA_CERTS="$CARAPA_CA_FILE"
  export SSL_CERT_FILE=/tmp/carapa-certs/ca-bundle.crt
  export REQUESTS_CA_BUNDLE="$SSL_CERT_FILE" CURL_CA_BUNDLE="$SSL_CERT_FILE"
fi

# The persisted home mount is now available; populate Chromium's NSS trust DB.
# Shared CarapaBot tools live under ai-cli-bin; stack-cli-bin is deliberately
# replaced by each stack's own command directory.
if [ -x /usr/local/ai-cli-bin/install-local-ca ]; then
  # Browser trust is optional; a bad shared NSS DB must not crash-loop the agent.
  /usr/local/ai-cli-bin/install-local-ca ||
    echo "WARNING: could not add local CA to ${HOME:-/home/ubuntu}/.pki/nssdb; Chromium may reject local HTTPS" >&2
fi

# Link this project's skills and rules into the container-local ~/.agent views
# (docker-compose.yml). A failure leaves them empty but must not crash-loop.
if command -v carapa-agent-view >/dev/null 2>&1; then
  carapa-agent-view refresh ||
    echo "WARNING: carapa-agent-view refresh failed; skills and rules are incomplete" >&2
fi

if [ "${CARAPA_SKIP_LOCAL_RESPONDER:-0}" != "1" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const http = require("http");
    const srv = http.createServer((req, res) => {
      res.writeHead(200, {"Content-Type": "text/plain"});
      res.end("ok");
    });
    srv.on("error", () => process.exit(0));
    srv.listen(3100, "127.0.0.1");
  ' &
fi
exec "$@"
