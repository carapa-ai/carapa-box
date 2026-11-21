#!/bin/sh
# Report whether an agent PID is alive without exposing a general shell command.
# Output is stable for CarapaBoard's watchdog and recovery sweep.

set -eu

PID="${1:-}"
case "$PID" in
  ''|*[!0-9]*)
    echo "agent-status: PID must be a positive integer" >&2
    exit 2
    ;;
esac

if [ "$PID" -eq 0 ]; then
  echo "agent-status: PID must be a positive integer" >&2
  exit 2
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "kill0_exit=0"
  exit 0
else
  status=$?
  echo "kill0_exit=$status"
  exit "$status"
fi
