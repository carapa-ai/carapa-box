import { describe, expect, test } from 'bun:test';
import { ToolCallRecovery } from './tool-call-recovery';
import { hasToolCallText } from '../tool-call-recovery';

const call = '<tool_call>\n<function=mcp__carapa_board__publish_app>\n<parameter=enabled>\nTrue\n</parameter>\n<parameter=targetPort>8090</parameter>\n</function>\n</tool_call>';
const assistant = (text: string, id = 'message') => ({
  method: 'item/completed', params: { item: { type: 'agentMessage', id, text } },
});
const action = (id = 'call') => ({
  method: 'item/completed', params: { item: { type: 'mcpToolCall', id, tool: 'publish_app' } },
});

describe('unexecuted tool-call detection', () => {
  test.each([
    call,
    `Publishing now.\n\n${call}`,
    '<tool_call><function=publish_app><parameter=enabled>True',
    '<tool_call>{"name":"publish_app","arguments":{"enabled":true}}</tool_call>',
    '<tool_call>publish_app>\n<parameter=enabled>true</parameter></tool_call>',
    '<function=publish_app><parameter=enabled>true</parameter></function>',
    '<tool_use><name>publish_app</name><input><enabled>true</enabled></input></tool_use>',
  ])('recognizes attempted call %s', (text) => {
    expect(hasToolCallText(text)).toBe(true);
  });

  test.each([
    'Published successfully.',
    'The <tool_call> tag marks a call.',
    `Example: ${call.replaceAll('\n', '')}`,
    '`<tool_call><function=publish_app><parameter=enabled>true</parameter></function></tool_call>`',
    `\`\`\`xml\n${call}\n\`\`\``,
    `~~~xml\n${call}\n~~~`,
    call.split('\n').map((line) => `> ${line}`).join('\n'),
    call.split('\n').map((line) => `    ${line}`).join('\n'),
    call.split('\n').map((line) => `\t${line}`).join('\n'),
    `\`\`\`\`xml\n\`\`\`\n${call}\n\`\`\`\``,
    `~~~xml\n~~~ not a closing fence\n${call}`,
  ])('ignores ordinary prose and quoted examples %s', (text) => {
    expect(hasToolCallText(text)).toBe(false);
  });

  test('continues detecting after a closed example', () => {
    expect(hasToolCallText(`\`\`\`xml\n${call}\n\`\`\`\n${call}`)).toBe(true);
  });

  test('catches the incident even after earlier actual tools, without parsing arguments', () => {
    const recovery = new ToolCallRecovery();
    recovery.consume(action('earlier-shell-check'));
    recovery.consume(assistant(`App is listening.\n${call}`));
    expect(recovery.needed()).toBe(true);
  });

  test('keeps printed calls pending through later tools and duplicate snapshots', () => {
    const recovery = new ToolCallRecovery();
    const message = assistant(call);
    const tool = action();
    recovery.consume(message);
    recovery.consume(tool);
    recovery.consume(message); // duplicate completed message
    recovery.consume({ method: 'turn/completed', params: { turn: {
      items: [message.params.item, tool.params.item],
    } } });
    expect(recovery.needed()).toBe(true);
  });

  test('assembles split streamed markers when no completed item arrives', () => {
    const recovery = new ToolCallRecovery();
    for (const delta of [call.slice(0, 7), call.slice(7, 26), call.slice(26)]) {
      recovery.consume({ method: 'item/agentMessage/delta', params: { itemId: 'message', delta } });
    }
    expect(recovery.needed()).toBe(true);
    recovery.consume(assistant('The tool is unavailable.'));
    expect(recovery.needed()).toBe(false);
  });

  test('accepts final snapshots without losing pending streamed text', () => {
    const recovery = new ToolCallRecovery();
    recovery.consume(action());
    recovery.consume(assistant(call));
    recovery.consume({ method: 'turn/completed', params: { turn: {
      items: [action().params.item, assistant(call).params.item],
    } } });
    expect(recovery.needed()).toBe(true);

    const snapshotOnly = new ToolCallRecovery();
    snapshotOnly.consume({ method: 'turn/completed', params: { turn: { items: [assistant(call).params.item] } } });
    expect(snapshotOnly.needed()).toBe(true);
  });

  test('uses the final snapshot text for an item that only started streaming', () => {
    const recovery = new ToolCallRecovery();
    recovery.consume({ method: 'item/agentMessage/delta', params: { itemId: 'message', delta: '<tool' } });
    recovery.consume({ method: 'turn/completed', params: { turn: { items: [assistant(call).params.item] } } });
    expect(recovery.needed()).toBe(true);
  });

  test('ignores markup contained in tool output and reasoning', () => {
    const recovery = new ToolCallRecovery();
    recovery.consume({ method: 'item/completed', params: { item: { type: 'mcpToolCall', id: 'call', result: call } } });
    recovery.consume({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'reasoning', text: call } } });
    expect(recovery.needed()).toBe(false);
  });
});


test('retains the truncated write through a reconnect, failed file check, and failed turn', () => {
  const recovery = new ToolCallRecovery();
  recovery.consume(assistant('Building now.\n<tool_call>\n<function=exec_command>\n<parameter=cmd>mkdir -p games/ufo-strike && cat > games/ufo-strike/index.html'));
  recovery.consume({ method: 'error', params: { willRetry: true, error: { message: 'max_output_tokens' } } });
  recovery.consume(assistant('Let me verify the file was written completely.', 'check-message'));
  for (const [method, status] of [['item/started', 'inProgress'], ['item/completed', 'failed']]) {
    recovery.consume({ method, params: { item: { type: 'commandExecution', id: 'check', status, command: 'wc -l games/ufo-strike/index.html', exitCode: 1 } } });
    expect(recovery.needed()).toBe(true);
  }
  recovery.consume({ method: 'turn/completed', params: { turn: { status: 'failed', items: [], error: { message: 'invalid_assistant_history' } } } });
  expect(recovery.needed()).toBe(true);
});
