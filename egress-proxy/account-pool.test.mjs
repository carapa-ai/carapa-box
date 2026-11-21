import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountPool, quotaExhaustedUntil, requestSession } from './api-relay/account-pool.mjs';
import { applyProviderAccounts } from './api-relay/provider-account-config.mjs';

const HOUR = 3600_000;
const id = n => `00000000-0000-4000-8000-00000000000${n}`;

function store(now, usage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-pool-'));
  fs.mkdirSync(path.join(directory, 'quota'));
  const files = Object.keys(usage).map(name => path.join(directory, 'credentials', name + '.json'));
  const record = (name, windows) => fs.writeFileSync(path.join(directory, 'quota', name + '.json'), JSON.stringify({ windows }));
  for (const [name, windows] of Object.entries(usage)) record(name, windows);
  return { directory, files, record, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('a session keeps its account, new sessions take the soonest reset, and a full account hands over', () => {
  let now = 1_000_000_000_000;
  const f = store(now, {
    personal: [{ label: '5-hour', usedPercent: 40, resetsAt: now + 2 * HOUR }, { label: 'Weekly', usedPercent: 50, resetsAt: now + 100 * HOUR }],
    business: [{ label: '5-hour', usedPercent: 0, resetsAt: now + 4 * HOUR }, { label: 'Weekly', usedPercent: 10, resetsAt: now + 30 * HOUR }],
  });
  try {
    const [personal, business] = f.files;
    const pool = createAccountPool({ directory: f.directory, now: () => now, log: () => {} });
    // The weekly allowance of "business" is lost first, so it is used first.
    expect(pool.choose('codex:shared:', f.files, 'box/s1')).toBe(business);
    // The provider refuses the account: the session moves, and stays moved.
    pool.markExhausted(business, now + 30 * HOUR);
    expect(pool.hasAlternative(f.files, new Set([business]))).toBe(true);
    expect(pool.choose('codex:shared:', f.files, 'box/s1', new Set([business]))).toBe(personal);
    now += 31 * HOUR;
    expect(pool.choose('codex:shared:', f.files, 'box/s1')).toBe(personal);
    // A usage reading at 100% moves a session without a refused request.
    expect(pool.choose('codex:shared:', f.files, 'box/s2')).toBe(personal);
    f.record('personal', [{ label: 'Weekly', usedPercent: 100, resetsAt: now + 69 * HOUR }]);
    f.record('business', [{ label: 'Weekly', usedPercent: 5, resetsAt: now + 167 * HOUR }]);
    now += 60_000;
    expect(pool.choose('codex:shared:', f.files, 'box/s2')).toBe(business);
    // With every account full, the session stays where it is instead of flapping.
    f.record('business', [{ label: 'Weekly', usedPercent: 100, resetsAt: now + 166 * HOUR }]);
    now += 60_000;
    expect(pool.hasAlternative(f.files, new Set())).toBe(false);
    expect(pool.choose('codex:shared:', f.files, 'box/s2')).toBe(business);
    expect(pool.choose('codex:shared:', f.files, 'box/s3')).toBe(personal);
  } finally { f.cleanup(); }
});

test('at the session cap the least recently used session is evicted, not an active one', () => {
  let now = 1_000_000_000_000;
  const f = store(now, { personal: [], business: [] });
  try {
    const [personal, business] = f.files;
    const pool = createAccountPool({ directory: f.directory, now: () => now, log: () => {} });
    // Both accounts look unused, so the victim starts on the first one.
    expect(pool.choose('codex:shared:', f.files, 'box/victim')).toBe(personal);
    // From now on a new session would take "business", so a lost victim entry shows as a move.
    f.record('business', [{ label: '5-hour', usedPercent: 0, resetsAt: now + 4 * HOUR }]);
    now += 20_000;
    for (let i = 0; i < 5100; i++) {
      expect(pool.choose('codex:shared:', f.files, 'box/victim')).toBe(personal);
      expect(pool.choose('codex:shared:', f.files, `attacker/${i}`)).toBe(business);
    }
  } finally { f.cleanup(); }
});

test('only a used-up plan counts as exhausted, and the session comes from the CLI header', () => {
  const now = 1_000_000_000_000;
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: now / 1000 + 600 } });
  expect(quotaExhaustedUntil('codex', 429, {}, body, now)).toBe(now + 600_000);
  expect(quotaExhaustedUntil('codex', 429, {}, '{"error":{"type":"rate_limit_exceeded"}}', now)).toBeNull();
  expect(quotaExhaustedUntil('codex', 500, {}, body, now)).toBeNull();
  expect(quotaExhaustedUntil('anthropic', 429, { 'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(now / 1000 + 60) }, '', now)).toBe(now + 60_000);
  expect(quotaExhaustedUntil('anthropic', 429, { 'anthropic-ratelimit-unified-status': 'allowed' }, '', now)).toBeNull();
  expect(requestSession({ 'session-id': '01a02ed9-dec1-74e1-bd4c-08ce3c00e31a' }, 'box')).toBe('box/01a02ed9-dec1-74e1-bd4c-08ce3c00e31a');
  expect(requestSession({}, 'box')).toBe('box');
});

test('accounts of one provider and scope become one route with every credential file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-pool-'));
  try {
    const account = n => ({ id: id(n), credentialId: id(n + 4), provider: 'codex', label: 'A' + n, scope: 'shared' });
    fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify([account(1), account(2),
      { ...account(3), provider: 'anthropic' }]));
    const { providers } = applyProviderAccounts(directory, { clients: [], defaults: { providers: {}, services: {} } }).defaults;
    const file = n => path.join(directory, 'credentials', id(n) + '.json');
    expect(providers.codex).toEqual({ auth: 'oauth', credentialFormat: 'codex', credentialFile: file(5),
      credentialFiles: [file(5), file(6)], pool: 'codex:shared:' });
    expect(providers.anthropic).toEqual({ auth: 'oauth', credentialFormat: 'anthropic', credentialFile: file(7) });
    // API-key providers still hold one key per scope.
    fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify([{ ...account(1), provider: 'openai' }, { ...account(2), provider: 'openai' }]));
    expect(() => applyProviderAccounts(directory, { clients: [], defaults: null })).toThrow('Duplicate provider account binding');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the relay continues a refused request on the other account and keeps the session there', async () => {
  const { startApiRelay } = await import('./api-relay/api-relay.mjs');
  const { Readable } = await import('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-pool-live-'));
  const clients = path.join(dir, 'clients'); fs.mkdirSync(clients);
  const store = path.join(dir, 'store'); fs.mkdirSync(path.join(store, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(store, 'accounts.json'), JSON.stringify([1, 2].map(n => (
    { id: id(n), credentialId: id(n), label: 'A' + n, provider: 'codex', scope: 'shared' }))));
  for (const n of [1, 2]) fs.writeFileSync(path.join(store, 'credentials', id(n) + '.json'),
    JSON.stringify({ tokens: { access_token: 'token-' + n, refresh_token: 'refresh-' + n } }));
  const calls = [];
  const relay = startApiRelay({ host: '127.0.0.1', port: 0, clientsDir: clients,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', PROVIDER_ACCOUNTS_DIR: store, SNI_BRIDGE_PORT: '0' },
    hostnameResolver: async () => 'agent', externalRequest: async (provider, target, method, headers) => {
      calls.push(headers.authorization);
      return headers.authorization === 'Bearer token-1'
        ? Object.assign(Readable.from([Buffer.from(JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 3600 } }))]), { statusCode: 429, headers: {} })
        : Object.assign(Readable.from(['ok']), { statusCode: 200, headers: {} });
    } });
  try {
    if (!relay.server.listening) await new Promise(resolve => relay.server.once('listening', resolve));
    const send = session => fetch(`http://127.0.0.1:${relay.server.address().port}/codex/responses`,
      { method: 'POST', headers: { 'session-id': session }, body: '{}' });
    const first = await send('session-0001');
    expect(first.status).toBe(200); expect(await first.text()).toBe('ok');
    expect(calls).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect((await send('session-0001')).status).toBe(200);
    // A new session does not try the exhausted account either.
    expect((await send('session-0002')).status).toBe(200);
    expect(calls.slice(2)).toEqual(['Bearer token-2', 'Bearer token-2']);
  } finally { relay.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
