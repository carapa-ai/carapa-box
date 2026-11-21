#!/bin/bash
# Verifies before-start.sh passes GIT_REPO / branch to the git container as
# positional arguments (no shell injection). Fake docker/git/bun, no real docker.
# Run: bash stacks/carapa-bot/test/before-start-injection.test.sh
set -uo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/ws" "$T/sshsrc" "$T/home"

cat > "$T/bin/bun" <<'F'
#!/bin/bash
exit 0
F
# Fake git: log each argument on its own line, then a separator.
cat > "$T/bin/git" <<'F'
#!/bin/bash
{ printf 'git'; for a in "$@"; do printf '\t%s' "$a"; done; printf '\n'; } >> "$FAKE_GIT_LOG"
exit 0
F
# Fake docker: runs the `-c` script locally (as sh would in the container).
cat > "$T/bin/docker" <<'F'
#!/bin/bash
case "$1" in volume) exit 0 ;; esac
args=("$@")
for i in "${!args[@]}"; do
    if [ "${args[$i]}" = "-c" ]; then
        script="${args[$((i+1))]}"
        rest=("${args[@]:$((i+2))}")
        case "$script" in
            *"ls -A"*) echo "${FAKE_EMPTY:-yes}"; exit 0 ;;
        esac
        script=${script//\/root\/.ssh/$FAKE_ROOT/ssh}
        script=${script//\/tmp\/ssh-source/$FAKE_ROOT/sshsrc}
        script=${script//cd \/workspace/cd $FAKE_ROOT/ws}
        HOME="$FAKE_ROOT/home" exec sh -c "$script" "${rest[@]}"
    fi
done
exit 0
F
chmod +x "$T/bin/"*

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

run() { # repo branch empty ssh(yes/no)
    : > "$T/git.log"
    rm -f "$T/marker"
    local keys="$T/nonexistent"
    [ "$4" = yes ] && keys="$T/sshsrc"
    ( cd "$root" && PATH="$T/bin:$PATH" FAKE_ROOT="$T" FAKE_GIT_LOG="$T/git.log" FAKE_EMPTY="$3" \
        COMPOSE_PROJECT_NAME=t SSH_KEYS_FOLDER="$keys" GIT_REPO="$1" DEFAULT_BRANCH="$2" \
        bash ./before-start.sh ) >"$T/out" 2>"$T/err"
}

# (a) injection payload with whitespace is rejected, nothing executes
if run "https://example.com/r.git $T/x; touch $T/marker; echo" main yes no; then fail "(a) payload accepted"; fi
[ ! -e "$T/marker" ] || fail "(a) marker created"
if run "-oProxyCommand=touch$T/marker" main yes no; then fail "(a) option-like repo accepted"; fi
if run "https://example.com/r.git" "-x" yes no; then fail "(a) option-like branch accepted"; fi
[ ! -s "$T/git.log" ] || fail "(a) git invoked for rejected input"

# (b) single-token metacharacters are inert, delivered as ONE argument
for ssh in no yes; do
    payload="https://example.com/r.git;touch$T/marker"
    run "$payload" main yes "$ssh" || fail "(b) run failed (ssh=$ssh)"
    [ ! -e "$T/marker" ] || fail "(b) marker created (ssh=$ssh)"
    grep -qxF "$(printf 'git\t-c\tcore.hooksPath=/dev/null\tclone\t--\t%s\t/workspace' "$payload")" "$T/git.log" \
        || { cat "$T/git.log" >&2; fail "(b) not passed as one argument (ssh=$ssh)"; }
    payload='https://example.com/$(touch'"$T"'/marker).git'
    run "$payload" main yes "$ssh" || fail "(b) \$() run failed (ssh=$ssh)"
    [ ! -e "$T/marker" ] || fail "(b) \$() marker created (ssh=$ssh)"
done

# (c) normal URL + branch still clone and pull
for ssh in no yes; do
    run "https://example.com/r.git" feature/x yes "$ssh" || fail "(c) clone failed (ssh=$ssh)"
    grep -qxF "$(printf 'git\t-c\tcore.hooksPath=/dev/null\tclone\t--\thttps://example.com/r.git\t/workspace')" "$T/git.log" || fail "(c) clone args (ssh=$ssh)"
    run "https://example.com/r.git" feature/x no "$ssh" || fail "(c) existing-repo run failed (ssh=$ssh)"
done

# (d) existing repo: no fetch/pull, no root container with keys, message printed
: > "$T/docker.log"
cat > "$T/bin/docker" <<'F'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in volume) exit 0 ;; esac
case "$*" in *"ls -A"*) echo "${FAKE_EMPTY:-no}" ;; esac
exit 0
F
for ssh in no yes; do
    : > "$T/docker.log"; : > "$T/git.log"
    keys="$T/nonexistent"; [ "$ssh" = yes ] && keys="$T/sshsrc"
    ( cd "$root" && PATH="$T/bin:$PATH" FAKE_DOCKER_LOG="$T/docker.log" FAKE_GIT_LOG="$T/git.log" \
        COMPOSE_PROJECT_NAME=t SSH_KEYS_FOLDER="$keys" GIT_REPO=https://example.com/r.git \
        bash ./before-start.sh ) >"$T/out" 2>"$T/err" || fail "(d) exit nonzero (ssh=$ssh)"
    grep -q 'existing repo: not updating on start' "$T/out" || fail "(d) message missing (ssh=$ssh)"
    ! grep -Eq 'fetch|pull' "$T/docker.log" "$T/git.log" || fail "(d) fetch/pull recorded (ssh=$ssh)"
    ! grep -q 'ssh-source' "$T/docker.log" || fail "(d) keys mounted (ssh=$ssh)"
done

# (f) SSH-style URL: fails closed before any docker run / key mount
for ssh in no yes; do
    : > "$T/docker.log"; : > "$T/git.log"
    keys="$T/nonexistent"; [ "$ssh" = yes ] && keys="$T/sshsrc"
    if ( cd "$root" && PATH="$T/bin:$PATH" FAKE_EMPTY=yes FAKE_DOCKER_LOG="$T/docker.log" FAKE_GIT_LOG="$T/git.log" \
        COMPOSE_PROJECT_NAME=t SSH_KEYS_FOLDER="$keys" GIT_REPO=git@example.com:o/r.git \
        bash ./before-start.sh ) >"$T/out" 2>"$T/err"; then fail "(f) ssh URL accepted (ssh=$ssh)"; fi
    grep -q 'SSH-keyed clone is not supported' "$T/err" || fail "(f) message missing (ssh=$ssh)"
    ! grep -q 'ssh-source\|chown\|alpine/git' "$T/docker.log" || fail "(f) container started (ssh=$ssh)"
done

# (e) no safe.directory "*" or git pull anywhere in the GIT_REPO branch
! grep -Eq 'safe\.directory|git pull' "$root/before-start.sh" || fail "(e) forbidden string present"

printf 'before-start injection tests passed\n'
