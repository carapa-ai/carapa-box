#!/bin/bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/../bin" && pwd)/carapa-delegate"
TMP="$(mktemp -d /tmp/carapa-delegate-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# The script finds run-agent.sh next to itself, so copy it beside a stub that
# records any invocation. A fake curl on PATH records any network call.
mkdir -p "$TMP/bin" "$TMP/fakebin" "$TMP/runs" "$TMP/tmp" "$TMP/work"
cp "$SCRIPT" "$TMP/bin/carapa-delegate"
printf '#!/bin/bash\necho run-agent >>"%s/calls"\n' "$TMP" >"$TMP/bin/run-agent.sh"
printf '#!/bin/bash\necho curl >>"%s/calls"\nexit 7\n' "$TMP" >"$TMP/fakebin/curl"
chmod +x "$TMP/bin/carapa-delegate" "$TMP/bin/run-agent.sh" "$TMP/fakebin/curl"
printf 'review this\n' >"$TMP/prompt.txt"

# Project values that would inject into the board URL path or query are refused
# with exit 2 before any request, and the run dir is removed.
for bad in '../x' 'a?b' 'a/b'; do
  rc=0
  (cd "$TMP/work" && PATH="$TMP/fakebin:$PATH" CARAPA_BOARD_API_TOKEN=dummy \
    DELEGATE_RUN_ROOT="$TMP/runs" TMPDIR="$TMP/tmp" \
    "$TMP/bin/carapa-delegate" --tier fast --prompt-file "$TMP/prompt.txt" \
    --project "$bad" --no-objective) >/dev/null 2>"$TMP/err" || rc=$?
  [[ $rc -eq 2 ]] || { echo "project '$bad': expected exit 2, got $rc" >&2; exit 1; }
  grep -q 'invalid id' "$TMP/err" || { echo "project '$bad': no 'invalid id' message" >&2; exit 1; }
  [[ ! -e "$TMP/calls" ]] || { echo "project '$bad': network or child call made" >&2; exit 1; }
  [[ -z $(ls -A "$TMP/runs") ]] || { echo "project '$bad': run dir left behind" >&2; exit 1; }
  [[ -z $(ls -A "$TMP/tmp") ]] || { echo "project '$bad': temp cwd left behind" >&2; exit 1; }
done
