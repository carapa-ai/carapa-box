import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectReusableWorktree, reuseManagedWorktree } from './worktree-reuse.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-worktree-reuse-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function git(cwd: string, ...args: string[]) {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
}
function repo(name: string) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-b', 'develop');
    git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    return dir;
}
function shell(cwd: string) {
    return async (command: string) => {
        const r = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };
}

test('reuses a dirty worktree and preview while preserving both checkouts and setup hooks', async () => {
    const dir = repo('preserve');
    git(dir, 'worktree', 'add', '.worktrees/task-one', '-b', 'task-one');
    const wt = path.join(dir, '.worktrees/task-one');
    fs.writeFileSync(path.join(wt, 'unfinished.txt'), 'keep task edits');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep shared edits');
    fs.mkdirSync(path.join(wt, '.agent'));
    fs.writeFileSync(path.join(wt, '.agent/worktree-setup.sh'), 'exit 99\n');
    fs.writeFileSync(path.join(wt, '.preview-url'), 'http://nginx:8083/\n');
    const before = git(wt, 'status', '--porcelain');
    for (let stage = 0; stage < 3; stage++) {
        expect(await inspectReusableWorktree('task-one', shell(dir))).toEqual({ missing: false, previewPort: 8083 });
    }
    expect(git(wt, 'status', '--porcelain')).toBe(before);
    expect(fs.readFileSync(path.join(wt, 'unfinished.txt'), 'utf8')).toBe('keep task edits');
    expect(git(dir, 'branch', '--show-current').trim()).toBe('develop');
    expect(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8')).toBe('keep shared edits');
});

test('distinguishes absence from wrong repositories, wrong branches and broken gitdirs', async () => {
    const dir = repo('validation');
    expect(await inspectReusableWorktree('missing', shell(dir))).toEqual({ missing: true });
    git(dir, 'worktree', 'add', '.worktrees/task-two', '-b', 'task-two');
    const wt = path.join(dir, '.worktrees/task-two');
    git(wt, 'checkout', '-b', 'wrong-branch');
    await expect(inspectReusableWorktree('task-two', shell(dir))).rejects.toThrow('validation failed');
    git(wt, 'checkout', 'task-two');
    const other = repo('other');
    git(other, 'worktree', 'add', path.join(dir, '.worktrees/foreign'), '-b', 'foreign');
    await expect(inspectReusableWorktree('foreign', shell(dir))).rejects.toThrow('validation failed');
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /missing/carapa-gitdir\n');
    await expect(inspectReusableWorktree('task-two', shell(dir))).rejects.toThrow('validation failed');
    await expect(inspectReusableWorktree('../escape', shell(dir))).rejects.toThrow('Invalid');
    await expect(inspectReusableWorktree('task-two', async () => ({ code: 1, stdout: '', stderr: 'transport failure' }))).rejects.toThrow('transport failure');
});

test('rejects a .worktrees entry that is a symlink to a same-repo worktree on the same branch', async () => {
    const dir = repo('symlink');
    const outside = path.join(root, 'symlink-outside');
    git(dir, 'worktree', 'add', outside, '-b', 'linked-task');
    fs.mkdirSync(path.join(dir, '.worktrees'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, '.worktrees/linked-task'));
    await expect(inspectReusableWorktree('linked-task', shell(dir))).rejects.toThrow('not a plain worktree');
});

test('keeps stable previews,repairs missing registry entries, and handles stacks without previews', async () => {
    const dir = repo('preview');
    git(dir, 'worktree', 'add', '.worktrees/preview-task', '-b', 'preview-task');
    const urlFile = path.join(dir, '.worktrees/preview-task/.preview-url');
    fs.writeFileSync(urlFile, 'http://nginx:8083/\n');
    let registeredPort: number | undefined = 8083;
    let repairs = 0;
    let writes = 0;
    const deps = {
        execShell: shell(dir),
        previewEnabled: true,
        readPreviewPort: () => registeredPort,
        restorePreview: async () => { repairs++; return 8084; },
        writePreview: async (port: number) => { writes++; fs.writeFileSync(urlFile, `http://nginx:${port}/\n`); },
    };
    expect(await reuseManagedWorktree('preview-task', dir, deps)).toContain('preview_port=8083');
    expect([repairs, writes]).toEqual([0, 0]);
    registeredPort = undefined;
    expect(await reuseManagedWorktree('preview-task', dir, deps)).toContain('preview_port=8084');
    expect([repairs, writes]).toEqual([1, 1]);
    expect(fs.readFileSync(urlFile, 'utf8')).toBe('http://nginx:8084/\n');
    expect(await reuseManagedWorktree('preview-task', dir, { ...deps, previewEnabled: false })).not.toContain('preview_port=');
    expect([repairs, writes]).toEqual([1, 1]);
    await expect(reuseManagedWorktree('preview-task', dir, { ...deps, restorePreview: async () => undefined })).rejects.toThrow('restore worktree preview');
    expect(await reuseManagedWorktree('absent', dir, deps)).toBe('worktree_missing=1');
    expect([repairs, writes]).toEqual([1, 1]);
});

test('reuse output reports the given host repo path, not a volume name', async () => {
    const dir = repo('host-path');
    git(dir, 'worktree', 'add', '-b', 'host-task', path.join(dir, '.worktrees', 'host-task'));
    const out = await reuseManagedWorktree('host-task', '/home/user/repos/carapa-brain', {
        execShell: shell(dir),
        previewEnabled: false,
        readPreviewPort: () => undefined,
        restorePreview: async () => undefined,
        writePreview: async () => {},
    });
    expect(out).toContain('worktree_path=/home/user/repos/carapa-brain/.worktrees/host-task');
    expect(out).not.toContain('carapa-mount-');
});
