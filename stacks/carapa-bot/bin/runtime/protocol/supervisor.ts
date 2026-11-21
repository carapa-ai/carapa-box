import { appendFileSync, closeSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite } from '../files';
import { containerInstanceId, terminateProcessTree } from '../processes';
import type { DaemonIdentity, DaemonSpec } from './daemon';
import { sessionBusy } from '../sessions';

const configPath = process.argv[2];
if (!configPath) throw new Error('usage: supervisor.ts <launch-config>');
const spec = JSON.parse(readFileSync(configPath, 'utf8')) as DaemonSpec & { generation: string };
rmSync(configPath, { force: true });
const logFd = openSync(spec.stderr, 'a', 0o600);
const outputFd = openSync(spec.output, 'a', 0o600);
closeSync(outputFd);
const child = spawn(spec.command[0], spec.command.slice(1), {
  cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', logFd],
});
if (!child.stdin || !child.stdout) throw new Error('Supervisor requires provider stdio pipes');
const input = child.stdin;
const output = child.stdout;
closeSync(logFd);
let stopped = false;
let flushing = false;
let timer: ReturnType<typeof setInterval> | undefined;
let reaper: ReturnType<typeof setInterval> | undefined;
const startedAt = Date.now();
const ownerPath = join(spec.input, 'owner.json');

function removePidFile(path: string): void {
  // A replacement daemon may already have recorded its own PID.
  try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true }); } catch { /* absent */ }
}

async function stop(code: number): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  if (reaper) clearInterval(reaper);
  rmSync(ownerPath, { force: true });
  // The runner records this supervisor's PID here; a stale file could later name a reused PID.
  if (spec.sessionDir) removePidFile(join(spec.sessionDir, 'daemon.pid'));
  if (child.pid) await terminateProcessTree(child.pid, 1_000);
  atomicWrite(join(spec.input, 'exit.json'), JSON.stringify({ code, generation: spec.generation }));
  process.exitCode = code;
}

output.on('data', (bytes: Buffer) => {
  try { appendFileSync(spec.output, bytes); }
  catch (error) { process.stderr.write(`protocol output: ${String(error)}\n`); void stop(1); }
});
input.on('error', () => { void stop(1); });
child.on('error', error => { process.stderr.write(`${error.message}\n`); void stop(1); });
child.on('close', (code, signal) => { void stop(code ?? (signal ? 1 : 0)); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { void stop(0); });

async function flush(): Promise<void> {
  if (flushing || stopped) return;
  flushing = true;
  try {
    const requests = join(spec.input, 'requests');
    for (const name of readdirSync(requests).filter(name => name.endsWith('.json')).sort()) {
      if (stopped) break;
      const path = join(requests, name);
      const request = JSON.parse(readFileSync(path, 'utf8')) as { generation: string; line: string };
      if (request.generation !== spec.generation || typeof request.line !== 'string') throw new Error('Invalid protocol request generation');
      await new Promise<void>((resolve, reject) => input.write(request.line, error => error ? reject(error) : resolve()));
      rmSync(path);
    }
  } catch (error) {
    process.stderr.write(`protocol input: ${String(error)}\n`);
    await stop(1);
  } finally { flushing = false; }
}

child.once('spawn', () => {
  if (stopped) return;
  const identity: DaemonIdentity = { version: 2, pid: process.pid, instance: containerInstanceId(), generation: spec.generation };
  atomicWrite(ownerPath, JSON.stringify(identity));
  timer = setInterval(() => { void flush(); }, 10);
  if (spec.sessionDir && spec.idleMs && Number.isFinite(spec.idleMs) && spec.idleMs > 0) {
    reaper = setInterval(() => {
      if (!spec.sessionDir || sessionBusy(spec.sessionDir)) return;
      const lastUsed = statSync(join(spec.sessionDir, 'last_used'), { throwIfNoEntry: false })?.mtimeMs ?? startedAt;
      if (Date.now() - lastUsed > spec.idleMs!) void stop(0);
    }, Math.min(spec.idleMs, 60_000));
  }
});
