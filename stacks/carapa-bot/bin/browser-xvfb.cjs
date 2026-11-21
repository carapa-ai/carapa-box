'use strict';
// Local Chromium launch options for the shared browser. CARAPA_BROWSER_HEADED=1
// runs Chromium headed on one shared virtual display, so a human using the
// Browser tab is not blocked by bot checks that reject "HeadlessChrome". It is
// not a challenge solver: agents must not automate those clicks.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DISPLAY = ':99';
const READY_MS = 5000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Our detached child is never reaped while this script is synchronous: a
// zombie (or missing) process has already exited.
const exited = pid => {
  try { return /^\d+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};

// A socket file outlives a killed Xvfb or a crashed sandbox (/tmp persists), so
// only a successful connection proves the display is up.
const listening = socket => spawnSync(process.execPath, ['-e',
  "const s = require('node:net').connect(process.argv[1]); s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 2000)",
  socket], { timeout: 5000 }).status === 0;

// One Xvfb per sandbox, started on first use and reused by every later start
// and restart, so repeated opens never leak processes. Fails closed.
function ensureDisplay(env = process.env) {
  const dir = env.CARAPA_X11_DIR || '/tmp/.X11-unix';
  const socket = path.join(dir, 'X' + DISPLAY.slice(1));
  if (fs.existsSync(socket)) {
    if (listening(socket)) return DISPLAY;
    // Stale leftovers of a dead server: clear them so a new Xvfb can bind.
    fs.rmSync(socket, { force: true });
    fs.rmSync(path.join(path.dirname(dir), `.X${DISPLAY.slice(1)}-lock`), { force: true });
  }
  // Xvfb cannot create this directory as a non-root user.
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o1777); } catch { /* owned by someone else: Xvfb only warns */ }
  const child = spawn('Xvfb', [DISPLAY, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
  if (!child.pid) throw new Error('CARAPA_BROWSER_HEADED=1 needs Xvfb, which is not installed');
  for (let waited = 0; waited < READY_MS && !exited(child.pid); waited += 50) {
    if (fs.existsSync(socket) && listening(socket)) return DISPLAY;
    sleep(50);
  }
  if (fs.existsSync(socket) && listening(socket)) return DISPLAY;
  try { process.kill(-child.pid); } catch { /* already gone */ }
  throw new Error(`CARAPA_BROWSER_HEADED=1 but Xvfb did not start on display ${DISPLAY}`);
}

function localLaunch(env = process.env) {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  const headed = env.CARAPA_BROWSER_HEADED === '1';
  return {
    launchOptions: { executablePath: env.CHROMIUM_PATH || '/usr/bin/chromium', headless: !headed,
      args: headed ? [...args, '--disable-blink-features=AutomationControlled'] : args },
    display: headed ? ensureDisplay(env) : undefined,
  };
}

module.exports = { localLaunch };
