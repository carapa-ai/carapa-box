import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../contracts';
import { planAcpHarness } from './contracts';
import { cursorAcpContract } from '../harnesses/cursor-acp';
import { hermesAcpContract } from '../harnesses/hermes-acp';
import { ompAcpContract } from '../harnesses/omp-acp';
import { primeAgentAcpContract } from '../harnesses/prime-agent-acp';

const acpHarnessContracts = [
  cursorAcpContract,
  hermesAcpContract,
  ompAcpContract,
  primeAgentAcpContract,
] as const;

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (): RunContext => ({
  runDir: '/tmp/run',
  prompt: 'hello',
  cwd: '/workspace',
  runTag: 'run',
  binDir: '/usr/local/stack-cli-bin',
  // No group rules on the test host: the default /workspace/group may exist.
  env: { OMP_THINKING_LEVEL: 'high', CARAPA_GROUP_ROOT: '/nonexistent/carapa-group' },
  args: {
    agentCmd: 'omp-acp',
    sessionId: '',
    forkSession: '',
    model: 'carapa-codex/gpt-5.6-sol',
    fallbackModel: '',
    reasoningEffort: '',
    fallbackReasoningEffort: '',
    chatMode: '',
    agent: '',
    bare: '',
    systemPrompt: 'system',
    workDir: '',
    conversationKey: 'conversation',
    persistent: '1',
    conversationId: 'conversation',
    env: {},
  },
});

describe('shared ACP harness contract', () => {
  test('keeps every ACP harness on the managed contract', () => {
    expect(acpHarnessContracts.map((contract) => contract.id).sort()).toEqual([
      'cursor-acp',
      'hermes-acp',
      'omp-acp',
      'prime-agent-acp',
    ]);
    expect(acpHarnessContracts).toHaveLength(4);
  });

  test('describes OMP startup, restoration, and configuration without shell interpolation', () => {
    // prepare() writes .omp/rules under cwd, so give it a directory this test owns.
    const cwd = mkdtempSync(join(tmpdir(), 'omp-contract-'));
    temporaryRoots.push(cwd);
    const value = { ...context(), cwd };
    expect(ompAcpContract.restore).toBe('resume');
    ompAcpContract.prepare?.(value);
    expect(value.env.PI_CODEX_WEBSOCKET).toBe('1');
    expect(ompAcpContract.process(value).command).toEqual([
      'omp',
      '--model',
      'carapa-codex/gpt-5.6-sol',
      '--thinking',
      'high',
      '--system-prompt',
      'system',
      'acp',
    ]);
    expect(ompAcpContract.configure?.(value, 'session')).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: 'session', configId: 'model', value: 'carapa-codex/gpt-5.6-sol' },
      },
      {
        method: 'session/set_config_option',
        params: { sessionId: 'session', configId: 'thinking', value: 'high' },
      },
    ]);
    expect(
      ompAcpContract.configure?.(value, 'session', {
        newDaemon: false,
        model: 'carapa-codex/gpt-5.6-sol',
        thinking: 'high',
      }),
    ).toEqual([]);
  });

  test('describes Cursor, Hermes, and Prime protocol differences', () => {
    const value = context();
    expect(cursorAcpContract.restore).toBe('load');
    expect(cursorAcpContract.restoreFailure).toBe('new-session');
    expect(cursorAcpContract.process(value).command).toEqual([
      'agent',
      '--yolo',
      '--approve-mcps',
      '--workspace',
      '/workspace',
      '--model',
      'carapa-codex/gpt-5.6-sol',
      'acp',
    ]);
    expect(cursorAcpContract.afterInitialize?.(value)).toEqual([
      { method: 'authenticate', params: { methodId: 'cursor_login' }, optional: true },
    ]);

    expect(hermesAcpContract.restore).toBe('load');
    expect(hermesAcpContract.process(value)).toEqual({
      command: ['hermes-acp'],
      env: {
        HERMES_INFERENCE_PROVIDER: 'openai-api',
        HERMES_INFERENCE_MODEL: 'carapa-codex/gpt-5.6-sol',
        OPENAI_BASE_URL: 'http://llama-proxy:8881/v1',
        OPENAI_API_KEY: 'llama-proxy-no-auth',
      },
    });
    expect(hermesAcpContract.configure?.(value, 'session')).toEqual([
      {
        method: 'session/set_model',
        params: { sessionId: 'session', modelId: 'openai-api:carapa-codex/gpt-5.6-sol' },
      },
    ]);

    value.args.reasoningEffort = 'none';
    expect(primeAgentAcpContract.process(value, 'prime-session').command).toEqual([
      'prime-agent',
      '--mode',
      'acp',
      '--cwd',
      '/workspace',
      '--resume',
      'prime-session',
      '--provider',
      'carapa-codex',
      '--model',
      'gpt-5.6-sol',
      '--thinking',
      'off',
    ]);
  });

  test('configures Hermes GPT models through the native Codex Responses transport', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-hermes-codex-'));
    temporaryRoots.push(root);
    const sourceHome = join(root, 'home', '.hermes');
    const runDir = join(root, 'ipc', 'runs', 'run');
    mkdirSync(join(sourceHome, 'skills'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const value = context();
    value.runDir = runDir;
    value.args.model = 'gpt-5.6-luna';
    value.env = {
      HOME: join(root, 'home'),
      HERMES_INFERENCE_PROVIDER: 'carapa-codex',
      OPENAI_API_KEY: 'relay-placeholder',
      OPENAI_BASE_URL: 'http://api-relay:8080/codex',
    };

    hermesAcpContract.prepare?.(value);

    const hermesHome = join(root, 'ipc', 'sessions', 'conversation', 'hermes-home');
    expect(value.env.HERMES_HOME).toBe(hermesHome);
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf8')).toContain(
      'transport: codex_responses',
    );
    expect(hermesAcpContract.process(value)).toEqual({
      command: ['hermes-acp'],
      env: {
        HERMES_INFERENCE_PROVIDER: 'carapa-codex',
        HERMES_INFERENCE_MODEL: 'gpt-5.6-luna',
        OPENAI_BASE_URL: 'http://api-relay:8080/codex',
        OPENAI_API_KEY: 'relay-placeholder',
      },
    });
    expect(hermesAcpContract.configure?.(value, 'session')).toEqual([
      {
        method: 'session/set_model',
        params: { sessionId: 'session', modelId: 'custom:carapa-codex:gpt-5.6-luna' },
      },
    ]);
  });

  test('builds a managed plan from a harness-local contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-cursor-plan-'));
    temporaryRoots.push(root);
    const value = context();
    value.runDir = join(root, 'ipc', 'runs', 'run');
    value.env = { ...value.env, HOME: join(root, 'home') };
    const runner = async () => 0;
    expect(planAcpHarness(value, cursorAcpContract, runner).kind).toBe('managed');
  });
});
