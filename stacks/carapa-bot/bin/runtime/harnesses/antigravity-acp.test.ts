import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRunContext } from '../contracts';
import { executeRun } from '../runner';
import { isAlive, terminateProcessTree } from '../processes';
import { antigravityAcpContract, antigravityReply } from './antigravity-acp';

const roots: string[] = [];
const pids = new Set<number>();
const binDir = resolve(import.meta.dir, '../..');
afterEach(async () => {
  for (const pid of pids) if (isAlive(pid)) await terminateProcessTree(pid);
  pids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carapa-agy-acp-'));
  roots.push(root);
  const binary = join(root, 'antigravity');
  const log = join(root, 'protocol.jsonl');
  writeFileSync(binary, '#!/bin/sh\nexec "$TEST_BUN" "$TEST_PEER" "$@"\n');
  chmodSync(binary, 0o755);
  const home = join(root, 'home');
  mkdirSync(home);
  function context(name: string, persistent = true, prompt = 'complete') {
    const runDir = join(root, 'ipc', 'runs', name);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'prompt.txt'), prompt);
    writeFileSync(join(runDir, 'args.json'), JSON.stringify({
      agentCmd: 'antigravity-acp', persistent: persistent ? '1' : '',
      groupFolder: 'test-group', conversationId: 'test-conversation',
      conversationKey: persistent ? 'agy-test' : '', workDir: root, model: 'gemini-test',
      env: { HOME: home, PATH: process.env.PATH, GEMINI_API_KEY: 'test-only-key',
        GOOGLE_API_KEY: 'must-not-inherit', GOOGLE_CLOUD_PROJECT: 'wrong-account',
        ANTIGRAVITY_ACP_BIN: binary,
        ANTIGRAVITY_ACP_API_KEY_FILE: join(root, 'absent-secret'),
        TEST_BUN: process.execPath, TEST_PEER: resolve(import.meta.dir, '../protocol/fixtures/antigravity-peer.ts'),
        TEST_PROTOCOL_TRANSCRIPT: log, CARAPA_RUN_MEMORY_LIMIT_MIB: '0', CARAPA_PERSIST_TURN_TIMEOUT: '3' },
    }));
    return createRunContext(runDir, binDir);
  }
  const frames = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const daemon = (runDir: string) => { const pid = Number(readFileSync(join(runDir, 'pid'), 'utf8')); pids.add(pid); return pid; };
  return { root, context, frames, daemon };
}

test('ACP is independently selectable, authenticates, reuses warm sessions and resumes after shutdown', async () => {
  const f = fixture();
  const first = f.context('first');
  expect(await executeRun(first)).toBe(0);
  const pid = f.daemon(first.runDir);
  const session = readFileSync(join(first.runDir, 'session_dir'), 'utf8');
  const sessionId = readFileSync(join(session, 'session_id'), 'utf8');
  const second = f.context('second');
  expect(await executeRun(second)).toBe(0);
  expect(f.daemon(second.runDir)).toBe(pid);
  expect(f.frames().filter(frame => frame.method === 'initialize')).toHaveLength(1);
  await terminateProcessTree(pid);
  rmSync(session, { recursive: true });
  const third = f.context('third');
  third.args.sessionId = sessionId; // Same native ID supplied by Board after runtime cleanup.
  expect(await executeRun(third)).toBe(0);
  expect(f.daemon(third.runDir)).not.toBe(pid);
  const frames = f.frames();
  expect(frames.find(frame => frame.method === 'authenticate').params).toEqual({ methodId: 'gemini-api-key' });
  expect(frames.find(frame => frame.method === 'session/resume').params.sessionId).toBe(sessionId);
  expect(frames.find(frame => frame.startup)).toMatchObject({
    googleKeyPresent: false, googleProjectPresent: false, hasGeminiKey: true,
    argv: ['acp', '--gemini-dir', third.env.GEMINI_HOME, '--disable-telemetry', '--dangerously-skip-permissions'],
    dummyGeminiKey: true, endpoint: 'http://api-relay:8080/google',
  });
  // Without modelProvider the CLI bypasses the relay and calls Google directly.
  expect(JSON.parse(readFileSync(join(third.env.GEMINI_HOME!, 'antigravity-cli', 'settings.json'), 'utf8'))).toEqual({ modelProvider: 'gemini' });
  expect(frames.find(frame => frame.id === 'permission-1' && frame.result).result.outcome.optionId).toBe('native-once-opaque');
  expect(frames.some(frame => frame.method === 'session/set_config_option' && frame.params.configId === 'model' && frame.params.value === 'gemini-test')).toBe(true);
  const events = readFileSync(join(third.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events).toContainEqual({ type: 'session', id: sessionId, status: 'resumed' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', status: 'completed', output: 'ok' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 10, outputTokens: 2 }));
  expect(events.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
  const changed = f.context('changed');
  changed.env.GOOGLE_GEMINI_BASE_URL = 'http://different-relay:8080/google';
  expect(await executeRun(changed)).toBe(1);
  expect(readFileSync(join(changed.runDir, 'agent-stderr.log'), 'utf8')).toContain('configuration changed');
}, 15_000);

test('switching a persistent conversation back to auto restores the model the session started on', async () => {
  const f = fixture();
  const chosen = f.context('chosen');
  expect(await executeRun(chosen)).toBe(0);
  f.daemon(chosen.runDir);
  const auto = f.context('auto');
  auto.args.model = 'auto';
  expect(await executeRun(auto)).toBe(0);
  const again = f.context('again');
  again.args.model = 'auto';
  expect(await executeRun(again)).toBe(0);
  const values = f.frames().filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params.value);
  // One explicit choice, one reset to the session's starting model; a second auto turn changes nothing.
  expect(values).toEqual(['gemini-test', 'gemini-default']);
}, 15_000);

test('fresh ACP turns retire their daemon; failed native resume never starts a replacement conversation', async () => {
  const f = fixture();
  const fresh = f.context('fresh', false);
  expect(await executeRun(fresh)).toBe(0);
  expect(isAlive(f.daemon(fresh.runDir))).toBe(false);
  const resume = f.context('resume');
  resume.args.sessionId = 'missing-session';
  expect(await executeRun(resume)).toBe(1);
  expect(f.frames().filter(frame => frame.method === 'session/new')).toHaveLength(1);
  expect(readFileSync(join(resume.runDir, 'persistent_resume_failed'), 'utf8')).toBe('missing-session');
}, 10_000);

test('fresh and persistent Antigravity turns share native storage across runtime eviction', async () => {
  const f = fixture();
  const fresh = f.context('fresh', false);
  expect(await executeRun(fresh)).toBe(0);
  const sessionId = JSON.parse(readFileSync(join(fresh.runDir, 'metrics.json'), 'utf8')).sessionId;
  const resume = f.context('resume');
  resume.args.sessionId = sessionId;
  expect(await executeRun(resume)).toBe(0);
  f.daemon(resume.runDir);
  expect(resume.env.GEMINI_HOME).toBe(fresh.env.GEMINI_HOME);
  expect(f.frames().filter(frame => frame.method === 'session/new')).toHaveLength(1);
}, 10_000);

test('provider errors streamed as text fail the turn despite a successful ACP response', async () => {
  const f = fixture();
  const context = f.context('provider-error', false, 'provider-error');
  expect(await executeRun(context)).toBe(1);
  expect(isAlive(f.daemon(context.runDir))).toBe(false);
  const events = readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ type: 'run', status: 'failed' });
  const compatibility = readFileSync(join(context.runDir, 'output.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(compatibility.at(-1)).toMatchObject({ type: 'turn.failed' });
  expect(readFileSync(join(context.runDir, 'exit_code'), 'utf8')).toBe('1');
  expect(existsSync(join(context.runDir, 'metrics_complete'))).toBe(true);
}, 10_000);

test('questions fail explicitly instead of selecting an answer; OAuth never starts an implicit login', async () => {
  const f = fixture();
  const question = f.context('question', false, 'question');
  expect(await executeRun(question)).toBe(1);
  expect(readFileSync(join(question.runDir, 'agent-stderr.log'), 'utf8')).toContain('user choice is required');
  expect(f.frames().some(frame => frame.id === 'permission-1' && frame.result)).toBe(false);
  const oauth = f.context('oauth');
  oauth.env.ANTIGRAVITY_ACP_AUTH_METHOD = 'oauth-personal';
  expect(() => antigravityAcpContract.prepare!(oauth)).toThrow('pre-authenticated');
  expect(oauth.env.GEMINI_API_KEY).toBeUndefined();
  expect(() => antigravityReply({ method: 'session/request_permission', id: 'x', params: {
    toolCall: { toolCallId: 'tool' }, options: [{ kind: 'allow_always', optionId: 'forever' }],
  } })).toThrow('no allow-once');
}, 10_000);
