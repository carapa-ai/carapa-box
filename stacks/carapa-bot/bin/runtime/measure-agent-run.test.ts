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

const roots: string[] = [];
const measureScript = resolve(import.meta.dir, '..', 'measure-agent-run.mjs');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const claudeResult = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  turns: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'result',
  num_turns: turns,
  duration_ms: durationMs,
  usage: {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  },
  ...extra,
});

const measureClaude = async (events: unknown[]) => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-measure-claude-'));
  roots.push(root);
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, 'args.json'),
    JSON.stringify({ agentCmd: 'claude', model: 'claude-opus-5-5' }),
  );
  writeFileSync(join(runDir, 'exit_code'), '0');
  writeFileSync(
    join(runDir, 'output.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const child = Bun.spawn([process.execPath, measureScript, runDir, String(Date.now())], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  expect(await new Response(child.stderr).text()).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
};

describe('measure-agent-run claude results', () => {
  test('sums usage, steps and duration across every top-level result', async () => {
    const metrics = await measureClaude([
      claudeResult(18, 5928, 860986, 68917, 12, 59926),
      claudeResult(16, 8207, 780692, 85748, 8, 62127),
      claudeResult(4, 101, 129432, 417, 1, 2256),
      claudeResult(12, 8347, 685504, 17192, 7, 63635),
    ]);
    expect(metrics.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 22583,
      cachedInputTokens: 2456614,
      cacheWriteTokens: 172274,
    });
    expect(metrics.usage.raw).toHaveLength(4);
    expect(metrics.steps).toBe(28);
    expect(metrics.durationMs).toBe(187944);
  });

  test('keeps single-result values unchanged', async () => {
    const metrics = await measureClaude([claudeResult(12, 8347, 685504, 17192, 7, 63635)]);
    expect(metrics.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8347,
      cachedInputTokens: 685504,
      cacheWriteTokens: 17192,
      reasoningOutputTokens: null,
      raw: {
        input_tokens: 12,
        output_tokens: 8347,
        cache_read_input_tokens: 685504,
        cache_creation_input_tokens: 17192,
      },
    });
    expect(metrics.steps).toBe(7);
    expect(metrics.durationMs).toBe(63635);
  });

  test('counts a duplicated result uuid once', async () => {
    const result = claudeResult(12, 8347, 685504, 17192, 7, 63635, { uuid: 'abc' });
    const metrics = await measureClaude([result, result]);
    expect(metrics.usage.cachedInputTokens).toBe(685504);
    expect(metrics.steps).toBe(7);
    expect(metrics.durationMs).toBe(63635);
  });

  test('ignores results from sub-agents', async () => {
    const metrics = await measureClaude([
      claudeResult(1, 1, 1, 1, 3, 100, { parent_tool_use_id: 'toolu_1' }),
      claudeResult(12, 8347, 685504, 17192, 7, 63635),
    ]);
    expect(metrics.usage.inputTokens).toBe(12);
    expect(metrics.steps).toBe(7);
    expect(metrics.durationMs).toBe(63635);
  });
});

describe('measure-agent-run', () => {
  test('normalizes usage from Pi agent_end snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-measure-pi-'));
    roots.push(root);
    const runDir = join(root, 'run');
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, 'args.json'),
      JSON.stringify({ agentCmd: 'pi', model: 'configured-model' }),
    );
    writeFileSync(join(runDir, 'exit_code'), '0');
    writeFileSync(
      join(runDir, 'output.jsonl'),
      `${JSON.stringify({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            model: 'gpt-5.6-luna',
            usage: {
              input: 809,
              output: 10,
              cacheRead: 2560,
              cacheWrite: 0,
              reasoning: 0,
              totalTokens: 3379,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ],
      })}\n`,
    );

    const child = Bun.spawn([process.execPath, measureScript, runDir, String(Date.now())], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    expect(await new Response(child.stderr).text()).toBe('');
    expect(exitCode).toBe(0);

    const metrics = JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
    expect(metrics.model).toBe('gpt-5.6-luna');
    expect(metrics.usage).toEqual({
      inputTokens: 809,
      outputTokens: 10,
      cachedInputTokens: 2560,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
      raw: {
        input: 809,
        output: 10,
        cacheRead: 2560,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 3379,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  });
});

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
  message: { role: 'assistant', model: 'priced-model', usage, ...extra },
});

const measurePi = async (events: unknown[]) => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-measure-pi-turns-'));
  roots.push(root);
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, 'args.json'),
    JSON.stringify({
      agentCmd: 'pi',
      model: 'configured-model',
      pricing: {
        version: 1,
        currency: 'USD',
        models: { 'priced-model': { input: 0.15, cachedInput: 0.015, output: 0.6 } },
      },
    }),
  );
  writeFileSync(join(runDir, 'exit_code'), '0');
  writeFileSync(
    join(runDir, 'output.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const child = Bun.spawn([process.execPath, measureScript, runDir, String(Date.now())], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  expect(await new Response(child.stderr).text()).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8'));
};

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
      { type: 'agent_end', messages: [{ role: 'assistant', model: 'priced-model', usage: last }] },
    ]);
    expect(metrics.usage).toEqual({
      inputTokens: sum.input,
      outputTokens: sum.output,
      cachedInputTokens: sum.cacheRead,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 26,
      raw: [first, last],
    });
    expect(metrics.costUsd).toBeCloseTo(sumCost, 12);
  });

  test('counts a repeated message_end responseId once', async () => {
    const metrics = await measurePi([
      piMessageEnd(first, { responseId: 'resp_1' }),
      piMessageEnd(first, { responseId: 'resp_1' }),
      piMessageEnd(last, { responseId: 'resp_2' }),
    ]);
    expect(metrics.usage.inputTokens).toBe(sum.input);
    expect(metrics.usage.raw).toEqual([first, last]);
    expect(metrics.costUsd).toBeCloseTo(sumCost, 12);
  });

  test('counts steps and toolCall blocks once per distinct assistant message_end', async () => {
    const toolTurn = piMessageEnd(first, {
      responseId: 'resp_1',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      ],
    });
    const metrics = await measurePi([
      toolTurn,
      toolTurn,
      piMessageEnd(last, { responseId: 'resp_2', content: [{ type: 'text', text: 'done' }] }),
      { type: 'agent_end', messages: [toolTurn.message] },
    ]);
    expect(metrics.steps).toBe(2);
    expect(metrics.toolCalls).toEqual([
      { id: 'call_1', name: 'bash', kind: 'tool', input: { command: 'ls' } },
    ]);
  });
});
