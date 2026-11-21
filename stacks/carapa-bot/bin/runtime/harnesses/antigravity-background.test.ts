import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityBackground } from './antigravity-background';

const root = mkdtempSync(join(tmpdir(), 'carapa-antigravity-background-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const logs = (id: string) => join(root, 'antigravity-cli', 'brain', id, '.system_generated');
function step(id: string, file: string, value: Record<string, unknown>): void {
  mkdirSync(join(logs(id), 'logs'), { recursive: true });
  appendFileSync(join(logs(id), 'logs', file), `${JSON.stringify({ status: 'DONE', created_at: '2026-11-15T19:13:05Z', ...value })}\n`);
}
const kinds = (updates: Array<Record<string, any>>) => updates.map(message => message.params.update.sessionUpdate);
const chunk = (kind: string) => ({ method: 'session/update', params: { update: { sessionUpdate: kind } } });

describe('Antigravity background work', () => {
  test('shows sub-agents and the turns they start, bills sub-agents once, and drops the later replay', () => {
    const sessionDir = join(root, 'session');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(logs('main'), 'subagents'), { recursive: true });
    writeFileSync(join(logs('main'), 'subagents', 'sub.json'), JSON.stringify({
      conversationId: 'sub', subagentDescriptor: { typeName: 'research', role: 'Bug Auditor' }, state: 'SUBAGENT_STATE_ALIVE',
    }));
    // The prompt's own turn: reported over ACP, so never shown from the log.
    step('main', 'transcript_full.jsonl', { step_index: 0, type: 'PLANNER_RESPONSE', content: 'Auditors are running.', input_tokens: 9, output_tokens: 9 });
    step('sub', 'transcript.jsonl', { step_index: 0, type: 'SYSTEM_MESSAGE', content: 'task' });
    step('sub', 'transcript.jsonl', { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: {} }], input_tokens: 100, cache_read_tokens: 1_000, output_tokens: 10 });

    const background = new AntigravityBackground(root, 'main', sessionDir, 60_000);
    const first = background.poll(true);
    expect(first).toMatchObject({ busy: true, updates: [], tasks: [{ id: 'sub', description: 'Bug Auditor' }] });
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedReadTokens: 1_000, totalTokens: 1_110 });

    // The sub-agent reports and stops; the main agent runs a turn of its own.
    step('sub', 'transcript.jsonl', { step_index: 2, type: 'GENERIC', content: 'file' });
    step('sub', 'transcript.jsonl', { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Sent report.', input_tokens: 5, output_tokens: 1 });
    step('main', 'transcript_full.jsonl', { step_index: 1, type: 'SYSTEM_MESSAGE', content: 'report' });
    step('main', 'transcript_full.jsonl', { step_index: 2, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ledger add' } }], input_tokens: 7, output_tokens: 7 });
    const working = background.poll(false);
    expect(working).toMatchObject({ busy: true, tasks: [] });
    expect(kinds(working.updates)).toEqual(['tool_call']);
    // The main agent's own tokens arrive with the next prompt's result.
    expect(working.usage).toEqual({ inputTokens: 5, outputTokens: 1, cachedReadTokens: 0, totalTokens: 6 });

    step('main', 'transcript_full.jsonl', { step_index: 3, type: 'GENERIC', status: 'ERROR', content: 'Created At: now\nCompleted At: now\nfailed' });
    step('main', 'transcript_full.jsonl', { step_index: 4, type: 'PLANNER_RESPONSE', content: 'Recorded.' });
    const done = background.poll(false);
    expect(done.busy).toBe(false);
    expect(done.usage).toBeUndefined();
    expect(done.updates.map(message => (message.params as any).update)).toMatchObject([
      { sessionUpdate: 'tool_call_update', status: 'failed', rawOutput: 'failed' },
      { sessionUpdate: 'agent_message_chunk', content: { text: '\n\nRecorded.' } },
    ]);

    // A later run of the same conversation: the next prompt replays what was shown.
    const next = new AntigravityBackground(root, 'main', sessionDir, 60_000);
    expect(['tool_call', 'agent_message_chunk', 'tool_call', 'user_message_chunk', 'agent_message_chunk'].map(kind => next.replayed(chunk(kind))))
      .toEqual([true, true, false, false, false]);
    expect(next.poll(true)).toMatchObject({ busy: false, tasks: [], updates: [] });
    expect(next.poll(true).usage).toBeUndefined();
  });

  test('gives up on a sub-agent that stopped writing mid-step', async () => {
    const sessionDir = join(root, 'stalled-session');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(logs('stalled'), 'subagents'), { recursive: true });
    writeFileSync(join(logs('stalled'), 'subagents', 'hung.json'), JSON.stringify({ conversationId: 'hung', state: 'SUBAGENT_STATE_ALIVE' }));
    step('hung', 'transcript.jsonl', { step_index: 0, type: 'SYSTEM_MESSAGE', content: 'task' });
    const background = new AntigravityBackground(root, 'stalled', sessionDir, 30);
    expect(background.poll(true).busy).toBe(true);
    await Bun.sleep(40);
    expect(background.poll(false)).toMatchObject({ busy: false, tasks: [] });
    // The next prompt of the same conversation does not wait the idle limit for it again.
    expect(new AntigravityBackground(root, 'stalled', sessionDir, 30).poll(true)).toMatchObject({ busy: false, tasks: [] });
  });
});
