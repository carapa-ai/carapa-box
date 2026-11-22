import { appendFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from './contracts';
import { atomicWrite } from './files';
import { createRunV1Writer, RunV1Writer } from './run-v1';
import { terminateProcessTree } from './processes';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const string = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string') || '';
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function effectiveOpenCodeModel(value: unknown): string {
  const item = record(value);
  const model = string(item.modelID, item.modelId, item.model, item.model_name);
  const provider = string(item.providerID, item.providerId, item.provider);
  if (model && model !== 'auto') return model;
  return provider && model ? `${provider}/${model}` : provider;
}

export function openCodeRunCommand(context: {
  args: Pick<RunContext['args'], 'sessionId' | 'model' | 'agent' | 'reasoningEffort'>;
  prompt: string;
}): string[] {
  const command = ['opencode', 'run', '--format', 'json'];
  if (context.args.sessionId) command.push('--session', context.args.sessionId);
  if (context.args.model && !context.args.model.startsWith('claude')) command.push('--model', context.args.model);
  if (context.args.agent) command.push('--agent', context.args.agent);
  if (context.args.reasoningEffort) command.push('--variant', context.args.reasoningEffort);
  command.push(context.prompt);
  return command;
}

/**
 * Turns on OpenCode's language servers without its runtime downloads, which
 * would land in the shared home. Built-ins use servers the image installs; the
 * shared tsc replaces its npm TypeScript server. Project opencode.json wins.
 */
export function openCodeEnv(env: Record<string, string>): Record<string, string> {
  const result = { OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', ...env };
  if (env.OPENCODE_CONFIG) return result;
  const lsp = Bun.which('tsc', { PATH: env.PATH ?? '' })
    ? { typescript: { command: ['tsc', '--lsp', '--stdio'], extensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'] } }
    : {};
  const config = JSON.stringify({ lsp });
  const path = join(env.TMPDIR || tmpdir(), `carapa-opencode-${createHash('sha256').update(config).digest('hex').slice(0, 12)}.json`);
  if (!existsSync(path)) atomicWrite(path, config);
  return { ...result, OPENCODE_CONFIG: path };
}

function exportedModel(value: unknown): string {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = exportedModel(value[index]);
      if (found) return found;
    }
    return '';
  }
  const item = record(value);
  if (item.role === 'assistant') {
    const model = effectiveOpenCodeModel(item);
    if (model) return model;
  }
  for (const child of Object.values(item)) {
    const found = exportedModel(child);
    if (found) return found;
  }
  return '';
}

function category(name: string): 'execute' | 'read' | 'edit' | 'search' | 'mcp' | 'other' {
  if (name === 'bash' || name === 'shell') return 'execute';
  if (name === 'read' || name === 'ls') return 'read';
  if (name === 'edit' || name === 'write' || name === 'delete') return 'edit';
  if (name === 'grep' || name === 'glob' || name === 'find') return 'search';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

export class OpenCodeRunV1Adapter {
  private started = false;
  private terminal = false;
  private messageText = '';
  private readonly tools = new Map<string, string>();
  private status: 'completed' | 'interrupted' | 'failed' = 'completed';
  private stopReason = 'end_turn';
  private sessionId = '';
  private effectiveModel = '';
  private terminalStep = false;
  private lastError = '';

  constructor(
    private readonly writer: RunV1Writer,
    private readonly requestedModel: string,
    private readonly resumed: boolean,
    private messageId = 'opencode-message-1',
  ) {}

  consume(event: JsonRecord): void {
    const eventModel = effectiveOpenCodeModel(event);
    if (eventModel) this.model(eventModel);
    const part = record(event.part);
    const partModel = effectiveOpenCodeModel(part);
    if (partModel) this.model(partModel);
    if (event.sessionID || event.sessionId) {
      const sessionId = string(event.sessionID, event.sessionId);
      if (sessionId && !this.sessionId) {
        this.sessionId = sessionId;
        this.writer.append({ type: 'session', id: sessionId, status: this.resumed ? 'resumed' : 'started' });
      }
    }
    switch (event.type) {
      case 'step_start':
        this.start();
        return;
      case 'text': {
        const text = string(part.text, event.text);
        if (!text) return;
        this.start();
        this.messageText += text;
        this.writer.append({ type: 'message_delta', id: this.messageId, role: 'assistant', delta: text });
        return;
      }
      case 'tool_use': {
        this.start();
        const state = record(part.state);
        const id = string(part.callID, part.id) || `opencode-tool-${this.tools.size + 1}`;
        const name = string(part.tool, 'tool');
        const input = state.input;
        const status = string(state.status);
        const known = this.tools.has(id);
        this.tools.set(id, name);
        if (status === 'completed' || status === 'error') {
          this.writer.append({ type: 'tool_call', id, status: status === 'error' ? 'failed' : 'completed', name, category: category(name), input, output: state.output, ...(status === 'error' ? { error: { message: string(state.error, 'OpenCode tool failed'), details: state.output } } : {}) });
          this.tools.delete(id);
        } else if (known) {
          this.writer.append({ type: 'tool_call', id, status: 'in_progress', name, category: category(name), input, outputDelta: state.output });
        } else {
          this.writer.append({ type: 'tool_call', id, status: 'started', name, category: category(name), input });
        }
        return;
      }
      case 'step_finish': {
        const tokens = record(part.tokens || event.tokens);
        const inputTokens = number(tokens.input);
        const outputTokens = number(tokens.output);
        if (inputTokens !== undefined && outputTokens !== undefined) {
          const cache = record(tokens.cache);
          this.writer.append({ type: 'usage', scope: 'incremental', inputTokens, outputTokens, ...(number(cache.read) === undefined ? {} : { cachedInputTokens: number(cache.read) }), ...(number(cache.write) === undefined ? {} : { cacheWriteInputTokens: number(cache.write) }) });
        }
        const reason = string(event.reason, part.reason);
        if (reason === 'stop' || reason === 'end_turn') {
          this.stopReason = reason;
          this.terminalStep = true;
        } else if (reason && reason !== 'tool-calls' && reason !== 'continue') {
          this.status = 'failed';
          this.stopReason = reason;
          this.fail(string(record(event.error).message, `OpenCode stopped with reason: ${reason}`));
        }
        return;
      }
      case 'error': {
        this.status = 'failed';
        this.stopReason = 'runtime_error';
        // `run --format json` nests the text as error: { name, data: { message } }.
        const error = record(event.error);
        this.fail(string(event.message, record(error.data).message, error.message, error.name, 'OpenCode runtime error'));
        return;
      }
      default:
        return;
    }
  }

  finish(exitCode: number): void {
    if (this.terminal) return;
    this.start();
    if (this.messageText) this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.messageText, format: 'markdown', status: exitCode === 0 ? 'completed' : 'interrupted' });
    for (const [id, name] of this.tools) this.writer.append({ type: 'tool_call', id, status: 'failed', name, category: category(name), error: { message: 'OpenCode run ended before the tool completed' } });
    if (exitCode !== 0) this.status = 'failed';
    this.writer.finish(this.status, {
      stopReason: exitCode === 0 ? this.stopReason : 'process_exit',
      ...(this.status === 'failed' && this.lastError ? { error: { message: this.lastError } } : {}),
    });
    this.terminal = true;
  }

  canContinue(): boolean { return this.status === 'completed' && this.terminalStep; }

  beginContinuation(): void {
    if (this.messageText) this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.messageText, format: 'markdown', status: 'completed' });
    this.messageText = '';
    this.messageId += '-correction';
    this.terminalStep = false;
  }

  getSessionId(): string { return this.sessionId; }
  hasTerminalStep(): boolean { return this.terminalStep; }

  setModel(value: string): void { this.model(value); }

  private fail(message: string): void {
    this.lastError = message;
    this.writer.append({ type: 'error', message, fatal: false });
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({ type: 'run', status: 'started', ...(this.requestedModel ? { model: this.requestedModel } : {}) });
  }

  private model(value: string): void {
    if (!value || value === this.requestedModel || value === this.effectiveModel) return;
    this.effectiveModel = value;
    this.writer.append({ type: 'run', status: 'in_progress', model: value });
  }
}

function lookupExportedModel(context: RunContext, sessionId: string): string {
  if (!sessionId) return '';
  const result = spawnSync('opencode', ['export', sessionId], {
    cwd: context.cwd,
    env: context.env,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return '';
  try { return exportedModel(JSON.parse(result.stdout)); } catch { return ''; }
}

export async function runOpenCodeNative(context: RunContext, command: string[]): Promise<number> {
  const rawPath = join(context.runDir, 'opencode.raw.jsonl');
  const writer = createRunV1Writer(context, 'opencode');
  const adapter = new OpenCodeRunV1Adapter(writer, context.args.model.trim(), Boolean(context.args.sessionId), `opencode-${context.runTag}-message-1`);
  const env = openCodeEnv(context.env);
  const run = async (command: string[]): Promise<number> => {
    let pending = Buffer.alloc(0);
    const child = spawn(command[0], command.slice(1), { cwd: context.cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalCleanup: Promise<void> | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      appendFileSync(rawPath, chunk);
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const line = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        if (line.trim()) {
          try { adapter.consume(JSON.parse(line) as JsonRecord); }
          catch (error) { adapter.consume({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
        }
        if (adapter.hasTerminalStep() && !stopTimer) {
          // OpenCode can stay alive after its final step. Stop only its child
          // tree; this wrapper must survive to export the model and finalize V1.
          stopTimer = setTimeout(() => {
            if (child.pid && child.exitCode === null && child.signalCode === null) {
              terminalCleanup = terminateProcessTree(child.pid);
            }
          }, 100);
        }
        newline = pending.indexOf(10);
      }
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? (terminalCleanup ? 0 : 1)));
    }).finally(() => {
      if (stopTimer) clearTimeout(stopTimer);
    });
    await terminalCleanup;
    if (pending.length) {
      appendFileSync(rawPath, pending);
      adapter.consume({ type: 'error', message: 'OpenCode output ended with an incomplete JSONL event' });
    }
    return exitCode;
  };
  let exitCode = 1;
  try {
    exitCode = await run(command);
    while (exitCode === 0 && adapter.canContinue() && writer.toolCallRecovery.needed() && !existsSync(join(context.runDir, 'turn_interrupt'))) {
      const session = adapter.getSessionId();
      if (!session) throw new Error('Cannot correct tool-call text: OpenCode returned no session to resume.');
      const correction = writer.correctToolCall();
      adapter.beginContinuation();
      const next = command.slice(0, -1);
      const sessionOption = next.indexOf('--session');
      if (sessionOption >= 0) next.splice(sessionOption, 2);
      next.push('--session', session, correction);
      exitCode = await run(next);
    }
  } catch (error) {
    exitCode = 1;
    adapter.consume({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  const resolvedModel = lookupExportedModel(context, adapter.getSessionId());
  if (resolvedModel) adapter.setModel(resolvedModel);
  adapter.finish(exitCode);
  return exitCode;
}
