import type { CarapaRunEventV1 } from './run-v1';
import { RunV1Writer } from './run-v1';

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const string = (...values: unknown[]): string => values.find((value): value is string => typeof value === 'string') || '';
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function toolCategory(name: string): CarapaRunEventV1 extends infer E
  ? E extends { type: 'tool_call'; category?: infer C } ? C : never : never {
  if (name === 'bash' || name === 'shell') return 'execute';
  if (name === 'read' || name === 'ls') return 'read';
  if (name === 'edit' || name === 'write' || name === 'delete') return 'edit';
  if (name === 'grep' || name === 'glob' || name === 'find') return 'search';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Canonicalizes the ACP updates produced by the OMP ACP harness. ACP is the
 * native protocol for this path; its exact frames remain in acp.raw.jsonl. */
export class OmpAcpRunV1Adapter {
  private readonly messageId: string;
  private messageText = '';
  private readonly tools = new Map<string, string>();
  private started = false;
  private terminal = false;
  private status: 'completed' | 'interrupted' | 'failed' = 'completed';
  private stopReason = 'end_turn';
  private model = '';

  constructor(
    private readonly writer: RunV1Writer,
    private readonly requestedModel: string,
    private readonly resumed: boolean,
    messageId = 'omp-acp-message-1',
  ) {
    this.messageId = messageId;
  }

  start(sessionId: string): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({ type: 'session', id: sessionId, status: this.resumed ? 'resumed' : 'started' });
    this.writer.append({ type: 'run', status: 'started', ...(this.requestedModel ? { model: this.requestedModel } : {}) });
  }

  consume(message: JsonRecord): void {
    if (this.terminal) return;
    const update = record(record(message.params).update);
    if (message.method !== 'session/update') return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = string(record(update.content).text);
        if (!text) return;
        this.messageText += text;
        this.writer.append({ type: 'message_delta', id: this.messageId, role: 'assistant', delta: text });
        return;
      }
      case 'tool_call': {
        const id = string(update.toolCallId) || `omp-acp-tool-${this.tools.size + 1}`;
        const name = string(update.title, record(update.rawInput).command, 'tool');
        this.tools.set(id, name);
        this.writer.append({ type: 'tool_call', id, status: 'started', name, category: toolCategory(name), input: update.rawInput });
        return;
      }
      case 'tool_call_update': {
        const id = string(update.toolCallId);
        if (!id) return;
        const name = this.tools.get(id) || string(update.title, 'tool');
        const terminal = ['completed', 'failed', 'finished', 'cancelled'].includes(string(update.status));
        if (!terminal) {
          this.writer.append({ type: 'tool_call', id, status: 'in_progress', name, category: toolCategory(name), outputDelta: update.rawOutput ?? update.content });
          return;
        }
        const failed = string(update.status) === 'failed';
        this.writer.append({ type: 'tool_call', id, status: failed ? 'failed' : 'completed', name, category: toolCategory(name), output: update.rawOutput ?? update.content, ...(failed ? { error: { message: 'OMP ACP tool failed', details: update.rawOutput ?? update.content } } : {}) });
        return;
      }
      case 'usage_update': {
        const usage = record(update);
        const inputTokens = number(usage.inputTokens) ?? number(usage.input);
        const outputTokens = number(usage.outputTokens) ?? number(usage.output);
        if (inputTokens !== undefined && outputTokens !== undefined) {
          this.writer.append({ type: 'usage', scope: 'cumulative', inputTokens, outputTokens, ...(number(usage.cachedInputTokens) === undefined ? {} : { cachedInputTokens: number(usage.cachedInputTokens) }) });
        }
        return;
      }
      case 'session_info_update': {
        const metadata = record(update._meta);
        const nextModel = string(update.model, update.modelId, metadata.upstreamModel, metadata.model);
        if (nextModel && nextModel !== this.model && nextModel !== this.requestedModel) this.writer.append({ type: 'run', status: 'in_progress', model: nextModel });
        if (nextModel) this.model = nextModel;
        return;
      }
      default:
        return;
    }
  }

  finish(exitCode: number, failure = ''): void {
    if (this.terminal) return;
    if (this.messageText) this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.messageText, format: 'markdown', status: exitCode === 0 ? 'completed' : 'interrupted' });
    if (failure) {
      this.status = 'failed';
      this.stopReason = 'runtime_error';
      this.writer.append({ type: 'error', message: failure, fatal: true });
    }
    if (exitCode !== 0 && this.status === 'completed') this.status = 'failed';
    this.writer.finish(this.status, { stopReason: exitCode === 0 ? this.stopReason : this.stopReason });
    this.terminal = true;
  }
}
