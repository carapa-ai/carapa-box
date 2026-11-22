import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { controlRun } from '../control';
import { containerInstanceId, isAlive, terminateProcessTree } from '../processes';
import { stopRun } from '../stop';
import { discardMarker, safeSessionKey } from '../sessions';
import { loadAgentArgs } from '../contracts';
import { readJournal } from './journal';
import { startProtocolDaemon } from './daemon';
import { JsonRpcClient, object, type RpcMethod } from './rpc';

const roots: string[] = [];
const pids = new Set<number>();
const bin = resolve(import.meta.dir, '../..');
afterEach(async () => {
  for (const pid of pids) if (isAlive(pid)) await terminateProcessTree(pid);
  pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(agentCmd = 'omp-acp') {
  const root = mkdtempSync(join(tmpdir(), 'carapa-supervisor-test-'));
  roots.push(root);
  const fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  const home = join(root, 'home');
  mkdirSync(home);
  const cli = join(fakeBin, agentCmd === 'claude' ? 'claude' : 'omp');
  writeFileSync(cli, '#!/bin/sh\nexec "$TEST_BUN" "$TEST_ACP_PEER" "$@"\n');
  chmodSync(cli, 0o755);
  const transcript = join(root, 'protocol.jsonl');
  const environment = {
    PATH: `${fakeBin}:${process.env.PATH}`, HOME: home,
    TEST_BUN: process.execPath, TEST_ACP_PEER: join(import.meta.dir, agentCmd === 'claude' ? 'fixtures/claude-peer.ts' : 'fixtures/acp-peer.ts'),
    TEST_PROTOCOL_TRANSCRIPT: transcript, CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
    CARAPA_PERSIST_TURN_TIMEOUT: '10',
  };
  function run(name: string, prompt = 'complete') {
    const runDir = join(root, 'ipc', 'runs', name);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'prompt.txt'), prompt);
    writeFileSync(join(runDir, 'args.json'), JSON.stringify({ agentCmd, workDir: root,
      persistent: '1', conversationKey: 'conversation-test', env: environment, metricsContract: 1 }));
    return runDir;
  }
  return { root, transcript, run };
}

async function waitFor(check: () => boolean, message: string, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(10); }
  throw new Error(`Timed out: ${message}`);
}
function pidFile(run: string, name: string): number {
  const pid = Number(readFileSync(join(run, name), 'utf8'));
  pids.add(pid);
  return pid;
}
async function launch(run: string): Promise<number> {
  const client = Bun.spawn([join(bin, 'run-agent.sh'), run], { stdout: 'pipe', stderr: 'inherit' });
  const pid = Number(await new Response(client.stdout).text());
  expect(await client.exited).toBe(0);
  pids.add(pid);
  return pid;
}

test.each(['omp-acp', 'claude'])('an attached controller can die and reconnect without duplicating the active turn; interrupt retains the daemon (%s)', async (harness) => {
  const f = fixture(harness);
  const run = f.run('first', 'hold');
  const controller = Bun.spawn([join(bin, 'run-agent.sh'), '--exec', run], { detached: true, stdout: 'ignore', stderr: 'inherit' });
  pids.add(controller.pid);
  await waitFor(() => existsSync(join(run, 'prompt_dispatched_at_ms')), 'prompt dispatch');
  const worker = pidFile(run, 'worker.pid');
  const daemon = pidFile(run, 'pid');
  expect(worker).not.toBe(controller.pid);
  controller.kill('SIGKILL');
  await controller.exited;
  expect(isAlive(worker)).toBe(true);
  expect(isAlive(daemon)).toBe(true);
  expect(await launch(run)).toBe(worker);
  expect(await controlRun(run, 'interrupt')).toEqual({ ok: true, action: 'interrupt' });
  expect(isAlive(daemon)).toBe(true);
  const events = readFileSync(join(run, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ type: 'run', status: 'interrupted' });
  const next = f.run('second');
  await launch(next);
  await waitFor(() => existsSync(join(next, 'metrics_complete')), 'follow-up completion');
  expect(pidFile(next, 'pid')).toBe(daemon);
  const frames = readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(frames.filter(frame => (frame.method === 'initialize' || frame.request?.subtype === 'initialize'))).toHaveLength(1);
  expect(frames.filter(frame => (frame.method === 'session/prompt' || frame.type === 'user'))).toHaveLength(2);
  expect(readFileSync(join(next, 'exit_code'), 'utf8')).toBe('0');
}, 15_000);

test('a lifecycle.lock left by a killed controller does not block later lifecycle controls', async () => {
  const f = fixture();
  const first = f.run('first');
  await launch(first);
  await waitFor(() => existsSync(join(first, 'metrics_complete')), 'first completion');
  const session = readFileSync(join(first, 'session_dir'), 'utf8');
  const dead = Bun.spawn(['true']);
  await dead.exited;
  const lock = join(session, 'lifecycle.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(dead.pid));
  expect(await controlRun(first, 'stop-daemon')).toEqual({ ok: true, action: 'stop-daemon' });
  expect(existsSync(lock)).toBe(false);
}, 15_000);

test.each(['omp-acp', 'claude'])('daemon shutdown preserves resume state; discard removes managed history and rejects stale resume IDs (%s)', async (harness) => {
  const f = fixture(harness);
  const first = f.run('first');
  await launch(first);
  await waitFor(() => existsSync(join(first, 'metrics_complete')), 'first completion');
  const daemon = pidFile(first, 'pid');
  const session = readFileSync(join(first, 'session_dir'), 'utf8');
  const sessionId = readFileSync(join(session, 'session_id'), 'utf8');
  expect(await controlRun(first, 'stop-daemon')).toEqual({ ok: true, action: 'stop-daemon' });
  expect(isAlive(daemon)).toBe(false);
  expect(readFileSync(join(session, 'session_id'), 'utf8')).toBe(sessionId);
  const second = f.run('second');
  await launch(second);
  await waitFor(() => existsSync(join(second, 'metrics_complete')), 'resumed completion');
  expect(pidFile(second, 'pid')).not.toBe(daemon);
  expect(readFileSync(join(session, 'session_id'), 'utf8')).toBe(sessionId);
  expect(await controlRun(second, 'discard-conversation')).toEqual({ ok: true, action: 'discard-conversation' });
  expect(existsSync(session)).toBe(false);
  const third = f.run('third');
  const argsPath = join(third, 'args.json');
  writeFileSync(argsPath, JSON.stringify({ ...JSON.parse(readFileSync(argsPath, 'utf8')), sessionId }));
  expect(loadAgentArgs(third).sessionId).toBe('');
  await launch(third);
  await waitFor(() => existsSync(join(third, 'metrics_complete')), 'fresh conversation');
  pidFile(third, 'pid');
  const newSessionId = readFileSync(join(session, 'session_id'), 'utf8');
  expect(newSessionId).not.toBe(sessionId);
  // Once the idle session dir is pruned, the explicit ID of the post-discard session must still resume.
  rmSync(session, { recursive: true, force: true });
  const fourth = f.run('fourth');
  const fourthArgs = join(fourth, 'args.json');
  writeFileSync(fourthArgs, JSON.stringify({ ...JSON.parse(readFileSync(fourthArgs, 'utf8')), sessionId: newSessionId }));
  expect(loadAgentArgs(fourth).sessionId).toBe(newSessionId);
  writeFileSync(fourthArgs, JSON.stringify({ ...JSON.parse(readFileSync(fourthArgs, 'utf8')), sessionId }));
  expect(loadAgentArgs(fourth).sessionId).toBe('');
}, 15_000);

test('discard records a Codex thread_id written before the first turn finished', async () => {
  const f = fixture();
  const first = f.run('first');
  const key = 'conversation-test';
  const session = join(f.root, 'ipc', 'sessions', safeSessionKey(key));
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'thread_id'), 'T-codex');
  writeFileSync(join(first, 'session_dir'), session);
  expect(await controlRun(first, 'discard-conversation')).toEqual({ ok: true, action: 'discard-conversation' });
  expect(JSON.parse(readFileSync(discardMarker(first, key), 'utf8')).sessionIds).toEqual(['T-codex']);
  const next = f.run('next');
  const nextArgs = join(next, 'args.json');
  writeFileSync(nextArgs, JSON.stringify({ ...JSON.parse(readFileSync(nextArgs, 'utf8')), sessionId: 'T-codex' }));
  expect(loadAgentArgs(next).sessionId).toBe('');
});

test('a marker without recorded session IDs rejects no resume ID', () => {
  const f = fixture();
  const run = f.run('first');
  const key = 'conversation-test';
  const marker = discardMarker(run, key);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ discardedAt: new Date().toISOString() }));
  const args = join(run, 'args.json');
  writeFileSync(args, JSON.stringify({ ...JSON.parse(readFileSync(args, 'utf8')), conversationKey: key, sessionId: 'S-kept' }));
  expect(loadAgentArgs(run).sessionId).toBe('S-kept');
});

test('lifecycle controls reject a foreign session and a stale container generation', async () => {
  const f = fixture();
  const run = f.run('first');
  const foreign = join(f.root, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'history'), 'keep');
  writeFileSync(join(run, 'session_dir'), foreign);
  expect((await controlRun(run, 'discard-conversation')).ok).toBe(false);
  expect(readFileSync(join(foreign, 'history'), 'utf8')).toBe('keep');
  writeFileSync(join(run, 'session_instance'), `${containerInstanceId()}-old`);
  expect((await controlRun(run, 'stop-daemon')).error).toContain('earlier container');
});

test('typed RPC correlates responses without swallowing server requests and handles send/remote failures', async () => {
  const frames: Array<Record<string, unknown>> = [];
  const client = new JsonRpcClient<{ ping: RpcMethod<{ value: string }, Record<string, unknown>> }>(
    line => frames.push(JSON.parse(line)), (_method, value) => object(value), 100,
  );
  const response = client.send('ping', { value: 'test' });
  const id = frames[0].id as string;
  expect(client.handleResponse({ id, method: 'approval', params: {} })).toBe(false);
  expect(client.handleResponse({ id, result: { ok: true } })).toBe(true);
  expect(await response).toEqual({ ok: true });
  const bad = client.send('ping', { value: 'bad' });
  client.handleResponse({ id: frames[1].id as string, result: [] });
  await expect(bad).rejects.toThrow('protocol object');
  const closed = client.send('ping', { value: 'closing' });
  client.rejectAll(new Error('disconnected'));
  await expect(closed).rejects.toThrow('disconnected');
});

test('journal offsets preserve partial UTF-8 frames without replaying earlier output', () => {
  const f = fixture();
  const journal = join(f.root, 'frames');
  const capture = join(f.root, 'capture');
  const cursor = { offset: 0 };
  writeFileSync(journal, '{"text":"first"}\n{"text":"');
  expect(readJournal(journal, cursor, capture)).toEqual(['{"text":"first"}']);
  expect(readJournal(journal, cursor, capture)).toEqual([]);
  writeFileSync(journal, '{"text":"first"}\n{"text":"țară"}\n');
  expect(readJournal(journal, cursor, capture)).toEqual(['{"text":"țară"}']);
  expect(readFileSync(capture)).toEqual(readFileSync(journal));
});

test.each(['omp-acp', 'claude'])('concurrent launch claims dispatch only once and an older run cannot stop the new owner (%s)', async (harness) => {
  const f = fixture(harness);
  const first = f.run('first');
  const claims = await Promise.all([launch(first), launch(first), launch(first)]);
  expect(new Set(claims).size).toBe(1);
  await waitFor(() => existsSync(join(first, 'metrics_complete')), 'first completion');
  const daemon = pidFile(first, 'pid');
  const next = f.run('next', 'hold');
  await launch(next);
  await waitFor(() => existsSync(join(next, 'prompt_dispatched_at_ms')), 'next prompt');
  expect((await controlRun(first, 'stop-daemon')).error).toContain('Another run owns');
  expect((await stopRun(first)).status).toBe('failed');
  expect(isAlive(daemon)).toBe(true);
  expect((await controlRun(next, 'interrupt')).ok).toBe(true);
  const frames = readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(frames.filter(frame => (frame.method === 'session/prompt' || frame.type === 'user'))).toHaveLength(2);
}, 15_000);

test('Claude warm turns reuse one process and recover history after shutdown', async () => {
  const f = fixture('claude');
  const first = f.run('first');
  await launch(first);
  await waitFor(() => existsSync(join(first, 'metrics_complete')), 'first Claude completion');
  const daemon = pidFile(first, 'pid');
  const session = readFileSync(join(first, 'session_dir'), 'utf8');
  const id = readFileSync(join(session, 'session_id'), 'utf8');
  const second = f.run('second');
  await launch(second);
  await waitFor(() => existsSync(join(second, 'metrics_complete')), 'warm Claude completion');
  expect(readFileSync(join(second, 'exit_code'), 'utf8')).toBe('0');
  expect(pidFile(second, 'pid')).toBe(daemon);
  expect(readFileSync(join(second, 'output.v1.jsonl'), 'utf8')).toContain('turn 2: complete');
  expect(readFileSync(join(second, 'output.v1.jsonl'), 'utf8')).not.toContain('turn 1:');
  expect(readFileSync(join(second, 'output.v1.jsonl'), 'utf8')).toContain('"status":"resumed"');
  expect((await controlRun(second, 'stop-daemon')).ok).toBe(true);
  const third = f.run('third');
  await launch(third);
  await waitFor(() => existsSync(join(third, 'metrics_complete')), 'Claude recovery');
  for (const run of [first, second, third]) {
    const metrics = JSON.parse(readFileSync(join(run, 'metrics.json'), 'utf8'));
    expect(metrics.costUsd).toBeCloseTo(0.01, 10);
    expect(metrics.cost.source).toBe('claude');
  }
  expect(pidFile(third, 'pid')).not.toBe(daemon);
  const calls = readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const launches = calls.filter(call => call.type === 'launch');
  expect(launches).toHaveLength(2);
  expect(launches[1].args).toContain(`--resume=${id}`);
}, 15_000);

test('large prompts cross the supervisor spool without truncation', async () => {
  const f = fixture();
  const prompt = 'țară'.repeat(50_000);
  const run = f.run('large', prompt);
  await launch(run);
  await waitFor(() => existsSync(join(run, 'metrics_complete')), 'large prompt completion');
  pidFile(run, 'pid');
  const frames = readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(frames.find(frame => (frame.method === 'session/prompt' || frame.type === 'user')).params.prompt[0].text).toBe(prompt);
  expect(readFileSync(join(run, 'exit_code'), 'utf8')).toBe('0');
}, 15_000);

test.each(['omp-acp', 'claude'])('stopping an active daemon finalizes the run without deleting resume state (%s)', async (harness) => {
  const f = fixture(harness);
  const run = f.run('active', 'hold');
  await launch(run);
  await waitFor(() => existsSync(join(run, 'prompt_dispatched_at_ms')), 'active prompt');
  const daemon = pidFile(run, 'pid');
  const worker = pidFile(run, 'worker.pid');
  const session = readFileSync(join(run, 'session_dir'), 'utf8');
  // Claude persists session_id only when the peer's init arrives, after prompt dispatch.
  await waitFor(() => existsSync(join(session, 'session_id')), 'native session id');
  expect((await controlRun(run, 'stop-daemon')).ok).toBe(true);
  expect(isAlive(daemon)).toBe(false);
  expect(isAlive(worker)).toBe(false);
  expect(existsSync(join(session, 'session_id'))).toBe(true);
  const events = readFileSync(join(run, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ type: 'run', status: 'failed' });
}, 15_000);


test('Claude replaces an abandoned worker turn before accepting a follow-up', async () => {
  const f = fixture('claude');
  const first = f.run('abandoned', 'hold');
  await launch(first);
  const session = join(f.root, 'ipc/sessions/conversation-test');
  await waitFor(() => existsSync(join(session, 'session_id')), 'Claude native session');
  const nativeId = readFileSync(join(session, 'session_id'), 'utf8');
  const worker = pidFile(first, 'worker.pid');
  const daemon = pidFile(first, 'pid');
  process.kill(worker, 'SIGKILL');
  await waitFor(() => !isAlive(worker), 'dead worker');
  expect(isAlive(daemon)).toBe(true);
  const next = f.run('recovered');
  await launch(next);
  await waitFor(() => existsSync(join(next, 'metrics_complete')), 'recovered Claude turn');
  expect(readFileSync(join(next, 'exit_code'), 'utf8')).toBe('0');
  expect(pidFile(next, 'pid')).not.toBe(daemon);
  expect(isAlive(daemon)).toBe(false);
  expect(readFileSync(join(session, 'session_id'), 'utf8')).toBe(nativeId);
}, 15_000);

test('an idle-reaped supervisor removes its daemon.pid so a reused PID is never recorded as the daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-supervisor-test-'));
  roots.push(root);
  const sessionDir = join(root, 'session');
  mkdirSync(sessionDir);
  const input = join(sessionDir, 'acp-input');
  const launched = await startProtocolDaemon({
    command: ['sleep', '60'], cwd: root, env: process.env, input,
    output: join(sessionDir, 'out'), stderr: join(sessionDir, 'err'), sessionDir, idleMs: 100,
  });
  pids.add(launched.pid);
  writeFileSync(join(sessionDir, 'daemon.pid'), String(launched.pid));
  await waitFor(() => existsSync(join(input, 'exit.json')), 'idle reap');
  expect(existsSync(join(sessionDir, 'daemon.pid'))).toBe(false);
});

test('a follow-up turn never terminates an unrelated process recorded in a stale daemon.pid', async () => {
  const f = fixture();
  const first = f.run('first');
  await launch(first);
  await waitFor(() => existsSync(join(first, 'metrics_complete')), 'first completion');
  const session = readFileSync(join(first, 'session_dir'), 'utf8');
  expect((await controlRun(first, 'stop-daemon')).ok).toBe(true);
  const bystander = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  pids.add(bystander.pid);
  writeFileSync(join(session, 'daemon.pid'), String(bystander.pid));
  const second = f.run('second');
  await launch(second);
  await waitFor(() => existsSync(join(second, 'metrics_complete')), 'resumed completion');
  expect(isAlive(bystander.pid)).toBe(true);
  expect(readFileSync(join(second, 'exit_code'), 'utf8')).toBe('0');
}, 15_000);
