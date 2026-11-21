import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { startApiRelay } from './api-relay/api-relay.mjs';
import { allowRuleMatches, readAccountRegistry, validAllowRule } from './api-relay/provider-account-config.mjs';

const CLIENT_TOKEN = 'glpat-read-only';
const PROJECT_TOKEN = 'glpat-project-issues';
const CRM_TOKEN = 'crm-secret';
const MAPS_TOKEN = 'maps-secret';

function send(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
      headers: { 'private-token': 'app-dummy', 'x-crm-key': 'app-dummy' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function writeAccounts(dir, accounts) {
  fs.mkdirSync(path.join(dir, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(accounts.map(({ token, ...account }) => {
    const credentialId = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, 'credentials', credentialId + '.json'), JSON.stringify({ apiKey: token }));
    return { id: crypto.randomUUID(), credentialId, label: account.provider, scope: 'project',
      project: { stack: 'demo-site', instance: 'demo-app' }, containers: ['demo-site-demo-app-php84-1'], ...account };
  })));
}

// A project integration must reach its service only from its own containers and
// only for its allowed calls, with the token placed as configured. On an existing
// route (GitLab) any other call keeps the client's key; on its own route it is refused.
test('project integrations serve only their containers and allowed calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-project-key-'));
  const clients = path.join(root, 'clients');
  const accounts = path.join(root, 'accounts');
  fs.mkdirSync(clients);
  fs.writeFileSync(path.join(clients, 'php.json'), JSON.stringify({ match: ['*-php84-*'],
    providers: { gitlab: { auth: 'apikey', envKey: 'GITLAB_PAT', host: 'gl.test' } } }));
  writeAccounts(accounts, [
    { provider: 'gitlab', host: 'gl.test', token: PROJECT_TOKEN,
      allow: [{ method: 'POST', path: '/api/v4/projects/99/issues' }, { method: 'GET', path: '/api/v4/projects/99/issues/*' }] },
    { provider: 'custom', route: 'crm', host: 'crm.test', pathPrefix: '/v2', auth: { type: 'header', name: 'x-crm-key' },
      token: CRM_TOKEN, allow: [{ method: 'POST', path: '/contacts' }] },
    { provider: 'custom', route: 'maps', host: 'maps.test', pathPrefix: '', auth: { type: 'query', name: 'key' },
      token: MAPS_TOKEN, allow: [{ method: 'GET', path: '/geocode' }] },
  ]);

  const calls = [];
  const state = { client: 'demo-site-demo-app-php84-1.agent_egress' };
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: clients, hostnameResolver: () => state.client,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', GITLAB_PAT: CLIENT_TOKEN, SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    externalRequest: async (provider, targetPath, method, headers) => {
      const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      calls.push({ host: provider.host, targetPath, method, headerCount: Object.keys(headers).length, uniqueCount: Object.keys(lower).length, ...lower });
      const upstream = Readable.from([Buffer.from('{}')]);
      upstream.statusCode = 200; upstream.headers = { 'content-type': 'application/json' };
      return upstream;
    },
  });
  try {
    if (!relay.server.listening) await once(relay.server, 'listening');
    const { port } = relay.server.address();
    const tokenFor = async (method, url) => {
      expect(await send(port, method, url)).toBe(200);
      const call = calls.at(-1);
      // Exactly one token header leaves the relay, never the application's own.
      expect(call.uniqueCount).toBe(call.headerCount);
      return call['private-token'];
    };

    expect(await tokenFor('POST', '/gitlab/api/v4/projects/99/issues')).toBe(PROJECT_TOKEN);
    expect(calls.at(-1)).toMatchObject({ host: 'gl.test', targetPath: '/api/v4/projects/99/issues' });
    expect(await tokenFor('GET', '/gitlab/api/v4/projects/99/issues/7?x=1')).toBe(PROJECT_TOKEN);

    // Same container, a call no rule allows: other method, project, depth, or an encoded spelling.
    expect(await tokenFor('DELETE', '/gitlab/api/v4/projects/99/issues')).toBe(CLIENT_TOKEN);
    expect(await tokenFor('POST', '/gitlab/api/v4/projects/98/issues')).toBe(CLIENT_TOKEN);
    expect(await tokenFor('GET', '/gitlab/api/v4/projects/99/issues/7/notes')).toBe(CLIENT_TOKEN);
    expect(await tokenFor('POST', '/gitlab/api/v4/projects/%39%39/issues')).toBe(CLIENT_TOKEN);

    // A custom route: its header replaces the application's, below its base path;
    // a query token replaces any the client sent.
    expect(await send(port, 'POST', '/crm/contacts')).toBe(200);
    expect(calls.at(-1)).toMatchObject({ host: 'crm.test', targetPath: '/v2/contacts', 'x-crm-key': CRM_TOKEN });
    expect(calls.at(-1)['private-token']).toBeUndefined();
    expect(await send(port, 'GET', '/maps/geocode?q=Cluj&key=mine')).toBe(200);
    expect(calls.at(-1)).toMatchObject({ host: 'maps.test', targetPath: `/geocode?q=Cluj&key=${MAPS_TOKEN}` });
    const forwarded = calls.length;
    expect(await send(port, 'DELETE', '/crm/contacts')).toBe(403);
    expect(await send(port, 'GET', '/maps/directions')).toBe(403);

    // Another container matching the same relay client never gets a project token.
    for (const client of ['demo-site-other-php84-1.agent_egress', 'demo-site-demo-app-php84-1-evil.agent_egress']) {
      state.client = client;
      expect(await tokenFor('POST', '/gitlab/api/v4/projects/99/issues')).toBe(CLIENT_TOKEN);
      expect(await send(port, 'POST', '/crm/contacts')).toBe(404);
    }
    expect(calls.filter(call => call.host !== 'gl.test').length).toBe(2);
    expect(calls.length).toBe(forwarded + 2);
  } finally {
    relay.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An upstream that redirects and keeps the query would hand a query token to the
// application. Only the URL headers are redacted, and only for query auth.
test('a query token is redacted from redirect and link headers, other auth passes through', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-query-redact-'));
  const clients = path.join(root, 'clients');
  const accounts = path.join(root, 'accounts');
  fs.mkdirSync(clients);
  const secret = 'maps secret/XYZ+1';
  writeAccounts(accounts, [
    { provider: 'custom', route: 'maps', host: 'maps.test', pathPrefix: '', auth: { type: 'query', name: 'key' },
      token: secret, allow: [{ method: 'GET', path: '/geocode' }] },
    { provider: 'custom', route: 'crm', host: 'crm.test', pathPrefix: '', auth: { type: 'header', name: 'x-crm-key' },
      token: CRM_TOKEN, allow: [{ method: 'GET', path: '/contacts' }] },
  ]);
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: clients, hostnameResolver: () => 'demo-site-demo-app-php84-1.agent_egress',
    env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts },
    externalRequest: async (provider, targetPath) => {
      const upstream = Readable.from([Buffer.from('{}')]);
      upstream.statusCode = 307;
      const url = `https://${provider.host}${targetPath.replace('?', '/?')}`;
      upstream.headers = { location: url, 'content-location': url, link: `<${url}>; rel="next"`,
        refresh: `0; url=${url}`, 'x-echo': url };
      return upstream;
    },
  });
  const get = (port, requestPath) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
      response.resume();
      response.once('end', () => resolve(response));
    }).once('error', reject);
  });
  try {
    if (!relay.server.listening) await once(relay.server, 'listening');
    const { port } = relay.server.address();

    const maps = await get(port, '/maps/geocode?q=x');
    expect(maps.statusCode).toBe(307);
    expect(maps.headers.location).toBe('https://maps.test/geocode/?q=x&key=[REDACTED]');
    expect(maps.headers['content-location']).toBe('https://maps.test/geocode/?q=x&key=[REDACTED]');
    expect(maps.headers.link).toBe('<https://maps.test/geocode/?q=x&key=[REDACTED]>; rel="next"');
    expect(maps.headers.refresh).toBe('0; url=https://maps.test/geocode/?q=x&key=[REDACTED]');
    // Other headers are not touched (bodies and unrelated headers are out of scope).
    expect(maps.headers['x-echo']).toContain(encodeURIComponent(secret));

    // Header auth: no query token was injected, so the redirect passes through exactly.
    const crm = await get(port, '/crm/contacts?q=x');
    expect(crm.headers.location).toBe('https://crm.test/contacts/?q=x');
  } finally {
    relay.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only project integrations carry containers and rules, and a custom route is HTTPS on its own name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-project-registry-'));
  const base = { id: crypto.randomUUID(), credentialId: crypto.randomUUID(), label: 'p', scope: 'project',
    project: { stack: 'demo-site', instance: 'demo-app' }, containers: ['demo-site-demo-app-php84-1'], allow: [{ method: 'POST', path: '/api/v4/projects/99/issues' }] };
  const custom = { ...base, provider: 'custom', route: 'crm', host: 'crm.test', pathPrefix: '/v2', auth: { type: 'bearer' } };
  const read = account => { fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify([account])); return () => readAccountRegistry(root); };
  try {
    expect(read({ ...base, provider: 'gitlab', host: 'gl.test' })()).toHaveLength(1);
    expect(read(custom)()).toHaveLength(1);
    expect(read({ ...base, provider: 'openai' })).toThrow();
    expect(read({ ...base, provider: 'gitlab', host: 'gl.test', allow: [] })).toThrow();
    expect(read({ ...base, provider: 'gitlab', host: 'gl.test', allow: [{ method: 'POST', path: '/api/v4/projects/../issues' }] })).toThrow();
    expect(read({ ...base, provider: 'gitlab', host: 'gl.test', containers: ['demo-site-demo-app-php84-1.agent_egress'] })).toThrow();
    expect(read({ ...base, provider: 'gitlab', host: 'gl.test', scope: 'shared' })).toThrow();
    expect(read({ ...custom, route: 'anthropic' })).toThrow();
    expect(read({ ...custom, host: 'crm.test:8443' })).toThrow();
    expect(read({ ...custom, auth: { type: 'header', name: 'host' } })).toThrow();
    expect(read({ ...custom, scope: 'shared' })).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A strict client lists the routes its container may reach; the container's own integration
// grant is one more, and only for the calls its rules allow.
test('a strict relay client reaches its own custom integration route, and no other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-strict-grant-'));
  const clients = path.join(root, 'clients');
  const accounts = path.join(root, 'accounts');
  fs.mkdirSync(clients);
  fs.writeFileSync(path.join(clients, 'php.json'), JSON.stringify({ match: ['demo-site-demo-app-php84-1'], isolation: 'strict', providers: {} }));
  writeAccounts(accounts, [
    { provider: 'custom', route: 'crm', host: 'crm.test', pathPrefix: '/v2', auth: { type: 'header', name: 'x-crm-key' },
      token: CRM_TOKEN, allow: [{ method: 'POST', path: '/contacts/' }] },
    { provider: 'custom', route: 'maps', host: 'maps.test', pathPrefix: '', auth: { type: 'header', name: 'x-crm-key' },
      token: MAPS_TOKEN, allow: [{ method: 'GET', path: '/geocode' }], containers: ['demo-site-demo-app-other-1'] },
    { provider: 'custom', route: 'ping', host: 'ping.test', pathPrefix: '', auth: { type: 'header', name: 'x-crm-key' },
      token: CRM_TOKEN, allow: [{ method: 'GET', path: '/' }] },
    // A valid route name that is also an inherited property of every plain object.
    { provider: 'custom', route: 'constructor', host: 'ctor.test', pathPrefix: '', auth: { type: 'header', name: 'x-crm-key' },
      token: CRM_TOKEN, allow: [{ method: 'GET', path: '/contacts' }] },
  ]);
  const calls = [];
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: clients, hostnameResolver: () => 'demo-site-demo-app-php84-1.agent_egress',
    env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', PROVIDER_ACCOUNTS_DIR: accounts, RELAY_REQUIRE_KNOWN_CLIENTS: '1' },
    externalRequest: async (provider, targetPath, method, headers) => {
      calls.push({ host: provider.host, targetPath, method, key: headers['x-crm-key'] });
      const upstream = Readable.from([Buffer.from('{}')]);
      upstream.statusCode = 200; upstream.headers = { 'content-type': 'application/json' };
      return upstream;
    },
  });
  try {
    if (!relay.server.listening) await once(relay.server, 'listening');
    const { port } = relay.server.address();
    expect(await send(port, 'POST', '/crm/contacts/')).toBe(200);
    expect(calls).toEqual([{ host: 'crm.test', targetPath: '/v2/contacts/', method: 'POST', key: CRM_TOKEN }]);
    // The grant's own rules still apply (a trailing slash is part of the rule), and routes without a grant stay refused.
    expect(await send(port, 'POST', '/crm/contacts')).toBe(403);
    expect(await send(port, 'DELETE', '/crm/contacts/')).toBe(403);
    expect(await send(port, 'GET', '/maps/geocode')).toBe(403);
    // A root rule needs the literal slash: the bare route name is a different path.
    expect(await send(port, 'GET', '/ping')).toBe(403);
    expect(calls).toHaveLength(1);
    expect(await send(port, 'GET', '/ping/')).toBe(200);
    expect(calls.pop()).toMatchObject({ host: 'ping.test', targetPath: '/', key: CRM_TOKEN });
    // Route names are looked up as registered entries only, never as inherited properties.
    expect(await send(port, 'GET', '/constructor/contacts')).toBe(200);
    expect(calls.pop()).toMatchObject({ host: 'ctor.test', targetPath: '/contacts', key: CRM_TOKEN });
    expect(await send(port, 'GET', '/constructor/other')).toBe(403);
    expect(await send(port, 'GET', '/toString/contacts')).toBe(403);
    expect(await send(port, 'GET', '/gitlab/api/v4/user')).toBe(403);
    expect(calls).toHaveLength(1);
  } finally {
    relay.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an allow rule may end in one slash, matched exactly; other empty segments are invalid', () => {
  const rule = path => ({ method: 'GET', path });
  for (const valid of ['/contacts/', '/', '/a/*/', '/contacts']) expect(validAllowRule(rule(valid))).toBe(true);
  for (const invalid of ['//', '/a//b', '/a//', '/contacts//', '']) expect(validAllowRule(rule(invalid))).toBe(false);
  expect(allowRuleMatches(rule('/contacts/'), 'GET', '/contacts/?x=1')).toBe(true);
  expect(allowRuleMatches(rule('/contacts/'), 'GET', '/contacts')).toBe(false);
  expect(allowRuleMatches(rule('/contacts'), 'GET', '/contacts/')).toBe(false);
  expect(allowRuleMatches(rule('/a/*/'), 'GET', '/a/7/')).toBe(true);
  expect(allowRuleMatches(rule('/a/*/'), 'GET', '/a//')).toBe(false);
  expect(allowRuleMatches(rule('/'), 'GET', '/')).toBe(true);
  expect(allowRuleMatches(rule('/'), 'GET', '/x')).toBe(false);
  expect(allowRuleMatches(rule('/'), 'GET', '')).toBe(false);
});
