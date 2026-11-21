import type { CarapaRunEventV1 } from './run-v1';
import { RunV1Writer } from './run-v1';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (...values: unknown[]): string => values.find((value): value is string => typeof value === 'string' && value.length > 0) || '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function category(name: string): CarapaRunEventV1 extends infer E ? E extends { type: 'tool_call'; category?: infer C } ? C : never : never {
  if (name === 'bash' || name === 'shell') return 'execute';
  if (name === 'read' || name === 'read_file' || name === 'ls') return 'read';
  if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'delete') return 'edit';
  if (name === 'grep' || name === 'glob' || name === 'find') return 'search';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Tool names Board renders as a short `**Name** \`arg\`` header. ACP titles
 * are prose ("Editing x.ts", "bash: git diff"), so when the agent reports one
 * of these names in `_meta.tool_name` (Mistral Vibe does) use it instead. */
const BOARD_TOOL_NAMES = new Set(['bash', 'read', 'read_file', 'edit', 'write', 'write_file', 'delete', 'grep', 'glob']);

function toolName(update: Json): string {
  const metaName = string(record(update._meta).tool_name);
  if (BOARD_TOOL_NAMES.has(metaName)) return metaName;
  return string(update.title, record(update.rawInput).command, 'tool');
}

export class StandardAcpRunV1Adapter {
  private readonly baseMessageId: string;
  private messageId: string;
  private segment = 1;
  private readonly tools = new Map<string, string>();
  private messageText = '';
  private started = false;
  private terminal = false;
  private status: 'completed' | 'interrupted' | 'failed' = 'completed';
  private stopReason = 'end_turn';
  private model = '';
  /** Vibe streams per-turn totals in usage_update._meta; kept for runs that end without a PromptResponse. */
  private streamedUsage: { total: number; output: number; cached: number } | undefined;
  private usageWritten = false;
  /** Vibe's counters are session-wide: what an earlier run or the crashed attempt already spent is taken off. */
  private baseline = { total: 0, output: 0, cached: 0 };
  /** Tokens in the model's context now, from `usage_update.used`. */
  private contextTokens: number | undefined;

  constructor(private readonly writer: RunV1Writer, private readonly requestedModel: string, private readonly resumed: boolean, messageId = 'acp-message-1') {
    this.baseMessageId = this.messageId = messageId;
  }

  /** Vibe reports the session's running totals when a session starts or loads, and after every turn. Whatever
   * the newest such report before this run's prompt holds was spent earlier, so the run bills only what it adds. */
  restored(message: Json): void {
    if (message.method !== 'session/update') return;
    const update = record(record(message.params).update);
    if (string(update.sessionUpdate) !== 'usage_update') return;
    const meta = record(update._meta);
    const total = number(meta.promptTokens);
    const output = number(meta.completionTokens);
    if (total !== undefined && output !== undefined) this.baseline = { total, output, cached: number(meta.cachedTokens) ?? 0 };
  }

  /** Close the text written so far so replay keeps it before the next tool call. */
  private closeMessage(status: 'completed' | 'interrupted'): void {
    if (!this.messageText) return;
    this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.messageText, format: 'markdown', status });
    this.messageText = '';
    this.messageId = `${this.baseMessageId}-${++this.segment}`;
  }

  start(sessionId: string): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({ type: 'session', id: sessionId, status: this.resumed ? 'resumed' : 'started' });
    this.writer.append({ type: 'run', status: 'started', ...(this.requestedModel ? { model: this.requestedModel } : {}) });
  }

  consume(message: Json): void {
    if (this.terminal || message.method !== 'session/update') return;
    const update = record(record(message.params).update);
    const kind = string(update.sessionUpdate);
    if (kind === 'agent_message_chunk') {
      const text = string(record(update.content).text);
      if (!text) return;
      this.messageText += text;
      this.writer.append({ type: 'message_delta', id: this.messageId, role: 'assistant', delta: text });
      return;
    }
    if (kind === 'agent_thought_chunk') return;
    if (kind === 'tool_call') {
      const id = string(update.toolCallId) || `acp-tool-${this.tools.size + 1}`;
      const name = toolName(update);
      this.closeMessage('completed');
      this.tools.set(id, name);
      this.writer.append({ type: 'tool_call', id, status: 'started', name, category: category(name), input: update.rawInput });
      // Antigravity replays a finished tool as a single tool_call that is already terminal.
      if (!['completed', 'failed', 'finished', 'cancelled'].includes(string(update.status))) return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = string(update.toolCallId);
      if (!id) return;
      const name = this.tools.get(id) || string(update.title, 'tool');
      const terminal = ['completed', 'failed', 'finished', 'cancelled'].includes(string(update.status));
      if (!terminal) {
        this.writer.append({ type: 'tool_call', id, status: 'in_progress', name, category: category(name), outputDelta: update.rawOutput ?? update.content });
        return;
      }
      const failed = string(update.status) === 'failed';
      this.writer.append({ type: 'tool_call', id, status: failed ? 'failed' : 'completed', name, category: category(name), output: update.rawOutput ?? update.content, ...(failed ? { error: { message: 'ACP tool failed', details: update.rawOutput ?? update.content } } : {}) });
      this.tools.delete(id);
      return;
    }
    if (kind === 'usage_update') {
      this.contextTokens = number(update.used) ?? this.contextTokens;
      const inputTokens = number(update.inputTokens) ?? number(update.input);
      const outputTokens = number(update.outputTokens) ?? number(update.output);
      if (inputTokens !== undefined && outputTokens !== undefined) this.writer.append({ type: 'usage', scope: 'cumulative', inputTokens, outputTokens });
      const meta = record(update._meta);
      const promptTokens = number(meta.promptTokens);
      const completionTokens = number(meta.completionTokens);
      if (promptTokens !== undefined && completionTokens !== undefined) {
        const { total, output, cached } = this.baseline;
        this.streamedUsage = { total: Math.max(0, promptTokens - total), output: Math.max(0, completionTokens - output),
          cached: Math.max(0, (number(meta.cachedTokens) ?? 0) - cached) };
      }
      return;
    }
    if (kind === 'session_info_update') {
      const metadata = record(update._meta);
      const nextModel = string(update.upstreamModel, update.model, update.modelId, metadata.upstreamModel, metadata.model);
      if (nextModel && nextModel !== this.model && nextModel !== this.requestedModel) this.writer.append({ type: 'run', status: 'in_progress', model: nextModel });
      if (nextModel) this.model = nextModel;
    }
  }

  /** ACP PromptResponse.usage for this turn. Board expects fresh input with
   * cache reads counted separately. ACP's inputTokens usually include them;
   * Antigravity's do not, which its totalTokens (= input + cached + output) shows. */
  result(result: Json): void {
    if (this.terminal) return;
    const usage = record(result.usage);
    const reportedTotal = number(usage.inputTokens);
    const reportedOutput = number(usage.outputTokens);
    if (reportedTotal === undefined || reportedOutput === undefined) return;
    this.usageWritten = true;
    const total = Math.max(0, reportedTotal - this.baseline.total);
    const outputTokens = Math.max(0, reportedOutput - this.baseline.output);
    const cached = Math.max(0, (number(usage.cachedReadTokens) ?? 0) - this.baseline.cached);
    const cacheWrite = number(usage.cachedWriteTokens);
    const reasoning = number(usage.thoughtTokens);
    const excludesCache = number(usage.totalTokens) === reportedTotal + (number(usage.cachedReadTokens) ?? 0) + reportedOutput;
    const fresh = excludesCache ? total : Math.max(0, total - cached);
    // A prompt's usage adds up every model call it made, each reading the whole context again.
    // Board takes context occupancy from the input of the last entry, so when the agent says
    // how full the context is, the last entry carries exactly that much and the rest goes first.
    const context = this.contextTokens ?? 0;
    const lastCached = context > 0 && context < fresh + cached ? Math.min(cached, context) : cached;
    const lastFresh = context > 0 && context < fresh + cached ? Math.min(fresh, context - lastCached) : fresh;
    if (lastFresh < fresh || lastCached < cached) {
      this.writer.append({ type: 'usage', scope: 'incremental', inputTokens: fresh - lastFresh, outputTokens: 0,
        ...(cached - lastCached ? { cachedInputTokens: cached - lastCached } : {}) });
    }
    this.writer.append({ type: 'usage', scope: 'incremental', inputTokens: lastFresh, outputTokens,
      ...(lastCached ? { cachedInputTokens: lastCached } : {}), ...(cacheWrite ? { cacheWriteInputTokens: cacheWrite } : {}),
      ...(reasoning ? { reasoningOutputTokens: reasoning } : {}) });
  }

  /** Interrupted or crashed turns have no PromptResponse.usage; bill what was streamed. */
  private billStreamedUsage(): void {
    if (!this.usageWritten && this.streamedUsage && (this.streamedUsage.total || this.streamedUsage.output)) {
      const { total, output, cached } = this.streamedUsage;
      this.usageWritten = true;
      this.writer.append({ type: 'usage', scope: 'incremental', inputTokens: Math.max(0, total - cached), outputTokens: output, ...(cached ? { cachedInputTokens: cached } : {}) });
    }
  }

  private failOpenTools(): void {
    for (const [id, name] of this.tools) this.writer.append({ type: 'tool_call', id, status: 'failed', name, category: category(name), error: { message: 'ACP run ended before the tool completed' } });
    this.tools.clear();
  }

  /** A crashed attempt that the run retries: record its usage and open tools so the retry starts clean. */
  abandonAttempt(): void {
    if (this.terminal) return;
    this.closeMessage('interrupted');
    this.billStreamedUsage();
    this.failOpenTools();
    if (this.streamedUsage) {
      const { total, output, cached } = this.streamedUsage;
      this.baseline = { total: this.baseline.total + total, output: this.baseline.output + output, cached: this.baseline.cached + cached };
    }
    this.streamedUsage = undefined;
    this.usageWritten = false;
    this.contextTokens = undefined;
  }

  /** The retry runs in a new session whose counters start from zero, not in the reloaded one. */
  retryInNewSession(): void {
    this.baseline = { total: 0, output: 0, cached: 0 };
  }

  finish(exitCode: number, failure = ''): void {
    if (this.terminal) return;
    this.closeMessage(exitCode === 0 ? 'completed' : 'interrupted');
    this.billStreamedUsage();
    this.failOpenTools();
    if (failure || exitCode !== 0) this.status = 'failed';
    // Board renders `error` events; a bare run.error would leave the chat without a visible failure.
    if (failure) this.writer.append({ type: 'error', message: failure, fatal: true });
    this.writer.finish(this.status, { stopReason: exitCode === 0 ? this.stopReason : 'process_exit', ...(failure ? { error: { message: failure } } : {}) });
    this.terminal = true;
  }
}
