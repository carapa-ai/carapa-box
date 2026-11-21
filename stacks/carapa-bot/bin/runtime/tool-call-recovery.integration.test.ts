import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRunContext } from './contracts';
import { runPiRpcHarness } from './pi-rpc/runner';
import { runClaudeHarness } from './claude-runner';
import { runAcpHarness } from './acp/runner';
import type { AcpHarnessContract } from './acp/contracts';
import { StandardAcpRunV1Adapter } from './standard-acp-v1';
import { runOpenCodeNative } from './opencode-v1';
import { runAgySdkNative } from './agy-sdk-v1';
import { TOOL_CALL_CORRECTION } from './tool-call-recovery';

const acpIds: AcpHarnessContract['id'][] = ['cursor-acp', 'hermes-acp', 'omp-acp', 'prime-agent-acp', 'antigravity-acp'];
const harnesses = ['pi', 'claude', 'opencode', 'agy-sdk', ...acpIds];
const jsonl = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

for (const scenario of ['recover', 'repeat', 'cancel', 'cancel-during']) {
  test.each(harnesses)(`${scenario}: %s keeps one run, preserves history, and bounds correction`, async (harness) => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-recovery-'));
    try {
      const runDir = join(root, 'ipc/runs/test');
      mkdirSync(runDir, { recursive: true });
      const peer = join(import.meta.dir, 'protocol/fixtures/recovery-peer.ts');
      const protocol = harness.endsWith('-acp') ? 'acp' : harness;
      for (const command of ['pi', 'claude', 'opencode']) {
        const path = join(root, command);
        writeFileSync(path, '#!/bin/sh\nexec "$TEST_BUN" "$TEST_RECOVERY_PEER" "$@"\n');
        chmodSync(path, 0o755);
      }
      const capture = join(root, 'capture.jsonl');
      writeFileSync(join(runDir, 'args.json'), JSON.stringify({ agentCmd: harness, env: {
        PATH: `${root}:${process.env.PATH}`, TEST_BUN: process.execPath, TEST_RECOVERY_PEER: peer,
        TEST_RECOVERY_PROTOCOL: protocol, TEST_RECOVERY_SCENARIO: scenario, TEST_RECOVERY_CAPTURE: capture,
        TEST_RECOVERY_RUN_DIR: runDir, CARAPA_RUN_MEMORY_LIMIT_MIB: '0', CARAPA_PERSIST_TURN_TIMEOUT: '5',
      } }));
      writeFileSync(join(runDir, 'prompt.txt'), 'Build the app');
      const context = createRunContext(runDir, resolve(import.meta.dir, '..'), root);
      // Only explicit fixture environment reaches provider peers.
      context.env = { ...context.args.env, HOME: root };
      let status: number;
      if (harness === 'pi') status = await runPiRpcHarness(context);
      else if (harness === 'claude') status = await runClaudeHarness(context);
      else if (harness === 'opencode') status = await runOpenCodeNative(context, ['opencode', 'run', '--format', 'json', context.prompt]);
      else if (harness === 'agy-sdk') status = await runAgySdkNative(context, [process.execPath, peer, '--warm']);
      else status = await runAcpHarness(context, {
        id: harness as AcpHarnessContract['id'], restore: 'resume', process: () => ({ command: [process.execPath, peer] }),
        ...(harness === 'antigravity-acp' ? { createV1: (_context, writer, resumed) => new StandardAcpRunV1Adapter(writer, '', resumed) } satisfies Partial<AcpHarnessContract> : {}),
      });
      // Normally the outer runtime finalizes transport failures too.
      const { ensureRunTerminal } = await import('./run-v1');
      ensureRunTerminal(context, status);
      const output = jsonl(join(runDir, 'output.v1.jsonl'));
      const prompts = jsonl(capture).filter(event => event.prompt);
      expect(prompts.map(event => event.prompt)).toEqual(scenario === 'cancel' ? [context.prompt] : [context.prompt, TOOL_CALL_CORRECTION]);
      if (harness !== 'opencode') expect(new Set(prompts.map(event => event.pid)).size).toBe(1);
      const terminal = output.filter(event => event.type === 'run' && ['completed', 'failed', 'interrupted'].includes(event.status));
      expect(terminal).toHaveLength(1);
      expect(terminal[0].status).toBe(scenario === 'recover' ? 'completed' : scenario.startsWith('cancel') ? 'interrupted' : 'failed');
      expect(status).toBe(scenario === 'repeat' ? 1 : 0);
      if (scenario === 'recover') {
        const calls = output.filter(event => event.type === 'tool_call' && event.name === 'write');
        expect(new Set(calls.map(event => event.id)).size).toBe(1);
        const correctionIndex = output.findIndex(event => event.type === 'message' && event.id === 'tool-protocol-correction');
        expect(correctionIndex).toBeGreaterThan(0);
        expect(output.slice(correctionIndex + 1).some(event => event.type === 'message' && event.role === 'assistant' && event.content.includes('Done'))).toBe(true);
      }
      if (scenario === 'repeat') expect(JSON.stringify(output)).toContain('after one automatic correction');
      if (scenario === 'recover' && ['claude', 'agy-sdk'].includes(harness)) {
        expect(output.filter(event => event.type === 'usage').at(-1)).toMatchObject({ inputTokens: 6, outputTokens: 4 });
      }
      if (scenario === 'recover' && harness === 'claude') {
        expect(JSON.parse(readFileSync(join(runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.02);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}
