import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { transformBody } from './llama-proxy.mjs';
import { getJson, spawnHarness } from './drain-test-helpers.mjs';

// MAX_BODY_BYTES / TRANSFORM_MAX_BYTES are read at module load, so every
// scenario runs the real startProxy() in a child process (bound to 127.0.0.1 so
// the stub upstream can use 127.0.0.2 on the same port number). With BOOM set,
// JSON.stringify throws for a body carrying a `__boom` key: a forced failure
// inside the transform step.
const HARNESS = String.raw`
import http from 'node:http';
const origListen = http.Server.prototype.listen;
// READY follows a successful listen; a port another process holds exits instead,
// so setup() can pick a new one rather than talk to that process.
http.Server.prototype.listen = function (port, cb) {
  this.once('listening', () => console.log('READY ' + this.address().port));
  this.once('error', e => { console.log('LISTEN_FAILED ' + e.code); process.exit(1); });
  return origListen.call(this, port, '127.0.0.1', cb);
};
if (process.env.BOOM) {
  const stringify = JSON.stringify;
  JSON.stringify = (v, ...rest) => {
    if (v && typeof v === 'object' && '__boom' in v) throw new Error('boom');
    return stringify(v, ...rest);
  };
}
const { startProxy } = await import(${JSON.stringify(new URL('./llama-proxy.mjs', import.meta.url).href)});
startProxy();
`;

// The proxy must listen on 127.0.0.1 on the stub's port number, and another test
// or process can hold that port on 127.0.0.1 even though 127.0.0.2 gave it to us.
async function setup(extraEnv = {}) {
  for (let attempt = 1; ; attempt++) {
    const received = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"stub":true}');
      });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.2', r));
    const h = spawnHarness(HARNESS, {
      PORTS: String(upstream.address().port), UPSTREAM_HOST: '127.0.0.2',
      // Keep the proxy->stub hop off any ambient HTTP(S)_PROXY.
      NO_PROXY: '*', no_proxy: '*',
      TOOL_PROFILES_PATH: '/nonexistent/tool_profiles.jsonc',
      // Never inherit debug capture: it would write request bodies into CAPTURE_DIR.
      LLAMA_DEBUG: '', LOG_REQUESTS: '', BOOM: '',
      // Pin every limit to the proxy default so an ambient setting cannot change a
      // scenario; each scenario's own overrides come last.
      MAX_BODY_BYTES: String(32 * 1024 * 1024), TRANSFORM_MAX_BYTES: String(8 * 1024 * 1024),
      MAX_BUFFERED_BODY_BYTES: String(48 * 1024 * 1024),
      LOADING_RETRY_ATTEMPTS: '10', LOADING_RETRY_DELAY_MS: '5000',
      ...extraEnv,
    });
    h.upstream = upstream;
    h.received = received;
    try {
      h.port = await h.ready();
      return h;
    } catch (err) {
      await finish(h);
      if (attempt >= 5 || !err.message.startsWith('child exited early')) throw err;
    }
  }
}

const finish = async h => {
  h.child.kill('SIGKILL');
  await h.exited;
  h.upstream.closeAllConnections();
  h.upstream.close();
};

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false,
      // The proxy forwards Host as-is; Node rejects one that differs from the upstream authority.
      headers: { host: `127.0.0.2:${port}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('no response within 10s')));
    req.on('error', reject);
    req.end(body);
  });
}

const inflight = async h => JSON.parse((await getJson(h.port)).body).inflight;

test('transformBody passes null, arrays and primitives through', () => {
  for (const raw of ['null', '[]', '1']) {
    const input = Buffer.from(raw);
    const result = transformBody(input, '/v1/messages');
    assert.equal(result.outBuf, input, raw);
    assert.deepEqual(result.applied, [], raw);
    assert.equal(result.reject, null, raw);
  }
});

test('POST /v1/messages with a null body is forwarded and the proxy survives', async () => {
  const h = await setup();
  try {
    const res = await post(h.port, '/v1/messages', 'null');
    assert.equal(res.status, 200);
    assert.equal(h.received.length, 1);
    assert.equal(h.received[0].body.toString(), 'null');
    assert.equal(h.exit, null, 'proxy process exited');
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('MAX_BODY_BYTES: oversized body gets 413 and never reaches the upstream', async () => {
  const h = await setup({ MAX_BODY_BYTES: '1024' });
  try {
    const big = await post(h.port, '/v1/chat/completions', 'x'.repeat(2048));
    assert.equal(big.status, 413);
    assert.equal(big.headers.connection, 'close');
    assert.equal(JSON.parse(big.body).error.type, 'request_too_large');
    assert.equal(h.received.length, 0);
    assert.match(h.out, /:\d+ 413 \d+ > 1024 \/v1\/chat\/completions/);

    const small = await post(h.port, '/v1/chat/completions', 'y'.repeat(512));
    assert.equal(small.status, 200);
    assert.equal(h.received.length, 1);
    assert.equal(h.received[0].body.length, 512);
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('MAX_BODY_BYTES=0 forwards the payload that a finite cap rejects', async () => {
  const payload = Buffer.alloc(4096, 'z');
  const capped = await setup({ MAX_BODY_BYTES: '1024' });
  try {
    assert.equal((await post(capped.port, '/v1/chat/completions', payload)).status, 413);
    assert.equal(capped.received.length, 0);
  } finally { await finish(capped); }

  const uncapped = await setup({ MAX_BODY_BYTES: '0' });
  try {
    assert.equal((await post(uncapped.port, '/v1/chat/completions', payload)).status, 200);
    assert.equal(uncapped.received.length, 1);
    assert.deepEqual(uncapped.received[0].body, payload);
  } finally { await finish(uncapped); }
});

test('TRANSFORM_MAX_BYTES: bodies above it are forwarded byte-identical', async () => {
  const h = await setup({ TRANSFORM_MAX_BYTES: '512' });
  try {
    const mk = pad => JSON.stringify({
      model: 'qwen3.8',
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=1' }, { type: 'text', text: 'keep' }],
      messages: [{ role: 'user', content: pad }],
    });
    const small = mk('hi');
    const large = mk('p'.repeat(1024));
    assert.ok(Buffer.byteLength(small) < 512 && Buffer.byteLength(large) > 512);

    assert.equal((await post(h.port, '/v1/messages', small)).status, 200);
    assert.equal((await post(h.port, '/v1/messages', large)).status, 200);
    assert.notEqual(h.received[0].body.toString(), small, 'small body should still be transformed');
    assert.equal(h.received[1].body.toString(), large);
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('an exception in the transform forwards the original body', async () => {
  const h = await setup({ BOOM: '1' });
  try {
    const body = JSON.stringify({
      __boom: true,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=1' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await post(h.port, '/v1/messages', body);
    assert.equal(res.status, 200);
    assert.equal(h.received.length, 1);
    assert.equal(h.received[0].body.toString(), body);
    assert.match(h.out, /transform-error passthrough: boom/);
    assert.ok(!h.out.includes('__boom'), 'body must not be logged');
    assert.equal(h.exit, null);
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('invalid LOADING_RETRY_ATTEMPTS falls back to the default and the request is answered', async () => {
  for (const value of ['abc', '-1']) {
    const h = await setup({ LOADING_RETRY_ATTEMPTS: value });
    try {
      const res = await post(h.port, '/v1/chat/completions', '{"model":"x"}');
      assert.equal(res.status, 200, value);
      assert.equal(h.received.length, 1, value);
    } finally { await finish(h); }
  }
});

test('MAX_BUFFERED_BODY_BYTES: bodies over the remaining budget get 503 and the budget returns on abort', async () => {
  const h = await setup({ MAX_BUFFERED_BODY_BYTES: '1024' });
  try {
    // Declared size alone exceeds the whole budget.
    const big = await post(h.port, '/v1/chat/completions', 'x'.repeat(2048));
    assert.equal(big.status, 503);
    assert.equal(big.headers.connection, 'close');
    assert.equal(JSON.parse(big.body).error.type, 'overloaded_error');
    assert.equal(h.received.length, 0);

    // Streamed (no Content-Length) body that crosses the budget mid-stream.
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/v1/chat/completions', method: 'POST', agent: false,
        headers: { host: `127.0.0.2:${h.port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write('a'.repeat(700));
      setTimeout(() => { req.write('b'.repeat(700)); req.end(); }, 50);
    });
    assert.equal(chunked, 503);
    assert.equal(h.received.length, 0);

    // A stalled request holds 600 of the 1024 bytes: a 600-byte body no longer fits.
    const stalled = http.request({ host: '127.0.0.1', port: h.port, path: '/v1/chat/completions', method: 'POST', agent: false,
      headers: { host: `127.0.0.2:${h.port}`, 'content-length': '800' } });
    stalled.on('error', () => {});
    stalled.write('s'.repeat(600));
    await new Promise(r => setTimeout(r, 200));
    const blocked = await post(h.port, '/v1/chat/completions', 'y'.repeat(600));
    assert.equal(blocked.status, 503);
    assert.equal(h.received.length, 0);
    // A body within the remaining budget is still forwarded.
    assert.equal((await post(h.port, '/v1/chat/completions', 'z'.repeat(300))).status, 200);
    assert.equal(h.received.length, 1);

    // Aborting the stalled request returns its 600 bytes.
    stalled.destroy();
    let status = 0;
    for (let i = 0; i < 50 && status !== 200; i++) {
      status = (await post(h.port, '/v1/chat/completions', 'y'.repeat(600))).status;
      if (status !== 200) await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status, 200);
    assert.equal(h.received.length, 2);
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('a declared body over MAX_BODY_BYTES gets 413 even when it also exceeds the budget', async () => {
  const h = await setup({ MAX_BODY_BYTES: '1000', MAX_BUFFERED_BODY_BYTES: '1500' });
  try {
    const tooBig = await post(h.port, '/v1/chat/completions', 'x'.repeat(2000));
    assert.equal(tooBig.status, 413);
    assert.equal(JSON.parse(tooBig.body).error.type, 'request_too_large');
    assert.match(h.out, /:\d+ 413 2000 > 1000 \/v1\/chat\/completions/);

    // Under the body cap but over the budget left by a stalled request: still a retryable 503.
    const stalled = http.request({ host: '127.0.0.1', port: h.port, path: '/v1/chat/completions', method: 'POST', agent: false,
      headers: { host: `127.0.0.2:${h.port}`, 'content-length': '1000' } });
    stalled.on('error', () => {});
    stalled.write('s'.repeat(900));
    await new Promise(r => setTimeout(r, 200));
    const blocked = await post(h.port, '/v1/chat/completions', 'y'.repeat(800));
    assert.equal(blocked.status, 503);
    assert.equal(JSON.parse(blocked.body).error.type, 'overloaded_error');
    assert.equal(h.received.length, 0);
    stalled.destroy();
  } finally { await finish(h); }
});

test('MAX_BUFFERED_BODY_BYTES counts the re-serialized copy of a transformed request', async () => {
  const body = JSON.stringify({
    model: 'qwen3.8',
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=1' }, { type: 'text', text: 'keep' }],
    messages: [{ role: 'user', content: 'p'.repeat(1000) }],
  });
  const size = Buffer.byteLength(body);
  // Fits the received body, but not the received body plus the transformed copy.
  const h = await setup({ MAX_BUFFERED_BODY_BYTES: String(size + 100) });
  try {
    const transformed = await post(h.port, '/v1/messages', body);
    assert.equal(transformed.status, 503);
    assert.equal(JSON.parse(transformed.body).error.type, 'overloaded_error');
    assert.equal(h.received.length, 0);
    assert.match(h.out, /exhausted by transformed body/);

    // An untransformed body of the same size creates no second copy.
    const plain = await post(h.port, '/v1/messages', 'q'.repeat(size));
    assert.equal(plain.status, 200);
    assert.equal(h.received.length, 1);
    assert.equal(await inflight(h), 0);
  } finally { await finish(h); }
});

test('the transformed copy is charged before a local 404 for a cloud model', async () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4',
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=1' }, { type: 'text', text: 'keep' }],
    messages: [{ role: 'user', content: 'p'.repeat(1000) }],
  });
  const h = await setup({ MAX_BUFFERED_BODY_BYTES: String(Buffer.byteLength(body) + 100) });
  try {
    const res = await post(h.port, '/v1/messages', body);
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.body).error.type, 'overloaded_error');
    assert.equal(h.received.length, 0);
  } finally { await finish(h); }

  const roomy = await setup();
  try {
    assert.equal((await post(roomy.port, '/v1/messages', body)).status, 404);
  } finally { await finish(roomy); }
});
