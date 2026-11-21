#!/bin/sh
# Update a public runtime's installed harnesses as validated releases inside a stable volume.
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$#" -eq 0 ] || [ "${1:-}" = "--tui" ]; then
    [ "$#" -eq 0 ] || shift
    exec python3 "$SCRIPT_DIR/harness-tui.py" --public-root "$SCRIPT_DIR" "$@"
fi
STACK_DIR="$SCRIPT_DIR"
VARIANT=""
ACTION=update
APPLY=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --stack-dir)
            [ "$#" -ge 2 ] || { echo '--stack-dir requires a directory' >&2; exit 2; }
            STACK_DIR="$2"; shift 2 ;;
        --debian) VARIANT=debian; shift ;;
        --alpine) VARIANT=alpine; shift ;;
        --configure) ACTION=configure; shift ;;
        --install) ACTION=install; shift ;;
        --remove) ACTION=remove; shift ;;
        --cleanup) ACTION=cleanup; shift ;;
        --apply) APPLY=--apply; shift ;;
        --rollback) ACTION=rollback; shift ;;
        -h|--help)
            echo 'Usage: update-harnesses.sh [--stack-dir DIR] [--debian|--alpine] [harness[@version] ...]'
            echo 'Omit harness names to update all installed harnesses. Example: ./update-harnesses.sh claude'
            echo 'New runs use the updated releases without restarting migrated sandboxes.'
            echo '--configure <names|none>: choose the installed set; --install <names>: add; --remove <names>: remove.'
            echo '--cleanup [--apply]: preview/remove unused releases. --rollback [harness ...]: undo selected updates.'
            exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; exit 2 ;;
        *) break ;;
    esac
done
if [ -n "$VARIANT" ]; then
    exec python3 "$SCRIPT_DIR/harness.py" --stack-dir "$STACK_DIR" --variant "$VARIANT" "$ACTION" ${APPLY:+"$APPLY"} "$@"
fi
exec python3 "$SCRIPT_DIR/harness.py" --stack-dir "$STACK_DIR" "$ACTION" ${APPLY:+"$APPLY"} "$@"
