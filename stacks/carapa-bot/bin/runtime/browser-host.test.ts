import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = join(import.meta.dir, '..');
const id = 'browser-' + 'a'.repeat(40);
const cdp = 'ws://api-relay:8080/board-api/api/web-browser/sessions/s/cdp';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-host-')); roots.push(root);
  const native = { CARAPA_IPC_ROOT: join(root, 'ipc'), CARAPA_WORKSPACE_ROOT: join(root, 'ws'), CARAPA_TMP_ROOT: join(root, 'tmp'),
    CARAPA_RELAY_URL: 'http://127.0.0.1:9/s/p' };
  mkdirSync(join(native.CARAPA_IPC_ROOT, 'browser-sessions'), { recursive: true });
  mkdirSync(join(native.CARAPA_WORKSPACE_ROOT, 'app'), { recursive: true });
  mkdirSync(native.CARAPA_TMP_ROOT);
  const descriptor = { id, workDir: '/workspace/app', requestedUrl: 'https://example.com/',
    env: { CARAPA_BROWSER_SESSION_ID: id, PLAYWRIGHT_CLI_SESSION: id, PLAYWRIGHT_DAEMON_SESSION_DIR: '/tmp/pwcli-' + id, PLAYWRIGHT_MCP_CDP_ENDPOINT: cdp } };
  writeFileSync(join(native.CARAPA_IPC_ROOT, 'browser-sessions', id + '.json'), JSON.stringify(descriptor));
  return { root, native, descriptor };
}

// A fresh process per scenario: the scripts read the CARAPA_* variables when they run.
function run(argv: string[], env: Record<string, string>) {
  // Inline scripts (-e) go through a temp file: bun misreads -e when started from bun test.
  if (argv[0] === '-e') {
    const dir = mkdtempSync(join(tmpdir(), 'browser-host-script-')); roots.push(dir);
    writeFileSync(join(dir, 'script.cjs'), argv[1]);
    argv = [join(dir, 'script.cjs')];
  }
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CARAPA_') && !key.startsWith('PLAYWRIGHT_') && !key.startsWith('PWTEST_')));
  return spawnSync(process.execPath, argv, { env: { ...clean, ...env }, encoding: 'utf8' });
}
const readBrowser = (env: Record<string, string>) => {
  const result = run(['-e', `const s = require(${JSON.stringify(join(bin, 'browser-session.cjs'))}); const r = s.readBrowser(${JSON.stringify(id)}); console.log(JSON.stringify({ file: r.file, cwd: r.cwd, env: r.env }))`], env);
  return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : undefined };
};

test('readBrowser maps the descriptor, cwd, session and socket dirs onto native roots and keeps container paths otherwise', () => {
  const { native } = fixture();
  const { value, stderr } = readBrowser(native);
  expect(stderr).toBe('');
  expect(value.file).toBe(join(native.CARAPA_IPC_ROOT, 'browser-sessions', id + '.json'));
  expect(value.cwd).toBe(join(native.CARAPA_WORKSPACE_ROOT, 'app'));
  expect(value.env.PLAYWRIGHT_DAEMON_SESSION_DIR).toBe(`${native.CARAPA_TMP_ROOT}/pwcli-${id}`);
  expect(value.env.PWTEST_SERVER_REGISTRY).toBe(`${native.CARAPA_TMP_ROOT}/pwcli-${id}/registry`);
  expect(value.env.PWTEST_SOCKETS_DIR.startsWith(native.CARAPA_TMP_ROOT + '/pw-')).toBe(true);
  expect(value.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('ws://127.0.0.1:9/s/p/board-api/api/web-browser/sessions/s/cdp');
  // Without the native variables the same descriptor resolves to the container paths.
  const missing = readBrowser({});
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain(`/workspace/ipc/browser-sessions/${id}.json`);
  const container = run(['-e', `console.log(JSON.stringify(require(${JSON.stringify(join(bin, 'browser-session.cjs'))}).currentEnvironment(
    { CARAPA_BROWSER_SESSION_ID: ${JSON.stringify(id)}, PLAYWRIGHT_DAEMON_SESSION_DIR: '/tmp/pwcli-${id}' })))`], {});
  const plain = JSON.parse(container.stdout);
  expect(plain.PWTEST_SOCKETS_DIR).toMatch(/^\/tmp\/pw-[a-f0-9]{20}$/);
  expect(plain.PWTEST_SERVER_REGISTRY).toBe(`/tmp/pwcli-${id}/registry`);
});

// browser-open drives a stand-in Playwright CLI that records its arguments.
function open(descriptorChange: (d: ReturnType<typeof fixture>['descriptor']) => void) {
  const { root, native, descriptor } = fixture();
  descriptorChange(descriptor);
  writeFileSync(join(native.CARAPA_IPC_ROOT, 'browser-sessions', id + '.json'), JSON.stringify(descriptor));
  const cli = join(root, 'cli.js');
  writeFileSync(cli, `const a = process.argv.slice(2); if (a[0] === 'list') console.log('{"browsers":[]}'); else require('fs').appendFileSync(${JSON.stringify(join(root, 'calls'))}, JSON.stringify(a) + '\\n');`);
  const result = run([join(bin, 'browser-open'), id, 'start'], { ...native, CARAPA_PLAYWRIGHT_REAL: cli });
  return { result, native, config: join(native.CARAPA_TMP_ROOT, 'pwcli-' + id, 'board-browser.json'), calls: join(root, 'calls') };
}

test('browser-open on a native runner connects to the hub browser and never launches a local one', () => {
  const { result, config, calls } = open(() => {});
  expect(result.stderr).toBe('');
  const browser = JSON.parse(readFileSync(config, 'utf8')).browser;
  expect(browser.launchOptions).toBeUndefined();
  expect(browser.cdpEndpoint).toBe('ws://127.0.0.1:9/s/p/board-api/api/web-browser/sessions/s/cdp');
  expect(readFileSync(calls, 'utf8')).toContain(`--config=${config}`);
});

test.each([
  ['no remote browser', (d: { env: Record<string, string> }) => { delete d.env.PLAYWRIGHT_MCP_CDP_ENDPOINT; }, 'Board did not provide a remote browser for this Mac project'],
  ['a loopback URL', (d: { requestedUrl?: string }) => { d.requestedUrl = 'http://localhost:3000/'; }, 'Previews of apps running on the Mac are not supported yet'],
  ['a loopback URL with a trailing DNS dot', (d: { requestedUrl?: string }) => { d.requestedUrl = 'http://service.localhost.:3000/'; }, 'Previews of apps running on the Mac are not supported yet'],
  ['no URL', (d: { requestedUrl?: string }) => { delete d.requestedUrl; }, 'Previews of apps running on the Mac are not supported yet'],
])('browser-open on a native runner refuses %s without launching anything', (_name, change, message) => {
  const { result, config, calls } = open(change as Parameters<typeof open>[0]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(calls)).toBe(false);
});

// browser-open reaches the local launch through browser-xvfb.cjs; the native
// fixtures above cannot exercise it, so call it in a child process with a fake Xvfb on PATH.
function headed(xvfb: string | undefined, calls = 1, stale = false) {
  const root = mkdtempSync(join(tmpdir(), 'browser-xvfb-')); roots.push(root);
  const x11 = join(root, 'x11'), log = join(root, 'xvfb.log');
  if (xvfb !== undefined) {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'Xvfb'), xvfb, { mode: 0o755 });
    chmodSync(join(root, 'bin', 'Xvfb'), 0o755);
  }
  if (stale) {
    // A server killed without cleanup leaves its socket file behind.
    mkdirSync(x11);
    writeFileSync(join(root, 'stale.cjs'), `require('node:net').createServer().listen(${JSON.stringify(join(x11, 'X99'))}, () => process.kill(process.pid, 'SIGKILL'))`);
    spawnSync(process.execPath, [join(root, 'stale.cjs')]);
    expect(existsSync(join(x11, 'X99'))).toBe(true);
  }
  const script = `const { localLaunch } = require(${JSON.stringify(join(bin, 'browser-xvfb.cjs'))});
    try { const out = []; for (let i = 0; i < ${calls}; i++) out.push(localLaunch()); console.log(JSON.stringify(out)); }
    catch (error) { console.error('browser-open: ' + error.message); process.exitCode = 1; }`;
  const result = run(['-e', script], { PATH: xvfb === undefined ? join(root, 'bin') : `${join(root, 'bin')}:/usr/bin:/bin`, CARAPA_BROWSER_HEADED: '1', CARAPA_X11_DIR: x11, FAKE_LOG: log, FAKE_NODE: process.execPath });
  const pids = existsSync(log + '.pid') ? readFileSync(log + '.pid', 'utf8').split('\n').filter(Boolean) : [];
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } }
  return { result, started: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], x11 };
}
// A fake Xvfb that really listens on its display socket, like the real one.
const listeningXvfb = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
echo $$ >> "$FAKE_LOG.pid"
mkdir -p "$CARAPA_X11_DIR"
exec "$FAKE_NODE" -e "require('node:net').createServer().listen(process.argv[1]); setTimeout(() => {}, 60000)" "$CARAPA_X11_DIR/X\${1#:}"
`;

test('headed mode launches Chromium headed on one shared Xvfb display that exists', () => {
  const { result, started, x11 } = headed(listeningXvfb, 3);
  expect(result.stderr).toBe('');
  const [first, ...rest] = JSON.parse(result.stdout);
  expect(first.launchOptions.headless).toBe(false);
  expect(first.launchOptions.args).toEqual(['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']);
  expect(JSON.stringify(first.launchOptions)).not.toContain('userAgent');
  expect(first.display).toBe(':99');
  expect(existsSync(join(x11, 'X99'))).toBe(true);
  // Repeated starts reuse the display instead of spawning another Xvfb.
  expect(rest.map((launch: { display: string }) => launch.display)).toEqual([':99', ':99']);
  expect(started).toHaveLength(1);
});

test.each([
  ['Xvfb is not installed', undefined, 'needs Xvfb, which is not installed'],
  ['Xvfb exits at startup', '#!/bin/sh\nexit 1\n', 'Xvfb did not start on display :99'],
])('headed mode fails closed when %s', (_name, xvfb, message) => {
  const { result } = headed(xvfb);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`browser-open: CARAPA_BROWSER_HEADED=1`);
  expect(result.stderr).toContain(message);
  expect(result.stdout).toBe('');
});

test('headed mode replaces a stale display socket instead of reusing a dead display', () => {
  const { result, started } = headed(listeningXvfb, 2, true);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout).map((launch: { display: string }) => launch.display)).toEqual([':99', ':99']);
  // The dead socket did not count as a display: one new Xvfb, then reused.
  expect(started).toHaveLength(1);
});

test('headed mode fails closed on a stale display socket when Xvfb is not installed', () => {
  const { result } = headed(undefined, 1, true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('needs Xvfb, which is not installed');
});

test.each([['no pid file', undefined], ['an empty pid file', '']])('the browser lock reclaims an old lock dir with %s', (_name, pidFile) => {
  const { native } = fixture();
  const sessionDir = '/tmp/pwcli-lock-test';
  const hash = createHash('sha256').update(sessionDir).digest('hex').slice(0, 20);
  const lock = join(native.CARAPA_TMP_ROOT, 'pw-open-' + hash);
  mkdirSync(lock);
  if (pidFile !== undefined) writeFileSync(join(lock, 'pid'), pidFile);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const result = run(['-e', `const s = require(${JSON.stringify(join(bin, 'browser-session.cjs'))});
    console.log(s.withBrowserLock({ PLAYWRIGHT_DAEMON_SESSION_DIR: ${JSON.stringify(sessionDir)} }, () => 'ran'))`], native);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('ran');
  expect(existsSync(lock)).toBe(false);
});

test('the browser lock never deletes a lock a live owner took over while another caller was reclaiming', () => {
  const { native } = fixture();
  const sessionDir = '/tmp/pwcli-lock-race-test';
  const hash = createHash('sha256').update(sessionDir).digest('hex').slice(0, 20);
  const lock = join(native.CARAPA_TMP_ROOT, 'pw-open-' + hash);
  // Another caller is mid-reclaim of a lock whose owner died.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), dead);
  mkdirSync(lock + '.reclaim');
  // While this caller waits, that reclaimer finishes and a live owner (the test runner) takes the lock; later it releases it.
  const result = run(['-e', `const fs = require('node:fs'), path = require('node:path');
    const s = require(${JSON.stringify(join(bin, 'browser-session.cjs'))});
    const lock = ${JSON.stringify(lock)}; const realWait = Atomics.wait; let waits = 0, ownerDone = false;
    Atomics.wait = (...args) => {
      waits++;
      if (waits === 2) { fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.ppid)); fs.rmSync(lock + '.reclaim', { recursive: true }); }
      if (waits === 4) { fs.rmSync(lock, { recursive: true }); ownerDone = true; }
      return realWait(...args);
    };
    console.log(s.withBrowserLock({ PLAYWRIGHT_DAEMON_SESSION_DIR: ${JSON.stringify(sessionDir)} }, () => 'ran after owner released: ' + ownerDone))`], native);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('ran after owner released: true');
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(lock + '.reclaim')).toBe(false);
});
