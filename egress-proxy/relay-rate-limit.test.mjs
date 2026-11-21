import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { startApiRelay } from './api-relay/api-relay.mjs';

const SANDBOX_A = 'carapa-aaa.agent_egress_default';
const SANDBOX_B = 'carapa-bbb.agent_egress_default';

async function withRelay(env, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rate-limit-'));
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  // Non-strict config whose glob matches both sandboxes, like relay-clients/carapa-bot.json.
  fs.writeFileSync(path.join(root, 'carapa-bot.json'), JSON.stringify({
    match: ['carapa-*.agent_egress*'],
    services: { 'mcp-relay': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } },
  }));
  let sandbox = SANDBOX_A;
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: root, hostnameResolver: () => sandbox,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', OPENROUTER_API_KEY: 'test-key', ...env },
    externalRequest: async () => {
      const response = new Readable({ read() { this.push(null); } });
      return Object.assign(response, { statusCode: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  if (!relay.server.listening) await once(relay.server, 'listening');
  const port = relay.server.address().port;
  const hit = async (as, route) => {
    sandbox = as;
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: '{}' });
    const text = await response.text();
    return { status: response.status, scope: response.status === 429 ? JSON.parse(text).scope : undefined };
  };
  try { await run(hit); } finally {
    relay.server.closeAllConnections?.();
    relay.close();
    upstream.closeAllConnections?.();
    upstream.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const route of ['/openrouter/v1/chat', '/mcp-relay/mcp']) {
  test(`per-client rate limit is per sandbox, not shared by sandboxes matching one config (${route})`, async () => {
    await withRelay({ RATE_LIMIT_PER_CLIENT: '2', RATE_LIMIT_GLOBAL: '100' }, async hit => {
      expect((await hit(SANDBOX_A, route)).status).toBe(200);
      expect((await hit(SANDBOX_A, route)).status).toBe(200);
      expect(await hit(SANDBOX_A, route)).toEqual({ status: 429, scope: 'per-client' });
      expect((await hit(SANDBOX_B, route)).status).toBe(200);
      expect((await hit(SANDBOX_B, route)).status).toBe(200);
      expect(await hit(SANDBOX_B, route)).toEqual({ status: 429, scope: 'per-client' });
    });
  });
}

test('global per-provider limit still applies across sandboxes', async () => {
  await withRelay({ RATE_LIMIT_PER_CLIENT: '10', RATE_LIMIT_GLOBAL: '3' }, async hit => {
    const route = '/openrouter/v1/chat';
    expect((await hit(SANDBOX_A, route)).status).toBe(200);
    expect((await hit(SANDBOX_A, route)).status).toBe(200);
    expect((await hit(SANDBOX_B, route)).status).toBe(200);
    expect(await hit(SANDBOX_B, route)).toEqual({ status: 429, scope: 'global' });
  });
});
