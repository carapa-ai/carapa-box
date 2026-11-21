import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgySdkRunV1Adapter } from './agy-sdk-v1';
import { RunV1Writer } from './run-v1';

describe('Antigravity SDK V1 adapter', () => {
  test('projects SDK events into one canonical run', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-agy-sdk-v1-'));
    try {
      const adapter = new AgySdkRunV1Adapter(
        new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'agy-sdk', requestedModel: 'gemini-2.5-pro' }),
        'gemini-2.5-pro', false, 'agy-sdk-run-1-message-1',
      );
      adapter.consume({ type: 'init', session_id: 'agy-sdk-session' });
      adapter.consume({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } });
      adapter.consume({ type: 'tool_use', tool_name: 'read_file', parameters: { path: 'x' } });
      adapter.consume({ type: 'tool_use', tool_name: 'run_command', parameters: { command_line: 'echo hi' } });
      adapter.consume({ type: 'tool_result', tool_name: 'run_command', output: 'hi\n' });
      adapter.consume({ type: 'text', part: { type: 'text', text: 'answer' } });
      adapter.consume({ type: 'result', result: 'answer', is_error: false, usage: { input_tokens: 4, output_tokens: 2 } });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        { type: 'session', id: 'agy-sdk-session', status: 'started' },
        { type: 'run', status: 'started', model: 'gemini-2.5-pro' },
        { type: 'thought', id: 'agy-sdk-run-1-message-1-thought-1', content: 'thinking', format: 'text', status: 'completed' },
        { type: 'tool_call', id: 'agy-sdk-tool-1', status: 'started', name: 'read_file', category: 'other', input: { path: 'x' } },
        { type: 'tool_call', id: 'agy-sdk-tool-2', status: 'completed', output: 'hi\n' },
        { type: 'tool_call', id: 'agy-sdk-tool-1', status: 'failed', error: { message: 'No tool result was reported by agy-sdk' } },
        { type: 'usage', scope: 'cumulative', inputTokens: 4, outputTokens: 2 },
        { type: 'message', id: 'agy-sdk-run-1-message-1', role: 'assistant', content: 'answer', format: 'markdown', status: 'completed' },
        { type: 'run', status: 'completed', stopReason: 'end_turn' },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
