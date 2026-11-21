import { expect, test } from 'bun:test';
import { ToolCallRecovery, TOOL_CALL_CORRECTION, TOOL_CALL_CORRECTION_FAILURE } from './tool-call-recovery';

const call = '<tool_call><function=write><parameter=content>unfinished';
test('shared recovery keeps pending text through tools and settles only on correction', () => {
  const recovery = new ToolCallRecovery();
  recovery.consume({ type: 'message_delta', id: 'a', role: 'assistant', delta: call });
  expect(recovery.needed()).toBe(true);
  recovery.consume({ type: 'tool_call', id: 'tool', status: 'completed', output: call });
  recovery.consume({ type: 'message', id: 'a', role: 'assistant', content: call, status: 'completed' });
  expect(recovery.needed()).toBe(true);
  recovery.consume({ type: 'message_delta', id: 'a', role: 'assistant', delta: `\n${call}` });
  expect(recovery.needed()).toBe(true);
  expect(recovery.next()).toBe(TOOL_CALL_CORRECTION);
  expect(recovery.needed()).toBe(false);
  recovery.consume({ type: 'message', id: 'a', role: 'assistant', content: `${call}\n${call}`, status: 'completed' });
  expect(recovery.needed()).toBe(false);
  recovery.consume({ type: 'message', id: 'b', role: 'assistant', content: `\`\`\`xml\n${call}\n\`\`\``, status: 'completed' });
  recovery.consume({ type: 'thought_delta', id: 'thought', delta: call });
  expect(recovery.needed()).toBe(false);
  recovery.consume({ type: 'message_delta', id: 'c', role: 'assistant', delta: call.slice(0, 8) });
  recovery.consume({ type: 'message_delta', id: 'c', role: 'assistant', delta: call.slice(8) });
  expect(recovery.needed()).toBe(true);
  expect(() => recovery.next()).toThrow(TOOL_CALL_CORRECTION_FAILURE);
});


test.each(['started', 'completed', 'failed'] as const)('a %s tool cannot settle a printed call', (status) => {
  const recovery = new ToolCallRecovery();
  recovery.consume({ type: 'message', id: 'write', role: 'assistant', content: call, status: 'completed' });
  recovery.consume({ type: 'tool_call', id: 'check', name: 'bash', status, output: 'No such file' });
  recovery.consume({ type: 'interaction', id: 'question', status: 'answered' });
  recovery.consume({ type: 'message', id: 'check-message', role: 'assistant', content: 'Checking the file.', status: 'completed' });
  expect(recovery.needed()).toBe(true);
});

test('suppressed (subagent) output never requests a correction', () => {
  const recovery = new ToolCallRecovery();
  recovery.suppress(() => recovery.consume({ type: 'message', id: 'sub', role: 'assistant', content: call, status: 'completed' }));
  expect(recovery.needed()).toBe(false);
  recovery.consume({ type: 'message', id: 'main', role: 'assistant', content: call, status: 'completed' });
  expect(recovery.needed()).toBe(true);
});
