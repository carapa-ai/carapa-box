import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveOpenCodeModel, openCodeEnv, openCodeRunCommand, OpenCodeRunV1Adapter } from './opencode-v1';
import { RunV1Writer } from './run-v1';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function events(): unknown[] {
  const root = mkdtempSync(join(tmpdir(), 'carapa-opencode-v1-'));
  roots.push(root);
  const writer = new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'opencode', requestedModel: null });
  const adapter = new OpenCodeRunV1Adapter(writer, '', false, 'opencode-run-1-message-1');
  adapter.consume({ type: 'step_start', sessionID: 'ses-opencode', part: { type: 'step-start' } });
  adapter.consume({ type: 'text', part: { type: 'text', text: 'OpenCode answer' } });
  adapter.consume({ type: 'tool_use', part: { type: 'tool', callID: 'tool-1', tool: 'bash', state: { status: 'completed', input: { command: 'printf ok' }, output: 'ok' } } });
  adapter.consume({ type: 'step_finish', sessionID: 'ses-opencode', reason: 'stop', part: { tokens: { input: 8, output: 2 } } });
  adapter.finish(0);
  return readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('OpenCode V1 normalization', () => {
  test('enables language servers without downloads, using the shared tsc only when installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-opencode-env-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const lsp = (env: Record<string, string>) => JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8')).lsp;
    const bare = openCodeEnv({ PATH: bin, TMPDIR: root });
    expect(bare.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe('true');
    expect(lsp(bare)).toEqual({});
    writeFileSync(join(bin, 'tsc'), '#!/bin/sh\n');
    chmodSync(join(bin, 'tsc'), 0o755);
    expect(lsp(openCodeEnv({ PATH: bin, TMPDIR: root })).typescript.command).toEqual(['tsc', '--lsp', '--stdio']);
    expect(openCodeEnv({ PATH: bin, OPENCODE_CONFIG: '/custom.json' }).OPENCODE_CONFIG).toBe('/custom.json');
  });

  test('forwards the selected reasoning effort as an OpenCode variant', () => {
    expect(openCodeRunCommand({
      args: {
        sessionId: 'ses-opencode',
        model: 'llamacpp/qwen3.8',
        agent: 'reviewer',
        reasoningEffort: 'xhigh',
      },
      prompt: 'Review this change',
    })).toEqual([
      'opencode', 'run', '--format', 'json', '--session', 'ses-opencode',
      '--model', 'llamacpp/qwen3.8', '--agent', 'reviewer', '--variant', 'xhigh',
      'Review this change',
    ]);
  });

  test('prefers the provider-resolved model ID over the requested alias', () => {
    expect(effectiveOpenCodeModel({ providerID: 'freeapi', modelID: 'poolside/laguna-s-2.1:free' })).toBe('poolside/laguna-s-2.1:free');
    expect(effectiveOpenCodeModel({ providerID: 'freeapi', modelID: 'auto' })).toBe('freeapi/auto');
  });

  test('normalizes native JSONL and excludes non-semantic step details', () => {
    const output = events() as Array<Record<string, any>>;
    expect(output.map((event) => event.type)).toEqual(['session', 'run', 'message_delta', 'tool_call', 'usage', 'message', 'run']);
    expect(output[0]).toEqual({ type: 'session', id: 'ses-opencode', status: 'started' });
    expect(output[2]).toMatchObject({ type: 'message_delta', id: 'opencode-run-1-message-1' });
    expect(output[3]).toMatchObject({ type: 'tool_call', id: 'tool-1', status: 'completed', name: 'bash', input: { command: 'printf ok' }, output: 'ok' });
    expect(output.at(-1)).toMatchObject({ type: 'run', status: 'completed', stopReason: 'stop' });
  });

  test('puts the nested provider error text in the failed terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-opencode-v1-'));
    roots.push(root);
    const writer = new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'opencode', requestedModel: null });
    const adapter = new OpenCodeRunV1Adapter(writer, '', false, 'opencode-run-4-message-1');
    adapter.consume({ type: 'error', error: { name: 'UnknownError', data: { message: 'Session not found' } } });
    adapter.finish(1);
    const output = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(output.find((event) => event.type === 'error')).toMatchObject({ message: 'Session not found' });
    expect(output.at(-1)).toMatchObject({ type: 'run', status: 'failed', error: { message: 'Session not found' } });
  });

  test('does not complete on intermediate tool-calls steps', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-opencode-v1-'));
    roots.push(root);
    const writer = new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'opencode', requestedModel: null });
    const adapter = new OpenCodeRunV1Adapter(writer, '', false, 'opencode-run-2-message-1');
    adapter.consume({ type: 'step_start', sessionID: 'ses-2' });
    adapter.consume({ type: 'step_finish', reason: 'tool-calls' });
    expect(readFileSync(join(root, 'output.v1.jsonl'), 'utf8')).not.toContain('"status":"completed"');
    expect(existsSync(join(root, 'output.v1.meta.json'))).toBe(true);
  });

  test('coalesces a running tool into one started and one terminal event', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-opencode-v1-'));
    roots.push(root);
    const writer = new RunV1Writer(root, { format: 'carapa-run', version: 1, harness: 'opencode', requestedModel: null });
    const adapter = new OpenCodeRunV1Adapter(writer, '', false, 'opencode-run-3-message-1');
    adapter.consume({ type: 'step_start', sessionID: 'ses-3' });
    adapter.consume({ type: 'tool_use', part: { type: 'tool', callID: 'tool-3', tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } } });
    adapter.consume({ type: 'tool_use', part: { type: 'tool', callID: 'tool-3', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace' } } });
    const output = readFileSync(join(root, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(output.filter((event) => event.type === 'tool_call').map((event) => event.status)).toEqual(['started', 'completed']);
    expect(output.filter((event) => event.type === 'tool_call').at(-1)).toMatchObject({ status: 'completed', output: '/workspace' });
  });
});
