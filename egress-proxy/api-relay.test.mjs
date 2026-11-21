import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createRequestPacer, parseRetryAfterMs, scrubString, startApiRelay, summarizeAnthropicCost } from './api-relay/api-relay.mjs';

test('Retry-After parses seconds and HTTP-dates, clamping invalid timing', () => {
  const now = Date.parse('Mon, 12 Oct 2026 12:00:00 GMT');
  expect(parseRetryAfterMs({ 'retry-after': '12' }, now)).toBe(12_000);
  expect(parseRetryAfterMs({ 'retry-after': 'Mon, 12 Oct 2026 12:00:05 GMT' }, now)).toBe(5_000);
  expect(parseRetryAfterMs({ 'retry-after': 'Mon, 12 Oct 2026 11:59:55 GMT' }, now)).toBe(0);
  expect(parseRetryAfterMs({ 'retry-after': 'not-a-date' }, now)).toBe(0);
});

test('request pacer spaces a provider and never holds other providers or unlimited routes', () => {
  let now = 1_000;
  const reserve = createRequestPacer(() => now);
  expect([reserve('p', 2), reserve('p', 2), reserve('p', 2)]).toEqual([0, 500, 1000]);
  expect(reserve('other', 2)).toBe(0);
  expect(reserve('unlimited', undefined)).toBe(0);
  now += 5_000;
  expect(reserve('p', 2)).toBe(0);
});

test('request pacer moves later waiters up when an earlier one releases its slot', () => {
  let now = 1_000;
  const pacer = createRequestPacer(() => now);
  const first = pacer.reserve('p', 1);
  const second = pacer.reserve('p', 1);
  const third = pacer.reserve('p', 1);
  let moved = 0;
  third.onMove(() => { moved += 1; });
  expect([first.waitMs(), second.waitMs(), third.waitMs()]).toEqual([0, 1000, 2000]);
  second.release();
  second.release();
  expect(third.waitMs()).toBe(1000);
  expect(moved).toBe(1);
  expect(pacer('p', 1)).toBe(2000);
  now += 1_500;
  third.release(); // its slot has already come up: nothing to give back
  expect(pacer('p', 1)).toBe(1500);
});

test('a disconnected client destroys the streaming upstream response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-stream-test-'));
  let upstream;
  let upstreamClosedResolve;
  let relay;
  try {
    fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: {}, services: {} }));
    relay = startApiRelay({
      port: 0,
      host: '127.0.0.1',
      clientsDir: root,
      env: { HTTP_PROXY: 'http://127.0.0.1:1', OPENROUTER_API_KEY: 'test-key', SNI_BRIDGE_PORT: '0' },
      externalRequest: async () => {
        upstream = new Readable({ read() {} });
        upstream.statusCode = 200;
        upstream.headers = { 'content-type': 'text/plain' };
        upstream.once('close', upstreamClosedResolve);
        upstream.push('partial response');
        return upstream;
      },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');

    const upstreamClosed = new Promise(resolve => { upstreamClosedResolve = resolve; });
    await new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: relay.server.address().port, path: '/openrouter/stream' }, response => {
        response.once('data', () => request.destroy());
        response.once('close', resolve);
        response.once('error', error => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
      });
      request.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('upstream was not destroyed')), 1000);
      upstreamClosed.then(() => { clearTimeout(timeout); resolve(); }, reject);
    });
    expect(upstream.destroyed).toBe(true);
  } finally {
    relay?.server.closeAllConnections?.();
    relay?.close();
    upstream?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const eq = (s) => s.replaceAll('<EQ>', '=');

const UNCHANGED = [
  'const authToken <EQ> req.headers.authorization;',
  "if (config.auth <EQ><EQ><EQ> 'apikey')",
  'const secretName <EQ> envName.toLowerCase();',
  'const SECRET_PATTERNS <EQ> [',
  'export const AUTH_HEADERS <EQ> $FOO',
];

const REDACTED_CASES = [
  ['API_KEY<EQ>abc123', 'API_KEY<EQ>[REDACTED]'],
  ['export X_TOKEN<EQ>abc', 'export X_TOKEN<EQ>[REDACTED]'],
  ['- DB_PASSWORD<EQ>abc', '- DB_PASSWORD<EQ>[REDACTED]'],
  ['12→API_KEY<EQ>abc', '12→API_KEY<EQ>[REDACTED]'],
  ['GET /x?access_token<EQ>x&y<EQ>1', 'GET /x?access_token<EQ>[REDACTED]&y<EQ>1'],
  ['cmd --password<EQ>x "q"', 'cmd --password<EQ>[REDACTED] "q"'],
];

const TOKEN_FORMATS = [
  'sk-abcdefghijklmnopqrstuvwx',
  'sk-ant-abcdefghijklmnopqrstuvwx',
  'ghp_' + 'a'.repeat(36),
  'AKIA' + 'A'.repeat(16),
  'glpat-abcdefghijklmnopqrstuvwx',
  'npm_' + 'a'.repeat(36),
  'xoxb-123-abc',
  'postgres://u:p@host/db',
];

test('scrubString leaves ordinary code assignments unchanged', () => {
  for (const input of UNCHANGED) {
    const text = eq(input);
    expect(scrubString(text)).toEqual({ text, count: 0 });
  }
});

test('scrubString redacts env, export, compose, query and CLI secrets', () => {
  for (const [input, expected] of REDACTED_CASES) {
    expect(scrubString(eq(input)).text).toBe(eq(expected));
  }
});

test('scrubString runs in linear time on long name runs before "="', () => {
  const N = 100_000;
  const shapes = {
    env: 'A'.repeat(N) + '=x',
    envKeyword: 'TOKEN'.repeat(N / 5) + '=x',
    cliQuery: '?' + 'a'.repeat(N) + '=x',
    keywordNoQuery: 'token'.repeat(N / 5) + '=x',
    dashes: 'a--'.repeat(N / 3) + '=x',
    // Keyword-dense runs ending in '=' with no value: the base rescanned the run per keyword (B-160).
    cliQueryKeywords: '?' + 'auth'.repeat(80_000) + '=',
    cliFlagKeywords: '--' + 'auth'.repeat(80_000) + '=',
    cliQueryDashKeywords: '?' + 'auth-'.repeat(80_000) + '=',
    cliFlagDashKeywords: '--' + 'token--'.repeat(80_000) + '=',
  };
  for (const [name, input] of Object.entries(shapes)) {
    const started = performance.now();
    scrubString(input);
    expect({ name, fast: performance.now() - started < 500 }).toEqual({ name, fast: true });
  }
  // The forward match must not swallow a nested secret behind a non-secret name.
  expect(scrubString(eq('FOO<EQ>BAR_TOKEN<EQ>abc')).text).toBe(eq('FOO<EQ>BAR_TOKEN<EQ>[REDACTED]'));
});

test('scrubString still redacts token-format patterns', () => {
  for (const token of TOKEN_FORMATS) {
    const { text, count } = scrubString(`x ${token} y`);
    expect(text).toBe('x [REDACTED] y');
    expect(count).toBe(1);
  }
});

async function runThrottleDisconnect(responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-throttle-test-'));
  const calls = [];
  const made = [];
  let relay;
  try {
    fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: {}, services: {} }));
    relay = startApiRelay({
      port: 0,
      host: '127.0.0.1',
      clientsDir: root,
      env: { HTTP_PROXY: 'http://127.0.0.1:1', OPENROUTER_API_KEY: 'test-key', SNI_BRIDGE_PORT: '0', OVERLOAD_RETRY_DELAY_MS: '1' },
      externalRequest: async () => {
        calls.push(Date.now());
        const upstream = new Readable({ read() {} });
        const [statusCode, headers] = responses(calls.length);
        upstream.statusCode = statusCode;
        upstream.headers = headers;
        made.push(upstream);
        return upstream;
      },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');
    const request = http.get({ hostname: '127.0.0.1', port: relay.server.address().port, path: '/openrouter/x' });
    request.on('error', () => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    request.destroy();
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { calls, made };
  } finally {
    relay?.server.closeAllConnections?.();
    relay?.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('client abort during throttle backoff stops further upstream calls', async () => {
  const { calls } = await runThrottleDisconnect(() => [429, { 'retry-after': '1' }]);
  expect(calls.length).toBe(1);
});

test('client abort during backoff never leaves a recovered stream open', async () => {
  const { calls, made } = await runThrottleDisconnect(n => n === 1 ? [429, { 'retry-after': '1' }] : [200, { 'content-type': 'text/event-stream' }]);
  expect(calls.length).toBeLessThanOrEqual(2);
  if (made[1]) expect(made[1].destroyed).toBe(true);
});

async function startPathRelay(root) {
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: {}, services: {} }));
  const calls = [];
  const relay = startApiRelay({
    port: 0,
    host: '127.0.0.1',
    clientsDir: root,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', OPENROUTER_API_KEY: 'test-key', SNI_BRIDGE_PORT: '0' },
    externalRequest: async (provider, targetPath, method, headers) => {
      calls.push({ host: provider.host, targetPath, authorization: headers.authorization });
      const upstream = new Readable({ read() { this.push(null); } });
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'text/plain' };
      return upstream;
    },
  });
  if (!relay.server.listening) await once(relay.server, 'listening');
  return { relay, calls, port: relay.server.address().port };
}

function postBody(port, requestPath, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method: 'POST', headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('relay scrubs text and JSON bodies but forwards binary, compressed and non-UTF-8 bodies byte-identical', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-scrub-body-test-'));
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: {}, services: {} }));
  const forwarded = [];
  const relay = startApiRelay({
    port: 0,
    host: '127.0.0.1',
    clientsDir: root,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', OPENROUTER_API_KEY: 'test-key', SNI_BRIDGE_PORT: '0' },
    externalRequest: async (provider, targetPath, method, headers, body) => {
      forwarded.push(body);
      const upstream = new Readable({ read() { this.push(null); } });
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'text/plain' };
      return upstream;
    },
  });
  try {
    if (!relay.server.listening) await once(relay.server, 'listening');
    const port = relay.server.address().port;
    const secret = 'cat .env -> DB_PASSWORD=hunter2';
    // Connect envelope (flags + big-endian length) around a protobuf-like message with a varint field.
    const message = Buffer.concat([Buffer.from([0x0a, secret.length]), Buffer.from(secret), Buffer.from([0x10, 0xff, 0xfe, 0x80, 0x01])]);
    const envelope = Buffer.alloc(5);
    envelope.writeUInt32BE(message.length, 1);
    const connect = Buffer.concat([envelope, message]);

    for (const [headers, body] of [
      [{ 'content-type': 'application/connect+proto' }, connect],
      [{ 'content-type': 'application/proto' }, connect],
      [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, connect],
      [{ 'content-type': 'application/json' }, connect],
    ]) {
      expect(await postBody(port, '/openrouter/x', headers, body)).toBe(200);
      expect(forwarded.pop().equals(body)).toBe(true);
    }

    const json = JSON.stringify({ prompt: secret });
    expect(await postBody(port, '/openrouter/x', { 'content-type': 'application/json; charset=utf-8' }, json)).toBe(200);
    expect(forwarded.pop().toString('utf8')).toBe(JSON.stringify({ prompt: 'cat .env -> DB_PASSWORD=[REDACTED]' }));
  } finally {
    relay.server.closeAllConnections?.();
    relay.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function getStatus(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

test('provider path prefix cannot be escaped with dot segments, encoded separators or backslashes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-path-test-'));
  let started;
  try {
    started = await startPathRelay(root);
    const { calls, port } = started;
    for (const bad of [
      '/openrouter/../v1/x',
      '/openrouter/./v1/x',
      '/openrouter/%2e%2e/v1/x',
      '/openrouter/%2E%2E%2Fv1/x',
      '/openrouter/v1%2fx',
      '/openrouter/%252e%252e/v1/x',
      '/openrouter/v1%5cx',
      '/openrouter/v1\\x',
      '/openrouter/v1%00x',
      '/openrouter/v1/..?q=1',
    ]) {
      expect([bad, await getStatus(port, bad)]).toEqual([bad, 400]);
    }
    expect(calls).toEqual([]);

    expect(await getStatus(port, '/openrouter/v1/chat/completions?next=../a')).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].targetPath).toEndWith('/v1/chat/completions?next=../a');
    expect(calls[0].authorization).toBeTruthy();
  } finally {
    started?.relay.server.closeAllConnections?.();
    started?.relay.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebSocket upgrades get the same provider path boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-path-ws-test-'));
  let started;
  try {
    started = await startPathRelay(root);
    const socket = net.connect(started.port, '127.0.0.1');
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.write('GET /openrouter/%2e%2e/v1/x HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await once(socket, 'close');
    expect(response.startsWith('HTTP/1.1 400')).toBe(true);
    expect(started.calls).toEqual([]);
  } finally {
    started?.relay.server.closeAllConnections?.();
    started?.relay.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function clientHello(serverName) {
  const name = Buffer.from(serverName, 'ascii');
  const serverNameExt = Buffer.concat([Buffer.from([0x00, 0x00]), u16(name.length + 5), u16(name.length + 3), Buffer.from([0x00]), u16(name.length), name]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00]),
    u16(2), Buffer.from([0x13, 0x01]), Buffer.from([0x01, 0x00]),
    u16(serverNameExt.length), serverNameExt,
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01, 0x00]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}
function u16(n) { return Buffer.from([n >> 8, n & 0xff]); }

const SNI_CHILD = `
import net from 'node:net';
import http from 'node:http';
const [relayPath, root, sniPort, proxyPort, confPath, ...helloHexes] = process.argv.slice(2);
const { startApiRelay } = await import(relayPath);
const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root,
  env: { HTTP_PROXY: 'http://127.0.0.1:' + proxyPort, SNI_BRIDGE_PORT: sniPort, RELAY_SQUID_CONF: confPath } });
await new Promise(resolve => relay.server.listening ? resolve() : relay.server.once('listening', resolve));
const send = hex => new Promise(resolve => {
  const socket = net.connect(Number(sniPort), '127.0.0.1', () => socket.write(Buffer.from(hex, 'hex')));
  socket.on('error', () => {});
  socket.on('close', resolve);
});
for (const [index, hex] of helloHexes.entries()) {
  await send(hex);
  console.log('CLOSED ' + index);
}
await new Promise(resolve => setTimeout(resolve, 1500));
const status = await new Promise(resolve => http.get({ hostname: '127.0.0.1', port: relay.server.address().port, path: '/nope/x' },
  response => { response.resume(); resolve(response.statusCode); }).on('error', () => resolve(0)));
console.log('ALIVE ' + status);
process.exit(0);
`;

// Runs the relay's SNI bridge in a child process against a stub squid that
// records CONNECT request lines. `conf` is the squid-generated.conf text, or
// null for a path that does not exist.
async function runSniBridge(conf, serverNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-sni-test-'));
  const connects = [];
  const proxy = net.createServer(socket => {
    socket.once('data', data => {
      connects.push(data.toString('latin1').split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  let child;
  try {
    fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: {}, services: {} }));
    fs.writeFileSync(path.join(root, 'sni-child.mjs'), SNI_CHILD);
    const confPath = path.join(root, 'squid-generated.conf');
    if (conf !== null) fs.writeFileSync(confPath, conf);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const free = net.createServer();
    free.listen(0, '127.0.0.1');
    await once(free, 'listening');
    const sniPort = free.address().port;
    await new Promise(resolve => free.close(resolve));

    const relayPath = fileURLToPath(new URL('./api-relay/api-relay.mjs', import.meta.url));
    child = spawn(process.execPath, [path.join(root, 'sni-child.mjs'), relayPath, root, String(sniPort), String(proxy.address().port), confPath,
      ...serverNames.map(name => clientHello(name).toString('hex'))], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr, connects };
  } finally {
    child?.kill();
    proxy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('an SNI with a space is dropped without crashing the relay; a valid SNI still reaches the CONNECT', async () => {
  const { code, stdout, stderr, connects } = await runSniBridge('', ['a b.googleapis.com', 'ok.googleapis.com']);

  expect(stderr).not.toContain('ERR_UNESCAPED_CHARACTERS');
  expect(code).toBe(0);
  expect(stdout).toContain('CLOSED 0');
  expect(stdout).toContain('ALIVE 404');
  expect(connects).toEqual(['CONNECT ok.googleapis.com:443 HTTP/1.1']);
});

test('the SNI bridge refuses relay_domains hosts (exact and leading-dot) and still tunnels other allowed hosts', async () => {
  const conf = [
    'acl relay_src src 172.20.0.5',
    'acl relay_allowed dstdomain -n accounts.google.com',
    'acl relay_allowed dstdomain -n .MCP.googleapis.com',
    'http_access allow CONNECT relay_src relay_allowed !private_dst',
    '',
  ].join('\n');
  const { stdout, stderr, connects } = await runSniBridge(conf,
    ['accounts.google.com', 'x.mcp.googleapis.com', 'mcp.googleapis.com', 'ok.googleapis.com']);

  expect(stdout).toContain('CLOSED 3');
  expect(connects).toEqual(['CONNECT ok.googleapis.com:443 HTTP/1.1']);
  expect(stderr).toContain('[sni-bridge] reject SNI=accounts.google.com (relay-only host)');
  expect(stderr).toContain('[sni-bridge] reject SNI=x.mcp.googleapis.com (relay-only host)');
});

test('the SNI bridge refuses relay_private_hosts names like relay_domains', async () => {
  const conf = [
    'acl relay_src src 172.20.0.5',
    'acl relay_private_host_0 dstdomain -n gl.googleapis.com',
    'acl relay_private_dst_0 dst 10.44.0.1/32',
    'http_access allow CONNECT SSL_ports relay_src relay_private_host_0 relay_private_dst_0',
    'http_access deny relay_private_host_0',
    '',
  ].join('\n');
  const { stdout, stderr, connects } = await runSniBridge(conf, ['gl.googleapis.com', 'ok.googleapis.com']);

  expect(stdout).toContain('CLOSED 1');
  expect(connects).toEqual(['CONNECT ok.googleapis.com:443 HTTP/1.1']);
  expect(stderr).toContain('[sni-bridge] reject SNI=gl.googleapis.com (relay-only host)');
});

test('the SNI bridge refuses every tunnel when the generated squid config is unreadable', async () => {
  const { stdout, stderr, connects } = await runSniBridge(null, ['ok.googleapis.com']);

  expect(stdout).toContain('CLOSED 0');
  expect(connects).toEqual([]);
  expect(stderr).toContain('ENOENT');
});

test('/anthropic-api spends the API key while /anthropic keeps the subscription OAuth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-anthropic-api-test-'));
  fs.mkdirSync(path.join(root, 'credentials'));
  const credentialFile = path.join(root, 'credentials', 'claude.json');
  fs.writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-access', refreshToken: 'oauth-refresh', expiresAt: Date.now() + 86_400_000 } }));
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: { anthropic: { auth: 'oauth', credentialFile } }, services: {} }));
  const calls = [];
  const relay = startApiRelay({
    port: 0,
    host: '127.0.0.1',
    clientsDir: root,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'relay-api-key', SECRETS_DIR: root, SNI_BRIDGE_PORT: '0' },
    oauthRequest: async () => { throw new Error('unexpected OAuth refresh'); },
    externalRequest: async (provider, targetPath, method, headers) => {
      calls.push({ host: provider.host, targetPath, headers });
      const upstream = new Readable({ read() { this.push(null); } });
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'application/json' };
      return upstream;
    },
  });
  try {
    if (!relay.server.listening) await once(relay.server, 'listening');
    const post = route => new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: relay.server.address().port, method: 'POST', path: route,
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-dummy-routed-via-relay', authorization: 'Bearer sandbox' } }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.end('{}');
    });

    expect(await post('/anthropic-api/v1/messages')).toBe(200);
    expect(await post('/anthropic/v1/messages')).toBe(200);
    const [api, subscription] = calls;
    expect([api.host, api.targetPath]).toEqual(['api.anthropic.com', '/v1/messages']);
    expect(api.headers['x-api-key']).toBe('relay-api-key');
    expect(api.headers.authorization).toBeUndefined();
    expect(api.headers['anthropic-beta']).toBeUndefined();
    expect(subscription.headers.authorization).toBe('Bearer oauth-access');
    expect(subscription.headers['x-api-key']).toBeUndefined();

    // The unscoped key is also an Admin API credential; sandboxes never reach it.
    for (const route of ['/anthropic-api/v1/organizations/api_keys', '/anthropic-api//v1/Organizations', '/anthropic-api/v1/%6frganizations/me', '/anthropic/v1/organizations/workspaces?limit=1']) {
      expect([route, await post(route)]).toEqual([route, 403]);
    }
    expect(calls.length).toBe(2);
  } finally {
    relay.server.closeAllConnections?.();
    relay.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Anthropic API spend sums cent amounts across pages, per model and in total', () => {
  const day = results => ({ starting_at: '2026-10-01T00:00:00Z', results });
  expect(summarizeAnthropicCost([
    { data: [day([{ amount: '150.5', model: 'claude-opus-5-5' }, { amount: '20', model: null, description: 'Web Search Usage' }])], has_more: true },
    { data: [day([{ amount: '49.5', model: 'claude-opus-5-5' }, { amount: 'n/a', model: 'claude-haiku-5-5' }]), day([])] },
  ])).toEqual({ spent: 2.2, models: { 'claude-opus-5-5': 2, 'Web Search Usage': 0.2 } });
});

