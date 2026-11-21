#!/bin/bash
# Fixed, rootless SSH control surface invoked by CarapaBox and the entrypoint.
set -euo pipefail
umask 077

[[ $(id -u) == 1000 && $(id -un) == ubuntu ]] || {
  echo 'SSH must run as ubuntu (uid 1000)' >&2
  exit 1
}
state=/workspace/ipc/ssh
runtime=/tmp/carapa-ssh
mkdir -p "$state" "$runtime"
# lock-open begin
# The agent owns $runtime, so control.lock may be a FIFO: opening one for
# writing blocks forever, before the bounded flock below. Replace anything that
# is not a plain file, open read-write (never blocks on a FIFO) and recheck
# what was actually opened.
lock="$runtime/control.lock"
if [[ -L $lock || ( -e $lock && ! -f $lock ) ]]; then rm -f -- "$lock"; fi
exec 9<>"$lock"
[[ -f /dev/fd/9 ]] || { echo 'SSH control lock is not a regular file' >&2; exit 1; }
# lock-open end
flock -w 10 9

enabled() {
  if [[ -f "$state/enabled" ]]; then
    [[ $(cat "$state/enabled") == 1 ]]
  else
    [[ ${ENABLE_SSHD:-0} == 1 ]]
  fi
}

running() {
  local pid
  [[ -s "$runtime/dropbear.pid" ]] || return 1
  read -r pid < "$runtime/dropbear.pid"
  [[ $pid =~ ^[0-9]+$ && $pid -gt 1 ]] || return 1
  [[ $(readlink "/proc/$pid/exe" 2>/dev/null) == /usr/sbin/dropbear ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # 08AE = 2222. Check that the listener, not merely a surviving session, exists.
  awk '$2 ~ /:08AE$/ && $4 == "0A" { found=1 } END { exit !found }' /proc/net/tcp
}

status() {
  local wanted=false active=false
  if enabled; then wanted=true; fi
  if running; then active=true; fi
  printf '{"enabled":%s,"running":%s}\n' "$wanted" "$active"
}

start() {
  if [[ ! -r /etc/shells ]] || ! grep -Fxq /bin/bash /etc/shells; then
    echo 'SSH requires /bin/bash in /etc/shells; rebuild and recreate the sandbox with the updated image' >&2
    return 1
  fi
  if ! running; then
    [[ -s /home/ubuntu/.ssh/authorized_keys ]] || {
      echo 'Add a public key to AGENT_HOME/.ssh/authorized_keys before enabling SSH' >&2
      return 1
    }
    [[ -x /usr/sbin/dropbear ]] || {
      echo 'Rebuild the sandbox image with Dropbear support' >&2
      return 1
    }
    if [[ ! -s "$state/host_key" ]]; then
      /usr/bin/dropbearkey -t ed25519 -f "$state/host_key" >&2
    fi
    # Do not inherit the control lock. Local forwarding supports Remote-SSH;
    # remote forwarding, passwords and root logins are disabled.
    /usr/sbin/dropbear -F -E -s -w -k -K 30 -p 0.0.0.0:2222 \
      -P "$runtime/dropbear.pid" -r "$state/host_key" \
      </dev/null >"$runtime/daemon.log" 2>&1 9>&- &
    local launched=$!
    for ((i=0; i<40; i++)); do
      if running; then break; fi
      if ! kill -0 "$launched" 2>/dev/null; then break; fi
      sleep 0.05
    done
    if ! running; then
      kill "$launched" 2>/dev/null || true
      cat "$runtime/daemon.log" >&2
      return 1
    fi
  fi
  printf '1\n' > "$state/enabled"
}

stop() {
  printf '0\n' > "$state/enabled"
  # This sandbox has one managed Dropbear service. Closing its session
  # processes also disconnects existing SSH clients when access is disabled.
  pkill -TERM -u 1000 -x dropbear || true
  for ((i=0; i<40; i++)); do
    if ! pgrep -u 1000 -x dropbear >/dev/null; then break; fi
    sleep 0.05
  done
  pkill -KILL -u 1000 -x dropbear || true
  rm -f "$runtime/dropbear.pid"
}

case "${1:-status}" in
  init) if enabled; then start; fi ;;
  start) start ;;
  stop) stop ;;
  status) ;;
  *) echo 'Expected init, start, stop, or status' >&2; exit 2 ;;
esac
status
