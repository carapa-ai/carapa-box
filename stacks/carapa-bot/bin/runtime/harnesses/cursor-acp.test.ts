import { afterAll, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCursorRelay } from './cursor-acp';

const root = mkdtempSync(join(tmpdir(), 'cursor-acp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('a Cursor run gets only the placeholder login, the shared settings with HTTP/1.1, and the other shared configs', () => {
  const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'cursor'), { recursive: true });
  mkdirSync(join(home, '.config', 'gh'));
  writeFileSync(join(home, '.config', 'cursor', 'auth.json'), JSON.stringify({ accessToken: 'real-token' }));
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: ['Shell(ls)'] } }));
  const env: Record<string, string | undefined> = { HOME: home, CURSOR_API_KEY: 'key', CURSOR_AUTH_TOKEN: 'token' };
  const config = join(root, 'run');
  useCursorRelay(env, config);
  useCursorRelay(env, config); // A reused conversation folder is refreshed in place.

  expect(env).toMatchObject({ XDG_CONFIG_HOME: config, CURSOR_API_ENDPOINT: 'http://api-relay:8080/cursor' });
  expect(env.CURSOR_API_KEY).toBeUndefined();
  expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
  const auth = readFileSync(join(config, 'cursor', 'auth.json'), 'utf8');
  expect(auth).not.toContain('real-token');
  expect(JSON.parse(Buffer.from(JSON.parse(auth).accessToken.split('.')[1], 'base64url').toString()).exp).toBeGreaterThan(Date.now() / 1000);
  expect(lstatSync(join(config, 'cursor')).isSymbolicLink()).toBe(false);
  expect(readlinkSync(join(config, 'gh'))).toBe(join(home, '.config', 'gh'));
  expect(JSON.parse(readFileSync(join(config, 'cursor', 'cli-config.json'), 'utf8')))
    .toEqual({ version: 1, permissions: { allow: ['Shell(ls)'] }, network: { useHttp1ForAgent: true } });
});
