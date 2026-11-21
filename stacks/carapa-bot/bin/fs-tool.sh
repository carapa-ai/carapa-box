#!/bin/sh
# fs-tool.sh — File-system helpers for board-side DirectLLM tools (ripgrep, peek_files).
#
# Mounted read-only at /usr/local/stack-cli-bin from the shared CarapaBot tools,
# and authorized by the policy's normalized trusted-bin rule for `sandbox_exec`.
#
# Usage:
#   fs-tool.sh ripgrep   <search_dir> <query>
#   fs-tool.sh read-file <path>
#
# `read-file` writes the file's bytes base64-encoded (single line) to stdout,
# or the literal string `__NOT_FOUND__` if the path does not exist or is not a regular file.

set -eu

sub="${1:-}"
[ -n "$sub" ] || { echo "fs-tool: missing subcommand" >&2; exit 2; }
shift

case "$sub" in
  ripgrep)
    SEARCH_DIR="${1:-}"
    QUERY="${2:-}"
    [ -n "$SEARCH_DIR" ] || { echo "fs-tool ripgrep: missing search dir" >&2; exit 2; }
    [ -n "$QUERY" ] || { echo "fs-tool ripgrep: missing query" >&2; exit 2; }
    exec rg \
      --max-columns 300 \
      --max-count 100 \
      --heading \
      --line-number \
      --color never \
      --hidden \
      --glob '!**/transcripts/**' \
      --glob '!**/.git/**' \
      -- "$QUERY" "$SEARCH_DIR"
    ;;
  read-file)
    P="${1:-}"
    [ -n "$P" ] || { echo "fs-tool read-file: missing path" >&2; exit 2; }
    if [ -f "$P" ]; then
      exec base64 -w0 "$P"
    else
      printf '__NOT_FOUND__'
    fi
    ;;
  *)
    echo "fs-tool: unknown subcommand: $sub" >&2
    exit 2
    ;;
esac
