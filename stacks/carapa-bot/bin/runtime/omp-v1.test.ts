import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { OmpAcpRunV1Adapter } from './omp-v1';
import { RunV1Writer } from './run-v1';

describe('OMP V1 normalization', () => {
  test('normalizes the configured omp harness ACP updates, without persisting ACP reasoning', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'omp-acp-v1-'));
    const adapter = new OmpAcpRunV1Adapter(
      new RunV1Writer(runDir, {
        format: 'carapa-run', version: 1, harness: 'omp-acp', requestedModel: 'model',
      }),
      'model',
      false,
      'omp-acp-run-1-message-1',
    );
    adapter.start('omp-session-1');
    adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'session_info_update', _meta: { upstreamModel: 'poolside/laguna-s-2.1:free' } } } });
    adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } } } });
    adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Visible' } } } });
    adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', rawInput: { command: 'true' } } } });
    adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'ok' } } });
    adapter.finish(0);
    const events = readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toContainEqual({ type: 'message_delta', id: 'omp-acp-run-1-message-1', role: 'assistant', delta: 'Visible' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', id: 'tool-1', status: 'completed', output: 'ok' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', content: 'Visible', status: 'completed' }));
    expect(events).toContainEqual({ type: 'run', status: 'in_progress', model: 'poolside/laguna-s-2.1:free' });
    expect(JSON.stringify(events)).not.toContain('private reasoning');
    expect(events.at(-1)).toEqual({ type: 'run', status: 'completed', stopReason: 'end_turn' });
  });
});
