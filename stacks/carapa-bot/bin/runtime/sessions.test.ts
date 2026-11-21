import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writtenBeforeBoot } from './processes';
import { acquireSessionLock, sessionBusy } from './sessions';

const roots: string[] = [];
const children: { kill(): boolean }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-lock-')); roots.push(root);
  const sessionDir = join(root, 'session'); const runDir = join(root, 'run');
  mkdirSync(sessionDir); mkdirSync(runDir);
  return { sessionDir, runDir };
}
function liveChildPid(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' }); children.push(child);
  return child.pid as number;
}
function plant(dir: string, name: 'lock' | 'lifecycle.lock', pid: number, seconds?: number) {
  const lock = join(dir, name); mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(pid));
  if (seconds !== undefined) utimesSync(join(lock, 'pid'), seconds, seconds);
}

test('writtenBeforeBoot compares mtime with the injected boot time', () => {
  const { runDir } = fixture(); const file = join(runDir, 'f'); writeFileSync(file, '');
  utimesSync(file, 1000, 1000);
  expect(writtenBeforeBoot(file, 2_000_000)).toBe(true);
  expect(writtenBeforeBoot(file, 500_000)).toBe(false);
  expect(writtenBeforeBoot(file, 0)).toBe(false);
  expect(writtenBeforeBoot(join(runDir, 'missing'), 2_000_000)).toBe(false);
});

test('a pre-boot lock/pid naming a live pid is stale and the lock is acquired', async () => {
  const { sessionDir, runDir } = fixture();
  plant(sessionDir, 'lock', liveChildPid(), 0);
  expect(sessionBusy(sessionDir)).toBe(false);
  const lock = await acquireSessionLock(sessionDir, runDir, 1_000);
  expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
});

test('a pre-boot lifecycle.lock/pid naming a live pid is dead and removed', async () => {
  const { sessionDir, runDir } = fixture();
  plant(sessionDir, 'lifecycle.lock', liveChildPid(), 0);
  await acquireSessionLock(sessionDir, runDir, 1_000);
  expect(existsSync(join(sessionDir, 'lifecycle.lock'))).toBe(false);
});

test('a same-boot live lock/pid still blocks until the deadline', async () => {
  const { sessionDir, runDir } = fixture();
  plant(sessionDir, 'lock', liveChildPid());
  expect(sessionBusy(sessionDir)).toBe(true);
  await expect(acquireSessionLock(sessionDir, runDir, 300)).rejects.toThrow('Harness session lock wait timed out');
});

test('a same-boot live lifecycle.lock/pid still blocks until the deadline', async () => {
  const { sessionDir, runDir } = fixture();
  plant(sessionDir, 'lifecycle.lock', liveChildPid());
  await expect(acquireSessionLock(sessionDir, runDir, 300)).rejects.toThrow('Harness session lock wait timed out');
});

test('a lock released between the existence check and stat is not busy', () => {
  const { sessionDir } = fixture();
  // Simulates the release landing right after the lock was seen: it exists for the check, then is gone.
  const exists = spyOn(fs, 'existsSync').mockReturnValue(true);
  try { expect(sessionBusy(sessionDir)).toBe(false); } finally { exists.mockRestore(); }
});
