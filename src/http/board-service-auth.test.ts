import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Board API credential manages relay tokens without granting general admin access', () => {
  // The real token store resolves its persistent path at import time. Keep this
  // round trip in a child with a private cwd, away from controller state.
  const root = mkdtempSync(join(tmpdir(), 'box-relay-auth-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import assert from 'node:assert/strict';
      const { handleBunRequest } = await import(process.env.HTTP_HANDLER);
      const api = 'test-board-api';
      const admin = 'test-operator-admin';
      process.env.CARAPA_BOX_API_TOKEN = api;
      delete process.env.CARAPA_BOX_ADMIN_TOKEN;
      const endpoint = '/api/admin/relay-token/carapa-bot-test-agent-1';
      const call = (method, path, token, body) => handleBunRequest(new Request('http://localhost' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
      for (const configuredAdmin of [undefined, admin]) {
        if (configuredAdmin) process.env.CARAPA_BOX_ADMIN_TOKEN = configuredAdmin;
        for (const suffix of ['', '?service=carapa-mail']) {
          const path = endpoint + suffix;
          assert.equal((await call('POST', path, api, { token: 'old-scoped-token' })).status, 200);
          assert.deepEqual(await (await call('GET', path, api)).json(), { token: 'old-scoped-token' });
          assert.equal((await call('PUT', path, api, { token: 'fresh-scoped-token' })).status, 200);
          assert.deepEqual(await (await call('GET', path, api)).json(), { token: 'fresh-scoped-token' });
          if (configuredAdmin) {
            assert.deepEqual(await (await call('GET', path, admin)).json(), { token: 'fresh-scoped-token' });
          }
          assert.equal((await call('DELETE', path, api)).status, 200);
          assert.equal((await call('GET', path, api)).status, 404);
        }
      }
      for (const token of [undefined, 'wrong-token']) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          assert.equal((await call(method, endpoint, token, method === 'POST' || method === 'PUT' ? { token: 'rejected' } : undefined)).status, 401);
        }
      }
      for (const path of ['/api/admin/config', '/api/admin/stacks', '/api/admin/logs',
        '/api/admin/relay-token', '/api/admin/relay-token/test/extra', '/api/admin/relay-token-other/test']) {
        assert.equal((await call('GET', path, api)).status, 401);
      }
      assert.equal((await call('PATCH', endpoint, api)).status, 401);
      assert.equal((await call('GET', '/api/tools', admin)).status, 401);
      delete process.env.CARAPA_BOX_API_TOKEN;
      assert.equal((await call('GET', endpoint)).status, 401);
      // The production module owns maintenance timers; this disposable peer
      // has finished all requests and must not wait for those timers.
      process.exit(0);
    `], {
      cwd: root,
      env: {
        PATH: process.env.PATH || '',
        SECRETS_DIR: root,
        LOG_LEVEL: 'silent',
        HTTP_HANDLER: new URL('./server.ts', import.meta.url).href,
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
});

test('relay-identity resolves a registered compose project and accepts the API token only on GET of that exact path', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-relay-identity-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import assert from 'node:assert/strict';
      const { handleBunRequest } = await import(process.env.HTTP_HANDLER);
      const { registerStackProject } = await import(process.env.POLICY);
      process.env.CARAPA_BOX_API_TOKEN = 'api';
      process.env.CARAPA_BOX_ADMIN_TOKEN = 'admin';
      registerStackProject('carapa-projects-carapa', 'carapa-projects');
      registerStackProject('carapa-projects', 'carapa-projects');
      registerStackProject('other', 'carapa-projects');
      const call = (method, path, token) => handleBunRequest(new Request('http://localhost' + path, {
        method, headers: token ? { Authorization: 'Bearer ' + token } : {} }));
      const base = '/api/admin/relay-identity/';
      for (const token of ['api', 'admin']) {
        const ok = await call('GET', base + 'carapa-projects-carapa', token);
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { stack: 'carapa-projects', instance: 'carapa' });
        for (const name of ['unknown', 'carapa-projects', 'other']) assert.equal((await call('GET', base + name, token)).status, 404);
        for (const name of ['bad.name', 'a%20b', 'x'.repeat(129)]) assert.equal((await call('GET', base + name, token)).status, 400);
      }
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call(method, base + 'carapa-projects-carapa', 'api')).status, 401);
      for (const path of [base.slice(0, -1), base + 'a/b']) assert.equal((await call('GET', path, 'api')).status, 401);
      assert.equal((await call('GET', base + 'carapa-projects-carapa')).status, 401);
      process.exit(0);
    `], {
      cwd: root,
      env: {
        PATH: process.env.PATH || '',
        SECRETS_DIR: root,
        LOG_LEVEL: 'silent',
        HTTP_HANDLER: new URL('./server.ts', import.meta.url).href,
        POLICY: new URL('../network-policy.ts', import.meta.url).href,
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
});
