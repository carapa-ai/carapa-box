import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('browser helper replaces browser-url.json atomically so the worker never reads a truncated file', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-helper-'));
  try {
    const file = path.join(profile, 'browser-url.json');
    fs.writeFileSync(file, JSON.stringify('https://old.example/login'));
    const before = fs.statSync(file).ino;
    const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'browser.mjs'), 'https://login.example/auth?x=1'], { env: { ...process.env, HOME: profile } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toBe('https://login.example/auth?x=1');
    // An in-place O_TRUNC write keeps the inode and exposes an empty file mid-write.
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(profile)).toEqual(['browser-url.json']);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
