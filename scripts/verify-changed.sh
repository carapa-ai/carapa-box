#!/usr/bin/env bash
# Typecheck plus only the tests this branch can affect. The full suite is the
# fallback for cross-cutting changes. Run it with: bun run verify:changed
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

HUB_LIMIT=12
# Same env and flags as the README full-suite command.
TEST_ENV=(ENABLE_INGRESS_PROXY=false ENABLE_SANDBOX_TMUX=1 "CARAPA_BOX_CONFIG_DIR=$ROOT/config")

SKIPPED=()
FULL_REASON=""
REGO_CHANGED=0

fail() {
  echo "VERIFY CHANGED: FAIL - $*" >&2
  exit 1
}

run_phase() {
  local name=$1
  shift
  echo "==> $name"
  "$@" || fail "$name"
}

is_test() { [[ $1 =~ \.test\.(ts|tsx|mjs|js)$ ]]; }
is_script() { [[ $1 =~ \.(ts|tsx|mjs|js)$ ]]; }
is_doc() { [[ $1 == *.md && $1 != .agent/skills/* && $1 != */.agent/skills/* ]]; }

is_full_trigger() {
  case $1 in
    package.json | */package.json | bun.lock* | */bun.lock* | tsconfig*.json | */tsconfig*.json | \
      bunfig.toml | */bunfig.toml | scripts/verify-changed.sh | scripts/verify-changed-importers.ts | \
      src/test-fixtures/* | fixtures/* | */fixtures/* | egress-proxy/drain-test-helpers.mjs) return 0 ;;
  esac
  return 1
}

# --- Changed set: commits since merge-base with develop, plus staged, unstaged and untracked files.
BASE=""
for ref in develop origin/develop; do
  if git rev-parse --verify -q "$ref^{commit}" > /dev/null; then
    BASE=$(git merge-base "$ref" HEAD) && break
    BASE=""
  fi
done

CHANGED=() # present in the working tree
DELETED=()
[ -n "$BASE" ] || { FULL_REASON="cannot determine merge-base with develop"; REGO_CHANGED=1; }
# NUL-delimited, so a path keeps its literal form (quotes, tabs, newlines). Git writes to files, so
# a git failure fails verify instead of looking like an empty change set.
DIFF_OUT=$(mktemp) && UNTRACKED_OUT=$(mktemp) || fail "mktemp"
git diff --name-status -z --no-renames "${BASE:-HEAD}" -- > "$DIFF_OUT" \
  && git ls-files --others --exclude-standard -z > "$UNTRACKED_OUT" \
  || { rm -f "$DIFF_OUT" "$UNTRACKED_OUT"; fail "git diff against ${BASE:-HEAD}"; }
while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  if [ "$status" = D ]; then DELETED+=("$path"); else CHANGED+=("$path"); fi
done < "$DIFF_OUT"
while IFS= read -r -d '' path; do
  CHANGED+=("$path")
done < "$UNTRACKED_OUT"
# Paths that differ from HEAD or from the index count for the name gate even when their content equals the
# merge-base again (a fix committed, then the old text restored as an unstaged edit).
GATE_EXTRA=()
git diff --name-only -z --diff-filter=d HEAD -- > "$DIFF_OUT" \
  && git diff --name-only -z --diff-filter=d -- >> "$DIFF_OUT" \
  || { rm -f "$DIFF_OUT" "$UNTRACKED_OUT"; fail "git diff against HEAD"; }
while IFS= read -r -d '' path; do
  GATE_EXTRA+=("$path")
done < "$DIFF_OUT"
rm -f "$DIFF_OUT" "$UNTRACKED_OUT"
ALL=("${CHANGED[@]}" "${DELETED[@]}")

# --- 0. Private names. Public files that changed must not hold a name from scripts/public-name-check.sh.
# Runs before the docs-only shortcut so a docs-only change is checked too. Three snapshots are scanned,
# each against the .publicignore of that same snapshot: what is committed since the merge-base (HEAD),
# what the index holds for every branch-changed path (raw blobs, no checkout conversions) and the working tree. Each is copied into a scratch
# dir, the ignored paths are removed as the export does, and the rest goes through the checker.
NAME_CHECK="$ROOT/scripts/public-name-check.sh"

# Scratch repositories must never see the caller's repository (GIT_INDEX_FILE, GIT_DIR, ...): every
# repository-local variable is unset for them, while reads of the caller's repository keep theirs.
LOCAL_ENV=$(git rev-parse --local-env-vars) || fail "git rev-parse --local-env-vars"
SCRATCH_GIT=(env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE)
for var in $LOCAL_ENV; do SCRATCH_GIT+=(-u "$var"); done
SCRATCH_GIT+=(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git)

# materialize_raw DIR DIFF-ARGS...: DIR gets the raw new blob of every non-deleted regular file in
# `git diff --raw DIFF-ARGS` (symlinks and submodules are skipped, as the export's grep skips them).
materialize_raw() {
  local dir=$1 out meta oldmode mode _old sha _status path
  shift
  out=$(mktemp) || return 1
  git diff --raw -z --no-renames --diff-filter=d "$@" -- > "$out" || { rm -f "$out"; return 1; }
  while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
    read -r oldmode mode _old sha _status <<< "$meta"
    case $mode in 120000 | 160000) continue ;; esac
    [[ $path != */* ]] || mkdir -p "$dir/${path%/*}" || { rm -f "$out"; return 1; }
    git cat-file blob "$sha" > "$dir/$path" || { rm -f "$out"; return 1; }
  done < "$out"
  rm -f "$out"
}
mat_committed() { materialize_raw "$1" "$BASE" HEAD; }
# The index blob of every path that differs from the merge-base or from HEAD: a path whose index blob was
# restored to the merge-base version still counts, because the next commit changes it against HEAD.
mat_staged() { materialize_raw "$1" --cached "$BASE" && materialize_raw "$1" --cached HEAD; }
mat_working() {
  local path
  for path in "${CHANGED[@]}" "${GATE_EXTRA[@]}"; do
    if [ -f "$path" ] && [ ! -L "$path" ]; then
      [[ $path != */* ]] || mkdir -p "$1/${path%/*}" || return 1
      cp -- "$path" "$1/$path" || return 1
    fi
  done
}

# index_paths DIR: a scratch index of DIR's files, for the export's `ls-files -ci` matching. Placeholder
# blobs, so no checkout or attribute conversion (an encoding attribute cannot break or hide a file).
index_paths() {
  local empty path
  empty=$("${SCRATCH_GIT[@]}" -C "$1" hash-object -w --stdin < /dev/null) || return 1
  (cd "$1" && find . -path ./.git -prune -o -type f -print0) \
    | while IFS= read -r -d '' path; do printf '100644 %s\t%s\0' "$empty" "${path#./}"; done \
    | "${SCRATCH_GIT[@]}" -C "$1" update-index --add -z --index-info
}

# scan_snapshot LABEL IGNORE-BLOB-SPEC MATERIALIZER: an empty spec means the working .publicignore.
scan_snapshot() {
  local label=$1 spec=$2 materialize=$3 dir ignore list path rc=0
  dir=$(mktemp -d) && ignore=$(mktemp) && list=$(mktemp) || return 1
  if [ -z "$spec" ]; then
    cp "$ROOT/.publicignore" "$ignore" || rc=1
  elif git cat-file -e "$spec" 2> /dev/null; then
    git cat-file blob "$spec" > "$ignore" || rc=1
  fi # a snapshot without .publicignore ignores nothing, so everything is scanned
  if [ $rc -eq 0 ]; then
    "$materialize" "$dir" \
      && "${SCRATCH_GIT[@]}" -C "$dir" init -q \
      && index_paths "$dir" \
      && "${SCRATCH_GIT[@]}" -C "$dir" ls-files -ci -z --exclude-from="$ignore" > "$list" || rc=1
  fi
  if [ $rc -eq 0 ]; then
    while IFS= read -r -d '' path; do rm -f -- "$dir/$path"; done < "$list"
    rm -rf "$dir/.git"
    (cd "$dir" && bash "$NAME_CHECK" .) || { echo "  (in the $label snapshot)" >&2; rc=1; }
  fi
  rm -rf "$dir" "$ignore" "$list"
  return $rc
}

check_public_names() {
  local rc=0
  scan_snapshot "committed since $BASE" "HEAD:.publicignore" mat_committed || rc=1
  scan_snapshot "staged" ":.publicignore" mat_staged || rc=1
  scan_snapshot "working tree" "" mat_working || rc=1
  return $rc
}
# The checker and .publicignore are private release tooling. The public snapshot has neither on disk nor
# tracked, so there is nothing to enforce there. If either one exists, is tracked or is in HEAD or the
# merge-base, both must be on disk: a checkout that lost them must not pass silently.
tool_known() {
  local listed
  [ -e "$1" ] && return 0
  listed=$(git ls-files -- "$1") || return 0 # a git error counts as known: fail closed
  [ -z "$listed" ] || return 0
  # In HEAD or in the merge-base: committing their deletion must not switch the gate off.
  git cat-file -e "HEAD:$1" 2> /dev/null || { [ -n "$BASE" ] && git cat-file -e "$BASE:$1" 2> /dev/null; }
}
if [ -f "$NAME_CHECK" ] && [ -f "$ROOT/.publicignore" ]; then
  # Committed changes can only be checked against a merge-base: without one (single-branch or shallow
  # clone) a clean tree would pass with its commits unscanned.
  [ -n "$BASE" ] || fail "public names: no merge-base with develop or origin/develop; fetch it (git fetch origin develop; add --unshallow for a shallow clone) so the committed changes can be checked"
  check_public_names || fail "public names (see scripts/public-name-check.sh)"
elif tool_known scripts/public-name-check.sh || tool_known .publicignore; then
  fail "the public name gate needs both scripts/public-name-check.sh and .publicignore on disk"
fi

# --- Reuse an earlier pass of the tests. The stamp lives in the worktree's private git dir, so it never
# shows in git status. Its key is the tree hash of the working state (staged, unstaged and untracked files,
# so a content-neutral commit keeps it), the merge-base and a hash of the verifier scripts. The name gate
# above always runs first on the exact bytes, so a reused pass never skips it.
# CARAPA_VERIFY_REUSE=0 forces a fresh run.
STAMP=""
STAMP_KEY=""
working_tree_hash() {
  local index tree
  index=$(mktemp) || return 1
  cp "$(git rev-parse --git-path index)" "$index" 2> /dev/null || : > "$index"
  tree=$(GIT_INDEX_FILE=$index git add -A 2> /dev/null && GIT_INDEX_FILE=$index git write-tree)
  local status=$?
  rm -f "$index"
  [ $status -eq 0 ] && echo "$tree"
}
stamp_key() {
  local tree scripts
  tree=$(working_tree_hash) || return 1
  # public-name-check.sh is private release tooling, absent from the public snapshot.
  scripts=$({ cat "$ROOT/scripts/verify-changed.sh" "$ROOT/scripts/verify-changed-importers.ts" || exit 1
    cat "$ROOT/scripts/public-name-check.sh" 2> /dev/null || true; } | git hash-object --stdin) || return 1
  echo "$tree $BASE $scripts"
}
if [ -n "$BASE" ] && STAMP="$(git rev-parse --absolute-git-dir)/verify-changed.stamp" \
  && STAMP_KEY=$(stamp_key); then
  if [ "${CARAPA_VERIFY_REUSE:-1}" != 0 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_KEY" ]; then
    echo "VERIFY CHANGED: PASS (reused earlier pass for tree ${STAMP_KEY%% *})"
    exit 0
  fi
  rm -f "$STAMP" # a failed or interrupted run leaves no stamp behind
else
  STAMP=""
fi

# --- 1. Docs-only.
if [ -n "$BASE" ]; then
  if [ ${#ALL[@]} -eq 0 ]; then
    echo "VERIFY CHANGED: no changes against $BASE, nothing to verify"
    echo "VERIFY CHANGED: PASS (0 test files; skipped: typecheck, tests, policy:test)"
    exit 0
  fi
  docs_only=1
  for path in "${ALL[@]}"; do
    is_doc "$path" || { docs_only=0; break; }
  done
  if [ "$docs_only" = 1 ]; then
    echo "docs-only change (${#ALL[@]} markdown file(s)): no gates run"
    echo "VERIFY CHANGED: PASS (0 test files; skipped: typecheck, tests, policy:test - docs-only)"
    exit 0
  fi
fi

# --- 2. Typecheck.
run_phase "typecheck" bun run typecheck

# --- 3/4/6. Test selection.
declare -A SELECTED=()
declare -A OWNED=()
HUBS=()
SCAN=()

if [ -z "$FULL_REASON" ]; then
  for path in "${ALL[@]}"; do
    [[ $path == *.rego ]] && REGO_CHANGED=1
    if is_full_trigger "$path" && [ -z "$FULL_REASON" ]; then
      FULL_REASON="$path is a shared input or test-infrastructure file"
    fi
  done
fi

if [ -z "$FULL_REASON" ]; then
  for path in "${CHANGED[@]}"; do
    if is_test "$path"; then
      SELECTED[$path]=1
    elif ! is_doc "$path"; then
      SCAN+=("$path")
      is_script "$path" && for ext in ts tsx mjs js; do
        colocated="${path%.*}.test.$ext"
        [ -f "$colocated" ] && SELECTED[$colocated]=1
      done
    fi
  done
  for path in "${DELETED[@]}"; do
    if is_test "$path" || is_doc "$path"; then continue; fi
    SCAN+=("$path")
    for ext in ts tsx mjs js; do
      colocated="${path%.*}.test.$ext"
      [ -f "$colocated" ] && { SELECTED[$colocated]=1; OWNED[$path]=1; }
    done
  done
  if [ ${#SCAN[@]} -gt 0 ]; then
    IMPORTERS=$(bun "$ROOT/scripts/verify-changed-importers.ts" "$HUB_LIMIT" "${SCAN[@]}") \
      || fail "importer scan"
    while IFS=$'\t' read -r kind source detail; do
      case $kind in
        IMPORTER) SELECTED[$detail]=1; OWNED[$source]=1 ;;
        HUB) HUBS+=("$source ($detail importing tests)") ;;
      esac
    done <<< "$IMPORTERS"
  fi
  for path in "${DELETED[@]}"; do
    if is_test "$path" || is_doc "$path"; then continue; fi
    if [ -z "${OWNED[$path]:-}" ] && [ -z "$FULL_REASON" ]; then
      FULL_REASON="$path was deleted or renamed and owns no test"
    fi
  done
fi

BUN_FILES=()
NODE_FILES=()
if [ -z "$FULL_REASON" ]; then
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [[ $path == *.test.mjs ]] && grep -q "node:test" "$path"; then
      NODE_FILES+=("$path")
    else
      BUN_FILES+=("./$path")
    fi
  done < <(printf '%s\n' "${!SELECTED[@]}" | sort)
fi

if [ -n "$FULL_REASON" ]; then
  echo "full suite: $FULL_REASON"
  run_phase "full suite" env "${TEST_ENV[@]}" bun --no-env-file test
  TEST_SUMMARY="full suite"
else
  for hub in "${HUBS[@]}"; do
    echo "skipped hub (left to the full suite): $hub"
  done
  [ ${#BUN_FILES[@]} -gt 0 ] && printf 'selected: %s\n' "${BUN_FILES[@]}"
  [ ${#NODE_FILES[@]} -gt 0 ] && printf 'selected: %s\n' "${NODE_FILES[@]}"
  if [ ${#BUN_FILES[@]} -gt 0 ]; then
    run_phase "bun tests (${#BUN_FILES[@]})" env "${TEST_ENV[@]}" bun --no-env-file test "${BUN_FILES[@]}"
  else
    SKIPPED+=("bun tests (none selected)")
  fi
  if [ ${#NODE_FILES[@]} -gt 0 ]; then
    run_phase "node tests (${#NODE_FILES[@]})" env "${TEST_ENV[@]}" node --test "${NODE_FILES[@]}"
  else
    SKIPPED+=("node tests (none selected)")
  fi
  TEST_SUMMARY="$((${#BUN_FILES[@]} + ${#NODE_FILES[@]})) test file(s)"
  for hub in "${HUBS[@]}"; do
    SKIPPED+=("hub importers of $hub")
  done
fi

# --- 5. Rego.
if [ "$REGO_CHANGED" = 1 ]; then
  if command -v opa > /dev/null; then
    run_phase "policy:test" bun run policy:test
  else
    echo "SKIPPED policy:test (opa not found)"
    SKIPPED+=("policy:test (opa not found)")
  fi
else
  SKIPPED+=("policy:test (no .rego change)")
fi

# --- 7. Summary.
SKIPPED_TEXT="none"
if [ ${#SKIPPED[@]} -gt 0 ]; then
  SKIPPED_TEXT=$(printf '%s; ' "${SKIPPED[@]}")
  SKIPPED_TEXT=${SKIPPED_TEXT%; }
fi
echo "VERIFY CHANGED: PASS (tests: $TEST_SUMMARY; skipped: $SKIPPED_TEXT)"
# Stamp only if the gates did not change the tree they verified.
if [ -n "$STAMP" ] && [ "$(stamp_key)" = "$STAMP_KEY" ]; then
  echo "$STAMP_KEY" > "$STAMP"
fi
