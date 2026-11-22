#!/usr/bin/env bash
# Remove a CarapaBox installation. Prints the plan and changes nothing unless
# --yes is given. Never sources .env and never prints secret contents.
#
# Default scope: containers, networks and Compose volumes of the controller,
# the egress proxy and every stack the controller launched, plus the host-mode
# systemd user service. Everything else is opt-in:
#   --images   also remove the images those containers used, the images
#              build.sh / egress-proxy/build.sh produce, and the CarapaBot
#              harness volumes (installed agent CLIs)
#   --state    delete generated install state: gitignored config in the
#              checkout (.env files, mount allowlist, compiled *.wasm, stack
#              .env files, generated/) and the configured IPC/state dirs
#   --secrets  delete the secret files the Compose files declare under each
#              SECRETS_DIR (controller and egress) and the provider-account
#              store (PROVIDER_ACCOUNTS_DIR: signed-in accounts and API keys)
#   --host     as root, on its own: unload the AppArmor profiles and remove
#              the gVisor runtime installed by the security scripts
# Group directories, agent homes and CarapaBoard are never touched.
# --egress-dir names the egress-proxy deployment when it is not <repo>/egress-proxy
# (the quick installer deploys it next to the controller's deploy directory).
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
fail() { printf 'uninstall: %s\n' "$*" >&2; exit 1; }
usage() {
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    echo 'Usage: bash uninstall.sh [--repo-root PATH] [--egress-dir PATH] [--images] [--state] [--secrets] [--yes]'
    echo '       sudo bash uninstall.sh --host [--repo-root PATH] [--yes]'
}
apply=0 images=0 state=0 secrets=0 host=0
egress_dir=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root) [[ $# -ge 2 ]] || fail '--repo-root requires a path'; repo_root=$2; shift 2 ;;
        --egress-dir) [[ $# -ge 2 ]] || fail '--egress-dir requires a path'; egress_dir=$2; shift 2 ;;
        --images) images=1; shift ;;
        --state) state=1; shift ;;
        --secrets) secrets=1; shift ;;
        --host) host=1; shift ;;
        --yes) apply=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) fail "unknown option: $1" ;;
    esac
done
[[ -f "$repo_root/docker-compose.yml" ]] || fail 'repository must contain docker-compose.yml'
repo_root="$(cd "$repo_root" && pwd -P)"
egress_dir="${egress_dir:-$repo_root/egress-proxy}"
[[ ! -d "$egress_dir" ]] || egress_dir="$(cd "$egress_dir" && pwd -P)"
if [[ $host -eq 1 ]]; then
    (( images + state + secrets == 0 )) || fail '--host runs on its own; run the other scopes as the operator user'
    [[ $EUID -eq 0 ]] || fail '--host must run as root (sudo)'
fi

run() {
    printf '  %s\n' "$*"
    [[ $apply -eq 0 ]] || "$@" || printf '    (failed, continuing)\n' >&2
}
# Same parsing rules as inspect-setup.sh: values are data, never evaluated.
strip_env_comment() {
    local value=$1 quote rest i
    quote=${value:0:1}
    if [[ "$quote" == \" || "$quote" == \' ]]; then
        for ((i = 1; i < ${#value}; i++)); do
            [[ "${value:i:1}" == "$quote" ]] || continue
            rest=${value:i+1}
            if [[ -z "$rest" || "$rest" =~ ^[[:space:]]+# ]]; then printf '%s' "${value:0:i+1}"; return 0; fi
        done
        printf '%s' "$value"; return 0
    fi
    value=${value%%[[:space:]]#*}
    printf '%s' "${value%"${value##*[![:space:]]}"}"
}
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
            if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}
            elif [[ "$value" == *[[:space:]]* || "$value" == *\"* || "$value" == *\'* ]]; then value=''; fi
            [[ "$value" != *'$'* && "$value" != *'`'* ]] || value=''
        fi
    done < "$file"
    printf '%s' "$value"
}
# Refuse paths whose removal would take more than CarapaBox state with it.
safe_path() {
    local p=$1
    [[ "$p" == /* ]] || return 1
    p=${p%/}
    [[ -n "$p" && "$p" != "$HOME" && "$p" != "$repo_root" && "$p" != "$(dirname "$repo_root")" ]] || return 1
    [[ "$p" == */*/* ]] || return 1   # at least two levels below /
}
remove_path() {
    local p=$1
    [[ -e "$p" || -L "$p" ]] || return 0
    safe_path "$p" || { printf '  skip unsafe path: %s\n' "$p"; return 0; }
    run rm -rf -- "$p"
}
tracked() { git -C "$repo_root" ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

if [[ $host -eq 1 ]]; then
    echo '== AppArmor profiles'
    profiles=()
    line=$(grep -m1 -E '^PROFILES=\(' "$repo_root/security/install-apparmor.sh" || true)
    [[ -z "$line" ]] || read -r -a profiles <<< "$(sed -E 's/^PROFILES=\((.*)\).*/\1/' <<< "$line")"
    for p in "${profiles[@]}"; do
        if [[ -f "/etc/apparmor.d/containers/$p" ]]; then run apparmor_parser -R "/etc/apparmor.d/containers/$p"; fi
        for f in "/etc/apparmor.d/$p" "/etc/apparmor.d/containers/$p"; do
            [[ ! -e "$f" && ! -L "$f" ]] || run rm -f -- "$f"
        done
    done
    echo '== gVisor runtime'
    if [[ -x /usr/local/bin/runsc ]]; then
        if grep -q '"runsc"' /etc/docker/daemon.json 2>/dev/null; then
            run /usr/local/bin/runsc uninstall
            run systemctl reload docker
        fi
        for f in /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1 /usr/local/bin/gvisor-bin; do
            [[ ! -e "$f" ]] || run rm -rf -- "$f"
        done
    else
        echo '  gVisor not installed in /usr/local/bin'
    fi
    [[ $apply -eq 1 ]] || echo 'Dry run: nothing changed. Re-run with --yes to apply.'
    exit 0
fi

command -v docker >/dev/null 2>&1 || fail 'docker is required'
controller_env="$repo_root/.env"
egress_env="$egress_dir/.env"

# Read everything the report needs now: --state deletes the .env files.
provider_accounts_dir=$(env_value "$controller_env" PROVIDER_ACCOUNTS_DIR)
keep_report=''
for key in CARAPA_BOX_GROUPS_ROOT AGENT_HOME CARAPA_CA_CERTIFICATE; do
    v=$(env_value "$controller_env" "$key"); [[ -z "$v" ]] || keep_report+="  $key=$v"$'\n'
done
for f in "$controller_env" "$egress_env"; do
    IFS=: read -r -a parts <<< "$(env_value "$f" COMPOSE_FILE)"
    for p in "${parts[@]}"; do [[ "$p" != /* ]] || keep_report+="  override outside the checkout: $p"$'\n'; done
done

# Compose projects belong to this install when they run from this checkout,
# or when the controller launched them (stack dir under /app/stacks or the
# host stacks dir, or an agent_egress_<project> network).
stacks_dir=$(env_value "$controller_env" SANDBOX_STACKS_DIR)
[[ -n "$stacks_dir" ]] || stacks_dir="$repo_root/stacks"
declare -A projects=()
while IFS=$'\t' read -r project workdir; do
    [[ -n "$project" ]] || continue
    case "$workdir" in
        # The controller starts egress itself: Compose then records its in-container path.
        "$repo_root"|"$egress_dir"|/app/egress-proxy|/app/egress-deploy|/app/stacks/*|"${stacks_dir%/}"/*) projects[$project]=1 ;;
    esac
done < <(docker ps -a --filter label=com.docker.compose.project \
    --format '{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}' | sort -u)
while IFS= read -r net; do
    [[ -z "$net" ]] || projects[${net#agent_egress_}]=1
done < <(docker network ls --filter name=agent_egress_ --format '{{.Name}}' | grep '^agent_egress_.' || true)

echo "Repository: $repo_root"
[[ $apply -eq 1 ]] || echo 'Dry run: printing the plan only.'
echo '== Containers, networks and volumes'
image_refs=()
if [[ ${#projects[@]} -eq 0 ]]; then echo '  no CarapaBox Compose projects found'; fi
for project in $(printf '%s\n' "${!projects[@]}" | sort); do
    echo "  project $project"
    mapfile -t ids < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
    if [[ ${#ids[@]} -gt 0 ]]; then
        mapfile -t -O "${#image_refs[@]}" image_refs < <(docker inspect --format '{{.Config.Image}}' "${ids[@]}")
        run docker rm -f "${ids[@]}"
    fi
    mapfile -t nets < <( { docker network ls -q --filter "label=com.docker.compose.project=$project"
        docker network ls -q --filter "name=^agent_egress_${project}\$"; } | sort -u)
    [[ ${#nets[@]} -eq 0 ]] || run docker network rm "${nets[@]}"
    mapfile -t vols < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
    [[ ${#vols[@]} -eq 0 ]] || run docker volume rm "${vols[@]}"
done
# Volumes the controller creates to pin sandbox mount sources (bind settings only, no data).
mapfile -t mount_vols < <(docker volume ls -q --filter name=^carapa-mount- | grep '^carapa-mount-' || true)
if [[ ${#mount_vols[@]} -gt 0 ]]; then echo '  sandbox mount volumes'; run docker volume rm "${mount_vols[@]}"; fi

unit="$HOME/.config/systemd/user/carapa-box.service"
if [[ -f "$unit" ]]; then
    echo '== Host-mode systemd user service'
    run systemctl --user disable --now carapa-box.service
    run rm -f -- "$unit"
    run systemctl --user daemon-reload
fi

if [[ $images -eq 1 ]]; then
    echo '== Images'
    image_refs+=(carapa-box:latest carapa-box-ingress:latest carapa-box-opa:latest
        carapa/egress-proxy-squid:latest carapa/egress-proxy-api-relay:latest carapa/egress-proxy-llama-proxy:latest)
    bot_version=$(cat "$repo_root/stacks/carapa-bot/VERSION" 2>/dev/null || true)
    [[ -z "$bot_version" ]] || image_refs+=("carapa-bot:$bot_version" "carapa-bot:$bot_version-alpine")
    for ref in $(printf '%s\n' "${image_refs[@]}" | sort -u); do
        if docker image inspect "$ref" >/dev/null 2>&1; then run docker rmi "$ref"; fi
    done
    # Installed agent CLIs belong to the runtime image they were installed for.
    mapfile -t hvols < <(docker volume ls -q --filter label=ai.carapa.harness-store)
    [[ ${#hvols[@]} -eq 0 ]] || run docker volume rm "${hvols[@]}"
fi

if [[ $secrets -eq 1 ]]; then
    echo '== Secrets'
    for scope in controller egress; do
        env_file=$controller_env compose="$repo_root/docker-compose.yml"
        [[ $scope == controller ]] || { env_file=$egress_env; compose="$egress_dir/docker-compose.yml"; }
        dir=$(env_value "$env_file" SECRETS_DIR)
        if [[ "$dir" != /* ]]; then echo "  $scope: no absolute SECRETS_DIR in $env_file, skipped"; continue; fi
        pattern='file:[[:space:]]*\$\{SECRETS_DIR\}/([A-Za-z0-9_.-]+)'
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" =~ $pattern && -e "$dir/${BASH_REMATCH[1]}" ]]; then run rm -f -- "$dir/${BASH_REMATCH[1]}"; fi
        done < "$compose"
        # Only an emptied directory goes; anything else in it is kept.
        if [[ -d "$dir" ]]; then
            if [[ $apply -eq 1 ]]; then rmdir -- "$dir" 2>/dev/null && echo "  rmdir $dir" || echo "  kept non-empty $dir"
            else echo "  rmdir $dir (if empty)"; fi
        fi
    done
    # Signed-in provider accounts and saved API keys (Board's Provider accounts).
    if [[ "$provider_accounts_dir" == /* && -e "$provider_accounts_dir" ]]; then remove_path "$provider_accounts_dir"; fi
fi

if [[ $state -eq 1 ]]; then
    echo '== Install state'
    # Resolve out-of-checkout dirs before the .env files that name them go.
    extra=()
    # Includes the private-installation layout of docs/installation-data.md.
    for key in CARAPA_BOX_ENV_FILE CARAPA_BOX_CONFIG_HOST_DIR CARAPA_BOX_STATE_HOST_DIR \
        INGRESS_STATE_HOST_DIR NGINX_PROXY_DIR CARAPA_BOX_IPC_HOST_DIR IPC_MOUNT; do
        v=$(env_value "$controller_env" "$key"); [[ -z "$v" ]] || extra+=("$v")
    done
    for f in "$controller_env" "$egress_env"; do
        [[ ! -L "$f" ]] || extra+=("$(readlink -f -- "$f")")
    done
    # Patterns stay quoted here and are expanded only below the checkout.
    patterns=('.env' '.env.bak-*' '.env.*.bak' 'egress-proxy/.env' 'egress-proxy/.env.bak-*'
        'docker-compose.override.*.yml' 'egress-proxy/docker-compose.override.*.yml'
        'config/mount-allowlist.yaml' 'config/policies/*.wasm' 'config/policies/network-base.yaml'
        'egress-proxy/policy.wasm' 'egress-proxy/tool_profiles.jsonc' 'generated' '.cache'
        'stacks/*/.env' 'stacks/*/policy.wasm' 'stacks/*/.harness' 'stacks/*/docker-compose.override.*.yml')
    shopt -s nullglob
    for rel in "${patterns[@]}"; do
        for p in "$repo_root"/$rel; do
            tracked "${p#"$repo_root"/}" || remove_path "$p"
        done
    done
    shopt -u nullglob
    # A deployment outside the checkout (quick installer) keeps its own egress files.
    if [[ "$egress_dir" != "$repo_root/egress-proxy" ]]; then
        shopt -s nullglob
        for p in "$egress_dir"/.env "$egress_dir"/.env.bak-* "$egress_dir"/docker-compose.override*.yml; do remove_path "$p"; done
        shopt -u nullglob
    fi
    for p in "${extra[@]}"; do remove_path "$p"; done
fi

echo '== Not removed'
printf '%s' "$keep_report"
[[ $state -eq 1 ]] || echo '  install state (add --state)'
[[ $secrets -eq 1 ]] || echo '  secrets (add --secrets)'
[[ $images -eq 1 ]] || echo '  images (add --images)'
echo '  AppArmor profiles and gVisor (run separately: sudo bash uninstall.sh --host --yes)'
[[ $apply -eq 1 ]] || echo 'Dry run: nothing changed. Re-run with --yes to apply.'
