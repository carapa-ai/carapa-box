// Per-worktree nginx preview confs live in a folder shared by every instance of
// a stack, so each conf name carries its owner (the compose project name):
// `<projectName>@<branch>.conf`. Owners and branches are slugs that may contain
// `-`, `--`, `.` and `_` but never `@`, so the first `@` splits the name
// unambiguously and no owner can match another owner's prefix. Legacy unprefixed
// `<branch>.conf` files cannot contain `@`: they never parse as owned, keep their
// port reserved and are never pruned, overwritten or removed.

export const PREVIEW_PORT_MIN = 8081;
export const PREVIEW_PORT_MAX = 8980;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const OWNER_SEPARATOR = "@";

/** Same charset guard for branch slugs and owners. */
export function isSafePreviewSlug(value: string): boolean {
    return SLUG_RE.test(value);
}

/** Conf file name (without directory) for an owner and branch. */
export function previewConfName(owner: string, branch: string): string {
    return `${owner}${OWNER_SEPARATOR}${branch}.conf`;
}

/** Split `<owner>@<branch>.conf`; undefined for legacy or malformed names. */
export function parsePreviewConfName(file: string): { owner: string; branch: string } | undefined {
    if (!file.endsWith(".conf")) return undefined;
    const stem = file.slice(0, -5);
    const at = stem.indexOf(OWNER_SEPARATOR);
    if (at < 1) return undefined;
    const owner = stem.slice(0, at);
    const branch = stem.slice(at + 1);
    if (!SLUG_RE.test(owner) || !SLUG_RE.test(branch)) return undefined;
    return { owner, branch };
}

/** True when the conf file belongs to `owner`. */
export function isOwnedPreviewConf(file: string, owner: string): boolean {
    return parsePreviewConfName(file)?.owner === owner;
}

/**
 * Locked shell script run inside nginx: take a lock inside the shared conf
 * folder (every instance's nginx is a separate container, so a container-local
 * lock would not serialize them; abort if it cannot be taken) → scan every conf (all stay reserved
 * ports) → reuse this owner's port for the branch or pick the lowest free one →
 * prune only this owner's confs whose branch is not live → write → echo port.
 * Interpolates only slug-guarded / numeric / base64 values (callers validate).
 */
export function buildPreviewSyncScript(opts: {
    owner: string;
    branch: string;
    liveBranches: string[];
    prune: boolean;
    base64Conf: string;
    wtDir?: string;
    lockWaitSeconds?: number;
}): string {
    const { owner, branch, liveBranches, prune, base64Conf } = opts;
    const wtDir = opts.wtDir ?? "/etc/nginx/conf.d/wt";
    const lockWait = opts.lockWaitSeconds ?? 60;
    return [
        `set -e`,
        `WT=${wtDir}`,
        `mkdir -p "$WT"`,
        // mkdir spinlock (atomic on tmpfs) — serialize concurrent execs.
        // Hidden, so the nginx `*.conf` include never sees it. A lock older than 5 minutes is stale.
        `lock="$WT/.preview.lock"; i=0`,
        `while ! mkdir "$lock" 2>/dev/null; do`,
        `  [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null && continue`,
        `  i=$((i+1)); [ $i -gt ${lockWait} ] && { echo PREVIEW_LOCK_TIMEOUT; exit 4; }; sleep 1`,
        `done`,
        `trap "rmdir $lock 2>/dev/null" EXIT`,
        `owner=${owner}; branch=${branch}; live=,${liveBranches.join(",")},; prune=${prune ? "1" : ""}`,
        `pre="$owner"@`,
        `reuse=; used=`,
        `for f in "$WT"/*.conf; do`,
        `  [ -e "$f" ] || continue`,
        `  b=$(basename "$f" .conf)`,
        `  p=$(sed -n "s/.*listen[[:space:]][[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$f" | head -n1)`,
        `  if [ "$b" = "$pre$branch" ]; then reuse=$p; continue; fi`,
        // Only this owner's confs may be pruned; foreign and legacy ones stay and keep their port.
        `  case "$b" in "$pre"*) mine=1 ;; *) mine= ;; esac`,
        `  if [ -n "$prune" ] && [ -n "$mine" ]; then case "$live" in *,"\${b#"$pre"}",*) used="$used $p" ;; *) rm -f "$f"; continue ;; esac; else used="$used $p"; fi`,
        `done`,
        `port=$reuse`,
        `if [ -z "$port" ]; then c=${PREVIEW_PORT_MIN}; while [ $c -le ${PREVIEW_PORT_MAX} ]; do case " $used " in *" $c "*) : ;; *) port=$c; break ;; esac; c=$((c+1)); done; fi`,
        `[ -n "$port" ] || { echo PREVIEW_NO_PORT; exit 3; }`,
        `b64=${base64Conf}`,
        `printf %s "$b64" | base64 -d | sed "s/__PORT__/$port/g" > "$WT/$pre$branch.conf"`,
        `echo PREVIEW_PORT=$port`,
    ].join("\n");
}
