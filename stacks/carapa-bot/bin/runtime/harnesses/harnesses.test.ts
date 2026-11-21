import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunContext } from '../contracts';
import { harnessAdapters, planHarness } from './index';
import { claudeLaunch, runClaudeHarness } from '../claude-runner';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (agentCmd: string, overrides: Partial<RunContext> = {}): RunContext => ({
  runDir: '/tmp/run',
  prompt: 'hello',
  cwd: '/workspace/project',
  runTag: 'run',
  binDir: '/usr/local/stack-cli-bin',
  // No group rules on the test host: the default /workspace/group may exist.
  env: { HOME: '/tmp/home', CARAPA_GROUP_ROOT: '/nonexistent/carapa-group' },
  args: {
    agentCmd,
    sessionId: '',
    forkSession: '',
    model: '',
    fallbackModel: '',
    reasoningEffort: '',
    fallbackReasoningEffort: '',
    chatMode: '',
    agent: '',
    bare: '',
    systemPrompt: '',
    workDir: '',
    conversationKey: '',
    persistent: '',
    conversationId: '',
    env: {},
  },
  ...overrides,
});

function filesystemContext(agentCmd: string): RunContext {
  const root = mkdtempSync(join(tmpdir(), 'carapa-harness-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const runDir = join(root, 'ipc', 'runs', 'run');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return context(agentCmd, {
    cwd,
    runDir,
    env: { HOME: home, CARAPA_GROUP_ROOT: join(root, 'group') },
  });
}

describe('harness adapters', () => {
  test('keeps every supported harness in a separate registered module', () => {
    expect(harnessAdapters.map((adapter) => adapter.command).sort()).toEqual([
      'agy-sdk',
      'antigravity-acp',
      'claude',
      'codex',
      'cursor-acp',
      'grok-acp',
      'hermes-acp',
      'muse-acp',
      'omp-acp',
      'opencode',
      'pi',
      'prime-agent-acp',
      'vibe-acp',
    ]);
  });

  test('builds Claude arguments without shell interpolation', async () => {
    const value = context('claude');
    value.args.sessionId = 'session with spaces';
    value.args.model = 'sonnet';
    value.args.systemPrompt = 'system prompt';
    const plan = await planHarness(value);
    expect(plan).toEqual({ kind: 'managed', execute: runClaudeHarness });
    expect(claudeLaunch(value, value.args.sessionId).command).toEqual([
      'claude', '--dangerously-skip-permissions', '-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--resume=session with spaces',
      '--model', 'sonnet', '--system-prompt', 'system prompt',
    ]);
  });

  test('builds representative native harness plans', async () => {
    const expected: Record<string, string> = {
      'agy-sdk': 'bun',
      opencode: 'bun',
    };
    for (const [name, executable] of Object.entries(expected)) {
      const plan = await planHarness(context(name));
      expect(plan.kind).toBe('native');
      if (plan.kind === 'native') expect(plan.command[0]).toBe(executable);
    }
  });

  test('prepares Codex, Pi, and OMP harness-specific state', async () => {
    const codex = filesystemContext('codex');
    const codexPlan = await planHarness(codex);
    expect(codexPlan.kind).toBe('native');
    if (codexPlan.kind === 'native') {
      expect(codexPlan.command).toEqual([
        'bun',
        '--no-env-file',
        join(codex.binDir, 'runtime', 'codex-app-server', 'main.ts'),
        codex.runDir,
      ]);
    }
    expect(codex.env.CODEX_HOME).toBe(
      join(dirname(dirname(codex.runDir)), 'codex-home'),
    );
    expect(existsSync(join(codex.cwd, '.agents', 'skills'))).toBe(true);

    const profiledCodex = filesystemContext('codex');
    profiledCodex.env.CODEX_PROFILE = 'freellmapi';
    const profiledCodexPlan = await planHarness(profiledCodex);
    expect(profiledCodexPlan.kind).toBe('native');
    if (profiledCodexPlan.kind === 'native') {
      expect(profiledCodexPlan.command).toEqual([
        'bun',
        '--no-env-file',
        join(
          profiledCodex.binDir,
          'runtime',
          'codex-app-server',
          'main.ts',
        ),
        profiledCodex.runDir,
      ]);
    }
    expect(profiledCodex.env.CODEX_HOME).toBe(
      join(dirname(dirname(profiledCodex.runDir)), 'codex-home'),
    );

    const pi = filesystemContext('pi');
    pi.args.model = 'openai/gpt-5';
    pi.args.reasoningEffort = 'high';
    const piPlan = await planHarness(pi);
    expect(pi.env.PI_CODEX_WEBSOCKET).toBe('1');
    expect(piPlan.kind).toBe('managed');

    const omp = filesystemContext('omp-acp');
    omp.args.model = 'anthropic/claude';
    omp.args.systemPrompt = 'system';
    const ompPlan = await planHarness(omp);
    expect(ompPlan.kind).toBe('managed');
    expect(omp.env.PI_CODEX_WEBSOCKET).toBe('1');
  });

  test('routes persistent ACP harnesses through managed plans', async () => {
    const cursor = filesystemContext('cursor-acp');
    cursor.args.persistent = '1';
    cursor.args.conversationKey = 'conversation';
    expect((await planHarness(cursor)).kind).toBe('managed');
    const hermes = filesystemContext('hermes-acp');
    hermes.args.persistent = '1';
    hermes.args.conversationKey = 'conversation';
    expect((await planHarness(hermes)).kind).toBe('managed');
    const omp = filesystemContext('omp-acp');
    omp.args.persistent = '1';
    omp.args.conversationKey = 'conversation';
    expect((await planHarness(omp)).kind).toBe('managed');
    const prime = filesystemContext('prime-agent-acp');
    const primeTemplate = join(prime.env.HOME, 'prime-models.json');
    writeFileSync(primeTemplate, JSON.stringify({ providers: { 'carapa-codex': {} } }));
    prime.env.PRIME_AGENT_MODELS_TEMPLATE = primeTemplate;
    prime.args.persistent = '1';
    prime.args.conversationKey = 'conversation';
    expect((await planHarness(prime)).kind).toBe('managed');
  });

  test('routes persistent non-ACP harnesses through their typed plans', async () => {
    const warm = context('claude');
    warm.args.persistent = '1';
    warm.args.conversationKey = 'conversation';
    expect((await planHarness(warm)).kind).toBe('managed');

    const pi = filesystemContext('pi');
    pi.args.persistent = '1';
    pi.args.conversationKey = 'conversation';
    expect((await planHarness(pi)).kind).toBe('managed');
  });

  test('reuses one project Codex home across conversations and profiles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-codex-persistent-'));
    roots.push(root);
    const cwd = join(root, 'workspace');
    const ipcRoot = join(root, 'ipc');
    const home = join(root, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const makeTurn = async (name: string, conversationKey: string, profile = '') => {
      const runDir = join(ipcRoot, 'runs', name);
      mkdirSync(runDir, { recursive: true });
      const value = context('codex', { runDir, cwd, env: { HOME: home, CARAPA_GROUP_ROOT: join(home, 'group') } });
      value.args.persistent = '1';
      value.args.conversationKey = conversationKey;
      if (profile) value.env.CODEX_PROFILE = profile;
      await planHarness(value);
      return value;
    };
    const first = await makeTurn('first', 'conversation/one');
    const second = await makeTurn('second', 'conversation/two', 'freellmapi');
    const expected = join(ipcRoot, 'codex-home');
    expect(first.env.CODEX_HOME).toBe(expected);
    expect(second.env.CODEX_HOME).toBe(expected);
  });

  test('rejects unsupported harnesses instead of delegating them', async () => {
    expect(planHarness(context('custom-agent'))).rejects.toThrow(
      'unsupported agent harness: custom-agent',
    );
  });

});
