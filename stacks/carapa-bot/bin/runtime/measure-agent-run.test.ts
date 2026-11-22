import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeRunV1Adapter } from './claude-v1';
import type { RunContext } from './contracts';
import { PiRunV1Adapter } from './pi-rpc/v1';
import { RunV1Writer } from './run-v1';

const roots: string[] = [];
const measureScript = resolve(import.meta.dir, '..', 'measure-agent-run.mjs');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RunFiles = { args: Record<string, unknown>; events?: string; manifest?: string };

const measureFiles = async ({ args, events, manifest }: RunFiles) => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-measure-'));
  roots.push(root);
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'args.json'), JSON.stringify(args));
  writeFileSync(join(runDir, 'exit_code'), '0');
  if (events !== undefined) writeFileSync(join(runDir, 'output.v1.jsonl'), events);
  if (manifest !== undefined) writeFileSync(join(runDir, 'output.v1.meta.json'), manifest);
  const child = Bun.spawn([process.execPath, measureScript, runDir, String(Date.now())], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  expect(await new Response(child.stderr).text()).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
};

/** Runs `feed` against a real V1 writer, then measures the files it wrote. */
const measureV1 = async (
  args: Record<string, unknown>,
  harness: string,
  feed: (writer: RunV1Writer) => void,
) => {
  const dir = mkdtempSync(join(tmpdir(), 'carapa-measure-v1-'));
  roots.push(dir);
  const writer = new RunV1Writer(dir, { format: 'carapa-run', version: 1, harness, requestedModel: String(args.model) });
  feed(writer);
  return measureFiles({
    args,
    events: readFileSync(writer.eventPath, 'utf8'),
    manifest: readFileSync(writer.manifestPath, 'utf8'),
  });
};

const claudeResult = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'result',
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  },
  ...extra,
});

const measureClaude = (events: Record<string, unknown>[]) =>
  measureV1({ agentCmd: 'claude', model: 'claude-opus-5-5' }, 'claude', (writer) => {
    const adapter = new ClaudeRunV1Adapter(writer, 'claude-opus-5-5', false);
    for (const event of events) {
      adapter.consume(event);
      // The runner opens the next turn after each result of a run kept open.
      if (event.type === 'result') adapter.beginContinuation();
    }
    adapter.finish(0);
  });

describe('measure-agent-run claude results', () => {
  test('sums usage across every top-level result', async () => {
    const metrics = await measureClaude([
      claudeResult(18, 5928, 860986, 68917),
      claudeResult(16, 8207, 780692, 85748),
      claudeResult(4, 101, 129432, 417),
      claudeResult(12, 8347, 685504, 17192),
    ]);
    expect(metrics.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 22583,
      cachedInputTokens: 2456614,
      cacheWriteTokens: 172274,
    });
    expect(metrics.usage.raw).toHaveLength(4);
  });

  test('keeps single-result values unchanged', async () => {
    const metrics = await measureClaude([claudeResult(12, 8347, 685504, 17192)]);
    expect(metrics.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8347,
      cachedInputTokens: 685504,
      cacheWriteTokens: 17192,
      reasoningOutputTokens: null,
      raw: [{
        type: 'usage',
        scope: 'cumulative',
        inputTokens: 12,
        outputTokens: 8347,
        cachedInputTokens: 685504,
        cacheWriteInputTokens: 17192,
      }],
    });
    expect(metrics.sessionId).toBe('claude-session');
    expect(metrics.model).toBe('claude-opus-5-5');
  });

  test('counts a duplicated result uuid once', async () => {
    const result = claudeResult(12, 8347, 685504, 17192, { uuid: 'abc' });
    const metrics = await measureClaude([result, result]);
    expect(metrics.usage.cachedInputTokens).toBe(685504);
    expect(metrics.usage.inputTokens).toBe(12);
  });

  test('ignores results from sub-agents', async () => {
    const metrics = await measureClaude([
      claudeResult(1, 1, 1, 1, { parent_tool_use_id: 'toolu_1' }),
      claudeResult(12, 8347, 685504, 17192),
    ]);
    expect(metrics.usage.inputTokens).toBe(12);
    expect(metrics.usage.raw).toHaveLength(1);
  });
});

const piContext = { args: { model: 'configured-model' } } as unknown as RunContext;

const piUsage = (input: number, output: number, cacheRead: number, reasoning: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const piMessageEnd = (usage: ReturnType<typeof piUsage>, extra: Record<string, unknown> = {}) => ({
  type: 'message_end',
  message: { role: 'assistant', model: 'priced-model', usage, content: [{ type: 'text', text: 'ok' }], ...extra },
});

const measurePi = (events: Record<string, unknown>[]) =>
  measureV1(
    {
      agentCmd: 'pi',
      model: 'configured-model',
      pricing: {
        version: 1,
        currency: 'USD',
        models: { 'priced-model': { input: 0.15, cachedInput: 0.015, output: 0.6 } },
      },
    },
    'pi',
    (writer) => {
      const adapter = new PiRunV1Adapter(writer, piContext);
      for (const event of events) adapter.consume(event);
      adapter.finish('completed', 'stop');
    },
  );

describe('measure-agent-run', () => {
  test('normalizes usage and model from a Pi agent_end snapshot', async () => {
    const snapshot = piUsage(809, 10, 2560, 0);
    const metrics = await measurePi([
      { type: 'agent_end', messages: [{ role: 'assistant', model: 'gpt-5.6-luna', usage: snapshot, content: [] }] },
    ]);
    expect(metrics.model).toBe('gpt-5.6-luna');
    expect(metrics.usage).toMatchObject({
      inputTokens: 809,
      outputTokens: 10,
      cachedInputTokens: 2560,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(metrics.usage.raw).toHaveLength(1);
  });

  test('folds hand-written V1 events: session, model, duration, usage scopes, tools and steps', async () => {
    const events = [
      { type: 'session', id: 'first', status: 'started' },
      { type: 'run', status: 'started', model: 'm-start' },
      { type: 'session', id: 'second', status: 'resumed' },
      { type: 'run', status: 'in_progress', model: 'm-later' },
      { type: 'usage', scope: 'incremental', inputTokens: 10, outputTokens: 1, cacheWriteInputTokens: 4 },
      { type: 'usage', scope: 'incremental', inputTokens: 5, outputTokens: 2, cachedInputTokens: 3 },
      'not json',
      { type: 'message', id: 'a1', role: 'assistant', content: 'x', status: 'completed' },
      { type: 'message', id: 'a2', role: 'assistant', content: 'y', status: 'interrupted' },
      { type: 'message', id: 'u1', role: 'user', content: 'z', status: 'completed' },
      { type: 'tool_call', id: 't1', status: 'started', name: 'mcp__board__list_tasks', category: 'mcp', input: { a: 1 } },
      { type: 'tool_call', id: 't1', status: 'completed', output: 'ok' },
      { type: 'tool_call', id: 't2', status: 'started', category: 'execute' },
      { type: 'tool_call', id: 't3', status: 'started' },
      { type: 'tool_call', id: 't3', status: 'completed', name: 'Bash', input: { command: 'ls' } },
      { type: 'run', status: 'completed', metrics: { durationMs: 4321 } },
    ];
    const metrics = await measureFiles({
      args: { agentCmd: 'x', sessionId: 'from-args', model: 'from-args' },
      events: events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n'),
      manifest: JSON.stringify({ format: 'carapa-run', version: 1, harness: 'x', requestedModel: 'requested' }),
    });
    expect(metrics.sessionId).toBe('second');
    expect(metrics.model).toBe('m-later');
    expect(metrics.durationMs).toBe(4321);
    expect(metrics.usage).toMatchObject({ inputTokens: 15, outputTokens: 3, cachedInputTokens: 3, cacheWriteTokens: 4, reasoningOutputTokens: null });
    expect(metrics.usage.raw).toHaveLength(2);
    expect(metrics.toolCalls).toEqual([
      { id: 't1', name: 'list_tasks', kind: 'mcp', input: { a: 1 } },
      { id: 't2', name: 'execute', kind: 'execute', input: {} },
      { id: 't3', name: 'Bash', kind: 'tool', input: { command: 'ls' } },
    ]);
    // One completed assistant message plus three distinct tool call ids.
    expect(metrics.steps).toBe(4);
  });

  test('cumulative usage replaces the running totals', async () => {
    const metrics = await measureFiles({
      args: { agentCmd: 'x' },
      events: [
        { type: 'usage', scope: 'incremental', inputTokens: 9, outputTokens: 9, cachedInputTokens: 9 },
        { type: 'usage', scope: 'cumulative', inputTokens: 100, outputTokens: 20 },
        { type: 'usage', scope: 'incremental', inputTokens: 1, outputTokens: 1 },
      ].map((event) => JSON.stringify(event)).join('\n'),
    });
    expect(metrics.usage).toMatchObject({ inputTokens: 101, outputTokens: 21, cachedInputTokens: null });
  });

  test('without V1 files the script falls back to the args and still writes metrics', async () => {
    const metrics = await measureFiles({ args: { agentCmd: 'x', sessionId: 'from-args', model: 'from-args' } });
    expect(metrics).toMatchObject({ sessionId: 'from-args', model: 'from-args', usage: null, steps: 0, toolCalls: [] });
    const bare = await measureFiles({ args: { agentCmd: 'x' }, manifest: '{broken' });
    expect(bare).toMatchObject({ sessionId: null, model: null, usage: null, steps: 0, toolCalls: [] });
  });

  test('uses the manifest requested model when no run event names one', async () => {
    const metrics = await measureFiles({
      args: { agentCmd: 'x', model: 'from-args' },
      events: JSON.stringify({ type: 'run', status: 'started' }),
      manifest: JSON.stringify({ format: 'carapa-run', version: 1, harness: 'x', requestedModel: 'requested' }),
    });
    expect(metrics.model).toBe('requested');
  });
});

describe('measure-agent-run pi message_end turns', () => {
  const first = piUsage(4156, 127, 11264, 26);
  const last = piUsage(1414, 732, 29184, 0);
  const sum = { input: 5570, output: 859, cacheRead: 40448 };
  const sumCost = (sum.input * 0.15 + sum.cacheRead * 0.015 + sum.output * 0.6) / 1_000_000;

  test('sums every assistant message_end and prices the sum, ignoring the agent_end replay', async () => {
    const metrics = await measurePi([
      { type: 'message_end', message: { role: 'user', content: 'hi' } },
      piMessageEnd(first),
      piMessageEnd(last),
      { type: 'agent_end', messages: [{ role: 'assistant', model: 'priced-model', usage: last, content: [{ type: 'text', text: 'ok' }] }] },
    ]);
    expect(metrics.usage).toMatchObject({
      inputTokens: sum.input,
      outputTokens: sum.output,
      cachedInputTokens: sum.cacheRead,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 26,
    });
    expect(metrics.usage.raw).toHaveLength(2);
    expect(metrics.costUsd).toBeCloseTo(sumCost, 12);
  });

  test('counts a repeated message_end responseId once', async () => {
    const metrics = await measurePi([
      piMessageEnd(first, { responseId: 'resp_1' }),
      piMessageEnd(first, { responseId: 'resp_1' }),
      piMessageEnd(last, { responseId: 'resp_2' }),
    ]);
    expect(metrics.usage.inputTokens).toBe(sum.input);
    expect(metrics.usage.raw).toHaveLength(2);
    expect(metrics.costUsd).toBeCloseTo(sumCost, 12);
  });

  test('counts steps and tool calls once per distinct message and tool id', async () => {
    const metrics = await measurePi([
      piMessageEnd(first, { responseId: 'resp_1' }),
      { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a' }] } },
      piMessageEnd(last, { responseId: 'resp_2' }),
      { type: 'agent_end', messages: [piMessageEnd(last, { responseId: 'resp_2' }).message] },
    ]);
    expect(metrics.steps).toBe(3);
    expect(metrics.toolCalls).toEqual([
      { id: 'call_1', name: 'bash', kind: 'execute', input: { command: 'ls' } },
    ]);
  });
});
