import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStopAgentsCommand, stopSandboxProcesses } from './client.js';

let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-shutdown-')); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('shutdown drains the configured PHP service and skips stopped services', async () => {
    await fs.writeFile(path.join(root, 'ssh.json'), JSON.stringify({ service: 'php84', port: 2222 }));
    const calls: string[] = [];
    let state = 'running';
    const deps = {
        getStackStatus: async () => ({ code: 0, stderr: '', stdout: JSON.stringify([
            { Service: 'nginx', State: 'running' }, { Service: 'php84', State: state },
        ]) }),
        execInService: async (_stack: string, service: string) => {
            calls.push(service);
            return { code: 0, stdout: '', stderr: '' };
        },
    };
    await stopSandboxProcesses(root, 'demo_app-demo-app', undefined, deps);
    expect(calls).toEqual(['php84']);
    state = 'exited';
    await stopSandboxProcesses(root, 'demo_app-demo-app', undefined, deps);
    expect(calls).toEqual(['php84']);
});

test('stop loop calls stop-agent.sh only for run dirs with a live pid', async () => {
    const tree = await fs.mkdtemp(path.join(root, 'ipc-'));
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'calls.log');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'stop-agent.sh'), `#!/bin/sh\necho "$1" >> '${log}'\n`, { mode: 0o755 });
    await fs.mkdir(path.join(tree, 'runs', 'a'), { recursive: true });
    await fs.mkdir(path.join(tree, 'runs', 'b'), { recursive: true });
    await fs.mkdir(path.join(tree, 'sessions', 's1'), { recursive: true });
    await fs.mkdir(path.join(tree, 'ssh'), { recursive: true });
    await fs.writeFile(path.join(tree, 'runs', 'a', 'pid'), String(process.pid));
    await fs.writeFile(path.join(tree, 'runs', 'b', 'pid'), '999999');
    const proc = Bun.spawn(['sh', '-c', buildStopAgentsCommand(tree)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
    expect(lines).toEqual([`${tree}/runs/a/`]);
});
