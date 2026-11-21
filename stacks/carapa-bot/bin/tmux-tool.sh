#!/bin/sh
# tmux-tool.sh — Low-level tmux helper invoked by the CarapaBox REST /api/tmux adapter.
#
# Mounted read-only at /usr/local/stack-cli-bin from the shared CarapaBot tools,
# and authorized by policy.rego's normalized trusted-bin rule. CarapaBox prefers direct tmux
# commands via `docker compose exec`, but this wrapper is kept for any stack-side
# script that needs a guaranteed-safe tmux invocation.
#
# Usage:
#   tmux-tool.sh create  <session> [cols] [rows]
#   tmux-tool.sh capture <session> [lines]
#   tmux-tool.sh send    <session> <literal-keys>
#   tmux-tool.sh resize  <session> <cols> <rows>
#   tmux-tool.sh kill    <session>
#   tmux-tool.sh has     <session>

set -eu

SESSION_RE='^[a-zA-Z0-9_-]+$'

sub="${1:-}"
[ -n "$sub" ] || { echo "tmux-tool: missing subcommand" >&2; exit 2; }
shift

session="${1:-}"
[ -n "$session" ] || { echo "tmux-tool: missing session" >&2; exit 2; }
printf '%s' "$session" | grep -qE "$SESSION_RE" || { echo "tmux-tool: invalid session name" >&2; exit 2; }
shift

case "$sub" in
  create)
    cols="${1:-200}"
    rows="${2:-50}"
    if ! tmux has-session -t "=$session" 2>/dev/null; then
      # Preserve login-shell semantics (`logout` works) while advertising
      # tmux's 256-color capability so ~/.bashrc selects its colored prompt.
      tmux new-session -d -s "$session" -n carapa -x "$cols" -y "$rows" \
        'env TERM=screen-256color /bin/bash -l'
    fi
    ;;
  capture)
    lines="${1:-2000}"
    tmux capture-pane -p -e -t "=$session:" -S "-$lines"
    ;;
  send)
    [ -n "$*" ] || { echo "tmux-tool send: missing keys" >&2; exit 2; }
    tmux send-keys -l -t "=$session:" "$*"
    ;;
  resize)
    cols="${1:-200}"
    rows="${2:-50}"
    tmux resize-window -t "=$session:" -x "$cols" -y "$rows"
    ;;
  kill)
    tmux kill-session -t "=$session" 2>/dev/null || true
    ;;
  has)
    tmux has-session -t "=$session" 2>/dev/null
    ;;
  *)
    echo "tmux-tool: unknown subcommand: $sub" >&2
    exit 2
    ;;
esac
