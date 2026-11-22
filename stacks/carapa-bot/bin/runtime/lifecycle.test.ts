import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isAlive } from './processes';
import { awaitWorkerMetrics, stopRun } from './stop';

const roots: string[] = [];
const runtimeDir = import.meta.dir;
const binDir = resolve(runtimeDir, '..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(agentCmd = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'carapa-runtime-lifecycle-'));
  roots.push(root);
  const runDir = join(root, 'run');
  const workDir = join(root, '.worktrees', 'task');
  const fakeBin = join(root, 'bin');
  mkdirSync(runDir);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(fakeBin);
  const argsFile = join(root, 'received-args');
  const promptFile = join(root, 'received-prompt');
  const envProbeFile = join(root, 'received-env-probe');
  const fakeClaude = join(fakeBin, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nprintf %s "${CARAPA_DOTENV_PROBE-unset}" > "$FAKE_ENV_PROBE_FILE"\nexec "$TEST_BUN" "$TEST_CLAUDE_PEER" "$@"\n');
  chmodSync(fakeClaude, 0o755);
  writeFileSync(
    join(runDir, 'args.json'),
    JSON.stringify({
      agentCmd,
      workDir: '.worktrees/task',
      metricsContract: 1,
      env: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        TEST_BUN: process.execPath,
        TEST_CLAUDE_PEER: join(runtimeDir, 'protocol/fixtures/claude-peer.ts'),
        CARAPA_RUN_MEMORY_LIMIT_MIB: '0',
        FAKE_ARGS_FILE: argsFile,
        FAKE_PROMPT_FILE: promptFile,
        FAKE_ENV_PROBE_FILE: envProbeFile,
      },
    }),
  );
  writeFileSync(join(runDir, 'prompt.txt'), 'prompt over stdin');
  return { root, runDir, workDir, argsFile, promptFile, envProbeFile };
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('lifecycle runtime', () => {
  test.each(['lingering', 'exited', 'failed'] as const)('OpenCode finalizes its response when the CLI has %s', async (mode) => {
    const value = fixture('opencode');
    const argsPath = join(value.runDir, 'args.json');
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    args.workDir = join(value.root, args.workDir);
    writeFileSync(argsPath, JSON.stringify(args));
    const executable = join(value.root, 'bin', 'opencode');
    writeFileSync(executable, `#!${process.execPath}
if (process.argv[2] === 'export') {
  await Bun.sleep(200);
  console.log(JSON.stringify({ messages: [{ info: { role: 'assistant', providerID: 'test', modelID: 'resolved-model' } }] }));
} else {
  const emit = (event) => console.log(JSON.stringify({ sessionID: 'ses-opencode', ...event }));
  emit({ type: 'step_start' });
  emit({ type: 'step_finish', part: { reason: 'tool-calls' } });
  await Bun.sleep(200);
  emit({ type: 'text', part: { text: 'Hi Sam! What can I help you with?' } });
  emit({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 12007, output: 13 } } });
  if (${JSON.stringify(mode)} === 'lingering') setInterval(() => {}, 1000);
  if (${JSON.stringify(mode)} === 'failed') process.exitCode = 7;
}
`);
    chmodSync(executable, 0o755);
    const wrapper = spawn(join(binDir, 'run-agent.sh'), [value.runDir], {
      cwd: value.root,
      env: process.env,
      stdio: 'ignore',
    });
    try {
      const wrapperCode = await new Promise<number>((resolveCode) =>
        wrapper.once('exit', (code) => resolveCode(code ?? 1)),
      );
      expect(wrapperCode).toBe(0);
      await waitFor(join(value.runDir, 'metrics_complete'));
      expect(readFileSync(join(value.runDir, 'agent-stderr.log'), 'utf8')).toBe('');
      expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe(mode === 'failed' ? '7' : '0');
      const output = readFileSync(join(value.runDir, 'output.v1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(output).toContainEqual({ type: 'session', id: 'ses-opencode', status: 'started' });
      expect(output).toContainEqual({ type: 'run', status: 'in_progress', model: 'resolved-model' });
      expect(output).toContainEqual({ type: 'usage', scope: 'incremental', inputTokens: 12007, outputTokens: 13 });
      expect(output.find(event => event.type === 'message')).toMatchObject({ content: 'Hi Sam! What can I help you with?', status: mode === 'failed' ? 'interrupted' : 'completed' });
      expect(output.filter(event => event.type === 'run' && ['completed', 'failed', 'interrupted'].includes(event.status))).toEqual([
        { type: 'run', status: mode === 'failed' ? 'failed' : 'completed', stopReason: mode === 'failed' ? 'process_exit' : 'stop' },
      ]);
    } finally {
      if (existsSync(join(value.runDir, 'pid'))) {
        await stopRun(value.runDir, readFileSync(join(value.runDir, 'pid'), 'utf8').trim());
      }
    }
  });

  test('the public wrapper launches a fresh Claude stream and preserves run artifacts', async () => {
    const value = fixture();
    // Bun auto-loads .env from its cwd; a project's .env must not configure the harness.
    for (const dir of [value.root, value.workDir]) writeFileSync(join(dir, '.env'), 'CARAPA_DOTENV_PROBE=leaked\n');
    const wrapper = spawn(join(binDir, 'run-agent.sh'), [value.runDir], {
      cwd: value.root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    wrapper.stdout.on('data', (chunk) => stdout.push(chunk));
    const wrapperCode = await new Promise<number>((resolveCode) =>
      wrapper.once('exit', (code) => resolveCode(code ?? 1)),
    );
    expect(wrapperCode).toBe(0);
    expect(Buffer.concat(stdout).toString()).toMatch(/^\d+\n$/);
    await waitFor(join(value.runDir, 'metrics_complete'));
    expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe('0');
    expect(readFileSync(value.promptFile, 'utf8')).toBe('prompt over stdin');
    expect(readFileSync(value.envProbeFile, 'utf8')).toBe('unset');
    expect(readFileSync(value.argsFile, 'utf8')).toContain('--output-format');
    expect(readFileSync(join(value.runDir, 'output.v1.jsonl'), 'utf8')).toContain('"type":"session"');
    expect(JSON.parse(readFileSync(join(value.runDir, 'metrics.json'), 'utf8')).harness).toBe('claude');
  });

  test('stop detects graceful exit without unconditional two-second sleeps', async () => {
    const value = fixture();
    const child = Bun.spawn(['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'], {
      detached: true,
      env: { ...process.env, CARAPA_AGENT_RUN_ID: 'run_' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFileSync(join(value.runDir, 'pid'), String(child.pid));
    writeFileSync(join(value.runDir, 'pgid'), String(child.pid));
    const started = Date.now();
    const result = await stopRun(value.runDir, String(child.pid));
    expect(result.status).toBe('killed');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe('137');
    expect(readFileSync(join(value.runDir, 'metrics_complete'), 'utf8')).toBe('stopped');
  });

  test('stop waits for the detached worker to write metrics before completing', async () => {
    const value = fixture();
    const harness = Bun.spawn(['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'], {
      detached: true,
      env: { ...process.env, CARAPA_AGENT_RUN_ID: 'run_' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFileSync(join(value.runDir, 'pid'), String(harness.pid));
    writeFileSync(join(value.runDir, 'pgid'), String(harness.pid));
    const script = [
      'while kill -0 "$1" 2>/dev/null; do sleep 0.05; done',
      'sleep 0.3',
      'printf %s \'{"status":"stopped"}\' > "$2/metrics.json"',
      'printf %s 143 > "$2/exit_code"',
      'printf %s ok > "$2/metrics_complete"',
    ].join('\n');
    const worker = Bun.spawn(['sh', '-c', script, 'sh', String(harness.pid), value.runDir], {
      detached: true,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFileSync(join(value.runDir, 'worker.pid'), String(worker.pid));

    const result = await stopRun(value.runDir, String(harness.pid));

    expect(result.status).toBe('killed');
    expect(existsSync(join(value.runDir, 'metrics.json'))).toBe(true);
    expect(readFileSync(join(value.runDir, 'metrics_complete'), 'utf8')).toBe('ok');
    expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe('143');
  });

  test.each(['absent', 'dead'] as const)('stop does not wait for a %s worker', async (mode) => {
    const value = fixture();
    const harness = Bun.spawn(['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'], {
      detached: true,
      env: { ...process.env, CARAPA_AGENT_RUN_ID: 'run_' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFileSync(join(value.runDir, 'pid'), String(harness.pid));
    writeFileSync(join(value.runDir, 'pgid'), String(harness.pid));
    if (mode === 'dead') {
      const dead = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
      await dead.exited;
      writeFileSync(join(value.runDir, 'worker.pid'), String(dead.pid));
    }
    const started = Date.now();
    const result = await stopRun(value.runDir, String(harness.pid));
    expect(result.status).toBe('killed');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe('137');
    expect(readFileSync(join(value.runDir, 'metrics_complete'), 'utf8')).toBe('stopped');
  });

  test('awaitWorkerMetrics is bounded when a live worker never writes metrics_complete', async () => {
    const value = fixture();
    const worker = Bun.spawn(['sh', '-c', 'while :; do sleep 1; done'], {
      detached: true,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      writeFileSync(join(value.runDir, 'worker.pid'), String(worker.pid));
      const started = Date.now();
      await awaitWorkerMetrics(value.runDir, 300);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1_500);
      expect(existsSync(join(value.runDir, 'metrics_complete'))).toBe(false);
    } finally {
      worker.kill('SIGKILL');
    }
  });

  test('stop preserves a finalized turn while terminating its warm daemon', async () => {
    const value = fixture('codex');
    const sessionDir = join(value.root, 'session');
    mkdirSync(sessionDir);
    const daemon = Bun.spawn(
      ['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'],
      {
        detached: true,
        env: { ...process.env, CARAPA_AGENT_RUN_ID: 'run_' },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    writeFileSync(join(value.runDir, 'pid'), String(daemon.pid));
    writeFileSync(join(value.runDir, 'session_dir'), sessionDir);
    writeFileSync(join(sessionDir, 'daemon.pid'), String(daemon.pid));
    writeFileSync(join(value.runDir, 'exit_code'), '0');
    writeFileSync(join(value.runDir, 'metrics_complete'), 'ok');
    writeFileSync(
      join(value.runDir, 'metrics.json'),
      JSON.stringify({ exitCode: 0, status: 'success' }),
    );

    const result = await stopRun(value.runDir, String(daemon.pid));

    expect(['killed', 'already_dead']).toContain(result.status);
    expect(readFileSync(join(value.runDir, 'exit_code'), 'utf8')).toBe('0');
    expect(readFileSync(join(value.runDir, 'metrics_complete'), 'utf8')).toBe('ok');
    expect(JSON.parse(readFileSync(join(value.runDir, 'metrics.json'), 'utf8')).status).toBe(
      'success',
    );
    expect(existsSync(join(sessionDir, 'daemon.pid'))).toBe(false);
  });

  test('stop terminates descendants of a warm daemon that is not a process-group leader', async () => {
    const value = fixture('codex');
    const sessionDir = join(value.root, 'session');
    const childPidFile = join(value.root, 'daemon-child.pid');
    mkdirSync(sessionDir);
    const daemon = Bun.spawn(
      ['sh', '-c', `sleep 300 & echo $! > "${childPidFile}"; wait`],
      {
        env: { ...process.env, CARAPA_AGENT_RUN_ID: 'run_' },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    writeFileSync(join(value.runDir, 'pid'), String(daemon.pid));
    writeFileSync(join(value.runDir, 'session_dir'), sessionDir);
    writeFileSync(join(sessionDir, 'daemon.pid'), String(daemon.pid));
    await waitFor(childPidFile);
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
    expect(isAlive(daemon.pid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    const result = await stopRun(value.runDir, String(daemon.pid));

    expect(['killed', 'already_dead']).toContain(result.status);
    expect(isAlive(daemon.pid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(existsSync(join(sessionDir, 'daemon.pid'))).toBe(false);
  });
});
