import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import { sleep, startStream } from './drain-test-helpers.mjs';

// Runs the real entry point (supervisor + cluster worker) under Node from a copy
// of the code directory, so the test can replace files like a git merge does.
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

// GET /_inflight; rejects on refusal or when nothing answers within 2s.
function inflight(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/_inflight', agent: false, timeout: 2000 }, res => {
      let body = ''; res.on('data', d => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })));
    req.on('error', reject);
  });
}

function replaceFile(file, content) {
  fs.writeFileSync(file + '.next', content);
  fs.renameSync(file + '.next', file);
}

// Bun's default 5s test deadline is shorter than the waits below (each `until` allows
// 10s) and than a loaded host needs to boot and swap three Node workers.
test('SIGHUP loads new code without refusing connections; the old worker finishes its stream', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-reload-'));
  const codeDir = path.join(root, 'api-relay');
  fs.cpSync(new URL('./api-relay/', import.meta.url), codeDir, { recursive: true });

  let release;
  const released = new Promise(resolve => { release = resolve; });
  const upstream = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('one;');
    await released;
    res.end('two;');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  fs.mkdirSync(path.join(root, 'relay-clients'));
  fs.writeFileSync(path.join(root, 'relay-clients', 'default.json'), JSON.stringify({
    providers: {},
    services: { slow: { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } },
  }));

  const port = await freePort();
  const child = spawn('node', [path.join(codeDir, 'api-relay.mjs')], {
    env: { PATH: process.env.PATH, HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = once(child, 'exit');
  const status = () => inflight(port);
  const until = async (check, what) => {
    for (let i = 0; i < 200; i++) {
      try { if (await check()) return; } catch { /* not listening yet */ }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}\n${out}`);
  };

  let polling = true;
  try {
    await until(async () => (await status()).codeHash, 'the first worker');
    const firstHash = (await status()).codeHash;
    const { done } = await startStream(port, '/slow/stream');

    // Poll throughout the reload: every connection must be accepted.
    const refused = [];
    const poller = (async () => {
      while (polling) {
        await inflight(port).catch(err => refused.push(err.code));
        await sleep(10);
      }
    })();

    replaceFile(path.join(codeDir, 'api-relay.mjs'), fs.readFileSync(path.join(codeDir, 'api-relay.mjs'), 'utf8') + '\n// v2\n');
    child.kill('SIGHUP');
    await until(async () => (await status()).codeHash !== firstHash, 'the reloaded worker');
    const secondHash = (await status()).codeHash;

    release();
    assert.equal(await done, 'one;two;');
    assert.deepEqual(refused, []);

    // Code that cannot start never replaces the serving worker.
    replaceFile(path.join(codeDir, 'websocket-upgrade.mjs'), 'export const broken = ;');
    child.kill('SIGHUP');
    await until(async () => /new worker failed to start \(reload\)/.test(out), 'the failed reload');
    assert.equal((await status()).codeHash, secondHash);

    polling = false;
    await poller;
    assert.deepEqual(refused, []);

    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    polling = false;
    child.kill('SIGKILL');
    upstream.closeAllConnections();
    upstream.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
