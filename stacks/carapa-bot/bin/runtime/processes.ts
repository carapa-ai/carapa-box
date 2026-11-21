import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readFileSync, readdirSync, statSync } from 'node:fs';
const numeric = /^\d+$/;

// Containers and Linux hosts read procfs. A native runner on macOS has no
// procfs and runs inside a Seatbelt sandbox that can neither execute the
// setuid ps(1) nor reach pgrep's sysmond service, so it reads the kern.proc
// sysctls (allowed by the profile) directly.
const procfs = (): boolean => process.platform === 'linux';

interface DarwinProc {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

// struct kinfo_proc on 64-bit macOS: kp_proc.p_stat, kp_proc.p_pid,
// kp_eproc.e_ppid and kp_eproc.e_pgid.
const KINFO_PROC_SIZE = 648;
const P_STAT = 36;
const P_PID = 40;
const E_PPID = 560;
const E_PGID = 564;
const SZOMB = 5;
const [CTL_KERN, KERN_PROC, KERN_PROC_ALL, KERN_PROC_PGRP, KERN_PROC_PID] = [1, 14, 0, 2, 1];

let darwinSysctl: ((name: number, namelen: number, oldp: number | null, oldlenp: number, newp: null, newlen: number) => number) | undefined;

/** Processes matching a kern.proc query, or null when the query failed. */
function darwinProcs(mib: number[]): DarwinProc[] | null {
  if (!darwinSysctl) {
    const library = dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    darwinSysctl = library.symbols.sysctl as unknown as typeof darwinSysctl;
  }
  const name = new Int32Array(mib);
  const length = new BigUint64Array(1);
  if (darwinSysctl!(ptr(name), mib.length, null, ptr(length), null, 0) !== 0) return null;
  // Headroom for processes started between the size query and the read.
  const buffer = new Uint8Array(Number(length[0]) + 32 * KINFO_PROC_SIZE);
  length[0] = BigInt(buffer.byteLength);
  if (darwinSysctl!(ptr(name), mib.length, ptr(buffer), ptr(length), null, 0) !== 0) return null;
  const view = new DataView(buffer.buffer);
  const procs: DarwinProc[] = [];
  for (let offset = 0; offset + KINFO_PROC_SIZE <= Number(length[0]); offset += KINFO_PROC_SIZE) {
    procs.push({
      pid: view.getInt32(offset + P_PID, true),
      ppid: view.getInt32(offset + E_PPID, true),
      pgid: view.getInt32(offset + E_PGID, true),
      zombie: view.getInt8(offset + P_STAT) === SZOMB,
    });
  }
  return procs;
}

export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (!procfs()) {
      // The signal probe succeeded; an unreadable process table cannot overrule it.
      const procs = darwinProcs([CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]);
      return procs === null || procs.some((proc) => !proc.zombie);
    }
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return !/^State:\s+Z/m.test(status);
  } catch {
    return false;
  }
}

export function containerInstanceId(): string {
  if (!procfs()) {
    // PIDs are only meaningful within one boot, as within one container. The
    // native runner passes its boot time: its OS sandbox hides kern.boottime.
    if (process.env.CARAPA_RUNTIME_INSTANCE) return process.env.CARAPA_RUNTIME_INSTANCE;
    const boot = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'kern.boottime'], { stdout: 'pipe', stderr: 'ignore' });
    return /sec = (\d+)/.exec(boot.stdout.toString())?.[1] ?? '';
  }
  try {
    const stat = readFileSync('/proc/1/stat', 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    return stat.slice(close + 2).trim().split(/\s+/)[19] ?? '';
  } catch {
    return '';
  }
}

/**
 * Wall-clock ms when this container's clock booted, or 0 when unknown. A
 * sandbox with its own boot clock (gVisor) starts PID 1 at the same tick on
 * every restart, so the instance id alone cannot tell restarts apart.
 */
function containerBootMs(): number {
  if (!procfs()) return 0;
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
    return btime ? Number(btime) * 1000 : 0;
  } catch {
    return 0;
  }
}

/** True when `path` was last written before this container booted (a lock left by an earlier run). */
export function writtenBeforeBoot(path: string, bootMs: number = containerBootMs()): boolean {
  if (!bootMs) return false;
  try {
    return statSync(path).mtimeMs < bootMs;
  } catch {
    return false;
  }
}

/** True when `path` records this container's instance and was written after it booted. */
export function matchesCurrentInstance(path: string, recorded: string): boolean {
  if (!recorded || recorded !== containerInstanceId()) return false;
  try {
    return statSync(path).mtimeMs >= containerBootMs();
  } catch {
    return false;
  }
}

function processGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

function parentProcessId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Snapshot a process tree below `rootPid`, ordered deepest child first. Warm
 * daemons inherited from the Bash runtime are not consistently process-group
 * leaders, so their descendants cannot be found by PGID alone.
 */
export function listDescendantPids(rootPid: number): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const children = new Map<number, number[]>();
  const addChild = (pid: number, ppid: number): void => {
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  };
  if (!procfs()) {
    for (const proc of darwinProcs([CTL_KERN, KERN_PROC, KERN_PROC_ALL]) ?? []) addChild(proc.pid, proc.ppid);
  } else {
    let entries: string[] = [];
    try {
      entries = readdirSync('/proc');
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!numeric.test(entry)) continue;
      const pid = Number(entry);
      const ppid = parentProcessId(pid);
      if (ppid !== null) addChild(pid, ppid);
    }
  }

  const result: number[] = [];
  const visited = new Set<number>([rootPid]);
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      visit(child);
      result.push(child);
    }
  };
  visit(rootPid);
  return result;
}

/**
 * List members of a run-owned process group without inspecting process
 * environments. Agent AppArmor profiles intentionally deny process environ
 * so one concurrent run cannot read another run's scoped credentials.
 */
export function listProcessGroupPids(pgid: number, exclude: number[] = []): number[] {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return [];
  const excluded = new Set(exclude);
  if (!procfs()) {
    return (darwinProcs([CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid]) ?? [])
      .map((proc) => proc.pid)
      .filter((pid) => !excluded.has(pid));
  }
  const result: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!numeric.test(entry)) continue;
    const pid = Number(entry);
    if (excluded.has(pid)) continue;
    if (processGroupId(pid) === pgid) result.push(pid);
  }
  return result;
}

export function residentMemoryKiB(pid: number): number {
  // Resident memory is not exposed by kern.proc; the memory guard is inert on macOS.
  if (!procfs()) return 0;
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)\s+kB/m);
    if (rollup) return Number(rollup[1]);
  } catch {
    // Restricted procfs installations may expose status but not smaps_rollup.
  }
  try {
    const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

export function processGroupMemoryKiB(pgid: number): number {
  return listProcessGroupPids(pgid).reduce((total, pid) => total + residentMemoryKiB(pid), 0);
}

export function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Idempotent lifecycle cleanup tolerates already-dead processes.
  }
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    signalPid(pid, signal);
  }
}

export function signalProcessGroupMembers(
  pgid: number,
  signal: NodeJS.Signals,
  exclude: number[] = [],
): void {
  for (const pid of listProcessGroupPids(pgid, exclude)) signalPid(pid, signal);
}

export async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isAlive(pid);
}

async function waitForAllDead(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await Bun.sleep(25);
  }
  return pids.every((pid) => !isAlive(pid));
}

/** Terminate a warm daemon and the child processes it created during a turn. */
export async function terminateProcessTree(pid: number, graceMs = 100): Promise<void> {
  const descendants = listDescendantPids(pid);
  for (const child of descendants) signalPid(child, 'SIGTERM');
  signalProcessGroup(pid, 'SIGTERM');
  const owned = [pid, ...descendants];
  if (await waitForAllDead(owned, graceMs)) return;
  for (const child of descendants) signalPid(child, 'SIGKILL');
  signalProcessGroup(pid, 'SIGKILL');
  await waitForAllDead(owned, 1_000);
}

export async function terminateOwnedRun(
  pid: number,
  options: { processGroup?: boolean; graceMs?: number; exclude?: number[] } = {},
): Promise<boolean> {
  const graceMs = options.graceMs ?? 1_000;
  const exclude = options.exclude ?? [];
  signalProcessGroup(pid, 'SIGTERM');
  if (options.processGroup) signalProcessGroupMembers(pid, 'SIGTERM', exclude);
  if (await waitForDead(pid, graceMs)) {
    if (options.processGroup) signalProcessGroupMembers(pid, 'SIGKILL', exclude);
    return true;
  }
  signalProcessGroup(pid, 'SIGKILL');
  if (options.processGroup) signalProcessGroupMembers(pid, 'SIGKILL', exclude);
  return waitForDead(pid, 1_000);
}
