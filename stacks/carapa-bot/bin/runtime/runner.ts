import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import type { HarnessPlan, RunContext } from './contracts';
import { atomicWrite, writeRunFile } from './files';
import { planHarness } from './harnesses';
import { signalProcessGroupMembers } from './processes';
import { resourceAdjustedExitCode, startResourceGuard } from './resource-guard';
import { startWatchers } from './watchers';
import { acquireSessionLock, releaseSessionLock, safeSessionKey } from './sessions';
import { ensureRunTerminal } from './run-v1';

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (!signal) return 1;
  return 128 + (constants.signals[signal] ?? 1);
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(exitCodeFor(code, signal)));
  });
}

async function measureRun(context: RunContext, startedAtMs: number, exitCode: number): Promise<void> {
  const child = spawn(
    'node',
    [join(context.binDir, 'measure-agent-run.mjs'), context.runDir, String(startedAtMs)],
    {
      cwd: context.cwd,
      env: { ...context.env, RUN_EXIT_CODE: String(exitCode) },
      stdio: 'ignore',
    },
  );
  const status = (await waitForChild(child)) === 0 ? 'ok' : 'error';
  atomicWrite(join(context.runDir, 'metrics_complete'), status);
}

export async function executeRun(context: RunContext): Promise<number> {
  const plan = await planHarness(context);
  let lock = '';
  let sessionDir = '';
  if (plan.kind === 'native' && plan.persistentResume && context.args.persistent === '1' && context.args.conversationKey) {
    sessionDir = join(dirname(dirname(context.runDir)), 'sessions', safeSessionKey(context.args.conversationKey));
    mkdirSync(sessionDir, { recursive: true });
    writeRunFile(context.runDir, 'session_dir', sessionDir);
    lock = await acquireSessionLock(sessionDir, context.runDir);
  }
  try { return await executePlannedRun(context, plan, sessionDir); }
  finally { if (lock) releaseSessionLock(lock); }
}

async function executePlannedRun(context: RunContext, plan: HarnessPlan, sessionDir: string): Promise<number> {
  const startedAtMs = Date.now();
  if (plan.kind === 'managed') {
    let exitCode = 1;
    try {
      exitCode = await plan.execute(context);
      exitCode = resourceAdjustedExitCode(context.runDir, exitCode);
    } finally {
      ensureRunTerminal(context, exitCode);
      writeRunFile(context.runDir, 'exit_code', String(exitCode));
      await measureRun(context, startedAtMs, exitCode);
    }
    return exitCode;
  }

  const stderrFd = openSync(join(context.runDir, 'agent-stderr.log'), 'a');
  const inputFd = plan.promptMode === 'stdin'
    ? openSync(join(context.runDir, 'prompt.txt'), 'r')
    : null;
  const command = [...plan.command];
  if (plan.promptMode === 'argument' && context.prompt) command.push(context.prompt);
  const sidecars: ReturnType<typeof spawn>[] = [];
  let child: ReturnType<typeof spawn> | null = null;
  try {
    for (const sidecar of plan.sidecars ?? []) {
      const process = spawn(sidecar.command[0], sidecar.command.slice(1), {
        cwd: context.cwd,
        env: context.env,
        stdio: ['ignore', 'ignore', stderrFd],
      });
      sidecars.push(process);
      if (sidecar.ready) {
        const deadline = Date.now() + sidecar.ready.timeoutMs;
        let ready = false;
        while (Date.now() < deadline && process.exitCode === null) {
          ready = await new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: sidecar.ready!.host, port: sidecar.ready!.port });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
          });
          if (ready) break;
          await Bun.sleep(100);
        }
        if (!ready) throw new Error(`sidecar failed readiness check: ${sidecar.command[0]}`);
      }
    }
    child = spawn(command[0], command.slice(1), {
      cwd: context.cwd,
      env: context.env,
      detached: true,
      stdio: [inputFd ?? 'ignore', 'ignore', stderrFd],
    });
  } catch (error) {
    for (const sidecar of sidecars) sidecar.kill('SIGTERM');
    if (inputFd !== null) closeSync(inputFd);
    closeSync(stderrFd);
    throw error;
  }
  if (inputFd !== null) closeSync(inputFd);
  if (!child.pid) {
    for (const sidecar of sidecars) sidecar.kill('SIGTERM');
    closeSync(stderrFd);
    throw new Error(`failed to launch ${context.args.agentCmd}`);
  }
  writeRunFile(context.runDir, 'pid', String(child.pid));
  writeRunFile(context.runDir, 'pgid', String(child.pid));
  const resourceGuard = startResourceGuard(context, child.pid);
  const watchers = startWatchers(context, child.pid);
  let exitCode = 1;
  try {
    exitCode = await waitForChild(child);
  } finally {
    resourceGuard.stop();
    watchers.stop();
    closeSync(stderrFd);
    for (const sidecar of sidecars) {
      if (sidecar.exitCode === null && sidecar.signalCode === null) sidecar.kill('SIGTERM');
    }
  }
  exitCode = resourceAdjustedExitCode(context.runDir, exitCode);
  writeRunFile(context.runDir, 'exit_code', String(exitCode));
  if (existsSync(join(context.runDir, 'clean_stop'))) {
    exitCode = 0;
    rmSync(join(context.runDir, 'clean_stop'), { force: true });
    writeRunFile(context.runDir, 'exit_code', '0');
  }
  signalProcessGroupMembers(child.pid, 'SIGTERM', [process.pid]);
  await Bun.sleep(50);
  signalProcessGroupMembers(child.pid, 'SIGKILL', [process.pid]);
  ensureRunTerminal(context, exitCode);
  if (sessionDir) {
    const events = readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const session = events.reverse().find(event => event.type === 'session' && typeof event.id === 'string');
    if (session) atomicWrite(join(sessionDir, 'session_id'), session.id);
    atomicWrite(join(sessionDir, 'last_used'), '');
  }
  await measureRun(context, startedAtMs, exitCode);
  return exitCode;
}

export function writeFailedRun(context: RunContext, error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  appendFileSync(join(context.runDir, 'agent-stderr.log'), `[agent-runtime] ${message}\n`);
  ensureRunTerminal(context, 1, error);
  writeFileSync(join(context.runDir, 'exit_code'), '1');
  atomicWrite(join(context.runDir, 'metrics_complete'), 'error');
}
