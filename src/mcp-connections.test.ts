import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpConnections } from './mcp-connections.js';

const ID = '11111111-2222-4333-8444-555555555555';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-mcp-'));
  const clients = path.join(root, 'clients');
  fs.mkdirSync(clients);
  fs.writeFileSync(path.join(clients, 'default.json'), JSON.stringify({ services: {
    notes: { auth: 'mcp-oauth', url: 'https://mcp.example.com/mcp', projects: ['alpha'] } } }));
  const accounts = path.join(root, 'accounts');
  return { root, accounts, mcp: new McpConnections({ directory: accounts, clientsDirectory: clients }) };
}

test('start validates service and project, writes a private request and lists the attempt', () => {
  const { root, accounts, mcp } = setup();
  try {
    expect(() => mcp.start({ service: 'nope', project: 'alpha' })).toThrow();
    expect(() => mcp.start({ service: 'notes', project: 'beta' })).toThrow();
    const { id } = mcp.start({ service: 'notes', project: 'alpha' });
    const file = path.join(accounts, 'mcp', 'attempts', id, 'request.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ service: 'notes', project: 'alpha' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(mcp.list().logins).toEqual([expect.objectContaining({ id, service: 'notes', project: 'alpha', state: 'starting' })]);
    expect(mcp.list().services).toEqual([{ service: 'notes', host: 'mcp.example.com', projects: [{ project: 'alpha', state: 'loginRequired' }] }]);
    expect(() => mcp.start({ service: 'notes', project: 'alpha' })).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('complete and cancel reject non-UUID and traversal ids, oversized values and non-waiting logins', () => {
  const { root, accounts, mcp } = setup();
  try {
    const { id } = mcp.start({ service: 'notes', project: 'alpha' });
    for (const bad of ['not-a-uuid', '../' + ID, ID + '/../..', '..']) {
      expect(() => mcp.complete(bad, 'http://127.0.0.1:33418/callback?code=a')).toThrow();
      expect(() => mcp.cancel(bad)).toThrow();
    }
    const dir = path.join(accounts, 'mcp', 'attempts', id);
    // Not yet awaiting the callback.
    expect(() => mcp.complete(id, 'http://127.0.0.1:33418/callback?code=a')).toThrow();
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'awaitingCallback', authorizationUrl: 'https://mcp.example.com/auth', expiresAt: Date.now() + 60_000 }));
    expect(() => mcp.complete(id, 'x'.repeat(16 * 1024 + 1))).toThrow();
    expect(() => mcp.complete(id, 42)).toThrow();
    expect(mcp.list().logins[0]?.authorizationUrl).toBe('https://mcp.example.com/auth');
    mcp.complete(id, 'http://127.0.0.1:33418/callback?code=a&state=b');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'callback.json'), 'utf8'))).toEqual({ value: 'http://127.0.0.1:33418/callback?code=a&state=b' });
    mcp.cancel(id);
    expect(fs.existsSync(dir)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked attempts directory and a symlinked attempt are refused', () => {
  const { root, accounts, mcp } = setup();
  try {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(accounts, 'mcp'), { recursive: true });
    fs.symlinkSync(outside, path.join(accounts, 'mcp', 'attempts'));
    expect(() => mcp.start({ service: 'notes', project: 'alpha' })).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.rmSync(path.join(accounts, 'mcp', 'attempts'));
    fs.mkdirSync(path.join(accounts, 'mcp', 'attempts'));
    fs.mkdirSync(path.join(outside, 'x'));
    fs.symlinkSync(outside, path.join(accounts, 'mcp', 'attempts', ID));
    expect(() => mcp.cancel(ID)).toThrow();
    expect(fs.existsSync(path.join(outside, 'x'))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('revoke writes an intent atomically and every call fails closed without PROVIDER_ACCOUNTS_DIR', async () => {
  const { root, accounts, mcp } = setup();
  try {
    expect(() => mcp.revoke({ service: 'notes', project: 'beta' })).toThrow();
    mcp.revoke({ service: 'notes', project: 'alpha' });
    const [id] = fs.readdirSync(path.join(accounts, 'mcp', 'attempts'));
    const dir = path.join(accounts, 'mcp', 'attempts', id!);
    expect(fs.existsSync(path.join(dir, 'revoke.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'))).toEqual({ service: 'notes', project: 'alpha' });
    expect(mcp.list().logins).toEqual([]);
    const { configuredMcpConnections } = await import('./mcp-connections.js');
    const saved = process.env.PROVIDER_ACCOUNTS_DIR;
    delete process.env.PROVIDER_ACCOUNTS_DIR;
    try { expect(() => configuredMcpConnections()).toThrow(); }
    finally { if (saved !== undefined) process.env.PROVIDER_ACCOUNTS_DIR = saved; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('finished and revoked attempts do not block a new login', () => {
  const { root, accounts, mcp } = setup();
  try {
    const target = { service: 'notes', project: 'alpha' };
    const attempts = path.join(accounts, 'mcp', 'attempts');
    // Revoke, then simulate the relay: status revoked, revoke.json removed, request.json kept.
    mcp.revoke(target);
    const [revoked] = fs.readdirSync(attempts);
    fs.writeFileSync(path.join(attempts, revoked!, 'status.json'), JSON.stringify({ state: 'revoked' }));
    fs.rmSync(path.join(attempts, revoked!, 'revoke.json'));
    const { id } = mcp.start(target);
    // A connected login also lingers for the relay's TTL.
    fs.writeFileSync(path.join(attempts, id, 'status.json'), JSON.stringify({ state: 'connected' }));
    expect(mcp.start(target).id).not.toBe(id);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('API token is accepted only on the documented MCP connection routes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-mcp-auth-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import assert from 'node:assert/strict';
      const { handleBunRequest } = await import(process.env.HTTP_HANDLER);
      process.env.CARAPA_BOX_API_TOKEN = 'api';
      process.env.CARAPA_BOX_ADMIN_TOKEN = 'admin';
      delete process.env.PROVIDER_ACCOUNTS_DIR;
      const id = '${ID}';
      const call = (method, p) => handleBunRequest(new Request('http://localhost' + p, { method, headers: { Authorization: 'Bearer api', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }));
      const base = '/api/admin/mcp-connections';
      // Allowed routes pass auth and reach the (unconfigured, generic 400) handler.
      for (const [m, p] of [['GET', base], ['POST', base + '/login'], ['POST', base + '/login/' + id + '/complete'],
        ['DELETE', base + '/login/' + id], ['POST', base + '/revoke']]) {
        const response = await call(m, p);
        assert.equal(response.status, 400, m + ' ' + p);
        assert.equal((await response.json()).error.includes('MCP connection operation failed'), true);
      }
      for (const [m, p] of [['POST', base], ['GET', base + '/login'], ['GET', base + '/revoke'], ['DELETE', base + '/revoke'],
        ['POST', base + '/login/' + id], ['GET', base + '/login/' + id + '/complete'], ['DELETE', base + '/login/' + id + '/complete'],
        ['POST', base + '/login/not-a-uuid/complete'], ['DELETE', base + '/login/' + id + '/x'], ['GET', base + '/other']]) {
        assert.equal((await call(m, p)).status, 401, m + ' ' + p);
      }
      process.exit(0);
    `], { cwd: root, env: { PATH: process.env.PATH || '', SECRETS_DIR: root, LOG_LEVEL: 'silent',
      HTTP_HANDLER: new URL('./http/server.ts', import.meta.url).href }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed login lists only a short error code; other error text is omitted', () => {
  const { root, accounts, mcp } = setup();
  try {
    const { id } = mcp.start({ service: 'notes', project: 'alpha' });
    const status = path.join(accounts, 'mcp', 'attempts', id, 'status.json');
    fs.writeFileSync(status, JSON.stringify({ state: 'failed', error: 'issuer_mismatch' }));
    expect(mcp.list().logins[0]).toMatchObject({ state: 'failed', error: 'issuer_mismatch' });
    for (const error of ['see https://evil.example/x', 'has spaces', 'UPPER', 'a'.repeat(65), 7]) {
      fs.writeFileSync(status, JSON.stringify({ state: 'failed', error }));
      expect(mcp.list().logins[0]?.error).toBeUndefined();
    }
    fs.writeFileSync(status, JSON.stringify({ state: 'starting', error: 'issuer_mismatch' }));
    expect(mcp.list().logins[0]?.error).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
