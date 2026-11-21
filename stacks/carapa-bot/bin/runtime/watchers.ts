import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './files';
import type { RunContext } from './contracts';
import { isAlive, terminateOwnedRun } from './processes';

export interface Watchers {
  stop(): void;
}

const outputRetryable = /"(?:api_)?error_status":(?:429|503|529)/;
const outputFatal = /"(?:api_)?error_status":[45]\d\d|"error":"unknown"/;
const stderrRetryable = /API Error: (?:429|503|529)/;
const stderrFatal = /API Error: [45]\d\d/;

export function shouldStopOnApiError(output: string, stderr: string): boolean {
  return (outputFatal.test(output) || stderrFatal.test(stderr))
    && !(outputRetryable.test(output) || stderrRetryable.test(stderr));
}

export function startWatchers(
  context: RunContext,
  pid: number,
): Watchers {
  const intervals: Timer[] = [];
  let stopping = false;
  const stop = async () => {
    if (stopping || !isAlive(pid)) return;
    stopping = true;
    await terminateOwnedRun(pid, { processGroup: true, exclude: [process.pid] });
  };

  const errorTimer = setInterval(() => {
    if (!isAlive(pid)) return;
    const output = safeRead(join(context.runDir, 'output.jsonl'));
    const stderr = safeRead(join(context.runDir, 'agent-stderr.log'));
    if (shouldStopOnApiError(output, stderr)) void stop();
  }, 2_000);
  errorTimer.unref();
  intervals.push(errorTimer);

  return {
    stop() {
      for (const interval of intervals) clearInterval(interval);
    },
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The detached worker owns diagnostics, so launcher disconnects cannot stop them. */
export function startCgroupSnapshots(context: RunContext): Watchers {
  const snapshot = () => {
    let text = `timestamp=${new Date().toISOString()} pid=${process.pid}\n`;
    for (const file of ['memory.current', 'memory.max', 'memory.events', 'memory.events.local', 'pids.current', 'pids.max']) {
      const content = safeRead(`/sys/fs/cgroup/${file}`);
      if (content) text += `[${file}]\n${content}`;
    }
    try { atomicWrite(join(context.runDir, 'cgroup-snapshot.log'), text); }
    catch { /* Diagnostics must not fail the agent turn. */ }
  };
  snapshot();
  const seconds = Number(context.env.CARAPA_RUN_MEMORY_POLL_SECONDS || 2);
  const interval = setInterval(snapshot, (Number.isFinite(seconds) ? Math.max(1, seconds) : 2) * 1_000);
  interval.unref();
  return { stop() { clearInterval(interval); snapshot(); } };
}
