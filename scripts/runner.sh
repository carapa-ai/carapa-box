#!/bin/sh
# Start carapa-runner after fast-forwarding this checkout (RUNNER_AUTO_UPDATE=0 skips).
cd "$(dirname "$0")/.." || exit 1

# Trust the hub's private CA without a manual env var (Bun ignores the macOS keychain).
root="${CARAPA_RUNNER_ROOT:-$HOME/.carapa-runner}"
ca="$root/carapa-root-ca.crt"
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$ca" ]; then
    export NODE_EXTRA_CA_CERTS="$ca"
fi

if [ "${RUNNER_AUTO_UPDATE:-1}" != "0" ]; then
    old=$(git rev-parse HEAD 2>/dev/null)
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo "carapa-runner: not updating, working tree has local changes" >&2
    elif ! git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
        echo "carapa-runner: not updating, current branch has no upstream" >&2
    elif ! git pull --ff-only >/dev/null 2>&1; then
        echo "carapa-runner: not updating, git pull --ff-only failed (offline or cannot fast-forward)" >&2
    fi
    new=$(git rev-parse HEAD 2>/dev/null)
    if [ "$old" != "$new" ] && ! git diff --quiet "$old" "$new" -- bun.lock; then
        bun install --frozen-lockfile || { echo "carapa-runner: bun install failed" >&2; exit 1; }
    fi
fi

echo "carapa-runner $(git rev-parse --short HEAD 2>/dev/null)"
exec bun run src/runner/main.ts "$@"
