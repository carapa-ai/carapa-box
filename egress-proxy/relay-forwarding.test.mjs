import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FORWARD_HEADERS, createReplayGuard, forwarderKeyFromSecret, sandboxAllowed, signForwardHeaders, verifyForwardedRequest,
} from './api-relay/relay-forwarding.mjs';

const SECRET = 'cbx_test-box-connection-value';
const KEY = forwarderKeyFromSecret(SECRET);
const SANDBOX = 'carapa-bot-proj-agent-1.agent_egress_carapa-bot-proj';
const policy = { key: KEY, projects: ['carapa-bot-proj'] };

test('signed forwarding headers verify; tampering, staleness and foreign sandboxes do not', () => {
  const now = 1_800_000_000_000;
  const headers = signForwardHeaders({ keyHex: KEY, method: 'POST', path: '/board-api/x', box: 'lab', sandbox: SANDBOX, credentials: { '': 'board-cred' }, now });
  const ok = verifyForwardedRequest({ headers, method: 'POST', path: '/board-api/x' }, () => policy, now);
  expect(ok).toMatchObject({ ok: true, box: 'lab', sandbox: SANDBOX, credentials: { '': 'board-cred' } });
  expect(verifyForwardedRequest({ headers, method: 'GET', path: '/board-api/x' }, () => policy, now).ok).toBe(false);
  expect(verifyForwardedRequest({ headers, method: 'POST', path: '/board-api/y' }, () => policy, now).ok).toBe(false);
  expect(verifyForwardedRequest({ headers, method: 'POST', path: '/board-api/x' }, () => policy, now + 120_000).ok).toBe(false);
  const swapped = { ...headers, [FORWARD_HEADERS.credentials]: Buffer.from('{"":"other"}').toString('base64url') };
  expect(verifyForwardedRequest({ headers: swapped, method: 'POST', path: '/board-api/x' }, () => policy, now).ok).toBe(false);
  expect(verifyForwardedRequest({ headers, method: 'POST', path: '/board-api/x' }, () => ({ key: forwarderKeyFromSecret('other'), projects: policy.projects }), now).ok).toBe(false);
  expect(verifyForwardedRequest({ headers, method: 'POST', path: '/board-api/x' }, () => ({ key: KEY, projects: ['other-proj'] }), now)).toMatchObject({ ok: false, reason: 'sandbox not placed on this box' });
  expect(sandboxAllowed('carapa-bot-proj-agent-1', ['carapa-bot-proj'])).toBe(true);
  expect(sandboxAllowed('carapa-bot-projx-agent-1', ['carapa-bot-proj'])).toBe(false);
  expect(sandboxAllowed('carapa-bot-proj-extra-agent-1', ['carapa-bot-proj'])).toBe(false);
  expect(sandboxAllowed('proja-agent-1.x.agent_egress_projb', ['proja'])).toBe(false);
  expect(sandboxAllowed('proja-agent-1.agent_egress_proja', ['proja'])).toBe(true);
  expect(sandboxAllowed('proja-agent-1.agent_egress_projb', ['proja'])).toBe(false);
  const dotted = signForwardHeaders({ keyHex: KEY, method: 'GET', path: '/mcp', box: 'lab', sandbox: 'proja-agent-1.x.agent_egress_projb', now });
  expect(verifyForwardedRequest({ headers: dotted, method: 'GET', path: '/mcp' }, () => ({ key: KEY, projects: ['proja'] }), now)).toEqual({ ok: false, reason: 'sandbox not placed on this box' });
  const once = createReplayGuard();
  expect(once('sig-a', now)).toBe(true);
  expect(once('sig-a', now + 1000)).toBe(false);
  expect(once('sig-b', now + 1000)).toBe(true);
});

test('identical parallel forwarded requests in one millisecond each verify once; a true replay and a stripped nonce are rejected', () => {
  const now = 1_800_000_000_000;
  const sign = () => signForwardHeaders({ keyHex: KEY, method: 'POST', path: '/mcp-relay/mcp/carapa-board', box: 'lab', sandbox: SANDBOX, now });
  const [first, second] = [sign(), sign()];
  const once = createReplayGuard();
  for (const headers of [first, second]) {
    expect(verifyForwardedRequest({ headers, method: 'POST', path: '/mcp-relay/mcp/carapa-board' }, () => policy, now).ok).toBe(true);
    expect(once(headers[FORWARD_HEADERS.signature], now)).toBe(true);
  }
  expect(once(first[FORWARD_HEADERS.signature], now)).toBe(false);
  const { [FORWARD_HEADERS.nonce]: _nonce, ...unnonced } = first;
  expect(verifyForwardedRequest({ headers: unnonced, method: 'POST', path: '/mcp-relay/mcp/carapa-board' }, () => policy, now).ok).toBe(false);
  const swapped = { ...first, [FORWARD_HEADERS.nonce]: second[FORWARD_HEADERS.nonce] };
  expect(verifyForwardedRequest({ headers: swapped, method: 'POST', path: '/mcp-relay/mcp/carapa-board' }, () => policy, now).ok).toBe(false);
});

test('a box forwarder reaches Board through the central relay with its sandbox credential only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-forward-'));
  const script = `
    import http from 'node:http';
    import fs from 'node:fs';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const seen = [];
    let accepted = 'sandbox-board-cred';
    let boxToken = 'sandbox-board-cred';
    const board = http.createServer((req, res) => {
      if (req.url.startsWith('/api/relay/forwarders/')) {
        assert.equal(req.headers.authorization, 'Bearer hub-secret-0123456789');
        if (req.url !== '/api/relay/forwarders/lab') { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: ${JSON.stringify(KEY)}, projects: ['carapa-bot-proj'] }));
        return;
      }
      if (req.headers.authorization !== 'Bearer ' + accepted) { res.writeHead(401); res.end(); return; }
      seen.push({ url: req.url, headers: req.headers });
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ echo: body })); });
    });
    board.listen(0, '127.0.0.1'); await once(board, 'listening');
    const boardPort = board.address().port;
    fs.mkdirSync(root + '/central'); fs.mkdirSync(root + '/box');
    const services = { 'board-api': { host: '127.0.0.1', port: boardPort, protocol: 'http', auth: 'apikey' } };
    fs.writeFileSync(root + '/central/carapa-bot.json', JSON.stringify({ match: ['carapa-*.agent_egress*'], services }));
    fs.writeFileSync(root + '/box/carapa-bot.json', JSON.stringify({ match: ['carapa-*.agent_egress*'], services }));
    const central = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root + '/central',
      hostnameResolver: () => null,
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_FORWARDER_PORT: '0', RELAY_FORWARDER_HOST: '127.0.0.1',
        CARAPA_RELAY_HUB_SECRET: 'hub-secret-0123456789', CARAPA_BOARD_URL: 'http://127.0.0.1:' + boardPort } });
    if (!central.forwarderListener.listening) await once(central.forwarderListener, 'listening');
    const upstreamPort = central.forwarderListener.address().port;
    // The box's own CarapaBox holds the sandbox credential (Board pushed it).
    const boxAdmin = http.createServer((req, res) => {
      if (req.url.startsWith('/api/admin/relay-token/carapa-bot-proj-agent-1') && !req.url.includes('service=')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: boxToken })); return;
      }
      res.writeHead(404); res.end();
    });
    boxAdmin.listen(0, '127.0.0.1'); await once(boxAdmin, 'listening');
    const forwarder = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root + '/box',
      hostnameResolver: () => ${JSON.stringify(SANDBOX)},
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_MODE: 'forward',
        CARAPA_RELAY_UPSTREAM: 'http://127.0.0.1:' + upstreamPort, CARAPA_BOX_ID: 'lab', CARAPA_HUB_BOX_SECRET: ${JSON.stringify(SECRET)},
        CARAPA_BOX_URL: 'http://127.0.0.1:' + boxAdmin.address().port, CARAPA_BOX_API_TOKEN: 'box-api' } });
    if (!forwarder.server.listening) await once(forwarder.server, 'listening');
    const call = (port, p, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
        let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.end('{"q":1}');
    });
    try {
      const ok = await call(forwarder.server.address().port, '/board-api/api/tasks', { authorization: 'Bearer agent-supplied', 'x-carapa-box': 'spoof' });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(JSON.parse(ok.body).echo, '{"q":1}');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, '/api/tasks');
      assert.equal(seen[0].headers.authorization, 'Bearer sandbox-board-cred');
      assert.ok(!Object.keys(seen[0].headers).some(h => h.startsWith('x-carapa-')));
      const forged = await call(upstreamPort, '/board-api/api/tasks', { 'x-carapa-box': 'lab', 'x-carapa-sandbox': ${JSON.stringify(SANDBOX)}, 'x-carapa-timestamp': String(Date.now()), 'x-carapa-signature': 'ab'.repeat(32) });
      assert.equal(forged.status, 401);
      const bare = await call(upstreamPort, '/board-api/api/tasks');
      assert.equal(bare.status, 401);
      assert.equal(seen.length, 1);
      // Board rotates the sandbox credential and pushes it to the box. The
      // request still carrying the cached old one is rejected; the forwarder
      // drops it, so the next request uses the box's current credential.
      accepted = boxToken = 'rotated-board-cred';
      const stale = await call(forwarder.server.address().port, '/board-api/api/tasks');
      assert.equal(stale.status, 401);
      const fresh = await call(forwarder.server.address().port, '/board-api/api/tasks');
      assert.equal(fresh.status, 200, fresh.body);
      assert.equal(seen.at(-1).headers.authorization, 'Bearer rotated-board-cred');
      // A native runner's forwarder identifies projects by path; the per-project
      // capability stops one project's agent from claiming another project.
      const CAP = 'c0ffee'.repeat(8);
      const pathForwarder = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root + '/box',
        pathCapability: (project) => project === 'carapa-bot-proj' ? CAP : undefined,
        env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_MODE: 'forward', RELAY_FORWARD_PATH_IDENTITY: '1',
          CARAPA_RELAY_UPSTREAM: 'http://127.0.0.1:' + upstreamPort, CARAPA_BOX_ID: 'lab', CARAPA_HUB_BOX_SECRET: ${JSON.stringify(SECRET)},
          CARAPA_BOX_URL: 'http://127.0.0.1:' + boxAdmin.address().port, CARAPA_BOX_API_TOKEN: 'box-api' } });
      if (!pathForwarder.server.listening) await once(pathForwarder.server, 'listening');
      try {
        const pathPort = pathForwarder.server.address().port;
        assert.equal((await call(pathPort, '/s/carapa-bot-proj/' + CAP + '/board-api/api/tasks')).status, 200);
        assert.equal(seen.at(-1).headers.authorization, 'Bearer rotated-board-cred');
        for (const claimed of ['/s/carapa-bot-proj/' + 'ab'.repeat(32) + '/board-api/api/tasks', '/s/carapa-bot-proj/board-api/api/tasks',
          '/s/carapa-bot-other/' + CAP + '/board-api/api/tasks']) {
          assert.equal((await call(pathPort, claimed)).status, 403, claimed);
        }
      } finally { pathForwarder.server.closeAllConnections?.(); pathForwarder.server.close(); pathForwarder.close(); }
      console.log('FORWARD-OK');
    } finally {
      for (const s of [forwarder.server, central.server, central.forwarderListener, board, boxAdmin]) { s.closeAllConnections?.(); s.close(); }
      forwarder.close(); central.close();
    }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 || !out.includes('FORWARD-OK')) throw new Error(out.slice(-3000) + '\n' + err.slice(-3000));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('unauthenticated forwarder requests trigger no Board lookup; lookups are deduped and the policy cache is bounded', async () => {
  const script = `
    import http from 'node:http';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const lookups = [];
    const board = http.createServer((req, res) => {
      lookups.push(req.url.split('/').pop());
      setTimeout(() => { res.writeHead(404); res.end(); }, 50);
    });
    board.listen(0, '127.0.0.1'); await once(board, 'listening');
    const central = startApiRelay({ port: 0, host: '127.0.0.1', hostnameResolver: () => null,
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_FORWARDER_PORT: '0', RELAY_FORWARDER_HOST: '127.0.0.1',
        CARAPA_RELAY_HUB_SECRET: 'hub-secret-0123456789', CARAPA_BOARD_URL: 'http://127.0.0.1:' + board.address().port } });
    if (!central.forwarderListener.listening) await once(central.forwarderListener, 'listening');
    const port = central.forwarderListener.address().port;
    const call = (headers) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/board-api/x', method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    const full = (box, extra = {}) => ({ 'x-carapa-box': box, 'x-carapa-sandbox': 's-1', 'x-carapa-timestamp': String(Date.now()),
      'x-carapa-nonce': 'n', 'x-carapa-signature': 'ab'.repeat(32), ...extra });
    try {
      assert.equal(await call({ 'x-carapa-box': 'fresh-a' }), 401);
      const { 'x-carapa-nonce': _n, ...noNonce } = full('fresh-b');
      assert.equal(await call(noNonce), 401);
      assert.equal(await call(full('fresh-c', { 'x-carapa-timestamp': String(Date.now() - 3_600_000) })), 401);
      assert.equal(await call(full('fresh-d', { 'x-carapa-timestamp': 'nope' })), 401);
      assert.deepEqual(lookups, []);
      const same = await Promise.all(Array.from({ length: 5 }, () => call(full('dup'))));
      assert.deepEqual(same, [401, 401, 401, 401, 401]);
      assert.deepEqual(lookups, ['dup']);
      lookups.length = 0;
      await call(full('box-0'));
      for (let i = 1; i < 300; i += 4) await Promise.all([0, 1, 2, 3].map(j => call(full('box-' + (i + j)))));
      lookups.length = 0;
      await call(full('box-0'));
      assert.deepEqual(lookups, ['box-0']);
      console.log('LOOKUPS-OK');
    } finally {
      for (const s of [central.server, central.forwarderListener, board]) { s.closeAllConnections?.(); s.close(); }
      central.close();
    }
  `;
  const child = Bun.spawn(['node', '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 || !out.includes('LOOKUPS-OK')) throw new Error(out.slice(-3000) + '\n' + err.slice(-3000));
}, 60_000);
