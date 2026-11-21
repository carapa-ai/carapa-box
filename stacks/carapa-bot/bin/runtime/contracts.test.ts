import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunContext } from './contracts';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runDir(args: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'carapa-runtime-contract-'));
  temporary.push(root);
  const run = join(root, 'run');
  const work = join(root, 'work');
  mkdirSync(run);
  mkdirSync(work);
  writeFileSync(join(run, 'args.json'), JSON.stringify({ workDir: work, ...args }));
  writeFileSync(join(run, 'prompt.txt'), 'hello');
  return run;
}

describe('run contracts', () => {
  test('normalizes optional fields and protects the controller-owned run tag', () => {
    const run = runDir({
      agentCmd: 'claude',
      env: {
        CARAPA_AGENT_RUN_ID: 'attacker',
        FEATURE: 7,
        GIT_DIR: '/stale/git-dir',
        GIT_WORK_TREE: '/stale/worktree',
        GIT_INDEX_FILE: '/stale/index',
      },
    });
    const context = createRunContext(run, '/trusted/bin');
    expect(context.args.sessionId).toBe('');
    expect(context.env.FEATURE).toBe('7');
    expect(context.env.CARAPA_AGENT_RUN_ID).toBe('run_');
    expect(context.env.GIT_DIR).toBeUndefined();
    expect(context.env.GIT_WORK_TREE).toBeUndefined();
    expect(context.env.GIT_INDEX_FILE).toBeUndefined();
    expect(context.prompt).toBe('hello');
  });

  test('passes the input prompt unchanged when browser sessions are assigned', () => {
    for (const env of [
      { CARAPA_BROWSER_SESSION_ID: 'conversation-browser' },
      { CARAPA_BROWSER_RUN_ID: 'task-browser' },
    ]) {
      const run = runDir({ agentCmd: 'claude', env });
      expect(createRunContext(run, '/trusted/bin').prompt).toBe('hello');
    }
  });

  test('rejects environment names that cannot be passed safely', () => {
    const run = runDir({ agentCmd: 'claude', env: { 'BAD=NAME': 'value' } });
    expect(() => createRunContext(run, '/trusted/bin')).toThrow('invalid environment variable name');
  });
});
