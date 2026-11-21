'use strict';
// Own only the optional foreground project hook started for this browser.
// No caller-provided executable, process ID, or upstream endpoint is accepted.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readBrowser, withBrowserLock } = require('./browser-session.cjs');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const files = env => {
  const root = path.join(env.PLAYWRIGHT_DAEMON_SESSION_DIR, 'app');
  return { root, owner: path.join(root, 'owner.json'), url: path.join(root, 'url'), log: path.join(root, 'log') };
};
function birth(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; }
  catch { return undefined; }
}
function owner(env) {
  try {
    const value = JSON.parse(fs.readFileSync(files(env).owner, 'utf8'));
    const cmd = fs.readFileSync(`/proc/${value.pid}/cmdline`, 'utf8').split('\0');
    return Number.isSafeInteger(value.pid) && value.pid > 1 && value.birth &&
      value.birth === birth(value.pid) && cmd[1] === __filename &&
      cmd[2] === env.CARAPA_BROWSER_SESSION_ID ? value : undefined;
  } catch { return undefined; }
}
function stopApp(env) {
  const value = owner(env);
  if (!value) return;
  process.kill(value.pid, 'SIGTERM');
  for (let i = 0; i < 200 && owner(env); i++) sleep(50);
  // Verify the same supervisor still owns the process group before escalation.
  if (owner(env)?.pid === value.pid) process.kill(-value.pid, 'SIGKILL');
}
function appUrl(env) {
  const file = files(env).url;
  if (!fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > 4096) throw new Error('Project browser hook returned an oversized URL');
  const value = fs.readFileSync(file, 'utf8').trim();
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Project browser hook must publish an HTTP or HTTPS URL');
  return value;
}
function startApp(env, cwd) {
  if (!fs.existsSync(path.join(cwd, '.agent/start-browser.sh'))) return undefined;
  // This lock is separate from the CLI open lock: a hook may authenticate the
  // shared browser itself, as CarapaBoard's existing UI sandbox launcher does.
  return withBrowserLock({ PLAYWRIGHT_DAEMON_SESSION_DIR: env.PLAYWRIGHT_DAEMON_SESSION_DIR + '-app' }, () => {
    const state = files(env);
    let started = false;
    if (!owner(env)) {
      started = true;
      fs.mkdirSync(state.root, { recursive: true, mode: 0o700 });
      for (const file of [state.owner, state.url, state.log]) fs.rmSync(file, { force: true });
      const child = spawn(process.execPath, [__filename, env.CARAPA_BROWSER_SESSION_ID], {
        cwd, env, detached: true, stdio: 'ignore',
      });
      // Handle spawn failure without an unhandled EventEmitter error. The
      // supervisor publishes its own ownership before launching project code.
      child.on('error', () => {});
      child.unref();
      if (!child.pid) throw new Error('Could not start project browser hook');
      for (let i = 0; i < 100 && !owner(env) && birth(child.pid); i++) sleep(50);
    }
    try {
      for (let i = 0; i < 1200; i++) {
        if (!owner(env)) throw new Error('Project browser hook exited before readiness');
        const url = appUrl(env);
        if (url) return { url, started };
        sleep(50);
      }
      throw new Error('Project browser hook did not publish its URL within 60 seconds');
    } catch (error) {
      stopApp(env);
      const detail = fs.existsSync(state.log) ? fs.readFileSync(state.log, 'utf8').slice(-2048).trim() : '';
      throw new Error(`${error.message}${detail ? `: ${detail}` : ''}`);
    }
  });
}
function supervise(id) {
  const { env, cwd, descriptor } = readBrowser(id);
  if (!descriptor) throw new Error('Project browser hooks require a persistent context');
  const state = files(env);
  const temporary = state.owner + '.' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, birth: birth(process.pid) }), { mode: 0o600 });
  fs.renameSync(temporary, state.owner);
  let log = '';
  const output = chunk => {
    log = (log + chunk.toString()).slice(-16 * 1024);
    fs.writeFileSync(state.log, log, { mode: 0o600 });
  };
  const child = spawn('bash', [path.join(cwd, '.agent/start-browser.sh')], {
    cwd, env: { ...env, CARAPA_BROWSER_URL_FILE: state.url }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', output);
  child.stderr.on('data', output);
  let stopping = false;
  const killGroup = () => process.kill(-process.pid, 'SIGKILL');
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Let the foreground hook shut its children/data down in order, then
    // release any descendants still in our private process group.
    child.kill('SIGTERM');
    setTimeout(killGroup, 8000);
  };
  child.once('error', error => { output(error.message); killGroup(); });
  child.once('exit', (code, signal) => { if (!stopping) output(`\nProject browser hook exited (${code ?? signal})`); killGroup(); });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: browser-app.cjs <contextId>');
  supervise(process.argv[2]);
}
module.exports = { startApp, stopApp, appUrl };
