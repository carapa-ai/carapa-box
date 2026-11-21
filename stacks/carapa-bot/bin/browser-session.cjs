'use strict';
// Shared by the CLI shim and the controller-owned viewer. Keep upstream's
// private compatibility variables here, alongside the supported version.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { hostPath, hostEnv, containerSessionDir, tmpDir } = require('./browser-host.cjs');
// Board invokes open/close/viewer directly, outside run-agent and the CLI shim.
// Pin the whole operation before resolving package paths or spawning children.
if (!process.env.CARAPA_HARNESS_SNAPSHOT && fs.existsSync('/opt/carapa-harness/bin/carapa-harness-exec')) {
  const result = spawnSync('/opt/carapa-harness/bin/carapa-harness-exec',
    [process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const PLAYWRIGHT_VERSION = '1.66.0-alpha-1794252756000';
const sessionKeys = new Set(['PLAYWRIGHT_DAEMON_SESSION_DIR', 'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
  'PLAYWRIGHT_CLI_SESSION', 'PLAYWRIGHT_SERVER_REGISTRY', 'PLAYWRIGHT_SOCKETS_DIR',
  'PWTEST_DAEMON_SESSION_DIR', 'PWTEST_SOCKETS_DIR', 'PWTEST_SERVER_REGISTRY']);
const browserKey = key => sessionKeys.has(key) || /^(CARAPA_RECORD|CARAPA_BROWSER_)/.test(key);

function currentEnvironment(source = process.env) {
  const env = { ...source };
  // Warm harnesses retain their process environment. The session lock publishes
  // the current run atomically; read it for EVERY CLI call, including cleanup.
  if (env.CARAPA_BROWSER_CONTEXT_FILE) {
    const runDir = hostPath(fs.readFileSync(env.CARAPA_BROWSER_CONTEXT_FILE, 'utf8').trim());
    const args = JSON.parse(fs.readFileSync(path.join(runDir, 'args.json'), 'utf8'));
    for (const key of Object.keys(env)) if (browserKey(key)) delete env[key];
    for (const [key, value] of Object.entries(hostEnv(args.env))) {
      if (browserKey(key) && typeof value === 'string') env[key] = value;
    }
  }
  const root = env.PLAYWRIGHT_DAEMON_SESSION_DIR;
  if (root && (env.CARAPA_BROWSER_RUN_ID || env.CARAPA_BROWSER_SESSION_ID)) {
    // Validate the container form; a native runner holds the mapped host form.
    const container = containerSessionDir(root);
    if (!container) throw new Error('Invalid browser session directory');
    const sockets = tmpDir('pw-' + createHash('sha256').update(container).digest('hex').slice(0, 20));
    env.PWTEST_DAEMON_SESSION_DIR = root;
    env.PWTEST_SOCKETS_DIR = sockets;
    env.PWTEST_SERVER_REGISTRY = path.join(root, 'registry');
    // Older images used these names. They do not affect the supported version.
    env.PLAYWRIGHT_SOCKETS_DIR = sockets;
    env.PLAYWRIGHT_SERVER_REGISTRY = env.PWTEST_SERVER_REGISTRY;
  }
  return env;
}

function realCli() {
  const candidates = [process.env.CARAPA_PLAYWRIGHT_REAL,
    '/opt/carapa-harness/harnesses/playwright/lib/node_modules/@playwright/cli/playwright-cli.js',
    '/opt/carapa-harness/lib/node_modules/@playwright/cli/playwright-cli.real.js',
    '/opt/carapa-harness/lib/node_modules/@playwright/cli/playwright-cli.js',
    '/usr/local/lib/node_modules/@playwright/cli/playwright-cli.real.js',
    '/usr/local/lib/node_modules/@playwright/cli/playwright-cli.js'].filter(Boolean);
  const cli = candidates.find(file => fs.existsSync(file));
  if (!cli) throw new Error('Playwright CLI is not installed');
  return cli;
}

function readRun(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(runId)) throw new Error('Invalid run ID');
  const runDir = path.join(hostPath('/workspace/ipc/runs'), runId);
  const args = JSON.parse(fs.readFileSync(path.join(runDir, 'args.json'), 'utf8'));
  if (args.env?.CARAPA_BROWSER_RUN_ID !== runId) throw new Error('Run has no managed browser context');
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (browserKey(key)) delete base[key];
  const env = currentEnvironment({ ...base, ...hostEnv(args.env) });
  if (!env.PWTEST_SERVER_REGISTRY || !env.PWTEST_SOCKETS_DIR) throw new Error('Run has no isolated browser registry');
  delete env.CARAPA_AGENT_RUN_ID;
  delete env.CARAPA_BROWSER_CONTEXT_FILE;
  return { runDir, env, cwd: hostPath(args.workDir || '/workspace') };
}

function readBrowser(id, { forCleanup = false } = {}) {
  if (!/^browser-[a-f0-9]{40}$/.test(id)) {
    const run = readRun(id);
    return forCleanup ? { ...run, cwd: '/' } : run;
  }
  const file = path.join(hostPath('/workspace/ipc/browser-sessions'), id + '.json');
  if (fs.statSync(file).size > 16 * 1024) throw new Error('Invalid browser descriptor');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (descriptor.id !== id || descriptor.env?.CARAPA_BROWSER_SESSION_ID !== id ||
      descriptor.env.PLAYWRIGHT_DAEMON_SESSION_DIR !== '/tmp/pwcli-' + id ||
      !path.isAbsolute(descriptor.workDir) ||
      descriptor.useServiceWorkDir && descriptor.worktree) throw new Error('Invalid browser descriptor');
  // Closing uses only the isolated registry and process ownership records. A
  // removed checkout must not strand its browser or hook-owned server.
  const cwd = forCleanup ? '/' : descriptor.useServiceWorkDir ? process.cwd() : hostPath(descriptor.workDir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Browser working directory does not exist: ${cwd}`);
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (browserKey(key)) delete base[key];
  const env = currentEnvironment({ ...base, ...hostEnv(descriptor.env) });
  env.CARAPA_BROWSER_WORK_DIR = cwd;
  delete env.CARAPA_AGENT_RUN_ID;
  delete env.CARAPA_BROWSER_CONTEXT_FILE;
  return { env, cwd, file, descriptor };
}

function commandError(result, operation) {
  // Playwright can report tool errors on stdout with a zero exit status.
  // Keep the error section, excluding any successful snapshot preceding it.
  const stdout = result.stdout || '';
  const detail = [result.error?.message,
    stdout.includes('### Error') ? stdout.split('### Error').slice(1).join('### Error') : stdout,
    result.stderr].filter(Boolean).join('\n').trim().slice(0, 2048);
  return new Error(`${operation}${result.error?.code ? ` (${result.error.code})` : ''}: ${detail || `exit ${result.status ?? result.signal ?? 'unknown'}`}`);
}

function browserIsOpen(env, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [realCli(), 'list', '--json'], {
    env, cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw commandError(result, 'Could not inspect browser session');
  return JSON.parse(result.stdout).browsers.some(browser => browser.name === env.PLAYWRIGHT_CLI_SESSION && browser.status === 'open');
}

function lockOwnerPid(lock) {
  try {
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
    return Number.isSafeInteger(pid) && pid >= 1 ? pid : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// A lock dir without a readable pid is only mid-acquire for a moment; an older
// one was left by a caller that died (or failed to write) before its pid landed.
const LOCK_PID_GRACE_MS = 5000;

// Reclaiming is serialized by a guard dir and re-reads the owner inside it: a
// pid read earlier may belong to a lock another reclaimer already replaced
// with a live owner's, and deleting by path would then remove that live lock.
function reclaimStaleLock(lock) {
  const guard = lock + '.reclaim';
  try { fs.mkdirSync(guard); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Reclaiming takes microseconds; an old guard was left by a caller that died inside it.
    try { if (Date.now() - fs.statSync(guard).mtimeMs > LOCK_PID_GRACE_MS) fs.rmSync(guard, { recursive: true, force: true }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  try {
    const pid = lockOwnerPid(lock);
    if (pid === undefined) {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_PID_GRACE_MS) fs.rmSync(lock, { recursive: true, force: true });
    } else {
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.rmSync(lock, { recursive: true, force: true }); else throw e; }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  finally { fs.rmSync(guard, { recursive: true, force: true }); }
}

// Both agent and on-demand opens use this lock, so simultaneous callers cannot
// launch replacement browsers and lose each other's tabs or cookies.
function withBrowserLock(env, action) {
  const lock = tmpDir('pw-open-' + createHash('sha256').update(env.PLAYWRIGHT_DAEMON_SESSION_DIR).digest('hex').slice(0, 20));
  let owned = false;
  for (let attempt = 0; attempt < 1200; attempt++) {
    try {
      fs.mkdirSync(lock);
      try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); }
      catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error; }
      owned = true; break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      reclaimStaleLock(lock);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (!owned) throw new Error('Browser is busy');
  try { return action(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

module.exports = { PLAYWRIGHT_VERSION, browserKey, currentEnvironment, realCli, readRun, readBrowser, browserIsOpen, withBrowserLock, commandError };
