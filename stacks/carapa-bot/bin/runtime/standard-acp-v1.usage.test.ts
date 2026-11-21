import { expect, test } from 'bun:test';
import type { RunV1Writer } from './run-v1';
import { StandardAcpRunV1Adapter } from './standard-acp-v1';

const update = {
  jsonrpc: '2.0', method: 'session/update', params: {
    update: {
      sessionUpdate: 'usage_update',
      _meta: { promptTokens: 1000, completionTokens: 50, cachedTokens: 800 }
    }
  }
};

function run(finalUsage: boolean) {
  const events: Array<Record<string, unknown>> = [];
  const writer = { append: (e: Record<string, unknown>) => { events.push(e); }, finish: () => { } } as unknown as RunV1Writer;
  const adapter = new StandardAcpRunV1Adapter(writer, 'glm-5.3-flash', false);
  adapter.start('s');
  adapter.consume(update);
  if (finalUsage) adapter.result({ usage: { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800 } });
  adapter.finish(1);
  return events.filter((e) => e.type === 'usage');
}

test('an interrupted turn still records the streamed usage once', () => {
  expect(run(false)).toEqual([{ type: 'usage', scope: 'incremental', inputTokens: 200, outputTokens: 50, cachedInputTokens: 800 }]);
});

test('a finished turn records only the final response usage', () => {
  expect(run(true)).toHaveLength(1);
});

test('input already excluding cache reads (Antigravity) is not reduced again', () => {
  const events: Array<Record<string, unknown>> = [];
  const writer = { append: (e: Record<string, unknown>) => { events.push(e); }, finish: () => { } } as unknown as RunV1Writer;
  const adapter = new StandardAcpRunV1Adapter(writer, 'gemini-4-hydrogen-low', true);
  adapter.start('s');
  // Captured from a warm Antigravity CLI turn: total = input + cached + output.
  adapter.result({ usage: { inputTokens: 2238, outputTokens: 27, cachedReadTokens: 26618, cachedWriteTokens: 0, thoughtTokens: 14, totalTokens: 28883 } });
  expect(events.filter((e) => e.type === 'usage')).toEqual([{
    type: 'usage', scope: 'incremental',
    inputTokens: 2238, outputTokens: 27, cachedInputTokens: 26618, reasoningOutputTokens: 14
  }]);
});

test('a prompt that made many model calls reports the context the agent states, with unchanged totals', () => {
  const events: Array<Record<string, unknown>> = [];
  const writer = { append: (e: Record<string, unknown>) => { events.push(e); }, finish: () => { } } as unknown as RunV1Writer;
  const adapter = new StandardAcpRunV1Adapter(writer, 'gemini-4-hydrogen-high', true);
  adapter.start('s');
  // Captured from Antigravity CLI: 134k tokens in context, read again by each call of the prompt.
  adapter.consume({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', used: 134239, size: 1048576 } } });
  adapter.result({ usage: { inputTokens: 62789, outputTokens: 20417, cachedReadTokens: 1686784, cachedWriteTokens: 0, thoughtTokens: 1816, totalTokens: 1769990 } });
  const usage = events.filter((e) => e.type === 'usage');
  const sum = (name: string) => usage.reduce((total, e) => total + (Number(e[name]) || 0), 0);
  // Board reads context occupancy from the last entry's input and cache reads.
  expect(Number(usage.at(-1)!.inputTokens) + Number(usage.at(-1)!.cachedInputTokens)).toBe(134239);
  expect([sum('inputTokens'), sum('cachedInputTokens'), sum('outputTokens'), sum('reasoningOutputTokens')]).toEqual([62789, 1686784, 20417, 1816]);
});

function retried(newSession: boolean) {
  const events: Array<Record<string, unknown>> = [];
  const writer = { append: (e: Record<string, unknown>) => { events.push(e); }, finish: () => { } } as unknown as RunV1Writer;
  const adapter = new StandardAcpRunV1Adapter(writer, 'glm-5.3-flash', false);
  adapter.start('s');
  adapter.consume(update);
  adapter.abandonAttempt();
  if (newSession) adapter.retryInNewSession();
  // Vibe's counters are session-wide: a reloaded session starts from what the crashed attempt reached.
  const start = newSession ? { input: 0, output: 0, cached: 0 } : { input: 1000, output: 50, cached: 800 };
  adapter.consume({
    ...update, params: {
      update: {
        ...update.params.update,
        _meta: { promptTokens: start.input + 300, completionTokens: start.output + 20, cachedTokens: start.cached }
      }
    }
  });
  adapter.result({ usage: { inputTokens: start.input + 300, outputTokens: start.output + 20, cachedReadTokens: start.cached } });
  adapter.finish(0);
  return events.filter((e) => e.type === 'usage');
}

test('a retry bills only what it added to the crashed attempt\'s cumulative counters, unless a new session replaced it', () => {
  const crashed = { type: 'usage', scope: 'incremental', inputTokens: 200, outputTokens: 50, cachedInputTokens: 800 };
  const added = { type: 'usage', scope: 'incremental', inputTokens: 300, outputTokens: 20 };
  expect(retried(false)).toEqual([crashed, added]);
  // A replacement session's counters start from zero, so nothing is taken off them.
  expect(retried(true)).toEqual([crashed, added]);
});

test('a run on a restored or warm session bills only what it added to the totals the agent reported before its prompt', () => {
  const events: Array<Record<string, unknown>> = [];
  const writer = { append: (e: Record<string, unknown>) => { events.push(e); }, finish: () => { } } as unknown as RunV1Writer;
  const adapter = new StandardAcpRunV1Adapter(writer, 'glm-5.3-flash', true);
  adapter.start('s');
  const totals = (promptTokens: number) => ({
    ...update, params: {
      update: {
        ...update.params.update,
        _meta: { promptTokens, completionTokens: 70, cachedTokens: 0 }
      }
    }
  });
  // A session that already spent 1,000 input tokens reports them as it loads, ahead of the prompt.
  adapter.restored(totals(1000));
  adapter.consume(totals(1200));
  adapter.abandonAttempt();
  adapter.consume(totals(1500));
  adapter.result({ usage: { inputTokens: 1500, outputTokens: 70 } });
  adapter.finish(0);
  expect(events.filter((e) => e.type === 'usage').map((e) => e.inputTokens)).toEqual([200, 300]);
});
