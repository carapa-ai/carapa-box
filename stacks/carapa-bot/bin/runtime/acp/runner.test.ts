import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunContext } from '../contracts';
import { isAlive } from '../processes';
import { stopRun } from '../stop';
import { StandardAcpRunV1Adapter } from '../standard-acp-v1';
import type { AcpHarnessContract } from './contracts';
import { primeAgentAcpContract } from '../harnesses/prime-agent-acp';
import { isProviderFailureText, runAcpHarness, translateAcpMessage, type TranslationState } from './runner';

const roots: string[] = [];
const runtimeBinDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function managedContext(root: string, agentCmd: string): RunContext {
  const cwd = join(root, 'workspace');
  const runDir = join(root, 'ipc', 'runs', 'turn');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    cwd,
    prompt: 'continue',
    runTag: 'turn',
    binDir: runtimeBinDir,
    env: {
      ...(process.env as Record<string, string>),
      CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
      PERSIST_TURN_TIMEOUT: '2',
    },
    args: {
      agentCmd,
      sessionId: '',
      forkSession: '',
      model: '',
      fallbackModel: '',
      reasoningEffort: '',
      fallbackReasoningEffort: '',
      chatMode: '',
      agent: '',
      bare: '',
      systemPrompt: '',
      workDir: cwd,
      conversationKey: '',
      persistent: '',
      conversationId: '',
      env: {},
    },
  };
}

const v1Events = (runDir: string) =>
  readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

describe('managed ACP protocol translation', () => {
  test('recognizes provider failures delivered as ordinary message chunks', () => {
    expect(
      isProviderFailureText(
        'The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed. raw-http-request=/home/ubuntu/.omp/logs/http-400-requests/request.json',
      ),
    ).toBe(true);
    expect(isProviderFailureText('I inspected the encrypted content parser and fixed the test.')).toBe(false);
    expect(isProviderFailureText('Agent execution error: model unreachable: Error 503, Status: UNAVAILABLE')).toBe(true);
    expect(isProviderFailureText('I fixed handling of Agent execution error: model unreachable: Error 503.')).toBe(false);
    // Antigravity CLI wording, including toolbox failures before any model call.
    expect(isProviderFailureText('\n⚠ agent executor error: building toolbox: tool "x" advertises an invalid parameter schema')).toBe(true);
    expect(isProviderFailureText('The provider returned 503 earlier; the retry succeeded.')).toBe(false);
  });

  test('counts visible output once per tool and records a streamed provider failure', () => {
    const state: TranslationState = { completedTools: new Set(), visibleText: [] };
    const update = (value: Record<string, unknown>) =>
      translateAcpMessage({ method: 'session/update', params: { update: value } }, state);

    expect(update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'checking' } })).toBe(false);
    expect(update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', rawInput: { command: 'rg error' } })).toBe(true);
    // Partial output must not complete the tool.
    expect(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' })).toBe(false);
    expect(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed' })).toBe(true);
    expect(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' })).toBe(false);
    expect(update({ sessionUpdate: 'agent_message_chunk', content: { text: 'invalid_encrypted_content from provider' } })).toBe(true);
    expect(state.providerFailure).toBe('invalid_encrypted_content from provider');
  });

  test('turns a streamed provider error into a failed Board turn even when ACP resolves normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-run-'));
    roots.push(root);
    const cwd = join(root, 'workspace');
    const runDir = join(root, 'ipc', 'runs', 'turn');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const server = join(root, 'fake-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } });
  if (request.method === 'session/new') emit({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fake-session' } });
  if (request.method === 'session/prompt') {
    emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The encrypted content gAAA...' } } } });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' could not be verified. Reason: Encrypted content could not be decrypted or parsed.' } } } });
    emit({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );
    const context: RunContext = {
      runDir,
      cwd,
      prompt: 'continue',
      runTag: 'turn',
      binDir: root,
      env: {
        ...(process.env as Record<string, string>),
        CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
        PERSIST_TURN_TIMEOUT: '2',
      },
      args: {
        agentCmd: 'omp-acp',
        sessionId: '',
        forkSession: '',
        model: '',
        fallbackModel: '',
        reasoningEffort: '',
        fallbackReasoningEffort: '',
        chatMode: '',
        agent: '',
        bare: '',
        systemPrompt: '',
        workDir: cwd,
        conversationKey: '',
        persistent: '',
        conversationId: '',
        env: {},
      },
    };
    const contract: AcpHarnessContract = {
      id: 'omp-acp',
      restore: 'resume',
      process: () => ({ command: [process.execPath, server] }),
    };

    expect(await runAcpHarness(context, contract)).toBe(1);
    const events = readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toEqual({ type: 'session', id: 'fake-session', status: 'started' });
    expect(events.at(-1)).toMatchObject({ type: 'run', status: 'failed' });
    expect(events.find((event) => event.type === 'error')?.message).toContain('could not be verified');
    const rawFrames = readFileSync(join(runDir, 'acp.raw.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rawFrames).toHaveLength(3);
    expect(rawFrames[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'The encrypted content gAAA...' },
        },
      },
    });
    expect(rawFrames.at(-1)?.result.stopReason).toBe('end_turn');
    expect(rawFrames.every((frame) => frame.type === undefined)).toBe(true);
    const promptDispatchedAtMs = Number(readFileSync(join(runDir, 'prompt_dispatched_at_ms'), 'utf8'));
    const firstOutputAtMs = Number(readFileSync(join(runDir, 'first_output_at_ms'), 'utf8'));
    expect(promptDispatchedAtMs).toBeGreaterThan(0);
    expect(firstOutputAtMs).toBeGreaterThanOrEqual(promptDispatchedAtMs);
  });

  test('keeps the run open while sub-agents work, takes a follow-up message, and accepts tools replayed as finished', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-run-'));
    roots.push(root);
    const context = managedContext(root, 'antigravity-acp');
    const server = join(root, 'fake-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
const update = (value: unknown) => emit({ method: 'session/update', params: { update: value } });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'background-session' } });
  if (request.method === 'session/prompt') {
    if (request.params.prompt[0].text === 'status?') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'replayed', title: 'ledger add', status: 'completed', rawOutput: 'added' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All recorded.' } });
    }
    emit({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
  }
});
`,
    );
    let polls = 0;
    const contract: AcpHarnessContract = {
      id: 'antigravity-acp',
      restore: 'resume',
      process: () => ({ command: [process.execPath, server] }),
      createV1: (_context, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed),
      background: () => ({
        replayed: () => false,
        // Busy after the first prompt; nothing left once the follow-up was answered.
        poll: (promptReturned) => {
          polls += 1;
          if (promptReturned && polls > 1) return { tasks: [], busy: false, updates: [] };
          return {
            tasks: [{ id: 'sub', description: 'Bug Auditor', startedAt: 1 }],
            busy: true,
            updates: polls === 2
              ? [{ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Unit finished.' } } } }]
              : [],
            ...(polls === 1 ? { usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 1_000, totalTokens: 1_110 } } : {}),
          };
        },
      }),
    };

    const run = runAcpHarness(context, contract);
    const requests = join(context.runDir, 'control-requests');
    const events = () => readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(existsSync(join(context.runDir, 'output.v1.jsonl')) && events().some((event) => event.type === 'message_delta' && event.delta === 'Unit finished.'))) await Bun.sleep(20);
    // Still open: the sub-agent is listed and the run has no terminal event.
    expect(events().find((event) => event.type === 'background_tasks')?.tasks).toEqual([{ id: 'sub', description: 'Bug Auditor', startedAt: 1 }]);
    expect(events().some((event) => event.type === 'run' && event.status === 'completed')).toBe(false);
    writeFileSync(join(requests, 'steer.json'), JSON.stringify({ id: 'steer', action: 'steer', text: 'status?' }));

    expect(await run).toBe(0);
    expect(JSON.parse(readFileSync(join(context.runDir, 'control-responses', 'steer.json'), 'utf8')).ok).toBe(true);
    const final = events();
    expect(final.filter((event) => event.type === 'tool_call').map((event) => event.status)).toEqual(['started', 'completed']);
    expect(final.filter((event) => event.type === 'background_tasks').at(-1)?.tasks).toEqual([]);
    expect(final.filter((event) => event.type === 'message').map((event) => event.content)).toEqual(['Unit finished.', 'All recorded.']);
    // Sub-agent tokens are added to the run; the prompt's own usage stays last.
    expect(final.filter((event) => event.type === 'usage').map((event) => event.inputTokens)).toEqual([1, 100, 1]);
    expect(final.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
  });

  test('keeps waiting through the quiet period after the last sub-agent finishes, so its report turn is captured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-run-'));
    roots.push(root);
    const context = managedContext(root, 'antigravity-acp');
    const server = join(root, 'fake-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'background-session' } });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    let polls = 0;
    const contract: AcpHarnessContract = {
      id: 'antigravity-acp',
      restore: 'resume',
      process: () => ({ command: [process.execPath, server] }),
      createV1: (_context, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed),
      background: () => ({
        replayed: () => false,
        // Busy, busy, then the last sub-agent is done; its report turn shows up only on a later poll.
        poll: (promptReturned) => {
          polls += 1;
          if (promptReturned && polls > 1) return { tasks: [], busy: false, updates: [] };
          if (polls === 3) return { tasks: [], busy: false, updates: [] };
          const report = polls === 4
            ? [{ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sub-agent report.' } } } }]
            : [];
          return { tasks: [], busy: true, updates: report };
        },
      }),
    };

    const run = runAcpHarness(context, contract);
    const events = () => readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const deadline = Date.now() + 10_000;
    const reported = () => existsSync(join(context.runDir, 'output.v1.jsonl')) && events().some((event) => event.type === 'message_delta' && event.delta === 'Sub-agent report.');
    while (Date.now() < deadline && !reported()) await Bun.sleep(20);
    // The run must still be open when the report arrives, not ended on the first quiet poll.
    expect(reported()).toBe(true);
    writeFileSync(join(context.runDir, 'control-requests', 'steer.json'), JSON.stringify({ id: 'steer', action: 'steer', text: 'status?' }));
    expect(await run).toBe(0);
  });

  test('delivers a message sent mid-turn as a second prompt and keeps the turn open until that one returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-run-'));
    roots.push(root);
    const context = managedContext(root, 'antigravity-acp');
    const server = join(root, 'fake-acp.ts');
    // Like Antigravity: a second prompt ends the first at once, and the work goes on under the second.
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
const say = (text: string) => emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let running: unknown;
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'steer-session' } });
  if (request.method !== 'session/prompt') return;
  if (running === undefined) {
    running = request.id;
    say('Working.');
    return;
  }
  emit({ id: running, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } });
  setTimeout(() => {
    say(' Got: ' + request.params.prompt[0].text);
    emit({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } } });
  }, 300);
});
`,
    );
    const contract: AcpHarnessContract = {
      id: 'antigravity-acp',
      restore: 'resume',
      steerMidTurn: true,
      process: () => ({ command: [process.execPath, server] }),
      createV1: (_context, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed),
    };

    const run = runAcpHarness(context, contract);
    const events = () => readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(existsSync(join(context.runDir, 'output.v1.jsonl')) && events().some((event) => event.type === 'message_delta'))) await Bun.sleep(20);
    writeFileSync(join(context.runDir, 'control-requests', 'steer.json'), JSON.stringify({ id: 'steer', action: 'steer', text: 'use tabs' }));

    expect(await run).toBe(0);
    expect(JSON.parse(readFileSync(join(context.runDir, 'control-responses', 'steer.json'), 'utf8')).ok).toBe(true);
    const final = events();
    expect(final.filter((event) => event.type === 'message').map((event) => event.content)).toEqual(['Working. Got: use tabs']);
    // Both prompts are billed; the replaced one did not end the run.
    expect(final.filter((event) => event.type === 'usage').map((event) => event.inputTokens)).toEqual([5, 7]);
    expect(final.filter((event) => event.type === 'run' && event.status === 'completed')).toHaveLength(1);
  });

  test('keeps Hermes stdout on a pipe through the managed relay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-hermes-transport-'));
    roots.push(root);
    const context = managedContext(root, 'hermes-acp');
    context.args.model = 'qwen3';
    const server = join(root, 'pipe-acp.ts');
    writeFileSync(
      server,
      `import { fstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (fstatSync(1).isFile()) process.exit(23);
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'hermes-session' } });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    const contract: AcpHarnessContract = {
      id: 'hermes-acp',
      restore: 'load',
      process: () => ({
        command: [process.execPath, server],
      }),
    };

    expect(await runAcpHarness(context, contract)).toBe(0);
    const events = v1Events(context.runDir);
    expect(events[0]).toEqual({ type: 'session', id: 'hermes-session', status: 'started' });
    expect(JSON.parse(readFileSync(join(context.runDir, 'output.v1.meta.json'), 'utf8')).requestedModel).toBe('qwen3');
    expect(events.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
  });

  test('a model probe ends with a completed V1 run naming the session and never prompts the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-probe-'));
    roots.push(root);
    const context = managedContext(root, 'hermes-acp');
    context.env.CARAPA_MODEL_PROBE = '1';
    const promptMarker = join(root, 'prompted');
    const server = join(root, 'probe-acp.ts');
    writeFileSync(
      server,
      `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'probe-session' } });
  if (request.method === 'session/prompt') writeFileSync(${JSON.stringify(promptMarker)}, 'prompted');
});
`,
    );
    const contract: AcpHarnessContract = {
      id: 'hermes-acp',
      restore: 'load',
      process: () => ({ command: [process.execPath, server] }),
    };

    expect(await runAcpHarness(context, contract)).toBe(0);
    const events = v1Events(context.runDir);
    expect(events).toContainEqual({ type: 'session', id: 'probe-session', status: 'started' });
    expect(events.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(existsSync(promptMarker)).toBe(false);
  });

  test('falls back to a new Cursor-style session when session/load is rejected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-cursor-restore-'));
    roots.push(root);
    const context = managedContext(root, 'cursor-acp');
    context.args.sessionId = 'stale-session';
    const server = join(root, 'load-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/load') emit({ id: request.id, error: { message: 'not found' } });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'replacement-session' } });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    const contract: AcpHarnessContract = {
      id: 'cursor-acp',
      restore: 'load',
      restoreFailure: 'new-session',
      createV1: (value, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed, `vibe-${value.runTag}-message-1`),
      process: () => ({ command: [process.execPath, server] }),
    };

    expect(await runAcpHarness(context, contract)).toBe(0);
    expect(readFileSync(join(context.runDir, 'persistent_resume_failed'), 'utf8')).toBe('stale-session');
    expect(v1Events(context.runDir)[0]).toMatchObject({ type: 'session', id: 'replacement-session' });
  });

  test('a rejected session/resume before the V1 writer exists still ends the run with the provider text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-resume-fail-'));
    roots.push(root);
    const context = managedContext(root, 'omp-acp');
    context.args.sessionId = 'abc';
    const server = join(root, 'resume-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/resume') emit({ id: request.id, error: { message: 'Session abc not found' } });
});
`,
    );
    const contract: AcpHarnessContract = {
      id: 'omp-acp',
      restore: 'resume',
      process: () => ({ command: [process.execPath, server] }),
    };

    expect(await runAcpHarness(context, contract)).toBe(1);
    const terminal = readFileSync(join(context.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
    expect(terminal).toMatchObject({ type: 'run', status: 'failed', error: { message: 'Session abc not found' } });
  });

  test('passes a Prime session id at process launch without session/load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-prime-restore-'));
    roots.push(root);
    const context = managedContext(root, 'prime-agent-acp');
    context.args.sessionId = 'prime-session';
    const server = join(root, 'prime-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    let resumedWith = '';
    const contract: AcpHarnessContract = {
      id: 'prime-agent-acp',
      restore: 'process-argument',
      process: (_context, sessionId) => {
        resumedWith = sessionId ?? '';
        return { command: [process.execPath, server] };
      },
    };

    expect(await runAcpHarness(context, contract)).toBe(0);
    expect(resumedWith).toBe('prime-session');
    expect(v1Events(context.runDir)[0]).toMatchObject({ type: 'session', id: 'prime-session' });
  });

  test('does not resend unchanged warm-session configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-config-'));
    roots.push(root);
    const capture = join(root, 'capture.jsonl');
    const server = join(root, 'config-acp.ts');
    writeFileSync(
      server,
      `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify(request) + '\\n');
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'warm-session' } });
  if (request.method === 'session/set_config_option') emit({ id: request.id, result: {} });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    const makeContext = (turn: string) => {
      const value = managedContext(root, 'omp-acp');
      value.runDir = join(root, 'ipc', 'runs', turn);
      mkdirSync(value.runDir, { recursive: true });
      value.args.persistent = '1';
      value.args.conversationKey = 'warm-config';
      value.args.model = 'carapa-codex/gpt-test';
      value.args.reasoningEffort = 'none';
      return value;
    };
    const contract: AcpHarnessContract = {
      id: 'omp-acp',
      restore: 'resume',
      process: () => ({ command: [process.execPath, server] }),
      desiredConfiguration: () => ({
        model: 'carapa-codex/gpt-test',
        thinking: 'off',
      }),
      configure: (_context, sessionId, current = { newDaemon: true, model: '', thinking: '' }) => [
        ...(current.newDaemon || current.model !== 'carapa-codex/gpt-test'
          ? [
            {
              method: 'session/set_config_option' as const,
              params: {
                sessionId,
                configId: 'model',
                value: 'carapa-codex/gpt-test',
              },
            },
          ]
          : []),
        ...(current.newDaemon || current.thinking !== 'off'
          ? [
            {
              method: 'session/set_config_option' as const,
              params: { sessionId, configId: 'thinking', value: 'off' },
            },
          ]
          : []),
      ],
    };
    const first = makeContext('first');
    const second = makeContext('second');
    expect(await runAcpHarness(first, contract)).toBe(0);
    expect(await runAcpHarness(second, contract)).toBe(0);
    const requests = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === 'session/set_config_option')).toHaveLength(2);
    expect(readFileSync(join(second.runDir, 'pid'), 'utf8')).toBe(readFileSync(join(first.runDir, 'pid'), 'utf8'));
    await stopRun(second.runDir, readFileSync(join(second.runDir, 'pid'), 'utf8'));
  });

  test('replaces a warm Prime process when the model or thinking effort changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-prime-launch-'));
    roots.push(root);
    const server = join(root, 'prime-acp.ts');
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: 'prime-warm' } });
  if (request.method === 'session/prompt') emit({ id: request.id, result: { stopReason: 'end_turn' } });
});
`,
    );
    const launches: string[][] = [];
    // The real Prime launch flags, run against a fake agent.
    const contract: AcpHarnessContract = {
      ...primeAgentAcpContract,
      prepare: undefined,
      process: (context, sessionId) => {
        launches.push(primeAgentAcpContract.process(context, sessionId).command);
        return { command: [process.execPath, server] };
      },
    };
    const turn = async (name: string, model: string, effort: string) => {
      const value = managedContext(root, 'prime-agent-acp');
      value.runDir = join(root, 'ipc', 'runs', name);
      mkdirSync(value.runDir, { recursive: true });
      value.args.persistent = '1';
      value.args.conversationKey = 'prime-switch';
      value.args.model = model;
      value.args.reasoningEffort = effort;
      expect(await runAcpHarness(value, contract)).toBe(0);
      return value;
    };
    const first = await turn('first', 'p/m1', 'low');
    const same = await turn('same', 'p/m1', 'low');
    const model = await turn('model', 'p/m2', 'low');
    const effort = await turn('effort', 'p/m2', 'high');
    const pid = (value: RunContext) => readFileSync(join(value.runDir, 'pid'), 'utf8');
    expect(pid(same)).toBe(pid(first));
    expect(pid(model)).not.toBe(pid(same));
    expect(pid(effort)).not.toBe(pid(model));
    expect(launches).toHaveLength(3);
    expect(launches[1]).toContain('m2');
    expect(launches[1]).toContain('--resume');
    expect(launches[2].slice(-2)).toEqual(['--thinking', 'high']);
    await stopRun(effort.runDir, pid(effort));
  });

  test('replaces a warm process whose failed turn left it refusing prompts, retrying once in the same run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-acp-retire-'));
    roots.push(root);
    const server = join(root, 'stuck-acp.ts');
    const prompts = join(root, 'prompts.log');
    // Like Vibe 3.1.0: a process that failed a turn refuses every later prompt;
    // a new process that reloads the session works (unless ALWAYS_REJECT is set).
    writeFileSync(
      server,
      `import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n');
let loaded = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') emit({ id: request.id, result: {} });
  if (request.method === 'session/new') emit({ id: request.id, result: { sessionId: loaded ? 'replacement-session' : 'stuck-session' } });
  if (request.method === 'session/set_mode') {
    // A replacement whose configuration fails; the ping and the error reach the runner in one read.
    if (loaded && process.env.CONFIG_FAILS) {
      emit({ method: 'test/ping' });
      emit({ id: request.id, error: { message: 'configuration failed' } });
    } else emit({ id: request.id, result: {} });
  }
  if (request.method === 'session/load') {
    loaded = true;
    // An interrupt that arrives while the agent restarts; with a delay, its marker comes first.
    if (process.env.MARKER_FILE) writeFileSync(process.env.MARKER_FILE, 'requested');
    const interrupt = () => writeFileSync(process.env.INTERRUPT_FILE!, JSON.stringify({ action: 'interrupt' }));
    if (process.env.INTERRUPT_FILE) setTimeout(interrupt, Number(process.env.INTERRUPT_DELAY_MS || 0));
    // Like Vibe: a loaded session reports its running totals before it takes a prompt.
    if (process.env.SESSION_TOTALS) emit({ method: 'session/update', params: { update: { sessionUpdate: 'usage_update', _meta: { promptTokens: 1000, completionTokens: 0 } } } });
    const answer = process.env.LOAD_FAILS ? { id: request.id, error: { message: 'session not found' } } : { id: request.id, result: {} };
    setTimeout(() => emit(answer), Number(process.env.LOAD_DELAY_MS || 0));
  }
  if (request.method === 'session/prompt') {
    appendFileSync(process.env.PROMPT_LOG!, process.pid + ': ' + request.params.prompt[0].text + '\\n');
    appendFileSync(process.env.PROMPT_LOG + '.times', Date.now() + '\\n');
    const reply = loaded && process.env.RETRY_ERROR
      ? { id: request.id, error: { message: process.env.RETRY_ERROR } }
      : loaded && process.env.RETRY_STOP
      ? { id: request.id, result: { stopReason: process.env.RETRY_STOP } }
      : loaded && !process.env.ALWAYS_REJECT
      ? { id: request.id, result: { stopReason: 'end_turn', ...(process.env.SESSION_TOTALS ? { usage: { inputTokens: 1300, outputTokens: 20 } } : {}) } }
      : { id: request.id, error: { message: 'Core rejected durable input: invalid_state' } };
    // An interrupt that is queued as the crashed agent exits.
    if (!loaded && process.env.CRASH_INTERRUPT_FILE) writeFileSync(process.env.CRASH_INTERRUPT_FILE, JSON.stringify({ action: 'interrupt' }));
    // Markup printed before the crash must not make the clean retry look like it needs a correction.
    if (!loaded && process.env.CRASH_TEXT) emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: process.env.CRASH_TEXT } } } });
    setTimeout(() => {
      // Flush the error, then die with it.
      // A request flushed in the same write as the error, for a host that can no longer answer it.
      const request = process.env.REQUEST_BEFORE_ERROR ? JSON.stringify({ id: 'req-1', method: 'test/request' }) + '\\n' : '';
      if (loaded && process.env.RETRY_HANG) return;
      if (!loaded && process.env.EXIT_AFTER_ERROR) process.stdout.write(request + JSON.stringify(reply) + '\\n', () => process.exit(0));
      else emit(reply);
    }, loaded ? 0 : Number(process.env.FAIL_DELAY_MS || 0));
  }
});
`,
    );
    const makeContext = (turn: string, key: string) => {
      const value = managedContext(root, 'vibe-acp');
      value.runDir = join(root, 'ipc', 'runs', turn);
      mkdirSync(value.runDir, { recursive: true });
      value.args.persistent = '1';
      value.args.conversationKey = key;
      return value;
    };
    const contract = (extra: Partial<AcpHarnessContract> = {}, env: Record<string, string> = {}): AcpHarnessContract => ({
      id: 'vibe-acp',
      restore: 'load',
      restoreFailure: 'new-session',
      createV1: (value, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed, `vibe-${value.runTag}-message-1`),
      process: () => ({ command: [process.execPath, server], env: { PROMPT_LOG: prompts, ...env } }),
      retireDaemonAfter: (failure) => failure.includes('Core rejected durable input'),
      ...extra,
    });
    const recovering = { recoveryPrompt: () => 'correction text' };
    const pidOf = (value: RunContext) => readFileSync(join(value.runDir, 'pid'), 'utf8');

    // Without a recovery prompt the run fails as before and the next run gets a fresh process.
    const first = makeContext('first', 'stuck');
    const second = makeContext('second', 'stuck');
    expect(await runAcpHarness(first, contract())).toBe(1);
    expect(await runAcpHarness(second, contract())).toBe(0);
    expect(pidOf(second)).not.toBe(pidOf(first));
    await stopRun(second.runDir, pidOf(second));

    // With one: a restarted process reloads the session and takes the correction in the same run.
    const recovered = makeContext('recovered', 'recovers');
    writeFileSync(prompts, '');
    expect(await runAcpHarness(recovered, contract(recovering))).toBe(0);
    const sent = readFileSync(prompts, 'utf8').trim().split('\n').map((line) => line.replace(/^\d+: /, ''));
    expect(sent).toEqual(['continue', 'correction text']);
    const recoveredEvents = v1Events(recovered.runDir);
    expect(recoveredEvents).toContainEqual(expect.objectContaining({ type: 'message', id: 'harness-restart-notice', content: expect.stringContaining('restarted the agent process') }));
    expect(recoveredEvents.at(-1)).toMatchObject({ type: 'run', status: 'completed' });
    await stopRun(recovered.runDir, pidOf(recovered));

    // A second matching failure in the same run fails it and retires the process.
    const exhausted = makeContext('exhausted', 'exhausted');
    writeFileSync(prompts, '');
    expect(await runAcpHarness(exhausted, contract(recovering, { ALWAYS_REJECT: '1' }))).toBe(1);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(v1Events(exhausted.runDir).at(-1)).toMatchObject({ type: 'run', status: 'failed' });
    expect(existsSync(join(root, 'ipc', 'sessions', 'exhausted', 'daemon.pid'))).toBe(false);

    // When the reload fails, the replacement session gets the original request with the correction and is
    // published in the V1 stream; the run keeps its first prompt dispatch time.
    const replaced = makeContext('replaced', 'replaced');
    writeFileSync(prompts, '');
    writeFileSync(`${prompts}.times`, '');
    expect(await runAcpHarness(replaced, contract(recovering, { LOAD_FAILS: '1', FAIL_DELAY_MS: '400' }))).toBe(0);
    expect(readFileSync(prompts, 'utf8')).toEndWith(': continue\n\ncorrection text\n');
    const v1Sessions = readFileSync(join(replaced.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((event) => event.type === 'session').map((event) => event.id);
    expect(v1Sessions).toEqual(['stuck-session', 'replacement-session']);
    const [, retriedAt] = readFileSync(`${prompts}.times`, 'utf8').trim().split('\n').map(Number);
    expect(Number(readFileSync(join(replaced.runDir, 'prompt_dispatched_at_ms'), 'utf8'))).toBeLessThan(retriedAt - 200);
    await stopRun(replaced.runDir, pidOf(replaced));

    // A process that dies right after flushing the matching error is still replaced in the same run.
    const died = makeContext('died', 'died');
    writeFileSync(prompts, '');
    expect(await runAcpHarness(died, contract(recovering, { EXIT_AFTER_ERROR: '1' }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n').map((line) => line.replace(/^\d+: /, ''))).toEqual(['continue', 'correction text']);
    await stopRun(died.runDir, pidOf(died));

    // An interrupt during a slow restore is answered and settled at once, not after the restore.
    const slow = makeContext('slow', 'slow');
    mkdirSync(join(slow.runDir, 'control-requests'), { recursive: true });
    writeFileSync(prompts, '');
    const slowStart = Date.now();
    expect(await runAcpHarness(slow, contract(recovering, {
      INTERRUPT_FILE: join(slow.runDir, 'control-requests', 'stop.json'), LOAD_DELAY_MS: '6000',
    }))).toBe(0);
    expect(Date.now() - slowStart).toBeLessThan(4000);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(slow.runDir, 'control-responses', 'stop.json'))).toBe(true);
    expect(v1Events(slow.runDir).at(-1)).toMatchObject({ type: 'run', status: 'completed' });

    // An interrupt whose marker is on disk before its request is still answered, and no correction is sent.
    const late = makeContext('late', 'late');
    mkdirSync(join(late.runDir, 'control-requests'), { recursive: true });
    writeFileSync(prompts, '');
    expect(await runAcpHarness(late, contract(recovering, {
      MARKER_FILE: join(late.runDir, 'turn_interrupt'), INTERRUPT_FILE: join(late.runDir, 'control-requests', 'stop.json'),
      INTERRUPT_DELAY_MS: '300',
    }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(late.runDir, 'control-responses', 'stop.json'))).toBe(true);
    await stopRun(late.runDir, pidOf(late));

    // A retry that fails with another error leaves no warm replacement for the next run.
    const retryFails = makeContext('retry-fails', 'retry-fails');
    expect(await runAcpHarness(retryFails, contract(recovering, { RETRY_ERROR: 'overloaded' }))).toBe(1);
    expect(existsSync(join(root, 'ipc', 'sessions', 'retry-fails', 'daemon.pid'))).toBe(false);

    // A retry that ends without success, even with no error text, retires the replacement.
    const retryStops = makeContext('retry-stops', 'retry-stops');
    expect(await runAcpHarness(retryStops, contract(recovering, { RETRY_STOP: 'max_tokens' }))).toBe(1);
    expect(existsSync(join(root, 'ipc', 'sessions', 'retry-stops', 'daemon.pid'))).toBe(false);

    // Tool-call markup from the crashed attempt is settled: a clean retry sends no further correction.
    const markup = makeContext('markup', 'markup');
    writeFileSync(prompts, '');
    expect(await runAcpHarness(markup, contract(recovering, { CRASH_TEXT: '<tool_call><function=foo>\n' }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n').map((line) => line.replace(/^\d+: /, ''))).toEqual(['continue', 'correction text']);
    await stopRun(markup.runDir, pidOf(markup));

    // An interrupt that is pending when the replacement's configuration fails is answered, and the
    // replacement session that was already saved is the one both streams name.
    const configuring = makeContext('configuring', 'configuring');
    mkdirSync(join(configuring.runDir, 'control-requests'), { recursive: true });
    writeFileSync(prompts, '');
    const configure: AcpHarnessContract['configure'] = (_value, sessionId) => [{ method: 'session/set_mode', params: { sessionId, modeId: 'auto' } }];
    // The marker lands in the read that carries the error, its request only afterwards: no poll can have settled it.
    const reply: AcpHarnessContract['reply'] = (message) => {
      if (message.method !== 'test/ping') return null;
      writeFileSync(join(configuring.runDir, 'turn_interrupt'), 'requested');
      setTimeout(() => writeFileSync(join(configuring.runDir, 'control-requests', 'stop.json'), JSON.stringify({ action: 'interrupt' })), 300);
      return null;
    };
    expect(await runAcpHarness(configuring, contract({ ...recovering, configure, reply }, {
      LOAD_FAILS: '1', CONFIG_FAILS: '1',
    }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(configuring.runDir, 'control-responses', 'stop.json'))).toBe(true);
    expect(readFileSync(join(root, 'ipc', 'sessions', 'configuring', 'session_id'), 'utf8')).toBe('replacement-session');
    expect(readFileSync(join(configuring.runDir, 'output.v1.jsonl'), 'utf8')).toContain('"id":"replacement-session"');

    // An interrupt that wins against the replacement's launch leaves no supervisor or pid file behind.
    const launching = makeContext('launching', 'launching');
    mkdirSync(join(launching.runDir, 'control-requests'), { recursive: true });
    // The request lands as soon as the crashed process is gone, while its replacement is still launching.
    const launchedPid = join(root, 'ipc', 'sessions', 'launching', 'daemon.pid');
    let running = false;
    const poller = setInterval(() => {
      if (existsSync(launchedPid)) running = true;
      else if (running) {
        clearInterval(poller);
        writeFileSync(join(launching.runDir, 'control-requests', 'stop.json.tmp'), JSON.stringify({ action: 'interrupt' }));
        renameSync(join(launching.runDir, 'control-requests', 'stop.json.tmp'), join(launching.runDir, 'control-requests', 'stop.json'));
      }
    }, 1);
    // A preload slows every launch, so the interrupt outruns the replacement's.
    const slowBoot = join(root, 'slow-boot.ts');
    writeFileSync(slowBoot, 'await Bun.sleep(300);\n');
    expect(await runAcpHarness(launching, contract(recovering, { BUN_OPTIONS: `--preload ${slowBoot}` }))).toBe(0);
    clearInterval(poller);
    await Bun.sleep(1500);
    expect(existsSync(join(root, 'ipc', 'sessions', 'launching', 'daemon.pid'))).toBe(false);

    // An interrupt queued as the crashed agent exits is answered locally, and no correction is sent.
    const crashing = makeContext('crashing', 'crashing');
    mkdirSync(join(crashing.runDir, 'control-requests'), { recursive: true });
    writeFileSync(prompts, '');
    expect(await runAcpHarness(crashing, contract(recovering, {
      EXIT_AFTER_ERROR: '1', CRASH_INTERRUPT_FILE: join(crashing.runDir, 'control-requests', 'stop.json'),
    }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(crashing.runDir, 'control-responses', 'stop.json'))).toBe(true);
    expect(v1Events(crashing.runDir).at(-1)).not.toMatchObject({ status: 'failed' });
    expect(existsSync(join(root, 'ipc', 'sessions', 'crashing', 'daemon.pid'))).toBe(false);

    // A hard stop aimed at the crashed process while its replacement starts leaves no replacement and no correction.
    const stopped = makeContext('stopped', 'stopped');
    writeFileSync(prompts, '');
    const stoppedRun = runAcpHarness(stopped, contract(recovering, { LOAD_DELAY_MS: '1500' }));
    const stopOutput = join(stopped.runDir, 'output.v1.jsonl');
    while (!existsSync(stopOutput) || !readFileSync(stopOutput, 'utf8').includes('restarted the agent process')) await Bun.sleep(20);
    await stopRun(stopped.runDir, pidOf(stopped));
    expect(await stoppedRun).toBe(1);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(root, 'ipc', 'sessions', 'stopped', 'daemon.pid'))).toBe(false);

    // The reloaded session's own totals are history: the retry bills only what it added.
    const totals = makeContext('totals', 'totals');
    expect(await runAcpHarness(totals, contract(recovering, { SESSION_TOTALS: '1' }))).toBe(0);
    const billed = readFileSync(join(totals.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((event) => event.type === 'usage');
    expect(billed.map((event) => event.inputTokens)).toEqual([300]);
    await stopRun(totals.runDir, pidOf(totals));

    // A hard stop recorded while the crashed agent is being ended must not be followed by a replacement launch.
    const fenced = makeContext('fenced', 'fenced');
    writeFileSync(prompts, '');
    let launches = 0;
    const recordStop = () => {
      writeFileSync(join(fenced.runDir, 'stop_requested'), 'requested');
      return 'correction text';
    };
    const launching1 = contract({ recoveryPrompt: recordStop });
    const launchedProcess = launching1.process;
    launching1.process = (...args) => {
      launches++;
      return launchedProcess(...args);
    };
    expect(await runAcpHarness(fenced, launching1)).toBe(1);
    expect(launches).toBe(1);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(root, 'ipc', 'sessions', 'fenced', 'daemon.pid'))).toBe(false);

    // A hard stop that names the crashed process, sent once the replacement has its prompt, still ends the run.
    const hung = makeContext('hung', 'hung');
    hung.env.PERSIST_TURN_TIMEOUT = '30';
    writeFileSync(prompts, '');
    const sentCount = () => readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).length;
    const hungRun = runAcpHarness(hung, contract(recovering, { RETRY_HANG: '1' }));
    while (sentCount() < 1) await Bun.sleep(10);
    const crashedPid = pidOf(hung);
    while (sentCount() < 2) await Bun.sleep(10);
    await stopRun(hung.runDir, crashedPid);
    expect(await hungRun).toBe(1);
    expect(existsSync(join(root, 'ipc', 'sessions', 'hung', 'daemon.pid'))).toBe(false);

    // A request flushed with the matching error, which the exited agent can no longer be answered, does not hide the error.
    const dying = makeContext('dying', 'dying');
    writeFileSync(prompts, '');
    const answer: AcpHarnessContract['reply'] = (message) => {
      if (message.method !== 'test/request') return null;
      const pid = Number(pidOf(dying));
      // The agent is gone before the reply is sent, however the exit raced the read.
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      while (isAlive(pid)) Bun.sleepSync(5);
      return { jsonrpc: '2.0', id: message.id, result: {} };
    };
    expect(await runAcpHarness(dying, contract({ ...recovering, reply: answer }, { EXIT_AFTER_ERROR: '1', REQUEST_BEFORE_ERROR: '1' }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n').map((line) => line.replace(/^\d+: /, ''))).toEqual(['continue', 'correction text']);
    await stopRun(dying.runDir, pidOf(dying));

    // A request a replacement session cannot repeat fails the run instead of sending the correction alone.
    const unrepeatable = makeContext('unrepeatable', 'unrepeatable');
    writeFileSync(prompts, '');
    expect(await runAcpHarness(unrepeatable, contract({ ...recovering, freshSessionRequest: () => null }, { LOAD_FAILS: '1' }))).toBe(1);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(v1Events(unrepeatable.runDir).at(-1)).toMatchObject({ type: 'run', status: 'failed', error: { message: expect.stringContaining('cannot repeat the original request') } });
    expect(existsSync(join(root, 'ipc', 'sessions', 'unrepeatable', 'daemon.pid'))).toBe(false);

    // An interrupt that arrives while the agent restarts ends the run without sending the correction.
    const interrupted = makeContext('interrupted', 'interrupted');
    mkdirSync(join(interrupted.runDir, 'control-requests'), { recursive: true });
    writeFileSync(prompts, '');
    const interruptFile = join(interrupted.runDir, 'control-requests', 'stop.json');
    expect(await runAcpHarness(interrupted, contract(recovering, { INTERRUPT_FILE: interruptFile }))).toBe(0);
    expect(readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(interrupted.runDir, 'control-responses', 'stop.json'))).toBe(true);
    expect(v1Events(interrupted.runDir).at(-1)).not.toMatchObject({ status: 'failed' });
    await stopRun(interrupted.runDir, pidOf(interrupted));
  }, 30_000);
});
