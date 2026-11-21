import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const mode = process.env.TEST_RECOVERY_PROTOCOL!;
const scenario = process.env.TEST_RECOVERY_SCENARIO!;
const capture = process.env.TEST_RECOVERY_CAPTURE!;
const runDir = process.env.TEST_RECOVERY_RUN_DIR!;
const call = '<tool_call><function=write><parameter=content>unfinished';
const session = 'recovery-session';
let turn = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = (value: unknown) => appendFileSync(capture, `${JSON.stringify(value)}\n`);
record({ launch: true, pid: process.pid });

function answer(prompt: string, id?: unknown): void {
  turn++;
  record({ prompt, pid: process.pid, session, id });
  const text = ['repeat', 'cancel-during'].includes(scenario) || turn === 1 ? call : 'Done using the available tools.';
  if (scenario === 'cancel') writeFileSync(join(runDir, 'turn_interrupt'), '1');
  if (turn === 2 && scenario === 'cancel-during') {
    writeFileSync(join(runDir, 'turn_interrupt'), '1');
  }
  if (mode === 'pi') {
    send({ type: 'response', id, success: true });
    if (turn === 1) {
      send({ type: 'tool_execution_start', toolCallId: 'earlier', toolName: 'bash' });
      send({ type: 'tool_execution_end', toolCallId: 'earlier', toolName: 'bash', result: { content: 'checked' } });
    }
    if (turn === 2 && scenario === 'recover') {
      send({ type: 'tool_execution_start', toolCallId: 'corrected', toolName: 'write', args: { path: 'app.html', content: 'app' } });
      send({ type: 'tool_execution_end', toolCallId: 'corrected', toolName: 'write', result: { content: 'written' } });
    }
    const message = { role: 'assistant', id: `message-${turn}`, content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 3, output: 2 } };
    send({ type: 'message_end', message });
    send({ type: 'agent_end', messages: [message], willRetry: false });
  } else if (mode === 'claude') {
    send({ type: 'system', subtype: 'init', session_id: session });
    if (turn === 2 && scenario === 'recover') {
      send({ type: 'assistant', session_id: session, message: { id: 'action', content: [{ type: 'tool_use', id: 'corrected', name: 'write', input: { path: 'app.html' } }] } });
      send({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 'corrected', content: 'written' }] } });
    }
    send({ type: 'assistant', session_id: session, message: { id: `message-${turn}`, content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', session_id: session, usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: turn * 0.01, modelUsage: { test: { inputTokens: turn * 3, outputTokens: turn * 2 } } });
  } else if (mode === 'acp') {
    if (turn === 2 && scenario === 'recover') {
      send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'tool_call', toolCallId: 'corrected', title: 'write', rawInput: { path: 'app.html' } } } });
      send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'tool_call_update', toolCallId: 'corrected', status: 'completed', rawOutput: 'written' } } });
    }
    send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (mode === 'opencode') {
    send({ type: 'step_start', sessionID: session });
    if (turn === 2 && scenario === 'recover') send({ type: 'tool_use', part: { tool: 'write', callID: 'corrected', state: { status: 'completed', input: { path: 'app.html' }, output: 'written' } } });
    send({ type: 'text', part: { text } });
    send({ type: 'step_finish', reason: 'stop', part: { tokens: { input: 3, output: 2 } } });
  } else {
    send({ type: 'init', session_id: session });
    if (turn === 2 && scenario === 'recover') send({ type: 'tool_use', tool_name: 'write', parameters: { path: 'app.html' } });
    send({ type: 'text', part: { type: 'text', text } });
    send({ type: 'result', result: text, session_id: session, usage: { input_tokens: 3, output_tokens: 2 } });
  }
}

if (mode === 'opencode') {
  if (process.argv.includes('export')) {
    send({ role: 'assistant', modelID: 'test' });
  } else {
    const args = process.argv.slice(2);
    if (args.includes('--session')) {
      if (args[args.indexOf('--session') + 1] !== session || !existsSync(join(runDir, 'native-history'))) process.exit(9);
      turn = 1;
    } else writeFileSync(join(runDir, 'native-history'), 'saved');
    answer(args.at(-1)!);
  }
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.type === 'get_state') send({ type: 'response', id: request.id, success: true, data: { sessionId: session, thinkingLevel: 'off', isStreaming: false, pendingMessageCount: 0 } });
    else if (request.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
    else if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1 } });
    else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: session } });
    else if (request.type === 'prompt') answer(request.message, request.id);
    else if (request.type === 'user') answer(request.message.content);
    else if (request.method === 'session/prompt') answer(request.params.prompt[0].text, request.id);
    else if (request.prompt) answer(request.prompt);
  }
}
