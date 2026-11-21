import { ipcRoot } from './roots';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { containerInstanceId, isAlive, writtenBeforeBoot } from './processes';
import { clearStaleLifecycleLock, readOwnedPid, readText, safeSessionKey, staleLifecycleLock } from './sessions';

const DAY = 86_400_000;
const safe = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function directory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function optionalText(file: string): string {
  try { return readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** A retained run protects only its own session, including pending Board recovery. */
function retainedSessions(root: string): Set<string> {
  const protectedKeys = new Set<string>();
  const runs = join(root, 'runs');
  if (!existsSync(runs)) return protectedKeys;
  if (!directory(runs)) throw new Error('IPC runs path is not a directory');
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = join(runs, entry.name);
    const pointer = optionalText(join(run, 'session_dir'));
    if (pointer) protectedKeys.add(basename(pointer));
    // Board publishes args before the worker acquires its session lock.
    const raw = optionalText(join(run, 'args.json'));
    if (!raw) continue;
    const args = JSON.parse(raw);
    if (args?.persistent === '1' && typeof args.conversationKey === 'string') {
      protectedKeys.add(safeSessionKey(args.conversationKey));
    }
  }
  return protectedKeys;
}

function recentlyUsed(dir: string, cutoff: number, emptyDirectoryMtime: number): boolean {
  // A turn always refreshes last_used. Also protect newer top-level artifacts
  // from an interrupted turn that did not reach its finalizer. Removing old
  // artifacts changes the directory mtime without making a session active.
  const entries = readdirSync(dir).filter(name => name !== 'lifecycle.lock');
  if (!entries.length) return emptyDirectoryMtime >= cutoff;
  return entries.some(name =>
    lstatSync(join(dir, name)).mtimeMs >= cutoff,
  );
}

function hasLiveProcess(dir: string): boolean {
  const current = containerInstanceId();
  if (!current) return true;
  const generation = readText(join(dir, 'container_instance'));
  if (generation && generation !== current) return false;
  return ['daemon.pid', 'holder.pid', 'supervisor.pid', 'perm_replier.pid', 'lock/pid'].some(name => {
    const pid = readOwnedPid(join(dir, name));
    return pid !== undefined && !(name === 'lock/pid' && writtenBeforeBoot(join(dir, name))) && isAlive(pid);
  });
}

export function pruneIpcSessions(root: string, days = 7, apply = false, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1) throw new Error('Retention must be a positive number of days');
  const result = { eligible: 0, removed: 0, skipped: 0, errors: [] as string[] };
  const sessions = join(root, 'sessions');
  if (!directory(root) || !directory(sessions)) return result;
  let protectedKeys: Set<string>;
  try { protectedKeys = retainedSessions(root); }
  catch (error) { result.errors.push(String(error)); return result; }
  const cutoff = now - days * DAY;
  for (const key of readdirSync(sessions)) {
    const dir = join(sessions, key);
    const lock = join(dir, 'lifecycle.lock');
    let locked = false;
    try {
      if (!safe.test(key) || !directory(dir) || protectedKeys.has(key) || (existsSync(lock) && !staleLifecycleLock(lock))) {
        result.skipped++; continue;
      }
      const directoryMtime = lstatSync(dir).mtimeMs;
      if (recentlyUsed(dir, cutoff, directoryMtime) || hasLiveProcess(dir)) {
        result.skipped++; continue;
      }
      if (!apply) { result.eligible++; continue; }
      clearStaleLifecycleLock(dir);
      mkdirSync(lock);
      locked = true;
      writeFileSync(join(lock, 'pid'), String(process.pid));
      if (retainedSessions(root).has(key) || recentlyUsed(dir, cutoff, directoryMtime) || hasLiveProcess(dir)) { result.skipped++; continue; }
      result.eligible++;
      rmSync(dir, { recursive: true });
      locked = false;
      result.removed++;
    } catch (error) { result.errors.push(`${key}: ${String(error)}`); }
    finally { if (locked) rmSync(lock, { recursive: true, force: true }); }
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && !/^--days=[1-9]\d*$/.test(arg))) throw new Error('usage: prune-ipc.sh [--apply] [--days=N]');
  const days = Number(args.find(arg => arg.startsWith('--days='))?.slice(7) || 7);
  const result = pruneIpcSessions(resolve(ipcRoot()), days, args.includes('--apply'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.errors.length) process.exitCode = 1;
}
