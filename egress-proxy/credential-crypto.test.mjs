import { afterAll, afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureCredentialSealing, readCredentialFile, sealPlaintextCredentials, writeCredentialFile } from './api-relay/credential-crypto.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-crypto-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
afterEach(() => configureCredentialSealing({}, null));
let n = 0;
function store() {
  const root = path.join(base, String(n++));
  for (const dir of ['credentials', 'mcp/credentials']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const keyFile = path.join(root, 'key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64') + '\n');
  return { root, env: { CARAPA_CREDENTIALS_KEY_FILE: keyFile } };
}

test('sealed credentials hide their content, open only under their own name, and leave files outside the store alone', () => {
  const { root, env } = store();
  expect(configureCredentialSealing(env, root)).toBe(true);
  const file = path.join(root, 'credentials', 'a.json');
  writeCredentialFile(file, { apiKey: 'secret-value' });
  const text = fs.readFileSync(file, 'utf8');
  expect(text).not.toContain('secret-value');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(readCredentialFile(file)).toEqual({ apiKey: 'secret-value' });
  // Copied over another account's file, it no longer authenticates.
  const other = path.join(root, 'credentials', 'b.json');
  fs.writeFileSync(other, text);
  expect(() => readCredentialFile(other)).toThrow();
  // Without the key, a sealed file is refused rather than misread.
  configureCredentialSealing({}, null);
  expect(() => readCredentialFile(file)).toThrow('no credential key');
  // Files outside the store (other tools may read them) stay plain.
  configureCredentialSealing(env, root);
  const outside = path.join(base, 'outside.json');
  writeCredentialFile(outside, { token: 't' });
  expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual({ token: 't' });
});

test('existing plain files stay readable and are sealed once, including MCP tokens', () => {
  const { root, env } = store();
  fs.writeFileSync(path.join(root, 'credentials', 'login.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }));
  fs.writeFileSync(path.join(root, 'mcp', 'credentials', 'svc--proj.json'), JSON.stringify({ access_token: 'm' }));
  configureCredentialSealing(env, root);
  expect(readCredentialFile(path.join(root, 'credentials', 'login.json'))).toEqual({ tokens: { refresh_token: 'r' } });
  expect(sealPlaintextCredentials(root)).toBe(2);
  expect(sealPlaintextCredentials(root)).toBe(0);
  expect(fs.readFileSync(path.join(root, 'mcp', 'credentials', 'svc--proj.json'), 'utf8')).not.toContain('"m"');
  expect(readCredentialFile(path.join(root, 'mcp', 'credentials', 'svc--proj.json'))).toEqual({ access_token: 'm' });
});

test('a named key that is not 32 bytes stops configuration instead of writing in the clear', () => {
  const { root, env } = store();
  fs.writeFileSync(env.CARAPA_CREDENTIALS_KEY_FILE, Buffer.from('short').toString('base64'));
  expect(() => configureCredentialSealing(env, root)).toThrow('32-byte');
  expect(() => configureCredentialSealing({ CARAPA_CREDENTIALS_KEY_FILE: path.join(root, 'missing') }, root)).toThrow();
});
