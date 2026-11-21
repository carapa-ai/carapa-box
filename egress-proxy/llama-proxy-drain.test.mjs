import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createDrainTracker } from './llama-proxy.mjs';
import { connectRefused, getJson, partialRequest, sleep, spawnHarness, startStream } from './drain-test-helpers.mjs';

// Child harness: the real startProxy() bound to 127.0.0.1 (so the fake upstream
// can use 127.0.0.2 on the same port number), wired to its own SIGTERM handler.
const HARNESS = String.raw`
import http from 'node:http';
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, cb) { return origListen.call(this, port, '127.0.0.1', cb); };
const { startProxy } = await import(${JSON.stringify(new URL('./llama-proxy.mjs', import.meta.url).href)});
startProxy();
setTimeout(() => console.log('READY ' + process.env.PORTS), 300);
`;

async function setup(extraEnv = {}, { hang = false } = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    if (!hang) setTimeout(() => res.end('data: two\n\n'), 1200);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.2', r));
  const port = upstream.address().port;
  const h = spawnHarness(HARNESS, {
    PORTS: String(port), UPSTREAM_HOST: '127.0.0.2', TOOL_PROFILES_PATH: '/nonexistent/tool_profiles.jsonc', ...extraEnv,
  });
  h.upstream = upstream;
  h.port = port;
  return h;
}

const finish = async h => { h.child.kill('SIGKILL'); await h.exited; h.upstream.closeAllConnections(); h.upstream.close(); };

test('streaming request completes after SIGTERM and exit follows its end', async () => {
  const h = await setup();
  const port = await h.ready();
  const { done } = await startStream(port, '/v1/stream');
  h.child.kill('SIGTERM');
  const t0 = Date.now();
  assert.equal(await done, 'data: one\n\ndata: two\n\n');
  assert.equal((await h.exited).code, 0);
  assert.ok(h.exitedAt >= t0 + 800, 'exited before the stream ended');
  assert.match(h.out, /\[drain\] start inflight=1/);
  assert.match(h.out, /\[drain\] done/);
  await finish(h);
});

test('SIGTERM with nothing in flight exits within ~1s', async () => {
  const h = await setup();
  await h.ready();
  const t0 = Date.now();
  h.child.kill('SIGTERM');
  assert.equal((await h.exited).code, 0);
  assert.ok(h.exitedAt - t0 < 1000);
  await finish(h);
});

test('new connections are refused after SIGTERM and /_inflight reports draining', async () => {
  const h = await setup();
  const port = await h.ready();
  const { done } = await startStream(port, '/v1/stream');
  const status = await partialRequest(port, '/_inflight');
  h.child.kill('SIGTERM');
  await sleep(300);
  assert.equal(await connectRefused(port), true);
  assert.match(await status.finish(), /"inflight":1,"draining":true/);
  await done;
  assert.equal((await h.exited).code, 0);
  await finish(h);
});

test('/_inflight counts active requests and does not count itself', async () => {
  const h = await setup();
  const port = await h.ready();
  assert.equal(JSON.parse((await getJson(port)).body).inflight, 0);
  const { done } = await startStream(port, '/v1/stream');
  assert.deepEqual(JSON.parse((await getJson(port)).body), { inflight: 1, draining: false });
  await done;
  await sleep(50);
  assert.equal(JSON.parse((await getJson(port)).body).inflight, 0);
  await finish(h);
});

test('/_inflight returns 403 from a non-loopback address', () => {
  const tracker = createDrainTracker();
  const run = remoteAddress => {
    const out = {};
    const res = { writeHead: s => { out.status = s; }, end: () => {} };
    tracker.handleStatus({ url: '/_inflight', socket: { remoteAddress } }, res);
    return out.status;
  };
  assert.equal(run('10.0.0.5'), 403);
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(run(ok), 200);
});

test('drain cap exits after RELAY_DRAIN_TIMEOUT_MS with a hung request', async () => {
  const h = await setup({ RELAY_DRAIN_TIMEOUT_MS: '400' }, { hang: true });
  const port = await h.ready();
  await startStream(port, '/v1/stream');
  const t0 = Date.now();
  h.child.kill('SIGTERM');
  assert.equal((await h.exited).code, 0);
  assert.ok(h.exitedAt - t0 >= 350 && h.exitedAt - t0 < 3000);
  assert.match(h.out, /\[drain\] timeout after 400ms, inflight=1/);
  await finish(h);
});
