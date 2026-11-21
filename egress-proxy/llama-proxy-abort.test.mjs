import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

// UPSTREAM_HOST and the retry delay are read at module load, so every scenario
// runs in a child `node` process. The child prints one JSON result line.
const CHILD = String.raw`
import http from 'node:http';
import { makeHandler } from ${JSON.stringify(new URL('./llama-proxy.mjs', import.meta.url).href)};

const scenario = process.env.SCENARIO;
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};

let upstreamAttempts = 0;
let upstreamCloseAt = null;
let generationDone = false;
let upstreamSocket = null;
const upstream = http.createServer((req, res) => {
  upstreamAttempts++;
  req.resume();
  if (scenario === 'retry') {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('loading');
    return;
  }
  upstreamSocket = req.socket;
  res.on('close', () => { upstreamCloseAt ??= Date.now(); });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: start\n\n');
  // Generation only counts as completed if the connection is still open.
  setTimeout(() => {
    if (res.destroyed) return;
    generationDone = true;
    res.end('data: done\n\n');
  }, 1000);
});
const upstreamPort = await listen(upstream);

// makeHandler(port) forwards to UPSTREAM_HOST on the same port.
const proxy = http.createServer(makeHandler(upstreamPort));
const proxyPort = await listen(proxy);

const body = JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] });
const req = http.request({
  host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
});
const t0 = Date.now();

if (scenario === 'client-abort') {
  req.on('error', () => {});
  req.on('response', res => { res.on('error', () => {}); res.resume(); });
  req.end(body);
  await sleep(300);
  const abortAt = Date.now();
  req.destroy();
  await sleep(1200); // past the 1000ms fake generation
  out.closeDelayMs = upstreamCloseAt ? upstreamCloseAt - abortAt : null;
  out.generationDone = generationDone;
} else if (scenario === 'upstream-die') {
  const result = await new Promise(resolve => {
    req.on('error', e => resolve({ kind: 'error', at: Date.now() - t0 }));
    req.on('response', res => {
      res.on('error', () => resolve({ kind: 'error', at: Date.now() - t0 }));
      res.on('close', () => resolve({ kind: res.complete ? 'complete' : 'aborted', at: Date.now() - t0 }));
      res.resume();
    });
    req.end(body);
    setTimeout(() => upstreamSocket?.destroy(), 300);
    setTimeout(() => resolve({ kind: 'hung', at: Date.now() - t0 }), 2500);
  });
  out.result = result;
} else if (scenario === 'retry') {
  req.on('error', () => {});
  req.end(body);
  await sleep(300);
  const attemptsAtAbort = upstreamAttempts;
  req.destroy();
  await sleep(600);
  out.attemptsAtAbort = attemptsAtAbort;
  out.attemptsAfter = upstreamAttempts;
}
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: {
        ...process.env,
        SCENARIO: scenario,
        UPSTREAM_HOST: '127.0.0.1',
        LOADING_RETRY_ATTEMPTS: '10',
        LOADING_RETRY_DELAY_MS: '200',
        LLAMA_DEBUG: '',
        LOG_REQUESTS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
      if (!line) return reject(new Error(`no result: ${stderr || stdout}`));
      resolve(JSON.parse(line.slice('RESULT '.length)));
    });
  });
}

test('client abort closes the upstream request within 500ms', async () => {
  const r = await runScenario('client-abort');
  assert.notEqual(r.closeDelayMs, null, 'upstream never saw close');
  assert.ok(r.closeDelayMs <= 500, `upstream close took ${r.closeDelayMs}ms`);
});

test('client abort does not let upstream generation complete', async () => {
  const r = await runScenario('client-abort');
  assert.equal(r.generationDone, false);
});

test('upstream socket destroyed mid-stream fails the client within 1s', async () => {
  const r = await runScenario('upstream-die');
  assert.notEqual(r.result.kind, 'hung');
  assert.notEqual(r.result.kind, 'complete');
  assert.ok(r.result.at <= 1000, `client failed after ${r.result.at}ms`);
});

test('client gone during 503 retries stops further upstream attempts', async () => {
  const r = await runScenario('retry');
  assert.ok(r.attemptsAtAbort >= 1);
  assert.equal(r.attemptsAfter, r.attemptsAtAbort);
});
