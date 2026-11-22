import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonIdentity, startProtocolDaemon } from '../protocol/daemon';
import { readJournal, decodeObject } from '../protocol/journal';
import { sendPi as send, decodePiResponse } from '../protocol/pi';
import type { RunContext } from '../contracts';
import { acquireSessionLock, releaseSessionLock } from '../sessions';
import { rekeyMcpCache } from './mcp-cache';
import { ensureProjectMcpApprovals } from './mcp-approvals';
import { atomicWrite, writeRunFile } from '../files';
import {
  containerInstanceId,
  matchesCurrentInstance,
  isAlive,
  listDescendantPids,
  signalPid,
  terminateProcessTree,
} from '../processes';
import { startResourceGuard } from '../resource-guard';
import { isProviderFailureText } from '../acp/runner';
import { createRunV1Writer } from '../run-v1';
import { PiRunV1Adapter } from './v1';

type Json = Record<string, any>;
type Cursor = { offset: number };
type PendingControl = { responsePath: string };

const MAX_FAILURE_TEXT = 4_000;

const safeKey = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');

function trim(path: string): string {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function readPid(path: string): number | null {
  const value = Number(trim(path));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readMessages(path: string, cursor: Cursor, rawCapturePath?: string): Json[] {
  return readJournal(path, cursor, rawCapturePath).flatMap(line => {
    const value = decodeObject(line);
    return value ? [value] : [];
  });
}


function clearRuntime(sessionDir: string, includeLock = true): void {
  for (const name of ['daemon.pid', 'stdin.fifo']) {
    try { unlinkSync(join(sessionDir, name)); } catch { /* optional stale file */ }
  }
  if (includeLock) rmSync(join(sessionDir, 'lock'), { recursive: true, force: true });
}

function prepareGeneration(sessionDir: string, runDir: string): void {
  const current = containerInstanceId();
  if (!current) throw new Error('could not determine container instance');
  const path = join(sessionDir, 'container_instance');
  if (trim(path) && !matchesCurrentInstance(path, trim(path))) {
    clearRuntime(sessionDir);
    rmSync(join(sessionDir, 'lifecycle.lock'), { recursive: true, force: true });
  }
  atomicWrite(path, current);
  writeRunFile(runDir, 'session_instance', current);
}

function piCommand(
  context: RunContext,
  sessionId: string,
): string[] {
  // RPC never serves pi-mcp-adapter's "Allow project MCP server?" prompt, so
  // project .mcp.json servers in trusted projects load as they do for Claude
  // and Codex runs; untrusted projects stay blocked.
  const command = ['pi', '--mode', 'rpc', '--mcp-project-servers', 'allow'];
  command.push('--session-dir', join(dirname(dirname(context.runDir)), 'pi-sessions'));
  if (sessionId) command.push('--session', sessionId);
  if (context.args.model.includes('/')) {
    const [provider, ...model] = context.args.model.split('/');
    command.push('--provider', provider, '--model', model.join('/'));
  } else if (context.args.model) {
    command.push('--model', context.args.model);
  }
  let thinking = context.env.PI_THINKING_LEVEL || context.args.reasoningEffort;
  if (thinking === 'none') thinking = 'off';
  if (thinking) command.push('--thinking', thinking);
  if (context.args.agent) command.push('--agent', context.args.agent);
  return command;
}

async function startDaemon(
  context: RunContext, sessionDir: string, sessionId: string,
): Promise<{ pid: number; fifo: string; output: string; offset: number }> {
  const fifo = join(sessionDir, 'pi-input');
  const output = join(sessionDir, 'pi-rpc.out');
  const mcpLog = (line: string) => appendFileSync(
    join(sessionDir, 'mcp-bootstrap.log'), `${new Date().toISOString()} ${line}\n`);
  await rekeyMcpCache(context.env, context.cwd, mcpLog);
  await ensureProjectMcpApprovals(context.env, context.cwd, mcpLog);
  // Fresh stderr per daemon start: waitForResponse quotes its tail, and a
  // previous daemon's last line must not explain this one's exit.
  const stderrPath = join(sessionDir, 'pi-rpc.stderr.log');
  writeFileSync(stderrPath, '', { mode: 0o600 });
  const launched = await startProtocolDaemon({
    sessionDir, idleMs: context.args.persistent === '1' ? Math.max(1, Number(context.env.CARAPA_PERSIST_IDLE_MIN || 30)) * 60_000 : 0,
    command: piCommand(context, sessionId), cwd: context.cwd,
    env: { ...context.env, PI_CODEX_WEBSOCKET: context.env.PI_CODEX_WEBSOCKET || '1' },
    input: fifo, output, stderr: stderrPath,
  });
  writeFileSync(join(sessionDir, 'daemon.pid'), String(launched.pid));
  writeFileSync(join(sessionDir, 'supervisor.pid'), String(launched.pid));
  return { ...launched, fifo, output };
}

async function waitForResponse(args: {
  id: string;
  pid: number;
  fifo: string;
  output: string;
  cursor: Cursor;
  rawCapturePath?: string;
}): Promise<Json> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const message of readMessages(args.output, args.cursor, args.rawCapturePath)) {
      const response = decodePiResponse(message, args.id);
      if (response) return response;
    }
    if (!isAlive(args.pid)) {
      // The daemon's stderr (e.g. "No session found matching ...") is the only
      // explanation for an immediate exit.
      const stderrTail = trim(join(dirname(args.output), 'pi-rpc.stderr.log')).split('\n').slice(-5).join('\n').slice(-MAX_FAILURE_TEXT);
      throw new Error(`Pi RPC daemon exited while awaiting response${stderrTail ? `: ${stderrTail}` : ''}`);
    }
    await Bun.sleep(25);
  }
  throw new Error(`Pi RPC response ${args.id} timed out`);
}

function completeControl(
  pendingControls: Map<string, PendingControl>,
  message: Json,
): boolean {
  const id = String(message.id ?? '');
  const pending = pendingControls.get(id);
  if (!pending) return false;
  const response = message.success
    ? { ok: true, result: message.data ?? {} }
    : { ok: false, error: String(message.error ?? 'Pi steer rejected') };
  atomicWrite(pending.responsePath, JSON.stringify(response));
  pendingControls.delete(id);
  return true;
}

function rejectPendingControls(
  pendingControls: Map<string, PendingControl>,
  error: string,
): void {
  for (const pending of pendingControls.values()) {
    atomicWrite(pending.responsePath, JSON.stringify({ ok: false, error }));
  }
  pendingControls.clear();
}

function handleControls(
  runDir: string,
  fifo: string,
  pendingControls: Map<string, PendingControl>,
): boolean {
  const requests = join(runDir, 'control-requests');
  let interrupted = false;
  let names: string[] = [];
  try { names = readdirSync(requests); } catch { return false; }
  for (const name of names.filter((value) => value.endsWith('.json'))) {
    const source = join(requests, name);
    let request: Json = {};
    try { request = JSON.parse(readFileSync(source, 'utf8')); } catch { /* fail below */ }
    const target = join(runDir, 'control-responses', name);
    if (request.action === 'interrupt') {
      send(fifo, { id: `abort-${Date.now()}`, type: 'abort' });
      atomicWrite(target, JSON.stringify({ ok: true, result: {} }));
      interrupted = true;
    } else if (request.action === 'steer' && typeof request.text === 'string' && request.text) {
      const id = `control-${name.slice(0, -'.json'.length)}`;
      pendingControls.set(id, { responsePath: target });
      send(fifo, { id, type: 'steer', message: request.text });
    } else {
      atomicWrite(target, JSON.stringify({ ok: false, error: 'unsupported or invalid Pi control request' }));
    }
    rmSync(source, { force: true });
  }
  return interrupted;
}

function retireTurnDescendants(pid: number, baseline: Set<number>): void {
  for (const child of listDescendantPids(pid)) if (!baseline.has(child)) signalPid(child, 'SIGTERM');
}

export async function runPiRpcHarness(context: RunContext): Promise<number> {
  const persistent = context.args.persistent === '1' && !!context.args.conversationKey;
  const key = persistent ? safeKey(context.args.conversationKey) : '';
  if (persistent && !key) throw new Error('persistent Pi RPC requires a conversation key');
  const sessionDir = persistent
    ? join(dirname(dirname(context.runDir)), 'sessions', key)
    : join(context.runDir, 'pi-rpc');
  mkdirSync(sessionDir, { recursive: true });
  if (persistent) {
    prepareGeneration(sessionDir, context.runDir);
    writeRunFile(context.runDir, 'session_dir', sessionDir);
  }
  mkdirSync(join(context.runDir, 'control-requests'), { recursive: true });
  mkdirSync(join(context.runDir, 'control-responses'), { recursive: true });
  const rawPiPath = join(context.runDir, 'pi.raw.jsonl');
  writeFileSync(rawPiPath, '');
  const writer = createRunV1Writer(context, 'pi');
  const v1 = new PiRunV1Adapter(writer, context);
  let lock = '';
  let daemonPid: number | null = null;
  let interrupted = false;
  try {
    if (persistent) lock = await acquireSessionLock(sessionDir, context.runDir);
    const rememberedSession = context.args.sessionId || trim(join(sessionDir, 'session_id'));
    daemonPid = persistent ? readPid(join(sessionDir, 'daemon.pid')) : null;
    let fifo = join(sessionDir, 'pi-input');
    const newDaemon = Boolean(context.args.sessionId && context.args.sessionId !== trim(join(sessionDir, 'session_id'))) || daemonPid === null || !isAlive(daemonPid) || daemonIdentity(fifo)?.pid !== daemonPid;
    // A recorded PID without a matching live owner.json is stale and may belong to an unrelated process.
    if (newDaemon && daemonPid !== null && daemonIdentity(fifo)?.pid === daemonPid) await terminateProcessTree(daemonPid);
    let daemonOutput = join(sessionDir, 'pi-rpc.out');
    let offset = statSync(daemonOutput, { throwIfNoEntry: false })?.size ?? 0;
    if (newDaemon) {
      clearRuntime(sessionDir, false);
      const launched = await startDaemon(
        context,
        sessionDir,
        rememberedSession,
      );
      daemonPid = launched.pid;
      fifo = launched.fifo;
      daemonOutput = launched.output;
      offset = launched.offset;
    }
    if (daemonPid === null) throw new Error('Pi RPC has no daemon pid');
    const activePid = daemonPid;
    writeRunFile(context.runDir, 'pid', String(activePid));
    const cursor: Cursor = { offset };
    const stateId = `state-${process.pid}-${Date.now()}`;
    send(fifo, { id: stateId, type: 'get_state' });
    const state = await waitForResponse({
      id: stateId,
      pid: activePid,
      fifo,
      output: daemonOutput,
      cursor,
      rawCapturePath: rawPiPath,
    });
    const sessionId = String(state.data?.sessionId ?? rememberedSession);
    if (!sessionId) throw new Error('Pi RPC returned no session id');
    // Pi saves a new session only once it holds a message. Announcing it earlier
    // lets Board resume an ID Pi cannot load when the turn failed before that.
    const sessionFile = typeof state.data?.sessionFile === 'string' ? state.data.sessionFile : '';
    let announced = false;
    const announceSession = () => {
      if (announced || (sessionFile && !existsSync(sessionFile))) return;
      announced = true;
      writeFileSync(join(sessionDir, 'session_id'), sessionId);
      v1.session(sessionId, Boolean(rememberedSession));
    };
    announceSession();
    v1.start();

    let desiredThinking = context.env.PI_THINKING_LEVEL || context.args.reasoningEffort;
    if (desiredThinking === 'none') desiredThinking = 'off';
    const currentThinking = String(state.data?.thinkingLevel ?? '');
    if (desiredThinking && currentThinking !== desiredThinking) {
      const thinkingId = `thinking-${process.pid}-${Date.now()}`;
      send(fifo, { id: thinkingId, type: 'set_thinking_level', level: desiredThinking });
      await waitForResponse({
        id: thinkingId,
        pid: activePid,
        fifo,
        output: daemonOutput,
        cursor,
        rawCapturePath: rawPiPath,
      });
    }

    atomicWrite(join(context.runDir, 'agent-control.json'), JSON.stringify({
      version: 1,
      harness: 'pi-rpc',
      pid: activePid,
      sessionId,
    }));
    let promptId = `prompt-${process.pid}-${Date.now()}`;
    const turnCursor: Cursor = { offset: statSync(daemonOutput).size };
    const baseline = new Set(listDescendantPids(activePid));
    send(fifo, { id: promptId, type: 'prompt', message: context.prompt });
    writeRunFile(context.runDir, 'prompt_dispatched_at_ms', String(Date.now()));
    const guard = startResourceGuard(context, activePid);
    const deadline = Date.now() + Math.max(1, Number(context.env.CARAPA_PERSIST_TURN_TIMEOUT || 9_800)) * 1_000;
    let completed = false;
    let failed = '';
    let providerFailure = '';
    let firstOutput = false;
    let idleCheckId = '';
    let checkIdleAt = 0;
    // Pi recovers from errors (context overflow compaction, transient retries) after emitting
    // agent_end, so the turn is only over once Pi itself reports idle.
    let settling = false;
    let recoveryActive = false;
    let recoveryDeadline = 0;
    const pendingControls = new Map<string, PendingControl>();
    try {
      while (Date.now() < deadline && !completed) {
        announceSession();
        const wasInterrupted = interrupted;
        interrupted = handleControls(context.runDir, fifo, pendingControls) || interrupted;
        // An abort can end Pi's work without any agent_end (e.g. during post-run compaction), so
        // after an interrupt completion falls back to Pi reporting idle.
        if (interrupted && !wasInterrupted) {
          settling = true;
          if (!idleCheckId) checkIdleAt = Date.now();
        }
        for (const message of readMessages(daemonOutput, turnCursor, rawPiPath)) {
          v1.consume(message);
          if (idleCheckId && message.type === 'response' && message.id === idleCheckId) {
            decodePiResponse(message, idleCheckId);
            idleCheckId = '';
            const busy = message.data?.isStreaming || message.data?.isCompacting ||
              message.data?.pendingMessageCount > 0 ||
              (!interrupted && recoveryActive && Date.now() < recoveryDeadline);
            if (busy) {
              checkIdleAt = Date.now() + 250;
            } else {
              settling = false;
              completed = true;
            }
            continue;
          }
          if (message.type === 'response' && completeControl(pendingControls, message)) continue;
          if (message.type === 'response' && message.id === promptId && !message.success) {
            failed = String(message.error ?? 'Pi prompt failed').slice(0, MAX_FAILURE_TEXT);
            completed = true;
            continue;
          }
          if (message.type === 'response' || message.type === 'available_commands_update') continue;
          if (!firstOutput && ['message_update', 'tool_execution_start', 'agent_end'].includes(String(message.type))) {
            firstOutput = true;
            writeRunFile(context.runDir, 'first_output_at_ms', String(Date.now()));
          }
          // A provider error is only final if Pi doesn't recover: a retry or post-compaction
          // continuation starts a new attempt, which supersedes the earlier failure text.
          if (message.type === 'agent_start' && providerFailure) {
            if (failed === providerFailure) failed = '';
            providerFailure = '';
          }
          // Only Pi's own error field counts: whole events embed the session history and tool
          // output, which can quote these phrases in a run that succeeded.
          const errorMessage = message.type === 'message_end' && message.message?.role === 'assistant'
            ? message.message.errorMessage
            : undefined;
          if (typeof errorMessage === 'string' && isProviderFailureText(errorMessage)) {
            providerFailure = errorMessage.slice(0, MAX_FAILURE_TEXT);
            failed = providerFailure;
          }
          if (message.type === 'compaction_start' || message.type === 'auto_retry_start') {
            recoveryActive = true;
            recoveryDeadline = Date.now() + 120_000;
          } else if (message.type === 'compaction_end') {
            recoveryActive = message.willRetry === true;
            recoveryDeadline = Date.now() + 30_000;
          } else if (message.type === 'auto_retry_end') {
            recoveryActive = false;
          } else if (message.type === 'agent_start') {
            recoveryActive = false;
          }
          if (message.type === 'agent_end' && message.willRetry !== true) {
            if (interrupted) {
              completed = true;
            } else {
              settling = true;
              idleCheckId = '';
              checkIdleAt = Date.now();
            }
          }
        }
        if (completed && !failed && v1.runStatus === 'completed' && writer.toolCallRecovery.needed()) {
          interrupted = handleControls(context.runDir, fifo, pendingControls) || interrupted || existsSync(join(context.runDir, 'turn_interrupt'));
          if (!interrupted) {
            completed = false;
            if (!checkIdleAt && !idleCheckId) {
              const correction = writer.correctToolCall();
              v1.beginContinuation();
              promptId = `correction-${process.pid}-${Date.now()}`;
              send(fifo, { id: promptId, type: 'prompt', message: correction });
            }
          }
        }
        if (settling && checkIdleAt && Date.now() >= checkIdleAt && !idleCheckId) {
          checkIdleAt = 0;
          idleCheckId = `idle-${process.pid}-${Date.now()}`;
          send(fifo, { id: idleCheckId, type: 'get_state' });
        }
        if (!isAlive(activePid)) throw new Error('Pi RPC daemon exited mid-turn');
        if (!completed) await Bun.sleep(50);
      }
    } finally {
      announceSession();
      guard.stop();
      retireTurnDescendants(activePid, baseline);
      rejectPendingControls(pendingControls, 'Pi turn ended before steer acceptance');
    }
    if (!completed) throw new Error('Pi RPC turn timed out');
    if (failed && !interrupted) {
      v1.finish('failed', 'provider_error', failed);
      return 1;
    }
    if (interrupted || v1.runStatus === 'interrupted') {
      v1.finish('interrupted', v1.stopReason || 'interrupted');
    } else if (v1.runStatus === 'failed') {
      v1.finish('failed', v1.stopReason, v1.errorMessage || 'Pi assistant stopped with an error');
    } else {
      v1.finish('completed', v1.stopReason || 'end_turn');
    }
    if (persistent) {
      writeFileSync(join(sessionDir, 'last_used'), '');
      utimesSync(join(sessionDir, 'last_used'), new Date(), new Date());
    }
    return 0;
  } catch (error) {
    if (
      persistent &&
      daemonPid !== null
    ) {
      await terminateProcessTree(daemonPid);
      clearRuntime(sessionDir, false);
    }
    const message = error instanceof Error ? error.message : String(error);
    v1.finish(
      interrupted ? 'interrupted' : 'failed',
      interrupted ? 'interrupted' : 'runtime_error',
      interrupted ? undefined : message,
    );
    appendFileSync(join(context.runDir, 'agent-stderr.log'), `managed Pi RPC: ${message}\n`);
    return 1;
  } finally {
    if (!persistent && daemonPid !== null) {
      await terminateProcessTree(daemonPid);
      clearRuntime(sessionDir, false);
    }
    if (lock) releaseSessionLock(lock);
  }
}
