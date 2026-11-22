import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunV1Adapter } from './claude-v1';
import { RunV1Writer } from './run-v1';

describe('Claude V1 adapter', () => {
  test('streams partial Claude text and closes it with the completed assistant message', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-v1-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'sonnet' }), 'sonnet', false);
      adapter.consume({ type: 'stream_event', session_id: 'claude-session', event: { type: 'message_start', message: { id: 'assistant-1', model: 'claude-sonnet' } } });
      adapter.consume({ type: 'stream_event', session_id: 'claude-session', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } });
      adapter.consume({ type: 'stream_event', session_id: 'claude-session', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' on it' } } });
      adapter.consume({ type: 'assistant', session_id: 'claude-session', message: { id: 'assistant-1', model: 'claude-sonnet', content: [{ type: 'text', text: 'Working on it' }] } });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.type === 'message_delta')).toEqual([
        { type: 'message_delta', id: 'assistant-1', role: 'assistant', delta: 'Working' },
        { type: 'message_delta', id: 'assistant-1', role: 'assistant', delta: ' on it' },
      ]);
      expect(events.find(event => event.type === 'message')).toMatchObject({ id: 'assistant-1', content: 'Working on it', status: 'completed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('emits a full delta when Claude provides only a completed assistant envelope', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-v1-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'sonnet' }), 'sonnet', false);
      adapter.consume({ type: 'assistant', session_id: 'claude-session', message: { id: 'assistant-1', content: [{ type: 'text', text: 'Visible before the tool' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }] } });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.type)).toEqual(['session', 'run', 'message_delta', 'message', 'tool_call', 'tool_call', 'run']);
      expect(events[2]).toEqual({ type: 'message_delta', id: 'assistant-1', role: 'assistant', delta: 'Visible before the tool' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('categorises Claude tools by name word, with mcp__ tools always mcp', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-v1-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'sonnet' }), 'sonnet', false);
      const names = ['ToolSearch', 'mcp__carapa-board__list_tasks', 'mcp__carapa-board__read_knowledge_document', 'Read', 'LS', 'Bash', 'MultiEdit', 'Grep'];
      adapter.consume({ type: 'assistant', session_id: 'claude-session', message: { id: 'assistant-1', content: names.map((name, index) => ({ type: 'tool_use', id: `tool-${index}`, name, input: {} })) } });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const categories = Object.fromEntries(events.filter(event => event.type === 'tool_call' && event.status === 'started').map(event => [event.name, event.category]));
      expect(categories).toEqual({
        ToolSearch: 'search',
        'mcp__carapa-board__list_tasks': 'mcp',
        'mcp__carapa-board__read_knowledge_document': 'mcp',
        Read: 'read',
        LS: 'read',
        Bash: 'execute',
        MultiEdit: 'edit',
        Grep: 'search',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('projects AskUserQuestion as an interaction lifecycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-v1-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'sonnet' }), 'sonnet', false);
      adapter.consume({ type: 'system', subtype: 'init', session_id: 'claude-session' });
      adapter.consume({ type: 'assistant', message: { id: 'assistant-1', model: 'claude-sonnet', content: [{ type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: { questions: [{ header: 'Choice', question: 'Continue?', multiSelect: true, options: [{ label: 'Yes', description: 'Continue', preview: 'ok  |  next' }, { label: 'No', description: 'Stop' }] }] } }] } });
      adapter.consume({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'question-1', content: [{ type: 'text', text: 'Yes' }] }] } });
      adapter.consume({ type: 'result', session_id: 'claude-session', result: 'done' });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'interaction', id: 'question-1', status: 'requested',
          questions: [expect.objectContaining({ multiSelect: true, options: [{ label: 'Yes', description: 'Continue', preview: 'ok  |  next' }, { label: 'No', description: 'Stop' }] })],
        }),
        { type: 'interaction', id: 'question-1', status: 'answered' },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('merges same-id assistant segments so a text follow-up survives a thinking lead segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-v1-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'qwen3.8' }), 'qwen3.8', false);
      adapter.consume({ type: 'system', subtype: 'init', session_id: 'ninfer-session' });
      // A --preserve-thinking backend splits one provider message into two
      // same-id assistant events: the thinking segment, then the text segment.
      adapter.consume({ type: 'assistant', message: { id: 'msg-1', model: 'qwen3.8', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'thinking', thinking: 'reasoning' }] } });
      adapter.consume({ type: 'assistant', message: { id: 'msg-1', model: 'qwen3.8', usage: { input_tokens: 100, output_tokens: 40 }, content: [{ type: 'text', text: 'Hello from the sandbox' }] } });
      adapter.consume({ type: 'result', session_id: 'ninfer-session', result: 'Hello from the sandbox' });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const kinds = events.map((event: { type: string }) => event.type);
      // The thinking lead segment must not swallow the text follow-up.
      expect(events.find((event: { type: string }) => event.type === 'message')?.content).toBe('Hello from the sandbox');
      expect(events.find((event: { type: string }) => event.type === 'thought')?.content).toBe('reasoning');
      expect(kinds.filter((type: string) => type === 'message')).toHaveLength(1);
      expect(kinds.filter((type: string) => type === 'usage')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


test('Claude final usage replaces preliminary same-message snapshots without counting resumed model totals', () => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-claude-usage-'));
  try {
    const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'opus' }), 'opus', true);
    const usage = { input_tokens: 4, cache_creation_input_tokens: 9435, cache_read_input_tokens: 42410, output_tokens: 2 };
    adapter.consume({ type: 'assistant', message: { id: 'msg-1', usage, content: [] } });
    adapter.consume({ type: 'assistant', message: { id: 'msg-1', usage: { ...usage, output_tokens: 3 }, content: [] } });
    adapter.consume({ type: 'result', usage: { ...usage, output_tokens: 25, output_tokens_details: { thinking_tokens: 10 } }, modelUsage: { opus: { inputTokens: 6, outputTokens: 67, cacheCreationInputTokens: 60823 } } });
    adapter.finish(0);
    const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'usage');
    expect(events).toEqual([
      { type: 'usage', scope: 'incremental', inputTokens: 4, outputTokens: 3, cachedInputTokens: 42410, cacheWriteInputTokens: 9435 },
      { type: 'usage', scope: 'cumulative', inputTokens: 4, outputTokens: 25, reasoningOutputTokens: 10, cachedInputTokens: 42410, cacheWriteInputTokens: 9435 },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude final usage reports the cache lifetime of the latest request that wrote the cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-claude-cache-ttl-'));
  try {
    const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'opus' }), 'opus', true);
    const usage = { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 };
    adapter.consume({ type: 'assistant', message: { id: 'msg-1', usage: { ...usage, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 } }, content: [] } });
    // A later request that only read the cache keeps the lifetime set by the last write.
    adapter.consume({ type: 'assistant', message: { id: 'msg-2', usage: { ...usage, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }, content: [] } });
    adapter.consume({ type: 'result', usage: { ...usage, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 } } });
    adapter.finish(0);
    const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'usage');
    expect(events.at(-1)).toMatchObject({ scope: 'cumulative', cacheTtlSeconds: 3600 });
    expect(events.filter(event => event.scope === 'incremental').every(event => !('cacheTtlSeconds' in event))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted Claude terminal keeps the runtime error it was given but never the remembered result text', () => {
  const finished = (error?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-claude-interrupted-'));
    try {
      const adapter = new ClaudeRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'claude', requestedModel: 'opus' }), 'opus', false);
      adapter.consume({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['provider text'], session_id: 'claude-session' });
      adapter.finish(1, true, error);
      return readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  expect(finished('Claude stream-json process disconnected')).toMatchObject({ status: 'interrupted', error: { message: 'Claude stream-json process disconnected' } });
  expect(finished()).not.toHaveProperty('error');
});
