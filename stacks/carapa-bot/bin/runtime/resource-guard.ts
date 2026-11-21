import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './contracts';
import { processGroupMemoryKiB, signalPid, signalProcessGroupMembers } from './processes';

export interface ResourceGuard {
  stop(): void;
}

export function startResourceGuard(context: RunContext, leaderPid: number): ResourceGuard {
  const limitMiB = Number(context.env.CARAPA_RUN_MEMORY_LIMIT_MIB || 6144);
  const pollSeconds = Math.max(1, Number(context.env.CARAPA_RUN_MEMORY_POLL_SECONDS || 2));
  if (!Number.isFinite(limitMiB) || limitMiB <= 0) return { stop() {} };

  let handling = false;
  const interval = setInterval(async () => {
    if (handling) return;
    const memory = processGroupMemoryKiB(leaderPid);
    if (memory <= limitMiB * 1024) return;
    handling = true;
    const marker = join(context.runDir, 'resource_limit');
    writeFileSync(marker, 'memory_limit\n');
    appendFileSync(
      join(context.runDir, 'memory-pressure.log'),
      `memory limit exceeded: pgid=${leaderPid} rss_kib=${memory} limit_mib=${limitMiB}\n`,
    );
    signalProcessGroupMembers(leaderPid, 'SIGTERM', [leaderPid, process.pid]);
    await Bun.sleep(1_000);
    signalProcessGroupMembers(leaderPid, 'SIGKILL', [leaderPid, process.pid]);
    let recoveredMemory = processGroupMemoryKiB(leaderPid);
    for (let attempt = 0; attempt < 4 && recoveredMemory >= limitMiB * 1024; attempt += 1) {
      await Bun.sleep(1_000);
      recoveredMemory = processGroupMemoryKiB(leaderPid);
    }
    if (recoveredMemory < limitMiB * 1024) {
      writeFileSync(
        join(context.runDir, 'resource_limit_recovered'),
        `tool_processes_terminated used_kib=${recoveredMemory}\n`,
      );
      appendFileSync(join(context.runDir, 'memory-pressure.log'),
        `memory recovered after terminating tagged tool processes: used_kib=${recoveredMemory}\n`);
    } else {
      appendFileSync(
        join(context.runDir, 'memory-pressure.log'),
        'memory remained above limit after tool cleanup; terminating run leader\n',
      );
      signalPid(leaderPid, 'SIGTERM');
      await Bun.sleep(1_000);
      signalPid(leaderPid, 'SIGKILL');
    }
    handling = false;
  }, pollSeconds * 1_000);
  interval.unref();
  return { stop: () => clearInterval(interval) };
}

export function resourceAdjustedExitCode(runDir: string, exitCode: number): number {
  if (existsSync(join(runDir, 'resource_limit')) && !existsSync(join(runDir, 'resource_limit_recovered'))) {
    appendFileSync(
      join(runDir, 'agent-stderr.log'),
      'run-agent: per-run memory limit exceeded; see memory-pressure.log\n',
    );
    return 137;
  }
  if (existsSync(join(runDir, 'resource_limit_recovered'))) {
    appendFileSync(
      join(runDir, 'agent-stderr.log'),
      'run-agent: tool processes exceeded the per-run memory limit and were terminated; see memory-pressure.log\n',
    );
  }
  return exitCode;
}
