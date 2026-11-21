import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWrite } from './files';
import { containerInstanceId, isAlive, writtenBeforeBoot } from './processes';

export function safeSessionKey(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '_'); }
export function readText(path: string): string {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
export function readOwnedPid(path: string): number | undefined {
  const pid = Number(readText(path));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function sessionBusy(sessionDir: string): boolean {
  const lock = join(sessionDir, 'lock');
  const owner = readOwnedPid(join(lock, 'pid'));
  if (owner !== undefined) return !writtenBeforeBoot(join(lock, 'pid')) && isAlive(owner);
  // Give the acquiring process time to publish its identity after mkdir.
  // The lock may be released between checks; a missing lock is not busy.
  const mtimeMs = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
  return mtimeMs !== undefined && Date.now() - mtimeMs < 5_000;
}

/** A lifecycle lock is stale when its controller is dead, predates this boot, or never published a pid. */
export function staleLifecycleLock(lifecycle: string): boolean {
  const controller = readOwnedPid(join(lifecycle, 'pid'));
  if (controller !== undefined) return !isAlive(controller) || writtenBeforeBoot(join(lifecycle, 'pid'));
  return Date.now() - (statSync(lifecycle, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 5_000;
}

/** Removes the session's lifecycle.lock when stale; returns true when none remains to wait for. */
export function clearStaleLifecycleLock(sessionDir: string): boolean {
  const lifecycle = join(sessionDir, 'lifecycle.lock');
  if (!existsSync(lifecycle)) return true;
  if (!staleLifecycleLock(lifecycle)) return false;
  rmSync(lifecycle, { recursive: true, force: true });
  return true;
}

/** Locks serialize turns and lifecycle changes independently of Board's lifetime. */
export async function acquireSessionLock(sessionDir: string, runDir: string, timeoutMs = 600_000): Promise<string> {
  const lock = join(sessionDir, 'lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Maintenance may retire an idle directory while a new turn is preparing.
    // Recreate it and claim the turn before opening any provider state.
    mkdirSync(sessionDir, { recursive: true });
    const lifecycle = join(sessionDir, 'lifecycle.lock');
    if (!clearStaleLifecycleLock(sessionDir)) { await Bun.sleep(25); continue; }
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!sessionBusy(sessionDir)) { rmSync(lock, { recursive: true, force: true }); continue; }
      await Bun.sleep(50);
      continue;
    }
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid));
      if (existsSync(lifecycle)) { rmSync(lock, { recursive: true, force: true }); await Bun.sleep(25); continue; }
      atomicWrite(join(sessionDir, 'active_run'), runDir);
      atomicWrite(join(sessionDir, 'container_instance'), containerInstanceId());
      atomicWrite(join(runDir, 'session_instance'), containerInstanceId());
      return lock;
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error('Harness session lock wait timed out');
}

export function releaseSessionLock(lock: string): void {
  if (readOwnedPid(join(lock, 'pid')) !== process.pid) return;
  rmSync(join(dirname(lock), 'active_run'), { force: true });
  rmSync(lock, { recursive: true, force: true });
}

export function discardMarker(runDir: string, key: string): string {
  return join(dirname(dirname(runDir)), 'discarded-sessions', safeSessionKey(key));
}

/** Session IDs a discard marker rejects; undefined for a legacy marker that recorded none (rejects every ID). */
export function discardedSessionIds(marker: string): string[] | undefined {
  try {
    const ids = JSON.parse(readFileSync(marker, 'utf8')).sessionIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : undefined;
  } catch { return undefined; }
}
