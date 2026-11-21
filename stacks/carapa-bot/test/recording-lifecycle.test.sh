#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/work"
printf 'http://nginx:8123/\n' >"$tmp/work/.preview-url"

cat >"$tmp/bin/playwright-cli" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_PW_LOG"
if [ "${FAKE_PW_FAIL:-}" = "${1:-}" ]; then
  echo "simulated $1 failure" >&2
  exit 23
fi
case "${1:-}" in
  open) echo "browser opened" ;;
  snapshot) echo "snapshot ready" ;;
  video-start) echo "Video recording started." ;;
  video-stop) echo "Video saved." ;;
  close) echo "browser closed" ;;
esac
EOF
chmod +x "$tmp/bin/playwright-cli"

export PATH="$tmp/bin:$PATH"
export PLAYWRIGHT_CLI_BIN="$tmp/bin/playwright-cli"
export FAKE_PW_LOG="$tmp/playwright.log"
begin="$root/bin/record-begin.sh"
end="$root/bin/record-end.sh"
daemon="$tmp/daemon"
recordings="$tmp/recordings"

grep -Fq 'PLAYWRIGHT_CLI_BIN:-/usr/local/ai-cli-bin/playwright-cli' "$begin" "$end"

"$end" "$daemon" test-run >"$tmp/no-recording.log" 2>&1
grep -Fq '[record-end] no recording for session test-run' "$tmp/no-recording.log"

if "$begin" >"$tmp/missing.log" 2>&1; then
  echo "record-begin must reject missing arguments" >&2
  exit 1
fi
grep -Fq '[record-begin] missing args' "$tmp/missing.log"

export FAKE_PW_FAIL=open
if "$begin" "$tmp/work" "$recordings" "$daemon" test-run >"$tmp/open.log" 2>&1; then
  echo "record-begin must propagate an open failure" >&2
  exit 1
fi
grep -Fq 'open failed (base http://nginx:8123/): simulated open failure' "$tmp/open.log"
test ! -e "$daemon/.pwcli-recording"

unset FAKE_PW_FAIL
"$begin" "$tmp/work" "$recordings" "$daemon" test-run >"$tmp/begin.log" 2>&1
grep -Fq '[begin] recording ->' "$tmp/begin.log"
test -f "$daemon/.pwcli-recording"

export FAKE_PW_FAIL=video-stop
if "$end" "$daemon" test-run >"$tmp/stop-fail.log" 2>&1; then
  echo "record-end must propagate a video-stop failure" >&2
  exit 1
fi
grep -Fq 'video-stop failed: simulated video-stop failure' "$tmp/stop-fail.log"
test -f "$daemon/.pwcli-recording"

unset FAKE_PW_FAIL
"$end" "$daemon" test-run >"$tmp/end.log" 2>&1
grep -Fq 'Video saved.' "$tmp/end.log"
test ! -e "$daemon/.pwcli-recording"
tail -n 1 "$FAKE_PW_LOG" | grep -Fxq 'close'

printf 'recording lifecycle tests passed\n'
