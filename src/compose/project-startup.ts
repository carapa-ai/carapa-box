import fs from 'node:fs/promises';
import path from 'node:path';
import { execDocker, splitDockerOutput } from '../utils.js';
import { atomicJson, isValidIngressIdentifier } from '../ingress.js';
import { getStateDir } from '../installation-paths.js';
import { logger } from '../logger.js';

/** Run repository code only in the selected container, with its configured user/CWD. */
export async function runProjectAfterStart(
    projectName: string,
    service?: string,
    onLog?: (message: string) => void,
    deps = { execDocker, timeoutSeconds: 120 },
): Promise<string> {
    const selected = service || 'agent';
    // Inspect the running instance rather than re-rendering its original Compose
    // model: workspace/env overrides may have been supplied only at start time.
    const services = await deps.execDocker(['ps', '--all', '--quiet',
        '--filter', `label=com.docker.compose.project=${projectName}`,
        '--filter', `label=com.docker.compose.service=${selected}`]);
    if (services.status !== 0) throw new Error(`Cannot discover project startup service: ${services.stderr}`);
    const containers = splitDockerOutput(services.stdout);
    if (!containers.length) {
        if (!service) return ''; // Non-agent stacks have no project hook.
        throw new Error(`Project startup service ${selected} is absent from ${projectName}`);
    }
    if (containers.length !== 1) throw new Error(`Project startup requires one ${selected} container in ${projectName}`);

    const absent = '__CARAPA_PROJECT_AFTER_START_ABSENT__';
    const script = [
        `if [ ! -e .agent/after-start.sh ] && [ ! -L .agent/after-start.sh ]; then echo ${absent}; exit 0; fi`,
        '[ -f .agent/after-start.sh ] && [ -r .agent/after-start.sh ] || { echo "Project hook is not a readable file" >&2; exit 1; }',
        // Bound execution inside the container. Aborting only the Docker client
        // would leave a stuck foreground hook running in the sandbox.
        `exec timeout -k 5 ${deps.timeoutSeconds} sh .agent/after-start.sh`,
    ].join('\n');
    const signal = AbortSignal.timeout((deps.timeoutSeconds + 10) * 1000);
    const result = await deps.execDocker(['exec', containers[0]!, 'sh', '-c', script], { onLog, signal });
    if (signal.aborted || result.status !== 0) {
        const reason = signal.aborted || result.status === 124
            ? `timed out after ${deps.timeoutSeconds}s`
            : `failed (exit ${result.status})`;
        const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
        throw new Error(`Sandbox is running, but .agent/after-start.sh ${reason} in ${selected}.${detail ? `\n${detail}` : ''}`);
    }
    if (result.stdout.trim() === absent) return '';
    return `[project after-start] .agent/after-start.sh completed in ${selected}`;
}

/* Docker's restart policy (host reboot, OOM recovery) restarts sandbox containers
 * without sandbox_start, so processes started by the project hook are lost. Each
 * managed start records the hook service and its container start time; a later
 * container start with a different time reruns only the project hook. Stack
 * host hooks are not rerun: their file effects survive a container restart and
 * they depend on caller env supplied only to sandbox_start. */

interface StartupRecord { service?: string; startedAt: string }
const startupDefaults = () => ({
    execDocker, timeoutSeconds: 120, directory: path.join(getStateDir(), 'project-startup'),
});
type StartupDeps = ReturnType<typeof startupDefaults>;

const locks = new Map<string, Promise<void>>();

/** Serialize a managed start and Docker-initiated resumes of the same project. */
export async function lockProjectStartup(projectName: string): Promise<() => void> {
    const previous = locks.get(projectName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(projectName, current);
    await previous;
    return () => {
        release();
        if (locks.get(projectName) === current) locks.delete(projectName);
    };
}

async function runningStartedAt(projectName: string, service: string, deps: StartupDeps) {
    const listed = await deps.execDocker(['ps', '--quiet',
        '--filter', `label=com.docker.compose.project=${projectName}`,
        '--filter', `label=com.docker.compose.service=${service}`]);
    const ids = listed.status === 0 ? splitDockerOutput(listed.stdout) : [];
    if (ids.length !== 1) return undefined;
    const inspected = await deps.execDocker(['inspect', '--format', '{{.State.StartedAt}}', ids[0]!]);
    return inspected.status === 0 ? inspected.stdout.trim() || undefined : undefined;
}

/** Remember which service's hook this managed start ran, for its current container. */
export async function recordProjectStartup(projectName: string, service?: string, deps = startupDefaults()) {
    const startedAt = await runningStartedAt(projectName, service || 'agent', deps);
    if (!startedAt) return;
    const record: StartupRecord = { service, startedAt };
    await atomicJson(path.join(deps.directory, `${projectName}.json`), record);
}

/** Rerun the project hook when a recorded sandbox's container restarted outside sandbox_start. */
export async function resumeProjectStartup(projectName: string, deps = startupDefaults()) {
    if (!isValidIngressIdentifier(projectName)) return;
    const release = await lockProjectStartup(projectName);
    try {
        const file = path.join(deps.directory, `${projectName}.json`);
        let record: StartupRecord;
        try { record = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
        const startedAt = await runningStartedAt(projectName, record.service || 'agent', deps);
        if (!startedAt || startedAt === record.startedAt) return;
        // Record first: a failing hook is reported once per container start, not retried in a loop.
        await atomicJson(file, { service: record.service, startedAt } satisfies StartupRecord);
        logger.info({ projectName }, '[project after-start] Container restarted outside sandbox_start; rerunning project hook');
        const result = await runProjectAfterStart(projectName, record.service, undefined, deps);
        if (result) logger.info({ projectName }, result);
    } catch (error) {
        logger.warn({ projectName, err: error }, '[project after-start] Resume after container restart failed');
    } finally {
        release();
    }
}

/** Boot sweep: containers Docker restarted before this controller was watching events. */
export async function resumeAllProjectStartups(deps = startupDefaults()) {
    const files = await fs.readdir(deps.directory).catch((error: any) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
    });
    for (const file of files) {
        if (file.endsWith('.json')) await resumeProjectStartup(file.slice(0, -5), deps);
    }
}
