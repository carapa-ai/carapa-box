#!/bin/sh
# record-begin.sh — board-owned recording bootstrap (carapa-board via sandbox_exec).
#
# Usage: record-begin.sh <workDir> <recDir> <daemonDir> <pwSession>
#
# Self-contained: does NOT delegate to the worktree's begin.sh (stale copies there
# suppress errors and arm the shim even when open/video-start failed). pwSession and
# daemon paths are passed as argv so we never depend on docker compose exec -e.

set +e

WORK_DIR="${1:-}"
REC_DIR="${2:-}"
DAEMON_DIR="${3:-}"
PW_SESSION="${4:-}"
PW_CLI="${PLAYWRIGHT_CLI_BIN:-/usr/local/ai-cli-bin/playwright-cli}"

if [ -z "$WORK_DIR" ] || [ -z "$REC_DIR" ] || [ -z "$DAEMON_DIR" ]; then
  echo "[record-begin] missing args (workDir recDir daemonDir pwSession)" >&2
  exit 2
fi

# pwSession defaults to branch slug (strip /tmp/pwcli-<branch> prefix).
if [ -z "$PW_SESSION" ]; then
  _base="$(basename "$DAEMON_DIR")"
  PW_SESSION="${_base#pwcli-}"
fi

export PLAYWRIGHT_DAEMON_SESSION_DIR="$DAEMON_DIR"
export PLAYWRIGHT_DAEMON_SOCKETS_DIR="$DAEMON_DIR/sockets"
export PLAYWRIGHT_CLI_SESSION="$PW_SESSION"
unset CARAPA_RECORD
export CARAPA_RECORD_BOOTSTRAP=1

rm -f /tmp/.pwcli-recording "$DAEMON_DIR/.pwcli-recording"
rm -rf "$DAEMON_DIR" "$DAEMON_DIR/sockets"
mkdir -p "$DAEMON_DIR/sockets" "$DAEMON_DIR"
mkdir -p "$REC_DIR"

cd "$WORK_DIR" || {
  echo "[record-begin] cd failed: $WORK_DIR" >&2
  exit 1
}

# Preview base URL — same resolution as begin.sh / login.sh.
PREVIEW_FILE=".preview-url"
if [ ! -f "$PREVIEW_FILE" ]; then
  _top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$_top" ] && [ -f "$_top/.preview-url" ] && PREVIEW_FILE="$_top/.preview-url"
fi
if [ -f "$PREVIEW_FILE" ]; then
  BASE="$(tr -d '[:space:]' < "$PREVIEW_FILE")"
elif node -e "require('dns').lookup('nginx', e => process.exit(e ? 1 : 0))"; then
  BASE="http://nginx/"
else
  echo "[record-begin] no .preview-url in $WORK_DIR and no nginx service in this sandbox" >&2
  exit 1
fi
BASE="${BASE%/}/"

echo "[record-begin] session=$PW_SESSION base=$BASE rec=$REC_DIR"

_open_log="$(mktemp)"
if ! "$PW_CLI" open "$BASE" >"$_open_log" 2>&1; then
  echo "[record-begin] open failed (base $BASE): $(cat "$_open_log" 2>/dev/null)" >&2
  rm -f "$_open_log"
  exit 1
fi
cat "$_open_log"
rm -f "$_open_log"

# sandbox_exec returns before the daemon is ready — poll snapshot.
_i=0
while [ "$_i" -lt 30 ]; do
  if "$PW_CLI" snapshot >/dev/null 2>&1; then
    break
  fi
  _i=$((_i + 1))
  sleep 1
done
if [ "$_i" -ge 30 ]; then
  echo "[record-begin] browser not ready after open (session $PW_SESSION)" >&2
  "$PW_CLI" close >/dev/null 2>&1 || true
  exit 1
fi

# Cosmetic cursor overlay (ignore failure).
_cursor=".agent/skills/playwright-cli/scripts/cursor.js"
[ -f "$_cursor" ] && "$PW_CLI" run-code --filename="$_cursor" 2>/dev/null || true

_video_log="$(mktemp)"
if ! "$PW_CLI" video-start "$REC_DIR/session.webm" >"$_video_log" 2>&1; then
  echo "[record-begin] video-start failed: $(cat "$_video_log" 2>/dev/null)" >&2
  rm -f "$_video_log"
  "$PW_CLI" close >/dev/null 2>&1 || true
  exit 1
fi
cat "$_video_log"
rm -f "$_video_log"

: > "$DAEMON_DIR/.pwcli-recording"
echo "[begin] recording -> $REC_DIR/session.webm (base $BASE)"
exit 0
