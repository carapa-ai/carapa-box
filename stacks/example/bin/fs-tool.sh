#!/bin/sh
set -eu

case "${1:-}" in
  read-file)
    path="${2:-}"
    [ -n "$path" ] || { echo "fs-tool: missing path" >&2; exit 2; }
    if [ -f "$path" ]; then
      base64 "$path" | tr -d '\n'
    else
      printf '__NOT_FOUND__'
    fi
    ;;
  *)
    echo "fs-tool: unsupported operation" >&2
    exit 2
    ;;
esac
