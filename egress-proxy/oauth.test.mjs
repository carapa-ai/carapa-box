import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { configureCredentialSealing } from './api-relay/credential-crypto.mjs';
import { OAuthManager, configuredOAuthEntries, readRelayConfigs, selectClientRoute,
  museContributorRequest, startApiRelay, withOAuthRetry } from './api-relay/api-relay.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const timestamp = 1_800_000_000_000;
const jwt = (expiry, marker = 'first') => 'header.' + Buffer.from(JSON.stringify({ exp: expiry / 1000, marker })).toString('base64url') + '.signature';
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapa-oauth-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function save(dir, name, value) { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const codex = (expiry = timestamp + 60_000, marker = 'first') => ({ custom: 'preserve', tokens: {
  access_token: jwt(expiry, marker), refresh_token: 'test-refresh-' + marker, account_id: 'account', id_token: 'old-id' } });
function manager(request, extra = {}) { return new OAuthManager({ request, now: () => timestamp, log: () => {}, ...extra }); }

test('scheduler covers global/default/per-client files, deduplicates aliases, and persists both provider formats', async () => {
  const dir = root();
  const shared = save(dir, 'shared.json', codex());
  const privateFile = save(dir, 'private.json', codex(timestamp + 60_000, 'private'));
  const claude = save(dir, 'claude.json', { custom: 'preserve', claudeAiOauth: {
    accessToken: 'claude-old', refreshToken: 'claude-refresh', expiresAt: timestamp + 10 * 60_000, scopes: ['keep'] } });
  const legacyClaude = save(dir, 'claude-legacy.json', { oauthAccount: {
    accessToken: 'legacy-old', refreshToken: 'legacy-refresh', expiresAt: timestamp - 8 * 86400_000 } });
  const alias = path.join(dir, 'alias.json'); fs.symlinkSync(shared, alias);
  const calls = [];
  const auth = manager(async (url, body) => {
    calls.push({ url, body });
    return { status: 200, body: { access_token: jwt(timestamp + 3600_000, body.refresh_token),
      refresh_token: body.refresh_token + '-rotated', expires_in: 3600, id_token: 'new-id' } };
  });
  const entries = configuredOAuthEntries(
    { providers: { codex: { auth: 'oauth', credentialFile: alias }, anthropic: { auth: 'oauth', credentialFile: claude } } }, [
      { name: 'private', isolation: 'strict', providers: { codex: { auth: 'oauth', credentialFile: privateFile } } },
      { name: 'legacy', providers: { anthropic: { auth: 'oauth', credentialFile: legacyClaude } } },
    ]);
  auth.configure(entries);
  await Promise.all([auth.tick(), auth.tick()]);
  expect(calls).toHaveLength(4);
  expect(calls.every(call => call.body.grant_type === 'refresh_token' && call.body.client_id)).toBe(true);
  expect(calls.map(call => new URL(call.url).hostname).sort()).toEqual(['auth.openai.com', 'auth.openai.com', 'console.anthropic.com', 'console.anthropic.com']);
  expect(read(shared)).toMatchObject({ custom: 'preserve', tokens: { account_id: 'account', id_token: 'new-id', refresh_token: 'test-refresh-first-rotated' } });
  expect(read(claude)).toMatchObject({ custom: 'preserve', claudeAiOauth: { scopes: ['keep'], refreshToken: 'claude-refresh-rotated', expiresAt: timestamp + 3600_000 } });
  expect(read(legacyClaude)).toMatchObject({ oauthAccount: { refreshToken: 'legacy-refresh-rotated', expiresAt: timestamp + 3600_000 } });
  for (const file of [shared, claude, privateFile]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(dir).some(file => file.endsWith('.tmp'))).toBe(false);
  await auth.tick(); expect(calls).toHaveLength(4);
  auth.configure([]); await auth.tick(); expect(auth.entries).toHaveLength(0);
  expect(() => auth.configure([...entries, { provider: 'codex', credentialFile: privateFile, owner: 'another' }])).toThrow('cannot be shared');
  expect(() => auth.configure([{ provider: 'codex', credentialFile: shared }, { provider: 'anthropic', credentialFile: alias }])).toThrow('conflicting');
});

test('managed Meta account serves Muse with its subscription key, records usage, refuses contributor mode, never refreshes', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000002';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000001', credentialId, provider: 'meta', label: 'Muse', scope: 'shared' }]);
  save(path.join(accounts, 'credentials'), credentialId + '.json', { schema_version: 1, providers: { meta: { mechanism: 'oauth',
    access_token: 'meta-access', api_key: 'meta-key', api_base_url: 'https://api.meta.ai/v1' } } });
  save(configs, 'default.json', { providers: {} });
  const forwarded = [];
  const subscription = { tier: 't', weekly: { resets_at: 1792368000, used_percent: 20 }, window: { resets_at: 1792078444, used_percent: 60, window_duration_mins: 300 } };
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n'
    + 'event: response.subscription_usage\ndata: ' + JSON.stringify({ subscription, type: 'response.subscription_usage' }) + '\n\n';
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    oauthRequest: async () => { throw new Error('a Muse key must never be refreshed'); },
    externalRequest: async (provider, target, _method, headers) => {
      forwarded.push({ host: provider.host, target, headers });
      // The usage event arrives split across stream chunks.
      const body = target.endsWith('/responses') ? [sse.slice(0, 40), sse.slice(40)] : ['{}'];
      return Object.assign(Readable.from(body), { statusCode: forwarded.length <= 2 ? 200 : 401, headers: { 'content-type': 'text/event-stream' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const ok = await fetch(base + '/muse-code/models', { headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  expect(ok.status).toBe(200); await ok.text();
  expect(forwarded[0]).toMatchObject({ host: 'api.meta.ai', target: '/muse-code/models', headers: { authorization: 'Bearer meta-key' } });
  const reply = await fetch(base + '/meta/v1/responses', { method: 'POST', body: '{}', headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  expect(reply.status).toBe(200); expect(await reply.text()).toBe(sse);
  expect(read(path.join(accounts, 'usage', credentialId + '.json')).subscription).toEqual(subscription);
  expect(forwarded[1]).toMatchObject({ host: 'api.meta.ai', target: '/v1/responses', headers: { authorization: 'Bearer meta-key' } });
  for (const [body, headers] of [['{"model": "muse-wonder-1.0-contributor"}', {}], ['{"model":"muse-wonder-1.0"}', { 'x-tbh-contributor-mode': '1' }],
    ['{"model":"muse-wonder-1.0-contributor"}', { 'x-tbh-contributor-mode': '0' }]]) {
    const contributor = await fetch(base + '/meta/v1/responses', { method: 'POST', body, headers: { authorization: 'Bearer carapa-relay-placeholder', ...headers } });
    expect(contributor.status).toBe(403); await contributor.text();
  }
  expect(forwarded).toHaveLength(2);
  const revoked = await fetch(base + '/muse-code/models', { headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  await revoked.text();
  expect(revoked.status).not.toBe(200);
  expect(forwarded).toHaveLength(3);
});

test('managed Cursor account injects its login, forwards binary Connect bodies unchanged, and never forwards analytics', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000004';
  const access = jwt(timestamp + 30 * 86400_000, 'cursor');
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000003', credentialId, provider: 'cursor', label: 'Cursor', scope: 'shared' }]);
  save(path.join(accounts, 'credentials'), credentialId + '.json', { accessToken: access, refreshToken: 'cursor-refresh' });
  save(configs, 'default.json', { providers: {} });
  const forwarded = [];
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    oauthRequest: async () => { throw new Error('a Cursor login must never be refreshed'); },
    externalRequest: async (provider, target, _method, headers, body) => {
      forwarded.push({ host: provider.host, target, headers, body });
      return Object.assign(Readable.from([Buffer.from([0x0a, 0x02, 0x4f, 0x4b])]), { statusCode: 200, headers: { 'content-type': 'application/proto' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const base = 'http://127.0.0.1:' + relay.server.address().port;
  const proto = Buffer.from([0x0a, 0x05, 0xff, 0xfe, 0x00, 0x80, 0x7f]);
  const reply = await fetch(base + '/cursor/aiserver.v1.DashboardService/GetMe', { method: 'POST', body: proto,
    headers: { authorization: 'Bearer carapa-relay-placeholder', 'content-type': 'application/proto' } });
  expect(reply.status).toBe(200); await reply.arrayBuffer();
  expect(forwarded[0]).toMatchObject({ host: 'api2.cursor.sh', target: '/aiserver.v1.DashboardService/GetMe', headers: { authorization: 'Bearer ' + access } });
  expect(Buffer.compare(Buffer.from(forwarded[0].body), proto)).toBe(0);
  for (const [route, type, expected] of [['/aiserver.v1.AnalyticsService/SubmitLogs', 'application/json', '{}'],
    ['/aiserver.v1.AnalyticsService/TrackEvents', 'application/proto', ''], ['/aiserver.v1.MetricsService/ReportMetrics', 'application/proto', ''],
    ['/aiserver.v1.AiService/ReportAiCodeChangeMetrics', 'application/proto', ''], ['/v1/traces', 'application/x-protobuf', '']]) {
    const analytics = await fetch(base + '/cursor' + route, { method: 'POST', body: '{"events":[1]}',
      headers: { authorization: 'Bearer carapa-relay-placeholder', 'content-type': type } });
    expect(analytics.status).toBe(200); expect(await analytics.text()).toBe(expected);
  }
  expect(forwarded).toHaveLength(1);
});

async function metaRelay(env = {}) {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000002';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000001', credentialId, provider: 'meta', label: 'Muse', scope: 'shared' }]);
  save(path.join(accounts, 'credentials'), credentialId + '.json', { schema_version: 1, providers: { meta: { mechanism: 'oauth',
    access_token: 'meta-access', api_key: 'meta-key', api_base_url: 'https://api.meta.ai/v1' } } });
  save(configs, 'default.json', { providers: {} });
  const forwarded = [];
  const relay = startApiRelay({ env: { SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts, ...env },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    oauthRequest: async () => { throw new Error('a Muse key must never be refreshed'); },
    externalRequest: async (provider, target, _method, headers, body) => {
      forwarded.push({ host: provider.host, target, headers, body });
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  return { forwarded, port: relay.server.address().port };
}

// Real backslash escapes: the upstream decodes them, the raw-body regex does not.
const ESCAPED_VALUE = '{"model":"muse-x\\u002dcontributor"}';
const ESCAPED_KEY = '{"\\u006dodel":"muse-x-contributor"}';

test('managed Meta account refuses contributor models hidden by JSON escapes or uninspectable JSON', async () => {
  const { forwarded, port } = await metaRelay({ HTTP_PROXY: 'http://127.0.0.1:1' });
  const send = (body, type) => fetch('http://127.0.0.1:' + port + '/meta/v1/responses', { method: 'POST', body,
    headers: { authorization: 'Bearer carapa-relay-placeholder', ...(type ? { 'content-type': type } : {}) } });
  for (const [body, type] of [[ESCAPED_VALUE, undefined], [ESCAPED_KEY, undefined], ['{"model":', 'application/json']]) {
    const refused = await send(body, type);
    expect(refused.status).toBe(403); await refused.text();
  }
  expect(forwarded).toEqual([]);
});

test('managed Meta account forwards a clean Muse body unchanged', async () => {
  const { forwarded, port } = await metaRelay({ HTTP_PROXY: 'http://127.0.0.1:1' });
  const clean = '{"model":"muse-wonder-1.0"}';
  const ok = await fetch('http://127.0.0.1:' + port + '/meta/v1/responses', { method: 'POST', body: clean,
    headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  expect(ok.status).toBe(200); await ok.text();
  expect(forwarded).toHaveLength(1);
  expect(Buffer.from(forwarded[0].body).toString('utf8')).toBe(clean);
});

test('non-Meta managed account still forwards bodies the Meta contributor check refuses', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000006';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000005', credentialId, provider: 'xai', label: 'Grok', scope: 'shared' }]);
  save(path.join(accounts, 'credentials'), credentialId + '.json', { 'https://auth.x.ai::grok-client': { key: 'xai-key', user_id: 'u',
    refresh_token: 'xai-refresh', expires_at: new Date(Date.now() + 3600_000).toISOString(), oidc_client_id: 'grok-client' } });
  save(configs, 'default.json', { providers: {} });
  const forwarded = [];
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    oauthRequest: async () => { throw new Error('a fresh key must not be refreshed'); },
    externalRequest: async (provider, target, _method, _headers, body) => {
      forwarded.push({ host: provider.host, target, body: Buffer.from(body).toString('utf8') });
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const url = 'http://127.0.0.1:' + relay.server.address().port + '/xai/v1/chat/completions';
  const headers = { authorization: 'Bearer carapa-relay-placeholder' };
  for (const [body, type] of [[ESCAPED_VALUE, 'text/plain'], ['{"model":', 'application/json']]) {
    const reply = await fetch(url, { method: 'POST', body, headers: { ...headers, 'content-type': type } });
    expect(reply.status).toBe(200); await reply.text();
    expect(forwarded.at(-1)).toMatchObject({ host: 'cli-chat-proxy.grok.com', body });
  }
  expect(forwarded).toHaveLength(2);
});

const DUPLICATE_ESCAPED_FIRST = '{"\\u006dodel":"muse-x-contributor","model":"muse-wonder-1.0"}';

test('managed Meta account refuses a duplicate top-level model key whose first key is JSON-escaped', async () => {
  const { forwarded, port } = await metaRelay({ HTTP_PROXY: 'http://127.0.0.1:1' });
  const refused = await fetch('http://127.0.0.1:' + port + '/meta/v1/responses', { method: 'POST', body: DUPLICATE_ESCAPED_FIRST,
    headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  expect(refused.status).toBe(403); await refused.text();
  expect(forwarded).toEqual([]);
});

test('museContributorRequest refuses duplicate top-level model keys after decoding, not nested ones', () => {
  expect(museContributorRequest({}, Buffer.from(DUPLICATE_ESCAPED_FIRST))).toBe(true);
  expect(museContributorRequest({}, Buffer.from('{"model":"muse-wonder-1.0","model":"muse-wonder-1.0"}'))).toBe(true);
  expect(museContributorRequest({}, Buffer.from('{"\\u006dodel":"a","x":1,"model":"b"}'))).toBe(true);
  expect(museContributorRequest({}, Buffer.from('{"model":"muse-wonder-1.0","input":{"model":"x"},"a":[{"model":1}]}'))).toBe(false);
  expect(museContributorRequest({}, Buffer.from('{"model":"muse-wonder-1.0","metadata":{"model":"x"}}'))).toBe(false);
  expect(museContributorRequest({}, Buffer.from('{"model":"muse-wonder-1.0","input":[{"model":"a"},{"model":"b"}]}'))).toBe(false);
});

test('museContributorRequest inspects the decoded JSON body', () => {
  expect(museContributorRequest({}, Buffer.from(ESCAPED_VALUE))).toBe(true);
  expect(museContributorRequest({}, Buffer.from(ESCAPED_KEY))).toBe(true);
  expect(museContributorRequest({}, Buffer.from('{"model":'))).toBe(true);
  expect(museContributorRequest({ 'Content-Type': 'application/json; charset=utf-8' }, Buffer.from('nope'))).toBe(true);
  expect(museContributorRequest({ 'content-type': 'text/plain' }, Buffer.from('nope'))).toBe(false);
  expect(museContributorRequest({}, Buffer.from('{"model": "muse-wonder-1.0-contributor"}'))).toBe(true);
  expect(museContributorRequest({ 'X-TBH-Contributor-Mode': '1' }, Buffer.from('{}'))).toBe(true);
  // Muse 1.4.13+ sends `0` on every request when contributor mode is off.
  expect(museContributorRequest({ 'x-tbh-contributor-mode': '0' }, Buffer.from('{"model":"muse-wonder-1.0"}'))).toBe(false);
  expect(museContributorRequest({ 'x-tbh-contributor-mode': '0, 1' }, Buffer.from('{}'))).toBe(true);
  expect(museContributorRequest({ 'x-tbh-contributor-mode': '' }, Buffer.from('{}'))).toBe(true);
  expect(museContributorRequest({}, Buffer.from('{"model":"muse-wonder-1.0"}'))).toBe(false);
  expect(museContributorRequest({}, Buffer.alloc(0))).toBe(false);
});

test('managed Meta account refuses WebSocket upgrades, with or without the contributor header, before any upstream connection', async () => {
  const connections = [];
  const proxy = net.createServer(socket => { connections.push('connect'); socket.destroy(); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  cleanups.push(() => new Promise(resolve => proxy.close(resolve)));
  const { forwarded, port } = await metaRelay({ HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port });
  for (const extra of ['', 'x-tbh-contributor-mode: 1\r\n']) {
    const socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
    socket.write('GET /meta/v1/responses HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer carapa-relay-placeholder\r\n' + extra + '\r\n');
    let reply = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { reply += chunk; });
    await once(socket, 'close');
    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
  }
  expect(connections).toEqual([]); expect(forwarded).toEqual([]);
});

test('managed Meta account refuses compressed request bodies and never forwards them', async () => {
  const { forwarded, port } = await metaRelay({ HTTP_PROXY: 'http://127.0.0.1:1' });
  const headers = { authorization: 'Bearer carapa-relay-placeholder' };
  const gz = await fetch('http://127.0.0.1:' + port + '/meta/v1/responses', { method: 'POST',
    body: zlib.gzipSync('{"model":"muse-wonder-1.0-contributor"}'), headers: { ...headers, 'content-encoding': 'gzip' } });
  expect(gz.status).toBe(415); expect(await gz.text()).toBe('Compressed request bodies are not accepted for this account\n');
  expect(forwarded).toEqual([]);
  const plain = await fetch('http://127.0.0.1:' + port + '/meta/v1/responses', { method: 'POST', body: '{}',
    headers: { ...headers, 'content-encoding': ' Identity ' } });
  expect(plain.status).toBe(200); await plain.text();
  expect(forwarded).toHaveLength(1);
});

test('managed xAI account renews its single-use Grok refresh token and serves the CLI chat proxy', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000004';
  const scope = 'https://auth.x.ai::grok-client';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000003', credentialId, provider: 'xai', label: 'Grok', scope: 'shared' }]);
  const file = save(path.join(accounts, 'credentials'), credentialId + '.json', { [scope]: { key: 'old-key', user_id: 'u',
    refresh_token: 'old-refresh', expires_at: new Date(Date.now() + 60_000).toISOString(), oidc_client_id: 'grok-client' } });
  save(configs, 'default.json', { providers: {} });
  const refreshes = []; const forwarded = [];
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    oauthRequest: async (endpoint, payload, options) => {
      refreshes.push({ endpoint, payload, format: options.format });
      return { status: 200, body: { access_token: 'new-key', refresh_token: 'new-refresh', expires_in: 3600 } };
    },
    externalRequest: async (provider, target, _method, headers) => {
      forwarded.push({ host: provider.host, target, headers });
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const reply = await fetch('http://127.0.0.1:' + relay.server.address().port + '/xai/v1/chat/completions',
    { method: 'POST', body: '{}', headers: { authorization: 'Bearer carapa-relay-placeholder' } });
  expect(reply.status).toBe(200); await reply.text();
  expect(refreshes).toEqual([{ endpoint: 'https://auth.x.ai/oauth2/token', format: 'form',
    payload: { client_id: 'grok-client', grant_type: 'refresh_token', refresh_token: 'old-refresh' } }]);
  expect(read(file)[scope]).toMatchObject({ key: 'new-key', refresh_token: 'new-refresh', user_id: 'u', oidc_client_id: 'grok-client' });
  expect(forwarded).toEqual([{ host: 'cli-chat-proxy.grok.com', target: '/v1/chat/completions',
    headers: expect.objectContaining({ authorization: 'Bearer new-key' }) }]);
});

test('rotation coalesces per file and never overwrites newer tokens written during the request', async () => {
  const dir = root(); const file = save(dir, 'codex.json', codex());
  let release; let calls = 0;
  const auth = manager(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const descriptor = { provider: 'codex', credentialFile: file };
  const first = auth.refresh(descriptor); const second = auth.refresh(descriptor);
  await Promise.resolve(); expect(calls).toBe(1);
  save(dir, 'codex.json', codex(timestamp + 3600_000, 'host-won'));
  release({ status: 400, body: { error: 'refresh_token_reused' } });
  const [a, b] = await Promise.all([first, second]);
  expect(a.headers).toEqual(b.headers);
  expect(read(file).tokens.refresh_token).toBe('test-refresh-host-won');
  await auth.refresh(descriptor, 'stale-token'); expect(calls).toBe(1);
  const third = auth.refresh(descriptor); await Promise.resolve();
  save(dir, 'codex.json', codex(timestamp + 3600_000, 'second-host-win'));
  release({ status: 200, body: { access_token: 'losing-token', refresh_token: 'losing-refresh' } });
  await third;
  expect(read(file).tokens.refresh_token).toBe('test-refresh-second-host-win');
});

test('timeouts abort refresh, release the lock, back off, and never expose provider secrets', async () => {
  const dir = root(); const file = save(dir, 'codex.json', codex(timestamp - 1));
  let now = timestamp; let signal; let calls = 0;
  const auth = manager((_url, _body, options) => { calls++; signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 15, now: () => now });
  const descriptor = { provider: 'codex', credentialFile: file };
  await expect(auth.getAuth(descriptor)).rejects.toThrow('renewal unavailable');
  expect(signal.aborted).toBe(true); expect(auth.locks.size).toBe(0);
  await expect(auth.refresh(descriptor)).rejects.toThrow('backing off'); expect(calls).toBe(1);
  now += 6000;
  auth.request = async () => ({ status: 400, body: { error: 'secret-provider-body-test-refresh-first' } });
  await expect(auth.refresh(descriptor)).rejects.toThrow('OAuth renewal failed');
  expect(read(file).tokens.refresh_token).toBe('test-refresh-first');
});

test('HTTP and WebSocket share one bounded 401 retry, not an infinite renewal loop', async () => {
  const file = save(root(), 'codex.json', codex(timestamp + 3600_000));
  let refreshes = 0;
  const auth = manager(async () => { refreshes++; return { status: 200, body: { access_token: jwt(timestamp + 3600_000, String(refreshes)) } }; });
  const descriptor = { provider: 'codex', credentialFile: file };
  const attempts = []; let discarded = 0;
  const response = await withOAuthRetry(auth, auth.read(descriptor), async (credentials, hold) => {
    attempts.push({ credentials, hold }); return { statusCode: 401 };
  }, () => { discarded++; });
  expect(response.statusCode).toBe(401); expect(attempts).toHaveLength(2); expect(discarded).toBe(1);
  expect(attempts.map(value => value.hold)).toEqual([true, false]);
  expect(attempts[0].credentials.headers.authorization).not.toBe(attempts[1].credentials.headers.authorization);
  const websocketAttempts = [];
  expect(await withOAuthRetry(auth, auth.read(descriptor), async (_credentials, hold) => {
    websocketAttempts.push(hold); return hold ? 401 : 101;
  })).toBe(101);
  expect(websocketAttempts).toEqual([true, false]); expect(refreshes).toBe(2);
});

test('strict selection cannot inherit defaults, wildcard accounts, or ambiguous identities', () => {
  const privateClient = { name: 'private', isolation: 'strict', patterns: ['private-agent-1'], providers: { codex: {} }, services: {} };
  const policy = { clients: [{ name: 'shared', patterns: ['*'], providers: {}, services: {} }, privateClient], defaults: { providers: { anthropic: {} } }, requireKnownClients: true };
  expect(selectClientRoute(policy, 'private-agent-1.agent_egress_private', 'codex').clientMatch).toBe(privateClient);
  for (const identity of [null, 'unregistered', 'private-agent-2']) expect(() => selectClientRoute(policy, identity, 'codex')).toThrow('Unrecognized');
  expect(() => selectClientRoute(policy, 'private-agent-1', 'anthropic')).toThrow('not configured');
  expect(() => selectClientRoute({ ...policy, clients: [privateClient, { ...privateClient, name: 'other' }] }, 'private-agent-1', 'codex')).toThrow('Ambiguous');
  expect(selectClientRoute({ clients: [], defaults: policy.defaults }, null, 'codex').clientConfig).toBe(policy.defaults);
});

test('live HTTP entry point injects only the selected private credential and fails closed on missing/malformed configuration', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const shared = save(dir, 'shared.json', codex(timestamp + 3600_000));
  const privateFile = save(dir, 'private.json', codex(timestamp + 3600_000, 'private'));
  save(configs, 'default.json', { providers: { codex: { auth: 'oauth', credentialFile: shared } } });
  const privateConfig = { match: ['private-agent-1'], isolation: 'strict', providers: { codex: { auth: 'oauth', credentialFile: privateFile } } };
  save(configs, 'private.json', privateConfig);
  let identity = 'private-agent-1'; const forwarded = []; let renewals = 0;
  const initialToken = read(privateFile).tokens.access_token;
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_REQUIRE_KNOWN_CLIENTS: '1', OVERLOAD_RETRY_DELAY_MS: '1' },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => identity,
    oauthRequest: async (_url, body) => {
      renewals++; expect(body.refresh_token).toBe('test-refresh-private');
      return { status: 200, body: { access_token: jwt(timestamp + 3600_000, 'renewed-private'), refresh_token: 'rotated-private' } };
    },
    externalRequest: async (_provider, target, _method, headers) => {
      forwarded.push({ target, headers });
      return Object.assign(Readable.from([Buffer.from('ok')]), { statusCode: [429, 401, 200][forwarded.length - 1] || 200, headers: { 'content-type': 'text/plain' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const address = relay.server.address(); const url = 'http://127.0.0.1:' + address.port + '/codex/responses';
  const response = await fetch(url, { headers: { authorization: 'Bearer client-dummy', 'x-goog-api-key': 'must-strip' } });
  expect(response.status).toBe(200); await response.text();
  expect(forwarded[0].headers.authorization).toBe('Bearer ' + initialToken);
  expect(forwarded[2].headers.authorization).toBe('Bearer ' + read(privateFile).tokens.access_token);
  expect(renewals).toBe(1); expect(read(shared).tokens.refresh_token).toBe('test-refresh-first');
  expect(forwarded[0].headers['x-goog-api-key']).toBeUndefined();
  expect(forwarded[0].target).toBe('/backend-api/codex/responses');
  identity = null; expect((await fetch(url)).status).toBe(403);
  identity = 'private-agent-1'; fs.unlinkSync(privateFile);
  expect((await fetch(url)).status).toBe(503);
  save(dir, 'private.json', codex(timestamp + 3600_000, 'private'));
  fs.writeFileSync(path.join(configs, 'private.json'), '{broken'); relay.reload();
  expect((await fetch(url)).status).toBe(403);
  save(configs, 'private.json', privateConfig); relay.reload();
  fs.unlinkSync(path.join(configs, 'private.json')); relay.reload();
  expect((await fetch(url)).status).toBe(403); expect(forwarded).toHaveLength(3);
});

test('Node WebSocket entry point renews a rejected handshake before forwarding headers; unknown clients get 403', async () => {
  const dir = root(); const file = save(dir, 'codex.json', codex(timestamp + 3600_000));
  const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  save(configs, 'private.json', { match: ['private-agent-1'], isolation: 'strict', providers: { codex: { auth: 'oauth', credentialFile: file } } });
  const certificate = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=chatgpt.com', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
    { env: { PATH: process.env.PATH }, stdout: 'ignore', stderr: 'pipe' });
  await new Response(certificate.stderr).text(); expect(await certificate.exited).toBe(0);
  const script = `
    import fs from 'node:fs'; import http from 'node:http'; import tls from 'node:tls';
    import net from 'node:net'; import assert from 'node:assert/strict'; import { once } from 'node:events';
    import { startApiRelay, requestOAuthThroughProxy } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const dir = ${JSON.stringify(dir)}, configs = ${JSON.stringify(configs)};
    let identity = 'private-agent-1', refreshes = 0; const tokens = [], sockets = new Set();
    const track = socket => { sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{}); return socket; };
    const upstream = tls.createServer({key:fs.readFileSync(dir+'/key.pem'),cert:fs.readFileSync(dir+'/cert.pem')}, socket => {
      track(socket); let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk; if (!buffer.includes('\\r\\n\\r\\n')) return;
        if (buffer.startsWith('POST /test-oauth ')) {
          const length = Number(buffer.match(/content-length: (\\d+)/i)[1]);
          const bodyText = buffer.split('\\r\\n\\r\\n')[1];
          if (Buffer.byteLength(bodyText) < length) return;
          const body = JSON.parse(bodyText); refreshes++;
          assert.equal(body.refresh_token,'test-refresh-first'); assert.equal(body.grant_type,'refresh_token');
          const response = JSON.stringify({access_token:'new-test-token',refresh_token:'new-test-refresh'});
          socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '+Buffer.byteLength(response)+'\\r\\n\\r\\n'+response);
          buffer = ''; return;
        }
        tokens.push(buffer.match(/authorization: ([^\\r]+)/i)[1]); buffer = '';
        socket.end(tokens.length === 1 ? 'HTTP/1.1 401 Unauthorized\\r\\nContent-Length: 0\\r\\n\\r\\n'
          : 'HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
      });
    });
    upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
    const proxy = http.createServer();
    proxy.on('connect', (request, client) => {
      assert.equal(request.url,'chatgpt.com:443'); track(client);
      const remote = track(net.connect(upstream.address().port,'127.0.0.1',()=> {
        client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); client.pipe(remote); remote.pipe(client);
      }));
      client.on('close',()=>remote.destroy()); remote.on('close',()=>client.destroy());
    });
    proxy.listen(0,'127.0.0.1'); await once(proxy,'listening');
    const relay = startApiRelay({ env:{HTTP_PROXY:'http://127.0.0.1:'+proxy.address().port,SNI_BRIDGE_PORT:'0',RELAY_REQUIRE_KNOWN_CLIENTS:'1'},
      port:0,host:'127.0.0.1',clientsDir:configs,hostnameResolver:()=>identity,
      oauthRequest: (_url, body, options) => requestOAuthThroughProxy('http://127.0.0.1:'+proxy.address().port,
        'https://chatgpt.com/test-oauth', body, options)
    });
    if(!relay.server.listening) await once(relay.server,'listening');
    async function upgrade() {
      const socket = track(net.connect(relay.server.address().port,'127.0.0.1'));
      socket.write('GET /codex/responses HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
      let response=''; for await(const chunk of socket) response += chunk;
      return response;
    }
    const timeout = setTimeout(()=>{for(const socket of sockets)socket.destroy();},3000);
    try {
      assert.match(await upgrade(),/^HTTP\\/1.1 101/);
      assert.equal(refreshes,1); assert.equal(tokens.length,2); assert.notEqual(tokens[0],tokens[1]);
      assert.equal(tokens[1],'Bearer new-test-token');
      assert.equal(JSON.parse(fs.readFileSync(dir+'/codex.json')).tokens.refresh_token,'new-test-refresh');
      identity = null; assert.match(await upgrade(),/^HTTP\\/1.1 403/);
      assert.equal(tokens.length,2);
    } finally { clearTimeout(timeout); for(const socket of sockets)socket.destroy(); relay.close(); proxy.close(); upstream.close(); }
  `;
  const child = Bun.spawn(['node', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem') }, stdout: 'ignore', stderr: 'pipe' });
  cleanups.push(() => child.kill());
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(stderr);
}, 10_000);

test('OAuth transport cancellation closes a stalled CONNECT without leaving a refresh hanging', async () => {
  // Production uses Node; Bun's http.request CONNECT implementation differs.
  const moduleUrl = new URL('./api-relay/api-relay.mjs', import.meta.url).href;
  const script = `
    import http from 'node:http'; import { once } from 'node:events';
    import { requestOAuthThroughProxy } from ${JSON.stringify(moduleUrl)};
    const proxy = http.createServer(); let tunnel;
    proxy.on('connect', (_request, socket) => { tunnel = socket; });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const controller = new AbortController();
    try {
      const request = requestOAuthThroughProxy('http://127.0.0.1:' + proxy.address().port,
        'https://auth.openai.com/oauth/token', { refresh_token: 'dummy' }, { signal: controller.signal })
        .then(() => { throw new Error('Expected cancellation'); }, error => {
          if (error.message !== 'OAuth transport failed') throw error;
        });
      await once(proxy, 'connect'); controller.abort(); await request;
    } finally { tunnel?.destroy(); proxy.close(); }
  `;
  const child = Bun.spawn(['node', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
  cleanups.push(() => child.kill());
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe(''); expect(await child.exited).toBe(0);
});

test('a client-scoped API key replaces only that client\'s route key, and a missing key file never falls back', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000007';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000006', credentialId, provider: 'mistral-vibe', label: 'Seat 2', scope: 'client', client: 'private' }]);
  const keyFile = save(path.join(accounts, 'credentials'), credentialId + '.json', { apiKey: 'private-key' });
  save(configs, 'default.json', { providers: { 'mistral-vibe': { host: 'api.eu.mistral.ai', auth: 'apikey', envKey: 'MISTRAL_VIBE_API_KEY',
    requestsPerSecond: 50, extraHeaders: { 'x-shared-only': '1' } } } });
  save(configs, 'private.json', { match: ['agent-private'], providers: {} });
  const forwarded = [];
  let caller = 'agent-1';
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts, MISTRAL_VIBE_API_KEY: 'shared-key' },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => caller,
    externalRequest: async (provider, target, _method, headers) => {
      forwarded.push({ host: provider.host, target, headers });
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const call = async () => { const r = await fetch('http://127.0.0.1:' + relay.server.address().port + '/mistral-vibe/v1/models',
    { headers: { authorization: 'Bearer carapa-relay' } }); await r.text(); return r.status; };
  expect(await call()).toBe(200);
  caller = 'agent-private';
  expect(await call()).toBe(200);
  expect(forwarded.map(f => [f.host, f.headers.authorization, f.headers['x-shared-only']])).toEqual([
    ['api.eu.mistral.ai', 'Bearer shared-key', '1'], ['api.eu.mistral.ai', 'Bearer private-key', undefined]]);
  fs.rmSync(keyFile);
  expect(await call()).not.toBe(200);
  expect(forwarded).toHaveLength(2);
});

test('a managed Google key replaces the Google secret and fails closed when its file is gone', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000009';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000008', credentialId, provider: 'google', label: 'Gemini', scope: 'shared' }]);
  const keyFile = save(path.join(accounts, 'credentials'), credentialId + '.json', { apiKey: 'managed-google-key' });
  save(configs, 'default.json', { providers: {} });
  const forwarded = [];
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts, GOOGLE_API_KEY: 'secret-google-key' },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    externalRequest: async (provider, target, _method, headers) => {
      forwarded.push({ host: provider.host, headers });
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => relay.close());
  if (!relay.server.listening) await once(relay.server, 'listening');
  const call = async () => { const r = await fetch('http://127.0.0.1:' + relay.server.address().port + '/google/v1beta/models',
    { headers: { 'x-goog-api-key': 'client-dummy' } }); await r.text(); return r.status; };
  expect(await call()).toBe(200);
  expect(forwarded.map(f => [f.host, f.headers['x-goog-api-key']])).toEqual([['generativelanguage.googleapis.com', 'managed-google-key']]);
  fs.rmSync(keyFile);
  expect(await call()).not.toBe(200);
  expect(forwarded).toHaveLength(1);
});

test('with a credential key the relay seals the existing store at start and still serves its keys', async () => {
  const dir = root(); const configs = path.join(dir, 'configs'); fs.mkdirSync(configs);
  const accounts = path.join(dir, 'accounts'); fs.mkdirSync(path.join(accounts, 'credentials'), { recursive: true });
  const credentialId = '00000000-0000-4000-8000-000000000011';
  save(accounts, 'accounts.json', [{ id: '00000000-0000-4000-8000-000000000010', credentialId, provider: 'openrouter', label: 'OR', scope: 'shared' }]);
  const keyFile = save(path.join(accounts, 'credentials'), credentialId + '.json', { apiKey: 'sealed-openrouter-key' });
  save(configs, 'default.json', { providers: {} });
  const credentialKey = path.join(dir, 'credential.key');
  fs.writeFileSync(credentialKey, crypto.randomBytes(32).toString('base64'));
  const forwarded = [];
  const relay = startApiRelay({ env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts, CARAPA_CREDENTIALS_KEY_FILE: credentialKey },
    port: 0, host: '127.0.0.1', clientsDir: configs, hostnameResolver: () => 'agent-1',
    externalRequest: async (provider, target, _method, headers) => {
      forwarded.push(headers.authorization);
      return Object.assign(Readable.from(['{}']), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    } });
  cleanups.push(() => { relay.close(); configureCredentialSealing({}, null); });
  if (!relay.server.listening) await once(relay.server, 'listening');
  expect(fs.readFileSync(keyFile, 'utf8')).not.toContain('sealed-openrouter-key');
  const response = await fetch('http://127.0.0.1:' + relay.server.address().port + '/openrouter/v1/models', { headers: { authorization: 'Bearer x' } });
  await response.text();
  expect(response.status).toBe(200);
  expect(forwarded).toEqual(['Bearer sealed-openrouter-key']);
});
