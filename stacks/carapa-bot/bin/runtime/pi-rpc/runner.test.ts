import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunContext } from '../contracts';
import { isAlive } from '../processes';
import { stopRun } from '../stop';
import { runPiRpcHarness } from './runner';

const roots: string[] = [];
const runtimeBinDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string, turn: string): RunContext {
  const cwd = join(root, 'workspace');
  const runDir = join(root, 'ipc', 'runs', turn);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    cwd,
    prompt: turn,
    runTag: turn,
    binDir: runtimeBinDir,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${root}:${process.env.PATH}`,
      FAKE_PI_CAPTURE: join(root, 'capture.jsonl'),
      CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
      CARAPA_PERSIST_TURN_TIMEOUT: '2',
    },
    args: {
      agentCmd: 'pi',
      sessionId: '',
      forkSession: '',
      model: 'carapa-codex/gpt-test',
      fallbackModel: '',
      reasoningEffort: 'none',
      fallbackReasoningEffort: '',
      chatMode: '',
      agent: '',
      bare: '',
      systemPrompt: '',
      workDir: cwd,
      conversationKey: 'conversation-pi',
      persistent: '1',
      conversationId: 'conversation-pi',
      env: {},
    },
  };
}

describe('Pi managed RPC runner', () => {
  test('streams V1 during a fresh task turn and retires its RPC daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-task-'));
    roots.push(root);
    const fakePi = join(root, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const capture = process.env.FAKE_PI_CAPTURE;
appendFileSync(capture, JSON.stringify({ type: 'launch', pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-task-session', thinkingLevel: 'off' } });
  if (message.type === 'prompt') {
    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } });
    setTimeout(() => send({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'gpt-test', stopReason: 'stop' }], willRetry: false, session_id: 'pi-task-session' }), 150);
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fakePi, 0o755);

    const turn = context(root, 'task');
    turn.args.persistent = '';
    turn.args.conversationKey = '';
    turn.args.conversationId = '';
    turn.args.sessionId = 'prior-task-session';
    const running = runPiRpcHarness(turn);
    const v1Path = join(turn.runDir, 'output.v1.jsonl');
    for (
      let attempt = 0;
      attempt < 100 &&
      (!await Bun.file(v1Path).exists() ||
        !readFileSync(v1Path, 'utf8').includes('"type":"message_delta"'));
      attempt += 1
    ) {
      await Bun.sleep(10);
    }

    expect(readFileSync(v1Path, 'utf8')).toContain(
      '"type":"message_delta","id":"pi-message-1","role":"assistant","delta":"live"',
    );
    expect(await running).toBe(0);
    const daemonPid = Number(readFileSync(join(turn.runDir, 'pid'), 'utf8'));
    expect(isAlive(daemonPid)).toBe(false);
    const launch = JSON.parse(readFileSync(join(root, 'capture.jsonl'), 'utf8').trim());
    expect(launch.argv).toContain('rpc');
    expect(launch.argv.join(' ')).toContain('--mcp-project-servers allow');
    expect(launch.argv).toContain('prior-task-session');
    expect(launch.argv).toContain('--session-dir');
    expect(launch.argv).toContain(join(root, 'ipc', 'pi-sessions'));
    const v1 = readFileSync(v1Path, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(v1[0]).toEqual({ type: 'session', id: 'pi-task-session', status: 'resumed' });
    expect(v1.at(-1)).toEqual({ type: 'run', status: 'completed', stopReason: 'stop' });
  });

  test('treats only Pi error messages, not quoted session text, as provider failures', async () => {
    const quoted = 'grep: /raw-http-request=|provider connection closed unexpectedly/';
    const runWith = async (events: unknown[]) => {
      const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-failure-'));
      roots.push(root);
      const fakePi = join(root, 'pi');
      writeFileSync(fakePi, `#!/usr/bin/env bun
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-failure-session', thinkingLevel: 'off' } });
  if (message.type === 'prompt') {
    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    for (const event of ${JSON.stringify(events)}) send(event);
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
      chmodSync(fakePi, 0o755);
      const turn = context(root, 'failure');
      turn.args.persistent = '';
      turn.args.conversationKey = '';
      turn.args.conversationId = '';
      const exitCode = await runPiRpcHarness(turn);
      const v1 = readFileSync(join(turn.runDir, 'output.v1.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      return { exitCode, terminal: v1.at(-1) };
    };

    const succeeded = await runWith([
      { type: 'tool_execution_end', toolName: 'bash', result: { content: [{ type: 'text', text: quoted }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } },
      { type: 'agent_end', messages: [{ role: 'toolResult', content: [{ type: 'text', text: quoted }] }, { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }], willRetry: false },
    ]);
    expect(succeeded).toMatchObject({ exitCode: 0, terminal: { type: 'run', status: 'completed' } });

    const providerError = 'provider connection closed unexpectedly';
    const failed = await runWith([
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError } },
      { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError }], willRetry: false },
    ]);
    expect(failed).toMatchObject({ exitCode: 1, terminal: { type: 'run', status: 'failed', error: { message: providerError } } });

    // Text that is not a provider failure still reaches the V1 terminal instead of a generic message.
    const refusal = 'model refused the request';
    const refused = await runWith([
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: refusal } },
      { type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: refusal }], willRetry: false },
    ]);
    expect(refused.terminal).toMatchObject({ type: 'run', status: 'failed', error: { message: refusal } });
  });

  test('announces a new session only after Pi has saved it', async () => {
    // Run 3 of task-1792504461988-20bqvk failed before Pi saved its session; Board
    // stored the announced ID and every retry failed with "No session found".
    const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-unsaved-'));
    roots.push(root);
    const fakePi = join(root, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const file = process.env.FAKE_PI_SESSION_FILE;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-new-session', sessionFile: file, thinkingLevel: 'off' } });
  if (message.type !== 'prompt') return;
  if (process.env.FAKE_PI_FAIL) {
    send({ id: message.id, type: 'response', command: 'prompt', success: false, error: 'No API key found for ollama-proxy.' });
    return;
  }
  writeFileSync(file, '{}');
  send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
  send({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'gpt-test', stopReason: 'stop' }], willRetry: false });
});
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fakePi, 0o755);
    const turn = (name: string, fail: boolean) => {
      const run = context(root, name);
      run.args.persistent = '';
      run.args.conversationKey = '';
      run.args.conversationId = '';
      run.env.FAKE_PI_SESSION_FILE = join(root, `${name}-session.jsonl`);
      if (fail) run.env.FAKE_PI_FAIL = '1';
      return run;
    };
    const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const failed = turn('failed', true);
    expect(await runPiRpcHarness(failed)).toBe(1);
    expect(lines(join(failed.runDir, 'output.v1.jsonl')).filter((event) => event.type === 'session')).toEqual([]);

    const saved = turn('saved', false);
    expect(await runPiRpcHarness(saved)).toBe(0);
    expect(lines(join(saved.runDir, 'output.v1.jsonl'))).toContainEqual({ type: 'session', id: 'pi-new-session', status: 'started' });
  });

  test('reuses one Pi process across follow-up turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-'));
    roots.push(root);
    const fakePi = join(root, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
const capture = process.env.FAKE_PI_CAPTURE;
const args = process.argv.slice(2);
const history = args[args.indexOf('--session-dir') + 1];
const resume = args.includes('--session');
if (resume && !existsSync(join(history, 'pi-session.jsonl'))) process.exit(9);
mkdirSync(history, { recursive: true });
writeFileSync(join(history, 'pi-session.jsonl'), 'native history');
appendFileSync(capture, JSON.stringify({ type: 'launch', pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(capture, JSON.stringify({ type: 'request', pid: process.pid, message }) + '\\n');
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session', thinkingLevel: 'off' } });
  if (message.type === 'set_thinking_level') send({ id: message.id, type: 'response', command: message.type, success: true });
  if (message.type === 'prompt') {
    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'true' } });
    send({ type: 'tool_execution_update', toolCallId: 'tool-1', partialResult: { content: 'working' } });
    send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result: { content: '(no output)' }, isError: false });
    send({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'gpt-test', responseModel: 'provider/effective-test', stopReason: 'stop', usage: { input: 3, output: 1 } }], willRetry: false, session_id: 'pi-session' });
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fakePi, 0o755);

    const first = context(root, 'first');
    const second = context(root, 'second');
    const firstResult = await runPiRpcHarness(first);
    if (firstResult !== 0) {
      const sessionDir = readFileSync(join(first.runDir, 'session_dir'), 'utf8');
      throw new Error(
        readFileSync(join(first.runDir, 'agent-stderr.log'), 'utf8') +
        readFileSync(join(sessionDir, 'pi-rpc.stderr.log'), 'utf8'),
      );
    }
    expect(await runPiRpcHarness(second)).toBe(0);

    const firstPid = readFileSync(join(first.runDir, 'pid'), 'utf8');
    const secondPid = readFileSync(join(second.runDir, 'pid'), 'utf8');
    expect(secondPid).toBe(firstPid);
    const capture = readFileSync(join(root, 'capture.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(capture.filter((event) => event.type === 'launch')).toHaveLength(1);
    expect(capture.filter((event) => event.message?.type === 'prompt')).toHaveLength(2);

    expect(JSON.parse(readFileSync(join(first.runDir, 'output.v1.meta.json'), 'utf8'))).toEqual({
      format: 'carapa-run',
      version: 1,
      harness: 'pi',
      requestedModel: 'carapa-codex/gpt-test',
    });
    const firstV1 = readFileSync(join(first.runDir, 'output.v1.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(firstV1[0]).toEqual({ type: 'session', id: 'pi-session', status: 'started' });
    expect(firstV1).toContainEqual({
      type: 'message_delta',
      id: 'pi-message-1',
      role: 'assistant',
      delta: 'ok',
    });
    expect(firstV1).toContainEqual({
      type: 'run',
      status: 'in_progress',
      model: 'provider/effective-test',
    });
    expect(firstV1).toContainEqual({
      type: 'message',
      id: 'pi-message-1',
      role: 'assistant',
      content: 'ok',
      format: 'markdown',
      status: 'completed',
    });
    expect(firstV1).toContainEqual({
      type: 'tool_call',
      id: 'tool-1',
      status: 'completed',
      name: 'bash',
    });
    expect(firstV1).not.toContainEqual(
      expect.objectContaining({ output: '(no output)' }),
    );
    expect(firstV1).toContainEqual({
      type: 'usage',
      scope: 'incremental',
      inputTokens: 3,
      outputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(firstV1.at(-1)).toEqual({ type: 'run', status: 'completed', stopReason: 'stop' });
    await stopRun(second.runDir);
    const runtime = readFileSync(join(second.runDir, 'session_dir'), 'utf8');
    rmSync(runtime, { recursive: true });
    const third = context(root, 'third');
    third.args.sessionId = 'pi-session';
    expect(await runPiRpcHarness(third)).toBe(0);
    expect(readFileSync(join(third.runDir, 'output.v1.jsonl'), 'utf8')).toContain('"status":"resumed"');
    await stopRun(third.runDir);

    const secondV1 = readFileSync(join(second.runDir, 'output.v1.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(secondV1[0]).toEqual({ type: 'session', id: 'pi-session', status: 'resumed' });

    const rawPi = readFileSync(join(first.runDir, 'pi.raw.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rawPi.some((event) => event.type === 'response' && event.command === 'get_state')).toBe(true);
    expect(rawPi.some((event) => event.type === 'agent_end')).toBe(true);
    expect(rawPi.some((event) => event.type === 'thread.started')).toBe(false);

    await stopRun(second.runDir, secondPid);
  });

  test('delivers steering to the active Pi turn and reports correlated acceptance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-steer-'));
    roots.push(root);
    const fakePi = join(root, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const capture = process.env.FAKE_PI_CAPTURE;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(capture, JSON.stringify({ type: 'request', message }) + '\\n');
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session', thinkingLevel: 'off' } });
  if (message.type === 'prompt') {
    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } });
  }
  if (message.type === 'steer') {
    send({ id: message.id, type: 'response', command: 'steer', success: true });
    send({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'steered' }], model: 'gpt-test', stopReason: 'stop' }], willRetry: false, session_id: 'pi-session' });
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fakePi, 0o755);

    const turn = context(root, 'steering');
    const running = runPiRpcHarness(turn);
    const controlPath = join(turn.runDir, 'agent-control.json');
    for (let attempt = 0; attempt < 100 && !await Bun.file(controlPath).exists(); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(await Bun.file(controlPath).exists()).toBe(true);

    const requestPath = join(turn.runDir, 'control-requests', 'steer-1.json');
    const responsePath = join(turn.runDir, 'control-responses', 'steer-1.json');
    writeFileSync(requestPath, JSON.stringify({ action: 'steer', text: 'change direction' }));
    for (let attempt = 0; attempt < 100 && !await Bun.file(responsePath).exists(); attempt += 1) {
      await Bun.sleep(10);
    }

    expect(JSON.parse(readFileSync(responsePath, 'utf8'))).toEqual({ ok: true, result: {} });
    expect(await running).toBe(0);
    const capture = readFileSync(join(root, 'capture.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(capture.find((event) => event.message?.type === 'steer')?.message).toEqual({
      id: 'control-steer-1',
      type: 'steer',
      message: 'change direction',
    });

    await stopRun(turn.runDir, readFileSync(join(turn.runDir, 'pid'), 'utf8'));
  });

  test('completes an interrupt that aborts post-run compaction without another agent_end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-pi-rpc-compaction-interrupt-'));
    roots.push(root);
    const fakePi = join(root, 'pi');
    writeFileSync(fakePi, `#!/usr/bin/env bun
import readline from 'node:readline';
let compacting = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'get_state') send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session', thinkingLevel: 'off', isStreaming: false, isCompacting: compacting, pendingMessageCount: 0 } });
  if (message.type === 'prompt') {
    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });
    send({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'gpt-test', stopReason: 'stop' }], willRetry: false, session_id: 'pi-session' });
    compacting = true;
    send({ type: 'compaction_start', reason: 'threshold' });
  }
  if (message.type === 'abort') {
    send({ id: message.id, type: 'response', command: 'abort', success: true });
    compacting = false;
    send({ type: 'compaction_end', reason: 'threshold', aborted: true, willRetry: false });
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
    chmodSync(fakePi, 0o755);

    const turn = context(root, 'compaction-interrupt');
    turn.env.CARAPA_PERSIST_TURN_TIMEOUT = '30';
    const running = runPiRpcHarness(turn);
    const v1Path = join(turn.runDir, 'output.v1.jsonl');
    const rawPath = join(turn.runDir, 'pi.raw.jsonl');
    for (
      let attempt = 0;
      attempt < 200 &&
      (!await Bun.file(rawPath).exists() || !readFileSync(rawPath, 'utf8').includes('compaction_start'));
      attempt += 1
    ) {
      await Bun.sleep(10);
    }
    mkdirSync(join(turn.runDir, 'control-requests'), { recursive: true });
    writeFileSync(join(turn.runDir, 'control-requests', 'interrupt-1.json'), JSON.stringify({ action: 'interrupt' }));

    const started = Date.now();
    expect(await running).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    const v1 = readFileSync(v1Path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(v1.at(-1)).toMatchObject({ type: 'run', status: 'interrupted' });

    await stopRun(turn.runDir, readFileSync(join(turn.runDir, 'pid'), 'utf8'));
  });
});
