import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real fetch handler in a child with a private cwd/secrets dir, so the
// module-level state it creates never touches the repo tree.
function runChild(script: string): void {
  const root = mkdtempSync(join(tmpdir(), 'box-origin-guard-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: root,
      env: {
        PATH: process.env.PATH || '',
        SECRETS_DIR: root,
        LOG_LEVEL: 'silent',
        HTTP_HANDLER: new URL('./server.ts', import.meta.url).href,
        REGISTRY: new URL('../tools/register.ts', import.meta.url).href,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PRELUDE = `
  import assert from 'node:assert/strict';
  const { handleBunRequest } = await import(process.env.HTTP_HANDLER);
  const { toolRegistry } = await import(process.env.REGISTRY);
  let runs = 0;
  toolRegistry.set('probe_tool', { description: 'probe', schema: {}, handler: async () => { runs++; return { content: [{ type: 'text', text: 'ok' }] }; } });
  const call = (path, headers, method = 'POST', body = '{}') => handleBunRequest(new Request('http://127.0.0.1:3100' + path, {
    method, headers, ...(method === 'POST' ? { body } : {}) }));
  const mcpInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
`;

test('no-token mode rejects browser requests with a foreign Origin or Host and still serves local processes', () => {
  runChild(PRELUDE + `
    delete process.env.CARAPA_BOX_API_TOKEN;
    // Simple CORS request: text/plain, no custom headers, no preflight.
    const simple = { 'Content-Type': 'text/plain', Origin: 'https://evil.example', Host: '127.0.0.1:3100' };
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example:3100', 'not a url']) {
      const res = await call('/api/tools/probe_tool', { ...simple, Origin: origin });
      assert.equal(res.status, 403, 'tools Origin ' + origin);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await call('/api/tools', simple, 'GET')).status, 403);
    assert.equal(runs, 0, 'handler must not run for a foreign Origin');

    // MCP endpoint, foreign Origin.
    const mcp = await call('/api/mcp', { ...mcpHeaders, Origin: 'https://evil.example', Host: '127.0.0.1:3100' }, 'POST', mcpInit);
    assert.equal(mcp.status, 403);
    assert.equal(mcp.headers.get('access-control-allow-origin'), null);

    // DNS rebinding: attacker name resolves to 127.0.0.1, no cross-origin Origin.
    for (const host of ['evil.example:3100', 'evil.example', '127.0.0.1.evil.example:3100']) {
      assert.equal((await call('/api/tools/probe_tool', { Host: host })).status, 403, 'tools Host ' + host);
      assert.equal((await call('/api/mcp', { ...mcpHeaders, Host: host }, 'POST', mcpInit)).status, 403, 'mcp Host ' + host);
    }
    assert.equal(runs, 0);

    // Preflight from a foreign Origin gets no ACAO and no echoed headers.
    const pre = await call('/api/tools/probe_tool', {
      Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-evil' }, 'OPTIONS');
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-headers'), null);

    // Local non-browser processes and loopback pages keep working.
    for (const headers of [{ Host: '127.0.0.1:3100' }, { Host: 'localhost:3100' }, { Host: '[::1]:3100' },
      { Host: '127.0.0.1:3100', Origin: 'http://localhost:5173' }]) {
      assert.equal((await call('/api/tools/probe_tool', headers)).status, 200, JSON.stringify(headers));
    }
    assert.equal((await call('/api/mcp', { ...mcpHeaders, Host: '127.0.0.1:3100' }, 'POST', mcpInit)).status, 200);
    const okPre = await call('/api/mcp', { Origin: 'http://localhost:5173' }, 'OPTIONS');
    assert.equal(okPre.status, 204);
    process.exit(0);
  `);
});

test('token mode never answers a foreign-Origin preflight with a wildcard', () => {
  runChild(PRELUDE + `
    process.env.CARAPA_BOX_API_TOKEN = 'tok';
    const pre = await call('/api/mcp', { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'authorization' }, 'OPTIONS');
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-headers'), null);
    // Authenticated calls are unchanged, whatever the Host.
    const ok = await call('/api/tools/probe_tool', { Authorization: 'Bearer tok', Host: 'box.internal:3100' });
    assert.equal(ok.status, 200);
    assert.equal((await call('/api/tools/probe_tool', { Host: 'box.internal:3100' })).status, 401);
    process.exit(0);
  `);
});
