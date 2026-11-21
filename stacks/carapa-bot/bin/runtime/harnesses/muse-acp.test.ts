import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../contracts';
import { museAcpContract } from './muse-acp';
import { RunV1Writer } from '../run-v1';

const root = mkdtempSync(join(tmpdir(), 'carapa-muse-acp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Fake `muse`: logs its arguments; FAIL_REJECT makes that reminder's reject fail. */
function fakeMuse(name: string, failReject = ''): { cli: string; log: string } {
  const cli = join(root, `${name}-muse`);
  const log = join(root, `${name}-muse.log`);
  writeFileSync(cli, `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = --version ] && echo 'Muse Code 1.4.8'\n[ "$3" = '${failReject}' ] && exit 1\nexit 0\n`);
  chmodSync(cli, 0o755);
  return { cli, log };
}
const calls = (log: string) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];

function context(home: string, args: Partial<RunContext['args']> = {}): RunContext {
  return {
    runDir: join(root, 'run'), prompt: 'task', cwd: root, runTag: 'run', binDir: root,
    env: { HOME: home },
    args: {
      agentCmd: 'muse-acp', sessionId: '', forkSession: '', model: '', fallbackModel: '',
      reasoningEffort: '', fallbackReasoningEffort: '', chatMode: '', agent: '', bare: '',
      systemPrompt: '', workDir: '', conversationKey: '', persistent: '', conversationId: '',
      env: {}, ...args,
    },
  };
}

test('routes Muse through the relay with a placeholder login and never lets it train on the workspace', () => {
  const run = context(join(root, 'home'), { systemPrompt: 'rules' });
  run.runDir = join(root, 'ipc', 'runs', 'run');
  run.env.META_API_KEY = 'must-not-reach-muse';
  run.env.MUSE_CLI = fakeMuse('relay').cli;
  museAcpContract.prepare!(run);
  expect(run.env.META_API_KEY).toBeUndefined();
  const login = JSON.parse(readFileSync(join(run.env.XDG_CONFIG_HOME!, 'muse', 'auth.json'), 'utf8')).providers.meta;
  expect(login).toMatchObject({ api_key: 'carapa-relay', api_base_url: 'http://api-relay:8080/meta/v1' });
  expect(run.prompt).toBe('rules\n\nUser request:\ntask');
  const env = museAcpContract.process(run).env!;
  expect(env.MUSE_SERVE_ARGS).toContain('--contributor-mode off');
  expect(env.MUSE_APPROVAL_MODE).toBe('allowAll');
});

test('resets Plan mode every turn and only resends changed model or reasoning', () => {
  const run = context(root, { model: 'muse-wonder-1.0', reasoningEffort: 'high', chatMode: 'plan' });
  const values = (current?: Parameters<NonNullable<typeof museAcpContract.configure>>[2]) =>
    museAcpContract.configure!(run, 's', current).map((request) => {
      const params = request.params as { configId: string; value: string };
      return `${params.configId}=${params.value}`;
    });
  expect(values()).toEqual(['mode=plan', 'model=muse-wonder-1.0', 'reasoning_effort=high']);
  run.args.chatMode = '';
  expect(values({ newDaemon: false, model: 'muse-wonder-1.0', thinking: 'high' })).toEqual(['mode=default']);
});

test('does not attach a Board MCP server the trusted workspace already declares', () => {
  const servers = [{ name: 'carapa-board' }, { name: 'other' }];
  const workspace = join(root, 'workspace-with-mcp');
  mkdirSync(workspace);
  expect(museAcpContract.sessionMcpServers!({ ...context(root), cwd: workspace }, servers)).toEqual(servers);
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { 'carapa-board': { type: 'http' } } }));
  expect(museAcpContract.sessionMcpServers!({ ...context(root), cwd: workspace }, servers)).toEqual([{ name: 'other' }]);
});

test('records Muse turn usage as fresh input plus cache reads', () => {
  const runDir = join(root, 'usage-run');
  mkdirSync(runDir);
  const writer = new RunV1Writer(runDir, { format: 'carapa-run', version: 1, harness: 'muse-acp', requestedModel: 'muse-wonder-1.0' });
  const v1 = museAcpContract.createV1!({ ...context(root), runDir }, writer, false);
  v1.start('session');
  v1.result!({ stopReason: 'end_turn', usage: { totalTokens: 42780, inputTokens: 42738, outputTokens: 42,
    thoughtTokens: 16, cachedReadTokens: 42484, cachedWriteTokens: 0 } });
  v1.finish(0);
  const events = readFileSync(join(runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', scope: 'incremental',
    inputTokens: 254, outputTokens: 42, cachedInputTokens: 42484, reasoningOutputTokens: 16 }]);
});

test('disables every Muse reminder once per Muse version and refuses to run with memory on', () => {
  const run = (name: string, muse: string) => {
    const value = context(root, { conversationKey: name });
    value.runDir = join(root, 'ipc', 'runs', name);
    value.env.MUSE_CLI = muse;
    museAcpContract.prepare!(value);
  };
  const muse = fakeMuse('reminders');
  run('conversation-a', muse.cli);
  expect(calls(muse.log).filter((line) => line.startsWith('plugins reject'))).toEqual([
    'plugins reject memory-reminder', 'plugins reject skill-reminder', 'plugins reject todo-reminder',
    'plugins reject goal-reminder', 'plugins reject verify-reminder', 'plugins reject scope-reminder']);
  run('conversation-a', muse.cli);
  expect(calls(muse.log).filter((line) => line.startsWith('plugins reject'))).toHaveLength(6);

  expect(() => run('conversation-b', fakeMuse('memory-stays-on', 'memory-reminder').cli)).toThrow(/memory reminder/);
});

test('retries a Muse reminder reject on the next turn after a transient failure', () => {
  const run = () => {
    const value = context(root, { conversationKey: 'transient' });
    value.runDir = join(root, 'ipc', 'runs', 'transient');
    value.env.MUSE_CLI = join(root, 'transient-muse');
    museAcpContract.prepare!(value);
  };
  const rejects = () => calls(join(root, 'transient-muse.log')).filter((line) => line.startsWith('plugins reject'));
  fakeMuse('transient', 'skill-reminder');
  run();
  expect(rejects()).toHaveLength(6);
  fakeMuse('transient');
  run();
  expect(rejects()).toHaveLength(12);
  run();
  expect(rejects()).toHaveLength(12);
});
