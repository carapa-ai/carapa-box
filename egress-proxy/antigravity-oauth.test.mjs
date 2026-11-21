import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OAuthManager, antigravityRequest, antigravityResponse, startApiRelay } from './api-relay/api-relay.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const native = { client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh', project_id: 'native-project', relayAcpVersion: '1.1.1' };

test('ACP API-key model targets regain OAuth variant IDs without changing request contents', () => {
  const credential = { ...native, relayEndpoint: 'daily-cloudcode-pa.googleapis.com' };
  for (const [model, level, expected] of [
    // The Antigravity CLI sends a base name plus level; xhigh exists for Gemini 4 Hydrogen.
    ['gemini-3.8-flash', 'high', 'gemini-3.8-flash-high'],
    ['gemini-3.8-flash', 'MEDIUM', 'gemini-3.8-flash-medium'], // Gemini API enum spelling.
    ['gemini-4-hydrogen', 'XHIGH', 'gemini-4-hydrogen-xhigh'],
    ['gemini-4-argon', 'medium', 'gemini-4-argon-medium'],
    ['gemini-3.8-flash-low', 'LOW', 'gemini-3.8-flash-low'], // Already a variant ID.
    ['gemini-2.5-flash', 'LOW', 'gemini-2.5-flash'],
    ['custom-model', 'HIGH', 'custom-model'],
    ['gemini-3.8-flash', undefined, 'gemini-3.8-flash'],
  ]) {
    const request = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { maxOutputTokens: 32, thinkingConfig: level ? { thinkingLevel: level } : { thinkingBudget: 1024 } } };
    for (const method of ['generateContent', 'streamGenerateContent']) {
      const wire = antigravityRequest(`/v1beta/models/${model}:${method}`, Buffer.from(JSON.stringify(request)), credential);
      expect(JSON.parse(wire.body)).toEqual({ project: native.project_id, model: expected, request });
    }
  }
});

test('native refresh-only ACP file acquires access token and resolves backend using shared refresh singleflight', async () => {
  const file = path.join(root, 'acp.json'); fs.writeFileSync(file, JSON.stringify(native));
  const calls = [];
  const manager = new OAuthManager({ log: () => {}, request: async (url, body, options) => {
    calls.push({ url, body, options });
    return url.includes('/token') ? { status: 200, body: { access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600 } }
      : { status: 200, body: { currentTier: { id: 'paid' }, cloudaicompanionProject: 'managed-project', paidTier: { usesGcpTos: false } } };
  } });
  const entry = { provider: 'antigravity', credentialFile: file };
  const [a, b] = await Promise.all([manager.getAuth(entry), manager.getAuth(entry)]);
  expect(a.headers.authorization).toBe('Bearer new-access'); expect(b).toEqual(a);
  expect(calls).toHaveLength(2);
  expect(calls[0].options.format).toBe('form'); expect(calls[0].body.client_secret).toBe('test-secret');
  expect(calls[1].options.headers.authorization).toBe('Bearer new-access');
  const saved = JSON.parse(fs.readFileSync(file));
  expect(saved).toMatchObject({ refresh_token: 'rotated', project_id: 'managed-project', relayEndpoint: 'daily-cloudcode-pa.googleapis.com' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const wire = antigravityRequest('/v1beta/models/gemini-3.8-flash:streamGenerateContent?key=attacker', Buffer.from('{"contents":[]}'), saved);
  expect(wire.path).toBe('/v1internal:streamGenerateContent?alt=sse');
  expect(JSON.parse(wire.body)).toEqual({ project: 'managed-project', model: 'gemini-3.8-flash', request: { contents: [] } });
});

test('SSE unwrap preserves split UTF-8 and does not buffer the whole response', async () => {
  const transform = antigravityResponse(true);
  const input = Buffer.from('data: {"response":{"text":"Bună"}}\r\n\r\ndata: [DONE]\n\n');
  const output = [];
  transform.on('data', chunk => output.push(chunk.toString()));
  for (const byte of input) transform.write(Buffer.from([byte]));
  expect(output.join('')).toBe('data: {"text":"Bună"}\n\ndata: [DONE]\n\n');
  transform.end();
  expect(() => antigravityRequest('/v1internal:loadCodeAssist', Buffer.from('{}'), {})).toThrow();
});

test('backend discovery failure preserves rotated credentials and retries discovery without rotating again', async () => {
  const file = path.join(root, 'discovery-retry.json'); fs.writeFileSync(file, JSON.stringify(native));
  let now = Date.now(); let refreshes = 0; let discoveries = 0;
  const manager = new OAuthManager({ now: () => now, log: () => {}, request: async url => {
    if (url.includes('/token')) { refreshes++; return { status: 200, body: { access_token: 'retained-access', refresh_token: 'retained-rotation', expires_in: 3600 } }; }
    discoveries++;
    return discoveries === 1 ? { status: 503, body: {} } : { status: 200, body: { currentTier: {}, cloudaicompanionProject: 'project', paidTier: { usesGcpTos: true } } };
  } });
  const entry = { provider: 'antigravity', credentialFile: file };
  await expect(manager.getAuth(entry)).rejects.toThrow();
  expect(JSON.parse(fs.readFileSync(file)).refresh_token).toBe('retained-rotation');
  now += 6000;
  await manager.getAuth(entry);
  expect(refreshes).toBe(1); expect(discoveries).toBe(2);
  expect(JSON.parse(fs.readFileSync(file)).relayEndpoint).toBe('cloudcode-pa.googleapis.com');
});

test('live managed Antigravity route strips sandbox secrets, selects account and translates streaming responses', async () => {
  const dir = path.join(root, 'live'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'credentials'));
  const clients = path.join(root, 'clients'); fs.mkdirSync(clients);
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ id, credentialId: id, label: 'test', provider: 'antigravity', scope: 'shared' }]));
  fs.writeFileSync(path.join(dir, 'credentials', id + '.json'), JSON.stringify({ ...native, access_token: 'real-test-token', expiresAt: Date.now() + 3600000, relayEndpoint: 'daily-cloudcode-pa.googleapis.com' }));
  const calls = [];
  const relay = startApiRelay({ host: '127.0.0.1', port: 0, clientsDir: clients, env: { HTTP_PROXY: 'http://127.0.0.1:1', PROVIDER_ACCOUNTS_DIR: dir, SNI_BRIDGE_PORT: '0' },
    hostnameResolver: async () => 'agent', externalRequest: async (provider, target, method, headers, body) => {
      calls.push({ provider, target, method, headers, body: JSON.parse(body) });
      return Object.assign(Readable.from(['data: {"response":{"candidates":[]}}\n\n']), { statusCode: 200, headers: {} });
    } });
  try {
    if (!relay.server.listening) await new Promise(resolve => relay.server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${relay.server.address().port}/antigravity/v1beta/models/gemini-3.8-flash:streamGenerateContent?key=client-secret`, {
      method: 'POST', headers: { authorization: 'Bearer client-secret', 'x-goog-api-key': 'client-secret', 'x-acp-proxy-token': 'client-secret' },
      body: JSON.stringify({ contents: [], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } } }) });
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: {"candidates":[]}\n\n');
    expect(calls[0].headers.authorization).toBe('Bearer real-test-token');
    expect(JSON.stringify(calls)).not.toContain('client-secret');
    expect(calls[0].provider).toEqual({ host: 'daily-cloudcode-pa.googleapis.com', verifyTls: true });
    expect(calls[0].body.model).toBe('gemini-3.8-flash-low');
  } finally { relay.close(); }
});

test('malformed or unsupported Antigravity requests get 400/404 with a log line, not 502, and never reach upstream', async () => {
  const dir = path.join(root, 'client-errors'); fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'credentials'));
  const clients = path.join(root, 'clients-errors'); fs.mkdirSync(clients);
  const id = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ id, credentialId: id, label: 'test', provider: 'antigravity', scope: 'shared' }]));
  fs.writeFileSync(path.join(dir, 'credentials', id + '.json'), JSON.stringify({ ...native, access_token: 'real-test-token', expiresAt: Date.now() + 3600000, relayEndpoint: 'daily-cloudcode-pa.googleapis.com' }));
  const calls = [];
  const relay = startApiRelay({ host: '127.0.0.1', port: 0, clientsDir: clients, env: { HTTP_PROXY: 'http://127.0.0.1:1', PROVIDER_ACCOUNTS_DIR: dir, SNI_BRIDGE_PORT: '0' },
    hostnameResolver: async () => 'agent', externalRequest: async (...args) => { calls.push(args); return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: {} }); } });
  const errors = []; const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    if (!relay.server.listening) await new Promise(resolve => relay.server.once('listening', resolve));
    const base = `http://127.0.0.1:${relay.server.address().port}/antigravity`;
    const post = (suffix, body) => fetch(base + suffix, { method: 'POST', body });
    const model = '/v1beta/models/gemini-3.8-flash:generateContent';
    for (const [suffix, body, status] of [[model, '{not json', 400], [model, '[]', 400], [model, 'null', 400], ['/v1internal:loadCodeAssist', '{}', 404], ['//[', '{}', 400]]) {
      const response = await post(suffix, body);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('request failed');
    }
    expect(errors.filter(line => line.includes('rejected request'))).toHaveLength(5);
    expect(calls).toHaveLength(0);
  } finally { console.error = originalError; relay.close(); }
});
