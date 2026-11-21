import type { WriteStream } from 'node:fs';
import { listProcessGroupPids, signalProcessGroupMembers } from '../processes';

function signalGroup(pid: number, signal: NodeJS.Signals, stderr: WriteStream): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      stderr.write(`failed to send ${signal} to Codex process group: ${error}\n`);
      try {
        process.kill(pid, signal);
      } catch {
        // The direct child may have exited after the process-group check.
      }
    }
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (check() && Date.now() < deadline) await Bun.sleep(50);
  return !check();
}

export async function cleanupCodexProcesses(
  childPid: number,
  _runTag: string,
  stderr: WriteStream,
): Promise<void> {
  signalGroup(childPid, 'SIGTERM', stderr);
  if (!(await waitUntil(() => groupExists(childPid), 2_000))) {
    stderr.write('Codex process group did not exit after SIGTERM; sending SIGKILL\n');
    signalGroup(childPid, 'SIGKILL', stderr);
    if (!(await waitUntil(() => groupExists(childPid), 2_000))) {
      stderr.write('Codex process group still did not report exit after SIGKILL\n');
    }
  }

  const groupMembersRemain = (): boolean =>
    listProcessGroupPids(childPid, [process.pid]).length > 0;
  signalProcessGroupMembers(childPid, 'SIGTERM', [process.pid]);
  if (!(await waitUntil(groupMembersRemain, 2_000))) {
    stderr.write('Escaped run processes did not exit after SIGTERM; sending SIGKILL\n');
    signalProcessGroupMembers(childPid, 'SIGKILL', [process.pid]);
    if (!(await waitUntil(groupMembersRemain, 2_000))) {
      stderr.write('Escaped run processes still did not report exit after SIGKILL\n');
    }
  }
}
