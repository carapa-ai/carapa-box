import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAdminApi } from './admin.js';

const originalCwd = process.cwd();
const originalStackKey = process.env.STACKS_DIR;
let dir: string;
let envPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-config-'));
  envPath = path.join(dir, '.env');
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(originalCwd);
  if (originalStackKey === undefined) delete process.env.STACKS_DIR; else process.env.STACKS_DIR = originalStackKey;
  fs.rmSync(dir, { recursive: true, force: true });
});

const initial = '# operator notes\nCARAPA_BOX_API_TOKEN=fake-token\nANTHROPIC_API_KEY=fake-key\nCUSTOM=keep\n\nSTACKS_DIR=/old\n';
const get = () => handleAdminApi(new Request('http://box/api/admin/config'), new URL('http://box/api/admin/config'));
const post = (body: unknown) => handleAdminApi(
  new Request('http://box/api/admin/config', { method: 'POST', body: JSON.stringify(body) }),
  new URL('http://box/api/admin/config'),
);
const tmpFiles = () => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

describe('admin config save', () => {
  test('GET then POST round-trip keeps secrets and comments and applies the change', async () => {
    fs.writeFileSync(envPath, initial);
    const config = await (await get()).json() as Record<string, string>;
    expect(config.CARAPA_BOX_API_TOKEN).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    const res = await post({ ...config, STACKS_DIR: '/new', ADDED: 'yes' });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(
      '# operator notes\nCARAPA_BOX_API_TOKEN=fake-token\nANTHROPIC_API_KEY=fake-key\nCUSTOM=keep\n\nSTACKS_DIR=/new\nADDED=yes\n',
    );
    const after = await (await get()).json() as Record<string, string>;
    expect(after.STACKS_DIR).toBe('/new');
    expect(after.CARAPA_BOX_API_TOKEN).toBeUndefined();
    expect(tmpFiles()).toEqual([]);
  });

  test('submitted secret keys are ignored', async () => {
    fs.writeFileSync(envPath, initial);
    expect((await post({ CARAPA_BOX_ADMIN_TOKEN: 'fake-admin', STACKS_DIR: '/x' })).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).not.toContain('fake-admin');
  });

  test('newline or carriage return values are rejected and the file is untouched', async () => {
    fs.writeFileSync(envPath, initial);
    for (const value of ['/x\nCARAPA_BOX_ADMIN_TOKEN=fake', '/x\rFOO=bar']) {
      const res = await post({ STACKS_DIR: value });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_CONFIG');
    }
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(initial);
    expect(tmpFiles()).toEqual([]);
  });

  test('non-string values, invalid keys and non-object bodies are rejected', async () => {
    fs.writeFileSync(envPath, initial);
    for (const body of [{ A: 1 }, { A: null }, { 'BAD KEY': 'x' }, { 'A=B': 'x' }, ['x'], 'str', null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(initial);
    expect(tmpFiles()).toEqual([]);
  });

  test('updates every line of a duplicated key so GET returns the submitted value', async () => {
    fs.writeFileSync(envPath, 'STACKS_DIR=/a\n# c\nSTACKS_DIR=/b\n');
    expect((await post({ STACKS_DIR: '/new' })).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('STACKS_DIR=/new\n# c\nSTACKS_DIR=/new\n');
    expect(((await (await get()).json()) as Record<string, string>).STACKS_DIR).toBe('/new');
  });

  test('round-trip POST keeps quoted values of untouched keys and quotes changed ones', async () => {
    fs.writeFileSync(envPath, 'B="x #y"\nC=\'p$ss\'\nD=plain\n');
    const config = await (await get()).json() as Record<string, string>;
    expect((await post({ ...config, D: 'a #b', E: 'cost$5' })).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('B="x #y"\nC=\'p$ss\'\nD=\'a #b\'\nE=\'cost$5\'\n');
    const after = await (await get()).json() as Record<string, string>;
    expect(after).toEqual({ B: 'x #y', C: 'p$ss', D: 'a #b', E: 'cost$5' });
  });

  test('round-trips `export KEY=` lines: GET returns the bare key and POST edits the line in place', async () => {
    fs.writeFileSync(envPath, 'export D=1\nexport E=old\n');
    const config = await (await get()).json() as Record<string, string>;
    expect(config).toEqual({ D: '1', E: 'old' });
    expect((await post({ ...config, E: 'new' })).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('export D=1\nexport E=new\n');
  });

  test('creates the file when absent and cleans up the temp file on failure', async () => {
    expect((await post({ A: 'b' })).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('A=b\n');
    fs.rmSync(envPath);
    fs.mkdirSync(envPath); // rename onto a directory fails
    expect((await post({ A: 'b' })).status).toBe(500);
    expect(tmpFiles()).toEqual([]);
  });
});

describe('admin config paired save (file=both)', () => {
  const originalEgressDir = process.env.SANDBOX_EGRESS_PROXY_DIR;
  const originalAccountsDir = process.env.PROVIDER_ACCOUNTS_DIR;
  let egressDir: string;
  const postBoth = (body: unknown) => handleAdminApi(
    new Request('http://box/api/admin/config?file=both', { method: 'POST', body: JSON.stringify(body) }),
    new URL('http://box/api/admin/config?file=both'),
  );
  beforeEach(() => {
    egressDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-egress-'));
    process.env.SANDBOX_EGRESS_PROXY_DIR = egressDir;
  });
  afterEach(() => {
    if (originalEgressDir === undefined) delete process.env.SANDBOX_EGRESS_PROXY_DIR; else process.env.SANDBOX_EGRESS_PROXY_DIR = originalEgressDir;
    if (originalAccountsDir === undefined) delete process.env.PROVIDER_ACCOUNTS_DIR; else process.env.PROVIDER_ACCOUNTS_DIR = originalAccountsDir;
    fs.rmSync(egressDir, { recursive: true, force: true });
  });

  test('writes both files and updates process.env', async () => {
    fs.writeFileSync(envPath, 'PROVIDER_ACCOUNTS_DIR=/old\n');
    fs.writeFileSync(path.join(egressDir, '.env'), 'PROVIDER_ACCOUNTS_DIR=/old\n');
    const res = await postBoth({ root: { PROVIDER_ACCOUNTS_DIR: '/new' }, egress: { PROVIDER_ACCOUNTS_DIR: '/new' } });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('PROVIDER_ACCOUNTS_DIR=/new\n');
    expect(fs.readFileSync(path.join(egressDir, '.env'), 'utf-8')).toBe('PROVIDER_ACCOUNTS_DIR=/new\n');
    expect(process.env.PROVIDER_ACCOUNTS_DIR).toBe('/new');
  });

  test('an unwritable egress dir fails the save and leaves root and process.env unchanged', async () => {
    fs.writeFileSync(envPath, 'PROVIDER_ACCOUNTS_DIR=/old\n');
    process.env.PROVIDER_ACCOUNTS_DIR = '/old';
    process.env.SANDBOX_EGRESS_PROXY_DIR = path.join(egressDir, 'missing', 'dir');
    const res = await postBoth({ root: { PROVIDER_ACCOUNTS_DIR: '/new' }, egress: { PROVIDER_ACCOUNTS_DIR: '/new' } });
    expect(res.status).toBe(500);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('PROVIDER_ACCOUNTS_DIR=/old\n');
    expect(process.env.PROVIDER_ACCOUNTS_DIR).toBe('/old');
  });

  test('a failing root write restores the egress file', async () => {
    const egressEnv = path.join(egressDir, '.env');
    fs.writeFileSync(egressEnv, '# keep\nPROVIDER_ACCOUNTS_DIR=/old\n', { mode: 0o640 });
    fs.mkdirSync(envPath); // rename onto a directory fails
    process.env.PROVIDER_ACCOUNTS_DIR = '/old';
    const res = await postBoth({ root: { PROVIDER_ACCOUNTS_DIR: '/new' }, egress: { PROVIDER_ACCOUNTS_DIR: '/new' } });
    expect(res.status).toBe(500);
    expect(fs.readFileSync(egressEnv, 'utf-8')).toBe('# keep\nPROVIDER_ACCOUNTS_DIR=/old\n');
    expect(fs.statSync(egressEnv).mode & 0o777).toBe(0o640);
    expect(process.env.PROVIDER_ACCOUNTS_DIR).toBe('/old');
    // Absent egress file is removed again rather than left behind
    fs.rmSync(egressEnv);
    expect((await postBoth({ root: { A: 'b' }, egress: { A: 'b' } })).status).toBe(500);
    expect(fs.existsSync(egressEnv)).toBe(false);
  });

  test('invalid payloads are rejected before any write', async () => {
    fs.writeFileSync(envPath, 'A=1\n');
    for (const body of [{ root: { A: 'x\ny' }, egress: {} }, { root: {} }, { root: [], egress: {} }, null]) {
      expect((await postBoth(body)).status).toBe(400);
    }
    expect(fs.existsSync(path.join(egressDir, '.env'))).toBe(false);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('A=1\n');
  });
});

describe('admin config secrets from .env.example', () => {
  const root = path.resolve(import.meta.dir, '../..');
  const examples = ['.env.example', 'egress-proxy/.env.example', 'stacks/carapa-bot/.env.example'];
  const keys = new Set<string>();
  for (const f of examples) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf-8').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) keys.add(m[1]);
  }
  const secretRe = /(_SECRET|_TOKEN|_API_KEY|_PASSWORD|_PAT)$/;
  const secrets = [...keys].filter(k => secretRe.test(k) || k === 'CARAPA_HUB_BOX_SECRET');
  const visible = ['AUDIT_LOG_PATH', 'SECRETS_DIR', 'OAUTH_CLIENT_CREDENTIALS_DIR'];

  test('example files contain the expected secret keys', () => {
    expect(secrets).toContain('CARAPA_HUB_BOX_SECRET');
    expect(secrets).toContain('GITLAB_PAT');
  });

  test('GET returns none of the secret keys', async () => {
    fs.writeFileSync(envPath, [...secrets.map(k => `${k}=s3cret`), 'AUDIT_LOG_PATH=/a', 'SECRETS_DIR=/s', 'OAUTH_CLIENT_CREDENTIALS_DIR=/o'].join('\n') + '\n');
    const config = await (await get()).json() as Record<string, string>;
    for (const k of secrets) expect(config[k]).toBeUndefined();
  });

  test('POST refuses to overwrite secret keys', async () => {
    const original = secrets.map(k => `${k}=s3cret`).join('\n') + '\n';
    fs.writeFileSync(envPath, original);
    expect((await post(Object.fromEntries(secrets.map(k => [k, 'hacked'])))).status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(original);
  });

  test('AUDIT_LOG_PATH, SECRETS_DIR and OAUTH_CLIENT_CREDENTIALS_DIR survive GET and POST', async () => {
    fs.writeFileSync(envPath, 'AUDIT_LOG_PATH=/a\nSECRETS_DIR=/s\nOAUTH_CLIENT_CREDENTIALS_DIR=/o\n');
    const config = await (await get()).json() as Record<string, string>;
    for (const k of visible) expect(config[k]).toBeDefined();
    expect((await post({ AUDIT_LOG_PATH: '/a2', SECRETS_DIR: '/s2', OAUTH_CLIENT_CREDENTIALS_DIR: '/o2' })).status).toBe(200);
    const after = await (await get()).json() as Record<string, string>;
    expect(after).toMatchObject({ AUDIT_LOG_PATH: '/a2', SECRETS_DIR: '/s2', OAUTH_CLIENT_CREDENTIALS_DIR: '/o2' });
    delete process.env.AUDIT_LOG_PATH; delete process.env.SECRETS_DIR; delete process.env.OAUTH_CLIENT_CREDENTIALS_DIR;
  });
});

describe('provider account estimate over HTTP', () => {
  test('PATCH sets and clears an estimate for the Board token and rejects invalid edits', () => {
    const accounts = path.join(dir, 'accounts');
    fs.mkdirSync(accounts);
    fs.mkdirSync(path.join(dir, 'clients'));
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(accounts, 'accounts.json'), JSON.stringify([{ id, credentialId: crypto.randomUUID(), provider: 'codex', label: 'Shared', scope: 'shared' }]));
    // Child process: the provider account controller is a per-process singleton bound to its first directory.
    const child = path.join(dir, 'child.ts');
    fs.writeFileSync(child, `
import { handleBunRequest } from ${JSON.stringify(path.join(import.meta.dir, 'server.ts'))};
const send = (method: string, body: unknown, token: string) => handleBunRequest(new Request('http://box/api/admin/provider-accounts/' + process.env.TEST_ACCOUNT_ID, {
  method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const results = [];
for (const [body, token] of [[{ label: 'claude max 20x' }, 'test-board'], [{ label: '' }, 'test-board'], [{ label: '   ' }, 'test-board'],
  [{ label: null }, 'test-board'], [{ label: 7 }, 'test-board'], [{ label: 'x'.repeat(81) }, 'test-board'],
  [{ tier: 'max 5x', capacity: 500 }, 'test-board'], [{ capacity: null }, 'test-board'],
  [{ capacity: 1001 }, 'test-board'], [{ tier: 'x'.repeat(41) }, 'test-board'], [{ tier: 'pro' }, 'wrong-token']]) {
  const response = await send('PATCH', body, token);
  results.push({ status: response.status, body: await response.json() });
}
const unknown = await handleBunRequest(new Request('http://box/api/admin/provider-accounts/00000000-0000-0000-0000-000000000000', {
  method: 'PATCH', headers: { Authorization: 'Bearer test-board', 'Content-Type': 'application/json' }, body: '{"tier":"pro"}' }));
results.push({ status: unknown.status, body: await unknown.json() });
const listed = await handleBunRequest(new Request('http://box/api/admin/provider-accounts', { headers: { Authorization: 'Bearer test-board' } }));
results.push({ status: listed.status, body: await listed.json() });
for (const [ids, token] of [[[process.env.TEST_ACCOUNT_ID], 'test-board'], [[], 'test-board'], [[process.env.TEST_ACCOUNT_ID], 'wrong-token']]) {
  const response = await handleBunRequest(new Request('http://box/api/admin/provider-accounts/order', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }));
  results.push({ status: response.status, body: await response.json() });
}
console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`);
    const run = Bun.spawnSync([process.execPath, child], {
      cwd: dir, timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', PROVIDER_ACCOUNTS_DIR: accounts, PROVIDER_RELAY_CLIENTS_DIR: path.join(dir, 'clients'),
        CARAPA_BOX_API_TOKEN: 'test-board', CARAPA_BOX_ADMIN_TOKEN: 'test-admin', TEST_ACCOUNT_ID: id },
    });
    const line = run.stdout.toString().split('\n').find(l => l.startsWith('RESULT '));
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const [renamed, emptyLabel, blankLabel, nullLabel, numberLabel, longLabel, set, cleared, tooHigh, tooLong, wrongToken, unknownId, listed, ordered, staleOrder, orderWrongToken] =
      JSON.parse(line!.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> }[];
    expect([renamed, emptyLabel, blankLabel, nullLabel, numberLabel, longLabel, set, cleared, tooHigh, tooLong, wrongToken, unknownId, listed].map(r => r.status))
      .toEqual([200, 400, 400, 400, 400, 400, 200, 200, 400, 400, 401, 400, 200]);
    expect(renamed.body).toMatchObject({ id, label: 'claude max 20x' });
    expect(listed.body.accounts).toMatchObject([{ id, label: 'claude max 20x' }]);
    expect(set.body).toMatchObject({ id, label: 'claude max 20x', tier: 'max 5x', capacity: 500 });
    expect(cleared.body).toMatchObject({ id, label: 'claude max 20x', tier: 'max 5x' });
    expect(cleared.body).not.toHaveProperty('capacity');
    expect([ordered.status, staleOrder.status, orderWrongToken.status]).toEqual([200, 400, 401]);
    expect(ordered.body.accounts).toMatchObject([{ id }]);
    expect(staleOrder.body).toEqual({ error: 'The account list changed; reload and try again' });
  });
});

describe('malformed percent-encoding in admin paths', () => {
  const call = (method: string, p: string) => {
    const url = `http://box${p}`;
    return handleAdminApi(new Request(url, { method }), new URL(url));
  };

  test('relay-token and tools paths return 400 instead of throwing', async () => {
    for (const [method, p] of [
      ['GET', '/api/admin/relay-token/%E0%A4%A'],
      ['POST', '/api/admin/relay-token/%E0%A4%A'],
      ['DELETE', '/api/admin/relay-token/%E0%A4%A'],
      ['POST', '/api/admin/tools/%E0%A4%A'],
    ]) {
      const res = await call(method, p);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('encoding');
    }
  });
});
