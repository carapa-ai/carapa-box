#!/bin/sh
# Read-only process-memory snapshot for CarapaBox diagnostics.
# Full argv is intentionally omitted because agent command lines may contain
# prompts, credentials, or other sensitive values.

set -eu

printf '%s\n' '== guest memory =='
awk '
  /^(MemTotal|MemFree|MemAvailable|Buffers|Cached|Shmem|SwapTotal|SwapFree):/ {
    print
  }
' /proc/meminfo

printf '%s\n' '== top processes by RSS (KiB) =='
ps -eo pid,ppid,rss,vsz,etimes,stat,comm --sort=-rss | head -n 41

printf '%s\n' '== top process working directories =='
printf '%-7s %-10s %-22s %s\n' PID RSS_KIB COMMAND CWD
ps -eo pid=,rss=,comm= --sort=-rss | head -n 25 | while read -r pid rss comm; do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || printf '%s' '?')
  printf '%-7s %-10s %-22s %s\n' "$pid" "$rss" "$comm" "$cwd"
done

printf '%s\n' '== process counts by name =='
ps -eo comm= | sort | uniq -c | sort -nr | head -n 30
