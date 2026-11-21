#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRunContext } from './contracts';
import { executeRun, writeFailedRun } from './runner';
import { startCgroupSnapshots } from './watchers';
import { stopRun } from './stop';
import { controlRun, type LifecycleAction } from './control';
import { containerInstanceId, isAlive, matchesCurrentInstance } from './processes';
import { readOwnedPid, readText } from './sessions';

const mainPath = fileURLToPath(import.meta.url);
const binDir = resolve(dirname(mainPath), '..');

// The holder may release the lock between our EEXIST and this stat; a vanished lock is just free.
function lockMtimeMs(claim: string): number {
  try { return statSync(claim).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Date.now(); throw error; }
}

async function launch(runDirInput: string): Promise<number> {
  const context = createRunContext(runDirInput, binDir);
  const claim = join(context.runDir, 'launch.lock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try { mkdirSync(claim); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwnedPid(join(claim, 'pid'));
      if ((owner !== undefined && !isAlive(owner)) || (owner === undefined && Date.now() - lockMtimeMs(claim) > 5_000)) { rmSync(claim, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error('Run launch lock timed out');
      await Bun.sleep(10);
    }
  }
  writeFileSync(join(claim, 'pid'), String(process.pid));
  try {
    const previous = readOwnedPid(join(context.runDir, 'worker.pid'));
    if (previous !== undefined && matchesCurrentInstance(join(context.runDir, 'session_instance'), readText(join(context.runDir, 'session_instance'))) &&
        (isAlive(previous) || existsSync(join(context.runDir, 'metrics_complete')))) return previous;
    const stderrFd = openSync(join(context.runDir, 'agent-stderr.log'), 'a');
    const child = spawn(process.execPath, ['--no-env-file', mainPath, 'worker', context.runDir, context.cwd], {
      cwd: context.cwd, env: process.env, detached: true, stdio: ['ignore', stderrFd, stderrFd],
    });
    closeSync(stderrFd);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (!child.pid) throw new Error('failed to start agent runtime worker');
    writeFileSync(join(context.runDir, 'worker.pid'), String(child.pid));
    writeFileSync(join(context.runDir, 'session_instance'), containerInstanceId());
    // Harnesses replace pid with their active process; worker.pid retains the owner.
    writeFileSync(join(context.runDir, 'pid'), String(child.pid));
    child.unref();
    return child.pid;
  } finally { rmSync(claim, { recursive: true, force: true }); }
}

async function execute(runDirInput: string, resolvedWorkDir?: string): Promise<void> {
  const context = createRunContext(runDirInput, binDir, resolvedWorkDir);
  const snapshots = startCgroupSnapshots(context);
  try { process.exitCode = (await executeRun(context)) === 0 ? 0 : 1; }
  catch (error) { writeFailedRun(context, error); process.exitCode = 1; }
  finally { snapshots.stop(); }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const runDir = process.argv[3];
  if (!action || !runDir) throw new Error('usage: main.ts <run|execute|worker|stop|control> <run-dir> [pid|action]');
  if (action === 'run') { process.stdout.write(`${await launch(runDir)}\n`); return; }
  if (action === 'worker') {
    // The launch claim publishes the worker identity before any harness can replace pid.
    const claim = join(runDir, 'launch.lock');
    while (existsSync(claim)) {
      const owner = readOwnedPid(join(claim, 'pid'));
      if (owner !== undefined && !isAlive(owner)) break;
      await Bun.sleep(10);
    }
    if (readOwnedPid(join(runDir, 'worker.pid')) !== process.pid) throw new Error('Worker launch was not committed');
    return execute(runDir, process.argv[4]);
  }
  if (action === 'execute') {
    // --exec is an attached waiter only. Disconnecting its caller cannot kill the worker.
    const worker = await launch(runDir);
    while (!existsSync(join(runDir, 'metrics_complete')) && isAlive(worker)) await Bun.sleep(25);
    process.exitCode = readText(join(runDir, 'exit_code')) === '0' ? 0 : 1;
    return;
  }
  if (action === 'control') {
    const result = await controlRun(runDir, process.argv[4] as LifecycleAction);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (action === 'stop') {
    const result = await stopRun(runDir, process.argv[4]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'failed' ? 1 : 0;
    return;
  }
  throw new Error(`Unknown runtime action: ${action}`);
}

main().catch(error => {
  process.stderr.write(`agent-runtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
