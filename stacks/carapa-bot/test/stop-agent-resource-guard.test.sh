#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
run_dir="$tmp/run-stop-resource-guard-$$"
mkdir -p "$run_dir"
# Model a process-group member that remains after its agent leader exits.
child_pid_file="$tmp/child.pid"
setsid sh -c 'sleep 60 & echo $! > "$1"' sh "$child_pid_file" &
leader=$!
wait "$leader"
escapee=$(cat "$child_pid_file")
trap 'kill "$escapee" 2>/dev/null || true; if [[ -n "${reused_pid:-}" ]]; then kill "$reused_pid" 2>/dev/null || true; fi; rm -rf "$tmp"' EXIT

printf '999999999' > "$run_dir/pid"
printf '%s' "$leader" > "$run_dir/pgid"
"$root/bin/stop-agent.sh" "$run_dir" >/dev/null

for _ in $(seq 1 50); do
  kill -0 "$escapee" 2>/dev/null || break
  sleep 0.02
done
if kill -0 "$escapee" 2>/dev/null; then
  printf 'process-group member survived already-dead cleanup\n' >&2
  exit 1
fi

wait "$escapee" 2>/dev/null || true

# A dead persistent daemon must not erase the provider's resumable history.
preserve_run="$tmp/run-preserve-session"
preserve_session="$tmp/session-preserved"
mkdir -p "$preserve_run" "$preserve_session/codex-home"
printf '%s' "$preserve_session" > "$preserve_run/session_dir"
printf '999999998' > "$preserve_run/pid"
printf '999999998' > "$preserve_session/daemon.pid"
printf 'thread-survives' > "$preserve_session/thread_id"
printf 'provider-state-survives' > "$preserve_session/codex-home/state"
"$root/bin/stop-agent.sh" "$preserve_run" >/dev/null
[ "$(cat "$preserve_session/thread_id")" = "thread-survives" ]
[ "$(cat "$preserve_session/codex-home/state")" = "provider-state-survives" ]
[ ! -e "$preserve_session/daemon.pid" ]

# Only an explicit controller marker may discard a confirmed poisoned session.
discard_run="$tmp/run-discard-session"
discard_session="$tmp/session-discarded"
mkdir -p "$discard_run" "$discard_session/codex-home"
printf '%s' "$discard_session" > "$discard_run/session_dir"
printf '999999997' > "$discard_run/pid"
printf '999999997' > "$discard_session/daemon.pid"
printf 'poisoned-thread' > "$discard_session/thread_id"
printf 'unresumable_session\n' > "$discard_run/discard_session"
"$root/bin/stop-agent.sh" "$discard_run" >/dev/null
[ ! -e "$discard_session" ]

# A sweep from a prior container generation must not signal a reused PID in
# the automatically restarted container.
sleep 60 &
reused_pid=$!
stale_run="$tmp/run-stale-container"
stale_session="$tmp/session-stale-container"
mkdir -p "$stale_run" "$stale_session"
printf '%s' "$stale_session" > "$stale_run/session_dir"
printf 'stale-container-instance' > "$stale_run/session_instance"
printf '999999996' > "$stale_run/pid"
printf '%s' "$reused_pid" > "$stale_session/daemon.pid"
"$root/bin/stop-agent.sh" "$stale_run" >/dev/null
kill -0 "$reused_pid"
kill "$reused_pid"
wait "$reused_pid" 2>/dev/null || true

trap - EXIT
rm -rf "$tmp"
printf 'Stop-agent resource guard tests passed\n'
