import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProxy, validateSnapshot, permitted } from './proxy.mjs';

function document(port, backendPort) {
  return { version: 1, revision: 'test', expiresAt: Date.now() + 30_000, denyCidrs: ['127.0.0.2/31'], routes: [{
    listenPort: port, targetPort: backendPort, targetIp: '127.0.0.2', sourceIp: '127.0.0.3', kind: 'http',
    container: 'sandbox-nginx-1', containerId: 'a'.repeat(64), allowCidrs: ['127.0.0.0/8'],
  }] };
}

test('sandbox denies override LAN allows; wrong interfaces, expired routes and unsafe targets fail closed', () => {
  const raw = document(22000, 8080);
  const snapshot = validateSnapshot(raw, 22000, 22255);
  const route = snapshot.routes.get(22000);
  assert.ok(permitted(snapshot, route, '127.0.0.1', '127.0.0.1', '127.0.0.1'));
  assert.ok(!permitted(snapshot, route, '127.0.0.2', '127.0.0.1', '127.0.0.1'));
  assert.ok(!permitted(snapshot, route, '127.0.0.1', '127.0.0.3', '127.0.0.1'));
  assert.ok(!permitted(snapshot, route, '::1', '127.0.0.1', '127.0.0.1'));
  assert.ok(!permitted(snapshot, route, '127.0.0.1', '127.0.0.1', '127.0.0.1', raw.expiresAt));
  for (const mutate of [r => r.routes.push(r.routes[0]), r => r.routes[0].targetIp = '192.168.1.1', r => r.routes[0].kind = 'ssh', r => r.expiresAt = Date.now() - 1]) {
    const invalid = structuredClone(raw); mutate(invalid);
    assert.throws(() => validateSnapshot(invalid, 22000, 22255));
  }
});

const listen = (server, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => resolve(server.address().port));
});
const close = server => new Promise(resolve => server.close(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real TCP forwarding preserves bytes and closes sessions on revoke, invalid config, DNS mismatch and lease expiry', async () => {
  // Ingress runs on Node. Bun's net.connect ignores localAddress, so it cannot
  // exercise the sandbox-source deny with a real connection. Keep this test in
  // default discovery, but execute that TCP boundary under the production runtime.
  if (process.versions.bun) {
    execFileSync('node', ['--test', '--test-name-pattern=real TCP forwarding', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', timeout: 10_000,
    });
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ingress-proxy-test-'));
  const configPath = path.join(root, 'routes.json');
  const largeBody = Buffer.alloc(8 * 1024 * 1024, 65);
  const backend = net.createServer(socket => socket.once('data', first => {
    if (first.toString() === 'large-response') socket.end(largeBody);
    else { socket.write(first); socket.pipe(socket); }
  }));
  const backendPort = await listen(backend, '127.0.0.2');
  const temporary = net.createServer();
  const port = await listen(temporary, '127.0.0.1');
  await close(temporary);
  let doc = document(port, backendPort);
  const write = async () => {
    await fs.writeFile(configPath + '.tmp', JSON.stringify(doc));
    await fs.rename(configPath + '.tmp', configPath);
  };
  await write();
  let address = '127.0.0.2';
  const proxy = await startProxy({ bindAddress: '127.0.0.1', firstPort: port, lastPort: port, configPath, pollMs: 10, resolve: async () => [address] });
  const clients = new Set();
  const connect = (localAddress = '127.0.0.1') => {
    const client = net.connect({ host: '127.0.0.1', port, localAddress });
    client.on('error', () => {}); client.resume(); clients.add(client);
    return client;
  };
  const disconnected = client => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Session remained open')), 1500);
    client.once('close', () => { clearTimeout(timer); resolve(); });
  });
  try {
    const client = connect();
    const payload = Buffer.from('SSH-2.0-test\r\nHTTP/1.1 101 Switching Protocols\r\n\x00\xff');
    const received = new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      client.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= payload.length) resolve(bytes); });
      client.once('error', reject);
    });
    client.write(payload);
    assert.deepEqual(await received, payload);
    const gone = disconnected(client);
    doc.routes = []; await write(); await proxy.refresh(); await gone;
    doc = document(port, backendPort); await write(); await proxy.refresh();
    const slow = connect(); slow.pause();
    const complete = new Promise(resolve => {
      let bytes = Buffer.alloc(0);
      slow.on('data', chunk => bytes = Buffer.concat([bytes, chunk]));
      slow.once('close', () => resolve(bytes));
    });
    slow.write('large-response'); await delay(100); slow.resume();
    assert.deepEqual(await complete, largeBody); // no truncation on upstream FIN
    await disconnected(connect('127.0.0.2')); // sandbox source, despite broad allow
    address = '127.0.0.4'; await disconnected(connect()); // container IP reused
    address = '127.0.0.2';
    const stale = connect(); stale.write('keepalive'); await delay(30);
    const expired = disconnected(stale);
    doc.expiresAt = Date.now() + 50; await write(); await proxy.refresh(); await expired;
    await fs.writeFile(configPath, '{broken'); await proxy.refresh(); await disconnected(connect());
  } finally {
    for (const client of clients) client.destroy();
    await proxy.close(); await close(backend); await fs.rm(root, { recursive: true, force: true });
  }
});

test('status file is replaced atomically so a concurrent reader never sees an empty or partial file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ingress-status-test-'));
  const configPath = path.join(root, 'routes.json');
  const statusPath = path.join(root, 'status.json');
  const temporary = net.createServer();
  const port = await listen(temporary, '127.0.0.1');
  await close(temporary);
  await fs.writeFile(configPath, JSON.stringify(document(port, 8080)));
  const proxy = await startProxy({ bindAddress: '127.0.0.1', firstPort: port, lastPort: port, configPath, statusPath, pollMs: 60_000 });
  try {
    let refreshing = true;
    const failures = [];
    const reader = (async () => {
      while (refreshing) {
        const text = await fs.readFile(statusPath, 'utf8');
        try { JSON.parse(text); } catch { failures.push(text); }
      }
    })();
    for (let i = 0; i < 500; i++) await proxy.refresh();
    refreshing = false;
    await reader;
    assert.deepEqual(failures, []);
  } finally {
    await proxy.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
