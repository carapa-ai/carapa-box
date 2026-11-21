import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopRun } from '../stop';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'carapa-codex-app-server-'));
  roots.push(root);
  const runDir = join(root, 'ipc', 'runs', 'first');
  const workDir = join(root, 'work');
  const groupDir = join(root, 'group');
  const capturePath = join(root, 'capture.jsonl');
  const fakeCodex = join(root, 'fake-codex');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(workDir);
  mkdirSync(groupDir);
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const capture = process.env.FAKE_CODEX_CAPTURE;
let awaitingAnswer = false;
appendFileSync(capture, JSON.stringify({ type: 'launch', argv: process.argv.slice(2), tag: process.env.CARAPA_AGENT_RUN_ID }) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const sendSubagentEvents = () => {
  const scope = { threadId: 'thread-child', turnId: 'turn-child' };
  send({ method: 'turn/started', params: { ...scope, turn: { id: scope.turnId } } });
  send({ method: 'error', params: { ...scope, message: 'child at capacity' } });
  send({ method: 'item/agentMessage/delta', params: { ...scope, itemId: 'child-message', delta: 'child review' } });
  send({ method: 'item/completed', params: { ...scope, item: { id: 'child-message', type: 'agentMessage', text: 'child review' } } });
  send({ method: 'item/started', params: { ...scope, item: { id: 'child-command', type: 'commandExecution', command: 'child-command' } } });
  send({ method: 'turn/plan/updated', params: { ...scope, plan: [{ step: 'child plan', status: 'completed' }] } });
  send({ method: 'thread/tokenUsage/updated', params: { ...scope, tokenUsage: { last: { inputTokens: 999, outputTokens: 99 } } } });
  send({ id: 901, method: 'item/tool/requestUserInput', params: { ...scope, questions: [{ id: 'child-question', question: 'Child question?' }] } });
  send({ method: 'turn/completed', params: { ...scope, turn: { id: scope.turnId, status: 'completed' } } });
  send({ method: 'turn/completed', params: { ...scope, turn: { id: 'another-child-turn', status: 'failed' } } });
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(capture, JSON.stringify({ type: 'request', message }) + '\\n');
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    if (process.env.FAKE_CODEX_RESUME_USAGE === '1') {
      send({ method: 'thread/tokenUsage/updated', params: { turnId: 'previous-turn', tokenUsage: { last: { inputTokens: 999, outputTokens: 99 } } } });
    }
  }
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-test' } } });
    if (process.env.FAKE_CODEX_SUBAGENTS === '1') {
      sendSubagentEvents();
      send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'previous-turn' } } });
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'previous-turn', status: 'failed' } } });
      send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'previous-turn', item: { id: 'stale-message', type: 'agentMessage', text: 'stale reply' } } });
    }
    send({ method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'hello' } });
    send({ method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: 'hello', phase: 'commentary' } } });
    if (process.env.FAKE_CODEX_SIMPLE === '1') {
      send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
      return;
    }
    send({ method: 'item/started', params: { item: { id: 'command-1', type: 'commandExecution', command: 'printf ok', cwd: process.cwd(), status: 'inProgress' } } });
    send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command-1', delta: 'ok' } });
    send({ method: 'item/completed', params: { item: { id: 'command-1', type: 'commandExecution', command: 'printf ok', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } } });
    send({ id: 900, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'Continue?' }] } });
    awaitingAnswer = true;
  }
  if (message.method === 'turn/steer') send({ id: message.id, result: { accepted: true } });
  if (awaitingAnswer && message.id === 900 && message.result?.answers) {
    awaitingAnswer = false;
    send({ method: 'serverRequest/resolved', params: { requestId: 900 } });
    send({ method: 'turn/plan/updated', params: { turnId: 'turn-test', plan: [{ step: 'Do the work', status: 'completed' }] } });
    send({ method: 'item/plan/delta', params: { itemId: 'p1', delta: '# Ship it\\n\\n' } });
    send({ method: 'item/plan/delta', params: { itemId: 'p1', delta: 'Do the work.' } });
    send({ method: 'item/completed', params: { item: { id: 'p1', type: 'plan', text: '# Ship it\\n\\nDo the work.' } } });
    send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 7, outputTokens: 3 } } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } });
    if (process.env.FAKE_CODEX_SUBAGENTS === '1') sendSubagentEvents();
  }
});
process.on('SIGTERM', () => process.exit(0));
`,
  );
  chmodSync(fakeCodex, 0o755);
  writeFileSync(
    join(runDir, 'args.json'),
    JSON.stringify({
      agentCmd: 'codex',
      codexControlContract: 1,
      workDir,
      groupDir,
      model: 'gpt-test',
      reasoningEffort: 'high',
      chatMode: 'plan',
      env: { FAKE_CODEX_CAPTURE: capturePath },
    }),
  );
  writeFileSync(join(runDir, 'prompt.txt'), 'implement this');
  return { root, runDir, workDir, groupDir, capturePath, fakeCodex };
}

describe('typed Codex app-server runner', () => {
  function recoveryFixture(mode: string, persistent = false, env: Record<string, string> = {}) {
    const value = createFixture();
    writeFileSync(value.fakeCodex, `#!/usr/bin/env bun\nimport ${JSON.stringify(join(import.meta.dir, 'fixtures/tool-call-peer.ts'))};\n`);
    const argsPath = join(value.runDir, 'args.json');
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    args.env.FAKE_CODEX_RECOVERY_MODE = mode;
    args.env.FAKE_CODEX_RUN_DIR = value.runDir;
    Object.assign(args.env, env);
    if (persistent) {
      args.persistent = '1';
      args.conversationKey = 'recovery-conversation';
    }
    if (mode === 'fallback') {
      args.fallbackModel = 'fallback-model';
      args.fallbackReasoningEffort = 'low';
    }
    writeFileSync(argsPath, JSON.stringify(args));
    const launch = (runDir = value.runDir) => Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), runDir], {
      cwd: value.workDir,
      env: { ...process.env, CARAPA_CODEX_BIN: value.fakeCodex },
      stdout: 'ignore', stderr: 'pipe',
    });
    const readJsonl = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    return { ...value, args, launch, readJsonl };
  }

  test.each([
    [false, ''],
    [true, 'after'],
    [true, 'before'],
  ])('corrects tool-call text in the same session without replaying earlier work (persistent=%s, late completion %s the response)', async (persistent, lateOrder) => {
    // A warm follow-up starts a fresh runner that has not retired any turn yet. The
    // peer puts the previous turn's late completion in the same read as the turn/start
    // response (ahead of it or behind it), then holds back the new turn so the runner
    // cannot wait it out.
    const value = recoveryFixture('recover', persistent, persistent ? { FAKE_CODEX_LATE_GAP_MS: '60', FAKE_CODEX_LATE_ORDER: lateOrder } : {});
    const processHandle = value.launch();
    let lastRunDir = value.runDir;
    try {
      expect(await processHandle.exited).toBe(0);
      const capture = value.readJsonl(value.capturePath);
      const turns = capture.filter((entry) => entry.message?.method === 'turn/start');
      expect(turns).toHaveLength(2);
      expect(turns.map((entry) => entry.message.params.threadId)).toEqual(['thread-recovery', 'thread-recovery']);
      expect(turns[0].message.params.input[0].text).toBe('implement this');
      expect(turns[1].message.params.input[0].text).toStartWith('Tool protocol correction:');
      expect(turns[1].message.params.input[0].text).toContain('do not repeat actions that already ran');
      expect(turns[1].message.params.model).toBe('gpt-test');
      expect(capture.find((entry) => entry.type === 'control-during-recovery').state).not.toBe('completed');
      const events = value.readJsonl(join(value.runDir, 'output.v1.jsonl'));
      expect(events.filter((event) => event.type === 'tool_call' && event.name === 'bash' && event.status === 'completed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool_call' && event.name?.includes('publish_app') && event.status === 'completed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'run' && ['completed', 'interrupted', 'failed'].includes(event.status))).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
      expect(events.some((event) => event.id === 'stale' || event.id === 'child')).toBe(false);
      for (const name of ['output.jsonl', 'output.v1.jsonl']) {
        const output = readFileSync(join(value.runDir, name), 'utf8');
        expect(output).toContain('correct the call automatically');
        expect(output).toContain('App published.');
      }
      if (persistent) {
        lastRunDir = join(value.root, 'ipc', 'runs', 'warm');
        mkdirSync(lastRunDir);
        writeFileSync(join(lastRunDir, 'args.json'), JSON.stringify(value.args));
        writeFileSync(join(lastRunDir, 'prompt.txt'), 'follow up');
        expect(await value.launch(lastRunDir).exited).toBe(0);
        expect(value.readJsonl(value.capturePath).filter((entry) => entry.type === 'launch')).toHaveLength(1);
        const warmTurns = value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start');
        expect(warmTurns).toHaveLength(4);
        expect(warmTurns.map((entry) => entry.message.params.threadId)).toEqual(Array(4).fill('thread-recovery'));
        expect(warmTurns[2].message.params.input[0].text).toBe('follow up');
        expect(warmTurns[3].message.params.input[0].text).toStartWith('Tool protocol correction:');
        expect(value.readJsonl(join(lastRunDir, 'output.v1.jsonl')).at(-1)).toMatchObject({ type: 'run', status: 'completed' });
      }
    } finally {
      if (existsSync(join(lastRunDir, 'pid'))) await stopRun(lastRunDir, readFileSync(join(lastRunDir, 'pid'), 'utf8'));
    }
  });

  test('fails clearly after one unsuccessful correction', async () => {
    const value = recoveryFixture('always');
    expect(await value.launch().exited).toBe(1);
    const events = value.readJsonl(join(value.runDir, 'output.v1.jsonl'));
    expect(events.at(-1)).toMatchObject({ type: 'run', status: 'failed', error: { message: expect.stringContaining('after one automatic correction') } });
    expect(events.some((event) => event.type === 'run' && event.status === 'completed')).toBe(false);
    expect(value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(2);
  });

  test.each(['quoted', 'interrupted', 'failed-without-text', 'interrupt-between'])('does not retry %s output', async (mode) => {
    const value = recoveryFixture(mode);
    const exitCode = await value.launch().exited;
    expect(exitCode).toBe(mode === 'quoted' ? 0 : 1);
    expect(value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(1);
    if (mode === 'interrupt-between') {
      expect(value.readJsonl(join(value.runDir, 'output.v1.jsonl')).at(-1)).toMatchObject({ type: 'run', status: 'interrupted' });
      expect(JSON.parse(readFileSync(join(value.runDir, 'control-responses', 'interrupt.json'), 'utf8')).ok).toBe(true);
    }
  });

  test.each(['actual', 'completed-after-check', 'failed-after-check', 'failed'])('corrects pending markup after %s without replaying the request', async (mode) => {
    const value = recoveryFixture(mode, true);
    try {
      expect(await value.launch().exited).toBe(0);
      const turns = value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start');
      expect(turns).toHaveLength(2);
      expect(turns.map((entry) => entry.message.params.threadId)).toEqual(['thread-recovery', 'thread-recovery']);
      expect(turns[1].message.params.input[0].text).toStartWith('Tool protocol correction:');
      expect(turns[1].message.params.input[0].text).toContain('do not repeat actions that already ran');
      expect(turns[1].message.params.model).toBe(turns[0].message.params.model);
      expect(turns[1].message.params.effort).toBe(turns[0].message.params.effort);
      const events = value.readJsonl(join(value.runDir, 'output.v1.jsonl'));
      expect(events.filter((event) => event.type === 'run' && ['completed', 'failed', 'interrupted'].includes(event.status))).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      expect(events.filter((event) => event.type === 'tool_call' && event.name?.includes('publish_app') && event.status === 'completed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool_call' && event.name === 'bash' && event.status === 'completed')).toHaveLength(1);
      if (mode.endsWith('after-check')) {
        expect(events.filter((event) => event.type === 'tool_call' && event.status === 'failed')).toHaveLength(1);
      }
    } finally {
      if (existsSync(join(value.runDir, 'pid'))) await stopRun(value.runDir, readFileSync(join(value.runDir, 'pid'), 'utf8'));
    }
  });

  test.each(['failed-correction', 'failed-repeat'])('bounds correction when the provider returns %s', async (mode) => {
    const value = recoveryFixture(mode);
    expect(await value.launch().exited).toBe(1);
    const turns = value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start');
    expect(turns).toHaveLength(2);
    const events = value.readJsonl(join(value.runDir, 'output.v1.jsonl'));
    expect(events.filter((event) => event.type === 'run' && ['completed', 'failed', 'interrupted'].includes(event.status))).toEqual([
      expect.objectContaining({ status: 'failed', error: { message: expect.stringContaining(mode === 'failed-repeat' ? 'after one automatic correction' : 'invalid_assistant_history') } }),
    ]);
  });

  test.each(['snapshot', 'fallback'])('recovers %s responses', async (mode) => {
    const value = recoveryFixture(mode);
    expect(await value.launch().exited).toBe(0);
    const turns = value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start');
    expect(turns).toHaveLength(mode === 'fallback' ? 3 : 2);
    expect(turns.at(-1).message.params.input[0].text).toStartWith('Tool protocol correction:');
    if (mode === 'fallback') {
      expect(turns.at(-1).message.params.model).toBe('fallback-model');
      expect(turns.at(-1).message.params.effort).toBe('low');
    }
  });

  test('honors interruption during the correction', async () => {
    const value = recoveryFixture('interrupt-recovery');
    const processHandle = value.launch();
    try {
      await waitFor(() => existsSync(value.capturePath) && value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start').length === 2, 'automatic correction');
      writeFileSync(join(value.runDir, 'control-requests', 'interrupt.json'), JSON.stringify({ action: 'interrupt' }));
      expect(await processHandle.exited).toBe(1);
      expect(value.readJsonl(join(value.runDir, 'output.v1.jsonl')).at(-1)).toMatchObject({ type: 'run', status: 'interrupted' });
      expect(value.readJsonl(value.capturePath).filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(2);
      expect(value.readJsonl(value.capturePath).find((entry) => entry.message?.method === 'turn/interrupt').message.params.turnId).toBe('turn-2');
    } finally {
      if (existsSync(join(value.runDir, 'pid'))) await stopRun(value.runDir, readFileSync(join(value.runDir, 'pid'), 'utf8'));
    }
  });

  test.each([false, true])('keeps subagent completion separate from the parent (persistent=%s)', async (persistent) => {
    const value = createFixture();
    const argsPath = join(value.runDir, 'args.json');
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    args.env.FAKE_CODEX_SUBAGENTS = '1';
    args.fallbackModel = 'fallback-model';
    if (persistent) {
      args.persistent = '1';
      args.conversationKey = 'subagent-conversation';
    }
    writeFileSync(argsPath, JSON.stringify(args));
    const environment = {
      ...process.env,
      CARAPA_CODEX_BIN: value.fakeCodex,
      CARAPA_AGENT_RUN_ID: 'typed-codex-subagents_',
    };
    let currentRunDir = value.runDir;
    try {
      // Exercise the same interleaving on a reused daemon as well as a fresh one.
      for (let index = 0; index < (persistent ? 2 : 1); index++) {
        if (index) {
          currentRunDir = join(value.root, 'ipc', 'runs', 'second');
          mkdirSync(currentRunDir);
          writeFileSync(join(currentRunDir, 'args.json'), JSON.stringify(args));
          writeFileSync(join(currentRunDir, 'prompt.txt'), 'follow up');
        }
        const processHandle = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), currentRunDir], {
          cwd: value.workDir, env: environment, stdout: 'ignore', stderr: 'inherit',
        });
        const v1Path = join(currentRunDir, 'output.v1.jsonl');
        await waitFor(() => existsSync(v1Path) && readFileSync(v1Path, 'utf8').includes('"type":"interaction"'), 'parent input request');
        expect(JSON.parse(readFileSync(join(currentRunDir, 'codex-control.json'), 'utf8'))).toMatchObject({
          state: 'running', threadId: 'thread-test', turnId: 'turn-test',
        });
        // Control polling supplies a handshake after child completion has been consumed.
        writeFileSync(join(currentRunDir, 'control-requests', 'steer.json'), JSON.stringify({ action: 'steer', text: 'finish implementation' }));
        await waitFor(() => existsSync(join(currentRunDir, 'control-responses', 'steer.json')), 'parent steer response');
        expect(JSON.parse(readFileSync(join(currentRunDir, 'control-responses', 'steer.json'), 'utf8')).ok).toBe(true);
        expect(processHandle.exitCode).toBeNull();
        writeFileSync(join(currentRunDir, 'control-requests', 'answer.json'), JSON.stringify({
          action: 'answerUserInput', requestId: '900', answers: { q1: { answers: ['Yes'] } },
        }));
        expect(await processHandle.exited).toBe(0);
        const canonical = readFileSync(v1Path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(canonical.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
        expect(canonical.filter((event) => event.type === 'usage')).toHaveLength(1);
        expect(canonical.find((event) => event.type === 'usage')).toMatchObject({ inputTokens: 7, outputTokens: 3 });
        for (const name of ['output.jsonl', 'output.v1.jsonl']) {
          const output = readFileSync(join(currentRunDir, name), 'utf8');
          expect(output).not.toContain('child');
          expect(output).not.toContain('stale reply');
          expect(output).toContain('hello');
        }
        expect(readFileSync(join(currentRunDir, 'codex.raw.jsonl'), 'utf8')).toContain('child review');
      }
      const capture = readFileSync(value.capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(capture.filter((entry) => entry.type === 'launch')).toHaveLength(1);
      expect(capture.filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(persistent ? 2 : 1);
      expect(capture.filter((entry) => entry.message?.method === 'turn/steer').every((entry) =>
        entry.message.params.threadId === 'thread-test' && entry.message.params.expectedTurnId === 'turn-test',
      )).toBe(true);
    } finally {
      if (existsSync(join(currentRunDir, 'pid'))) {
        await stopRun(currentRunDir, readFileSync(join(currentRunDir, 'pid'), 'utf8').trim());
      }
    }
  });

  test('preserves protocol and waits for Plan input before completing the turn', async () => {
    const value = createFixture();
    const processHandle = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), value.runDir], {
      cwd: value.workDir,
      env: {
        ...process.env,
        CARAPA_CODEX_BIN: value.fakeCodex,
        CARAPA_AGENT_RUN_ID: 'typed-codex-run_',
        ENABLE_CODEX_PLAN_MODE: '1',
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });

    const controlPath = join(value.runDir, 'codex-control.json');
    try {
      await waitFor(() => {
        if (!existsSync(controlPath)) return false;
        return JSON.parse(readFileSync(controlPath, 'utf8')).state === 'running';
      }, 'running control state');
    } catch (error) {
      const diagnostic = (name: string): string => {
        const path = join(value.runDir, name);
        return existsSync(path) ? readFileSync(path, 'utf8') : '(missing)';
      };
      throw new Error(
        `${error instanceof Error ? error.message : error}; exit=${processHandle.exitCode}; ` +
        `control=${diagnostic('codex-control.json')}; stderr=${diagnostic('codex-stderr.log')}; ` +
        `output=${diagnostic('output.jsonl')}; capture=${
          existsSync(value.capturePath) ? readFileSync(value.capturePath, 'utf8') : '(missing)'
        }`,
      );
    }
    const requestPath = join(value.runDir, 'control-requests', 'steer.json');
    writeFileSync(
      requestPath,
      JSON.stringify({ action: 'steer', id: 'steer-1', text: 'also add tests' }),
    );
    const responsePath = join(value.runDir, 'control-responses', 'steer.json');
    await waitFor(() => existsSync(responsePath), 'steer response');
    expect(JSON.parse(readFileSync(responsePath, 'utf8'))).toEqual({
      ok: true,
      result: { accepted: true },
    });

    const outputPath = join(value.runDir, 'output.jsonl');
    await waitFor(
      () => readFileSync(outputPath, 'utf8').includes('askuserquestion'),
      'Codex user-input request',
    );
    const v1Path = join(value.runDir, 'output.v1.jsonl');
    await waitFor(
      () =>
        existsSync(v1Path) &&
        readFileSync(v1Path, 'utf8').includes('"type":"interaction"'),
      'canonical Codex user-input request',
    );
    expect(processHandle.exitCode).toBeNull();
    const answerPath = join(value.runDir, 'control-requests', 'answer.json');
    writeFileSync(
      answerPath,
      JSON.stringify({
        action: 'answerUserInput',
        requestId: '900',
        answers: { q1: { answers: ['Yes'] } },
      }),
    );
    const answerResponsePath = join(value.runDir, 'control-responses', 'answer.json');
    await waitFor(() => existsSync(answerResponsePath), 'user-input answer response');
    expect(JSON.parse(readFileSync(answerResponsePath, 'utf8'))).toEqual({
      ok: true,
      result: {},
    });

    expect(await processHandle.exited).toBe(0);
    const output = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(output).toContainEqual({ type: 'thread.started', thread_id: 'thread-test' });
    expect(output).toContainEqual({
      type: 'item.updated',
      item: { id: 'a1', type: 'agent_message', delta: 'hello' },
    });
    expect(output.some((event) => event.item?.text?.includes('askuserquestion'))).toBe(true);
    expect(output.some((event) => event.item?.text?.includes('carapaplan'))).toBe(true);
    expect(output).toContainEqual({
      type: 'turn.usage',
      usage: {
        input_tokens: 7,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 3,
        reasoning_output_tokens: 0,
      },
    });
    expect(JSON.parse(readFileSync(controlPath, 'utf8')).state).toBe('completed');
    const promptDispatchedAtMs = Number(
      readFileSync(join(value.runDir, 'prompt_dispatched_at_ms'), 'utf8'),
    );
    const firstOutputAtMs = Number(readFileSync(join(value.runDir, 'first_output_at_ms'), 'utf8'));
    expect(promptDispatchedAtMs).toBeGreaterThan(0);
    expect(firstOutputAtMs).toBeGreaterThanOrEqual(promptDispatchedAtMs);

    const rawCodex = readFileSync(join(value.runDir, 'codex.raw.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      rawCodex.some(
        (message) =>
          message.method === 'item/tool/requestUserInput' &&
          message.params?.questions?.[0]?.id === 'q1',
      ),
    ).toBe(true);
    expect(
      rawCodex.some(
        (message) =>
          message.method === 'thread/tokenUsage/updated' &&
          message.params?.tokenUsage?.last?.inputTokens === 7,
      ),
    ).toBe(true);

    expect(
      JSON.parse(readFileSync(join(value.runDir, 'output.v1.meta.json'), 'utf8')),
    ).toEqual({
      format: 'carapa-run',
      version: 1,
      harness: 'codex',
      requestedModel: 'gpt-test',
    });
    const canonical = readFileSync(v1Path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(canonical[0]).toEqual({
      type: 'session',
      id: 'thread-test',
      status: 'started',
    });
    expect(canonical).toContainEqual({
      type: 'message',
      id: 'a1',
      role: 'assistant',
      content: 'hello',
      format: 'markdown',
      status: 'completed',
    });
    expect(canonical.filter((event) => event.type === 'message_delta' && event.id === 'p1')
      .map((event) => event.delta).join('')).toBe('# Ship it\n\nDo the work.');
    const completedPlans = canonical.filter((event) => event.type === 'message' && event.id === 'p1');
    expect(completedPlans).toHaveLength(1);
    expect(completedPlans[0]).toMatchObject({
      role: 'assistant',
      status: 'completed',
      content: output.find((event) => event.item?.id === 'p1')?.item.text,
    });
    expect(completedPlans[0].content).toContain('carapaplan');
    const planCard = JSON.parse(completedPlans[0].content.match(/```carapaplan\n([^\n]+)/)[1]);
    expect(readFileSync(join(value.groupDir, planCard.artifactPath), 'utf8'))
      .toBe('# Ship it\n\nDo the work.\n');
    expect(readdirSync(join(value.groupDir, 'artifacts', 'plans')).filter((name) => name.endsWith('.md')))
      .toHaveLength(1);
    expect(canonical).toContainEqual({
      type: 'tool_call',
      id: 'command-1',
      status: 'completed',
      name: 'bash',
      output: 'ok',
      exitCode: 0,
    });
    expect(canonical).toContainEqual({
      type: 'interaction',
      id: '900',
      status: 'answered',
    });
    expect(canonical).toContainEqual({
      type: 'plan',
      id: 'turn-test-plan',
      entries: [{
        id: 'turn-test-plan-1',
        content: 'Do the work',
        status: 'completed',
      }],
    });
    expect(canonical).toContainEqual({
      type: 'usage',
      scope: 'incremental',
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(canonical.at(-1)).toEqual({
      type: 'run',
      status: 'completed',
      stopReason: 'completed',
    });

    const plansDir = join(value.groupDir, 'artifacts', 'plans');
    const planName = readdirSync(plansDir).find((name) => name.endsWith('.md'));
    expect(planName).toBeTruthy();
    expect(readFileSync(join(plansDir, planName as string), 'utf8')).toBe(
      '# Ship it\n\nDo the work.\n',
    );

    const capture = readFileSync(value.capturePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const launch = capture.find((entry) => entry.type === 'launch');
    expect(launch.tag).toBe('typed-codex-run_');
    expect(launch.argv[0]).toBe('app-server');
    expect(launch.argv.join(' ')).toContain('shell_environment_policy.set.CARAPA_AGENT_RUN_ID');
    expect(
      capture.some(
        (entry) =>
          entry.message?.method === 'turn/steer' &&
          entry.message.params?.expectedTurnId === 'turn-test',
      ),
    ).toBe(true);
    expect(
      capture.some(
        (entry) =>
          entry.message?.id === 900 && entry.message.result?.answers?.q1?.answers?.[0] === 'Yes',
      ),
    ).toBe(true);
  });

  test('resumes an existing thread instead of silently starting a replacement', async () => {
    const value = createFixture();
    const argsPath = join(value.runDir, 'args.json');
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    args.sessionId = 'thread-existing';
    args.env.FAKE_CODEX_SIMPLE = '1';
    args.env.FAKE_CODEX_RESUME_USAGE = '1';
    args.env.CODEX_PROFILE = 'freellmapi';
    writeFileSync(argsPath, JSON.stringify(args));
    const profileHome = join(value.root, 'profile-home');
    mkdirSync(join(profileHome, '.codex'), { recursive: true });
    writeFileSync(
      join(profileHome, '.codex', 'freellmapi.config.toml'),
      'model_provider = "freellmapi"\nmodel_context_window = 256000\n',
    );
    const processHandle = Bun.spawn(['bun', join(import.meta.dir, 'main.ts'), value.runDir], {
      cwd: value.workDir,
      env: {
        ...process.env,
        HOME: profileHome,
        CARAPA_CODEX_BIN: value.fakeCodex,
        CARAPA_AGENT_RUN_ID: 'typed-codex-resume_',
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });

    expect(await processHandle.exited).toBe(0);
    const output = readFileSync(join(value.runDir, 'output.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(output).toContainEqual({ type: 'thread.started', thread_id: 'thread-existing' });
    const capture = readFileSync(value.capturePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const launchArgs = capture.find((entry) => entry.type === 'launch')?.argv;
    expect(launchArgs[0]).toBe('app-server');
    expect(launchArgs).toContain('model_provider="freellmapi"');
    expect(launchArgs).toContain('model_context_window=256000');
    expect(
      capture.some(
        (entry) =>
          entry.message?.method === 'thread/resume' &&
          entry.message.params?.modelProvider === 'freellmapi',
      ),
    ).toBe(true);
    expect(capture.some((entry) => entry.message?.method === 'thread/start')).toBe(false);
    expect(existsSync(join(value.runDir, 'persistent_resume_failed'))).toBe(false);
    const canonical = readFileSync(join(value.runDir, 'output.v1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(canonical[0]).toEqual({
      type: 'session',
      id: 'thread-existing',
      status: 'resumed',
    });
    expect(canonical.some((event) => event.type === 'usage')).toBe(false);
    const compatibilityOutput = readFileSync(join(value.runDir, 'output.jsonl'), 'utf8');
    expect(compatibilityOutput).not.toContain('"type":"turn.usage"');
  });

  test('keeps one app-server daemon alive across warm turns', async () => {
    const value = createFixture();
    const firstArgsPath = join(value.runDir, 'args.json');
    const args = JSON.parse(readFileSync(firstArgsPath, 'utf8'));
    args.persistent = '1';
    args.conversationKey = 'codex-conversation';
    args.env.FAKE_CODEX_SIMPLE = '1';
    writeFileSync(firstArgsPath, JSON.stringify(args));
    const environment = {
      ...process.env,
      CARAPA_CODEX_BIN: value.fakeCodex,
      CARAPA_AGENT_RUN_ID: 'ignored-for-warm-daemon_',
    };
    const runTurn = (runDir: string) => Bun.spawn(
      ['bun', join(import.meta.dir, 'main.ts'), runDir],
      { cwd: value.workDir, env: environment, stdout: 'ignore', stderr: 'inherit' },
    );

    const first = runTurn(value.runDir);
    expect(await first.exited).toBe(0);
    const secondRunDir = join(value.root, 'ipc', 'runs', 'second');
    mkdirSync(secondRunDir, { recursive: true });
    writeFileSync(join(secondRunDir, 'args.json'), JSON.stringify(args));
    writeFileSync(join(secondRunDir, 'prompt.txt'), 'follow up');
    const second = runTurn(secondRunDir);
    expect(await second.exited).toBe(0);

    const firstPid = readFileSync(join(value.runDir, 'pid'), 'utf8');
    const secondPid = readFileSync(join(secondRunDir, 'pid'), 'utf8');
    try {
      expect(secondPid).toBe(firstPid);
      const capture = readFileSync(value.capturePath, 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(capture.filter((entry) => entry.type === 'launch')).toHaveLength(1);
      expect(capture.filter((entry) => entry.message?.method === 'initialize')).toHaveLength(1);
      expect(capture.filter((entry) => entry.message?.method === 'turn/start')).toHaveLength(2);
    } finally {
      await stopRun(secondRunDir, secondPid);
    }
  });
});
