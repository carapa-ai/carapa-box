import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a sandbox aborting a request body does not crash the relay worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-abort-'));
  const script = `
    import http from 'node:http';
    import net from 'node:net';
    import fs from 'node:fs';
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const upstream = http.createServer((req, res) => { res.end('ok'); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    fs.writeFileSync(root + '/client.json', JSON.stringify({
      match: ['approved-agent'], isolation: 'strict',
      services: { 'mcp-relay': { host: '127.0.0.1', port: upstream.address().port, protocol: 'http', auth: 'none' } },
    }));
    const relay = startApiRelay({ port: 0, host: '127.0.0.1', clientsDir: root,
      hostnameResolver: () => 'approved-agent',
      env: { HTTP_PROXY: 'http://127.0.0.1:1', SNI_BRIDGE_PORT: '0', RELAY_REQUIRE_KNOWN_CLIENTS: '1' },
    });
    if (!relay.server.listening) await once(relay.server, 'listening');
    const relayPort = relay.server.address().port;
    try {
      // Content-Length promises 100 bytes, 5 arrive, then the socket dies.
      const socket = net.connect(relayPort, '127.0.0.1');
      await once(socket, 'connect');
      socket.write('POST /mcp-relay/mcp/carapa-board HTTP/1.1\\r\\nHost: relay\\r\\nContent-Type: application/json\\r\\nContent-Length: 100\\r\\n\\r\\n{"met');
      await new Promise(resolve => setTimeout(resolve, 100));
      socket.destroy();
      await new Promise(resolve => setTimeout(resolve, 300));
      const body = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: relayPort, path: '/mcp-relay/mcp/carapa-board' }, response => {
          let text = '';
          response.on('data', chunk => { text += chunk; });
          response.on('end', () => resolve(text));
        }).on('error', reject);
      });
      assert.equal(body, 'ok');
    } finally {
      relay.server.closeAllConnections(); relay.close();
      upstream.closeAllConnections(); upstream.close();
    }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (await child.exited !== 0) throw new Error(stderr + stdout);
    expect(await child.exited).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
