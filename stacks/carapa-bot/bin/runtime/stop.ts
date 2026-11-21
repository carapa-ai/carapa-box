import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, writeRunFile } from './files';
import {
  containerInstanceId,
  isAlive,
  matchesCurrentInstance,
  signalProcessGroupMembers,
  terminateOwnedRun,
  terminateProcessTree,
} from './processes';

import { sessionBusy, readText } from './sessions';

export interface StopResult {
  status:
    | 'killed'
    | 'already_dead'
    | 'failed'
    | 'no_pid'
    | 'stale_container_generation';
  pid?: number;
  run_dir?: string;
  run_instance?: string;
  current_instance?: string;
}

const readTrim = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};

const readPid = (path: string): number | null => {
  const digits = readTrim(path).replace(/\D/g, '');
  const pid = Number(digits);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

function completeStoppedRun(runDir: string): void {
  if (existsSync(join(runDir, 'clean_stop'))) return;
  const existingExitCode = readTrim(join(runDir, 'exit_code'));
  const existingMetricsStatus = readTrim(join(runDir, 'metrics_complete'));
  if (/^\d+$/.test(existingExitCode) && existingMetricsStatus) return;
  atomicWrite(join(runDir, 'metrics_complete'), 'stopped');
  writeRunFile(runDir, 'exit_code', '137');
}

export async function awaitWorkerMetrics(runDir: string, timeoutMs = 8_000): Promise<void> {
  const workerPid = readPid(join(runDir, 'worker.pid'));
  if (workerPid === null || workerPid === process.pid || !isAlive(workerPid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(join(runDir, 'metrics_complete')) || !isAlive(workerPid)) return;
    await Bun.sleep(50);
  }
}

async function stopWarmSession(runDir: string, requestedPid: number | null): Promise<void> {
  const sessionDirPath = join(runDir, 'session_dir');
  if (!existsSync(sessionDirPath)) return;
  const sessionDir = readTrim(sessionDirPath);
  if (!sessionDir || !existsSync(sessionDir)) return;
  try {
    if (!statSync(sessionDir).isDirectory()) return;
  } catch {
    return;
  }

  const daemonPid = readPid(join(sessionDir, 'daemon.pid'));
  const discard = existsSync(join(runDir, 'discard_session'));
  const shouldTeardown =
    discard ||
    requestedPid === null ||
    (daemonPid !== null && requestedPid === daemonPid) ||
    (daemonPid !== null && !isAlive(daemonPid));
  if (!shouldTeardown) return;

  for (const name of ['daemon.pid', 'holder.pid']) {
    const pid = readPid(join(sessionDir, name));
    if (pid === null) continue;
    await terminateProcessTree(pid);
  }
  if (discard) {
    rmSync(sessionDir, { recursive: true, force: true });
    return;
  }
  for (const name of [
    'daemon.pid',
    'holder.pid',
    'supervisor.pid',
    'perm_replier.pid',
    'stdin.fifo',
  ]) {
    try {
      unlinkSync(join(sessionDir, name));
    } catch {
      // Missing runtime files are expected after crashes.
    }
  }
}

/** Written when a stop begins: a worker that would restart its agent reads it and does not. */
export const stopRequestedPath = (runDir: string): string => join(runDir, 'stop_requested');

export async function stopRun(runDirInput: string, requested?: string): Promise<StopResult> {
  const runDir = resolve(runDirInput);
  const runInstance = readTrim(join(runDir, 'session_instance'));
  const currentInstance = containerInstanceId();
  if (runInstance && currentInstance &&
      !matchesCurrentInstance(join(runDir, 'session_instance'), runInstance)) {
    completeStoppedRun(runDir);
    return {
      status: 'stale_container_generation',
      run_instance: runInstance,
      current_instance: currentInstance,
    };
  }

  try {
    atomicWrite(stopRequestedPath(runDir), 'requested');
  } catch { /* A run directory that is gone has no worker to fence. */ }

  const session = readText(join(runDir, 'session_dir'));
  // Read active_run once: the owner may release it between two reads, which would look like a foreign owner.
  const activeRun = session && sessionBusy(session) ? readText(join(session, 'active_run')) : '';
  if (activeRun && activeRun !== runDir) return { status: 'failed', run_dir: runDir };

  const requestedDigits = (requested ?? '').replace(/\D/g, '');
  const requestedPid = requestedDigits ? Number(requestedDigits) : null;
  await stopWarmSession(runDir, requestedPid);

  const pid = requestedPid ?? readPid(join(runDir, 'pid'));
  if (pid === null) return { status: 'no_pid', run_dir: runDir };
  const pgid = readPid(join(runDir, 'pgid')) ?? pid;
  const tagged = existsSync(join(runDir, 'pgid'));
  if (!isAlive(pid)) {
    if (tagged) {
      signalProcessGroupMembers(pgid, 'SIGTERM', [process.pid]);
      await Bun.sleep(50);
      signalProcessGroupMembers(pgid, 'SIGKILL', [process.pid]);
    }
    await awaitWorkerMetrics(runDir);
    completeStoppedRun(runDir);
    return { status: 'already_dead', pid };
  }

  const killed = await terminateOwnedRun(pgid, {
    processGroup: tagged,
    graceMs: 1_000,
    exclude: [process.pid],
  });
  if (!killed) return { status: 'failed', pid };
  await awaitWorkerMetrics(runDir);
  completeStoppedRun(runDir);
  return { status: 'killed', pid };
}
