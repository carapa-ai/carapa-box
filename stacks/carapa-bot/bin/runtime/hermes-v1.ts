import type { CarapaRunEventV1 } from './run-v1';
import { RunV1Writer } from './run-v1';

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const string = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || '';

function toolCategory(name: string): CarapaRunEventV1 extends infer E
  ? E extends { type: 'tool_call'; category?: infer C } ? C : never : never {
  if (name === 'bash' || name === 'shell') return 'execute';
  if (name === 'read' || name === 'ls') return 'read';
  if (name === 'edit' || name === 'write' || name === 'delete') return 'edit';
  if (name === 'grep' || name === 'glob' || name === 'find') return 'search';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Canonical Hermes ACP projection. Hermes' ACP stream is text/thought/tool
 * updates; response model metadata is accepted when Hermes emits it and the
 * requested model remains the honest fallback when it does not. */
export class HermesAcpRunV1Adapter {
  private readonly messageId: string;
  private readonly tools = new Map<string, string>();
  private messageText = '';
  private started = false;
  private terminal = false;
  private model = '';
  private status: 'completed' | 'interrupted' | 'failed' = 'completed';
  private stopReason = 'end_turn';

  constructor(
    private readonly writer: RunV1Writer,
    private readonly requestedModel: string,
    private readonly resumed: boolean,
    messageId = 'hermes-acp-message-1',
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
    if (kind === 'tool_call') {
      const id = string(update.toolCallId) || `hermes-acp-tool-${this.tools.size + 1}`;
      const name = string(update.title, record(update.rawInput).command, 'tool');
      this.tools.set(id, name);
      this.writer.append({ type: 'tool_call', id, status: 'started', name, category: toolCategory(name), input: update.rawInput });
      return;
    }
    if (kind === 'tool_call_update') {
      const id = string(update.toolCallId);
      if (!id) return;
      const name = this.tools.get(id) || string(update.title, 'tool');
      const terminal = ['completed', 'failed', 'finished', 'cancelled'].includes(string(update.status));
      if (!terminal) {
        this.writer.append({ type: 'tool_call', id, status: 'in_progress', name, category: toolCategory(name), outputDelta: update.rawOutput ?? update.content });
        return;
      }
      const failed = string(update.status) === 'failed';
      this.writer.append({ type: 'tool_call', id, status: failed ? 'failed' : 'completed', name, category: toolCategory(name), output: update.rawOutput ?? update.content, ...(failed ? { error: { message: 'Hermes ACP tool failed', details: update.rawOutput ?? update.content } } : {}) });
      this.tools.delete(id);
      return;
    }
    if (kind === 'session_info_update') {
      const metadata = record(update._meta);
      const fieldMeta = record(update.field_meta);
      const nextModel = string(update.upstreamModel, update.model, update.modelId, metadata.upstreamModel, metadata.model, fieldMeta.upstreamModel, fieldMeta.model);
      if (nextModel && nextModel !== this.model && nextModel !== this.requestedModel) this.writer.append({ type: 'run', status: 'in_progress', model: nextModel });
      if (nextModel) this.model = nextModel;
    }
  }

  finish(exitCode: number, failure = ''): void {
    if (this.terminal) return;
    if (this.messageText) this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.messageText, format: 'markdown', status: exitCode === 0 ? 'completed' : 'interrupted' });
    for (const [id, name] of this.tools) this.writer.append({ type: 'tool_call', id, status: 'failed', name, category: toolCategory(name), error: { message: 'Hermes ACP run ended before the tool completed' } });
    if (failure) this.status = 'failed';
    else if (exitCode !== 0) this.status = 'failed';
    // Board renders `error` events; a bare run.error would leave the chat without a visible failure.
    if (failure) this.writer.append({ type: 'error', message: failure, fatal: true });
    this.writer.finish(this.status, { stopReason: exitCode === 0 ? this.stopReason : 'process_exit', ...(failure ? { error: { message: failure } } : {}) });
    this.terminal = true;
  }
}
