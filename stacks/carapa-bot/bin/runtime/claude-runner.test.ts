import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approveExternalRuleIncludes, claudeLaunch, runClaudeHarness } from './claude-runner';
import { createRunContext } from './contracts';
import { daemonIdentity } from './protocol/daemon';
import { isAlive, terminateProcessTree } from './processes';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const owner = daemonIdentity(join(root, 'ipc/sessions/claude-test/claude-input'));
    if (owner) await terminateProcessTree(owner.pid);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carapa-claude-stream-'));
  roots.push(root);
  const cli = join(root, 'claude');
  writeFileSync(cli, '#!/bin/sh\nexec "$TEST_BUN" "$TEST_CLAUDE_PEER" "$@"\n');
  chmodSync(cli, 0o755);
  const session = join(root, 'ipc/sessions/claude-test');
  const capture = join(root, 'capture.jsonl');
  function turn(name: string, prompt = name, args = {}, extraEnv: Record<string, string> = {}) {
    const runDir = join(root, 'ipc/runs', name);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'args.json'), JSON.stringify({
      agentCmd: 'claude', persistent: '1', conversationKey: 'claude-test', ...args,
      env: { PATH: `${root}:${process.env.PATH}`, TEST_BUN: process.execPath,
        TEST_CLAUDE_PEER: join(import.meta.dir, 'protocol/fixtures/claude-peer.ts'),
        TEST_PROTOCOL_TRANSCRIPT: capture, CARAPA_PERSIST_TURN_TIMEOUT: '1', CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
        CARAPA_GROUP_ROOT: join(root, 'group'), HOME: root, ...extraEnv },
    }));
    writeFileSync(join(runDir, 'prompt.txt'), prompt);
    return createRunContext(runDir, resolve(import.meta.dir, '..'), root);
  }
  return { root, session, capture, turn, launches: () => readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'launch') };
}
const events = (runDir: string) => readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('fresh Claude turns use streaming, preserve large Unicode prompts, and retire their process', async () => {
  const f = fixture();
  const prompt = 'țară🙂'.repeat(30_000);
  const run = f.turn('fresh', prompt, { persistent: '', conversationKey: '', sessionId: 'prior-session' });
  expect(await runClaudeHarness(run)).toBe(0);
  expect(isAlive(Number(readFileSync(join(run.runDir, 'pid'), 'utf8')))).toBe(false);
  expect(events(run.runDir).find(event => event.type === 'message')?.content).toBe(`turn 1: ${prompt}`);
  expect(events(run.runDir)[0]).toEqual({ type: 'session', id: 'prior-session', status: 'resumed' });
  expect(f.launches()[0].args).toContain('--resume=prior-session');
});

test('model, effort, system prompt, and provider environment changes restart and resume the session', async () => {
  const f = fixture();
  const first = f.turn('first');
  expect(await runClaudeHarness(first)).toBe(0);
  const id = readFileSync(join(f.session, 'session_id'), 'utf8');
  for (const [index, args] of [{ model: 'sonnet' }, { model: 'sonnet', reasoningEffort: 'low' }, { model: 'sonnet', reasoningEffort: 'low', systemPrompt: 'custom' }].entries()) {
    const run = f.turn(`changed-${index}`, 'complete', args);
    expect(await runClaudeHarness(run)).toBe(0);
    expect(f.launches().at(-1).args).toContain(`--resume=${id}`);
  }
  const provider = f.turn('provider', 'complete', { model: 'sonnet', reasoningEffort: 'low', systemPrompt: 'custom' });
  provider.env.ANTHROPIC_BASE_URL = 'http://provider.invalid';
  expect(await runClaudeHarness(provider)).toBe(0);
  expect(f.launches()).toHaveLength(5);
  expect(readFileSync(join(f.session, 'session_id'), 'utf8')).toBe(id);
});

test('forking a retained Claude session starts a new process and records its new native ID', async () => {
  const f = fixture();
  expect(await runClaudeHarness(f.turn('first'))).toBe(0);
  const id = readFileSync(join(f.session, 'session_id'), 'utf8');
  const fork = f.turn('fork', 'complete', { forkSession: '1', sessionId: id });
  expect(await runClaudeHarness(fork)).toBe(0);
  const forkId = readFileSync(join(f.session, 'session_id'), 'utf8');
  expect(forkId).not.toBe(id);
  expect(events(fork.runDir)[0].id).toBe(forkId);
  expect(f.launches()[1].args).toContain('--fork-session');
  expect(await runClaudeHarness(f.turn('follow-fork'))).toBe(0);
  expect(f.launches()).toHaveLength(2);
});

test.each(['crash', 'hold'])('Claude %s fails the run, retires the process, and resumes on the next turn', async (prompt) => {
  const f = fixture();
  const failed = f.turn('failed', prompt);
  expect(await runClaudeHarness(failed)).toBe(1);
  expect(events(failed.runDir).at(-1).status).toBe('failed');
  expect(isAlive(Number(readFileSync(join(failed.runDir, 'pid'), 'utf8')))).toBe(false);
  const id = readFileSync(join(f.session, 'session_id'), 'utf8');
  expect(await runClaudeHarness(f.turn('recovery'))).toBe(0);
  expect(f.launches()[1].args).toContain(`--resume=${id}`);
});

test('provider error results fail the run without discarding a usable warm process', async () => {
  const f = fixture();
  const failed = f.turn('failed', 'fail');
  expect(await runClaudeHarness(failed)).toBe(1);
  expect(events(failed.runDir).at(-1).status).toBe('failed');
  expect(await runClaudeHarness(f.turn('next'))).toBe(0);
  expect(f.launches()).toHaveLength(1);
});

test('an abandoned in-flight turn retires its process before another prompt is sent', async () => {
  const f = fixture();
  expect(await runClaudeHarness(f.turn('first'))).toBe(0);
  writeFileSync(join(f.session, 'turn_in_flight'), '/previous/dead/worker');
  expect(await runClaudeHarness(f.turn('next'))).toBe(0);
  expect(f.launches()).toHaveLength(2);
  expect(existsSync(join(f.session, 'turn_in_flight'))).toBe(false);
});

test('Claude launch retains bare/agent/effort options without mutating the turn environment', () => {
  const f = fixture();
  const run = f.turn('options', 'complete', { bare: '1', agent: 'reviewer', reasoningEffort: 'none' });
  const launch = claudeLaunch(run);
  expect(launch.command).toContain('--bare');
  expect(launch.command).toContain('--include-partial-messages');
  expect(launch.command).toContain('reviewer');
  expect(launch.env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-ninfer-reasoning: none');
  expect(run.env.ANTHROPIC_CUSTOM_HEADERS).not.toBe('x-ninfer-reasoning: none');
});

test('Claude launch registers project MCP servers so a changed set restarts the warm process', () => {
  const run = fixture().turn('mcp');
  expect(claudeLaunch(run).command.some((arg) => arg.startsWith('--mcp-config'))).toBe(false);
  const command = claudeLaunch(run, '', [{ name: 'carapa-mail', url: 'http://api-relay:8080/carapa-mail/mcp' }]).command;
  const flag = command.find((arg) => arg.startsWith('--mcp-config=')) ?? '';
  expect(JSON.parse(flag.slice('--mcp-config='.length))).toEqual({
    mcpServers: { 'carapa-mail': { type: 'http', url: 'http://api-relay:8080/carapa-mail/mcp' } },
  });
});

test('Claude launch appends group rules for runs outside the group directory, except bare runs', () => {
  const f = fixture();
  const run = f.turn('group-rules');
  Object.assign(run.env, { HOME: f.root });
  expect(claudeLaunch(run).command).not.toContain('--append-system-prompt-file');
  const rules = join(run.env.CARAPA_GROUP_ROOT, '.agent', 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'g.md'), '---\ntrigger: always_on\n---\nGroup rule.\n');
  const command = claudeLaunch(run).command;
  const file = command[command.indexOf('--append-system-prompt-file') + 1];
  expect(readFileSync(file, 'utf8')).toContain('Group rule.');
  expect(claudeLaunch({ ...run, args: { ...run.args, bare: '1' } }).command).not.toContain('--append-system-prompt-file');
});

test('Claude launch excludes model_decision rules natively in the group and in the agent view, with a stable index', () => {
  const f = fixture();
  const run = f.turn('model-decision');
  const group = run.env.CARAPA_GROUP_ROOT;
  const rules = join(group, '.agent', 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'always.md'), '---\ntrigger: always_on\n---\nAlways body text.\n');
  writeFileSync(join(rules, 'plain.md'), '---\ntrigger: model_decision\n---\nNo description.\n');
  const settingsOf = (command: string[]) => command[command.indexOf('--settings') + 1];
  const appendOf = (command: string[]) => command.filter((arg, i) => command[i - 1] === '--append-system-prompt-file');
  const inGroup = { ...run, cwd: group };
  expect(claudeLaunch(inGroup).command).not.toContain('--settings');
  expect(claudeLaunch(inGroup).command).not.toContain('--append-system-prompt-file');
  writeFileSync(join(rules, 'ref.md'), '---\ntrigger: model_decision\ndescription: Reference doc\n---\nRef body text.\n');
  const command = claudeLaunch(inGroup).command;
  expect(JSON.parse(readFileSync(settingsOf(command), 'utf8'))).toEqual({ claudeMdExcludes: [realpathSync(join(rules, 'ref.md'))] });
  const [index] = appendOf(command);
  expect(readFileSync(index, 'utf8')).toContain('[Reference doc]');
  expect(readFileSync(index, 'utf8')).not.toContain('Always body text.');
  expect(claudeLaunch(inGroup).command).toEqual(command);
  expect(claudeLaunch({ ...inGroup, args: { ...run.args, bare: '1' } }).command).not.toContain('--settings');
  // Outside the group, without the agent view, the appended group file is unchanged and nothing is excluded.
  const outside = claudeLaunch({ ...run, cwd: f.root }).command;
  expect(outside).not.toContain('--settings');
  expect(readFileSync(appendOf(outside)[0], 'utf8')).toContain('Always body text.');
  // With the agent view the same rules are excluded for a run outside the group.
  mkdirSync(join(run.env.HOME, '.agent', 'rules'), { recursive: true });
  writeFileSync(join(run.env.HOME, '.agent', 'rules', '.carapa-agent-view'), '');
  const view = claudeLaunch({ ...run, cwd: f.root }).command;
  expect(settingsOf(view)).toBe(settingsOf(command));
  expect(appendOf(view)).toEqual([index]);
});

test('Claude launch falls back to the plain command when the settings file cannot be written', () => {
  const f = fixture();
  const run = f.turn('model-decision-failure');
  const rules = join(run.env.CARAPA_GROUP_ROOT, '.agent', 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'ref.md'), '---\ntrigger: model_decision\ndescription: Reference doc\n---\nBody.\n');
  const inGroup = { ...run, cwd: run.env.CARAPA_GROUP_ROOT };
  expect(claudeLaunch(inGroup).command).toContain('--settings');
  // A file where the cache directory should be makes every write fail.
  rmSync(join(run.env.HOME, '.cache'), { recursive: true, force: true });
  writeFileSync(join(run.env.HOME, '.cache'), '');
  const command = claudeLaunch(inGroup).command;
  expect(command).not.toContain('--settings');
  expect(command).not.toContain('--append-system-prompt-file');
});

test('Claude runs approve externally linked rules for their directory without losing other config', async () => {
  const f = fixture();
  const config = join(f.root, '.claude.json');
  const run = f.turn('approve');
  approveExternalRuleIncludes(run);
  expect(JSON.parse(readFileSync(config, 'utf8')).projects[run.cwd].hasClaudeMdExternalIncludesApproved).toBe(true);
  writeFileSync(config, JSON.stringify({ oauthAccount: { id: 'kept' }, projects: { [run.cwd]: { allowedTools: ['x'], hasClaudeMdExternalIncludesApproved: false }, '/other': { a: 1 } } }));
  chmodSync(config, 0o600);
  expect(await runClaudeHarness(f.turn('approve-run', 'complete', { persistent: '', conversationKey: '' }))).toBe(0);
  expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ oauthAccount: { id: 'kept' }, projects: {
    [run.cwd]: { allowedTools: ['x'], hasClaudeMdExternalIncludesApproved: true }, '/other': { a: 1 } } });
  expect(statSync(config).mode & 0o777).toBe(0o600);
  writeFileSync(config, '{"partial');
  expect(() => approveExternalRuleIncludes(run)).toThrow();
  expect(readFileSync(config, 'utf8')).toBe('{"partial');
});

test('Claude launch requests the 1-hour prompt cache only for opted-in conversations on Anthropic endpoints', () => {
  const f = fixture();
  const ttl = (env: Record<string, string>, promptCacheTtl = '1h') => {
    const run = f.turn('cache-ttl', 'complete', { promptCacheTtl });
    Object.assign(run.env, env);
    return claudeLaunch(run).env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  };
  expect(ttl({}, '')).toBeUndefined();
  expect(ttl({})).toBe('1h');
  expect(ttl({ ANTHROPIC_BASE_URL: 'http://api-relay:8080/anthropic' })).toBe('1h');
  expect(ttl({ ANTHROPIC_BASE_URL: 'http://api-relay:8080/anthropic-api' })).toBe('1h');
  expect(ttl({ ANTHROPIC_BASE_URL: 'http://llama-proxy:8881' })).toBeUndefined();
  expect(ttl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })).toBe('5m');
});

test('Claude launch loads an LSP plugin declaring only the language servers on PATH', () => {
  const f = fixture();
  const bin = join(f.root, 'lsp-bin');
  mkdirSync(bin);
  const run = f.turn('lsp');
  Object.assign(run.env, { PATH: bin, TMPDIR: f.root });
  expect(claudeLaunch(run).command).not.toContain('--plugin-dir');
  writeFileSync(join(bin, 'intelephense'), '#!/bin/sh\n');
  chmodSync(join(bin, 'intelephense'), 0o755);
  const command = claudeLaunch(run).command;
  const plugin = command[command.indexOf('--plugin-dir') + 1];
  const servers = JSON.parse(readFileSync(join(plugin, '.lsp.json'), 'utf8'));
  expect(Object.keys(servers)).toEqual(['php']);
  expect(servers.php.settings.intelephense.files.exclude).toEqual(expect.arrayContaining(['**/.worktrees/**', 'storage/**']));
  expect(existsSync(join(plugin, '.claude-plugin/plugin.json'))).toBe(true);
});


test('Claude initialization rejection fails before dispatch and retires the process', async () => {
  const f = fixture();
  const run = f.turn('init-rejection');
  run.env.TEST_CLAUDE_REJECT_CONTROL = 'initialize';
  expect(await runClaudeHarness(run)).toBe(1);
  expect(existsSync(join(run.runDir, 'prompt_dispatched_at_ms'))).toBe(false);
  expect(isAlive(Number(readFileSync(join(run.runDir, 'pid'), 'utf8')))).toBe(false);
  expect(events(run.runDir).at(-1).error.message).toContain('fixture rejection');
});

test('Claude interruption is acknowledged only after a correlated provider response', async () => {
  const f = fixture();
  const run = f.turn('interrupt-rejection', 'hold');
  run.env.TEST_CLAUDE_REJECT_CONTROL = 'interrupt';
  const running = runClaudeHarness(run);
  try {
    for (let i = 0; i < 200 && !existsSync(join(run.runDir, 'prompt_dispatched_at_ms')); i++) await Bun.sleep(5);
    writeFileSync(join(run.runDir, 'control-requests/rejected.json'), JSON.stringify({ action: 'interrupt' }));
    const response = join(run.runDir, 'control-responses/rejected.json');
    for (let i = 0; i < 200 && !existsSync(response); i++) await Bun.sleep(5);
    expect(JSON.parse(readFileSync(response, 'utf8'))).toEqual({ ok: false, error: 'fixture rejection' });
    expect(await running).toBe(1);
    expect(events(run.runDir).at(-1).status).toBe('failed');
  } finally { await running; }
});


test('Board bootstrap-only system prompts retain the warm process and survive restart', async () => {
  const f = fixture();
  const systemPrompt = 'Conversation instructions.\n\n';
  const first = f.turn('first', 'complete', { systemPrompt });
  const followUp = f.turn('follow-up');
  expect(await runClaudeHarness(first)).toBe(0);
  expect(await runClaudeHarness(followUp)).toBe(0);
  for (const run of [first, followUp]) expect(JSON.parse(readFileSync(join(run.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.01, 10);
  expect(f.launches()).toHaveLength(1);
  const owner = daemonIdentity(join(f.session, 'claude-input'))!;
  await terminateProcessTree(owner.pid);
  const resume = f.turn('resume');
  expect(await runClaudeHarness(resume)).toBe(0);
  expect(JSON.parse(readFileSync(join(resume.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.01, 10);
  expect(f.launches()).toHaveLength(2);
  expect(f.launches()[1].args).toContain(systemPrompt);
});

test('Plan mode holds AskUserQuestion for the Board answer and publishes ExitPlanMode as a plan', async () => {
  const f = fixture();
  const run = f.turn('plan', 'plan', { chatMode: 'plan', groupDir: f.root });
  run.env.CARAPA_PERSIST_TURN_TIMEOUT = '10';
  const running = runClaudeHarness(run);
  try {
    const v1 = join(run.runDir, 'output.v1.jsonl');
    const asked = () => existsSync(v1) && readFileSync(v1, 'utf8').includes('"status":"requested"');
    for (let i = 0; i < 400 && !asked(); i++) await Bun.sleep(5);
    expect(events(run.runDir).find(event => event.type === 'interaction')?.id).toBe('plan-tool-1');
    writeFileSync(join(run.runDir, 'control-requests/answer.json'), JSON.stringify({ action: 'answerUserInput', requestId: 'plan-tool-1', answers: { 'question-1': { answers: ['Blue'] } } }));
    expect(await running).toBe(0);
    expect(JSON.parse(readFileSync(join(run.runDir, 'control-responses/answer.json'), 'utf8')).ok).toBe(true);
  } finally { await running; }
  const launch = f.launches()[0].args;
  expect(launch).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--permission-prompt-tool', 'stdio']));
  expect(launch).not.toContain('--dangerously-skip-permissions');
  const decisions = readFileSync(join(f.root, 'capture.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'control_response' && event.response.response?.behavior).map(event => event.response.response);
  expect(decisions[0]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which color?': 'Blue' } } });
  expect(decisions[1]).toMatchObject({ behavior: 'allow', updatedInput: { command: 'touch plan-probe' } });
  expect(decisions[2].behavior).toBe('deny');
  const plan = events(run.runDir).find(event => event.type === 'message' && event.content.includes('```carapaplan'));
  expect(plan?.content).toContain('# Paint plan');
  expect(events(run.runDir).some(event => event.type === 'tool_call' && event.name === 'ExitPlanMode')).toBe(false);
  expect(events(run.runDir).find(event => event.type === 'interaction' && event.status === 'answered')?.id).toBe('plan-tool-1');
});

async function control(runDir: string, name: string, request: object) {
  for (let i = 0; i < 200 && !existsSync(join(runDir, 'prompt_dispatched_at_ms')); i++) await Bun.sleep(5);
  writeFileSync(join(runDir, `control-requests/${name}.json`), JSON.stringify(request));
  const response = join(runDir, `control-responses/${name}.json`);
  for (let i = 0; i < 200 && !existsSync(response); i++) await Bun.sleep(5);
  return JSON.parse(readFileSync(response, 'utf8'));
}
const messages = (runDir: string) => events(runDir).filter(event => event.type === 'message').map(event => event.content);

test('Claude steering is acknowledged by the CLI and absorbed into the running turn', async () => {
  const f = fixture();
  const run = f.turn('steer-absorbed', 'hold');
  const running = runClaudeHarness(run);
  try {
    expect(await control(run.runDir, 'steer', { action: 'steer', text: 'absorb this' })).toEqual({ ok: true, result: {} });
    expect(await running).toBe(0);
  } finally { await running; }
  expect(messages(run.runDir)).toEqual(['turn 1: hold', 'turn 2: absorb this']);
});

test('a Claude steer queued behind the turn result keeps the run open for its turn', async () => {
  const f = fixture();
  const run = f.turn('steer-split', 'slow');
  const running = runClaudeHarness(run);
  try {
    expect((await control(run.runDir, 'steer', { action: 'steer', text: 'redirect' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(messages(run.runDir)).toEqual(['turn 1: slow', 'turn 2: redirect']);
  // The warm process is idle: the next run's prompt is not answered by a stale steer turn.
  const next = f.turn('after-steer', 'next');
  expect(await runClaudeHarness(next)).toBe(0);
  expect(messages(next.runDir)).toEqual(['turn 3: next']);
});

test('interrupting a Claude turn also stops a steer the CLI starts afterwards', async () => {
  const f = fixture();
  const run = f.turn('steer-interrupt', 'hold');
  const running = runClaudeHarness(run);
  try {
    expect((await control(run.runDir, 'steer', { action: 'steer', text: 'hold' })).ok).toBe(true);
    expect((await control(run.runDir, 'interrupt', { action: 'interrupt' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(events(run.runDir).at(-1).status).toBe('interrupted');
  const interrupts = readFileSync(join(f.root, 'capture.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'control_request' && event.request.subtype === 'interrupt');
  expect(interrupts).toHaveLength(2);
});

const userFrames = (root: string): string[] => readFileSync(join(root, 'capture.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .filter(event => event.type === 'user' && typeof event.message.content === 'string').map(event => event.message.content);

test('an allowlisted user command is sent as a second frame after the prompt turn and both turns are counted', async () => {
  const f = fixture();
  const run = f.turn('goal', 'board context');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal all tests pass\n\nsecond paragraph is dropped\n');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(userFrames(f.root)).toEqual(['board context', '/goal all tests pass']);
  expect(messages(run.runDir)).toEqual(['turn 1: board context', 'turn 2: /goal all tests pass']);
  expect(JSON.parse(readFileSync(join(run.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.02, 10);
  // Not allowlisted, empty or not a command: only the prompt frame, as before.
  for (const [name, command] of [['reflect', '/reflect'], ['empty', '  \n'], ['plain', 'goal x']]) {
    const single = f.turn(name, name);
    writeFileSync(join(single.runDir, 'user-command.txt'), command);
    expect(await runClaudeHarness(single)).toBe(0);
    expect(messages(single.runDir)).toHaveLength(1);
  }
  // CARAPA_CLAUDE_FORWARD_COMMANDS replaces the default allowlist.
  const custom = f.turn('custom', 'custom', {}, { CARAPA_CLAUDE_FORWARD_COMMANDS: 'reflect' });
  writeFileSync(join(custom.runDir, 'user-command.txt'), '/reflect now');
  expect(await runClaudeHarness(custom)).toBe(0);
  expect(messages(custom.runDir)).toEqual(['turn 6: custom', 'turn 7: /reflect now']);
});

test('an interrupt during the prompt turn means the user command is never sent', async () => {
  const f = fixture();
  const run = f.turn('goal-interrupt', 'hold');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal x');
  const running = runClaudeHarness(run);
  try {
    expect((await control(run.runDir, 'interrupt', { action: 'interrupt' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(userFrames(f.root)).toEqual(['hold']);
  // Control: the same command is sent when the turn is not interrupted.
  const next = f.turn('goal-after', 'next');
  writeFileSync(join(next.runDir, 'user-command.txt'), '/goal x');
  expect(await runClaudeHarness(next)).toBe(0);
  expect(userFrames(f.root)).toEqual(['hold', 'next', '/goal x']);
});

test('the run stays open for the user command when a steer runs between the prompt and the command', async () => {
  const f = fixture();
  const run = f.turn('goal-steer', 'slow');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal x');
  const running = runClaudeHarness(run);
  try {
    expect((await control(run.runDir, 'steer', { action: 'steer', text: 'redirect' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(messages(run.runDir)).toEqual(['turn 1: slow', 'turn 2: redirect', 'turn 3: /goal x']);
});

test.each([
  ['background-early', 'turn 2: task notified'],
  ['background-now', 'turn 2: task notified'],
])('the user command waits for a pending background notification turn instead of racing it (%s)', async (prompt, notification) => {
  const f = fixture();
  const run = f.turn('goal-background', prompt);
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal x');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual([`turn 1: ${prompt}`, notification, 'turn 3: /goal x']);
  expect(userFrames(f.root)).toEqual([prompt, '/goal x']);
  expect(JSON.parse(readFileSync(join(run.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.03, 10);
});

test('the user command waits for every owed notification turn, not just the first', async () => {
  const f = fixture();
  const run = f.turn('goal-two-notifications', 'background-two');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal x');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual(['turn 1: background-two', 'turn 2: task notified', 'turn 3: task notified', 'turn 4: /goal x']);
  expect(JSON.parse(readFileSync(join(run.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.04, 10);
});

test('interrupting while the user command is queued behind another turn also stops the command when it starts', async () => {
  const f = fixture();
  const run = f.turn('goal-queued-interrupt', 'hidden-turn');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal hold');
  const running = runClaudeHarness(run);
  try {
    for (let i = 0; i < 400 && !(existsSync(f.capture) && userFrames(f.root).includes('/goal hold')); i++) await Bun.sleep(10);
    expect((await control(run.runDir, 'interrupt', { action: 'interrupt' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(events(run.runDir).at(-1).status).toBe('interrupted');
  const interrupts = readFileSync(join(f.root, 'capture.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'control_request' && event.request.subtype === 'interrupt');
  expect(interrupts).toHaveLength(2);
});

test('a steer result and a pending background notification both finish before the user command is sent', async () => {
  const f = fixture();
  const run = f.turn('goal-steer-background', 'background-slow');
  writeFileSync(join(run.runDir, 'user-command.txt'), '/goal x');
  const running = runClaudeHarness(run);
  try {
    expect((await control(run.runDir, 'steer', { action: 'steer', text: 'redirect' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(messages(run.runDir)).toEqual(['turn 1: background-slow', 'turn 2: redirect', 'turn 3: task notified', 'turn 4: /goal x']);
  expect(JSON.parse(readFileSync(join(run.runDir, 'claude-turn-cost.json'), 'utf8')).amount).toBeCloseTo(0.04, 10);
});

test('the slash commands a warm CLI advertised once still gate later runs, and a replaced process starts fresh', async () => {
  const f = fixture();
  const advertised = (list: string[]) => ({ TEST_CLAUDE_SLASH_COMMANDS: JSON.stringify(list) });
  expect(await runClaudeHarness(f.turn('first', 'first', {}, advertised(['reflect'])))).toBe(0);
  const warm = f.turn('warm', 'warm');
  writeFileSync(join(warm.runDir, 'user-command.txt'), '/goal x');
  expect(await runClaudeHarness(warm)).toBe(0);
  expect(messages(warm.runDir)).toEqual(['turn 2: warm']);
  const restarted = f.turn('restarted', 'restarted', { model: 'sonnet' }, advertised(['goal']));
  writeFileSync(join(restarted.runDir, 'user-command.txt'), '/goal x');
  expect(await runClaudeHarness(restarted)).toBe(0);
  expect(f.launches()).toHaveLength(2);
  expect(messages(restarted.runDir)).toEqual(['turn 1: restarted', 'turn 2: /goal x']);
});

test('a result for an earlier queued command does not end the run before its own prompt starts', async () => {
  const f = fixture();
  const run = f.turn('stale-result', 'stale-result');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual(['turn 1: stale-result']);
});

test('a Claude run stays open for the turn started by a finished background agent', async () => {
  const f = fixture();
  const run = f.turn('background', 'background');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual(['turn 1: background', 'turn 2: agent done']);
  const snapshots = events(run.runDir).filter(event => event.type === 'background_tasks').map(event => event.tasks);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0]).toEqual([{ id: 'agent-1', description: 'Fixture agent', startedAt: expect.any(Number) }]);
  expect(snapshots[1]).toEqual([]);
  expect(events(run.runDir).at(-1).status).toBe('completed');
});

test('a Claude run stays open for the notification turn of a task that finished before the result', async () => {
  const f = fixture();
  const run = f.turn('background-early', 'background-early');
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual(['turn 1: background-early', 'turn 2: task notified']);
  expect(events(run.runDir).at(-1).status).toBe('completed');
});

test('stopping a run that waits on background agents ends it and retires the process that runs them', async () => {
  const f = fixture();
  const run = f.turn('background-stop', 'background-stop');
  const running = runClaudeHarness(run);
  try {
    await Bun.sleep(300);
    expect((await control(run.runDir, 'interrupt', { action: 'interrupt' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(events(run.runDir).at(-1).status).toBe('interrupted');
  expect(events(run.runDir).filter(event => event.type === 'background_tasks').at(-1).tasks).toEqual([]);
  expect(isAlive(Number(readFileSync(join(run.runDir, 'pid'), 'utf8')))).toBe(false);
});

test('a run waiting only on a background task that never finishes is abandoned after the idle limit', async () => {
  const f = fixture();
  const run = f.turn('background-stuck', 'background-stop', {}, { CARAPA_BACKGROUND_IDLE_LIMIT_SECONDS: '0.3' });
  expect(await runClaudeHarness(run)).toBe(0);
  expect(messages(run.runDir)).toEqual(['turn 1: background-stop']);
  expect(readFileSync(join(run.runDir, 'agent-stderr.log'), 'utf8')).toContain('abandoned background tasks');
  expect(events(run.runDir).at(-1).status).toBe('completed');
  expect(isAlive(Number(readFileSync(join(run.runDir, 'pid'), 'utf8')))).toBe(false);
});

test('a single background task can be stopped while the run waits, and the run then ends', async () => {
  const f = fixture();
  const run = f.turn('background-stop-task', 'background-stop');
  const running = runClaudeHarness(run);
  try {
    await Bun.sleep(300);
    expect((await control(run.runDir, 'stop-task', { action: 'stopTask', taskId: 'agent-1' })).ok).toBe(true);
    expect(await running).toBe(0);
  } finally { await running; }
  expect(messages(run.runDir)).toEqual(['turn 1: background-stop', 'turn 2: task stopped']);
  const snapshots = events(run.runDir).filter(event => event.type === 'background_tasks').map(event => event.tasks);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0][0]).toMatchObject({ id: 'agent-1', description: 'Fixture agent' });
  expect(typeof snapshots[0][0].startedAt).toBe('number');
  expect(snapshots[1]).toEqual([]);
  expect(events(run.runDir).at(-1).status).toBe('completed');
});
