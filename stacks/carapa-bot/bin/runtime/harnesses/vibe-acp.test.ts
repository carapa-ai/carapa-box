import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../contracts';
import { VIBE_PLAN_MODE, vibeAcpContract } from './vibe-acp';

const root = mkdtempSync(join(tmpdir(), 'carapa-vibe-acp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function context(args: Partial<RunContext['args']> = {}): RunContext {
  return {
    runDir: join(root, 'ipc', 'runs', 'run'), prompt: 'task', cwd: join(root, 'workspace'), runTag: 'run', binDir: root,
    env: { HOME: join(root, 'home'), MISTRAL_API_KEY: 'must-not-reach-vibe' },
    args: {
      agentCmd: 'vibe-acp', sessionId: '', forkSession: '', model: '', fallbackModel: '',
      reasoningEffort: '', fallbackReasoningEffort: '', chatMode: '', agent: '', bare: '',
      systemPrompt: '', workDir: '', conversationKey: 'conv-1', persistent: '', conversationId: '',
      env: {}, ...args,
    },
  };
}

test('routes Vibe through the relay with a placeholder key and no uploads', () => {
  const run = context();
  vibeAcpContract.prepare!(run);
  const env = vibeAcpContract.process(run).env!;
  expect(env.MISTRAL_API_KEY).toBe('carapa-relay');
  expect(JSON.parse(env.VIBE_PROVIDERS)).toEqual([{
    name: 'mistral', api_base: 'http://api-relay:8080/mistral-vibe/v1', api_key_env_var: 'MISTRAL_API_KEY', backend: 'mistral',
  }]);
  expect(env).toMatchObject({ VIBE_ENABLE_TELEMETRY: 'false', VIBE_ENABLE_CONNECTORS: 'false', VIBE_ENABLE_AUTO_UPDATE: 'false' });
  expect(JSON.parse(env.VIBE_EXPERIMENTS)).toEqual({ enable: false });
  expect(readFileSync(join(run.env.VIBE_HOME!, 'trusted_folders.toml'), 'utf8')).toContain(JSON.stringify(run.cwd));
});

test('plan mode uses the read-only profile and every other turn auto-approves', () => {
  const run = context({ chatMode: 'plan', model: 'mistral-medium-3.5', reasoningEffort: 'high' });
  vibeAcpContract.prepare!(run);
  const profile = readFileSync(join(run.env.VIBE_HOME!, 'agents', `${VIBE_PLAN_MODE}.toml`), 'utf8');
  for (const tool of ['bash', 'edit', 'write_file']) expect(profile).not.toContain(`"${tool}"`);
  expect(vibeAcpContract.configure!(run, 's').map((request) => request.params)).toEqual([
    { sessionId: 's', configId: 'mode', value: VIBE_PLAN_MODE },
    { sessionId: 's', configId: 'model', value: 'mistral-medium-3.5' },
    { sessionId: 's', configId: 'thinking', value: 'high' },
  ]);
  const next = context({ model: 'mistral-medium-3.5', reasoningEffort: 'high' });
  expect(vibeAcpContract.configure!(next, 's', { newDaemon: false, model: 'mistral-medium-3.5', thinking: 'high' })
    .map((request) => request.params)).toEqual([{ sessionId: 's', configId: 'mode', value: 'auto-approve' }]);
});

test('tells the model to pass tools.process.start an object, before and after a crash', () => {
  const run = context({ systemPrompt: 'be brief' });
  vibeAcpContract.prepare!(run);
  expect(run.prompt).toStartWith('be brief\n\nIn run_typescript, call tools.process.start with an object');
  expect(run.prompt).toEndWith('User request:\ntask');
  expect(vibeAcpContract.recoveryPrompt!('RustAcceptedApplyResult')).toContain('call tools.process.start with an object');
});

test('keeps built-in commands and installed skills first, but guides every other slash-led prompt', () => {
  const skill = context();
  mkdirSync(join(skill.cwd, '.vibe', 'skills', 'ship-it'), { recursive: true });
  writeFileSync(join(skill.cwd, '.vibe', 'skills', 'ship-it', 'SKILL.md'), '---\nname: ship-it\n---\n');
  for (const prompt of ['/compact', '  \n/Retry now', '/SHIP-IT now']) {
    const command = context();
    command.cwd = skill.cwd;
    command.prompt = prompt;
    vibeAcpContract.prepare!(command);
    expect(command.prompt).toBe(prompt);
  }
  // No built-in command or installed skill claims these: Vibe sends them to the model as ordinary text.
  for (const prompt of ['/workspace/project/build.ts: fix the launcher', '/tmp is full; find the cause',
    '/results.json does not exist; create it', '/unknown-skill do it']) {
    const ordinary = context();
    ordinary.cwd = skill.cwd;
    ordinary.prompt = prompt;
    vibeAcpContract.prepare!(ordinary);
    expect(ordinary.prompt).toStartWith('In run_typescript, call tools.process.start with an object');
    expect(ordinary.prompt).toEndWith(`User request:\n${prompt}`);
  }
});

test('keeps /loop first, as Vibe schedules a prompt only when it is the first word, and guides after it', () => {
  for (const prompt of ['/loop every hour check the build', '  \n/LOOP every hour check the build']) {
    const loop = context();
    loop.prompt = prompt;
    vibeAcpContract.prepare!(loop);
    expect(loop.prompt).toStartWith(prompt);
    expect(loop.prompt).toContain('\n\nIn run_typescript, call tools.process.start with an object');
  }
});

test('a fresh session cannot repeat a built-in command, only an ordinary request', () => {
  expect(vibeAcpContract.freshSessionRequest!('/retry')).toBeNull();
  expect(vibeAcpContract.freshSessionRequest!('  /compact now')).toBeNull();
  expect(vibeAcpContract.freshSessionRequest!('fix the build')).toBe('fix the build');
});
