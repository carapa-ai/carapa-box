import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from '../files';
import { isAlive, matchesCurrentInstance, terminateProcessTree } from '../processes';

export interface DaemonSpec {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  input: string;
  output: string;
  stderr: string;
  idleMs?: number;
  sessionDir?: string;
}

export interface DaemonIdentity {
  // Version 2 guarantees the stable browser context pointer for warm turns.
  version: 2;
  pid: number;
  instance: string;
  generation: string;
}

export function daemonIdentity(input: string): DaemonIdentity | undefined {
  try {
    const ownerPath = join(input, 'owner.json');
    const value = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (value.version === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        matchesCurrentInstance(ownerPath, value.instance) && typeof value.generation === 'string' && isAlive(value.pid)) return value;
  } catch { /* Dead or pre-supervisor daemon. */ }
}

/** A supervisor owns the provider's pipes. Callers can exit without closing stdin.
 * Aborting `signal` stops the launch: before the spawn nothing starts, after it the supervisor is reaped. */
export async function startProtocolDaemon(spec: DaemonSpec, signal?: AbortSignal): Promise<{ pid: number; offset: number }> {
  if (signal?.aborted) throw new Error('Protocol supervisor startup cancelled');
  if (spec.sessionDir && existsSync(join(spec.sessionDir, 'active_run'))) {
    spec = { ...spec, env: { ...spec.env, CARAPA_BROWSER_CONTEXT_FILE: join(spec.sessionDir, 'active_run') } };
  }
  if (daemonIdentity(spec.input)) throw new Error('Protocol daemon is already running');
  // Only the exact transport directory for this session is replaced. Provider history stays.
  rmSync(spec.input, { recursive: true, force: true });
  mkdirSync(join(spec.input, 'requests'), { recursive: true, mode: 0o700 });
  const generation = randomUUID();
  const configPath = join(spec.input, 'launch.json');
  atomicWrite(configPath, JSON.stringify({ ...spec, generation }));
  // The launch configuration contains scoped credentials; it is consumed and removed at boot.
  const { chmodSync } = await import('node:fs');
  chmodSync(configPath, 0o600);
  const log = openSync(spec.stderr, 'a', 0o600);
  const offset = existsSync(spec.output) ? statSync(spec.output).size : 0;
  const child = spawn(process.execPath, ['--no-env-file', join(import.meta.dir, 'supervisor.ts'), configPath], {
    cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.unref();
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (signal?.aborted) throw new Error('Protocol supervisor startup cancelled');
      const owner = daemonIdentity(spec.input);
      if (owner?.generation === generation && owner.pid === child.pid) return { pid: owner.pid, offset };
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Protocol supervisor failed to start');
      await Bun.sleep(10);
    }
    throw new Error('Protocol supervisor startup timed out');
  } catch (error) {
    if (child.pid) await terminateProcessTree(child.pid);
    throw error;
  } finally {
    rmSync(configPath, { force: true });
  }
}

let sequence = 0;
/** Atomic spool entries avoid FIFO buffer limits and partial writes of large prompts. */
export function sendProtocolLine(input: string, line: string): void {
  const owner = daemonIdentity(input);
  if (!owner) throw new Error('Protocol supervisor is no longer available');
  const name = `${String(Date.now()).padStart(16, '0')}-${process.pid}-${String(sequence++).padStart(12, '0')}.json`;
  atomicWrite(join(input, 'requests', name), JSON.stringify({ generation: owner.generation, line }));
}

export function sendProtocol(input: string, value: unknown): void {
  sendProtocolLine(input, `${JSON.stringify(value)}\n`);
}
