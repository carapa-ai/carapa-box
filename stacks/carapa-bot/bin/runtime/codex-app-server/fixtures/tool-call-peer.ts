import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { record, string, type JsonRecord } from '../types';

const capture = process.env.FAKE_CODEX_CAPTURE!;
const mode = process.env.FAKE_CODEX_RECOVERY_MODE!;
const runDir = process.env.FAKE_CODEX_RUN_DIR!;
const markup = '<tool_call>\n<function=mcp__carapa_board__publish_app>\n<parameter=enabled>\nTrue\n</parameter>\n<parameter=targetPort>8090</parameter>\n</function>\n</tool_call>';
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let turnNumber = 0;
let scope: JsonRecord = {};
appendFileSync(capture, `${JSON.stringify({ type: 'launch' })}\n`);
const event = (method: string, params: JsonRecord) => send({ method, params: { ...scope, ...params } });
const finish = (status = 'completed', items: unknown[] = [], error?: unknown) => {
  event('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } });
  event('turn/completed', { turn: { id: scope.turnId, status, items, error } });
};
const text = (content: string, suffix = '') => {
  const item = { type: 'agentMessage', id: `message-${turnNumber}${suffix}`, text: content };
  event('item/agentMessage/delta', { itemId: item.id, delta: content.slice(0, 8) });
  event('item/agentMessage/delta', { itemId: item.id, delta: content.slice(8) });
  event('item/completed', { item });
};
const publish = () => {
  const item = { type: 'mcpToolCall', id: `publish-${turnNumber}`, server: 'carapa-board', tool: 'publish_app', arguments: { enabled: true, targetPort: 8090 } };
  event('item/started', { item: { ...item, status: 'inProgress' } });
  event('item/completed', { item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: '{"ready":true}' }] } } });
};

// Delay between a late previous-turn completion and the new turn's own events.
const lateGapMs = Number(process.env.FAKE_CODEX_LATE_GAP_MS || 0);
// 'before' puts that completion ahead of the turn/start response.
const lateBeforeResponse = process.env.FAKE_CODEX_LATE_ORDER === 'before';
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  appendFileSync(capture, `${JSON.stringify({ type: 'request', message })}\n`);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId || 'thread-recovery' } } });
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    finish('interrupted');
  }
  if (message.method !== 'turn/start') return;
  const previousScope = scope;
  scope = { threadId: message.params.threadId, turnId: `turn-${++turnNumber}` };
  const accepted = { id: message.id, result: { turn: { id: scope.turnId } } };
  // Late events must not terminate a correction or count as its output.
  if (turnNumber > 1) {
    const lateCompletion = { method: 'turn/completed', params: { ...previousScope, turn: { id: previousScope.turnId, status: lateGapMs ? 'completed' : 'failed' } } };
    if (lateGapMs) {
      // One write puts the response and the late completion in the same runner read.
      const lines = lateBeforeResponse ? [lateCompletion, accepted] : [accepted, lateCompletion];
      process.stdout.write(lines.map((value) => `${JSON.stringify(value)}\n`).join(''));
      await Bun.sleep(lateGapMs);
    } else {
      send(accepted);
      send(lateCompletion);
    }
    send({ method: 'item/completed', params: { ...previousScope, item: { type: 'agentMessage', id: 'stale', text: markup } } });
  } else {
    send(accepted);
  }
  event('turn/started', { turn: { id: scope.turnId } });
  send({ method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'child', text: markup } } });
  const correction = string(record(message.params.input[0]).text).startsWith('Tool protocol correction:');
  if (mode === 'fallback' && message.params.model === 'gpt-test') {
    event('error', { message: 'model at capacity' });
    finish('failed');
    return;
  }
  if (mode === 'failed-without-text' || (correction && mode === 'failed-correction')) {
    const error = { message: 'invalid_assistant_history: reasoning cannot follow assistant message content' };
    event('error', { error, willRetry: false });
    finish('failed', [], error);
    return;
  }
  if (correction && !['always', 'interrupt-recovery', 'failed-repeat'].includes(mode)) {
    appendFileSync(capture, `${JSON.stringify({ type: 'control-during-recovery', state: JSON.parse(readFileSync(join(runDir, 'codex-control.json'), 'utf8')).state })}\n`);
    // The correction must preserve an action that already really executed.
    if (mode !== 'actual') publish();
    text('App published.');
    finish();
    return;
  }
  if (!correction) {
    event('item/started', { item: { type: 'commandExecution', id: `shell-${turnNumber}`, command: 'check-app' } });
    event('item/completed', { item: { type: 'commandExecution', id: `shell-${turnNumber}`, command: 'check-app', exitCode: 0, aggregatedOutput: 'App is listening.' } });
  }
  if (mode === 'snapshot') {
    finish('completed', [{ type: 'agentMessage', id: `message-${turnNumber}`, text: markup }]);
    return;
  }
  text(mode === 'quoted' ? `Example:\n\`\`\`xml\n${markup}\n\`\`\`` : markup);
  if (mode === 'actual') publish();
  if (['completed-after-check', 'failed-after-check', 'failed-correction', 'failed-repeat'].includes(mode)) {
    event('error', { error: { message: 'Reconnecting... 1/5', additionalDetails: 'Incomplete response returned, reason: max_output_tokens' }, willRetry: true });
    text('The output was truncated in display — let me verify the file was written completely.', '-check');
    const check = { type: 'commandExecution', id: `check-${turnNumber}`, command: 'wc -l games/ufo-strike/index.html; tail -5 games/ufo-strike/index.html' };
    event('item/started', { item: { ...check, status: 'inProgress' } });
    event('item/completed', { item: { ...check, status: 'failed', exitCode: 1, aggregatedOutput: 'No such file or directory' } });
    if (mode !== 'completed-after-check') {
      const error = { message: 'invalid_assistant_history: reasoning cannot follow assistant message content' };
      event('error', { error, willRetry: false });
      finish('failed', [], error);
      return;
    }
  }
  if (mode === 'interrupt-between') {
    writeFileSync(join(runDir, 'turn_interrupt'), 'requested');
    writeFileSync(join(runDir, 'control-requests', 'interrupt.json'), JSON.stringify({ action: 'interrupt' }));
  }
  if (correction && mode === 'interrupt-recovery') return;
  finish(mode === 'interrupted' || mode === 'failed' ? mode : 'completed');
});
process.on('SIGTERM', () => process.exit(0));
