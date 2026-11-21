#!/usr/bin/env bash
# Ubuntu/Debian operator-host prerequisites. Default is a read-only check.
set -euo pipefail
prereq_cleanup_path=''

usage() {
    cat <<'EOF'
Usage: bash install-prerequisites.sh [--check | --install] [--mode container|host]

Default: --check --mode container. Check exits 1 if required tools are missing.
--install installs missing prerequisites on Ubuntu/Debian using apt and sudo.
Container mode: Docker Engine/Compose/Buildx, AppArmor tools, Git, curl, OpenSSL, CA certificates.
Host mode also installs Bun and OPA for the invoking user under ~/.bun and ~/.local/bin.
Existing Docker installations are preserved. No automatic package removals,
Docker daemon configuration changes, group membership changes or registry login.
Package installation may start a newly installed Docker service.
EOF
}
fail() { printf 'prerequisites: %s\n' "$*" >&2; return 1; }
has_tool() { command -v "$1" >/dev/null 2>&1 || [[ -x "/usr/sbin/$1" || -x "/sbin/$1" ]]; }
package_installed() { [[ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" == 'install ok installed' ]]; }
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
apt_install() { as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade --no-remove "$@"; }
load_os() {
    [[ "$(uname -s)" == Linux && -r /etc/os-release ]] || { fail 'automatic installation supports Ubuntu/Debian Linux hosts'; return 1; }
    # Trusted, OS-owned metadata; never source project .env files.
    . /etc/os-release
    distro=${ID:-}
    codename=${VERSION_CODENAME:-}
    [[ "$distro" == ubuntu || "$distro" == debian ]] || { fail 'automatic installation supports Ubuntu/Debian; install prerequisites manually on this OS'; return 1; }
    [[ "$codename" =~ ^[a-z][a-z0-9-]*$ ]] || { fail 'could not determine a valid distribution codename'; return 1; }
}
repository_configured() {
    grep -Rqs "download.docker.com/linux/$distro" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null
}
configure_docker_repository() {
    if repository_configured; then return; fi
    local arch
    arch=$(dpkg --print-architecture)
    curl -q -fsSL --retry 2 --connect-timeout 15 --max-time 120 \
        "https://download.docker.com/linux/$distro/gpg" -o "$scratch/docker.asc"
    [[ -s "$scratch/docker.asc" ]] || { fail 'Docker signing-key download is empty'; return 1; }
    cat > "$scratch/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/carapa-docker.asc
EOF
    # Do not overwrite an operator-owned source or key with this name.
    [[ ! -e /etc/apt/sources.list.d/carapa-docker.sources && ! -e /etc/apt/keyrings/carapa-docker.asc ]] || { fail 'existing carapa-docker apt files need operator reconciliation'; return 1; }
    as_root install -d -m 0755 /etc/apt/keyrings
    as_root install -m 0644 "$scratch/docker.asc" /etc/apt/keyrings/carapa-docker.asc
    as_root install -m 0644 "$scratch/docker.sources" /etc/apt/sources.list.d/carapa-docker.sources
    as_root apt-get update
}
package_available() {
    apt-cache policy "$1" 2>/dev/null | awk '$1 == "Candidate:" && $2 != "(none)" { found = 1 } END { exit !found }'
}
# Sets plugin_packages to the Compose/Buildx packages matching the installed engine.
engine_plugin_packages() {
    local compose=docker-compose-plugin buildx=docker-buildx-plugin
    plugin_packages=()
    docker compose version >/dev/null 2>&1 && compose='' || true
    docker buildx version >/dev/null 2>&1 && buildx='' || true
    [[ -n "$compose$buildx" ]] || return 0
    if package_installed docker.io; then
        [[ -z "$compose" ]] || compose=docker-compose-v2
        [[ -z "$buildx" ]] || buildx=docker-buildx
    elif ! package_installed docker-ce-cli; then
        fail 'Docker is not from docker.io or Docker CE apt packages; install Compose v2/Buildx for that installation manually (nothing changed)'; return 1
    fi
    [[ -z "$compose" ]] || plugin_packages+=("$compose")
    [[ -z "$buildx" ]] || plugin_packages+=("$buildx")
    as_root apt-get update
    for package in "${plugin_packages[@]}"; do
        package_available "$package" || { fail "apt package $package is not available for this Docker installation; install Compose v2/Buildx manually or reconcile Docker (nothing changed)"; return 1; }
    done
}
missing_requirements() {
    missing=()
    local tool
    for tool in curl git openssl apparmor_parser aa-status; do
        has_tool "$tool" || missing+=("$tool")
    done
    package_installed ca-certificates || missing+=(ca-certificates)
    if ! has_tool docker; then
        missing+=(docker)
    else
        docker compose version >/dev/null 2>&1 || missing+=(docker-compose)
        docker buildx version >/dev/null 2>&1 || missing+=(docker-buildx)
    fi
    if [[ "$mode" == host ]]; then
        has_tool bun || missing+=(bun)
        has_tool opa || missing+=(opa)
    fi
}
install_host_tools() {
    if ! has_tool bun; then
        # Bun's official installer runs as the invoking account, not sudo.
        curl -q -fsSL --retry 2 --connect-timeout 15 --max-time 120 https://bun.com/install -o "$scratch/bun-install.sh"
        BUN_INSTALL="$HOME/.bun" bash "$scratch/bun-install.sh"
    fi
    if ! has_tool opa; then
        local arch binary version expected actual
        case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) fail 'host OPA install supports amd64/arm64'; return 1 ;; esac
        version=${OPA_VERSION:-v1.14.1} # Match the repository build.sh default.
        [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { fail 'OPA_VERSION must be a release such as v1.14.1'; return 1; }
        binary="opa_linux_${arch}_static"
        curl -q -fsSL --retry 2 --connect-timeout 15 --max-time 180 "https://openpolicyagent.org/downloads/$version/$binary" -o "$scratch/$binary"
        curl -q -fsSL --retry 2 --connect-timeout 15 --max-time 120 "https://openpolicyagent.org/downloads/$version/$binary.sha256" -o "$scratch/opa.sha256"
        read -r expected _ < "$scratch/opa.sha256"
        actual=$(sha256sum "$scratch/$binary"); actual=${actual%% *}
        [[ "$expected" =~ ^[a-fA-F0-9]{64}$ && "$actual" == "$expected" ]] || { fail 'OPA checksum verification failed'; return 1; }
        mkdir -p "$HOME/.local/bin"
        install -m 0755 "$scratch/$binary" "$HOME/.local/bin/opa"
    fi
}
ensure_operator_host() {
    if [[ -f /.dockerenv || -f /run/.containerenv ]]; then
        fail 'run prerequisite installation on the operator host, not in a container'; return 1
    fi
}
main() {
    local action=check mode=container distro='' codename='' scratch='' missing=() packages=() plugin_packages=() tool package docker_missing=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check) action=check; shift ;;
            --install) action=install; shift ;;
            --mode) [[ $# -ge 2 ]] || { fail '--mode requires container or host'; return 1; }; mode=$2; shift 2 ;;
            --help|-h) usage; return ;;
            *) fail "unknown option: $1"; return 1 ;;
        esac
    done
    [[ "$mode" == container || "$mode" == host ]] || { fail '--mode must be container or host'; return 1; }
    load_os
    # Discover an existing per-user Bun/OPA installation without reinstalling it.
    export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
    missing_requirements
    if [[ ${#missing[@]} -eq 0 ]]; then
        echo "Prerequisite tools are present ($mode mode)."
    else
        printf 'Missing:'; printf ' %s' "${missing[@]}"; printf '\n'
        if [[ "$action" == check ]]; then return 1; fi
        ensure_operator_host
        if [[ "$mode" == host && -n "${SUDO_USER:-}" ]]; then
            fail 'run without sudo; the script elevates apt only and installs Bun/OPA for your account'; return 1
        fi
        [[ $EUID -eq 0 ]] || { has_tool sudo || { fail 'sudo or root is required for apt'; return 1; }; }
        has_tool docker || docker_missing=true
        if [[ "$docker_missing" == true ]]; then
            for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
                if package_installed "$package"; then fail "conflicting package $package is installed; reconcile Docker manually (nothing removed)"; return 1; fi
            done
        fi
        # Select only missing packages; apt is never used as a general upgrade.
        has_tool curl || packages+=(curl)
        has_tool git || packages+=(git)
        has_tool openssl || packages+=(openssl)
        package_installed ca-certificates || packages+=(ca-certificates)
        has_tool apparmor_parser || packages+=(apparmor)
        has_tool aa-status || packages+=(apparmor-utils)
        if [[ "$mode" == host ]]; then has_tool unzip || packages+=(unzip); fi
        # Validate the existing engine's plugin packages before the first apt
        # install, so an unsupported Docker source fails with nothing installed.
        if [[ "$docker_missing" != true ]]; then engine_plugin_packages; fi
        if [[ ${#packages[@]} -gt 0 ]]; then as_root apt-get update; apt_install "${packages[@]}"; fi
        scratch=$(mktemp -d "${TMPDIR:-/tmp}/carapabox-prereqs.XXXXXX")
        prereq_cleanup_path=$scratch
        trap 'rm -rf -- "${prereq_cleanup_path:-}"' EXIT
        if [[ "$docker_missing" == true ]]; then
            configure_docker_repository
            apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        else
            # Use the existing engine's package source and names; don't switch a
            # Desktop/distro/rootless installation to Docker CE implicitly.
            if [[ ${#plugin_packages[@]} -gt 0 ]]; then
                apt_install "${plugin_packages[@]}"
            fi
        fi
        if [[ "$mode" == host ]]; then install_host_tools; fi
        rm -rf -- "$scratch"
        scratch=''
        prereq_cleanup_path=''
        trap - EXIT
        hash -r
        missing_requirements
        [[ ${#missing[@]} -eq 0 ]] || { fail "still missing: ${missing[*]}"; return 1; }
        echo "Prerequisite tools installed ($mode mode)."
    fi
    echo 'Next: verify docker info as the operator, then docker login dhi.io.'
    echo 'Load repository AppArmor profiles during setup; package presence does not prove kernel support.'
    if [[ "$mode" == host ]]; then echo 'For future shells, include ~/.bun/bin and ~/.local/bin in PATH.'; fi
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
