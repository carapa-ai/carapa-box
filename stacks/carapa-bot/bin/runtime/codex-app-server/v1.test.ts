import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunV1Writer, type CarapaRunEventV1 } from '../run-v1';
import { createPlanRenderer } from './plans';
import type { CodexRunnerArgs, RpcMessage } from './types';
import { CodexRunV1Adapter } from './v1';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carapa-codex-v1-'));
  roots.push(root);
  const args: CodexRunnerArgs = {
    sessionId: '', model: 'gpt-test', fallbackModel: '', reasoningEffort: 'high',
    fallbackReasoningEffort: '', chatMode: 'plan', systemPrompt: '', groupDir: root, env: {},
  };
  const renderPlan = createPlanRenderer(args);
  const writer = new RunV1Writer(root, {
    format: 'carapa-run', version: 1, harness: 'codex', requestedModel: args.model,
  });
  const adapter = new CodexRunV1Adapter(writer, args, renderPlan);
  adapter.beginTurn(args.model, args.reasoningEffort);
  const events = (): CarapaRunEventV1[] => readFileSync(writer.eventPath, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  return { root, args, renderPlan, adapter, events };
}

const delta = (text: string): RpcMessage => ({
  method: 'item/plan/delta', params: { itemId: 'native-plan', delta: text },
});
const complete = (text?: string): RpcMessage => ({
  method: 'item/completed', params: { item: { type: 'plan', id: 'native-plan', text } },
});

describe('Codex V1 native plans', () => {
  test('preserves the final answer and artifact after commentary and a successful tool', () => {
    const value = fixture();
    value.adapter.consume({ method: 'item/completed', params: {
      item: { type: 'agentMessage', id: 'commentary', text: 'I will refine the plan.' },
    } });
    value.adapter.consume({ method: 'item/started', params: {
      item: { type: 'commandExecution', id: 'read', command: 'cat source.ts' },
    } });
    value.adapter.consume({ method: 'item/completed', params: {
      item: { type: 'commandExecution', id: 'read', exitCode: 0, aggregatedOutput: 'source' },
    } });
    value.adapter.consume(delta('# Search history\n\n'));
    value.adapter.consume(delta('Index archived transcripts.'));
    expect(value.events().filter((event) => event.type === 'message_delta')).toHaveLength(2);
    const text = '# Search history\n\nIndex archived transcripts.';
    const completion = complete(text);
    value.adapter.consume(completion);
    value.adapter.consume(completion);
    value.adapter.consume(delta('late duplicate'));
    value.adapter.consume({ method: 'turn/completed', params: {
      turn: { status: 'completed', error: null },
    } });
    value.adapter.finish();
    const messages = value.events().filter((event) => event.type === 'message');
    expect(messages.map((event) => event.id)).toEqual(['commentary', 'native-plan']);
    const answer = messages[1];
    expect(answer.status).toBe('completed');
    expect(answer.content).toStartWith(text);
    const card = JSON.parse(answer.content.match(/```carapaplan\n([^\n]+)/)![1]);
    expect(card.planText).toBe(text);
    expect(readFileSync(join(value.root, card.artifactPath), 'utf8')).toBe(`${text}\n`);
    expect(JSON.parse(readFileSync(join(value.root, `${card.artifactPath}.meta.json`), 'utf8')))
      .toEqual({ source: 'agent' });
    expect(readdirSync(join(value.root, 'artifacts', 'plans'))).toHaveLength(2);
    expect(value.events().filter((event) => event.type === 'message_delta')).toHaveLength(2);
    expect(value.events().at(-1)).toMatchObject({ type: 'run', status: 'completed' });
  });

  test('keeps the provider error extras on the error event and the failed terminal', () => {
    const value = fixture();
    value.adapter.consume({ method: 'error', params: { willRetry: true, error: { message: 'retrying' } } });
    value.adapter.consume({ method: 'error', params: { willRetry: false, error: { message: 'x', additionalDetails: 'invalid_encrypted_content', codexErrorInfo: 'other' } } });
    value.adapter.finish();
    const events = value.events();
    expect(events.find((event) => event.type === 'error' && event.message === 'retrying')).not.toHaveProperty('details');
    expect(events.at(-2)).toMatchObject({ type: 'error', message: 'x', fatal: true, details: { additionalDetails: 'invalid_encrypted_content', codexErrorInfo: 'other' } });
    expect(events.at(-1)).toMatchObject({ type: 'run', status: 'failed', error: { message: 'x', details: { additionalDetails: 'invalid_encrypted_content' } } });
  });

  test('accepts a completed plan without deltas', () => {
    const value = fixture();
    value.adapter.consume(complete('# Plan\n\nDo the work.'));
    value.adapter.finish();
    expect(value.events().find((event) => event.type === 'message')).toMatchObject({
      id: 'native-plan', status: 'completed', content: expect.stringContaining('carapaplan'),
    });
  });

  test('uses accumulated plan text when the completion omits text', () => {
    const value = fixture();
    value.adapter.consume(delta('# Plan\n\nRecovered from deltas.'));
    value.adapter.consume(complete());
    value.adapter.finish();
    expect(value.events().find((event) => event.type === 'message')).toMatchObject({
      status: 'completed', content: expect.stringContaining('Recovered from deltas.'),
    });
  });

  test('retains an interrupted plan as partial text without a completed plan card', () => {
    const value = fixture();
    value.adapter.consume(delta('# Unfinished plan'));
    value.adapter.consume({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
    value.adapter.finish();
    expect(value.events().find((event) => event.type === 'message')).toEqual({
      type: 'message', id: 'native-plan', role: 'assistant', content: '# Unfinished plan',
      format: 'markdown', status: 'interrupted',
    });
    expect(existsSync(join(value.root, 'artifacts'))).toBe(false);
  });

  test('keeps progress checklists separate and ignores empty native plans', () => {
    const value = fixture();
    value.adapter.consume({ method: 'turn/plan/updated', params: {
      turnId: 'turn-1', plan: [{ step: 'Read the source', status: 'completed' }],
    } });
    value.adapter.consume(complete(''));
    value.adapter.finish();
    expect(value.events().find((event) => event.type === 'plan')).toEqual({
      type: 'plan', id: 'turn-1-plan', entries: [
        { id: 'turn-1-plan-1', content: 'Read the source', status: 'completed' },
      ],
    });
    expect(value.events().filter((event) => event.type === 'message')).toHaveLength(0);
    expect(existsSync(join(value.root, 'artifacts'))).toBe(false);
  });
});
