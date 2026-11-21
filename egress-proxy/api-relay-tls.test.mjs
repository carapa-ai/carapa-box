import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each scenario runs in a child process so env (NODE_EXTRA_CA_CERTS,
// RELAY_DEBUG_SNIFF) never leaks between tests or depends on import order.
const RELAY_URL = new URL('./api-relay/api-relay.mjs', import.meta.url).href;

function makeCert(dir, name, san) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert, '-subj', `/CN=${san}`, '-addext', `subjectAltName=DNS:${san}`],
  { stdio: 'ignore' });
  return { key, cert };
}

async function runScenario({ certSan = 'openrouter.ai', trust, providerConfig = {}, env = {}, script }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-tls-'));
  try {
    const { key, cert } = makeCert(root, 'upstream', certSan);
    fs.writeFileSync(path.join(root, 'default.json'),
      JSON.stringify({ providers: { openrouter: { auth: 'apikey', envKey: 'OPENROUTER_API_KEY', ...providerConfig } }, services: {} }));
    const childEnv = { PATH: process.env.PATH, ...env };
    if (trust) childEnv.NODE_EXTRA_CA_CERTS = cert;
    const code = `
      import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
      import fs from 'node:fs'; import { once } from 'node:events';
      import { startApiRelay } from ${JSON.stringify(RELAY_URL)};
      const upstream = https.createServer({ key: fs.readFileSync(${JSON.stringify(key)}), cert: fs.readFileSync(${JSON.stringify(cert)}) },
        (req, res) => res.end('upstream-ok'));
      upstream.on('upgrade', (req, socket) => {
        socket.on('error', () => {});
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
      });
      upstream.on('tlsClientError', () => {});
      upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
      const stub = http.createServer();
      const connects = [];
      stub.on('connect', (req, client) => {
        connects.push(req.url);
        const up = net.connect(upstream.address().port, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
      });
      stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
      const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: ${JSON.stringify(root)},
        env: { HTTP_PROXY: 'http://127.0.0.1:' + stub.address().port, OPENROUTER_API_KEY: 'k', SNI_BRIDGE_PORT: '0',
          RELAY_DEBUG_SNIFF: process.env.RELAY_DEBUG_SNIFF } });
      if (!relay.server.listening) await once(relay.server, 'listening');
      const relayPort = relay.server.address().port;
      const get = (p) => new Promise((resolve, reject) => {
        const r = http.get({ hostname: '127.0.0.1', port: relayPort, path: p }, res => {
          let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
        }); r.on('error', reject);
      });
      const ws = (p) => new Promise((resolve, reject) => {
        const s = net.connect(relayPort, '127.0.0.1');
        s.write('GET ' + p + ' HTTP/1.1\\r\\nHost: relay\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Key: abc==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');
        let data = ''; s.on('data', c => { data += c; }); s.on('close', () => resolve(data)); s.on('error', reject);
        setTimeout(() => { s.destroy(); }, 2000);
      });
      const deadline = setTimeout(() => { console.log(JSON.stringify({ hang: true })); process.exit(1); }, 8000);
      const out = {};
      try { ${script} } finally {
        clearTimeout(deadline); relay.server.closeAllConnections?.(); relay.close(); stub.close(); upstream.close();
      }
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    `;
    const stdout = execFileSync('node', ['--input-type=module', '-e', code],
      { env: childEnv, encoding: 'utf8', timeout: 15_000 });
    return JSON.parse(stdout.split('RESULT ').pop());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const BOTH = `out.http = await get('/openrouter/v1'); out.ws = (await ws('/openrouter/v1')).split('\\r\\n')[0];
  out.wsBody = (await ws('/openrouter/v1'));`;

describe('Squid-tunnelled upstream TLS verification', () => {
  test('verifies by default: a trusted, matching certificate connects over HTTP and WebSocket', async () => {
    const out = await runScenario({ trust: true, script: BOTH });
    expect(out.http).toEqual({ status: 200, body: 'upstream-ok' });
    expect(out.ws).toMatch(/^HTTP\/1.1 101/);
  }, 20_000);

  test('verifies by default: an untrusted certificate is rejected (HTTP and WebSocket)', async () => {
    const out = await runScenario({ trust: false, script: BOTH });
    expect(out.http.status).toBe(502);
    expect(out.ws).toMatch(/^HTTP\/1.1 502/);
  }, 20_000);

  test('verifies by default: a trusted certificate for the wrong hostname is rejected', async () => {
    const out = await runScenario({ trust: true, certSan: 'evil.example', script: BOTH });
    expect(out.http.status).toBe(502);
    expect(out.http.body).toContain('openrouter.ai');
    expect(out.ws).toMatch(/^HTTP\/1.1 502/);
  }, 20_000);

  test('verifyTls: false keeps the unverified behaviour (HTTP and WebSocket)', async () => {
    const out = await runScenario({ trust: false, providerConfig: { verifyTls: false }, script: BOTH });
    expect(out.http).toEqual({ status: 200, body: 'upstream-ok' });
    expect(out.ws).toMatch(/^HTTP\/1.1 101/);
  }, 20_000);

  test('a certificate failure returns a 502 naming the host and TLS error code without hanging', async () => {
    const out = await runScenario({ trust: false, script: BOTH });
    expect(out.hang).toBeUndefined();
    expect(out.http.status).toBe(502);
    expect(out.http.body).toContain('openrouter.ai');
    expect(out.http.body).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
    expect(out.wsBody).toContain('openrouter.ai');
  }, 20_000);
});

describe('removed /sniff debug route', () => {
  test('RELAY_DEBUG_SNIFF=1 does not forward /sniff/<host>/... to the named host', async () => {
    const out = await runScenario({ trust: true, env: { RELAY_DEBUG_SNIFF: '1' }, certSan: 'example.test',
      script: `out.status = (await get('/sniff/example.test/x')).status; out.connects = connects;` });
    expect(out.status).toBe(404);
    expect(out.connects).toEqual([]);
  }, 20_000);
});
