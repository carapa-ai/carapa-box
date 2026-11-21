import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('internal SSE delivers headers before the upstream sends its first event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-sse-'));
  const script = `
    import http from 'node:http';
    import fs from 'node:fs';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    let upstreamResponse;
    const upstream = http.createServer((req, res) => {
      assert.equal(req.url, '/mcp/carapa-board');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session' });
      res.flushHeaders();
      upstreamResponse = res;
      // Wait for the downstream client to receive headers before emitting data.
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    fs.writeFileSync(root + '/client.json', JSON.stringify({
      match: ['approved-agent'], isolation: 'strict',
      services: { 'mcp-relay': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } },
    }));
    const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root,
      hostnameResolver: () => 'approved-agent',
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_REQUIRE_KNOWN_CLIENTS: '1' },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');
    try {
      await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: relay.server.address().port,
          path: '/mcp-relay/mcp/carapa-board', headers: { accept: 'text/event-stream' } }, response => {
          try {
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['mcp-session-id'], 'test-session');
            assert.equal(response.headers['content-type'], 'text/event-stream');
            upstreamResponse.end(': ready\\n\\n');
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => {
              try { assert.equal(body, ': ready\\n\\n'); resolve(); } catch (error) { reject(error); }
            });
          } catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.setTimeout(1500, () => request.destroy(new Error('SSE headers blocked until first body data')));
      });
    } finally {
      relay.server.closeAllConnections(); relay.close();
      upstream.closeAllConnections(); upstream.close();
    }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (await child.exited !== 0) throw new Error(stderr + stdout);
    expect(await child.exited).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('a revoked sandbox token returns the upstream 401 body at once instead of a hung, reset response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-revoked-'));
  const script = `
    import http from 'node:http';
    import fs from 'node:fs';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const errorBody = JSON.stringify({ error: 'token revoked' });
    const upstream = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errorBody) });
      res.end(errorBody);
    });
    // carapa-box hands out a token once, then reports it revoked.
    let tokenLookups = 0;
    const box = http.createServer((req, res) => {
      if (++tokenLookups === 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: 'sandbox-token' })); }
      else { res.writeHead(404); res.end('{}'); }
    });
    for (const server of [upstream, box]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    fs.writeFileSync(root + '/client.json', JSON.stringify({
      match: ['approved-agent'], isolation: 'strict',
      services: { 'mcp-relay': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'apikey' } },
    }));
    const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root,
      hostnameResolver: () => 'approved-agent',
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_REQUIRE_KNOWN_CLIENTS: '1',
        CARAPA_BOX_URL: 'http://127.0.0.1:' + box.address().port, CARAPA_BOX_ADMIN_TOKEN: 'admin' },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch('http://127.0.0.1:' + relay.server.address().port + '/mcp-relay/mcp', { method: 'POST', body: '{}', signal: controller.signal });
      assert.equal(response.status, 401);
      assert.equal(await response.text(), errorBody);
      clearTimeout(timer);
    } finally {
      relay.server.closeAllConnections(); relay.close();
      upstream.closeAllConnections(); upstream.close();
      box.closeAllConnections(); box.close();
    }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (await child.exited !== 0) throw new Error(stderr + stdout);
    expect(await child.exited).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('Board fallback requests share one rate-limit bucket whatever the first path segment is', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-fallback-rl-'));
  const script = `
    import http from 'node:http';
    import fs from 'node:fs';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    fs.writeFileSync(root + '/client.json', JSON.stringify({
      match: ['approved-agent'],
      services: { 'mcp-relay': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } },
    }));
    const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root,
      hostnameResolver: () => 'approved-agent',
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_REQUIRE_KNOWN_CLIENTS: '1', RATE_LIMIT_PER_CLIENT: '2' },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');
    try {
      const port = relay.server.address().port;
      const statuses = [];
      for (const segment of ['aaa', 'bbb', 'ccc', 'ddd']) {
        statuses.push((await fetch('http://127.0.0.1:' + port + '/' + segment + '/mcp')).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429]);
    } finally {
      relay.server.closeAllConnections(); relay.close();
      upstream.closeAllConnections(); upstream.close();
    }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (await child.exited !== 0) throw new Error(stderr + stdout);
    expect(await child.exited).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
