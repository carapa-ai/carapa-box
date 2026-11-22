import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonIdentity, sendProtocol as send, startProtocolDaemon } from '../protocol/daemon';
import { readJournal, decodeObject } from '../protocol/journal';
import { requestAcp, type AcpMethods, type AcpRequest } from '../protocol/acp';
import { carapaMailMcpServers } from '../carapa-mail';
import type { RunContext } from '../contracts';
import { acquireSessionLock, releaseSessionLock, sessionBusy } from '../sessions';
import { atomicWrite, writeRunFile } from '../files';
import { containerInstanceId, isAlive, listDescendantPids, matchesCurrentInstance, signalPid, terminateProcessTree } from '../processes';
import { startResourceGuard } from '../resource-guard';
import { stopRequestedPath } from '../stop';
import type { AcpHarnessContract } from './contracts';
import { availableModels } from './models';
import { OmpAcpRunV1Adapter } from '../omp-v1';
import { HermesAcpRunV1Adapter } from '../hermes-v1';
import { PrimeAgentRunV1Adapter } from '../prime-agent-v1';
import { CursorAcpRunV1Adapter } from '../cursor-v1';
import { RunV1Writer, createRunV1Writer, ensureRunTerminal } from '../run-v1';

type Json = Record<string, any>;

interface ReadCursor {
  offset: number;
}

export interface TranslationState {
  completedTools: Set<string>;
  visibleText: string[];
  providerFailure?: string;
}

const boardMcpServers = [
  {
    name: 'carapa-board',
    type: 'http',
    url: 'http://api-relay:8080/mcp-relay/mcp/carapa-board',
    headers: [],
  },
];

const trim = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};

const cursorDisplayModel = (value: string): string =>
  value === 'default[]' ? 'auto' : value;

const readPid = (path: string): number | null => {
  const value = Number(trim(path).replace(/\D/g, ''));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const safeKey = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');

function readMessages(path: string, cursor: ReadCursor, rawCapturePath?: string): Json[] {
  return readJournal(path, cursor, rawCapturePath).flatMap(line => {
    const value = decodeObject(line);
    return value ? [value] : [];
  });
}

/** What the agent sent before `end`: the tail of its output, oldest first. A warm or restored session
 * reports its running totals there, ahead of the prompt that this run adds to. */
function messagesBefore(path: string, end: number): Json[] {
  const start = Math.max(0, end - 256 * 1024);
  const buffer = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  // A window that starts mid-line leaves a fragment that does not decode.
  return buffer.toString('utf8').split('\n').flatMap(line => {
    const value = decodeObject(line);
    return value ? [value] : [];
  });
}

function permissionReply(message: Json): Json | null {
  if (message.method === 'session/request_permission' && message.id != null) {
    const options = Array.isArray(message.params?.options) ? message.params.options : [];
    const selected =
      options.find((option: Json) => /allow-always/i.test(String(option.optionId))) ??
      options.find((option: Json) => /allow/i.test(String(option.optionId))) ??
      options[0];
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        outcome: {
          outcome: 'selected',
          optionId: selected?.optionId ?? 'allow-once',
        },
      },
    };
  }
  if (message.method === 'cursor/ask_question' && message.id != null) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        outcome: {
          outcome: 'answered',
          answers: (message.params?.questions ?? []).map((question: Json) => ({
            questionId: question.id,
            selectedOptionIds: [question.options?.[0]?.id ?? ''],
          })),
        },
      },
    };
  }
  if (message.method === 'cursor/create_plan' && message.id != null) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { outcome: { outcome: 'accepted' } },
    };
  }
  return null;
}

export function isProviderFailureText(text: string): boolean {
  // Antigravity reports model and toolbox failures as assistant text with stopReason=end_turn.
  // The ⚠ line can follow earlier text of the same run, e.g. a quota error after a finished prompt.
  return /^\s*Agent execution error: model unreachable:|^\s*(?:⚠\s*)?agent executor error:|(?:^|\n)[ \t]*⚠[ \t]*agent executor error:|invalid_encrypted_content|encrypted content[\s\S]{0,160}(?:could not|cannot) be (?:verified|decrypted|parsed)|raw-http-request=|provider connection closed unexpectedly/i.test(
    text,
  );
}

/**
 * The failure line Board shows for a provider failure. Antigravity's executor error is reduced to
 * its last occurrence without the Go `Details: [map[...]]` dump, keeping the model and reset time.
 */
export function providerFailureMessage(text: string): string {
  const start = text.lastIndexOf('agent executor error:');
  if (start < 0) return text;
  const error = text.slice(start).trim();
  const parsed = error.match(/Error (\d+), Message: ([\s\S]*?), Status: ([A-Z_]+)/);
  if (!parsed) return error;
  const model = error.match(/\bmodel:([^\s\]]+)/)?.[1];
  const resetAt = error.match(/\bquotaResetTimeStamp:([^\s\]]+)/)?.[1];
  return [
    `Antigravity error ${parsed[1]} (${parsed[3]})${model ? ` for ${model}` : ''}: ${parsed[2].trim()}`,
    resetAt ? `Quota resets at ${resetAt}.` : '',
  ].filter(Boolean).join(' ');
}

/** Tracks what decides the turn's outcome and first output; V1 adapters render the events themselves. */
export function translateAcpMessage(message: Json, state: TranslationState): boolean {
  if (message.method !== 'session/update') return false;
  const update = message.params?.update;
  if (!update || typeof update !== 'object') return false;
  if (update.sessionUpdate === 'agent_message_chunk') {
    const text = update.content?.text;
    if (typeof text !== 'string' || !text) return false;
    state.visibleText.push(text);
    const visibleText = state.visibleText.join('');
    if (isProviderFailureText(visibleText)) state.providerFailure = visibleText;
    return true;
  }
  // Antigravity replays a finished tool as a single tool_call that is already terminal.
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const terminal = ['completed', 'failed', 'finished', 'cancelled'].includes(update.status);
    if (!terminal) return update.sessionUpdate === 'tool_call';
    const id = String(update.toolCallId ?? '');
    if (id && state.completedTools.has(id)) return false;
    if (id) state.completedTools.add(id);
    return true;
  }
  return false;
}


function clearRuntimeFiles(sessionDir: string, includeLock = true): void {
  for (const name of ['daemon.pid', 'holder.pid', 'supervisor.pid', 'perm_replier.pid', 'stdin.fifo']) {
    try {
      unlinkSync(join(sessionDir, name));
    } catch {
      // Missing stale runtime files are expected.
    }
  }
  if (includeLock) rmSync(join(sessionDir, 'lock'), { recursive: true, force: true });
}

function prepareContainerGeneration(sessionDir: string, runDir: string): void {
  const current = containerInstanceId();
  if (!current) throw new Error('could not determine container instance');
  const generationFile = join(sessionDir, 'container_instance');
  const previous = trim(generationFile);
  if (previous && !matchesCurrentInstance(generationFile, previous)) {
    clearRuntimeFiles(sessionDir);
    rmSync(join(sessionDir, 'lifecycle.lock'), { recursive: true, force: true });
  }
  atomicWrite(generationFile, current);
  writeRunFile(runDir, 'session_instance', current);
}

async function removeSessionDirectory(sessionDir: string): Promise<void> {
  const storedInstance = trim(join(sessionDir, 'container_instance'));
  const currentInstance = containerInstanceId();
  if (!storedInstance || !currentInstance ||
      matchesCurrentInstance(join(sessionDir, 'container_instance'), storedInstance)) {
    for (const name of ['daemon.pid', 'holder.pid', 'supervisor.pid', 'perm_replier.pid']) {
      const pid = readPid(join(sessionDir, name));
      if (pid !== null) await terminateProcessTree(pid);
    }
  }
  clearRuntimeFiles(sessionDir);
}

function sessionDirectories(sessionsRoot: string): string[] {
  try {
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name))
      .filter(sessionDir => { const pid = readPid(join(sessionDir, 'daemon.pid')); return pid !== null && isAlive(pid); });
  } catch {
    return [];
  }
}

function lastUsedMs(sessionDir: string): number {
  try {
    return statSync(join(sessionDir, 'last_used')).mtimeMs;
  } catch {
    try {
      return statSync(sessionDir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

async function reapIdleSessions(context: RunContext, sessionsRoot: string, currentKey: string): Promise<void> {
  const idleMinutes = Math.max(1, Number(context.env.CARAPA_PERSIST_IDLE_MIN || 30));
  const maximum = Math.max(1, Number(context.env.CARAPA_PERSIST_MAX_SESSIONS || 8));
  const now = Date.now();
  for (const sessionDir of sessionDirectories(sessionsRoot)) {
    const name = sessionDir.slice(sessionsRoot.length + 1);
    if (name === currentKey || name.startsWith('task-') || sessionBusy(sessionDir)) continue;
    if (now - lastUsedMs(sessionDir) > idleMinutes * 60_000) {
      await removeSessionDirectory(sessionDir);
    }
  }
  const candidates = sessionDirectories(sessionsRoot)
    .filter((sessionDir) => sessionDir.slice(sessionsRoot.length + 1) !== currentKey && !sessionBusy(sessionDir))
    .sort((left, right) => lastUsedMs(left) - lastUsedMs(right));
  const excess = Math.max(0, candidates.length + 1 - maximum);
  for (const victim of candidates.slice(0, excess)) await removeSessionDirectory(victim);
}

async function reapSiblingVariants(context: RunContext, sessionsRoot: string, currentKey: string): Promise<void> {
  if (!context.args.conversationId) return;
  const prefix = `${safeKey(context.args.conversationId)}-`;
  for (const sessionDir of sessionDirectories(sessionsRoot)) {
    const name = sessionDir.slice(sessionsRoot.length + 1);
    if (name !== currentKey && name.startsWith(prefix) && !sessionBusy(sessionDir)) await removeSessionDirectory(sessionDir);
  }
}

async function startDaemon(
  context: RunContext, contract: AcpHarnessContract, sessionDir: string, previousSessionId: string, signal?: AbortSignal,
): Promise<{ pid: number; fifo: string; output: string; outputOffset: number }> {
  const fifo = join(sessionDir, 'acp-input');
  const output = join(sessionDir, `${contract.id}.out`);
  const spec = contract.process(context, previousSessionId || undefined);
  const launched = await startProtocolDaemon({
    sessionDir, idleMs: context.args.persistent === '1' ? Math.max(1, Number(context.env.CARAPA_PERSIST_IDLE_MIN || 30)) * 60_000 : 0,
    command: spec.command, cwd: context.cwd, env: { ...context.env, ...spec.env },
    input: fifo, output, stderr: join(sessionDir, `${contract.id}.stderr.log`),
  }, signal);
  writeFileSync(join(sessionDir, 'daemon.pid'), String(launched.pid));
  writeFileSync(join(sessionDir, 'supervisor.pid'), String(launched.pid));
  return { pid: launched.pid, fifo, output, outputOffset: launched.offset };
}

async function request<K extends keyof AcpMethods>(
  state: { daemonPid: number; fifo: string; output: string; cursor: ReadCursor; reply?: AcpHarnessContract['reply'] },
  method: K, params: AcpMethods[K]['params'], onMessage?: (message: Json) => void,
): Promise<Json> {
  return requestAcp(state, method, params, message => {
    const reply = state.reply ? state.reply(message) : permissionReply(message);
    if (reply) send(state.fifo, reply);
    onMessage?.(message);
  });
}

async function runContractRequests(
  rpc: {
    nextId: number;
    reply?: AcpHarnessContract['reply'];
    daemonPid: number;
    fifo: string;
    output: string;
    cursor: ReadCursor;
  },
  requests: AcpRequest[],
): Promise<void> {
  for (const value of requests) {
    try {
      await request(rpc, value.method, value.params);
    } catch (error) {
      if (!value.optional) throw error;
    }
  }
}

function rememberModel(sessionDir: string, response: Json, harness: string, initialized: Json): void {
  const model = response.result?.models?.currentModelId;
  if (typeof model === 'string' && model) writeFileSync(join(sessionDir, 'model_id'), model);
  // Kept beside sessions/ so it outlives isolated task sessions; Board reads the newest per harness.
  const models = availableModels(initialized.result, response.result);
  if (!models.length) return;
  try {
    const dir = join(dirname(dirname(sessionDir)), 'harness-models');
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, `${harness}.json`), JSON.stringify({ harness, observedAt: Date.now(), models }));
  } catch { /* Discovery only; never fail the run over it. */ }
}

function initializeControl(runDir: string, harness: string, pid: number, sessionId: string, turnId: number): void {
  mkdirSync(join(runDir, 'control-requests'), { recursive: true });
  mkdirSync(join(runDir, 'control-responses'), { recursive: true });
  atomicWrite(join(runDir, 'agent-control.json'), JSON.stringify({ version: 1, harness, pid, sessionId, turnId }));
}

/** `onSteer` is set when a message can be sent now: between prompts, or mid-turn for an agent that takes one. */
function handleControls(runDir: string, fifo: string | null, sessionId: string, onSteer?: (text: string) => void): boolean {
  const requests = join(runDir, 'control-requests');
  let interrupted = false;
  let names: string[] = [];
  try {
    names = readdirSync(requests);
  } catch {
    return false;
  }
  const controls = names.filter((value) => value.endsWith('.json')).map((name) => {
    try {
      const { action = '', text } = JSON.parse(readFileSync(join(requests, name), 'utf8'));
      return { name, action, text: text as unknown };
    } catch {
      // Malformed controls receive the same explicit failure as unknown ones.
      return { name, action: '', text: undefined };
    }
  });
  // Interrupts first: a message read in the same pass must not start a turn after the cancel.
  controls.sort((a, b) => Number(b.action === 'interrupt') - Number(a.action === 'interrupt'));
  for (const { name, action, text } of controls) {
    const source = join(requests, name);
    const target = join(runDir, 'control-responses', name);
    if (action === 'interrupt') {
      // No fifo, or a supervisor that is already gone: there is no turn left to cancel.
      if (fifo) {
        try {
          send(fifo, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
        } catch { /* The agent exited; the interrupt is still answered. */ }
      }
      atomicWrite(target, JSON.stringify({ ok: true, result: {} }));
      interrupted = true;
    } else if (action === 'steer' && onSteer && !interrupted && typeof text === 'string' && text) {
      onSteer(text);
      atomicWrite(target, JSON.stringify({ ok: true, result: {} }));
    } else {
      atomicWrite(
        target,
        JSON.stringify({
          ok: false,
          error: 'ACP managed mode supports interrupt only',
        }),
      );
    }
    rmSync(source, { force: true });
  }
  return interrupted;
}

class RecoveryInterrupted extends Error {}

/** While a restarted agent restores its session nothing reads controls: answer an interrupt
 * at once and let `interrupted` reject, so a slow restore cannot hold the cancel past its deadline. */
function watchInterrupts(runDir: string): { interrupted: Promise<never>; stop: () => void } {
  let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    const timer = setInterval(() => {
      // A hard stop must not leave the worker starting a replacement that stop never saw.
      if (existsSync(stopRequestedPath(runDir))) {
        clearInterval(timer);
        reject(new Error('run was stopped while the agent restarted'));
        return;
      }
      if (!handleControls(runDir, null, '')) return;
      clearInterval(timer);
      reject(new RecoveryInterrupted('interrupted while the agent restarted'));
    }, 50);
    stop = () => clearInterval(timer);
  });
  interrupted.catch(() => {});
  return { interrupted, stop };
}

/** True once the user has stopped this turn. An interrupt writes its marker just before it publishes
 * the request, so a marker without a request is waited for: the request must still be answered. */
async function acknowledgeInterrupt(runDir: string, fifo: string | null, sessionId: string): Promise<boolean> {
  if (handleControls(runDir, fifo, sessionId)) return true;
  if (!existsSync(join(runDir, 'turn_interrupt'))) return false;
  const until = Date.now() + 2_000;
  while (Date.now() < until && !handleControls(runDir, fifo, sessionId)) await Bun.sleep(25);
  return true;
}

// Delay between the last sub-agent finishing and the turn its report starts.
const BACKGROUND_TURN_GRACE_MS = 10_000;

function retireTurnDescendants(daemonPid: number, baseline: Set<number>): void {
  for (const pid of listDescendantPids(daemonPid)) {
    if (!baseline.has(pid)) signalPid(pid, 'SIGTERM');
  }
}

export async function runAcpHarness(context: RunContext, contract: AcpHarnessContract): Promise<number> {
  const persistent = context.args.persistent === '1' && !!context.args.conversationKey;
  const key = persistent ? safeKey(context.args.conversationKey) : `isolated-${safeKey(context.runTag)}-${process.pid}`;
  if (!key) throw new Error(`${contract.id} requires a conversation key`);
  const ipcRoot = dirname(dirname(context.runDir));
  const sessionsRoot = join(ipcRoot, 'sessions');
  const sessionDir = join(sessionsRoot, key);
  mkdirSync(sessionsRoot, { recursive: true });
  if (persistent) await reapIdleSessions(context, sessionsRoot, key);
  mkdirSync(sessionDir, { recursive: true });
  prepareContainerGeneration(sessionDir, context.runDir);
  writeRunFile(context.runDir, 'session_dir', sessionDir);
  const lock = await acquireSessionLock(sessionDir, context.runDir);
  let daemonPid: number | null = null;
  let exitCode = 1;
  let v1: ReturnType<NonNullable<AcpHarnessContract['createV1']>> | null = null;
  let writer: RunV1Writer | null = null;
  // Set once the agent crashed and was restarted: the correction prompt the retried turn sends.
  let recoveryPrompt = '';
  let crashFailure = '';
  // Run-level timing and identity: a retry keeps the first attempt's dispatch and first output.
  let promptDispatchedAtMs: number | null = null;
  let firstOutputAtMs: number | null = null;
  let publishedSessionId = '';
  let restartWatch: ReturnType<typeof watchInterrupts> | null = null;
  // True while a replacement agent starts and is configured: nothing else reads controls then.
  let restarting = false;
  // A launch that an interrupt outran: still spawning a supervisor that nothing else knows about.
  let pendingLaunch: ReturnType<typeof startDaemon> | null = null;
  const launchAbort = new AbortController();
  try {
    for (;;) {
      restartWatch = recoveryPrompt ? watchInterrupts(context.runDir) : null;
      restarting = Boolean(recoveryPrompt);
      const watch = restartWatch;
      const guarded = <T>(work: Promise<T>): Promise<T> => watch ? Promise.race([work, watch.interrupted]) : work;
      const rememberedSessionId =
        context.args.sessionId || trim(join(sessionDir, 'session_id')) || trim(join(sessionDir, 'last_session_id'));
      if (contract.sessionIdentity) {
        const identity = contract.sessionIdentity(context);
        const identityPath = rememberedSessionId && contract.sessionIdentityPath?.(context, rememberedSessionId);
        const saved = (identityPath ? trim(identityPath) : '') || trim(join(sessionDir, 'adapter_identity'));
        // Session IDs are provider-native, never interchangeable with SDK display IDs.
        if ((saved && saved !== identity) || (!saved && trim(join(sessionDir, 'session_id')))) {
          throw new Error('ACP session configuration changed or belongs to another harness; use a new conversation key');
        }
        atomicWrite(join(sessionDir, 'adapter_identity'), identity);
      }
      let fifo = join(sessionDir, 'acp-input');
      let daemonOutput = join(sessionDir, `${contract.id}.out`);
      let daemonOutputOffset = 0;
      daemonPid = readPid(join(sessionDir, 'daemon.pid'));
      // Agents receive MCP servers only when a session starts, so a changed set needs a new process.
      const projectMcpServers = (await guarded(carapaMailMcpServers())).map(({ name, url }) => ({ name, type: 'http', url, headers: [] }));
      const mcpIdentity = JSON.stringify(projectMcpServers.map(({ name }) => name));
      const launchIdentity = contract.launchIdentity?.(context) ?? '';
      const newDaemon = Boolean(context.args.sessionId && context.args.sessionId !== trim(join(sessionDir, 'session_id'))) || daemonPid === null || !isAlive(daemonPid) || daemonIdentity(fifo)?.pid !== daemonPid
        || (trim(join(sessionDir, 'mcp_servers')) || '[]') !== mcpIdentity
        || (trim(join(sessionDir, 'launch_identity')) !== launchIdentity);
      // A recorded PID without a matching live owner.json is stale and may belong to an unrelated process.
      if (newDaemon && daemonPid !== null && daemonIdentity(fifo)?.pid === daemonPid) await terminateProcessTree(daemonPid);
      // A hard stop that landed while the crashed agent was ending must not be followed by a replacement.
      if (restarting && existsSync(stopRequestedPath(context.runDir))) throw new Error('run was stopped while the agent restarted');
      if (newDaemon) {
        if (persistent) await reapSiblingVariants(context, sessionsRoot, key);
        clearRuntimeFiles(sessionDir, false);
        pendingLaunch = startDaemon(context, contract, sessionDir, rememberedSessionId, launchAbort.signal);
        const launched = await guarded(pendingLaunch);
        pendingLaunch = null;
        daemonPid = launched.pid;
        fifo = launched.fifo;
        daemonOutput = launched.output;
        daemonOutputOffset = launched.outputOffset;
        atomicWrite(join(sessionDir, 'mcp_servers'), mcpIdentity);
        atomicWrite(join(sessionDir, 'launch_identity'), launchIdentity);
      }
      if (daemonPid === null) throw new Error(`${contract.id} has no daemon pid`);
      const activeDaemonPid = daemonPid;
      writeRunFile(context.runDir, 'pid', String(activeDaemonPid));
      const cursor: ReadCursor = {
        offset: newDaemon ? daemonOutputOffset : statSync(daemonOutput).size,
      };
      const rpc = {
        nextId: 1,
        reply: contract.reply,
        daemonPid: activeDaemonPid,
        fifo,
        output: daemonOutput,
        cursor,
      };
      let sessionId = trim(join(sessionDir, 'session_id'));

      if (newDaemon) {
        const initialized = await guarded(request(rpc, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'carapa-agent-runtime', version: '2' },
        }));
        await guarded(runContractRequests(rpc, contract.afterInitialize?.(context) ?? []));

        const servers = [...boardMcpServers, ...projectMcpServers];
        const mcpServers = contract.sessionMcpServers?.(context, servers) ?? servers;
        if (rememberedSessionId) {
          try {
            if (contract.restore === 'load') {
              const restored = await guarded(request(rpc, 'session/load', {
                sessionId: rememberedSessionId,
                cwd: context.cwd,
                mcpServers,
              }));
              rememberModel(sessionDir, restored, contract.id, initialized);
            } else if (contract.restore === 'resume') {
              const restored = await guarded(request(rpc, 'session/resume', {
                sessionId: rememberedSessionId,
                cwd: context.cwd,
                mcpServers,
              }));
              rememberModel(sessionDir, restored, contract.id, initialized);
            }
            sessionId = rememberedSessionId;
          } catch (error) {
            if (error instanceof RecoveryInterrupted) throw error;
            writeRunFile(context.runDir, 'persistent_resume_failed', rememberedSessionId);
            if (contract.restoreFailure === 'new-session') sessionId = '';
            else throw error;
          }
        }
        if (!sessionId) {
          const created = await guarded(request(rpc, 'session/new', {
            cwd: context.cwd,
            mcpServers,
          }));
          sessionId = String(created.result?.sessionId ?? '');
          rememberModel(sessionDir, created, contract.id, initialized);
          // The model a fresh session starts on is the one 'auto' means; rememberModel's model_id is overwritten per turn.
          const startModel = created.result?.models?.currentModelId;
          if (typeof startModel === 'string' && startModel) writeFileSync(join(sessionDir, 'default_model'), startModel);
        }
        if (!sessionId) throw new Error(`${contract.id} did not return a session id`);
        writeFileSync(join(sessionDir, 'session_id'), sessionId);
        if (recoveryPrompt && sessionId !== publishedSessionId) {
          // The reload failed and a new session replaced the abandoned one: the saved id is published
          // now, so an interrupt during configuration leaves both outputs naming it.
          writer?.append({ type: 'session', id: sessionId, status: 'started' });
          publishedSessionId = sessionId;
        }
      }

      if (!sessionId) throw new Error(`${contract.id} warm daemon has no session id`);
      // Board's model discovery only needs the lists recorded above; stop
      // before configuring or prompting so the model is never called.
      if (context.env.CARAPA_MODEL_PROBE === '1') {
        const probe = createRunV1Writer(context, contract.id);
        probe.append({ type: 'session', id: sessionId, status: 'started' });
        probe.finish('completed', { stopReason: 'end_turn' });
        return 0;
      }
      if (contract.sessionIdentity && contract.sessionIdentityPath) {
        const identityPath = contract.sessionIdentityPath(context, sessionId);
        mkdirSync(dirname(identityPath), { recursive: true, mode: 0o700 });
        atomicWrite(identityPath, contract.sessionIdentity(context));
      }
      const currentConfiguration = {
        newDaemon,
        model: trim(join(sessionDir, 'configured_model')),
        thinking: trim(join(sessionDir, 'configured_thinking')),
        defaultModel: trim(join(sessionDir, 'default_model')),
      };
      await guarded(runContractRequests(rpc, contract.configure?.(context, sessionId, currentConfiguration) ?? []));
      restartWatch?.stop();
      restarting = false;
      const desiredConfiguration = contract.desiredConfiguration?.(context);
      if (desiredConfiguration?.model !== undefined) {
        writeFileSync(join(sessionDir, 'configured_model'), desiredConfiguration.model);
      }
      if (desiredConfiguration?.thinking !== undefined) {
        writeFileSync(join(sessionDir, 'configured_thinking'), desiredConfiguration.thinking);
      }
      if (context.args.model) writeFileSync(join(sessionDir, 'model_id'), context.args.model);

      const rawAcpPath = join(context.runDir, 'acp.raw.jsonl');
      if (!recoveryPrompt) writeFileSync(rawAcpPath, '');
      const v1RequestedModel = contract.id === 'cursor-acp'
        ? cursorDisplayModel(trim(join(sessionDir, 'model_id')) || context.args.model.trim())
        : context.args.model.trim();
      writer ??= new RunV1Writer(context.runDir, { format: 'carapa-run', version: 1, harness: contract.id, requestedModel: v1RequestedModel || null });
      const runWriter = writer;
      v1 ??= contract.createV1
        ? contract.createV1(context, runWriter, Boolean(rememberedSessionId))
        : contract.id === 'cursor-acp'
        ? new CursorAcpRunV1Adapter(
            runWriter,
            v1RequestedModel,
            Boolean(context.args.sessionId || rememberedSessionId),
            `cursor-acp-${context.runTag}-message-1`,
          )
        : contract.id === 'omp-acp'
        ? new OmpAcpRunV1Adapter(
            runWriter,
            context.args.model.trim(),
            Boolean(context.args.sessionId || rememberedSessionId),
            `omp-acp-${context.runTag}-message-1`,
          )
        : contract.id === 'hermes-acp'
          ? new HermesAcpRunV1Adapter(
              runWriter,
              context.args.model.trim(),
              Boolean(context.args.sessionId || rememberedSessionId),
              `hermes-acp-${context.runTag}-message-1`,
            )
        : contract.id === 'prime-agent-acp'
          ? new PrimeAgentRunV1Adapter(
              runWriter,
              context.args.model.trim(),
              Boolean(context.args.sessionId || rememberedSessionId),
              `prime-agent-${context.runTag}-message-1`,
            )
        : null;
      v1?.start(sessionId);
      publishedSessionId = sessionId;
      let promptId = rpc.nextId++;
      initializeControl(context.runDir, contract.id, activeDaemonPid, sessionId, promptId);
      const turnCursor: ReadCursor = { offset: statSync(daemonOutput).size };
      if (v1?.restored) for (const message of messagesBefore(daemonOutput, turnCursor.offset)) v1.restored(message);
      const baseline = new Set(listDescendantPids(activeDaemonPid));
      let interrupted = false;
      let completion: Json | null = null;
      // The pid file named the crashed agent until now, so a stop may have missed the replacement.
      // A stop that named the crashed agent's pid finds the replacement unowned, so the retry watches for it.
      const stopDuringRetry = () => {
        if (recoveryPrompt && existsSync(stopRequestedPath(context.runDir))) throw new Error('run was stopped while the agent restarted');
      };
      stopDuringRetry();
      if (recoveryPrompt) {
        // An interrupt queued while the agent restarted must not be followed by a new prompt.
        interrupted = await acknowledgeInterrupt(context.runDir, fifo, sessionId);
        if (interrupted) completion = { result: { stopReason: 'cancelled' } };
      }
      if (!interrupted) {
        // A fresh session has none of the original request: send it along with the correction.
        const fresh = Boolean(recoveryPrompt) && sessionId !== rememberedSessionId;
        if (fresh) v1?.retryInNewSession?.();
        const request = fresh && contract.freshSessionRequest ? contract.freshSessionRequest(context.prompt) : context.prompt;
        if (request === null) throw new Error(`${crashFailure}; the restarted session cannot repeat the original request`);
        const text = !recoveryPrompt ? request : fresh ? `${request}\n\n${recoveryPrompt}` : recoveryPrompt;
        send(fifo, {
          jsonrpc: '2.0',
          id: promptId,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text }] },
        });
        if (promptDispatchedAtMs === null) {
          promptDispatchedAtMs = Date.now();
          writeRunFile(context.runDir, 'prompt_dispatched_at_ms', String(promptDispatchedAtMs));
        }
      }
      const translation: TranslationState = {
        completedTools: new Set(),
        visibleText: [],
      };
      const guard = startResourceGuard(context, activeDaemonPid);
      const failureOf = (message: Json | null): string => {
        if (translation.providerFailure) return providerFailureMessage(translation.providerFailure);
        const data = typeof message?.error?.data === 'string' ? message.error.data : '';
        return message?.error?.message ? [String(message.error.message), data].filter(Boolean).join(': ') : '';
      };
      const timeoutSeconds = Number(context.env.CARAPA_PERSIST_TURN_TIMEOUT || context.env.PERSIST_TURN_TIMEOUT || 9_800);
      const timeoutMs = Math.max(1, timeoutSeconds) * 1_000;
      let deadline = Date.now() + timeoutMs;
      const background = contract.background?.(context, sessionId, sessionDir);
      let publishedTasks = '[]';
      /** Prompts replaced by a mid-turn message before they returned. */
      const superseded = new Set<string>();
      // Sub-agent tokens, which no prompt reports; written once, before the run ends.
      const unreported = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, totalTokens: 0 };
      const pollBackground = (promptReturned: boolean) => {
        const state = background!.poll(promptReturned);
        for (const message of state.updates) {
          v1?.consume(message);
          translateAcpMessage(message, translation);
        }
        for (const name of Object.keys(unreported) as Array<keyof typeof unreported>) unreported[name] += Number(state.usage?.[name]) || 0;
        const tasks = JSON.stringify(state.tasks);
        if (tasks !== publishedTasks) {
          publishedTasks = tasks;
          runWriter.append({ type: 'background_tasks', tasks: state.tasks });
        }
        return state;
      };
      /** Holds the run open while sub-agents work. Returns a follow-up message to send, or null when done. */
      const waitForBackground = async (): Promise<string | null> => {
        let state = pollBackground(true);
        // A turn with nothing left running ends at once, as it did before.
        if (!state.busy) return null;
        let quietSince = 0;
        for (;; state = pollBackground(false)) {
          // Measure the quiet period from this poll, not from the state before the sleep.
          if (state.busy) quietSince = 0;
          else quietSince ||= Date.now();
          // The main agent's own model failure (e.g. a 429 quota) reaches stdout, never its log:
          // read it now, as the next prompt would, and end the run instead of waiting on the log.
          for (const message of readMessages(daemonOutput, turnCursor, rawAcpPath)) {
            if (background!.replayed(message)) continue;
            v1?.consume(message);
            const reply = contract.reply ? contract.reply(message) : permissionReply(message);
            if (reply) send(fifo, reply);
            translateAcpMessage(message, translation);
            if (superseded.has(String(message.id)) && message.method == null && message.result && typeof message.result === 'object')
              v1?.result?.(message.result as Json);
          }
          if (translation.providerFailure) return null;
          // A sub-agent's report starts the main agent's next turn within moments.
          if (!state.busy && Date.now() - quietSince > BACKGROUND_TURN_GRACE_MS) return null;
          const steers: string[] = [];
          interrupted = handleControls(context.runDir, fifo, sessionId, text => steers.push(text)) || interrupted;
          if (interrupted) return null;
          if (steers.length) return steers.join('\n\n');
          if (!isAlive(activeDaemonPid)) throw new Error(`${contract.id} daemon exited while sub-agents were running`);
          stopDuringRetry();
          await Bun.sleep(250);
        }
      };
      /** Reads what the agent has written so far; returns the turn's completion if it was among it. */
      const drainTurn = (): Json | null => {
        let found: Json | null = null;
        for (const message of readMessages(daemonOutput, turnCursor, rawAcpPath)) {
          if (background?.replayed(message)) continue;
          v1?.consume(message);
          const reply = contract.reply ? contract.reply(message) : permissionReply(message);
          try {
            if (reply) send(fifo, reply);
          } catch (error) {
            // An agent that flushed a request and its failure and then exited cannot be answered:
            // the failure later in this batch is still the turn's outcome.
            if (daemonIdentity(fifo)) throw error;
          }
          const emitted = translateAcpMessage(message, translation);
          if (emitted && firstOutputAtMs === null) {
            firstOutputAtMs = Date.now();
            writeRunFile(context.runDir, 'first_output_at_ms', String(firstOutputAtMs));
          }
          if (String(message.id) === String(promptId) && (message.result != null || message.error != null)) {
            found = message;
          } else if (superseded.has(String(message.id)) && message.method == null) {
            // Only its usage matters: the turn continues under the prompt that replaced it.
            if (message.error != null) found = message;
            else if (message.result && typeof message.result === 'object') v1?.result?.(message.result as Json);
          }
        }
        return found;
      };
      try {
       for (;;) {
        while (Date.now() < deadline && !completion) {
          stopDuringRetry();
          const steers: string[] = [];
          interrupted = handleControls(context.runDir, fifo, sessionId,
            contract.steerMidTurn && !interrupted ? text => steers.push(text) : undefined) || interrupted;
          if (steers.length) {
            // The agent ends the running prompt at once and carries its work on under the new one.
            superseded.add(String(promptId));
            promptId = rpc.nextId++;
            initializeControl(context.runDir, contract.id, activeDaemonPid, sessionId, promptId);
            deadline = Date.now() + timeoutMs;
            send(fifo, { jsonrpc: '2.0', id: promptId, method: 'session/prompt',
              params: { sessionId, prompt: [{ type: 'text', text: steers.join('\n\n') }] } });
          }
          completion = drainTurn() ?? completion;
          if (completion && !completion.error && !translation.providerFailure &&
              (completion.result?.stopReason ?? completion.result?.stop_reason) === 'end_turn' && runWriter.toolCallRecovery.needed()) {
            interrupted = handleControls(context.runDir, fifo, sessionId) || interrupted || existsSync(join(context.runDir, 'turn_interrupt'));
            if (!interrupted) {
              const correction = runWriter.correctToolCall();
              promptId = rpc.nextId++;
              initializeControl(context.runDir, contract.id, activeDaemonPid, sessionId, promptId);
              completion = null;
              send(fifo, { jsonrpc: '2.0', id: promptId, method: 'session/prompt',
                params: { sessionId, prompt: [{ type: 'text', text: correction }] } });
            }
          }
          if (!isAlive(activeDaemonPid)) {
            // The agent may have flushed its failure after the read above and then died: that failure
            // is the cause, and the retire hook may recover from it.
            completion = drainTurn() ?? completion;
            const failed = completion ? failureOf(completion) : '';
            if (!(failed && contract.retireDaemonAfter?.(failed))) throw new Error(`${contract.id} daemon exited mid-turn`);
          }
          if (!completion) await Bun.sleep(50);
        }
        if (!background || !completion || completion.error || translation.providerFailure || interrupted ||
            (completion.result?.stopReason ?? completion.result?.stop_reason) !== 'end_turn') break;
        const followUp = await waitForBackground();
        if (followUp === null) break;
        promptId = rpc.nextId++;
        initializeControl(context.runDir, contract.id, activeDaemonPid, sessionId, promptId);
        if (completion.result && typeof completion.result === 'object') v1?.result?.(completion.result as Json);
        completion = null;
        deadline = Date.now() + timeoutMs;
        send(fifo, { jsonrpc: '2.0', id: promptId, method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: followUp }] } });
       }
      } finally {
        guard.stop();
        retireTurnDescendants(activeDaemonPid, baseline);
      }
      if (!completion) throw new Error(`${contract.id} turn timed out`);
      const stopReason = String(completion.result?.stopReason ?? completion.result?.stop_reason ?? '');
      const failure = failureOf(completion);
      // A crashed agent loses nothing durable: restart it, reload the session and send the correction once.
      let correction: string | undefined;
      if (failure && !recoveryPrompt && contract.recoveryPrompt && contract.retireDaemonAfter?.(failure)) {
        // An interrupted turn has nothing to retry: settle it as interrupted, the agent being gone.
        if (interrupted || await acknowledgeInterrupt(context.runDir, fifo, sessionId)) {
          throw new RecoveryInterrupted('interrupted after the agent crashed');
        }
        // A hard stop ends the run as it does without recovery: no replacement is started.
        if (!existsSync(stopRequestedPath(context.runDir))) correction = contract.recoveryPrompt(failure);
      }
      if (correction) {
        // What the crashed attempt streamed is billed now; the retry reports its own usage.
        v1?.abandonAttempt?.();
        // Markup the crashed attempt printed was answered by the crash: the retry starts with no pending correction.
        runWriter.toolCallRecovery.settle();
        await terminateProcessTree(activeDaemonPid);
        clearRuntimeFiles(sessionDir, false);
        recoveryPrompt = correction;
        crashFailure = failure;
        // The reloaded session, not an explicit id that was already replaced.
        context.args.sessionId = '';
        const notice = `${contract.id} crashed on this turn (${failure}); restarted the agent process and retrying once.`;
        runWriter.append({ type: 'message', id: 'harness-restart-notice', role: 'system', content: notice, format: 'text', status: 'completed' });
        continue;
      }
      let terminalFailure = failure;
      if (!failure && !(stopReason === 'end_turn' || (stopReason === 'cancelled' && interrupted))) {
        terminalFailure = stopReason ? `turn ended: ${stopReason}` : 'ACP turn ended without a stop reason';
      }
      exitCode = terminalFailure ? 1 : 0;
      // The prompt's own usage goes last: Board reads context occupancy from the latest entry.
      if (unreported.totalTokens) v1?.result?.({ usage: unreported });
      if (completion.result && typeof completion.result === 'object') v1?.result?.(completion.result as Json);
      if (publishedTasks !== '[]') runWriter.append({ type: 'background_tasks', tasks: [] });
      v1?.finish(exitCode, terminalFailure);
      // A retry that did not succeed leaves a replacement that proved no better: retire it as well.
      if ((recoveryPrompt && exitCode !== 0) || (failure && contract.retireDaemonAfter?.(failure))) {
        await terminateProcessTree(activeDaemonPid);
        clearRuntimeFiles(sessionDir, false);
      }
      writeFileSync(join(sessionDir, 'last_session_id'), sessionId);
      writeFileSync(join(sessionDir, 'last_used'), '');
      utimesSync(join(sessionDir, 'last_used'), new Date(), new Date());
      return exitCode;
    }
  } catch (caught) {
    restartWatch?.stop();
    // An interrupt queued while the replacement started is answered even when that start failed first.
    const error = !(caught instanceof RecoveryInterrupted) && restarting && await acknowledgeInterrupt(context.runDir, null, '')
      ? new RecoveryInterrupted('interrupted while the agent restarted')
      : caught;
    if (pendingLaunch) {
      // Reap that launch before the session lock is released, or it publishes daemon.pid afterwards.
      launchAbort.abort();
      const late = await pendingLaunch.then(launched => launched.pid, () => null);
      if (late !== null) daemonPid = late;
    }
    if (daemonPid !== null) {
      await terminateProcessTree(daemonPid);
      clearRuntimeFiles(sessionDir, false);
    }
    if (error instanceof RecoveryInterrupted) {
      // Settled like an interrupted turn: the agent is gone, the saved session reloads next run.
      v1?.finish(0, '');
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (v1) v1.finish(1, message);
    else ensureRunTerminal(context, 1, message);
    appendFileSync(join(context.runDir, 'agent-stderr.log'), `managed ACP: ${message}\n`);
    return 1;
  } finally {
    releaseSessionLock(lock);
    if (!persistent) {
      if (daemonPid !== null) await terminateProcessTree(daemonPid);
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(join(context.runDir, 'session_dir'), { force: true });
    }
  }
}
