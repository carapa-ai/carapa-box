import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../contracts';
import { grokAcpContract } from './grok-acp';
import { RunV1Writer } from '../run-v1';

const root = mkdtempSync(join(tmpdir(), 'carapa-grok-acp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function context(args: Partial<RunContext['args']> = {}): RunContext {
  return {
    runDir: join(root, 'ipc', 'runs', 'run'), prompt: 'task', cwd: root, runTag: 'run', binDir: root,
    env: { HOME: join(root, 'home'), XAI_API_KEY: 'must-not-reach-grok' },
    args: {
      agentCmd: 'grok-acp', sessionId: '', forkSession: '', model: '', fallbackModel: '',
      reasoningEffort: '', fallbackReasoningEffort: '', chatMode: '', agent: '', bare: '',
      systemPrompt: '', workDir: '', conversationKey: 'conv-1', persistent: '', conversationId: '',
      env: {}, ...args,
    },
  };
}

test('routes Grok through the relay with a non-renewable placeholder login and no uploads', () => {
  const run = context();
  grokAcpContract.prepare!(run);
  expect(run.env.XAI_API_KEY).toBeUndefined();
  const login = Object.values(JSON.parse(readFileSync(join(run.env.GROK_HOME!, 'auth.json'), 'utf8')))[0] as Record<string, unknown>;
  expect(login).toMatchObject({ key: 'carapa-relay', oidc_issuer: 'https://auth.x.ai', coding_data_retention_opt_out: true });
  expect(login.refresh_token).toBeUndefined();
  expect(grokAcpContract.process(run).env).toMatchObject({
    GROK_CLI_CHAT_PROXY_BASE_URL: 'http://api-relay:8080/xai/v1',
    GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_MEMORY: '0', GROK_CLAUDE_MCPS_ENABLED: '0',
  });
});

test('keeps text and tool calls in streamed order and reports usage from Grok metadata', () => {
  const runDir = join(root, 'v1'); mkdirSync(runDir);
  const writer = new RunV1Writer(runDir, { format: 'carapa-run', version: 1, harness: 'grok-acp', requestedModel: 'grok-4.7' });
  const v1 = grokAcpContract.createV1!({ ...context(), runDir }, writer, false);
  const update = (value: Record<string, unknown>) => v1.consume({ method: 'session/update', params: { sessionId: 's', update: value } });
  v1.start('s');
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep', rawInput: { pattern: 'mcp' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'none' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Nothing found.' } });
  v1.result!({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 70539, outputTokens: 808, cachedReadTokens: 38528, reasoningTokens: 465 } } });
  v1.finish(0);
  const events = readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const order = events.filter((e) => e.type === 'message' || (e.type === 'tool_call' && e.status === 'started'))
    .map((e) => e.type === 'message' ? e.content : e.name);
  expect(order).toEqual(['Checking.', 'grep', 'Nothing found.']);
  expect(new Set(events.filter((e) => e.type === 'message').map((e) => e.id)).size).toBe(2);
  expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 32011, outputTokens: 808, cachedInputTokens: 38528, reasoningOutputTokens: 465 });
});
