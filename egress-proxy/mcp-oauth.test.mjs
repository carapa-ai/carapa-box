import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { readRelayConfigs, startApiRelay } from './api-relay/api-relay.mjs';
import { authorizationRequest, createMcpOAuthProcessor, discover, exchangeCode, refresh, register, validateCallback,
  validateMcpOAuthConfig } from './api-relay/mcp-oauth.mjs';

const MCP = 'https://mcp.example.com/mcp';
const PRM_PATH = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const PRM_ROOT = 'https://mcp.example.com/.well-known/oauth-protected-resource';
const AS_META_URL = 'https://auth.example.com/.well-known/oauth-authorization-server';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const config = { auth: 'mcp-oauth', url: MCP, projects: ['proj-a'], authHosts: ['auth.example.com'], scopes: undefined };

const asMeta = (extra = {}) => ({ issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token', registration_endpoint: 'https://auth.example.com/register',
  revocation_endpoint: 'https://auth.example.com/revoke', code_challenge_methods_supported: ['S256'], ...extra });
const prm = (extra = {}) => ({ resource: MCP, authorization_servers: ['https://auth.example.com'], scopes_supported: ['mcp:use'], ...extra });

/** In-memory network: `routes` maps "METHOD url" to a response or a function of the request. */
function network(routes = {}) {
  const calls = [];
  const table = {
    [`POST ${MCP}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_PATH}", scope="read write"` }, body: null },
    [`GET ${PRM_PATH}`]: { status: 200, body: prm() },
    [`GET ${AS_META_URL}`]: { status: 200, body: asMeta() },
    'POST https://auth.example.com/register': { status: 201, body: { client_id: 'dcr-client' } },
    'POST https://auth.example.com/revoke': { status: 200, body: null },
    ...routes,
  };
  const request = async req => {
    calls.push(req);
    const route = table[`${req.method} ${req.url}`];
    if (!route) return { status: 404, headers: {}, body: null };
    const response = typeof route === 'function' ? route(req) : route;
    return { headers: {}, ...response };
  };
  return { request, calls };
}

const tmp = [];
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-test-')); tmp.push(dir); return dir; };
afterEach(() => { for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const normalised = (extra = {}) => validateMcpOAuthConfig('notion', { ...config, ...extra });

// ── Happy path ──────────────────────────────────────────────────────────────

test('discovers via WWW-Authenticate, registers by DCR and builds an S256 + resource authorization URL', async () => {
  const net = network();
  const cfg = normalised();
  const meta = await discover(cfg, net);
  expect(meta.challengeScope).toBe('read write');
  const client = await register(meta, cfg, net);
  expect(client).toEqual({ clientId: 'dcr-client', authMethod: 'none' });
  const dcr = net.calls.find(call => call.url.endsWith('/register')).payload;
  expect(dcr).toEqual({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], client_name: 'CarapaBox relay' });
  const { authorizationUrl, state, verifier } = authorizationRequest({ config: cfg, asMeta: meta, client });
  const url = new URL(authorizationUrl);
  expect(url.searchParams.get('code_challenge')).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('resource')).toBe(MCP);
  expect(url.searchParams.get('scope')).toBe('read write');
  expect(url.searchParams.get('state')).toBe(state);
  expect(Buffer.from(state, 'base64url').length).toBe(32);
});

test('falls back to the well-known paths and PRM scopes_supported when the probe has no challenge', async () => {
  const net = network({ [`POST ${MCP}`]: { status: 200, body: null }, [`GET ${PRM_PATH}`]: { status: 404, body: null },
    [`GET ${PRM_ROOT}`]: { status: 200, body: prm() } });
  const cfg = normalised();
  const meta = await discover(cfg, net);
  expect(net.calls.filter(call => call.method === 'GET').map(call => call.url).slice(0, 2)).toEqual([PRM_PATH, PRM_ROOT]);
  const client = await register(meta, cfg, net);
  expect(new URL(authorizationRequest({ config: cfg, asMeta: meta, client }).authorizationUrl).searchParams.get('scope')).toBe('mcp:use');
});

test('exchange sends resource and refresh keeps the old refresh token when none is returned', async () => {
  const bodies = [];
  const net = network({ 'POST https://auth.example.com/token': req => {
    bodies.push(req.payload);
    return { status: 200, body: req.payload.grant_type === 'authorization_code'
      ? { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 } : { access_token: 'a2', expires_in: 3600 } };
  } });
  const cfg = normalised();
  const meta = await discover(cfg, net);
  const client = { clientId: 'cid', authMethod: 'none' };
  const first = await exchangeCode({ config: cfg, asMeta: meta, client, code: 'c', verifier: 'v' }, net);
  const second = await refresh({ config: cfg, asMeta: meta, client, refreshToken: first.refreshToken }, net);
  expect(bodies.map(body => body.resource)).toEqual([MCP, MCP]);
  expect(second).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
});

// ── Metadata bypass variants ────────────────────────────────────────────────

const reject = async (routes, code, cfg = normalised()) => {
  await expect(discover(cfg, network(routes))).rejects.toThrow(code);
};

test('rejects metadata pointing outside the trusted hosts or off https:443', async () => {
  const header = host => ({ [`POST ${MCP}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${host}"` } } });
  await reject(header('https://evil.example.net/prm'), 'untrusted_metadata_host');
  await reject({ [`GET ${PRM_PATH}`]: { status: 200, body: prm({ authorization_servers: ['https://evil.example.net'] }) } }, 'untrusted_metadata_host');
  for (const token_endpoint of ['https://host.docker.internal:3100/token', 'https://10.0.0.5/token', 'https://auth.example.com:8443/token',
    'http://auth.example.com/token', 'https://evil.example.net/token']) {
    await reject({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ token_endpoint }) } }, 'untrusted_metadata_host');
  }
  await reject({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ registration_endpoint: 'https://evil.example.net/register' }) } }, 'untrusted_metadata_host');
});

test('rejects issuer mismatch, PRM resource mismatch and an AS without S256', async () => {
  await reject({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ issuer: 'https://auth.example.com/other' }) } }, 'issuer_mismatch');
  await reject({ [`GET ${PRM_PATH}`]: { status: 200, body: prm({ resource: 'https://mcp.example.com/other' }) } }, 'resource_mismatch');
  await reject({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ code_challenge_methods_supported: ['plain'] }) } }, 'pkce_s256_unsupported');
  await reject({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ code_challenge_methods_supported: undefined }) } }, 'pkce_s256_unsupported');
});

test('picks the PRM whose resource matches when the challenge points at a root document (Cloudinary shape)', async () => {
  const net = network({ [`POST ${MCP}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_ROOT}"` } },
    [`GET ${PRM_ROOT}`]: { status: 200, body: prm({ resource: 'https://mcp.example.com' }) },
    'POST https://auth.example.com/token': { status: 200, body: { access_token: 'a1', expires_in: 3600 } } });
  const cfg = normalised();
  const meta = await discover(cfg, net);
  const client = { clientId: 'cid', authMethod: 'none' };
  expect(new URL(authorizationRequest({ config: cfg, asMeta: meta, client }).authorizationUrl).searchParams.get('resource')).toBe(MCP);
  await exchangeCode({ config: cfg, asMeta: meta, client, code: 'c', verifier: 'v' }, net);
  expect(net.calls.find(call => call.url.endsWith('/token')).payload.resource).toBe(MCP);
});

test('a root-only server covers the MCP url and its normalised resource is sent', async () => {
  const net = network({ [`GET ${PRM_PATH}`]: { status: 404, body: null },
    [`GET ${PRM_ROOT}`]: { status: 200, body: prm({ resource: 'https://mcp.example.com' }) },
    'POST https://auth.example.com/token': { status: 200, body: { access_token: 'a1', expires_in: 3600 } } });
  const cfg = normalised();
  const meta = await discover(cfg, net);
  const client = { clientId: 'cid', authMethod: 'none' };
  expect(new URL(authorizationRequest({ config: cfg, asMeta: meta, client }).authorizationUrl).searchParams.get('resource')).toBe('https://mcp.example.com/');
  await exchangeCode({ config: cfg, asMeta: meta, client, code: 'c', verifier: 'v' }, net);
  expect(net.calls.find(call => call.url.endsWith('/token')).payload.resource).toBe('https://mcp.example.com/');
});

test('rejects PRM resources that neither match nor cover the MCP url', async () => {
  for (const resource of ['https://mcp.example.com/m', 'https://evil.example.com/mcp', 'https://mcp.example.com/other']) {
    await reject({ [`GET ${PRM_PATH}`]: { status: 200, body: prm({ resource }) } }, 'resource_mismatch');
  }
});

test('registration without clientId or registration endpoint is unavailable', async () => {
  const cfg = normalised();
  const meta = await discover(cfg, network({ [`GET ${AS_META_URL}`]: { status: 200, body: asMeta({ registration_endpoint: undefined }) } }));
  await expect(register(meta, cfg, network())).rejects.toThrow('client_registration_unavailable');
});

// ── Callback bypass variants ────────────────────────────────────────────────

test('callback validation rejects every mismatching variant', () => {
  const ok = `${REDIRECT}?code=abc&state=S`;
  expect(validateCallback(ok, REDIRECT, 'S')).toBe('abc');
  for (const value of [`${REDIRECT}?code=abc&state=X`, `${REDIRECT}?code=abc&state=S&state=S`, `${REDIRECT}?code=a&code=b&state=S`,
    `${REDIRECT}?error=access_denied&code=abc&state=S`, `${REDIRECT}?state=S`,
    `http://127.0.0.1:9999/callback?code=abc&state=S`, `http://localhost:33418/callback?code=abc&state=S`,
    `http://127.0.0.1:33418/other?code=abc&state=S`, `http://evil@127.0.0.1:33418/callback?code=abc&state=S`, 'not a url']) {
    expect(() => validateCallback(value, REDIRECT, 'S')).toThrow('callback_mismatch');
  }
});

// ── Config ──────────────────────────────────────────────────────────────────

function relayConfig(services) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({ providers: {}, services }));
  return dir;
}

test('readRelayConfigs accepts a valid mcp-oauth service and rejects unsafe definitions', () => {
  const good = { auth: 'mcp-oauth', url: MCP, projects: ['proj-a'] };
  expect(readRelayConfigs(relayConfig({ notion: good })).defaults.services.notion.url).toBe(MCP);
  const bad = [
    { ...good, url: 'https://10.0.0.5/mcp' }, { ...good, url: 'https://[::1]/mcp' }, { ...good, url: 'https://user:pw@mcp.example.com/mcp' },
    { ...good, url: 'https://mcp.example.com:8443/mcp' }, { ...good, url: 'http://mcp.example.com/mcp' }, { ...good, url: 'https://mcp.example.com/mcp#x' },
    { ...good, url: 'https://localhost/mcp' }, { ...good, url: 'https://host.docker.internal/mcp' }, { ...good, url: 'https://db.internal/mcp' },
    { ...good, url: 'https://printer.local/mcp' }, { ...good, url: 'https://127.1/mcp' },
    { ...good, projects: [] }, { ...good, projects: ['a/b'] }, { auth: 'mcp-oauth', url: MCP },
    { ...good, authHosts: ['127.0.0.1'] }, { ...good, redirectUri: 'http://evil.example.com/cb' },
    { ...good, clientSecretEnv: 'SECRET' },
    { ...good, host: 'db.internal' }, { ...good, port: 5432 }, { ...good, protocol: 'http' }, { ...good, pathPrefix: '/x' },
  ];
  for (const service of bad) expect(() => readRelayConfigs(relayConfig({ notion: service }))).toThrow();
  for (const name of ['anthropic', 'mcp-relay', 'board-api']) expect(() => readRelayConfigs(relayConfig({ [name]: good }))).toThrow();
});

// ── Login processor ─────────────────────────────────────────────────────────

function processor(routes = {}, services = { notion: normalised() }) {
  const accountsDir = tempDir();
  const net = network({ 'POST https://auth.example.com/token': req => ({ status: 200, body: req.payload.grant_type === 'authorization_code'
    ? { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } : { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } }), ...routes });
  const proc = createMcpOAuthProcessor({ accountsDir, getServices: () => new Map(Object.entries(services)), request: net.request, log: () => {} });
  const attempt = (id, files) => {
    const dir = path.join(accountsDir, 'mcp', 'attempts', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    return dir;
  };
  const status = dir => JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  return { accountsDir, net, proc, attempt, status, credential: path.join(accountsDir, 'mcp', 'credentials', 'notion--proj-a.json') };
}
const ID = crypto.randomUUID();

test('login: awaitingCallback never exposes state/verifier, callback exchange writes a 0600 credential, tokens are served', async () => {
  const t = processor();
  const dir = t.attempt(ID, { 'request.json': { service: 'notion', project: 'proj-a' } });
  await t.proc.scan();
  const status = t.status(dir);
  expect(status.state).toBe('awaitingCallback');
  const secret = JSON.parse(fs.readFileSync(path.join(dir, 'attempt-secret.json'), 'utf8'));
  expect(JSON.stringify(status)).not.toContain(secret.verifier);
  expect(fs.statSync(path.join(dir, 'attempt-secret.json')).mode & 0o777).toBe(0o600);
  const state = new URL(status.authorizationUrl).searchParams.get('state');
  fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=the-code&state=${state}` }));
  await t.proc.scan();
  expect(t.status(dir).state).toBe('connected');
  const exchange = t.net.calls.find(call => call.url.endsWith('/token')).payload;
  expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: secret.verifier, resource: MCP });
  expect(fs.statSync(t.credential).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(t.credential)).mode & 0o777).toBe(0o700);
  expect(await t.proc.getMcpAuth('notion', 'proj-a')).toEqual({ headers: { authorization: 'Bearer access-1' } });
  expect(JSON.parse(fs.readFileSync(path.join(t.accountsDir, 'mcp', 'status', 'notion--proj-a.json'), 'utf8')).state).toBe('connected');
  expect(await t.proc.getMcpAuth('notion', 'other')).toBeNull();
  // On-demand refresh rotates the stored tokens.
  expect(await t.proc.getMcpAuth('notion', 'proj-a', { force: true })).toEqual({ headers: { authorization: 'Bearer access-2' } });
  expect(JSON.parse(fs.readFileSync(t.credential, 'utf8')).refreshToken).toBe('refresh-2');
});

test('a failed disk write keeps the rotated tokens in memory, serves them and retries the write', async () => {
  let n = 0;
  const t = processor({ 'POST https://auth.example.com/token': req => ({ status: 200, body: req.payload.grant_type === 'authorization_code'
    ? { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }
    : { access_token: `access-${++n + 1}`, refresh_token: `refresh-${n + 1}`, expires_in: 3600 } }) });
  const dir = t.attempt(ID, { 'request.json': { service: 'notion', project: 'proj-a' } });
  await t.proc.scan();
  const state = new URL(t.status(dir).authorizationUrl).searchParams.get('state');
  fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=the-code&state=${state}` }));
  await t.proc.scan();
  // A read-only credentials dir makes every write fail (as ENOSPC/EIO would) while the old file stays readable.
  const credentialsDir = path.dirname(t.credential);
  fs.chmodSync(credentialsDir, 0o500);
  expect(await t.proc.getMcpAuth('notion', 'proj-a', { force: true })).toEqual({ headers: { authorization: 'Bearer access-2' } });
  // The disk still holds the consumed token; the next refresh must use the rotated one, not refresh-1.
  expect(await t.proc.getMcpAuth('notion', 'proj-a', { force: true })).toEqual({ headers: { authorization: 'Bearer access-3' } });
  const refreshes = t.net.calls.filter(call => call.url.endsWith('/token') && call.payload.grant_type === 'refresh_token');
  expect(refreshes.map(call => call.payload.refresh_token)).toEqual(['refresh-1', 'refresh-2']);
  expect(JSON.parse(fs.readFileSync(t.credential, 'utf8')).refreshToken).toBe('refresh-1');
  // Once the disk recovers the unsaved tokens are written.
  fs.chmodSync(credentialsDir, 0o700);
  expect(await t.proc.getMcpAuth('notion', 'proj-a')).toEqual({ headers: { authorization: 'Bearer access-3' } });
  expect(JSON.parse(fs.readFileSync(t.credential, 'utf8'))).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-3' });
});

test('an unwritable status dir never turns a failed refresh into a 502: valid token is served, expired one gives null', async () => {
  const failing = { 'POST https://auth.example.com/token': req => req.payload.grant_type === 'authorization_code'
    ? { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } } : { status: 500, body: {} } };
  const restore = [];
  const loggedIn = async () => {
    const t = processor(failing);
    const dir = t.attempt(ID, { 'request.json': { service: 'notion', project: 'proj-a' } });
    await t.proc.scan();
    const state = new URL(t.status(dir).authorizationUrl).searchParams.get('state');
    fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=the-code&state=${state}` }));
    await t.proc.scan();
    const statusDir = path.join(t.accountsDir, 'mcp', 'status');
    fs.chmodSync(statusDir, 0o500);
    restore.push(() => fs.chmodSync(statusDir, 0o700));
    return t;
  };
  try {
    const valid = await loggedIn();
    expect(await valid.proc.getMcpAuth('notion', 'proj-a', { force: true })).toEqual({ headers: { authorization: 'Bearer access-1' } });
    expect(await valid.proc.getMcpAuth('notion', 'proj-a', { force: true })).toEqual({ headers: { authorization: 'Bearer access-1' } });

    const expired = await loggedIn();
    const stored = JSON.parse(fs.readFileSync(expired.credential, 'utf8'));
    fs.writeFileSync(expired.credential, JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }));
    expect(await expired.proc.getMcpAuth('notion', 'proj-a')).toBeNull();

    const revoked = await loggedIn();
    fs.rmSync(revoked.credential);
    expect(await revoked.proc.getMcpAuth('notion', 'proj-a')).toBeNull();
  } finally { for (const undo of restore) undo(); }
});

test('login: a project outside the allowlist fails and a wrong-state callback stores nothing', async () => {
  const t = processor();
  const denied = t.attempt(ID, { 'request.json': { service: 'notion', project: 'other' } });
  await t.proc.scan();
  expect(t.status(denied)).toMatchObject({ state: 'failed', error: 'project_not_allowed' });
  expect(t.net.calls.length).toBe(0);

  const dir = t.attempt(crypto.randomUUID(), { 'request.json': { service: 'notion', project: 'proj-a' } });
  await t.proc.scan();
  fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=c&state=wrong` }));
  await t.proc.scan();
  expect(t.status(dir)).toMatchObject({ state: 'failed', error: 'callback_mismatch' });
  expect(fs.existsSync(t.credential)).toBe(false);
  expect(t.net.calls.some(call => call.url.endsWith('/token'))).toBe(false);
});

test('revoke.json revokes upstream and deletes the credential; expired attempts are removed', async () => {
  const t = processor();
  const dir = t.attempt(ID, { 'request.json': { service: 'notion', project: 'proj-a' } });
  await t.proc.scan();
  const state = new URL(t.status(dir).authorizationUrl).searchParams.get('state');
  fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=c&state=${state}` }));
  await t.proc.scan();
  const revokeDir = t.attempt(crypto.randomUUID(), { 'request.json': { service: 'notion', project: 'proj-a' }, 'revoke.json': {} });
  await t.proc.scan();
  expect(t.net.calls.filter(call => call.url.endsWith('/revoke')).map(call => call.payload.token)).toEqual(['refresh-1', 'access-1']);
  expect(fs.existsSync(t.credential)).toBe(false);
  expect(t.status(revokeDir).state).toBe('revoked');
  expect(await t.proc.getMcpAuth('notion', 'proj-a')).toBeNull();

  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'failed', expiresAt: Date.now() - 1 }));
  await t.proc.scan();
  expect(fs.existsSync(dir)).toBe(false);
});

// ── Forward mode ────────────────────────────────────────────────────────────

test('a forward-mode relay starts no MCP login processor; a normal relay does', async () => {
  const accounts = tempDir();
  const clients = tempDir();
  const base = { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts };
  const forward = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: clients, env: { ...base, RELAY_MODE: 'forward',
    CARAPA_RELAY_UPSTREAM: 'http://127.0.0.1:1', CARAPA_BOX_ID: 'lab', CARAPA_HUB_BOX_SECRET: 'x'.repeat(24) } });
  const normal = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: clients, env: base });
  try {
    for (const relay of [forward, normal]) if (!relay.server.listening) await once(relay.server, 'listening');
    expect(forward.mcpOAuth).toBeNull();
    expect(normal.mcpOAuth).not.toBeNull();
  } finally { forward.close(); normal.close(); }
});

test('MCP OAuth upstream requests are bounded: a stalled token endpoint becomes refreshFailed, not a hung lock', async () => {
  const t = processor({}, { notion: normalised() });
  const stalled = createMcpOAuthProcessor({ accountsDir: t.accountsDir, getServices: () => new Map([['notion', normalised()]]), timeoutMs: 50, log: () => {},
    request: options => new Promise((_, rejectRequest) => options.signal.addEventListener('abort', () => rejectRequest(new Error('aborted')))) });
  const dir = path.join(t.accountsDir, 'mcp', 'attempts', crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ service: 'notion', project: 'proj-a' }));
  await stalled.scan();
  expect(t.status(dir).state).toBe('failed');
});

// ── Relay routing ───────────────────────────────────────────────────────────

const SANDBOX_A = 'proj-a-agent-1.agent_egress_proj-a';
const SANDBOX_B = 'proj-b-agent-1.agent_egress_proj-b';

/** Fake Box serving /api/admin/relay-identity/<name>; `identities` maps suffix -> instance,. */
async function fakeBox(identities) {
  const box = { identities, calls: [], auth: [], status: null };
  box.server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop());
    box.calls.push(name);
    box.auth.push(req.headers.authorization);
    const instance = box.identities[name];
    if (box.status) { res.writeHead(box.status); return res.end(); }
    if (!instance) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stack: 'stack', instance }));
  });
  await new Promise(resolve => box.server.listen(0, '127.0.0.1', resolve));
  box.url = `http://127.0.0.1:${box.server.address().port}`;
  return box;
}

/** A relay with a connected credential per project, a fake AS and a recording fake upstream. */
async function routedRelay({ services, upstream, extraEnv = {}, hostname = SANDBOX_A, projects = ['proj-a', 'proj-b'], clients, identities = { 'proj-a': 'proj-a', 'proj-b': 'proj-b' }, connect = true, relayFileReader, netRoutes = {} } = {}) {
  const accounts = tempDir();
  const box = await fakeBox(identities);
  const clientsDir = clients ?? relayConfig({ notion: { auth: 'mcp-oauth', url: MCP, projects, authHosts: ['auth.example.com'], ...services } });
  let counter = 0;
  const net = network({ 'POST https://auth.example.com/token': req => ({ status: 200, body: req.payload.grant_type === 'authorization_code'
    ? { access_token: `access-${req.payload.code}`, refresh_token: `refresh-${req.payload.code}`, expires_in: 3600 }
    : { access_token: `refreshed-${++counter}`, expires_in: 3600 } }), ...netRoutes });
  const seen = [];
  const state = { hostname };
  const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir, hostnameResolver: () => state.hostname,
    mcpOAuthRequest: net.request, relayFileReader, env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts,
      CARAPA_BOX_URL: box.url, CARAPA_BOX_ADMIN_TOKEN: 'box-admin', ...extraEnv },
    externalRequest: async (provider, target, method, headers, body) => {
      seen.push({ provider, target, method, headers: { ...headers }, body: body ? body.toString() : '' });
      return upstream(seen.length, headers);
    } });
  if (!relay.server.listening) await once(relay.server, 'listening');
  const { Readable } = await import('node:stream');
  const reply = (statusCode, headers, body = '') => Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
  // Connect each project through the real login exchange against the fake AS.
  for (const project of connect ? projects : []) {
    const dir = path.join(accounts, 'mcp', 'attempts', crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ service: 'notion', project }));
    await relay.mcpOAuth.scan();
    const authState = new URL(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).authorizationUrl).searchParams.get('state');
    fs.writeFileSync(path.join(dir, 'callback.json'), JSON.stringify({ value: `${REDIRECT}?code=${project}&state=${authState}` }));
    await relay.mcpOAuth.scan();
  }
  const url = path => `http://127.0.0.1:${relay.server.address().port}${path}`;
  return { relay, seen, state, url, reply, accounts, box, close: () => { box.server.close(); return relay.close(); } };
}

const okJson = (r) => (_n) => r.reply(200, { 'content-type': 'application/json' }, '{"ok":true}');

test('an allowed project gets its own Bearer, only on url.pathname, with client auth and forwarding headers dropped', async () => {
  const t = { reply: null };
  const r = await routedRelay({ upstream: (...args) => t.up(...args) });
  t.reply = r.reply; t.up = okJson(r);
  try {
    for (const [sandbox, token] of [[SANDBOX_A, 'access-proj-a'], [SANDBOX_B, 'access-proj-b']]) {
      r.state.hostname = sandbox;
      const response = await fetch(r.url('/notion/?x=1'), { method: 'POST', body: '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}',
        headers: { authorization: 'Bearer sandbox-supplied', 'x-api-key': 'k', 'x-forwarded-for': '1.2.3.4', cookie: 'c=1', 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-06-18', 'last-event-id': '7' } });
      expect(response.status).toBe(200);
      const call = r.seen.at(-1);
      expect(call.provider.host).toBe('mcp.example.com');
      expect(call.target).toBe('/mcp?x=1');
      expect(call.headers.authorization).toBe('Bearer ' + token);
      expect(call.headers).toMatchObject({ 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-06-18', 'last-event-id': '7', accept: 'application/json, text/event-stream' });
      for (const name of ['x-api-key', 'x-forwarded-for', 'cookie']) expect(call.headers[name]).toBeUndefined();
    }
  } finally { r.close(); }
});

test('the configured url query is kept on data calls and cannot be overridden by the sandbox', async () => {
  const t = {};
  const queried = `${MCP}?workspace=w&mode=a%20b`;
  const r = await routedRelay({ upstream: (...args) => t.up(...args), services: { url: queried }, netRoutes: {
    [`POST ${queried}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_PATH}"` }, body: null },
    [`GET ${PRM_PATH}`]: { status: 200, body: prm({ resource: queried }) } } });
  t.up = okJson(r);
  try {
    for (const [path, target] of [
      ['/notion/?x=1', '/mcp?workspace=w&mode=a%20b&x=1'],
      ['/notion', '/mcp?workspace=w&mode=a%20b'],
      ['/notion/?workspace=other&x=1&mode=z&workspace=again', '/mcp?workspace=w&mode=a%20b&x=1'],
      ['/notion/?%77orkspace=other', '/mcp?workspace=w&mode=a%20b'],
    ]) {
      expect((await fetch(r.url(path), { method: 'POST', body: '{}' })).status).toBe(200);
      expect(r.seen.at(-1).target).toBe(target);
    }
  } finally { r.close(); }
});

test('an over-cap body gets 413 and is never forwarded; a body under the cap is forwarded unchanged', async () => {
  const t = {};
  const r = await routedRelay({ upstream: (...args) => t.up(...args), extraEnv: { RELAY_MAX_REQUEST_BODY_BYTES: '1024' } });
  t.up = okJson(r);
  try {
    const big = await fetch(r.url('/notion'), { method: 'POST', body: 'x'.repeat(1025) });
    expect(big.status).toBe(413);
    expect(big.headers.get('connection')).toBe('close');
    expect((await big.json()).error).toBe('request_too_large');
    const chunked = await fetch(r.url('/notion'), { method: 'POST', duplex: 'half',
      body: new ReadableStream({ start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(512)); controller.close(); } }) });
    expect(chunked.status).toBe(413);
    expect(r.seen.length).toBe(0);
    expect((await fetch(r.url('/notion'), { method: 'POST', body: 'y'.repeat(1024) })).status).toBe(200);
    expect(r.seen.map(call => call.body)).toEqual(['y'.repeat(1024)]);
  } finally { r.close(); }
});

test('a sandbox of a project outside the allowlist, or without the egress suffix, gets 403 and nothing is sent', async () => {
  const t = {};
  const r = await routedRelay({ projects: ['proj-a'], upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    for (const hostname of [SANDBOX_B, 'proj-a-agent-1', null, 'proj-a-agent-1.agent_egress_proj-a.evil', 'x.agent_egress_']) {
      r.state.hostname = hostname;
      expect((await fetch(r.url('/notion'))).status).toBe(403);
    }
    expect(r.seen.length).toBe(0);
  } finally { r.close(); }
});

test('only /<service> and /<service>/ are proxied; other subpaths are 404', async () => {
  const t = {};
  const r = await routedRelay({ upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    for (const target of ['/notion/../x', '/notion/other', '/notion/%2e%2e/x', '/notion//']) expect((await fetch(r.url(target))).status).toBe(404);
    expect(r.seen.length).toBe(0);
    expect((await fetch(r.url('/notion'))).status).toBe(200);
    expect(r.seen[0].target).toBe('/mcp');
  } finally { r.close(); }
});

test('a 401 refreshes once and retries; a persistent 401 or no credential is a 503 without www-authenticate', async () => {
  const t = {};
  const r = await routedRelay({ upstream: (...args) => t.up(...args) });
  t.up = (n, headers) => headers.authorization === 'Bearer access-proj-a' ? r.reply(401, { 'www-authenticate': 'Bearer resource_metadata="x"' })
    : r.reply(200, { 'content-type': 'application/json' }, '{"ok":true}');
  try {
    const retried = await fetch(r.url('/notion'), { method: 'POST', body: '{}' });
    expect(retried.status).toBe(200);
    expect(r.seen.map(call => call.headers.authorization)).toEqual(['Bearer access-proj-a', 'Bearer refreshed-1']);
    expect(retried.headers.get('www-authenticate')).toBeNull();

    t.up = () => r.reply(401, { 'www-authenticate': 'Bearer resource_metadata="x"' });
    const failed = await fetch(r.url('/notion'), { method: 'POST', body: '{}' });
    expect(failed.status).toBe(503);
    expect(failed.headers.get('www-authenticate')).toBeNull();
    expect(await failed.json()).toEqual({ error: 'mcp_oauth_refresh_failed', service: 'notion', project: 'proj-a' });

    fs.rmSync(path.join(r.accounts, 'mcp', 'credentials', 'notion--proj-a.json'));
    const missing = await fetch(r.url('/notion'));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: 'mcp_oauth_not_connected', service: 'notion', project: 'proj-a' });
  } finally { r.close(); }
});

test('upstream www-authenticate is stripped from successful responses and SSE headers are flushed before the first event', async () => {
  const t = {};
  const r = await routedRelay({ upstream: (...args) => t.up(...args) });
  const { PassThrough } = await import('node:stream');
  const events = new PassThrough();
  t.up = () => Object.assign(events, { statusCode: 200, headers: { 'content-type': 'text/event-stream', 'www-authenticate': 'Bearer' } });
  try {
    const response = await fetch(r.url('/notion'), { headers: { accept: 'text/event-stream' } });
    // fetch resolves on headers: no event has been written yet.
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('www-authenticate')).toBeNull();
    events.write('data: hi\n\n');
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: hi\n\n');
    await reader.cancel();
  } finally { r.close(); }
});

test('a WebSocket upgrade to an mcp-oauth route is refused with 404', async () => {
  const t = {};
  const r = await routedRelay({ upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    const net = await import('node:net');
    const socket = net.connect(r.relay.server.address().port, '127.0.0.1');
    socket.write('GET /notion HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const [chunk] = await once(socket, 'data');
    expect(chunk.toString()).toStartWith('HTTP/1.1 404');
    socket.destroy();
    expect(r.seen.length).toBe(0);
  } finally { r.close(); }
});

test('a strict client without the route cannot reach the service', async () => {
  const t = {};
  const clients = tempDir();
  fs.writeFileSync(path.join(clients, 'default.json'), JSON.stringify({ providers: {}, services: { notion: { auth: 'mcp-oauth', url: MCP, projects: ['proj-a'], authHosts: ['auth.example.com'] } } }));
  fs.writeFileSync(path.join(clients, 'strict.json'), JSON.stringify({ match: [SANDBOX_A], isolation: 'strict', providers: {}, services: {} }));
  const r = await routedRelay({ clients, projects: [], extraEnv: { RELAY_REQUIRE_KNOWN_CLIENTS: '1' }, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect((await fetch(r.url('/notion'))).status).toBe(403);
    expect(r.seen.length).toBe(0);
  } finally { r.close(); }
});

test('forwarded credentials never supply the token: the project credential is used', async () => {
  const t = {};
  const { forwarderKeyFromSecret, signForwardHeaders } = await import('./api-relay/relay-forwarding.mjs');
  const key = forwarderKeyFromSecret('cbx_test-box-connection-value');
  const http = await import('node:http');
  const board = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ key, projects: ['proj-a'] })); });
  board.listen(0, '127.0.0.1');
  await once(board, 'listening');
  const r = await routedRelay({ projects: ['proj-a'], hostname: null, upstream: (...args) => t.up(...args), extraEnv: {
    RELAY_FORWARDER_PORT: '0', RELAY_FORWARDER_HOST: '127.0.0.1', CARAPA_RELAY_HUB_SECRET: 'hub-secret-0123456789',
    CARAPA_BOARD_URL: `http://127.0.0.1:${board.address().port}` } });
  t.up = okJson(r);
  try {
    if (!r.relay.forwarderListener.listening) await once(r.relay.forwarderListener, 'listening');
    const post = (sandbox, credentials) => fetch(`http://127.0.0.1:${r.relay.forwarderListener.address().port}/notion`, { method: 'POST', body: '{}',
      headers: signForwardHeaders({ keyHex: key, method: 'POST', path: '/notion', box: 'lab', sandbox, credentials }) });
    expect((await post('proj-a-agent-1.agent_egress_proj-a', { '': 'forged-token', notion: 'forged-token' })).status).toBe(200);
    expect(r.seen.at(-1).headers.authorization).toBe('Bearer access-proj-a');
    expect(JSON.stringify(r.seen)).not.toContain('forged-token');
    // A forwarded sandbox without the egress suffix is not a project sandbox.
    expect((await post('proj-a-agent-1', { notion: 'forged-token' })).status).toBe(403);
  } finally { r.close(); board.close(); }
});

// ── Project identity (egress network suffix -> board project via Box) ──────

const REAL_SANDBOX = 'x-agent-1.agent_egress_carapa-projects-carapa';
const REAL_IDENTITIES = { 'carapa-projects-carapa': 'carapa' };

test('a real sandbox hostname resolves to its board project through Box and gets that project\'s Bearer only', async () => {
  const t = {};
  const r = await routedRelay({ projects: ['carapa', 'other'], hostname: REAL_SANDBOX, identities: REAL_IDENTITIES, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect((await fetch(r.url('/notion'), { method: 'POST', body: '{}' })).status).toBe(200);
    expect(r.seen.at(-1).headers.authorization).toBe('Bearer access-carapa');
    expect(r.seen.every(call => call.headers.authorization !== 'Bearer access-other')).toBe(true);
    expect(r.box.auth[0]).toBe('Bearer box-admin');
  } finally { r.close(); }
});

test('the raw network suffix is no longer accepted as the project', async () => {
  const t = {};
  const r = await routedRelay({ projects: ['carapa-projects-carapa'], hostname: REAL_SANDBOX, identities: REAL_IDENTITIES, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect((await fetch(r.url('/notion'))).status).toBe(403);
    expect(r.seen.length).toBe(0);
  } finally { r.close(); }
});

test('unknown to Box, Box error or Box down fails closed with 403', async () => {
  const t = {};
  const r = await routedRelay({ projects: ['carapa'], hostname: REAL_SANDBOX, identities: {}, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect((await fetch(r.url('/notion'))).status).toBe(403);
    r.box.server.close();
    r.state.hostname = 'x-agent-1.agent_egress_other-net';
    expect((await fetch(r.url('/notion'))).status).toBe(403);
    expect(r.seen.length).toBe(0);
  } finally { r.close(); }
});

test('a positive Box lookup is cached; a negative one is not retried within its TTL', async () => {
  const t = {};
  const r = await routedRelay({ projects: ['carapa'], hostname: REAL_SANDBOX, identities: REAL_IDENTITIES, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    for (let i = 0; i < 3; i++) expect((await fetch(r.url('/notion'))).status).toBe(200);
    expect(r.box.calls.filter(name => name === 'carapa-projects-carapa').length).toBe(1);
    r.state.hostname = 'x-agent-1.agent_egress_unknown';
    for (let i = 0; i < 2; i++) expect((await fetch(r.url('/notion'))).status).toBe(403);
    expect(r.box.calls.filter(name => name === 'unknown').length).toBe(1);
  } finally { r.close(); }
});

// ── Sandbox-initiated login ─────────────────────────────────────────────────

const until = async (read, ok) => {
  for (let i = 0; i < 100; i++) { const value = await read(); if (ok(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('timeout');
};
const post = (r, target, body) => fetch(r.url(target), { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const getStatus = async r => (await fetch(r.url('/notion/.status'))).json();

test('sandbox login: .login -> .status awaitingCallback -> complete -> connected -> Bearer is injected', async () => {
  const t = {};
  const r = await routedRelay({ connect: false, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect(await getStatus(r)).toMatchObject({ service: 'notion', project: 'proj-a', state: 'loginRequired', logins: [] });
    const login = await post(r, '/notion/.login');
    expect(login.status).toBe(202);
    expect(login.headers.get('cache-control')).toBe('no-store');
    expect(login.headers.get('content-type')).toBe('application/json');
    const { id } = await login.json();
    const waiting = await until(() => getStatus(r), s => s.logins[0]?.state === 'awaitingCallback');
    expect(waiting.logins[0]).toMatchObject({ id });
    const authState = new URL(waiting.logins[0].authorizationUrl).searchParams.get('state');
    const done = await post(r, `/notion/.login/${id}/complete`, { value: `${REDIRECT}?code=proj-a&state=${authState}` });
    expect(done.status).toBe(202);
    expect((await until(() => getStatus(r), s => s.state === 'connected')).state).toBe('connected');
    expect((await fetch(r.url('/notion'), { method: 'POST', body: '{}' })).status).toBe(200);
    expect(r.seen.at(-1).headers.authorization).toBe('Bearer access-proj-a');
    expect(r.seen.length).toBe(1);
  } finally { r.close(); }
});

test('sandbox login: project comes from the identity (body/query ignored), other projects are isolated, no secrets or revoke', async () => {
  const t = {};
  const r = await routedRelay({ connect: false, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    const { id } = await (await post(r, '/notion/.login?project=proj-b', { project: 'proj-b', service: 'other' })).json();
    const request = JSON.parse(fs.readFileSync(path.join(r.accounts, 'mcp', 'attempts', id, 'request.json'), 'utf8'));
    expect(request).toEqual({ service: 'notion', project: 'proj-a' });
    const waiting = await until(() => getStatus(r), s => s.logins[0]?.state === 'awaitingCallback');
    const text = JSON.stringify(waiting);
    for (const secret of ['accessToken', 'refreshToken', 'verifier', 'client_secret', 'code_verifier']) expect(text).not.toContain(secret);
    expect(waiting.relayCode).toMatch(/^[0-9a-f]{12}$/);

    r.state.hostname = SANDBOX_B;
    expect((await getStatus(r)).logins).toEqual([]);
    const authState = new URL(waiting.logins[0].authorizationUrl).searchParams.get('state');
    const foreign = await post(r, `/notion/.login/${id}/complete`, { value: `${REDIRECT}?code=x&state=${authState}` });
    const unknown = await post(r, `/notion/.login/${crypto.randomUUID()}/complete`, { value: 'x' });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    expect(fs.existsSync(path.join(r.accounts, 'mcp', 'attempts', id, 'callback.json'))).toBe(false);
    expect((await post(r, '/notion/.revoke')).status).toBe(404);
    expect((await post(r, '/notion/.login/revoke')).status).toBe(404);
    expect((await fetch(r.url('/notion/.status'), { method: 'POST' })).status).toBe(404);
  } finally { r.close(); }
});

test('sandbox login: not-allowed projects and identity failures get 403 on all three routes', async () => {
  const t = {};
  const r = await routedRelay({ connect: false, projects: ['proj-a'], upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  const id = crypto.randomUUID();
  const hit = async () => [(await fetch(r.url('/notion/.status'))).status, (await post(r, '/notion/.login')).status,
    (await post(r, `/notion/.login/${id}/complete`, { value: 'x' })).status];
  try {
    r.state.hostname = SANDBOX_B;
    expect(await hit()).toEqual([403, 403, 403]);
    r.state.hostname = SANDBOX_A;
    r.box.status = 500;
    r.state.hostname = 'proj-c-agent-1.agent_egress_unknown';
    expect(await hit()).toEqual([403, 403, 403]);
    expect(fs.readdirSync(path.join(r.accounts, 'mcp', 'attempts'))).toEqual([]);
  } finally { r.close(); }
});

test('sandbox login: limits (2 per project, 16 total), value validation and non-UUID ids', async () => {
  const t = {};
  const r = await routedRelay({ connect: false, upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    expect((await post(r, '/notion/.login')).status).toBe(202);
    expect((await post(r, '/notion/.login')).status).toBe(202);
    const third = await post(r, '/notion/.login');
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: 'login_in_progress' });

    const waiting = await until(() => getStatus(r), s => s.logins.length === 2 && s.logins.every(l => l.state === 'awaitingCallback'));
    const id = waiting.logins[0].id;
    for (const value of ['x'.repeat(16 * 1024 + 1), 42, undefined, null, ['a']]) {
      expect((await post(r, `/notion/.login/${id}/complete`, { value })).status).toBe(400);
    }
    expect((await post(r, `/notion/.login/${id}/complete`, undefined)).status).toBe(400);
    expect((await post(r, '/notion/.login/not-a-uuid/complete', { value: 'x' })).status).toBe(404);
    // Encoded separators are refused by the relay's global unsafe-path check before routing.
    expect((await post(r, '/notion/.login/..%2F..%2Fx/complete', { value: 'x' })).status).toBe(400);

    // Global cap (total 16 is above the 12 sandbox ceiling): fill the directory with 14 more in-flight attempts of other projects.
    const dir = path.join(r.accounts, 'mcp', 'attempts');
    for (let i = 0; i < 14; i++) {
      const d = path.join(dir, crypto.randomUUID());
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'request.json'), JSON.stringify({ service: 'notion', project: `p${i}` }));
    }
    r.state.hostname = SANDBOX_B;
    const capped = await post(r, '/notion/.login');
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: 'too_many_logins' });
  } finally { r.close(); }
});

test('sandbox login: one project holds at most 4 attempts across services and leaves 4 global slots for the admin', async () => {
  const t = {};
  const service = { auth: 'mcp-oauth', url: MCP, projects: ['proj-a', 'proj-b'], authHosts: ['auth.example.com'] };
  const r = await routedRelay({ connect: false, clients: relayConfig({ notion: service, linear: service, github: service }), upstream: (...args) => t.up(...args) });
  t.up = okJson(r);
  try {
    for (const svc of ['notion', 'notion', 'linear', 'linear']) expect((await post(r, `/${svc}/.login`)).status).toBe(202);
    const extra = await post(r, '/github/.login');
    expect(extra.status).toBe(429);
    expect(await extra.json()).toEqual({ error: 'too_many_logins' });

    r.state.hostname = SANDBOX_B;
    expect((await post(r, '/notion/.login')).status).toBe(202);

    // 5 in flight; 7 more from other projects reach 12 = the sandbox ceiling (16 minus 4 reserved for Box).
    const dir = path.join(r.accounts, 'mcp', 'attempts');
    for (let i = 0; i < 7; i++) {
      const d = path.join(dir, crypto.randomUUID());
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'request.json'), JSON.stringify({ service: 'notion', project: `p${i}` }));
    }
    const reserved = await post(r, '/linear/.login');
    expect(reserved.status).toBe(429);
    expect(await reserved.json()).toEqual({ error: 'too_many_logins' });
  } finally { r.close(); }
});

test('relayCode is 12 hex chars and changes with the content of mcp-oauth.mjs', async () => {
  const code = async content => {
    const t = {};
    const r = await routedRelay({ connect: false, upstream: (...args) => t.up(...args),
      relayFileReader: file => (file.includes('mcp-oauth') ? content : 'relay') });
    try { return (await getStatus(r)).relayCode; } finally { r.close(); }
  };
  const a = await code('one');
  expect(a).toMatch(/^[0-9a-f]{12}$/);
  expect(await code('one')).toBe(a);
  expect(await code('two')).not.toBe(a);
});
