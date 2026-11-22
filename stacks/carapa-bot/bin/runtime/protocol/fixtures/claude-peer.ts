import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
const args = process.argv.slice(2);
const capture = (value: unknown) => {
  if (process.env.TEST_PROTOCOL_TRANSCRIPT) appendFileSync(process.env.TEST_PROTOCOL_TRANSCRIPT, `${JSON.stringify(value)}\n`);
};
capture({ type: 'launch', pid: process.pid, args });
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, args.join('\n'));
const session = args.includes('--fork-session') ? randomUUID() : args.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length) || randomUUID();
const send = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
let initialized = false;
let turns = 0;
let active = false;
// Like the CLI, a user message sent mid-turn is a queued command: it is either
// absorbed by the running turn or, after its result, runs as the next turn.
const steers: Array<{ uuid: string; text: string }> = [];
let command = '';
const lifecycle = (uuid: string, state: string) => send({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: session });
const reply = (prompt: string) => send({ type: 'assistant', session_id: session, message: { id: `message-${++turns}`, content: [{ type: 'text', text: `turn ${turns}: ${prompt}` }] } });
const result = (failed = false) => {
  active = false;
  send({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, session_id: session, result: 'done',
    ...(failed ? { errors: [`No conversation found with session ID: ${session}`] } : {}), usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: turns * 0.01, modelUsage: { fixture: { inputTokens: turns, outputTokens: turns } } });
  if (command) lifecycle(command, 'completed');
  command = '';
  const next = steers.shift();
  if (!next) return;
  command = next.uuid;
  active = true;
  lifecycle(command, 'started');
  reply(next.text);
  if (!next.text.endsWith('hold')) result();
};
// Native plan mode: each tool waits for the host's can_use_tool decision.
const planTools = [
  { name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
  { name: 'Bash', input: { command: 'touch plan-probe' } },
  { name: 'ExitPlanMode', input: { plan: '# Paint plan\n\n1. Paint it.' } },
];
const permissions = new Map<string, number>();
const requestPermission = (index: number) => {
  const tool = planTools[index];
  const id = `plan-tool-${index + 1}`;
  send({ type: 'assistant', session_id: session, message: { id: `plan-message-${index + 1}`, content: [{ type: 'tool_use', id, name: tool.name, input: tool.input }] } });
  const requestId = randomUUID();
  permissions.set(requestId, index);
  send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool.name, input: tool.input, tool_use_id: id } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  capture(message);
  if (message.type === 'control_response' && permissions.has(message.response.request_id)) {
    const index = permissions.get(message.response.request_id)!;
    permissions.delete(message.response.request_id);
    const decision = message.response.response;
    send({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: `plan-tool-${index + 1}`, is_error: decision.behavior !== 'allow', content: JSON.stringify(decision) }] } });
    if (index + 1 < planTools.length) requestPermission(index + 1);
    else result();
    return;
  }
  if (message.type === 'control_request') {
    if (message.request.subtype === process.env.TEST_CLAUDE_REJECT_CONTROL) {
      send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'fixture rejection' } });
      return;
    }
    if (message.request.subtype === 'initialize') initialized = true;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.request.subtype === 'interrupt' && active) result();
    if (message.request.subtype === 'stop_task') {
      send({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: session });
      active = true; reply('task stopped'); result();
    }
    return;
  }
  if (message.type !== 'user') return;
  if (!initialized || !args.includes('--input-format') || !args.includes('stream-json')) process.exit(9);
  const prompt = message.message.content;
  if (active) {
    lifecycle(message.uuid, 'queued');
    if (!prompt.startsWith('absorb')) { steers.push({ uuid: message.uuid, text: prompt }); return; }
    lifecycle(message.uuid, 'started');
    reply(prompt);
    lifecycle(message.uuid, 'completed');
    result();
    return;
  }
  if (prompt === 'stale-result') {
    // A stopped background task's notification turn runs before the queued prompt.
    lifecycle(message.uuid, 'queued');
    send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: '', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });
    setTimeout(() => { lifecycle(message.uuid, 'started'); active = true; reply(prompt); result(); }, 100);
    return;
  }
  active = true;
  if (process.env.FAKE_PROMPT_FILE) writeFileSync(process.env.FAKE_PROMPT_FILE, prompt);
  // Only the first turn emits init: warm adapters must not depend on a repeated init.
  if (turns === 0) send({ type: 'system', subtype: 'init', session_id: session, ...(process.env.TEST_CLAUDE_SLASH_COMMANDS ? { slash_commands: JSON.parse(process.env.TEST_CLAUDE_SLASH_COMMANDS) } : {}) });
  reply(prompt);
  if (prompt === 'slow') { setTimeout(() => result(), 300); return; }
  if (prompt === 'crash') { process.stderr.write(`No conversation found with session ID: ${session}\n`); setTimeout(() => process.exit(7), 50); return; }
  if (prompt === 'hold') return;
  if (prompt === 'plan') { requestPermission(0); return; }
  if (prompt === 'hidden-turn') {
    // Another turn the host was not told about starts right behind the result and holds.
    result();
    active = true; reply('hidden turn');
    return;
  }
  if (prompt.startsWith('background')) {
    // The turn ends while an agent runs on; its completion later starts another turn.
    const tasks = (list: object[]) => send({ type: 'system', subtype: 'background_tasks_changed', tasks: list, session_id: session });
    tasks([{ task_id: 'agent-1', task_type: 'local_agent', description: 'Fixture agent' }]);
    if (prompt === 'background-now') {
      // The notification turn is already in the journal right behind the prompt's result.
      tasks([]);
      result();
      active = true; reply('task notified'); result();
      return;
    }
    if (prompt === 'background-two') {
      // Two tasks finish during the turn; each one's notification turn follows the result.
      const agent = (id: string) => ({ task_id: id, task_type: 'local_agent', description: id });
      tasks([agent('agent-1'), agent('agent-2')]);
      setTimeout(() => tasks([agent('agent-2')]), 40);
      setTimeout(() => tasks([]), 80);
      setTimeout(() => {
        result();
        setTimeout(() => { active = true; reply('task notified'); result(); }, 100);
        setTimeout(() => { active = true; reply('task notified'); result(); }, 300);
      }, 120);
      return;
    }
    if (prompt === 'background-slow') {
      // The task finishes while the turn runs; the notification turn follows the result.
      tasks([]);
      setTimeout(() => { result(); setTimeout(() => { active = true; reply('task notified'); result(); }, 200); }, 300);
      return;
    }
    if (prompt === 'background-early') {
      // The task finishes before the turn's result; its notification turn follows it.
      tasks([]);
      result();
      setTimeout(() => { active = true; reply('task notified'); result(); }, 200);
      return;
    }
    result();
    if (prompt === 'background') setTimeout(() => {
      send({ type: 'assistant', session_id: session, parent_tool_use_id: 'agent-call', message: { id: 'sub-message', content: [{ type: 'text', text: 'sub-agent chatter' }] } });
      tasks([]); active = true; reply('agent done'); result();
    }, 200);
    return;
  }
  result(prompt === 'fail');
});
