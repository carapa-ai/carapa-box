import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneIpcSessions } from './prune-ipc';
import { spawn } from 'node:child_process';
import { containerInstanceId } from './processes';
import { acquireSessionLock, releaseSessionLock } from './sessions';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ipc-pruning-')); roots.push(root);
  mkdirSync(join(root, 'sessions'));
  return root;
}
function old(dir: string) {
  const then = new Date(Date.now() - 10 * 86_400_000);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), then, then);
  utimesSync(dir, then, then);
}
function session(root: string, name: string) {
  const dir = join(root, 'sessions', name); mkdirSync(dir);
  writeFileSync(join(dir, 'last_used'), ''); old(dir); return dir;
}

test('dry run preserves runtime files; apply prunes them without changing stable native homes', () => {
  const root = fixture(); const dir = session(root, 'conv-old');
  // Native-home migration/removal touches the directory, not actual usage.
  utimesSync(dir, new Date(), new Date());
  const histories = [
    'codex-home/sessions/rollout.jsonl',
    'pi-sessions/native.jsonl',
    'antigravity-home/antigravity-acp/conversations/native.db',
    'antigravity-home/identities/native-id',
  ];
  for (const name of histories) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, name);
  }
  expect(pruneIpcSessions(root)).toMatchObject({ eligible: 1, removed: 0, errors: [] });
  expect(existsSync(dir)).toBe(true);
  expect(pruneIpcSessions(root, 7, true)).toMatchObject({ removed: 1, errors: [] });
  expect(existsSync(dir)).toBe(false);
  for (const name of histories) expect(readFileSync(join(root, name), 'utf8')).toBe(name);
});

test('retains live sessions and run-owned recovery without blocking unrelated idle sessions', () => {
  const root = fixture(); const live = session(root, 'conv-live');
  writeFileSync(join(live, 'daemon.pid'), String(process.pid));
  writeFileSync(join(live, 'container_instance'), containerInstanceId()); old(live);
  const locked = session(root, 'conv-locked'); mkdirSync(join(locked, 'lifecycle.lock')); writeFileSync(join(locked, 'lifecycle.lock', 'pid'), String(process.pid)); old(locked);
  const fresh = session(root, 'conv-fresh'); writeFileSync(join(fresh, 'last_used'), '');
  symlinkSync(live, join(root, 'sessions', 'conv-link'));
  const stale = session(root, 'conv-stale');
  const pending = session(root, 'conv-pending');
  const prepared = session(root, 'conv-prepared');
  mkdirSync(join(root, 'runs', 'run-orphan'), { recursive: true });
  const retainedRun = join(root, 'runs', 'run-retained'); mkdirSync(retainedRun);
  writeFileSync(join(retainedRun, 'session_dir'), '/workspace/ipc/sessions/conv-pending');
  writeFileSync(join(retainedRun, 'metrics_complete'), 'ok');
  const preparingRun = join(root, 'runs', 'run-preparing'); mkdirSync(preparingRun);
  writeFileSync(join(preparingRun, 'args.json'), JSON.stringify({ persistent: '1', conversationKey: 'conv-prepared' }));
  expect(pruneIpcSessions(root, 7, true).removed).toBe(1);
  expect(existsSync(stale)).toBe(false);
  for (const dir of [live, locked, fresh, pending, prepared]) expect(existsSync(dir)).toBe(true);
  // Board's recovery cleanup releases the remaining sessions for retention.
  rmSync(join(root, 'runs'), { recursive: true });
  expect(pruneIpcSessions(root, 7, true)).toMatchObject({ removed: 2, errors: [] });
  for (const dir of [live, locked, fresh]) expect(existsSync(dir)).toBe(true);
});

test('a new turn recreates only runtime state after eviction', async () => {
  const root = fixture(); const dir = session(root, 'conv-pi');
  mkdirSync(join(root, 'pi-sessions'));
  writeFileSync(join(root, 'pi-sessions', 'native.jsonl'), 'resume history');
  writeFileSync(join(dir, 'session_id'), 'native-id'); old(dir);
  expect(pruneIpcSessions(root, 7, true).removed).toBe(1);
  const run = join(root, 'runs', 'run-new'); mkdirSync(run, { recursive: true });
  const lock = await acquireSessionLock(dir, run);
  try {
    expect(readFileSync(join(root, 'pi-sessions', 'native.jsonl'), 'utf8')).toBe('resume history');
    expect(existsSync(join(dir, 'session_id'))).toBe(false); // Board supplies the native ID.
    expect(pruneIpcSessions(root, 7, true).removed).toBe(0);
  } finally { releaseSessionLock(lock); }
});

function liveChild() { return spawn('sleep', ['60'], { stdio: 'ignore' }); }
function stamp(path: string, seconds: number) { utimesSync(path, seconds, seconds); }

test('prune: pre-boot lock/pid with a live-looking pid is pruned; same-boot one is kept', () => {
  const root = fixture(); const child = liveChild();
  try {
    const pre = session(root, 'conv-preboot'); mkdirSync(join(pre, 'lock'));
    writeFileSync(join(pre, 'lock', 'pid'), String(child.pid)); stamp(join(pre, 'lock', 'pid'), 0); old(pre);
    const same = session(root, 'conv-sameboot'); mkdirSync(join(same, 'lock'));
    writeFileSync(join(same, 'lock', 'pid'), String(child.pid)); old(same);
    expect(pruneIpcSessions(root, 7, true)).toMatchObject({ removed: 1, errors: [] });
    expect(existsSync(pre)).toBe(false);
    expect(existsSync(same)).toBe(true);
  } finally { child.kill(); }
});
