#!/bin/sh
# record-end.sh — stop board-owned playwright recording (carapa-board via sandbox_exec).
#
# Usage: record-end.sh <daemonDir> <pwSession> [managedRunId]

set +e

DAEMON_DIR="${1:-}"
PW_SESSION="${2:-}"
PW_CLI="${PLAYWRIGHT_CLI_BIN:-$(dirname "$0")/playwright-cli}"

if [ -z "$DAEMON_DIR" ]; then
  echo "[record-end] missing daemonDir" >&2
  exit 2
fi

if [ -z "$PW_SESSION" ]; then
  _base="$(basename "$DAEMON_DIR")"
  PW_SESSION="${_base#pwcli-}"
fi

export PLAYWRIGHT_DAEMON_SESSION_DIR="$DAEMON_DIR"
export PLAYWRIGHT_DAEMON_SOCKETS_DIR="$DAEMON_DIR/sockets"
export PLAYWRIGHT_CLI_SESSION="$PW_SESSION"
if [ -n "${3:-}" ]; then
  export CARAPA_BROWSER_RUN_ID="$3"
  _browser_bin=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  _browser_cwd=$(node -e 'process.stdout.write(require(process.argv[1]).readRun(process.argv[2]).cwd)' "$_browser_bin/browser-session.cjs" "$3") || exit 1
  cd "$_browser_cwd" || exit 1
fi
# Finalization must reach the real CLI even if an exec environment happens to
# inherit the recording-stage flag from the agent process.
unset CARAPA_RECORD
export CARAPA_RECORD_BOOTSTRAP=1

if [ ! -f "$DAEMON_DIR/.pwcli-recording" ]; then
  echo "[record-end] no recording for session $PW_SESSION"
  exit 0
fi

_video_log="$(mktemp)"
if ! "$PW_CLI" video-stop >"$_video_log" 2>&1; then
  echo "[record-end] video-stop failed: $(cat "$_video_log" 2>/dev/null)" >&2
  rm -f "$_video_log"
  exit 1
fi
cat "$_video_log"
rm -f "$_video_log" "$DAEMON_DIR/.pwcli-recording"
"$PW_CLI" close >/dev/null 2>&1 || true
# CarapaBoard trims the trailing idle tail after persisting the recording.
exit 0
