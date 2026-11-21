import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrimeAgentRunV1Adapter } from './prime-agent-v1';
import { RunV1Writer } from './run-v1';

test('projects Prime Agent ACP events with a per-run message identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'carapa-prime-agent-v1-'));
  const adapter = new PrimeAgentRunV1Adapter(new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'prime-agent-acp', requestedModel: 'freeapi/auto' }), 'freeapi/auto', false, 'prime-agent-run-1-message-1');
  adapter.start('prime-session');
  adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'session_info_update', model: 'poolside/laguna-s-2.1:free' } } });
  adapter.consume({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
  adapter.finish(0);
  const events = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events).toContainEqual({ type: 'run', status: 'in_progress', model: 'poolside/laguna-s-2.1:free' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'message_delta', id: 'prime-agent-run-1-message-1' }));
  expect(events.at(-1)).toEqual({ type: 'run', status: 'completed', stopReason: 'end_turn' });
});
