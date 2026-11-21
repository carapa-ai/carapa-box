#!/usr/bin/env bash
# Tests command dispatch with fake package/network operations; never installs.
set -euo pipefail
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/carapabox-prereqs-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/tmp"
cat > "$fixture/runner.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
source "$SCRIPTS/install-prerequisites.sh"
git_ready=false
engine_ready=true
host_ready=false
plugins_ready=true
[[ "$CASE" != fresh && "$CASE" != conflict ]] || engine_ready=false
[[ "$CASE" != distro* && "$CASE" != unknown_engine ]] || plugins_ready=false
load_os() { distro=ubuntu; codename=noble; }
ensure_operator_host() { :; } # All system/network actions below are fixtures.
has_tool() {
    case "$1" in
        git) [[ "$git_ready" == true ]] ;;
        docker) [[ "$engine_ready" == true ]] ;;
        bun|opa) [[ "$host_ready" == true ]] ;;
        *) return 0 ;;
    esac
}
package_installed() {
    [[ "$1" == ca-certificates ]] || [[ "$CASE" == conflict && "$1" == runc ]] || [[ "$CASE" == distro* && "$1" == docker.io ]]
}
package_available() { [[ "$CASE" != distro_unavailable ]]; }
docker() { [[ "$engine_ready" == true && "$plugins_ready" == true && ( "$1" == compose || "$1" == buildx ) ]]; }
repository_configured() { return 1; }
dpkg() { [[ "$1" == --print-architecture ]]; echo amd64; }
curl() {
    printf 'download %s\n' "$*" >> "$LOG"
    while [[ $# -gt 0 ]]; do
        if [[ "$1" == -o ]]; then printf 'fixture-public-key\n' > "$2"; return; fi
        shift
    done
    exit 80
}
as_root() {
    printf '%s\n' "$*" >> "$LOG"
    case "$*" in
        'apt-get update') return ;;
        'install -d -m 0755 /etc/apt/keyrings') return ;;
        install\ -m\ 0644*)
            # Read the staged source to check its contents without writing /etc.
            if [[ "$4" == */docker.sources ]]; then
                grep -q 'URIs: https://download.docker.com/linux/ubuntu' "$4"
                grep -q 'Signed-By: /etc/apt/keyrings/carapa-docker.asc' "$4"
            fi
            return ;;
        'env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade --no-remove '* )
            if [[ "$CASE" == apt_failure ]]; then return 42; fi
            [[ " $* " != *' git '* ]] || git_ready=true
            [[ " $* " != *' docker-ce '* ]] || engine_ready=true
            [[ " $* " != *' docker-compose-v2 docker-buildx '* ]] || plugins_ready=true
            return ;;
        *) echo 'Unexpected privileged command' >&2; exit 81 ;;
    esac
}
install_host_tools() { echo 'host-tools' >> "$LOG"; host_ready=true; }
case "$CASE" in
    check) main --check ;;
    host) main --install --mode host ;;
    repeat) main --install; main --install ;;
    *) main --install ;;
esac
RUN
for scenario in check conflict apt_failure fresh repeat host distro distro_unavailable unknown_engine; do
    : > "$fixture/log"
    if CASE="$scenario" SCRIPTS="$scripts" LOG="$fixture/log" TMPDIR="$fixture/tmp" \
        bash "$fixture/runner.sh" > "$fixture/output" 2>&1; then
        [[ "$scenario" == fresh || "$scenario" == repeat || "$scenario" == host || "$scenario" == distro ]]
    else
        code=$?
        [[ "$scenario" == check || "$scenario" == conflict || "$scenario" == apt_failure || "$scenario" == distro_unavailable || "$scenario" == unknown_engine ]]
        [[ "$scenario" != apt_failure || "$code" == 42 ]]
    fi
    case "$scenario" in
        check|conflict) [[ ! -s "$fixture/log" ]] ;;
        fresh) grep -q 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' "$fixture/log" ;;
        repeat) [[ "$(grep -c 'apt-get install' "$fixture/log")" == 1 ]]; if grep -q 'docker-ce\|download' "$fixture/log"; then exit 1; fi ;;
        host) grep -q '^host-tools$' "$fixture/log"; if grep -q 'docker-ce' "$fixture/log"; then exit 1; fi ;;
        distro) grep -q 'docker-compose-v2 docker-buildx$' "$fixture/log"; if grep -q 'docker-ce\|-plugin\|download' "$fixture/log"; then exit 1; fi ;;
        distro_unavailable) grep -q 'docker-compose-v2 is not available' "$fixture/output"; if grep -q 'apt-get install' "$fixture/log"; then exit 1; fi ;;
        unknown_engine) grep -q 'install Compose v2/Buildx' "$fixture/output"; if grep -q 'apt-get install' "$fixture/log"; then exit 1; fi ;;
    esac
    if grep -q 'systemctl\|usermod\|apt-get remove\|apt-get upgrade' "$fixture/log"; then exit 1; fi
    [[ -z "$(ls -A "$fixture/tmp")" ]]
done
echo 'PASS: prerequisite check/no-op, fresh install dispatch, host tools, conflict refusal, distro docker.io plugins and apt failure propagation.'
