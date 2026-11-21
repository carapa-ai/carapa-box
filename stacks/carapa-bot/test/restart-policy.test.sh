#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

for compose_file in docker-compose.yml docker-compose.git.yml; do
  awk '
    /^  agent:$/ { in_agent = 1; next }
    in_agent && /^  [[:alnum:]_-]+:$/ { exit }
    in_agent && /^    restart: unless-stopped$/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$root/$compose_file" || {
    printf 'agent restart policy missing from %s\n' "$compose_file" >&2
    exit 1
  }
done

printf 'CarapaBot restart policy tests passed\n'
