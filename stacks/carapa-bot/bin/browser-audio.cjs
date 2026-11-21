'use strict';

// One private, output-only sound server per managed browser. Never connect to
// the sandbox's default sound server or a host audio device.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { withBrowserLock } = require('./browser-session.cjs');
const { containerSessionDir, tmpDir } = require('./browser-host.cjs');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function paths(env) {
  const context = env.PLAYWRIGHT_DAEMON_SESSION_DIR;
  const container = containerSessionDir(context);
  if (!container) throw new Error('Invalid audio context');
  const root = tmpDir('pwa-' + createHash('sha256').update(container).digest('hex').slice(0, 20));
  return { root, config: path.join(root, 'server.pa'), socket: path.join(root, 'native'),
    owner: path.join(root, 'owner.json'), enabled: path.join(root, 'browser-enabled') };
}

function birth(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; }
  catch { return undefined; }
}

function owner(state) {
  try {
    const value = JSON.parse(fs.readFileSync(state.owner, 'utf8'));
    const args = fs.readFileSync(`/proc/${value.pid}/cmdline`, 'utf8').split('\0');
    return Number.isSafeInteger(value.pid) && value.pid > 1 && value.birth &&
      birth(value.pid) === value.birth && args.includes(`--file=${state.config}`) ? value : undefined;
  } catch { return undefined; }
}

function pulseEnv(env, state) {
  const result = { ...env, PULSE_SERVER: `unix:${state.socket}`, PULSE_SINK: 'browser',
    PULSE_SOURCE: 'browser.monitor', PULSE_RUNTIME_PATH: state.root,
    PULSE_STATE_PATH: state.root, PULSE_CONFIG_PATH: state.root };
  delete result.CARAPA_AGENT_RUN_ID;
  return result;
}

function prepareAudio(env) {
  paths(env);
  return withBrowserLock({ PLAYWRIGHT_DAEMON_SESSION_DIR: env.PLAYWRIGHT_DAEMON_SESSION_DIR + '-audio' }, () => startAudio(env));
}

function startAudio(env) {
  const state = paths(env);
  if (!owner(state)) {
    // Older runtime images remain usable for silent browsing.
    if (!fs.existsSync('/usr/bin/pulseaudio') || !fs.existsSync('/usr/bin/parec')) return undefined;
    fs.mkdirSync(state.root, { recursive: true, mode: 0o700 });
    fs.rmSync(state.enabled, { force: true });
    fs.writeFileSync(state.config, [
      'load-module module-null-sink sink_name=browser rate=48000 channels=2',
      `load-module module-native-protocol-unix socket=${state.socket} auth-anonymous=1 auth-cookie-enabled=0`,
      'set-default-sink browser', 'set-default-source browser.monitor', '',
    ].join('\n'), { mode: 0o600 });
    const result = spawnSync('/usr/bin/pulseaudio', ['--daemonize=yes', '--use-pid-file=yes',
      '--exit-idle-time=-1', '--disable-shm=yes', '--high-priority=no', '--realtime=no',
      '--disallow-exit=yes', '--disallow-module-loading=yes', '--log-target=stderr',
      '-n', `--file=${state.config}`], {
      env: { ...pulseEnv(env, state),
        // Only the private server must avoid the desktop org.PulseAudio1 name.
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${state.root}/no-dbus`,
        DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${state.root}/no-dbus` },
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
    });
    if (result.status !== 0) {
      fs.writeFileSync(path.join(state.root, 'startup.log'), String(result.stderr || result.error?.message || 'Audio startup failed').slice(-8192), { mode: 0o600 });
      return undefined;
    }
    let pid;
    try { pid = Number(fs.readFileSync(path.join(state.root, 'pid'), 'utf8').trim()); }
    catch { return undefined; } // A sound server failure must not prevent browsing.
    fs.writeFileSync(state.owner, JSON.stringify({ pid, birth: birth(pid) }), { mode: 0o600 });
    if (!owner(state) || !fs.existsSync(state.socket)) {
      stopAudio(env);
      return undefined;
    }
  }
  return { ...pulseEnv(env, state), CARAPA_BROWSER_AUDIO_SERVER: state.socket };
}

function markAudioBrowser(env) {
  fs.writeFileSync(paths(env).enabled, '', { mode: 0o600 });
}

function audioStatus(env) {
  const state = paths(env);
  if (!fs.existsSync('/usr/bin/pulseaudio') || !fs.existsSync('/usr/bin/parec'))
    return { available: false, error: 'Sound requires an updated sandbox runtime.' };
  if (!owner(state) || !fs.existsSync(state.enabled))
    return { available: false, error: 'Restart this browser to enable sound.' };
  return { available: true };
}

function stopAudio(env) {
  const state = paths(env);
  const value = owner(state);
  if (value) {
    try { process.kill(value.pid, 'SIGTERM'); } catch { /* already exited */ }
    for (let i = 0; i < 40 && owner(state); i++) sleep(50);
    if (owner(state)?.pid === value.pid) process.kill(value.pid, 'SIGKILL');
  }
  fs.rmSync(state.root, { recursive: true, force: true });
}

function captureAudio(env, onFrame, onError) {
  const status = audioStatus(env);
  if (!status.available) throw new Error(status.error);
  const state = paths(env);
  const child = spawn('/usr/bin/parec', ['--raw', '--format=s16le', '--rate=48000',
    '--channels=2', '--latency-msec=40', '--device=browser.monitor', `--server=unix:${state.socket}`],
  { env: pulseEnv(env, state), stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = Buffer.alloc(0);
  let stopped = false;
  // Fixed 40 ms packets keep latency and frame size bounded independently of
  // pipe chunk boundaries. Each viewer owns only its capture process.
  const packetBytes = 48000 * 2 * 2 * 0.04;
  child.stdout.on('data', chunk => {
    if (stopped) return;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= packetBytes) {
      onFrame({ data: pending.subarray(0, packetBytes).toString('base64'), sampleRate: 48000, channels: 2 });
      pending = pending.subarray(packetBytes);
    }
  });
  const failed = () => { if (!stopped) { stopped = true; onError('Browser sound capture stopped.'); } };
  child.once('error', failed);
  child.once('exit', failed);
  return () => {
    stopped = true;
    pending = Buffer.alloc(0);
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
}

module.exports = { prepareAudio, markAudioBrowser, audioStatus, stopAudio, captureAudio };
