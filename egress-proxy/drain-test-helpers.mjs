// Shared helpers for the *-drain tests: spawn a harness child and talk to it.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// The harness talks to fake upstreams on loopback addresses such as 127.0.0.2,
// which NO_PROXY usually does not list; drop the ambient proxy settings so the
// child never routes them through a real egress proxy (NODE_USE_ENV_PROXY).
const PROXY_ENV = /^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i;

export function spawnHarness(source, env, execPath = process.execPath) {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PROXY_ENV.test(k)));
  const child = spawn(execPath, ['--input-type=module', '-e', source], {
    env: { ...ambient, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '', exit: null, exitedAt: null };
  child.stdout.on('data', d => { state.out += d; });
  child.stderr.on('data', d => { state.out += d; });
  state.exited = new Promise(r => child.once('exit', (code, signal) => { state.exit = { code, signal }; state.exitedAt = Date.now(); r(state.exit); }));
  state.child = child;
  state.ready = async (re = /READY (\d+)/) => {
    for (let i = 0; i < 200; i++) {
      const m = state.out.match(re);
      if (m) return Number(m[1]);
      if (state.exit) throw new Error(`child exited early: ${state.out}`);
      await sleep(50);
    }
    throw new Error(`child not ready: ${state.out}`);
  };
  return state;
}

export function getJson(port, path = '/_inflight') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
      let b = ''; res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

// Start a streaming GET; resolves { firstChunk, done } once headers arrive.
export function startStream(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
      let body = '';
      const done = new Promise(r => { res.on('end', () => r(body)); res.on('error', () => r(body + '[error]')); res.on('close', () => r(body + '[close]')); });
      res.once('data', () => resolve({ done }));
      res.on('data', d => { body += d; });
    });
    req.on('error', reject);
  });
}

export function connectRefused(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

// Open a connection and send a partial request so it is not "idle"; the
// caller finishes it later (used to query /_inflight while draining).
export function partialRequest(port, path) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n`);
      resolve({
        finish: () => new Promise(r => {
          let b = ''; s.on('data', d => { b += d; }); s.on('close', () => r(b)); s.on('error', () => r(b));
          s.write('Connection: close\r\n\r\n');
        }),
      });
    });
  });
}
