#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root=$(mktemp -d /tmp/carapa-box-plugin-test.XXXXXX)
trap 'rm -rf "$test_root"' EXIT
python3 "$repo_root/scripts/package-plugin.py" --output "$test_root/plugin copy"
python3 "$test_root/plugin copy/scripts/install_helpers.py" --prefix "$test_root/helpers"
CARAPA_PLUGIN_TEST_PACKAGE="$test_root/plugin copy" \
CARAPA_PLUGIN_TEST_RUNTIME="$test_root/helpers" \
  "$test_root/helpers/venv/bin/python" -m unittest discover -s "$repo_root/scripts/plugin-tests" -p 'test_*.py' -v
