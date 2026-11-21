import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { ProviderAccounts } from './provider-accounts.js';
import { isMountPathAllowed } from './security.js';
import { handleBunRequest } from './http/server.js';
// @ts-ignore -- standalone relay modules
import { anthropicAdminKeys, applyProviderAccounts, readAccountRegistry } from '../egress-proxy/api-relay/provider-account-config.mjs';
// @ts-ignore -- shared encryption at rest
import { configureCredentialSealing } from '../egress-proxy/api-relay/credential-crypto.mjs';
// @ts-ignore -- production callback validator
import { authorization, validateCallback } from '../egress-proxy/provider-login/worker.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-account-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const save = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
type Docker = (args: string[]) => Promise<{ status: number; stdout?: string; stderr?: string }>;
function fixture(name: string, docker?: Docker, harnessVolume?: string, request?: typeof fetch, extra: Record<string, unknown> = {}) {
  const directory = path.join(root, name);
  const clientsDirectory = path.join(root, name + '-clients');
  fs.mkdirSync(clientsDirectory);
  save(path.join(clientsDirectory, 'private.json'), { match: ['carapa-bot-private-agent-1'], isolation: 'strict', providers: {} });
  const calls: string[][] = [];
  const options = { directory, hostDirectory: directory, clientsDirectory, helperDirectory: '/trusted/helper', image: 'trusted:test',
    network: 'egress_proxy', uid: '1000:1000', proxy: 'http://squid:3128', harnessVolume, request, ...extra,
    docker: docker ?? (async (args: string[]) => { calls.push(args); return { status: 0 }; }) };
  return { directory, calls, manager: new ProviderAccounts(options), restart: () => new ProviderAccounts(options) };
}
const credential = { tokens: { access_token: 'test-only-access', refresh_token: 'test-only-refresh', account_id: 'test-account' } };

test('provider credentials reject overlapping mounts and use existing authenticated Box access', async () => {
  const keys = ['PROVIDER_ACCOUNTS_HOST_DIR', 'PROVIDER_ACCOUNTS_DIR', 'PROVIDER_RELAY_CLIENTS_DIR', 'CARAPA_BOX_API_TOKEN', 'CARAPA_BOX_ADMIN_TOKEN', 'DOCKER_HOST'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    // The HTTP routes use the configured manager, which runs real Docker: point
    // it at no daemon so a cancel never reaches the host's Docker.
    process.env.DOCKER_HOST = 'unix://' + path.join(root, 'no-docker.sock');
    process.env.PROVIDER_ACCOUNTS_HOST_DIR = path.join(root, 'secret');
    fs.mkdirSync(process.env.PROVIDER_ACCOUNTS_HOST_DIR);
    fs.symlinkSync(process.env.PROVIDER_ACCOUNTS_HOST_DIR, path.join(root, 'alias'));
    for (const candidate of ['/', root, path.join(root, 'secret'), path.join(root, 'secret', 'credentials'), path.join(root, 'alias')]) {
      expect(await isMountPathAllowed(candidate)).toBe(false);
    }
    const request = (token = '') => new Request('http://localhost/api/admin/provider-accounts', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    const configured = fixture('http-auth');
    process.env.PROVIDER_ACCOUNTS_DIR = configured.directory;
    process.env.PROVIDER_RELAY_CLIENTS_DIR = path.join(root, 'http-auth-clients');
    delete process.env.CARAPA_BOX_API_TOKEN;
    delete process.env.CARAPA_BOX_ADMIN_TOKEN;
    expect((await handleBunRequest(request())).status).toBe(503);
    process.env.CARAPA_BOX_API_TOKEN = 'test-infrastructure';
    expect((await handleBunRequest(request('test-infrastructure'))).status).toBe(200);
    process.env.CARAPA_BOX_ADMIN_TOKEN = 'test-infrastructure';
    expect((await handleBunRequest(request('test-infrastructure'))).status).toBe(200);
    process.env.CARAPA_BOX_ADMIN_TOKEN = 'test-admin-override';
    expect((await handleBunRequest(request())).status).toBe(401);
    expect((await handleBunRequest(request('wrong-token'))).status).toBe(401);
    expect((await handleBunRequest(request('test-infrastructure'))).status).toBe(200);
    expect((await handleBunRequest(request('test-admin-override'))).status).toBe(200);
    const missingLogin = '00000000-0000-0000-0000-000000000000';
    for (const [method, suffix] of [['POST', '/login'], ['POST', `/login/${missingLogin}/complete`], ['DELETE', `/login/${missingLogin}`]]) {
      const call = (token: string) => handleBunRequest(new Request('http://localhost/api/admin/provider-accounts' + suffix, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }));
      // Invalid input reaches the handler without starting a login worker. Cancel
      // validates only the ID, so its result depends on Docker; it must just pass auth.
      const authorized = (await call('test-infrastructure')).status;
      if (method === 'DELETE') expect(authorized).not.toBe(401);
      else expect(authorized).toBe(400);
      expect((await call('wrong-token')).status).toBe(401);
    }
    for (const [method, suffix] of [['DELETE', ''], ['GET', '/login'], ['POST', '/login/extra'], ['GET', '-other']]) {
      expect((await handleBunRequest(new Request('http://localhost/api/admin/provider-accounts' + suffix, {
        method, headers: { Authorization: 'Bearer test-infrastructure' },
      }))).status).toBe(401);
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('cleanup retry cannot overwrite credentials already rotated after installation', async () => {
  const f = fixture('cleanup-retry');
  const { id } = await f.manager.start({ provider: 'codex', label: 'Shared', scope: 'shared' });
  const dir = path.join(f.directory, 'attempts', id);
  const attempt = JSON.parse(fs.readFileSync(path.join(dir, 'attempt.json'), 'utf8'));
  save(path.join(dir, 'profile', 'result.json'), credential);
  save(path.join(dir, 'profile', 'status.json'), { state: 'completed' });
  // Represents a committed registry followed by interrupted worker cleanup.
  save(path.join(f.directory, 'accounts.json'), [attempt.account]);
  const file = path.join(f.directory, 'credentials', attempt.account.credentialId + '.json');
  const rotated = { tokens: { ...credential.tokens, refresh_token: 'new-rotated-session' } };
  save(file, rotated);
  expect((await f.restart().list()).accounts).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(rotated);
  expect(fs.existsSync(dir)).toBe(false);
});

test('cleanup revalidates the attempts directory after Docker awaits', async () => {
  const attemptsRoot = path.join(root, 'cleanup-symlink', 'attempts');
  const outside = path.join(root, 'cleanup-symlink-target');
  let replaceAttempts = false;
  const f = fixture('cleanup-symlink', async (args) => {
    if (replaceAttempts && args[0] === 'rm') {
      replaceAttempts = false;
      fs.renameSync(attemptsRoot, attemptsRoot + '.moved');
      fs.mkdirSync(outside);
      save(path.join(outside, 'sentinel'), { preserved: true });
      fs.symlinkSync(outside, attemptsRoot, 'dir');
    }
    return { status: 0 };
  });
  const { id } = await f.manager.start({ provider: 'codex', label: 'Shared', scope: 'shared' });
  const attemptDir = path.join(attemptsRoot, id);
  save(path.join(attemptDir, 'profile', 'result.json'), credential);
  save(path.join(attemptDir, 'profile', 'status.json'), { state: 'completed' });
  replaceAttempts = true;

  await expect(f.manager.list()).rejects.toThrow();
  expect(fs.lstatSync(attemptsRoot).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(outside, 'sentinel'))).toBe(true);
});

test('login survives controller recreation, imports atomically and never exposes native tokens to Board', async () => {
  const f = fixture('restart', undefined, 'carapa-bot-harness-test');
  const { id } = await f.manager.start({ provider: 'codex', label: 'Private account', scope: 'client', client: 'private' });
  const run = f.calls[0];
  expect(run).toContain('--read-only'); expect(run).toContain('--log-driver=none'); expect(run).toContain('--pull=never');
  expect(run).toContain('type=volume,source=carapa-bot-harness-test,target=/opt/carapa-harness,readonly,volume-nocopy');
  expect(run.join(' ')).not.toContain('AGENT_HOME'); expect(run.join(' ')).not.toContain('agent_egress');
  const attemptDir = path.join(f.directory, 'attempts', id);
  save(path.join(attemptDir, 'profile', 'status.json'), { state: 'waiting', authorizationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', input: 'none', access_token: 'must-not-export' });
  const restarted = f.restart();
  expect(JSON.stringify(await restarted.list())).not.toContain('must-not-export');
  save(path.join(attemptDir, 'profile', 'result.json'), credential);
  save(path.join(attemptDir, 'profile', 'status.json'), { state: 'completed' });
  const result = await restarted.list();
  expect(result.accounts).toHaveLength(1); expect(result.logins).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('test-only');
  const registry = JSON.parse(fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8'));
  const file = path.join(f.directory, 'credentials', registry[0].credentialId + '.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(credential);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(attemptDir)).toBe(false);
  const applied = applyProviderAccounts(f.directory, { defaults: null, clients: [{ name: 'private', isolation: 'strict', providers: {}, services: {} }] });
  expect(applied.clients[0].providers.codex.credentialFile).toBe(file);
  expect(applied.defaults).toBeNull();
  expect(() => applyProviderAccounts(f.directory, { defaults: null, clients: [] })).toThrow('missing');
  const reconnect = await restarted.start({ provider: 'codex', label: 'Replacement', scope: 'client', client: 'private' });
  save(path.join(f.directory, 'attempts', reconnect.id, 'profile', 'status.json'), { state: 'failed' });
  expect((await restarted.list()).accounts[0].label).toBe('Private account');
  await restarted.cancel(reconnect.id);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(credential);
});

test('callback routing rejects SSRF, stale state, duplicate parameters, and repeated submissions', async () => {
  const claude = 'https://claude.com/cai/oauth/authorize?' + new URLSearchParams({ state: 'test-state', redirect_uri: 'https://platform.claude.com/oauth/code/callback', response_type: 'code' });
  expect(authorization('anthropic', claude).state).toBe('test-state');
  const redirect = 'http://127.0.0.1:12345/';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ state: 'test-state', redirect_uri: redirect, response_type: 'code' });
  const auth = authorization('antigravity', url);
  const callback = redirect + '?state=test-state&code=test-code';
  expect(validateCallback(auth, callback).hostname).toBe('127.0.0.1');
  for (const bad of ['http://169.254.169.254/?state=test-state&code=x', callback.replace('12345', '12346'), callback.replace('test-state', 'other'), callback + '&code=again']) {
    expect(() => validateCallback(auth, bad)).toThrow();
  }
  expect(() => authorization('antigravity', url.replace('accounts.google.com', 'example.com'))).toThrow();
  const meta = 'https://auth.meta.com/oauth/device/?code=ABCD-1234';
  expect(authorization('meta', meta)).toEqual({ url: meta, userCode: 'ABCD-1234' });
  for (const bad of [meta.replace('auth.meta.com', 'auth.meta.com.example.org'), meta + '&redirect=https://example.org',
    meta.replace('/oauth/device/', '/oauth/authorize/'), meta.replace('ABCD-1234', 'abcd<script>')]) {
    expect(() => authorization('meta', bad)).toThrow();
  }
  const grok = 'https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234';
  expect(authorization('xai', grok)).toEqual({ url: grok, userCode: 'WXYZ-1234' });
  expect(authorization('xai', 'https://accounts.x.ai/oauth2/device')).toEqual({ url: 'https://accounts.x.ai/oauth2/device' });
  for (const bad of [grok.replace('accounts.x.ai', 'accounts.x.ai.example.org'), grok + '&redirect=https://example.org',
    grok.replace('/oauth2/device', '/oauth2/authorize'), grok.replace('WXYZ-1234', 'abcd<script>')]) {
    expect(() => authorization('xai', bad)).toThrow();
  }
  const cursor = 'https://cursor.com/loginDeepControl?challenge=zOtgPjGp-3wXusR1cQRfepnm8pSCkxkdPcuS3XTIaPE&uuid=8480fa1d-aa6d-4740-829a-b5d7cc5ba0eb&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true';
  expect(authorization('cursor', cursor)).toEqual({ url: cursor });
  for (const bad of [cursor.replace('cursor.com', 'cursor.com.example.org'), cursor + '&redirect=https://example.org',
    cursor.replace('/loginDeepControl', '/login'), cursor.replace('mode=login', 'mode=signup'), cursor + '&uuid=8480fa1d-aa6d-4740-829a-b5d7cc5ba0eb']) {
    expect(() => authorization('cursor', bad)).toThrow();
  }
  const f = fixture('callback');
  const { id } = await f.manager.start({ provider: 'antigravity', scope: 'shared', label: 'Google' });
  save(path.join(f.directory, 'attempts', id, 'profile', 'status.json'), { state: 'waiting', authorizationUrl: url, input: 'callback' });
  await expect(f.manager.complete(id, callback.replace('test-state', 'other'))).rejects.toThrow();
  await f.manager.complete(id, callback);
  await expect(f.manager.complete(id, callback)).rejects.toThrow();
  await expect(f.manager.cancel('../credentials')).rejects.toThrow();
  await f.manager.cancel(id);
});

async function completed(f: ReturnType<typeof fixture>, input: any, result: unknown) {
  const { id } = await f.manager.start(input);
  const dir = path.join(f.directory, 'attempts', id);
  save(path.join(dir, 'profile', 'result.json'), result);
  save(path.join(dir, 'profile', 'status.json'), { state: 'completed' });
  return { id, dir };
}
const removals = (calls: string[][]) => calls.filter(c => c[0] === 'rm');

test('completed login without a refresh token is cleaned up instead of breaking list()', async () => {
  const f = fixture('poison-no-refresh');
  const { dir } = await completed(f, { provider: 'codex', label: 'Shared', scope: 'shared' }, { tokens: { access_token: 'test-only-access' } });
  f.calls.length = 0;
  const result = await f.manager.list();
  expect(result.accounts).toHaveLength(0); expect(result.logins).toHaveLength(0);
  expect(fs.existsSync(dir)).toBe(false);
  expect(removals(f.calls)).toHaveLength(1);
  await f.manager.list();
  expect(removals(f.calls)).toHaveLength(1);
});

test('completed client login whose relay client was deleted is cleaned up', async () => {
  const f = fixture('poison-no-client');
  const { dir } = await completed(f, { provider: 'codex', label: 'Private', scope: 'client', client: 'private' }, credential);
  fs.rmSync(path.join(f.directory + '-clients', 'private.json'));
  f.calls.length = 0;
  const result = await f.manager.list();
  expect(result.accounts).toHaveLength(0);
  expect(fs.existsSync(dir)).toBe(false);
  expect(removals(f.calls)).toHaveLength(1);
});

test('valid completed login is installed and cleaned up', async () => {
  const f = fixture('valid-completed');
  const { dir } = await completed(f, { provider: 'codex', label: 'Shared', scope: 'shared' }, credential);
  f.calls.length = 0;
  expect((await f.manager.list()).accounts).toHaveLength(1);
  const registry = JSON.parse(fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8'));
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'credentials', registry[0].credentialId + '.json'), 'utf8'))).toEqual(credential);
  expect(fs.existsSync(dir)).toBe(false);
  expect(removals(f.calls)).toHaveLength(1);
});

test('Meta login installs its minted API key without a refresh token', async () => {
  const f = fixture('meta-completed');
  const muse = { schema_version: 1, providers: { meta: { mechanism: 'oauth', obtained_via: 'device_code',
    access_token: 'test-only-access', api_key: 'test-only-key', api_base_url: 'https://api.meta.ai/v1', subs_active: true } } };
  await completed(f, { provider: 'meta', label: 'Muse', scope: 'shared' }, muse);
  const result = await f.manager.list();
  expect(result.accounts.map((a: any) => [a.provider, a.state])).toEqual([['meta', 'connected']]);
  const account = JSON.parse(fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8'))[0];
  expect((await f.manager.usage()).usage[account.id].error).toBeString();
  (f.manager as any).usageCache.clear();
  fs.mkdirSync(path.join(f.directory, 'usage'));
  save(path.join(f.directory, 'usage', account.credentialId + '.json'), { observedAt: 1, subscription: {
    weekly: { resets_at: 4102444800, used_percent: 20 }, window: { resets_at: 4102444800, used_percent: 60, window_duration_mins: 300 } } });
  expect((await f.manager.usage()).usage[account.id]).toEqual({ fetchedAt: 1, windows: [
    { label: '5-hour', usedPercent: 60, resetsAt: 4102444800000 }, { label: 'Weekly', usedPercent: 20, resetsAt: 4102444800000 }] });
  const missingKey = await completed(f, { provider: 'meta', label: 'Muse', scope: 'shared' },
    { schema_version: 1, providers: { meta: { ...muse.providers.meta, api_key: undefined } } });
  await f.manager.list();
  expect(fs.existsSync(missingKey.dir)).toBe(false);
});

test('usage reports the OpenRouter balance and Anthropic API spend the relay recorded', async () => {
  const f = fixture('openrouter-credits');
  expect((await f.manager.usage()).credits).toBeUndefined();
  fs.mkdirSync(path.join(f.directory, 'usage'));
  save(path.join(f.directory, 'usage', 'openrouter.json'), { observedAt: 5, totalCredits: 10, totalUsage: 2.5 });
  expect((await f.manager.usage()).credits).toEqual({ provider: 'openrouter', totalCredits: 10, totalUsage: 2.5, remaining: 7.5, fetchedAt: 5 });
  expect((await f.manager.usage()).apiSpend).toBeUndefined();
  save(path.join(f.directory, 'usage', 'anthropic-api.json'), { observedAt: 6, periodStart: '2026-10-01T00:00:00Z', spent: 2.2, models: { 'claude-opus-5-5': 2, bad: 'x' } });
  expect((await f.manager.usage()).apiSpend).toEqual({ provider: 'anthropic-api', spent: 2.2, periodStart: '2026-10-01T00:00:00Z', models: { 'claude-opus-5-5': 2 }, fetchedAt: 6 });
  expect((await f.manager.usage()).openRouterPrices).toBeUndefined();
  const models = { 'a/b': { name: 'A: B', input: 0.14, output: 0.28 } };
  save(path.join(f.directory, 'usage', 'openrouter-prices.json'), { observedAt: 6, models });
  expect((await f.manager.usage()).openRouterPrices).toEqual({ models, fetchedAt: 6 });
});

test('a poisoned login does not block a valid one', async () => {
  const f = fixture('poison-and-valid');
  const bad = await completed(f, { provider: 'anthropic', label: 'Bad', scope: 'shared' }, { tokens: {} });
  const good = await completed(f, { provider: 'codex', label: 'Good', scope: 'shared' }, credential);
  const result = await f.manager.list();
  expect(result.accounts.map((a: any) => a.label)).toEqual(['Good']);
  expect(fs.existsSync(bad.dir)).toBe(false); expect(fs.existsSync(good.dir)).toBe(false);
});

test('tier and capacity estimates are set, changed, cleared and listed', async () => {
  const f = fixture('estimates');
  await completed(f, { provider: 'codex', label: 'Shared', scope: 'shared' }, credential);
  const [{ id }] = (await f.manager.list()).accounts;
  const registry = path.join(f.directory, 'accounts.json');
  expect(await f.manager.update(id, { tier: '  max 5x ', capacity: 500 })).toMatchObject({ id, tier: 'max 5x', capacity: 500 });
  expect((await f.manager.list()).accounts[0]).toMatchObject({ tier: 'max 5x', capacity: 500 });
  await f.manager.update(id, { capacity: 100 });
  expect((await f.manager.list()).accounts[0]).toMatchObject({ tier: 'max 5x', capacity: 100 });
  await f.manager.update(id, { tier: null });
  const cleared = await f.manager.update(id, { capacity: null });
  expect(cleared.tier).toBeUndefined(); expect(cleared.capacity).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(registry, 'utf8'))[0]).not.toHaveProperty('tier');
  expect(JSON.parse(fs.readFileSync(registry, 'utf8'))[0]).not.toHaveProperty('capacity');
});

test('invalid estimate edits are rejected and leave the registry unchanged', async () => {
  const f = fixture('estimate-validation');
  await completed(f, { provider: 'codex', label: 'Shared', scope: 'shared' }, credential);
  const [{ id }] = (await f.manager.list()).accounts;
  const registry = path.join(f.directory, 'accounts.json');
  expect((await f.manager.update(id, { capacity: 1000, tier: 'pro' })).capacity).toBe(1000);
  const saved = fs.readFileSync(registry, 'utf8');
  for (const bad of [{ capacity: 0 }, { capacity: 1001 }, { capacity: 2.5 }, { capacity: '10' }, { tier: '' }, { tier: '   ' },
    { tier: 'x'.repeat(41) }, { tier: 'pro', id: 'x' }, ['pro'], null]) {
    await expect(f.manager.update(id, bad)).rejects.toThrow();
  }
  await expect(f.manager.update('00000000-0000-0000-0000-000000000000', { tier: 'pro' })).rejects.toThrow();
  expect(fs.readFileSync(registry, 'utf8')).toBe(saved);
});

test('the label is renamed with tier and capacity, and invalid labels leave the registry unchanged', async () => {
  const f = fixture('label-rename');
  await completed(f, { provider: 'codex', label: 'Shared', scope: 'shared' }, credential);
  const [{ id }] = (await f.manager.list()).accounts;
  const registry = path.join(f.directory, 'accounts.json');
  const saved = fs.readFileSync(registry, 'utf8');
  for (const label of ['', '   ', null, 7, 'x'.repeat(81)]) {
    await expect(f.manager.update(id, { label })).rejects.toThrow('Invalid provider account label');
  }
  expect(fs.readFileSync(registry, 'utf8')).toBe(saved);
  expect(await f.manager.update(id, { label: '  claude max 20x ', tier: 'max 20x', capacity: 1000 })).toMatchObject({ id, label: 'claude max 20x', tier: 'max 20x', capacity: 1000 });
  expect((await f.manager.list()).accounts[0]).toMatchObject({ label: 'claude max 20x', tier: 'max 20x', capacity: 1000 });
  // The relay reads the same registry, so a renamed account must still load.
  expect(readAccountRegistry(f.directory)).toMatchObject([{ id, label: 'claude max 20x' }]);
});

test('a re-login keeps the tier and capacity estimates of the account', async () => {
  const f = fixture('estimate-relogin');
  const target = { provider: 'codex', label: 'Private', scope: 'client', client: 'private' } as const;
  await completed(f, target, credential);
  const [{ id }] = (await f.manager.list()).accounts;
  await f.manager.update(id, { tier: 'pro', capacity: 100 });
  const registry = path.join(f.directory, 'accounts.json');
  const previousCredential = JSON.parse(fs.readFileSync(registry, 'utf8'))[0].credentialId;
  await completed(f, { ...target, accountId: id }, { tokens: { ...credential.tokens, refresh_token: 'rotated-refresh' } });
  expect((await f.manager.list()).accounts).toMatchObject([{ id, tier: 'pro', capacity: 100 }]);
  expect(JSON.parse(fs.readFileSync(registry, 'utf8'))[0].credentialId).not.toBe(previousCredential);
  // A login that names no account adds a second one for the same provider and client.
  await completed(f, { ...target, label: 'Business' }, credential);
  const accounts = (await f.manager.list()).accounts;
  expect(accounts).toMatchObject([{ id, label: 'Private' }, { label: 'Business', provider: 'codex', client: 'private' }]);
  expect(accounts[1].id).not.toBe(id);
  await expect(f.manager.start({ ...target, accountId: crypto.randomUUID() })).rejects.toThrow('The account list changed; reload and try again');
  // Removing an account deletes its credential and leaves the other one in place.
  const removedCredential = JSON.parse(fs.readFileSync(registry, 'utf8'))[0].credentialId;
  expect((await f.manager.remove(id)).accounts).toMatchObject([{ id: accounts[1].id, label: 'Business' }]);
  expect(fs.existsSync(path.join(f.directory, 'credentials', removedCredential + '.json'))).toBe(false);
  expect(readAccountRegistry(f.directory)).toHaveLength(1);
  await expect(f.manager.remove(id)).rejects.toThrow('The account list changed; reload and try again');
});

test('the manual account order is stored, rejects a stale list, and survives a re-login', async () => {
  const f = fixture('order');
  const idsOf = (accounts: { id: string }[]) => accounts.map(a => a.id);
  const claude = { claudeAiOauth: { accessToken: 'test-only-access', refreshToken: 'test-only-refresh', expiresAt: Date.now() + 3_600_000 } };
  const target = (label: string) => ({ provider: 'codex', label, scope: 'client', client: 'private' }) as const;
  await completed(f, { provider: 'codex', label: 'A', scope: 'shared' }, credential);
  await completed(f, target('B'), credential);
  await completed(f, { provider: 'anthropic', label: 'C', scope: 'shared' }, claude);
  const registry = path.join(f.directory, 'accounts.json');
  const ids = idsOf((await f.manager.list()).accounts);
  expect(ids).toHaveLength(3);
  const before: { id: string }[] = JSON.parse(fs.readFileSync(registry, 'utf8'));
  const order = [ids[2], ids[0], ids[1]];
  const result = await f.manager.reorder(order);
  expect(idsOf(result.accounts)).toEqual(order);
  expect(idsOf((await f.manager.list()).accounts)).toEqual(order);
  const saved: { id: string }[] = JSON.parse(fs.readFileSync(registry, 'utf8'));
  expect(idsOf(saved)).toEqual(order);
  expect(saved).toEqual([before[2], before[0], before[1]]);
  const text = fs.readFileSync(registry, 'utf8');
  for (const bad of [[ids[0], ids[1]], [...ids, ids[0]], [ids[0], ids[0], ids[1]], [ids[0], ids[1], crypto.randomUUID()], [ids[0], ids[1], 7], 'abc', null, { ids }]) {
    await expect(f.manager.reorder(bad)).rejects.toThrow('The account list changed; reload and try again');
  }
  expect(fs.readFileSync(registry, 'utf8')).toBe(text);
  // A re-login of the middle account keeps its position; a genuinely new account goes last.
  await completed(f, { provider: 'codex', label: 'A again', scope: 'shared', accountId: ids[0] }, credential);
  expect(idsOf((await f.manager.list()).accounts)).toEqual(order);
  await completed(f, { ...target('B'), accountId: ids[1] }, credential);
  expect(idsOf((await f.manager.list()).accounts)).toEqual(order);
  await completed(f, { provider: 'anthropic', label: 'E', scope: 'client', client: 'private' }, claude);
  const final = (await f.manager.list()).accounts;
  expect(final).toHaveLength(4);
  expect(idsOf(final.slice(0, 3))).toEqual(order);
  expect(final[3].label).toBe('E');
});

test('hand-edited invalid estimates are ignored and the relay still loads the registry', async () => {
  const f = fixture('estimate-hand-edit');
  const shared = { id: crypto.randomUUID(), credentialId: crypto.randomUUID(), provider: 'codex', label: 'Shared', scope: 'shared', tier: 'pro', capacity: 100 };
  const hand = { id: crypto.randomUUID(), credentialId: crypto.randomUUID(), provider: 'anthropic', label: 'Private', scope: 'client', client: 'private', tier: 7, capacity: 5000 };
  fs.mkdirSync(f.directory, { recursive: true });
  save(path.join(f.directory, 'accounts.json'), [shared, hand]);
  expect((await f.manager.list()).accounts.map((a: { label: string; tier?: string; capacity?: number }) => [a.label, a.tier, a.capacity])).toEqual([['Shared', 'pro', 100], ['Private', undefined, undefined]]);
  const clients = { defaults: null, clients: [{ name: 'private', isolation: 'strict', providers: {}, services: {} }] };
  expect(applyProviderAccounts(f.directory, clients).clients[0].providers.anthropic.credentialFile).toContain(hand.credentialId);
});

test('worker mount is the profile subdirectory, never the attempt metadata', async () => {
  const f = fixture('mount-split');
  const { id } = await f.manager.start({ provider: 'codex', label: 'x', scope: 'shared' });
  const mount = f.calls[0].find(a => a.endsWith('target=/profile'))!;
  expect(mount).toBe(`type=bind,source=${path.join(f.directory, 'attempts', id, 'profile')},target=/profile`);
  expect(fs.existsSync(path.join(f.directory, 'attempts', id, 'attempt.json'))).toBe(true);
  expect(fs.existsSync(path.join(f.directory, 'attempts', id, 'profile', 'attempt.json'))).toBe(false);
});

test('a tampered attempt.json can neither escape credentials/ nor rebind an account', async () => {
  const f = fixture('tamper');
  const shared = { id: crypto.randomUUID(), credentialId: crypto.randomUUID(), provider: 'codex', label: 'org', scope: 'shared' };
  fs.mkdirSync(f.directory, { recursive: true });
  save(path.join(f.directory, 'accounts.json'), [shared]);
  const { id } = await f.manager.start({ provider: 'codex', label: 'tenant', scope: 'client', client: 'private' });
  const dir = path.join(f.directory, 'attempts', id);
  const att = JSON.parse(fs.readFileSync(path.join(dir, 'attempt.json'), 'utf8'));
  // Box-side tampering (e.g. legacy/crash remnant) must fail validation:
  save(path.join(dir, 'attempt.json'), { ...att, account: { ...att.account, credentialId: '../../ESCAPED' } });
  save(path.join(dir, 'profile', 'result.json'), credential);
  save(path.join(dir, 'profile', 'status.json'), { state: 'completed' });
  const r = await f.manager.list();
  expect(fs.existsSync(path.join(f.directory, '..', 'ESCAPED.json'))).toBe(false);
  expect(r.accounts.map((a: { label: string; scope: string }) => [a.label, a.scope])).toEqual([['org', 'shared']]);
  expect(fs.existsSync(dir)).toBe(false);
  // A worker writing attempt.json inside its own mount has no effect:
  const second = await f.manager.start({ provider: 'codex', label: 'tenant', scope: 'client', client: 'private' });
  const d2 = path.join(f.directory, 'attempts', second.id);
  const a2 = JSON.parse(fs.readFileSync(path.join(d2, 'attempt.json'), 'utf8'));
  save(path.join(d2, 'profile', 'attempt.json'), { ...a2, account: { ...a2.account, id: shared.id, scope: 'shared', client: undefined } });
  save(path.join(d2, 'profile', 'result.json'), credential);
  save(path.join(d2, 'profile', 'status.json'), { state: 'completed' });
  const after = await f.manager.list();
  expect(after.accounts.find((a: { id: string }) => a.id === shared.id)?.label).toBe('org');
  expect(after.accounts.find((a: { scope: string }) => a.scope === 'client')?.client).toBe('private');
});

test('a missing attempt.json or bad authorization URL does not wedge list/start/cancel', async () => {
  const f = fixture('wedge');
  const broken = await f.manager.start({ provider: 'codex', label: 'x', scope: 'shared' });
  fs.unlinkSync(path.join(f.directory, 'attempts', broken.id, 'attempt.json'));
  await f.manager.list();                                  // must not throw; broken attempt removed
  expect(fs.existsSync(path.join(f.directory, 'attempts', broken.id))).toBe(false);
  const ok = await f.manager.start({ provider: 'anthropic', label: 'y', scope: 'shared' });
  save(path.join(f.directory, 'attempts', ok.id, 'profile', 'status.json'), { state: 'waiting', authorizationUrl: 'https://evil.example/' });
  const listed = await f.manager.list();
  expect(listed.logins.find(l => l.id === ok.id)).toMatchObject({ state: 'failed', authorizationUrl: undefined });
  await f.manager.cancel(ok.id);
});

test('a legacy attempt without profile/ is never installed and is removed', async () => {
  const f = fixture('legacy');
  const { id } = await f.manager.start({ provider: 'codex', label: 'x', scope: 'shared' });
  const dir = path.join(f.directory, 'attempts', id);
  fs.rmSync(path.join(dir, 'profile'), { recursive: true });
  save(path.join(dir, 'result.json'), credential);        // old layout: worker files at attempt root
  save(path.join(dir, 'status.json'), { state: 'completed' });
  const r = await f.manager.list();
  expect(r.accounts).toHaveLength(0);
  expect(fs.existsSync(dir)).toBe(false);
  expect(f.calls.some(c => c[0] === 'rm' && c.includes('carapa-provider-login-' + id))).toBe(true);
});

test('an invalid attempt whose worker cannot be stopped does not wedge list()', async () => {
  let stuck = '';
  const f = fixture('stuck-invalid', async args => {
    return args.includes('carapa-provider-login-' + stuck) ? { status: 1, stderr: 'daemon busy' } : { status: 0 };
  });
  const ok = await f.manager.start({ provider: 'anthropic', label: 'y', scope: 'shared' });
  const broken = await f.manager.start({ provider: 'codex', label: 'x', scope: 'shared' });
  fs.unlinkSync(path.join(f.directory, 'attempts', broken.id, 'attempt.json'));
  stuck = broken.id;
  const listed = await f.manager.list();
  expect(listed.logins.map(l => l.id)).toEqual([ok.id]);
  expect(fs.existsSync(path.join(f.directory, 'attempts', broken.id))).toBe(true);
  await f.manager.cancel(ok.id);
});

test('a FIFO planted as status.json does not block the event loop', async () => {
  const f = fixture('fifo');
  const { id } = await f.manager.start({ provider: 'codex', label: 'x', scope: 'shared' });
  const fifo = path.join(f.directory, 'attempts', id, 'profile', 'status.json');
  execFileSync('mkfifo', [fifo]);
  // Safety valve: if a regression blocks openSync, this writer unblocks it after 2 s and keeps the
  // FIFO open, so later opens cannot block either and the assertion below fails instead of hanging.
  const writer = spawn('sh', ['-c', 'sleep 2; exec 3>"$0"; exec sleep 30', fifo], { stdio: 'ignore' });
  try {
    const t = Date.now();
    await f.manager.list();
    expect(Date.now() - t).toBeLessThan(1000);
  } finally { writer.kill('SIGKILL'); }
});

test('an API key is checked with the provider, installed without a login worker, and keeps its route settings', async () => {
  const seen: { url: string; authorization?: string }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string>).authorization;
    seen.push({ url: String(url), authorization });
    return new Response('{}', { status: authorization === 'Bearer rejected-key' ? 401 : 200 });
  }) as unknown as typeof fetch;
  const f = fixture('api-key', undefined, undefined, request);
  const input = { provider: 'mistral-vibe', label: 'Seat 2', scope: 'client', client: 'private' };
  await expect(f.manager.start({ ...input, apiKey: 'rejected-key' })).rejects.toThrow('rejected this key');
  expect((await f.manager.list()).accounts).toEqual([]);
  const { id } = await f.manager.start({ ...input, apiKey: 'accepted-key' });
  expect(f.calls).toEqual([]);
  expect(seen.at(-1)).toEqual({ url: 'https://api.eu.mistral.ai/v1/models', authorization: 'Bearer accepted-key' });
  expect((await f.manager.list()).accounts).toMatchObject([{ id, provider: 'mistral-vibe', scope: 'client', client: 'private', state: 'connected' }]);
  const [account] = readAccountRegistry(f.directory);
  const file = path.join(f.directory, 'credentials', account.credentialId + '.json');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // Reconnecting the same scope keeps the account and points it at a new key file.
  expect((await f.manager.start({ ...input, apiKey: 'second-key' })).id).toBe(id);
  const [replaced] = readAccountRegistry(f.directory);
  expect(replaced.credentialId).not.toBe(account.credentialId);
  expect(fs.existsSync(file)).toBe(false);
  const applied = applyProviderAccounts(f.directory, { defaults: { providers: { 'mistral-vibe': { host: 'api.eu.mistral.ai', auth: 'apikey',
    envKey: 'MISTRAL_VIBE_API_KEY', requestsPerSecond: 20, extraHeaders: { 'x-shared': '1' } } }, services: {} },
  clients: [{ name: 'private', isolation: 'strict', providers: {}, services: {} }] });
  expect(applied.clients[0].providers['mistral-vibe']).toEqual({ host: 'api.eu.mistral.ai', requestsPerSecond: 20, auth: 'apikey',
    keyFile: path.join(f.directory, 'credentials', replaced.credentialId + '.json') });
  // The Mistral account carries the allowance windows; the secret-based row is not repeated.
  const usage = await f.manager.usage(request);
  expect(usage.usage[id]).toBeDefined();
  expect(usage.mistralBudget).toBeUndefined();
  expect(seen.at(-1)).toEqual({ url: 'https://api.mistral.ai/v1/billing/budget', authorization: 'Bearer second-key' });
  expect((await f.manager.models(request)).models[id]).toBeUndefined();
});

test('an organisation-wide Anthropic key needs its workspace ID, and the admin key is never a relay route', async () => {
  const seen: Record<string, string>[] = [];
  const request = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url: String(url), ...headers });
    // Like Anthropic: an unscoped key without the workspace header is a bad request.
    return new Response('{}', { status: String(url).endsWith('/v1/models') && !headers['anthropic-workspace-id'] ? 400 : 200 });
  }) as unknown as typeof fetch;
  const f = fixture('anthropic-keys', undefined, undefined, request);
  const api = { provider: 'anthropic-api', label: 'API', scope: 'shared', apiKey: 'sk-ant-api-test' };
  await expect(f.manager.start(api)).rejects.toThrow('workspace ID');
  const { id } = await f.manager.start({ ...api, workspaceId: 'wrkspc_Test123' });
  expect(seen.at(-1)).toMatchObject({ url: 'https://api.anthropic.com/v1/models', 'x-api-key': 'sk-ant-api-test', 'anthropic-workspace-id': 'wrkspc_Test123' });
  await f.manager.start({ provider: 'anthropic-admin', label: 'Admin', scope: 'shared', apiKey: 'sk-ant-admin-test' });
  expect(seen.at(-1)).toMatchObject({ url: 'https://api.anthropic.com/v1/organizations/me', 'x-api-key': 'sk-ant-admin-test' });
  expect((await f.manager.list()).accounts).toMatchObject([{ id, workspaceId: 'wrkspc_Test123', state: 'connected' }, { provider: 'anthropic-admin', state: 'connected' }]);
  const applied = applyProviderAccounts(f.directory, { defaults: { providers: {}, services: {} }, clients: [] });
  expect(Object.keys(applied.defaults.providers)).toEqual(['anthropic-api']);
  expect(applied.defaults.providers['anthropic-api'].extraHeaders).toEqual({ 'anthropic-workspace-id': 'wrkspc_Test123' });
  // A project pairs its own admin key with its own API key; neither admin key becomes a route.
  await f.manager.start({ provider: 'anthropic-admin', label: 'Project admin', scope: 'client', client: 'private', apiKey: 'sk-ant-admin-project' });
  await f.manager.start({ ...api, scope: 'client', client: 'private', workspaceId: 'wrkspc_Project1' });
  const registry = readAccountRegistry(f.directory);
  const admins = registry.filter((a: { provider: string }) => a.provider === 'anthropic-admin');
  expect(anthropicAdminKeys(f.directory)).toEqual(admins.map((account: { credentialId: string }) => ({ account,
    file: path.join(f.directory, 'credentials', account.credentialId + '.json') })));
  const routed = applyProviderAccounts(f.directory, { defaults: { providers: {}, services: {} }, clients: [{ name: 'private', isolation: 'strict', providers: {}, services: {} }] });
  expect(Object.keys(routed.clients[0].providers)).toEqual(['anthropic-api']);
  // Box reports each admin key's recorded spend under its account.
  fs.mkdirSync(path.join(f.directory, 'usage'));
  const project = admins.find((a: { scope: string }) => a.scope === 'client');
  save(path.join(f.directory, 'usage', project.credentialId + '.json'), { observedAt: 7, periodStart: '2026-11-01T00:00:00Z', spent: 1.5, models: {} });
  expect((await f.manager.usage()).apiSpendByAccount).toEqual({ [project.id]: { provider: 'anthropic-api', spent: 1.5, periodStart: '2026-11-01T00:00:00Z', models: {}, fetchedAt: 7 } });
});

test('a GitLab token names its server, which replaces the route\'s configured host', async () => {
  const seen: { url: string; token?: string }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), token: (init.headers as Record<string, string>)['PRIVATE-TOKEN'] });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const f = fixture('gitlab-key', undefined, undefined, request);
  const input = { provider: 'gitlab', label: 'GitLab', scope: 'client', client: 'private', apiKey: 'glpat-test-token' };
  await expect(f.manager.start({ ...input, host: 'http://gitlab.example.com' })).rejects.toThrow('GitLab server address');
  await expect(f.manager.start({ ...input, host: 'https://gitlab.example.com/group' })).rejects.toThrow('GitLab server address');
  await f.manager.start({ ...input, host: 'https://GitLab.Example.com' });
  expect(seen).toEqual([{ url: 'https://gitlab.example.com/api/v4/personal_access_tokens/self', token: 'glpat-test-token' }]);
  const applied = applyProviderAccounts(f.directory, { defaults: { providers: { gitlab: { auth: 'apikey', envKey: 'GITLAB_PAT', envHost: 'GITLAB_HOST_URL' } }, services: {} },
    clients: [{ name: 'private', isolation: 'shared', providers: {}, services: {} }] });
  expect(applied.clients[0].providers.gitlab).toMatchObject({ host: 'gitlab.example.com', auth: 'apikey' });
  expect(applied.clients[0].providers.gitlab.envHost).toBeUndefined();
});

test('a custom integration takes a manual expiry by PATCH, set and cleared', async () => {
  const f = fixture('integration-expiry', undefined, undefined, undefined, { projectContainers: async () => ['demo-site-demo-app-php84-1'] });
  const { id } = await f.manager.start({ provider: 'custom', label: 'CRM', scope: 'project', project: { stack: 'demo-site', instance: 'demo-app' },
    route: 'crm', baseUrl: 'https://api.crm.example/v2', auth: { type: 'bearer' }, allow: [{ method: 'POST', path: '/contacts/' }], apiKey: 'crm-test-token' });
  expect(await f.manager.update(id, { expiresAt: '2027-03-01' })).toMatchObject({ expiresAt: '2027-03-01', expirySource: 'manual' });
  expect(readAccountRegistry(f.directory)[0].expiresAt).toBe('2027-03-01');
  await expect(f.manager.update(id, { expiresAt: '2027-02-30' })).rejects.toThrow('YYYY-MM-DD');
  expect((await f.manager.update(id, { expiresAt: null })) as Record<string, unknown>).not.toHaveProperty('expiresAt');
  expect(readAccountRegistry(f.directory)[0]).not.toHaveProperty('expiresAt');
});

test('a key account carries a manual expiry that a provider-reported date overrides, and an unreachable provider keeps the last check', async () => {
  let reply: () => Response = () => new Response(JSON.stringify({ expires_at: null }), { status: 200 });
  const request = (async () => reply()) as unknown as typeof fetch;
  const f = fixture('key-expiry', undefined, undefined, request);
  const login = { provider: 'gitlab', label: 'GitLab', host: 'https://gitlab.example.com', scope: 'shared', apiKey: 'glpat-expiry-key' };
  await expect(f.manager.start({ ...login, expiresAt: '2026-13-40' })).rejects.toThrow('YYYY-MM-DD');
  await expect(f.manager.start({ ...login, expiresAt: '2026-12-31T00:00:00Z' })).rejects.toThrow('YYYY-MM-DD');
  expect(readAccountRegistry(f.directory)).toEqual([]);
  const { id } = await f.manager.start({ ...login, expiresAt: '2026-12-31' });
  // The save-time check is listed at once, and the manual date shows as such.
  expect((await f.manager.list()).accounts[0]).toMatchObject({ id, state: 'connected', expiresAt: '2026-12-31', expirySource: 'manual', keyCheck: 'valid', keyCheckedAt: expect.any(Number) });
  expect(JSON.stringify(await f.manager.list())).not.toContain('glpat-expiry-key');
  expect(await f.manager.update(id, { expiresAt: '2027-01-15' })).toMatchObject({ expiresAt: '2027-01-15', expirySource: 'manual' });
  for (const bad of ['2026-13-40', '2026-02-30', '2026/12/31', 20261231, '']) await expect(f.manager.update(id, { expiresAt: bad })).rejects.toThrow('YYYY-MM-DD');
  expect(readAccountRegistry(f.directory)[0].expiresAt).toBe('2027-01-15');
  // The daily check: a provider date wins over the manual one; an unreachable provider changes nothing.
  reply = () => new Response(JSON.stringify({ expires_at: '2026-12-01' }), { status: 200 });
  await f.manager.checkKeys();
  expect((await f.manager.list()).accounts[0]).toMatchObject({ expiresAt: '2026-12-01', expirySource: 'provider', keyCheck: 'valid' });
  const checkedAt = (await f.manager.list()).accounts[0].keyCheckedAt;
  reply = () => new Response('{}', { status: 503 });
  await f.manager.checkKeys();
  expect((await f.manager.list()).accounts[0]).toMatchObject({ expiresAt: '2026-12-01', expirySource: 'provider', keyCheck: 'valid', keyCheckedAt: checkedAt });
  reply = () => new Response('{}', { status: 401 });
  await f.manager.checkKeys();
  expect((await f.manager.list()).accounts[0]).toMatchObject({ keyCheck: 'rejected', state: 'connected', expiresAt: '2026-12-01' });
  // An explicit "never expires" clears the provider date; the manual one shows again. Null clears the manual one.
  reply = () => new Response(JSON.stringify({ expires_at: null }), { status: 200 });
  await f.manager.checkKeys();
  expect((await f.manager.list()).accounts[0]).toMatchObject({ expiresAt: '2027-01-15', expirySource: 'manual', keyCheck: 'valid' });
  expect((await f.manager.update(id, { expiresAt: null })) as Record<string, unknown>).not.toHaveProperty('expiresAt');
  // Re-saving the key replaces the manual expiry: none supplied clears it.
  await f.manager.update(id, { expiresAt: '2027-01-15' });
  await f.manager.start({ ...login, apiKey: 'glpat-second-key' });
  expect((await f.manager.list()).accounts[0]).not.toHaveProperty('expiresAt');
  expect(readAccountRegistry(f.directory)[0]).not.toHaveProperty('expiresAt');
  // A hand-edited invalid date is dropped, and sign-in accounts refuse the field.
  const registry = path.join(f.directory, 'accounts.json');
  save(registry, readAccountRegistry(f.directory).map((a: object) => ({ ...a, expiresAt: '2026-02-30' })));
  expect(readAccountRegistry(f.directory)[0]).not.toHaveProperty('expiresAt');
  await expect(f.manager.start({ provider: 'codex', label: 'Codex', scope: 'shared', expiresAt: '2026-12-31' })).rejects.toThrow('API-key');
  const oauth = { id: crypto.randomUUID(), credentialId: crypto.randomUUID(), provider: 'codex', label: 'Codex', scope: 'shared' };
  save(registry, [...readAccountRegistry(f.directory), oauth]);
  await expect(f.manager.update(oauth.id, { expiresAt: '2026-12-31' })).rejects.toThrow('API-key');
  // Deleting the account drops its check.
  await f.manager.remove(id);
  expect(JSON.stringify((await f.manager.list()).accounts)).not.toContain('keyCheck');
});

test('issue requests use the code hosting account the relay serves to the agent container for that server', async () => {
  const checked: string[] = [];
  const request = (async (url: string) => { checked.push(String(url)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const f = fixture('gitlab-issues', undefined, undefined, request);
  const clients = path.join(root, 'gitlab-issues-clients');
  // An isolated client switches the relay to exact names; these clients match by pattern.
  fs.rmSync(path.join(clients, 'private.json'));
  save(path.join(clients, 'php.json'), { match: ['*-php84-*'], providers: { gitlab: { auth: 'apikey', envKey: 'GITLAB_PAT', gitRepos: ['team/*'] } } });
  save(path.join(clients, 'own-route.json'), { match: ['*-own-*'], providers: { gitlab: { auth: 'apikey', envKey: 'GITLAB_PAT' } } });
  save(path.join(clients, 'plain.json'), { match: ['*-plain-*'], providers: {} });
  const key = { provider: 'gitlab', label: 'GitLab', host: 'https://gitlab.example.com' };
  const gl = 'gitlab.example.com';
  expect(() => f.manager.codeHostAccountFor('shop-plain-agent-1', gl)).toThrow('No GitLab or GitHub account for gitlab.example.com in Provider accounts for relay client plain');
  await f.manager.start({ ...key, scope: 'shared', apiKey: 'glpat-shared-key' });
  await f.manager.start({ ...key, scope: 'client', client: 'php', apiKey: 'glpat-client-key' });
  await f.manager.start({ provider: 'github', label: 'GitHub', host: 'https://github.com', scope: 'shared', apiKey: 'ghp-shared-key' });
  expect(checked.at(-1)).toBe('https://api.github.com/user');
  expect(f.manager.codeHostAccountFor('shop-demo-app-php84-1', gl)).toEqual({ provider: 'gitlab', label: 'GitLab (relay client php)', host: gl, key: 'glpat-client-key' });
  // A client without its own route for the provider, or no client at all, falls back to the shared account.
  expect(f.manager.codeHostAccountFor('shop-plain-agent-1', gl).key).toBe('glpat-shared-key');
  expect(f.manager.codeHostAccountFor('unmatched-agent-1', gl).key).toBe('glpat-shared-key');
  // The repository's server picks the provider: a github.com remote never gets a GitLab token.
  expect(f.manager.codeHostAccountFor('shop-demo-app-php84-1', 'github.com')).toMatchObject({ provider: 'github', key: 'ghp-shared-key' });
  expect(() => f.manager.codeHostAccountFor('shop-demo-app-php84-1', 'gitlab.other.example')).toThrow('No GitLab or GitHub account');
  // The relay serves its own route's key to these, never the shared account.
  expect(() => f.manager.codeHostAccountFor('shop-own-agent-1', gl)).toThrow('relay client own-route');
  // The relay sends the GitHub key to its API host and keeps the server for git.
  const applied = applyProviderAccounts(f.directory, { defaults: { providers: {}, services: {} }, clients: [{ name: 'php', isolation: 'shared', providers: {}, services: {} }] });
  expect(applied.defaults.providers.github).toMatchObject({ host: 'api.github.com', pathPrefix: '', gitHost: 'github.com', auth: 'apikey' });
});

test('issue requests match relay clients by the network-qualified container hostname the relay sees', async () => {
  const request = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const relayEnvFile = path.join(root, 'qualified-relay.env');
  const f = fixture('qualified-issues', undefined, undefined, request, { relayEnvFile });
  const clients = path.join(root, 'qualified-issues-clients');
  fs.rmSync(path.join(clients, 'private.json'));
  // The shipped carapa-bot.json pattern only matches the name Docker's reverse DNS reports, with the network.
  save(path.join(clients, 'carapa-bot.json'), { match: ['carapa-*.agent_egress*'], providers: {} });
  save(path.join(clients, 'own-route.json'), { match: ['own-*.agent_egress*'], providers: { gitlab: { auth: 'apikey', envKey: 'GITLAB_PAT' } } });
  const key = { provider: 'gitlab', label: 'GitLab', host: 'https://gitlab.example.com' };
  const gl = 'gitlab.example.com';
  await f.manager.start({ ...key, scope: 'shared', apiKey: 'glpat-shared-key' });
  await f.manager.start({ ...key, scope: 'client', client: 'carapa-bot', apiKey: 'glpat-bot-key' });
  const names = ['carapa-bot-p-agent-1.agent_egress_carapa-bot-p', 'carapa-bot-p-agent-1'];
  expect(f.manager.codeHostAccountFor(names, gl)).toEqual({ provider: 'gitlab', label: 'GitLab (relay client carapa-bot)', host: gl, key: 'glpat-bot-key' });
  // A network that matches no client does not hide a later one; no match at all keeps the shared account.
  expect(f.manager.codeHostAccountFor(['carapa-bot-p-agent-1.other_net', ...names], gl).key).toBe('glpat-bot-key');
  expect(f.manager.codeHostAccountFor(['shop-agent-1.agent_egress_shop', 'shop-agent-1'], gl).key).toBe('glpat-shared-key');
  // A client with its own route gets no shared fallback, reached through the qualified name.
  expect(() => f.manager.codeHostAccountFor(['own-p-agent-1.agent_egress_own-p', 'own-p-agent-1'], gl)).toThrow('relay client own-route');
  // The relay's own env decides exact matching; Box's process env no longer does.
  process.env.RELAY_REQUIRE_KNOWN_CLIENTS = '1';
  try { expect(f.manager.codeHostAccountFor(names, gl).key).toBe('glpat-bot-key'); } finally { delete process.env.RELAY_REQUIRE_KNOWN_CLIENTS; }
  // Compose drops an inline comment after whitespace, so the relay reads 1 here and requires exact names.
  for (const line of ['RELAY_REQUIRE_KNOWN_CLIENTS=1', 'RELAY_REQUIRE_KNOWN_CLIENTS=1 # exact names only', 'RELAY_REQUIRE_KNOWN_CLIENTS="1"  # exact']) {
    fs.writeFileSync(relayEnvFile, line + '\n');
    expect(() => f.manager.codeHostAccountFor(names, gl)).toThrow('No GitLab or GitHub account');
  }
});

test('with encryption at rest Box saves keys sealed and still reads them for listing and usage', async () => {
  const sent: (string | undefined)[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    sent.push((init.headers as Record<string, string>).authorization);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const f = fixture('sealed-key', undefined, undefined, request);
  const keyFile = path.join(root, 'sealed-key.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'));
  try {
    configureCredentialSealing({ CARAPA_CREDENTIALS_KEY_FILE: keyFile }, f.directory);
    const { id } = await f.manager.start({ provider: 'mistral-vibe', label: 'Vibe', scope: 'shared', apiKey: 'sealed-vibe-key' });
    const [account] = readAccountRegistry(f.directory);
    expect(fs.readFileSync(path.join(f.directory, 'credentials', account.credentialId + '.json'), 'utf8')).not.toContain('sealed-vibe-key');
    expect((await f.manager.list()).accounts).toMatchObject([{ id, state: 'connected' }]);
    sent.length = 0;
    await f.manager.usage(request);
    expect(sent).toEqual(['Bearer sealed-vibe-key']);
  } finally { configureCredentialSealing({}, null); }
});
