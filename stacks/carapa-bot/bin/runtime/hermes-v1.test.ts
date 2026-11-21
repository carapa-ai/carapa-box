import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesAcpRunV1Adapter } from './hermes-v1';
import { RunV1Writer } from './run-v1';

test('projects Hermes ACP messages and resolved model metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-hermes-v1-'));
  const adapter = new HermesAcpRunV1Adapter(
    new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'hermes-acp', requestedModel: 'auto' }),
    'auto', false, 'hermes-acp-run-1-message-1',
  );
  adapter.start('hermes-session');
  adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'session_info_update', _meta: { upstreamModel: 'poolside/laguna-s-2.1:free' } } } });
  adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
  adapter.finish(0);
  const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events).toContainEqual({ type: 'run', status: 'in_progress', model: 'poolside/laguna-s-2.1:free' });
  expect(events).toContainEqual({ type: 'message', id: 'hermes-acp-run-1-message-1', role: 'assistant', content: 'hello', format: 'markdown', status: 'completed' });
  expect(events.at(-1)).toEqual({ type: 'run', status: 'completed', stopReason: 'end_turn' });
});
