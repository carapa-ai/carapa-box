import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorAcpRunV1Adapter } from './cursor-v1';
import { RunV1Writer } from './run-v1';

describe('Cursor ACP V1 adapter', () => {
  test('projects text, thought, tool, and resolved model updates', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-cursor-v1-'));
    try {
      mkdirSync(root, { recursive: true });
      const adapter = new CursorAcpRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'cursor-acp', requestedModel: 'auto' }), 'auto', false, 'cursor-run-1-message-1');
      adapter.start('cursor-session');
      const update = (value: Record<string, unknown>) => adapter.consume({ method: 'session/update', params: { update: value } });
      update({ sessionUpdate: 'session_info_update', model: 'poolside/laguna-s-2.1:free' });
      update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'checking' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { text: 'done' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', rawInput: { command: 'pwd' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: '/tmp' });
      adapter.finish(0);
      const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        { type: 'run', status: 'in_progress', model: 'poolside/laguna-s-2.1:free' },
        { type: 'message_delta', id: 'cursor-run-1-message-1', role: 'assistant', delta: 'done' },
        { type: 'thought_delta', id: 'cursor-run-1-message-1:thought', delta: 'checking' },
        { type: 'run', status: 'completed', stopReason: 'end_turn' },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
