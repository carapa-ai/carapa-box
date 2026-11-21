#!/bin/bash
set -euo pipefail

SCANNER="$(cd "$(dirname "$0")/../bin" && pwd)/carapa-repository-scan"
TMP="$(mktemp -d "$PWD/.repository-scan.XXXXXX")"
OUTSIDE="$(mktemp -d /tmp/carapa-repository-scan-outside.XXXXXX)"
trap 'rm -rf "$TMP" "$OUTSIDE"' EXIT

mkdir -p "$TMP/top/.git" "$TMP/top/nested/.git" "$TMP/file-repo" \
  "$TMP/excluded/repo/.git" "$TMP/link-target/repo/.git" "$TMP/deep/one/repo/.git"
mkdir -p "$TMP/__pycache__/repo/.git"
printf 'gitdir: elsewhere\n' >"$TMP/file-repo/.git"
ln -s "$TMP/link-target" "$TMP/link"
mkdir -p "$OUTSIDE/.git"
ln -s "$OUTSIDE" "$TMP/outside-link"
mkdir -p "$TMP/adversarial"$'\n'"name/.git"

mapfile -d '' -t found < <(/usr/bin/python3 "$SCANNER" "$TMP" 3 excluded __pycache__)
expected=("$TMP/adversarial"$'\n'"name" "$TMP/deep/one/repo" "$TMP/file-repo" "$TMP/link-target/repo" "$TMP/top")
[[ ${#found[@]} -eq ${#expected[@]} ]]
for repository in "${expected[@]}"; do
  present=false
  for actual in "${found[@]}"; do
    [[ "$actual" == "$repository" ]] && present=true
  done
  [[ "$present" == true ]]
done

# A repository is pruned, symlink aliases are not followed, and depth is exact.
[[ " ${found[*]} " != *" $TMP/top/nested "* ]]
[[ " ${found[*]} " != *" $TMP/link/repo "* ]]
[[ " ${found[*]} " != *" $TMP/outside-link "* ]]
mapfile -d '' -t shallow < <(/usr/bin/python3 "$SCANNER" "$TMP" 1 excluded)
[[ " ${shallow[*]} " != *" $TMP/deep/one/repo "* ]]

# Docker's configured working directory is the trusted boundary. Exercise the
# conventional and a non-/workspace layout without using an environment input.
mkdir -p "$TMP/layouts/workspace/repo/.git" "$TMP/layouts/var/www/demo-app/repo/.git"
mapfile -d '' -t conventional < <(cd "$TMP/layouts/workspace" && /usr/bin/python3 "$SCANNER" "$TMP/layouts/workspace" 1)
[[ ${conventional[*]} == "$TMP/layouts/workspace/repo" ]]
mapfile -d '' -t custom < <(cd "$TMP/layouts/var/www/demo-app" && /usr/bin/python3 "$SCANNER" "$TMP/layouts/var/www/demo-app" 1)
[[ ${custom[*]} == "$TMP/layouts/var/www/demo-app/repo" ]]
mapfile -d '' -t cosmetic < <(cd "$TMP/layouts/var/www/demo-app" && /usr/bin/python3 "$SCANNER" "$TMP/layouts//var/www/demo-app/./" 1)
[[ ${cosmetic[*]} == "$TMP/layouts/var/www/demo-app/repo" ]]

# The wire format remains absolute paths with a trailing NUL.
(cd "$TMP/layouts/var/www/demo-app" && /usr/bin/python3 "$SCANNER" "$TMP/layouts/var/www/demo-app" 1) >"$TMP/output"
[[ $(tail -c 1 "$TMP/output" | od -An -tu1 | tr -d ' ') == 0 ]]

# Invalid inputs fail closed.
! (cd "$TMP" && /usr/bin/python3 "$SCANNER" "$OUTSIDE" 1) >/dev/null 2>&1
! (cd "$TMP" && /usr/bin/python3 "$SCANNER" relative 1) >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 0 >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 13 >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 01 >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" nope >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 2 ../escape >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 2 .git >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 2 'bad/name' >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP" 2 '_cache' >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP/link" 2 >/dev/null 2>&1
! /usr/bin/python3 "$SCANNER" "$TMP/../$(basename "$TMP")" 2 >/dev/null 2>&1

/usr/bin/python3 "$(dirname "$0")/repository-scan-race.test.py" "$SCANNER"
