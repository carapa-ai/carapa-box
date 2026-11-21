import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readCappedBody, startApiRelay } from './api-relay/api-relay.mjs';

const CAP = 1024;

/** POST to the relay. `declare` sends a Content-Length of that size and no body; otherwise the body is sent chunked. */
function post(port, requestPath, { body = '', declare } = {}) {
  return new Promise((resolve, reject) => {
    const headers = declare === undefined ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(declare) };
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method: 'POST', headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => { resolve({ status: response.statusCode, headers: response.headers, text }); request.destroy(); });
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('no response: the body was awaited instead of rejected')));
    if (declare !== undefined) request.flushHeaders();
    else request.write(body);
    if (declare === undefined) request.end();
  });
}

async function withRelay(config, extraEnv, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-body-cap-'));
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify(config));
  const seen = [];
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: root,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_MAX_REQUEST_BODY_BYTES: String(CAP), ...extraEnv },
    externalRequest: async (_provider, _target, _method, _headers, body) => {
      seen.push(body ? body.toString() : '');
      const response = new Readable({ read() { this.push(null); } });
      return Object.assign(response, { statusCode: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  if (!relay.server.listening) await once(relay.server, 'listening');
  try { await run({ port: relay.server.address().port, seen }); } finally {
    relay.server.closeAllConnections?.();
    relay.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectRejected(response) {
  expect(response.status).toBe(413);
  expect(response.headers.connection).toBe('close');
  expect(JSON.parse(response.text).error).toBe('request_too_large');
}

test('provider route: an over-cap body gets 413 and is never forwarded; a body under the cap is forwarded unchanged', async () => {
  await withRelay({ providers: {}, services: {} }, { OPENROUTER_API_KEY: 'test-key' }, async ({ port, seen }) => {
    expectRejected(await post(port, '/openrouter/v1/chat', { body: 'x'.repeat(CAP + 1) }));
    expectRejected(await post(port, '/openrouter/v1/chat', { declare: 100 * 1024 * 1024 }));
    expect(seen).toEqual([]);
    expect((await post(port, '/openrouter/v1/chat', { body: 'y'.repeat(CAP) })).status).toBe(200);
    expect(seen).toEqual(['y'.repeat(CAP)]);
  });
});

test('service route: an over-cap body gets 413 and never reaches the upstream; a body under the cap is forwarded unchanged', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { received.push(Buffer.concat(chunks).toString()); res.end('ok'); });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const services = { 'cloud-tts': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } };
  try {
    await withRelay({ providers: {}, services }, {}, async ({ port }) => {
      expectRejected(await post(port, '/cloud-tts/x', { body: 'x'.repeat(CAP + 1) }));
      expectRejected(await post(port, '/cloud-tts/x', { declare: 100 * 1024 * 1024 }));
      expect(received).toEqual([]);
      const ok = await post(port, '/cloud-tts/x', { body: 'y'.repeat(CAP) });
      expect(ok.status).toBe(200);
      expect(received).toEqual(['y'.repeat(CAP)]);
    });
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('readCappedBody rejects when the client aborted before the body was awaited', async () => {
  let handled;
  const done = new Promise(resolve => { handled = resolve; });
  const server = http.createServer(async (req, res) => {
    // Stand-in for the auth lookup that runs before the body read.
    await new Promise(resolve => setTimeout(resolve, 150));
    const outcome = await Promise.race([
      readCappedBody(req, res, CAP).then(() => 'settled', error => error.message),
      new Promise(resolve => setTimeout(() => resolve('hung'), 1000)),
    ]);
    handled(outcome);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
    request.on('error', () => {});
    request.write('partial');
    setTimeout(() => request.destroy(), 30);
    expect(await done).toMatch(/aborted/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
