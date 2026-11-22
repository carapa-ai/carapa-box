#!/usr/bin/env bun
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { daemonIdentity, sendProtocolLine, startProtocolDaemon } from '../protocol/daemon';
import { readJournal as readCompleteLines, type JournalCursor as OutputCursor } from '../protocol/journal';
import { loadAgentArgs, runTagForDirectory } from '../contracts';
import { acquireSessionLock, releaseSessionLock } from '../sessions';
import { carapaMailMcpServers } from '../carapa-mail';
import { atomicWrite } from '../files';
import { containerInstanceId, isAlive, matchesCurrentInstance, terminateProcessTree } from '../processes';
import { RunV1Writer } from '../run-v1';
import { cleanupCodexProcesses } from './cleanup';
import { CodexRpcClient, type CodexMethods } from './client';
import { ControlRequestPoller } from './controls';
import {
  isCapacityFailure,
  isMeaningfulTurnMessage,
  isOutputMessage,
} from './translator';
import type { CodexRunnerArgs, JsonRecord, RpcId, RpcMessage } from './types';
import { errorMessage, record, string } from './types';
import { CodexRunV1Adapter } from './v1';
import { ToolCallRecovery } from './tool-call-recovery';
import { ToolCallCorrection, TOOL_CALL_CORRECTION_NOTICE } from '../tool-call-recovery';

interface RunnerState {
  threadId: string;
  turnId: string;
  completed: boolean;
  exitStatus: string;
  capacityFailure: boolean;
  meaningfulTurnOutput: boolean;
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true'].includes(String(value || '').trim().toLowerCase());
}

const PROFILE_OVERRIDE_KEYS = new Set([
  'model_provider',
  'model_catalog_json',
  'model_context_window',
  'model_auto_compact_token_limit',
  'model_auto_compact_token_limit_scope',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
  'model_verbosity',
  'web_search',
]);

function codexProfileSettings(
  profile: string,
): { overrides: string[]; modelProvider: string } {
  if (!profile) return { overrides: [], modelProvider: '' };
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new Error(`codex: invalid CODEX_PROFILE ${JSON.stringify(profile)}`);
  }
  const home = process.env.HOME || '';
  const profilePath = join(home, '.codex', `${profile}.config.toml`);
  if (!home || !existsSync(profilePath)) {
    throw new Error(`codex: missing profile file ${profilePath}`);
  }
  const overrides: string[] = [];
  let modelProvider = '';
  for (const sourceLine of readFileSync(profilePath, 'utf8').split('\n')) {
    const line = sourceLine.replace(/\s*#.*$/, '').trim();
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!PROFILE_OVERRIDE_KEYS.has(key) || !value) continue;
    overrides.push(`${key}=${value}`);
    if (key === 'model_provider') {
      modelProvider = value.replace(/^"|"$/g, '');
    }
  }
  if (!modelProvider) {
    throw new Error(`codex: profile ${profile} has no model_provider`);
  }
  return { overrides, modelProvider };
}


const safeKey = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');

function trimmed(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function readPid(path: string): number | null {
  const value = Number(trimmed(path));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}


async function run(runDirInput: string): Promise<number> {
  const runDir = resolve(runDirInput);
  const args = loadAgentArgs(runDir) as CodexRunnerArgs;
  if (args.codexControlContract !== 1) {
    throw new Error(`unsupported Codex control contract: ${String(args.codexControlContract)}`);
  }
  const prompt = readFileSync(join(runDir, 'prompt.txt'), 'utf8');
  const persistent = args.persistent === '1' && !!args.conversationKey;
  const ipcRoot = resolve(runDir, '..', '..');
  const sessionDir = persistent
    ? join(ipcRoot, 'sessions', safeKey(args.conversationKey || ''))
    : runDir;
  mkdirSync(sessionDir, { recursive: true });
  if (persistent) atomicWrite(join(runDir, 'session_dir'), sessionDir);
  const generationFile = join(sessionDir, 'container_instance');
  const currentGeneration = containerInstanceId();
  if (persistent && currentGeneration) {
    const previousGeneration = trimmed(generationFile);
    if (previousGeneration && !matchesCurrentInstance(generationFile, previousGeneration)) {
      rmSync(join(sessionDir, 'lock'), { recursive: true, force: true });
      rmSync(join(sessionDir, 'lifecycle.lock'), { recursive: true, force: true });
      for (const name of ['daemon.pid', 'codex-stdin.fifo', 'supervisor.pid']) {
        try { unlinkSync(join(sessionDir, name)); } catch { /* stale files are optional */ }
      }
    }
    atomicWrite(generationFile, currentGeneration);
  }
  const lock = persistent ? await acquireSessionLock(sessionDir, runDir) : '';
  const rawCodexPath = join(runDir, 'codex.raw.jsonl');
  const controlPath = join(runDir, 'codex-control.json');
  const stderrPath = join(sessionDir, 'codex-stderr.log');
  const stdinPath = join(sessionDir, 'codex-input');
  const stdoutPath = join(sessionDir, 'codex-stdout.jsonl');
  const requestsDir = join(runDir, 'control-requests');
  const responsesDir = join(runDir, 'control-responses');
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
  writeFileSync(rawCodexPath, '');
  const v1 = new CodexRunV1Adapter(
    new RunV1Writer(runDir, {
      format: 'carapa-run',
      version: 1,
      harness: 'codex',
      requestedModel: args.model.trim() || null,
    }),
    args,
  );

  const nativePlanFeature = enabled(process.env.ENABLE_CODEX_PLAN_MODE);
  const nativePlanMode = nativePlanFeature && args.chatMode === 'plan';
  const runTag = persistent
    ? `codex-${safeKey(args.conversationKey || '')}`
    : process.env.CARAPA_AGENT_RUN_ID || runTagForDirectory(runDir);
  const imageToolDir = '/usr/local/ai-cli-bin';
  const overrideToolDir = '/usr/local/stack-cli-bin';
  const mountedToolDir = existsSync(join(overrideToolDir, 'bash-env.sh'))
    ? overrideToolDir
    : imageToolDir;
  const shellPath = [
    mountedToolDir,
    ...String(process.env.PATH || '')
      .split(':')
      .filter((entry) => entry && entry !== mountedToolDir),
  ].join(':');
  const shellEnvironment: Record<string, string> = {
    PATH: shellPath,
    BASH_ENV: `${mountedToolDir}/bash-env.sh`,
    ...(persistent ? { CARAPA_BROWSER_CONTEXT_FILE: join(sessionDir, 'active_run') } : {}),
  };
  for (const name of [
    'CARAPA_RECORD',
    'CARAPA_RECORD_DAEMON_DIR',
    'CARAPA_RECORD_SOCKETS_DIR',
    'CARAPA_RECORD_SESSION',
    'CARAPA_RECORD_DIR',
    'PLAYWRIGHT_DAEMON_SESSION_DIR',
    'PLAYWRIGHT_DAEMON_SOCKETS_DIR',
    'PLAYWRIGHT_CLI_SESSION',
    'CARAPA_BROWSER_RUN_ID',
    'CARAPA_BROWSER_SESSION_ID',
    'CARAPA_BROWSER_WORK_DIR',
  ]) {
    const value = args.env[name];
    if (value !== undefined) shellEnvironment[name] = value;
  }
  const profile = process.env.CODEX_PROFILE || args.env.CODEX_PROFILE || '';
  const profileSettings = codexProfileSettings(profile);
  const childArgs = ['app-server'];
  for (const override of profileSettings.overrides) {
    childArgs.push('-c', override);
  }
  for (const [name, value] of Object.entries(shellEnvironment)) {
    childArgs.push('-c', `shell_environment_policy.set.${name}=${JSON.stringify(value)}`);
  }
  childArgs.push(
    '-c',
    `shell_environment_policy.set.CARAPA_AGENT_RUN_ID=${JSON.stringify(runTag)}`,
  );
  // Project-scoped servers join carapa-board from config.toml. The app-server
  // reads them only at launch, so a changed set needs a new process.
  const projectMcpServers = await carapaMailMcpServers();
  for (const { name, url } of projectMcpServers) childArgs.push('-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`);
  const mcpIdentity = JSON.stringify(projectMcpServers.map(({ name }) => name));

  const codexBin = process.env.CARAPA_CODEX_BIN || '/opt/carapa-harness/bin/codex';
  const stderr = createWriteStream(stderrPath, { flags: 'a' });
  let activePid = persistent ? readPid(join(sessionDir, 'daemon.pid')) : null;
  const newDaemon = Boolean(args.sessionId && args.sessionId !== trimmed(join(sessionDir, 'thread_id'))) || activePid === null || !isAlive(activePid) || daemonIdentity(stdinPath)?.pid !== activePid
    || (trimmed(join(sessionDir, 'mcp_servers')) || '[]') !== mcpIdentity;
  // A recorded PID without a matching live owner.json is stale and may belong to an unrelated process.
  if (newDaemon && activePid !== null && daemonIdentity(stdinPath)?.pid === activePid) await terminateProcessTree(activePid);
  let outputOffset = 0;
  if (newDaemon) {
    const launched = await startProtocolDaemon({
      sessionDir, idleMs: persistent ? Math.max(1, Number(process.env.CARAPA_PERSIST_IDLE_MIN || 30)) * 60_000 : 0,
      command: [codexBin, ...childArgs], cwd: process.cwd(),
      env: { ...process.env, ...args.env, CARAPA_AGENT_RUN_ID: runTag },
      input: stdinPath, output: stdoutPath, stderr: stderrPath,
    });
    activePid = launched.pid;
    outputOffset = launched.offset;
    writeFileSync(join(sessionDir, 'daemon.pid'), String(activePid));
    writeFileSync(join(sessionDir, 'supervisor.pid'), String(activePid));
    atomicWrite(join(sessionDir, 'mcp_servers'), mcpIdentity);
  } else {
    outputOffset = statSync(stdoutPath).size;
  }
  if (activePid === null) throw new Error('Codex app-server has no daemon pid');
  writeFileSync(join(runDir, 'pid'), String(activePid));
  // Learn the turn id when the response is read: a previous turn's late events can
  // follow it in the same read, and the awaiting code only resumes after the batch.
  const client = new CodexRpcClient((line) => sendProtocolLine(stdinPath, line), (method, result) => {
    if (method !== 'turn/start') return;
    state.turnId = string(record(result.turn).id) || string(result.turnId) || state.turnId;
    turnStartPending = false;
    for (const line of deferredTurnLines.splice(0)) handleLine(line);
  });

  const state: RunnerState = {
    threadId: '',
    turnId: '',
    completed: false,
    exitStatus: 'failed',
    capacityFailure: false,
    meaningfulTurnOutput: false,
  };
  const pendingUserInput = new Map<string, RpcId>();
  // Until the turn/start response names the new turn, turn-scoped events cannot be
  // told apart from a previous turn's late ones. They wait here, in order.
  let turnStartPending = false;
  const deferredTurnLines: string[] = [];
  let recovery = new ToolCallRecovery();
  const retiredTurns = new Set<string>();
  let runCompleted = false;
  let firstOutputRecorded = false;
  let promptDispatchedAtMs: number | null = null;
  const recordFirstOutput = (): void => {
    if (firstOutputRecorded || promptDispatchedAtMs === null) return;
    firstOutputRecorded = true;
    writeFileSync(join(runDir, 'first_output_at_ms'), String(Date.now()));
  };
  const publishControl = (): void => {
    const temporary = `${controlPath}.tmp.${process.pid}`;
    writeFileSync(
      temporary,
      JSON.stringify({
        version: 1,
        state: runCompleted ? 'completed' : state.turnId && !state.completed ? 'running' : 'starting',
        pid: activePid,
        threadId: state.threadId || null,
        turnId: state.turnId || null,
      }),
    );
    renameSync(temporary, controlPath);
  };
  const poller = new ControlRequestPoller(
    requestsDir,
    responsesDir,
    client,
    pendingUserInput,
    () => state,
    stderr,
  );

  const handleLine = (line: string): void => {
    let message: RpcMessage;
    try {
      message = record(JSON.parse(line)) as RpcMessage;
    } catch {
      return;
    }
    if (client.handleResponse(message)) return;
    const params = record(message.params);
    // One app-server streams the parent and all delegated threads. Child events
    // remain in the raw journal, but must not change this run's controls, output,
    // usage, fallback decision, or terminal status. Their token usage is still
    // billed to this run, through a sidecar that only the run metrics read.
    const eventThreadId = string(params.threadId);
    if (eventThreadId && eventThreadId !== state.threadId) {
      if (message.method === 'thread/tokenUsage/updated' && state.turnId) {
        const usage = record(record(params.tokenUsage).last);
        appendFileSync(join(runDir, 'subagent-usage.jsonl'), `${JSON.stringify({
          threadId: eventThreadId,
          inputTokens: Number(usage.inputTokens) || 0,
          cachedInputTokens: Number(usage.cachedInputTokens) || 0,
          cacheWriteInputTokens: Number(usage.cacheWriteInputTokens) || 0,
          outputTokens: Number(usage.outputTokens) || 0,
          reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0,
        })}\n`);
      }
      return;
    }
    const eventTurnId = string(params.turnId) ||
      (message.method?.startsWith('turn/') ? string(record(params.turn).id) : '');
    if (eventTurnId && retiredTurns.has(eventTurnId)) return;
    if (eventTurnId && turnStartPending) {
      deferredTurnLines.push(line);
      return;
    }
    if (eventTurnId && state.turnId && eventTurnId !== state.turnId) return;
    if (
      message.id !== undefined &&
      (message.method === 'item/tool/requestUserInput' ||
        message.method === 'tool/requestUserInput')
    ) {
      v1.consume(message);
      const requestId = String(message.id);
      pendingUserInput.set(requestId, message.id);
      recordFirstOutput();
      return;
    }
    // thread/resume replays the previous turn's last token-usage snapshot.
    // It belongs to history, not to this run's incremental usage or metrics.
    if (message.method === 'thread/tokenUsage/updated' && !state.turnId) return;
    if (message.method === 'turn/started') {
      const turn = record(params.turn);
      state.turnId = string(turn.id) || string(params.turnId) || state.turnId;
      publishControl();
    }
    if (isCapacityFailure(message)) state.capacityFailure = true;
    if (isMeaningfulTurnMessage(message)) state.meaningfulTurnOutput = true;
    const suppressCapacityFailure = Boolean(
      args.fallbackModel &&
      isCapacityFailure(message) &&
      !state.meaningfulTurnOutput,
    );
    recovery.consume(message);
    if (!suppressCapacityFailure) v1.consume(message);
    if (!suppressCapacityFailure && isOutputMessage(message)) recordFirstOutput();
    if (message.method === 'turn/completed') {
      state.exitStatus = string(record(params.turn).status, 'completed');
      state.completed = true;
      publishControl();
    }
  };
  const outputCursor: OutputCursor = { offset: outputOffset };
  const consumeOutput = (): void => {
    for (const line of readCompleteLines(stdoutPath, outputCursor, rawCodexPath)) {
      handleLine(line);
    }
    if (!isAlive(activePid)) client.rejectAll(new Error('Codex supervisor exited'));
  };
  const outputTimer = setInterval(consumeOutput, 10);
  outputTimer.unref();

  poller.start();
  let daemonReusable = false;
  try {
    publishControl();
    if (newDaemon) {
      await client.send('initialize', {
        clientInfo: { name: 'carapa-runner', version: '1' },
        ...(nativePlanFeature ? { capabilities: { experimentalApi: true } } : {}),
      });
      client.notify('initialized', {});
    }
    if (!newDaemon) state.threadId = trimmed(join(sessionDir, 'thread_id'));
    const resumeThreadId = args.sessionId || trimmed(join(sessionDir, 'thread_id'));
    let resumedThread = !newDaemon && Boolean(state.threadId);
    if (newDaemon && resumeThreadId) {
      try {
        const resumeParams: CodexMethods['thread/resume']['params'] = {
          threadId: resumeThreadId,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
        };
        if (profileSettings.modelProvider) {
          resumeParams.modelProvider = profileSettings.modelProvider;
        }
        await client.send('thread/resume', resumeParams);
        state.threadId = resumeThreadId;
        resumedThread = true;
      } catch (error) {
        writeFileSync(join(runDir, 'persistent_resume_failed'), resumeThreadId);
        stderr.write(
          `Codex thread/resume failed for ${resumeThreadId}: ${errorMessage(error)}\n`,
        );
        state.threadId = '';
      }
    }
    if (!state.threadId) {
      const startParams: CodexMethods['thread/start']['params'] = {
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        model: args.model || undefined,
        developerInstructions: args.systemPrompt || undefined,
      };
      if (profileSettings.modelProvider) {
        startParams.modelProvider = profileSettings.modelProvider;
      }
      const result = await client.send('thread/start', startParams);
      state.threadId = string(record(result.thread).id) || string(result.threadId);
    }
    if (!state.threadId) throw new Error('Codex app-server returned no thread id');
    if (persistent) writeFileSync(join(sessionDir, 'thread_id'), state.threadId);
    daemonReusable = true;
    v1.session(state.threadId, resumedThread);
    v1.start();
    publishControl();

    const runTurn = async (model: string, effort: string, input = prompt): Promise<void> => {
      state.completed = false;
      if (state.turnId) retiredTurns.add(state.turnId);
      state.turnId = '';
      turnStartPending = true;
      state.capacityFailure = false;
      state.meaningfulTurnOutput = false;
      recovery = new ToolCallRecovery();
      const turnParams: CodexMethods['turn/start']['params'] = {
        threadId: state.threadId,
        input: [{ type: 'text', text: input }],
        model: model || undefined,
        effort: effort || undefined,
      };
      if (nativePlanFeature) {
        turnParams.collaborationMode = {
          mode: nativePlanMode ? 'plan' : 'default',
          settings: {
            model: model || null,
            reasoning_effort: effort || 'medium',
            developer_instructions: null,
          },
        };
      }
      if (promptDispatchedAtMs === null) {
        promptDispatchedAtMs = Date.now();
        writeFileSync(join(runDir, 'prompt_dispatched_at_ms'), String(promptDispatchedAtMs));
      }
      v1.beginTurn(model, effort);
      let result: JsonRecord;
      try {
        result = await client.send('turn/start', turnParams);
      } finally {
        turnStartPending = false;
        deferredTurnLines.length = 0;
      }
      state.turnId = string(record(result.turn).id) || string(result.turnId) || state.turnId;
      publishControl();
      while (!state.completed) {
        if (!isAlive(activePid)) {
          throw new Error('Codex app-server exited during the turn');
        }
        await Bun.sleep(100);
      }
    };

    let model = args.model;
    let effort = args.reasoningEffort;
    await runTurn(model, effort);
    if (state.capacityFailure && !state.meaningfulTurnOutput && args.fallbackModel) {
      stderr.write(
        `Codex model ${args.model || '(default)'} at capacity; retrying once with ${args.fallbackModel}\n`,
      );
      model = args.fallbackModel;
      effort = args.fallbackReasoningEffort;
      await runTurn(model, effort);
    }
    const correction = new ToolCallCorrection();
    // Provider retries can fail after printing a call (for example, truncated
    // output followed by invalid_assistant_history). Give that turn the same
    // bounded correction, while leaving interruptions and unrelated failures alone.
    for (; ['completed', 'failed'].includes(state.exitStatus) && recovery.needed();) {
      await poller.handle();
      if (poller.interrupted || existsSync(join(runDir, 'turn_interrupt'))) {
        state.exitStatus = 'interrupted';
        v1.consume({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
        break;
      }
      const correctionPrompt = correction.next();
      const notice: RpcMessage = { method: 'item/completed', params: { item: {
        id: `tool-protocol-correction-${state.turnId}`,
        type: 'agentMessage',
        text: TOOL_CALL_CORRECTION_NOTICE,
      } } };
      v1.consume(notice);
      await runTurn(model, effort, correctionPrompt);
    }
  } catch (error) {
    daemonReusable = false;
    v1.runtimeError(error);
    stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    state.exitStatus = 'failed';
  } finally {
    clearInterval(outputTimer);
    consumeOutput();
    poller.stop();
    state.completed = true;
    runCompleted = true;
    publishControl();
    v1.finish();
    if (!persistent || !daemonReusable || !isAlive(activePid)) {
      await cleanupCodexProcesses(activePid, runTag, stderr);
      rmSync(stdinPath, { recursive: true, force: true });
      if (persistent) rmSync(join(sessionDir, 'daemon.pid'), { force: true });
    } else {
      writeFileSync(join(sessionDir, 'last_used'), '');
      utimesSync(join(sessionDir, 'last_used'), new Date(), new Date());
    }
    if (lock) releaseSessionLock(lock);
    stderr.end();
  }
  return state.exitStatus === 'completed' ? 0 : 1;
}

const runDir = process.argv[2];
if (!runDir) throw new Error('usage: main.ts <run-dir>');
try {
  process.exitCode = await run(runDir);
} catch (error) {
  const eventPath = join(resolve(runDir), 'output.v1.jsonl');
  const manifestPath = join(resolve(runDir), 'output.v1.meta.json');
  if (existsSync(eventPath) && existsSync(manifestPath)) {
    const events = readFileSync(eventPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [record(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    const terminal = events.some(
      (event) =>
        event.type === 'run' &&
        ['completed', 'interrupted', 'failed'].includes(string(event.status)),
    );
    if (!terminal) {
      if (!events.some((event) => event.type === 'run' && event.status === 'started')) {
        appendFileSync(eventPath, `${JSON.stringify({ type: 'run', status: 'started' })}\n`);
      }
      const message = errorMessage(error);
      appendFileSync(
        eventPath,
        `${JSON.stringify({ type: 'error', message, fatal: true })}\n` +
          `${JSON.stringify({
            type: 'run',
            status: 'failed',
            stopReason: 'runtime_error',
            error: { message },
          })}\n`,
      );
    }
  }
  throw error;
}
