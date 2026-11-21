import { describe, expect, test } from 'bun:test';
import type { RunContext } from '../contracts';
import type { RunV1Writer } from '../run-v1';
import { PiRunV1Adapter } from './v1';

function adapter() {
  const events: Record<string, any>[] = [];
  const writer = { append: (event: Record<string, any>) => events.push(event) } as unknown as RunV1Writer;
  const context = { args: { model: 'm' } } as unknown as RunContext;
  return { events, pi: new PiRunV1Adapter(writer, context) };
}

describe('PiRunV1Adapter message identity', () => {
  test('final message reuses the id its deltas were streamed under', () => {
    const { events, pi } = adapter();
    // Partial messages carry no provider id; only the final message does.
    pi.consume({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'hel' } });
    pi.consume({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'lo' } });
    pi.consume({
      type: 'message_end',
      message: { role: 'assistant', responseId: 'resp_1', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop' },
    });
    const ids = events.filter((e) => e.type === 'message_delta' || e.type === 'message').map((e) => e.id);
    expect(new Set(ids)).toEqual(new Set(['pi-message-1']));
    expect(events.filter((e) => e.type === 'message')).toHaveLength(1);
  });

  test('the next message gets a fresh id', () => {
    const { events, pi } = adapter();
    for (const [responseId, text] of [['resp_1', 'a'], ['resp_2', 'b']]) {
      pi.consume({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: text } });
      pi.consume({ type: 'message_end', message: { role: 'assistant', responseId, content: [{ type: 'text', text }], stopReason: 'stop' } });
    }
    expect(events.filter((e) => e.type === 'message').map((e) => e.id)).toEqual(['pi-message-1', 'pi-message-2']);
  });
});

describe('PiRunV1Adapter agent_end dedupe', () => {
  const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: 1700000000000 + text.length,
    usage: { input: 10, output: 5 },
    ...extra,
  });
  const counts = (events: Record<string, unknown>[]) => ({
    messages: events.filter((e) => e.type === 'message').length,
    usage: events.filter((e) => e.type === 'usage').length,
  });

  test('id-less messages ended via message_end are not re-emitted by agent_end', () => {
    const { events, pi } = adapter();
    const first = assistant('a');
    const last = assistant('bb');
    pi.consume({ type: 'message_start', message: first });
    pi.consume({ type: 'message_end', message: first });
    pi.consume({ type: 'message_start', message: last });
    pi.consume({ type: 'message_end', message: last });
    pi.consume({ type: 'agent_end', messages: [{ ...first }, { ...last }] });
    expect(counts(events)).toEqual({ messages: 2, usage: 2 });
  });

  test('a responseId that only appears on the final message does not cause a second emit', () => {
    const { events, pi } = adapter();
    pi.consume({ type: 'message_start', message: { role: 'assistant' } });
    pi.consume({ type: 'message_end', message: assistant('done', { responseId: 'resp_1' }) });
    pi.consume({ type: 'agent_end', messages: [assistant('done', { responseId: 'resp_1' })] });
    expect(counts(events)).toEqual({ messages: 1, usage: 1 });
  });
});
