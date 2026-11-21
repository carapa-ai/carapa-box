import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './files';
import { isAlive, matchesCurrentInstance, terminateProcessTree } from './processes';
import { clearStaleLifecycleLock, discardedSessionIds, discardMarker, readOwnedPid, readText, safeSessionKey, sessionBusy } from './sessions';
import { stopRun } from './stop';
import { createRunContext } from './contracts';
import { ensureRunTerminal } from './run-v1';

export type LifecycleAction = 'interrupt' | 'stop-daemon' | 'discard-conversation';
export interface LifecycleResult { ok: boolean; action: LifecycleAction; error?: string }

/** Never follow an IPC pointer into another workspace or a sibling conversation. */
function ownedSession(runDir: string): string | undefined {
  const pointer = readText(join(runDir, 'session_dir'));
  if (!pointer) return undefined;
  const session = realpathSync(pointer);
  const sessionsRoot = resolve(dirname(dirname(runDir)), 'sessions');
  const inRun = session.startsWith(`${runDir}/`);
  const inSessions = dirname(session) === sessionsRoot && realpathSync(sessionsRoot) === sessionsRoot;
  if (!inRun && !inSessions) throw new Error('Session pointer is outside this run or its IPC sessions directory');
  const args = JSON.parse(readFileSync(join(runDir, 'args.json'), 'utf8'));
  if (inSessions && args.persistent === '1' &&
      (typeof args.conversationKey !== 'string' || basename(session) !== safeSessionKey(args.conversationKey))) {
    throw new Error('Session pointer does not match this conversation');
  }
  const instance = readText(join(session, 'container_instance'));
  if (instance && !matchesCurrentInstance(join(session, 'container_instance'), instance)) throw new Error('Session belongs to an earlier container');
  if (sessionBusy(session) && readText(join(session, 'active_run')) !== runDir) throw new Error('Another run owns this session');
  return session;
}

async function interrupt(runDir: string): Promise<void> {
  if (existsSync(join(runDir, 'metrics_complete'))) return;
  atomicWrite(join(runDir, 'turn_interrupt'), 'requested');
  if (!existsSync(join(runDir, 'agent-control.json')) && !existsSync(join(runDir, 'codex-control.json'))) {
    // One-shot CLI adapters have no in-session interrupt protocol. Kill only
    // their run; native provider history is retained for an explicit resume.
    const result = await stopRun(runDir);
    if (result.status === 'failed' || result.status === 'no_pid') throw new Error('Run could not be interrupted');
    return;
  }
  const id = randomUUID();
  const requests = join(runDir, 'control-requests');
  const response = join(runDir, 'control-responses', `${id}.json`);
  mkdirSync(requests, { recursive: true });
  atomicWrite(join(requests, `${id}.json`), JSON.stringify({ id, action: 'interrupt' }));
  const deadline = Date.now() + 10_000;
  let accepted = false;
  while (Date.now() < deadline) {
    if (existsSync(response)) {
      const result = JSON.parse(readFileSync(response, 'utf8'));
      if (!result.ok) {
        rmSync(join(runDir, 'turn_interrupt'), { force: true });
        throw new Error(result.error || 'Harness rejected interruption');
      }
      accepted = true;
      rmSync(response);
    }
    if (accepted && existsSync(join(runDir, 'metrics_complete'))) return;
    await Bun.sleep(25);
  }
  throw new Error('Turn did not confirm interruption; stop-daemon is a separate operation');
}

export async function controlRun(runDirInput: string, action: LifecycleAction): Promise<LifecycleResult> {
  let lifecycleLock: string | undefined;
  try {
    if (!['interrupt', 'stop-daemon', 'discard-conversation'].includes(action)) throw new Error('Unknown lifecycle action');
    const runDir = realpathSync(runDirInput);
    const instance = readText(join(runDir, 'session_instance'));
    if (instance && !matchesCurrentInstance(join(runDir, 'session_instance'), instance)) throw new Error('Run belongs to an earlier container');
    const session = ownedSession(runDir);
    if (session) {
      lifecycleLock = join(session, 'lifecycle.lock');
      clearStaleLifecycleLock(session);
      try { mkdirSync(lifecycleLock); }
      catch (error) { lifecycleLock = undefined; throw error; }
      atomicWrite(join(lifecycleLock, 'pid'), String(process.pid));
      // Recheck after excluding new turn claims.
      ownedSession(runDir);
    }
    if (action === 'interrupt') await interrupt(runDir);
    else {
      if (session) {
        const daemon = readOwnedPid(join(session, 'daemon.pid'));
        if (daemon !== undefined && isAlive(daemon)) await terminateProcessTree(daemon, 1_000);
      }
      const result = await stopRun(runDir);
      if (result.status === 'failed') throw new Error('Run could not be stopped');
      const worker = readOwnedPid(join(runDir, 'worker.pid'));
      if (worker !== undefined && isAlive(worker)) await terminateProcessTree(worker, 1_000);
      // A hard stop can kill the translator before it emits its terminal frame.
      // Finalize only after its worker is gone, preserving an already-finished run.
      ensureRunTerminal(createRunContext(runDir, resolve(import.meta.dir, '..')), 137, new Error('Runtime stopped'));
      if (action === 'discard-conversation') {
        const args = JSON.parse(readFileSync(join(runDir, 'args.json'), 'utf8'));
        if (typeof args.conversationKey === 'string' && args.conversationKey) {
          const marker = discardMarker(runDir, args.conversationKey);
          mkdirSync(dirname(marker), { recursive: true });
          const sessionIds = new Set(existsSync(marker) ? discardedSessionIds(marker) : []);
          // Codex writes thread_id when the thread starts; session_id only lands when the first turn ends.
          for (const id of [args.sessionId, session && readText(join(session, 'session_id')), session && readText(join(session, 'thread_id'))]) {
            if (typeof id === 'string' && id) sessionIds.add(id);
          }
          atomicWrite(marker, JSON.stringify({ discardedAt: new Date().toISOString(), sessionIds: [...sessionIds] }));
        }
        if (session) rmSync(session, { recursive: true, force: true });
      }
    }
    return { ok: true, action };
  } catch (error) {
    return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
  } finally { if (lifecycleLock) rmSync(lifecycleLock, { recursive: true, force: true }); }
}
