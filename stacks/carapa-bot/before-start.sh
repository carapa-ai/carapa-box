#!/bin/bash
# ── CarapaBot agent pre-start hook ────────────────────────────────────────
# Runs on the HOST before `docker compose up` for each instance.
# Validates the selected public runtime and installed harness volume.
#
# Usage: cd /workspace/stacks/carapa-bot && ./before-start.sh
set -e

# Do not download/install anything during ordinary sandbox startup.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bun "$SCRIPT_DIR/check-harness.mjs" "$SCRIPT_DIR"

# ── GIT_REPO mode: clone or pull into named volume ──────────────────────────
if [ -n "$GIT_REPO" ] && [ -z "$LOCAL_REPO" ]; then
    VOLUME_NAME="${COMPOSE_PROJECT_NAME}_workspace"
    # SSH keys: prefer SSH_KEYS_FOLDER, fall back to current user's ~/.ssh
    SSH_KEYS_PATH="${SSH_KEYS_FOLDER:-$HOME/.ssh}"
    # Branch to pull: use DEFAULT_BRANCH from project settings, fall back to main
    BRANCH="${DEFAULT_BRANCH:-main}"

    # Values reach the git container as positional arguments, never as shell
    # text; still reject anything that could be read as an option or is malformed.
    case "$GIT_REPO" in
        -*|*[[:space:][:cntrl:]]*)
            echo "ERROR: invalid GIT_REPO (must not start with '-' or contain whitespace/control characters)" >&2
            exit 1
            ;;
    esac
    BRANCH_OK=yes
    case "$BRANCH" in
        -*) BRANCH_OK=no ;;
        *)
            if command -v git &>/dev/null; then
                git check-ref-format --branch "$BRANCH" &>/dev/null || BRANCH_OK=no
            else
                [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || BRANCH_OK=no
            fi
            ;;
    esac
    if [ "$BRANCH_OK" != "yes" ]; then
        echo "ERROR: invalid branch name in DEFAULT_BRANCH" >&2
        exit 1
    fi

    # Ensure volume exists
    docker volume inspect "$VOLUME_NAME" &>/dev/null || docker volume create "$VOLUME_NAME"

    IS_EMPTY=$(docker run --rm -v "$VOLUME_NAME:/mnt" alpine sh -c \
        '[ -z "$(ls -A /mnt)" ] && echo yes || echo no')

    if [ "$IS_EMPTY" = "yes" ]; then
        # SSH-keyed clones are not supported here: mounting host keys into a
        # container that cannot use them (no uid-1000 passwd entry) is pointless
        # and a root-with-keys clone is unsafe. Fail closed before any keys move.
        case "$GIT_REPO" in
            http://*|https://*) ;;
            *)
                echo "ERROR: SSH-keyed clone is not supported in before-start.sh; use LOCAL_REPO or an HTTPS GIT_REPO" >&2
                exit 1
                ;;
        esac
        echo "Cloning $GIT_REPO into volume $VOLUME_NAME..."
        # Clone runs as uid 1000 (never root), no keys, hooks disabled; the volume
        # is made writable for that uid first by a separate container.
        docker run --rm -v "$VOLUME_NAME:/workspace" alpine chown 1000:1000 /workspace
        docker run --rm --user 1000:1000 -e HOME=/tmp \
            -v "$VOLUME_NAME:/workspace" \
            --entrypoint sh \
            alpine/git:latest \
            -c 'git -c core.hooksPath=/dev/null clone -- "$1" /workspace' sh "$GIT_REPO"

        if [ $? -ne 0 ]; then
            echo "ERROR: git clone failed for $GIT_REPO" >&2
            exit 1
        fi
        echo "Repository cloned successfully"
    else
        echo "existing repo: not updating on start; use sandbox_git / sandbox_worktree to fetch"
    fi

    # Always fix ownership — covers fresh clones and recovering from root-owned state
    docker run --rm -v "$VOLUME_NAME:/workspace" alpine chown -R 1000:1000 /workspace
fi
