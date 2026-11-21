import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { createDrainTracker } from './api-relay/api-relay.mjs';
import { connectRefused, getJson, partialRequest, sleep, spawnHarness, startStream } from './drain-test-helpers.mjs';

// Child harness: real startApiRelay with a fake slow-streaming upstream, wired
// to relay.drain() exactly like the entry guard.
const HARNESS = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-drain-'));
const services = {};
if (process.env.WS === '1') {
  // A service WebSocket whose upstream sends one more frame 800ms after the upgrade.
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    setTimeout(() => socket.end('late-frame'), 800);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  services.board = { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none', websocketPaths: ['/ws/'] };
}
fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({ providers: {}, services }));
const hang = process.env.HANG === '1';
const relay = startApiRelay({
  port: 0, host: '127.0.0.1', clientsDir: dir,
  env: { HTTP_PROXY: 'http://127.0.0.1:1', OPENROUTER_API_KEY: 'k', SNI_BRIDGE_PORT: '0', RELAY_DRAIN_TIMEOUT_MS: process.env.RELAY_DRAIN_TIMEOUT_MS },
  externalRequest: async () => {
    const up = new Readable({ read() {} });
    up.statusCode = 200; up.headers = { 'content-type': 'text/plain' };
    if (process.env.FIRST_QUICK === '1' && !globalThis.firstServed) {
      globalThis.firstServed = true;
      up.push('first;'); up.push(null);
      return up;
    }
    up.push('one;');
    if (!hang) setTimeout(() => { up.push('two;'); up.push(null); }, 1200);
    return up;
  },
});
if (!relay.server.listening) await once(relay.server, 'listening');
relay.server.on('connection', () => console.log('CONNECTION'));
process.on('SIGTERM', () => relay.drain());
console.log('READY ' + relay.server.address().port);
`;

// Wait until the child's server has accepted n connections (the harness logs each one).
const connections = h => (h.out.match(/^CONNECTION$/gm) ?? []).length;
async function acceptedConnections(h, n) {
  for (let i = 0; i < 200 && connections(h) < n; i++) await sleep(25);
  assert.equal(connections(h), n, 'connections accepted');
}
function openSocket(port) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', d => { received += d; });
  const closed = new Promise(r => socket.on('close', r));
  return { socket, closed, received: () => received };
}
const get = (path, extra = '') => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;

test('streaming request completes after SIGTERM and exit follows its end', async () => {
  const h = spawnHarness(HARNESS, {});
  const port = await h.ready();
  const { done } = await startStream(port, '/openrouter/stream');
  h.child.kill('SIGTERM');
  const t0 = Date.now();
  const body = await done;
  assert.equal(body, 'one;two;');
  const exit = await h.exited;
  assert.equal(exit.code, 0);
  assert.ok(h.exitedAt >= t0 + 800, 'exited before the stream ended');
  assert.match(h.out, /\[drain\] start inflight=1/);
  assert.match(h.out, /\[drain\] done/);
});

test('SIGTERM with nothing in flight exits within ~1s', async () => {
  const h = spawnHarness(HARNESS, {});
  await h.ready();
  const t0 = Date.now();
  h.child.kill('SIGTERM');
  const exit = await h.exited;
  assert.equal(exit.code, 0);
  assert.ok(h.exitedAt - t0 < 1000);
});

test('new connections are refused after SIGTERM and /_inflight reports draining', async () => {
  const h = spawnHarness(HARNESS, {});
  const port = await h.ready();
  const { done } = await startStream(port, '/openrouter/stream');
  const status = await partialRequest(port, '/_inflight');
  // A connection still in the kernel backlog when the listener closes is never served.
  await acceptedConnections(h, 2);
  h.child.kill('SIGTERM');
  await sleep(300);
  assert.equal(await connectRefused(port), true);
  const res = await status.finish();
  assert.match(res, /"inflight":1,"draining":true/);
  await done;
  assert.equal((await h.exited).code, 0);
});

test('/_inflight counts active requests and does not count itself', async () => {
  const h = spawnHarness(HARNESS, {});
  const port = await h.ready();
  assert.equal(JSON.parse((await getJson(port)).body).inflight, 0);
  const { done } = await startStream(port, '/openrouter/stream');
  const { codeHash, ...status } = JSON.parse((await getJson(port)).body);
  assert.deepEqual(status, { inflight: 1, draining: false });
  assert.match(codeHash, /^[0-9a-f]{64}$/);
  await done;
  await sleep(50);
  assert.equal(JSON.parse((await getJson(port)).body).inflight, 0);
  h.child.kill('SIGTERM');
  await h.exited;
});

test('/_inflight returns 403 from a non-loopback address', () => {
  const tracker = createDrainTracker();
  const run = remoteAddress => {
    const out = {};
    const res = { writeHead: s => { out.status = s; }, end: b => { out.body = b; } };
    const handled = tracker.handleStatus({ url: '/_inflight', socket: { remoteAddress } }, res);
    return { handled, ...out };
  };
  assert.equal(run('10.0.0.5').status, 403);
  assert.equal(run('172.18.0.3').handled, true);
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(run(ok).status, 200);
});

test('drain cap exits after RELAY_DRAIN_TIMEOUT_MS with a hung request', async () => {
  const h = spawnHarness(HARNESS, { HANG: '1', RELAY_DRAIN_TIMEOUT_MS: '400' });
  const port = await h.ready();
  await startStream(port, '/openrouter/stream');
  const t0 = Date.now();
  h.child.kill('SIGTERM');
  const exit = await h.exited;
  assert.equal(exit.code, 0);
  assert.ok(h.exitedAt - t0 >= 350 && h.exitedAt - t0 < 3000);
  assert.match(h.out, /\[drain\] timeout after 400ms, inflight=1/);
});


// These two run under Node, which production uses; Bun's http server closes sockets differently.
test('a drain with nothing in flight keeps an accepted connection that has not sent its request yet', async () => {
  const h = spawnHarness(HARNESS, {}, 'node');
  const port = await h.ready();
  const client = openSocket(port);
  await acceptedConnections(h, 1);
  h.child.kill('SIGTERM');
  await sleep(300);
  assert.equal(h.exit, null, 'worker exited while an accepted connection was waiting to send its request');
  client.socket.write(get('/_inflight', 'Connection: close\r\n'));
  await client.closed;
  assert.match(client.received(), /^HTTP\/1\.1 200[\s\S]*"draining":true/);
  assert.equal((await h.exited).code, 0);
});

test('a drain keeps accepted connections that have not sent a request, a pipelined response still streaming and an open WebSocket', async () => {
  const h = spawnHarness(HARNESS, { FIRST_QUICK: '1', WS: '1' }, 'node');
  const port = await h.ready();
  const waiting = openSocket(port);
  const pipelined = openSocket(port);
  const websocket = openSocket(port);
  await acceptedConnections(h, 3);
  websocket.socket.write(get('/board/ws/x', 'Connection: Upgrade\r\nUpgrade: websocket\r\n'));
  for (let i = 0; i < 200 && !websocket.received().startsWith('HTTP/1.1 101'); i++) await sleep(20);
  assert.match(websocket.received(), /^HTTP\/1\.1 101/);
  pipelined.socket.write(get('/openrouter/first') + get('/openrouter/second'));
  for (let i = 0; i < 200 && !pipelined.received().includes('one;'); i++) await sleep(20);
  assert.ok(pipelined.received().includes('first;') && pipelined.received().includes('one;'), pipelined.received());
  h.child.kill('SIGTERM');
  await sleep(100);
  waiting.socket.write(get('/_inflight', 'Connection: close\r\n'));
  await Promise.all([waiting.closed, pipelined.closed, websocket.closed]);
  assert.match(waiting.received(), /^HTTP\/1\.1 200[\s\S]*"draining":true/);
  assert.ok(pipelined.received().includes('two;'), `pipelined response truncated: ${JSON.stringify(pipelined.received())}`);
  assert.ok(websocket.received().includes('late-frame'), `WebSocket frame lost: ${JSON.stringify(websocket.received())}`);
  assert.equal((await h.exited).code, 0);
});

test('a request that arrives from an accepted connection during an idle drain still obeys RELAY_DRAIN_TIMEOUT_MS', async () => {
  const h = spawnHarness(HARNESS, { HANG: '1', RELAY_DRAIN_TIMEOUT_MS: '400' }, 'node');
  const port = await h.ready();
  const client = openSocket(port);
  await acceptedConnections(h, 1);
  h.child.kill('SIGTERM');
  await sleep(100);
  const t0 = Date.now();
  client.socket.write(get('/openrouter/stream'));
  const exit = await h.exited;
  assert.ok(client.received().includes('one;'), `request was not served: ${JSON.stringify(client.received())}`);
  assert.equal(exit.code, 0);
  assert.ok(h.exitedAt - t0 < 3000, `worker outlived the drain deadline by ${h.exitedAt - t0}ms`);
  assert.match(h.out, /\[drain\] timeout after 400ms, inflight=1/);
});
