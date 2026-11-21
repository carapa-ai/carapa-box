import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordProjectStartup, resumeAllProjectStartups, runProjectAfterStart } from './project-startup.js';
import type { execDocker } from '../utils.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-project-startup-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name: string, hook?: string) {
    const checkout = path.join(root, name);
    fs.mkdirSync(path.join(checkout, '.agent'), { recursive: true });
    if (hook !== undefined) fs.writeFileSync(path.join(checkout, '.agent/after-start.sh'), hook);
    const calls: string[] = [];
    const deps = {
        timeoutSeconds: 1,
        execDocker: (async (args, options) => {
            if (args[0] === 'ps') {
                expect(args).toContain('label=com.docker.compose.project=stack-project');
                const service = args.at(-1)!.split('=').at(-1)!;
                calls.push(service);
                return { status: 0, stdout: ['agent', 'web'].includes(service) ? 'container-id\n' : '', stderr: '' };
            }
            expect(args.slice(0, 2)).toEqual(['exec', 'container-id']);
            expect(options?.env).toBeUndefined(); // No controller or provisioning secrets.
            // Execute the real hook wrapper in a disposable checkout. Docker
            // selects the user/CWD in production; this fixture supplies that CWD.
            const child = Bun.spawn(args.slice(2), {
                cwd: checkout, env: { PATH: process.env.PATH },
                stdout: 'pipe', stderr: 'pipe', signal: options?.signal,
            });
            const [stdout, stderr, status] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            return { stdout, stderr, status };
        }) as typeof execDocker,
    };
    return { checkout, calls, deps };
}

test('runs the project hook on each managed start in the selected service and checkout', async () => {
    const f = fixture("project with ' spaces", 'printf "%s\\n" "$PWD" >> starts\n');
    for (let start = 0; start < 2; start++) {
        expect(await runProjectAfterStart('stack-project', 'web', undefined, f.deps))
            .toContain('completed in web');
    }
    expect(fs.readFileSync(path.join(f.checkout, 'starts'), 'utf8')).toBe(`${f.checkout}\n${f.checkout}\n`);
    expect(f.calls).toEqual(['web', 'web']);
});

test('skips absent hooks and non-agent stacks, but rejects an explicit missing service', async () => {
    const f = fixture('absent');
    expect(await runProjectAfterStart('stack-project', undefined, undefined, f.deps)).toBe('');
    f.calls.length = 0;
    f.deps.execDocker = async args => {
        expect(args[0]).toBe('ps');
        return { status: 0, stdout: '', stderr: '' };
    };
    expect(await runProjectAfterStart('stack-project', undefined, undefined, f.deps)).toBe('');
    await expect(runProjectAfterStart('stack-project', 'web', undefined, f.deps))
        .rejects.toThrow('service web is absent');
    expect(f.calls).toEqual([]);
});

test('reports hook failures and terminates a stuck foreground hook', async () => {
    const failure = fixture('failure', 'echo app-not-ready >&2\nexit 9\n');
    await expect(runProjectAfterStart('stack-project', undefined, undefined, failure.deps))
        .rejects.toThrow('failed (exit 9) in agent.\napp-not-ready');
    const stuck = fixture('stuck', 'echo $$ > hook.pid\nexec sleep 60\n');
    await expect(runProjectAfterStart('stack-project', undefined, undefined, stuck.deps))
        .rejects.toThrow('timed out after 1s');
    const pid = Number(fs.readFileSync(path.join(stuck.checkout, 'hook.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
});

test('reruns the hook only after a Docker-initiated restart of a recorded sandbox', async () => {
    const f = fixture('resume', 'echo started >> starts\n');
    let startedAt = '2026-09-26T08:00:00Z';
    const run = f.deps.execDocker;
    const deps = {
        ...f.deps,
        directory: path.join(root, 'records'),
        execDocker: (async (args, options) => args[0] === 'inspect'
            ? { status: 0, stdout: `${startedAt}\n`, stderr: '' }
            : run(args, options)) as typeof execDocker,
    };
    const starts = () => fs.existsSync(path.join(f.checkout, 'starts'))
        ? fs.readFileSync(path.join(f.checkout, 'starts'), 'utf8').split('\n').filter(Boolean).length : 0;

    await resumeAllProjectStartups(deps); // No records yet: projects CarapaBox never started are left alone.
    await recordProjectStartup('stack-project', 'web', deps); // Managed start already ran the hook.
    await resumeAllProjectStartups(deps); // Controller restart, same container start.
    expect(starts()).toBe(0);

    startedAt = '2026-09-26T09:00:00Z'; // Host reboot: Docker restarted the container.
    await resumeAllProjectStartups(deps);
    await resumeAllProjectStartups(deps);
    expect(starts()).toBe(1);
});
