import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveStackAndProject } from '../utils.js';
import { execCompose } from '../compose/client.js';
import { resolveTrustedCommand, validateCommand } from '../security.js';
import { auditLog } from '../audit.js';
import { bearerToken, safeTokenCompare } from './auth.js';

export const BROWSER_MAX_FRAME = 4 * 1024 * 1024;
export const BROWSER_MAX_INPUT = 64 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export type BrowserTarget = { stack: string; service: string; instance?: string; sessionId: string };
export type BrowserBridge = { input(line: string): void; close(): void };
type Emit = (line: string) => void;
export interface BrowserBridgeDeps {
  open(target: BrowserTarget, emit: Emit, ended: () => void): Promise<BrowserBridge>;
}
export interface BrowserHandlerOptions {
  /** Skip the bearer check: only for a caller that already authenticated the request (the runner's in-process hub tunnel). */
  trusted?: boolean;
}
/** A refusal `open` reports with its own HTTP status (the default for any other open failure is 502). */
export class BrowserOpenError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readBody(req: Request): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > BROWSER_MAX_INPUT) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

/**
 * Turns the helper's stdout chunks into NDJSON frames: each complete line must be JSON,
 * and an unfinished line over the frame cap or an invalid line closes the viewer.
 */
export function frameLines(emit: Emit, close: () => void): (chunk: string) => void {
  let pending = '';
  return chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > BROWSER_MAX_FRAME) { close(); return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { JSON.parse(line); emit(line + '\n'); } catch { close(); return; }
    }
  };
}

async function openBridge(target: BrowserTarget, emit: Emit, ended: () => void): Promise<BrowserBridge> {
  const { stackPath, projectName } = await resolveStackAndProject(target.stack, target.instance);
  if (!stackPath) throw new Error('Sandbox stack not found');
  const resolved = await resolveTrustedCommand(stackPath, `browser-viewer ${target.sessionId}`);
  if (!resolved.ok) throw new Error(resolved.reason);
  const command = resolved.value.command;
  const permission = await validateCommand(stackPath, target.service, command, 'sandbox_exec', { shellFree: true });
  auditLog({ timestamp: new Date().toISOString(), tool: 'sandbox_browser_attach',
    stack: target.stack, service: target.service, projectName, command,
    allowed: permission.allowed, reason: permission.reason, policy_name: permission.policy_name });
  if (!permission.allowed) throw new Error(permission.reason || 'Browser viewer denied by stack policy');
  const result = await execCompose(stackPath, ['ps', '-q', target.service], { projectName, allowFailure: true });
  const container = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Running sandbox service not found');
  const proc = spawn('docker', ['exec', '-i', '-u', '1000', container, ...resolved.value.argv], {
    cwd: stackPath, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    proc.stdin.end(); // EOF lets the trusted helper stop its own server cleanly.
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2500);
    timer.unref();
    proc.once('exit', () => clearTimeout(timer));
    ended();
  };
  proc.on('error', close);
  proc.on('exit', close);
  proc.stdin.on('error', close);
  proc.stderr.resume();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', frameLines(emit, close));
  return { close, input(line) {
    if (closed || proc.stdin.writableLength + Buffer.byteLength(line) > BROWSER_MAX_INPUT) throw new Error('Browser input backpressure');
    proc.stdin.write(line);
  } };
}

/** One attach response owns one exec stream. Disconnect and DELETE are idempotent. */
export function createBrowserHandler(deps: BrowserBridgeDeps = { open: openBridge }, options: BrowserHandlerOptions = {}) {
  const bridges = new Map<string, BrowserBridge>();
  let opening = 0;
  return async (req: Request, server?: { timeout(req: Request, seconds: number): void } | null): Promise<Response> => {
    const expected = process.env.CARAPA_BOX_API_TOKEN;
    const provided = bearerToken(req.headers);
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    if (!options.trusted && (!expected || !provided || !safeTokenCompare(expected, provided))) return json(401, { error: 'Unauthorized' });
    const url = new URL(req.url);
    if (url.pathname === '/api/browser/attach' && req.method === 'POST') {
      if (bridges.size + opening >= 64) return json(429, { error: 'Browser viewer capacity reached' });
      const body = await readBody(req);
      if (body === null) return json(413, { error: 'Request too large' });
      let target: BrowserTarget;
      try { target = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (!target || ![target.stack, target.service, target.sessionId].every(v => typeof v === 'string' && identifier.test(v)) ||
          (target.instance !== undefined && (typeof target.instance !== 'string' || !identifier.test(target.instance)))) return json(400, { error: 'Invalid browser target' });
      if (bridges.size + opening >= 64) return json(429, { error: 'Browser viewer capacity reached' });
      server?.timeout(req, 0);
      const id = randomUUID();
      let bridge: BrowserBridge | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const encoder = new TextEncoder();
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        bridges.delete(id);
        req.signal.removeEventListener('abort', finish);
        bridge?.close();
        try { controller.close(); } catch { /* consumer cancelled */ }
      };
      const emit = (line: string) => {
        if (closed) return;
        const bytes = encoder.encode(line);
        if (bytes.length > BROWSER_MAX_FRAME || (controller.desiredSize ?? 0) < bytes.length) { finish(); return; }
        controller.enqueue(bytes);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; }, cancel: finish,
      }, { highWaterMark: BROWSER_MAX_FRAME * 2, size: bytes => bytes?.byteLength ?? 0 });
      opening++;
      try {
        emit(JSON.stringify({ type: 'attached', viewerId: id }) + '\n');
        bridge = await deps.open(target, emit, finish);
        if (closed) bridge.close();
        else if (req.signal.aborted) finish();
        else {
          bridges.set(id, bridge);
          req.signal.addEventListener('abort', finish, { once: true });
          heartbeat = setInterval(() => emit('{"type":"heartbeat"}\n'), 15_000);
          heartbeat.unref();
        }
        return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
      } catch (error) {
        finish();
        return json(error instanceof BrowserOpenError ? error.status : 502, { error: error instanceof Error ? error.message : 'Browser attach failed' });
      } finally { opening--; }
    }
    const match = url.pathname.match(/^\/api\/browser\/([a-f0-9-]{36})(\/input)?$/);
    if (!match) return json(404, { error: 'Not found' });
    const bridge = bridges.get(match[1]);
    if (req.method === 'DELETE' && !match[2]) { bridge?.close(); bridges.delete(match[1]); return json(200, { ok: true }); }
    if (!bridge) return json(410, { error: 'Viewer disconnected' });
    if (req.method !== 'POST' || !match[2]) return json(405, { error: 'Method not allowed' });
    const body = await readBody(req);
    if (body === null) return json(413, { error: 'Browser input too large' });
    try {
      const messages: unknown = JSON.parse(body);
      if (!Array.isArray(messages) || messages.length > 128) return json(400, { error: 'Expected a bounded message batch' });
      const lines = messages.map(message => {
        if (typeof message !== 'string' || message.includes('\n')) throw new Error('Invalid message');
        JSON.parse(message);
        return message + '\n';
      }).join('');
      bridge.input(lines);
      return json(200, { ok: true });
    } catch { bridge.close(); return json(400, { error: 'Invalid or backpressured browser input' }); }
  };
}
export const handleBrowserRequest = createBrowserHandler();
