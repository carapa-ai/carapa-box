import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPreviewSyncScript, parsePreviewConfName, previewConfName } from './worktree-preview.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-wt-preview-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const TMPL = 'server { listen __PORT__; # __BRANCH__\n}\n';

function conf(port: number) {
    return `server { listen ${port}; }\n`;
}

/** Runs the real in-nginx script against a temp dir; returns the dir and the printed port. */
function run(dir: string, owner: string, branch: string, live: string[], prune = true, wait = 60) {
    const rendered = TMPL.split('__BRANCH__').join(branch);
    const script = buildPreviewSyncScript({
        owner, branch, liveBranches: live, prune,
        base64Conf: Buffer.from(rendered).toString('base64'),
        wtDir: dir, lockWaitSeconds: wait,
    });
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    return { out: r.stdout, status: r.status, port: Number(r.stdout.match(/PREVIEW_PORT=(\d+)/)?.[1]) };
}

test('conf names carry owner and branch and parse back', () => {
    expect(previewConfName('demo-site-admin', 'task-1')).toBe('demo-site-admin@task-1.conf');
    expect(parsePreviewConfName('demo-site-admin@task-1.conf')).toEqual({ owner: 'demo-site-admin', branch: 'task-1' });
    expect(parsePreviewConfName('legacy-branch.conf')).toBeUndefined();
    expect(parsePreviewConfName('demo-site--running.conf')).toBeUndefined();
});

test('add in one instance never prunes another instance or unprefixed confs', () => {
    const dir = path.join(root, 'shared');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'legacy-task.conf'), conf(8081));
    fs.writeFileSync(path.join(dir, 'demo-site-admin@running.conf'), conf(8082));
    fs.writeFileSync(path.join(dir, 'demo-site@gone.conf'), conf(8083));
    fs.writeFileSync(path.join(dir, 'demo-site@kept.conf'), conf(8084));

    // Instance "demo-site" sees only its own worktrees: "kept" and the new "fresh".
    const { port } = run(dir, 'demo-site', 'fresh', ['kept', 'fresh']);

    expect(fs.readdirSync(dir).sort()).toEqual([
        'demo-site-admin@running.conf', 'demo-site@fresh.conf', 'demo-site@kept.conf', 'legacy-task.conf',
    ]);
    // Foreign and unprefixed ports stay reserved (8081, 8082); the pruned 8083 is free again.
    expect(port).toBe(8083);
    expect(fs.readFileSync(path.join(dir, 'demo-site@fresh.conf'), 'utf8')).toContain('listen 8083;');
});

test('same branch in two instances gets separate confs and ports; refresh keeps the port', () => {
    const dir = path.join(root, 'same-branch');
    fs.mkdirSync(dir);
    const a = run(dir, 'demo-site', 'task', ['task']);
    const b = run(dir, 'demo-site-admin', 'task', ['task']);
    expect(a.port).not.toBe(b.port);
    expect(fs.readdirSync(dir).sort()).toEqual(['demo-site-admin@task.conf', 'demo-site@task.conf']);
    expect(run(dir, 'demo-site', 'task', ['task']).port).toBe(a.port);
});

test('unknown live set skips pruning', () => {
    const dir = path.join(root, 'no-prune');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'demo-site@other.conf'), conf(8081));
    run(dir, 'demo-site', 'task', [], false);
    expect(fs.existsSync(path.join(dir, 'demo-site@other.conf'))).toBe(true);
});

test('owners that differ only by hyphens never touch each other, nor unprefixed files that look prefixed', () => {
    const dir = path.join(root, 'hyphens');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'demo-site-admin-@running.conf'), conf(8081));
    fs.writeFileSync(path.join(dir, 'demo-site--running.conf'), conf(8082)); // unprefixed branch "demo-site--running"
    fs.writeFileSync(path.join(dir, 'demo-site-admin--blue@live.conf'), conf(8083));
    const a = run(dir, 'demo-site-admin', 'x', ['x']);
    const b = run(dir, 'demo-site', 'running', ['running']);
    run(dir, 'demo-site-admin--blue', 'other', ['other', 'live']);
    expect(a.port).toBe(8084);
    expect(b.port).toBe(8085);
    expect(fs.readFileSync(path.join(dir, 'demo-site--running.conf'), 'utf8')).toContain('listen 8082;');
    expect(fs.readdirSync(dir).sort()).toEqual([
        'demo-site--running.conf', 'demo-site-admin--blue@live.conf', 'demo-site-admin--blue@other.conf',
        'demo-site-admin-@running.conf', 'demo-site-admin@x.conf', 'demo-site@running.conf',
    ]);
});

test('instances serialize on a lock in the shared folder and abort when it is held', () => {
    const dir = path.join(root, 'locked');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, '.preview.lock'));
    const r = run(dir, 'demo-site', 'task', ['task'], true, 1);
    expect(r.out).toContain('PREVIEW_LOCK_TIMEOUT');
    expect(r.port).toBeNaN();
    expect(fs.readdirSync(dir)).toEqual(['.preview.lock']); // lock of the other holder untouched, nothing written
});
