import { shellQuote } from "../utils.js";

type CommandResult = { code: number; stdout: string; stderr: string };

/** One container call; no index scan, remote access, checkout or project hooks. */
export async function inspectReusableWorktree(
    branch: string,
    execShell: (command: string) => Promise<CommandResult>,
): Promise<{ missing: boolean; previewPort?: number }> {
    // This path is also consumed by the existing provisioning implementation.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
        branch.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('Invalid managed worktree branch');
    }
    const result = await execShell([
        'set -e',
        // Same trust as other Box Git operations, without writing global config.
        `git() { command git -c safe.directory='*' "$@"; }`,
        `wt=${shellQuote(`.worktrees/${branch}`)}`,
        // Only positive absence permits provisioning. Never turn a broken
        // gitdir, wrong branch or transport failure into destructive repair.
        'if [ ! -e "$wt" ] && [ ! -L "$wt" ]; then echo worktree_missing=1; exit 0; fi',
        // An && list does not trigger set -e unless it is the last command.
        'if [ -L "$wt" ] || [ ! -f "$wt/.git" ]; then echo "not a plain worktree: $wt" >&2; exit 1; fi',
        'main_common=$(git rev-parse --path-format=absolute --git-common-dir)',
        'main_common=$(cd "$main_common" && pwd -P)',
        'cd "$wt"',
        '[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ]',
        'wt_common=$(git rev-parse --path-format=absolute --git-common-dir)',
        '[ "$(cd "$wt_common" && pwd -P)" = "$main_common" ]',
        `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
        'current=$(git symbolic-ref -q HEAD || true)',
        // Detached HEAD is legitimate during a pending rebase, but a different
        // checked-out branch must never receive this task's agent.
        `if [ -n "$current" ]; then [ "$current" = ${shellQuote(`refs/heads/${branch}`)} ]; else gitdir=$(git rev-parse --absolute-git-dir); [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; fi`,
        'echo worktree_ready=1',
        'if [ -f .preview-url ] && [ ! -L .preview-url ]; then head -c 128 .preview-url; fi',
    ].join('\n'));
    if (result.code !== 0) {
        throw new Error(`Existing worktree validation failed for ${branch}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
    if (result.stdout.trim() === 'worktree_missing=1') return { missing: true };
    if (!result.stdout.startsWith('worktree_ready=1\n')) {
        throw new Error(`Unrecognized worktree validation result for ${branch}`);
    }
    const match = result.stdout.slice('worktree_ready=1\n'.length).trim().match(/^http:\/\/nginx:(\d+)\/$/);
    const port = match ? Number(match[1]) : undefined;
    return { missing: false, previewPort: port && port <= 65535 ? port : undefined };
}

/** Reuse never invokes project provisioning, even when preview metadata needs repair. */
export async function reuseManagedWorktree(
    branch: string,
    localRepo: string,
    deps: {
        execShell: (command: string) => Promise<CommandResult>;
        previewEnabled: boolean;
        readPreviewPort: () => number | undefined;
        restorePreview: () => Promise<number | undefined>;
        writePreview: (port: number) => Promise<void>;
    },
): Promise<string> {
    const state = await inspectReusableWorktree(branch, deps.execShell);
    if (state.missing) return 'worktree_missing=1';
    // The conf registry is authoritative, not a stale file left in the checkout.
    let port = deps.previewEnabled ? deps.readPreviewPort() : undefined;
    if (deps.previewEnabled && !port) {
        port = await deps.restorePreview();
        if (!port) throw new Error('Unable to restore worktree preview; retry when nginx is available');
    }
    if (port && port !== state.previewPort) await deps.writePreview(port);
    return `worktree_path=${localRepo}/.worktrees/${branch}${port ? `\npreview_port=${port}` : ''}\nWorktree reused without provisioning`;
}
