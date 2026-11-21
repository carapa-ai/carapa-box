import type { RunContext } from '../contracts';
import type { RunV1TerminalStatus } from '../run-v1';
import { RunV1Writer } from '../run-v1';

type Json = Record<string, any>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;

const string = (...values: unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0);

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const block = object(item);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

function terminalStatus(stopReason: unknown): RunV1TerminalStatus {
  switch (stopReason) {
    case 'aborted':
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'interrupted';
    case 'error':
    case 'failed':
      return 'failed';
    default:
      return 'completed';
  }
}

function toolCategory(name: string): 'execute' | 'read' | 'edit' | 'search' | 'mcp' | 'other' {
  if (/^(bash|shell|terminal|exec|command)$/i.test(name)) return 'execute';
  if (/^(read|view|open)/i.test(name)) return 'read';
  if (/^(write|edit|patch|replace)/i.test(name)) return 'edit';
  if (/^(search|find|grep|rg)/i.test(name)) return 'search';
  if (/^mcp[:_-]/i.test(name)) return 'mcp';
  return 'other';
}

function normalizedToolOutput(value: unknown): unknown {
  const text = textFromContent(object(value)?.content);
  if (text) return text.trim() === '(no output)' ? undefined : text;
  return value;
}

function normalizedPlanStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  if (value === 'completed' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'active') return 'in_progress';
  return 'pending';
}

function messageFingerprint(message: Json): string {
  return JSON.stringify([
    message.timestamp,
    message.stopReason,
    message.usage,
    textFromContent(message.content),
  ]);
}

export class PiRunV1Adapter {
  private activeMessageId: string | null = null;
  private messageSequence = 0;
  private readonly partialText = new Map<string, string>();
  private readonly emittedMessages = new Set<string>();
  private readonly emittedUsage = new Set<string>();
  // agent_end re-sends messages already emitted at message_end as new objects,
  // and a provider may give them no id, so identity has to come from content.
  private readonly endedMessages = new Set<string>();
  private readonly toolOutput = new Map<string, string>();
  private currentModel: string;
  private lastStopReason = 'stop';
  private started = false;

  constructor(
    private readonly writer: RunV1Writer,
    private readonly context: RunContext,
  ) {
    this.currentModel = context.args.model;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({
      type: 'run',
      status: 'started',
      ...(this.context.args.model ? { model: this.context.args.model } : {}),
      ...(this.context.args.reasoningEffort
        ? { reasoningEffort: this.context.args.reasoningEffort }
        : {}),
      ...(this.context.args.chatMode ? { mode: this.context.args.chatMode } : {}),
    });
  }

  session(id: string, resumed: boolean): void {
    this.writer.append({ type: 'session', id, status: resumed ? 'resumed' : 'started' });
  }

  consume(record: Json): void {
    if (record.type === 'session') {
      const id = string(record.sessionId, record.session_id, record.id);
      if (id) this.session(id, false);
      return;
    }
    if (
      record.type === 'message_start' ||
      record.type === 'message_update' ||
      record.type === 'message_end' ||
      record.type === 'tool_execution_start' ||
      record.type === 'tool_execution_update' ||
      record.type === 'tool_execution_end' ||
      record.type === 'plan_update' ||
      record.type === 'error' ||
      record.type === 'turn.failed' ||
      record.type === 'agent_end'
    ) {
      this.start();
    }
    switch (record.type) {
      case 'message_start':
        this.observeMessage(record.message);
        return;
      case 'message_update':
        this.messageUpdate(record);
        return;
      case 'message_end':
        this.messageEnd(record.message);
        return;
      case 'tool_execution_start':
        this.toolStart(record);
        return;
      case 'tool_execution_update':
        this.toolUpdate(record);
        return;
      case 'tool_execution_end':
        this.toolEnd(record);
        return;
      case 'plan_update':
        this.plan(record);
        return;
      case 'error':
      case 'turn.failed':
        this.error(record);
        return;
      case 'agent_end':
        this.agentEnd(record);
        return;
      default:
        return;
    }
  }

  finish(status: RunV1TerminalStatus, stopReason: string, error?: string): void {
    this.start();
    this.finishOpenMessage(status === 'completed' ? 'interrupted' : status);
    this.writer.finish(status, {
      stopReason,
      ...(error ? { error: { message: error } } : {}),
    });
  }

  beginContinuation(): void {
    this.activeMessageId = null;
  }

  get stopReason(): string {
    return this.lastStopReason;
  }

  get runStatus(): RunV1TerminalStatus {
    return terminalStatus(this.lastStopReason);
  }

  private observeMessage(raw: unknown): string {
    const message = object(raw);
    // Keep the first identity for the whole message. Deltas are already written
    // under it, and the provider id usually only appears on the final message;
    // switching ids mid-message would split one answer into two V1 entries.
    const nativeId = string(message?.responseId, message?.id);
    if (nativeId && !this.activeMessageId) this.activeMessageId = nativeId;
    if (!this.activeMessageId) {
      this.messageSequence += 1;
      this.activeMessageId = `pi-message-${this.messageSequence}`;
    }
    return this.activeMessageId;
  }

  private messageUpdate(record: Json): void {
    const event = object(record.assistantMessageEvent);
    const partial = object(event?.partial) ?? object(record.message);
    const id = this.observeMessage(partial);
    if (event?.type !== 'text_delta' || typeof event.delta !== 'string') return;
    this.partialText.set(id, (this.partialText.get(id) ?? '') + event.delta);
    this.writer.append({
      type: 'message_delta',
      id,
      role: 'assistant',
      delta: event.delta,
    });
  }

  private messageEnd(raw: unknown): void {
    const message = object(raw);
    if (!message || message.role !== 'assistant') return;
    this.emitAssistantMessage(message);
    this.endedMessages.add(messageFingerprint(message));
    this.activeMessageId = null;
  }

  private emitAssistantMessage(message: Json): void {
    const id = this.observeMessage(message);
    const stopReason = string(message.stopReason) ?? 'stop';
    this.lastStopReason = stopReason;
    this.observeModel(string(message.responseModel, message.model));
    const content = textFromContent(message.content) || this.partialText.get(id) || '';
    const status = terminalStatus(stopReason) === 'interrupted' ? 'interrupted' : 'completed';
    if (content.trim() && !this.emittedMessages.has(id)) {
      this.writer.append({
        type: 'message',
        id,
        role: 'assistant',
        content,
        format: 'markdown',
        status,
      });
      this.emittedMessages.add(id);
    }
    this.emitUsage(id, message.usage);
    if (stopReason === 'error' && string(message.errorMessage)) {
      this.writer.append({
        type: 'error',
        message: String(message.errorMessage),
        fatal: true,
      });
    }
    this.partialText.delete(id);
  }

  private emitUsage(id: string, raw: unknown): void {
    const usage = object(raw);
    if (!usage || this.emittedUsage.has(id)) return;
    this.emittedUsage.add(id);
    this.writer.append({
      type: 'usage',
      scope: 'incremental',
      inputTokens: Math.max(0, Number(usage.input ?? 0)),
      outputTokens: Math.max(0, Number(usage.output ?? 0)),
      cachedInputTokens: Math.max(0, Number(usage.cacheRead ?? 0)),
      cacheWriteInputTokens: Math.max(0, Number(usage.cacheWrite ?? 0)),
      reasoningOutputTokens: Math.max(0, Number(usage.reasoning ?? 0)),
    });
  }

  private observeModel(value: unknown): void {
    const model = string(value);
    if (!model || model === this.currentModel) return;
    this.currentModel = model;
    this.writer.append({ type: 'run', status: 'in_progress', model });
  }

  private toolStart(record: Json): void {
    const id = string(record.toolCallId);
    const name = string(record.toolName);
    if (!id || !name) return;
    this.writer.append({
      type: 'tool_call',
      id,
      status: 'started',
      name,
      category: toolCategory(name),
      ...(record.args === undefined ? {} : { input: record.args }),
    });
  }

  private toolUpdate(record: Json): void {
    const id = string(record.toolCallId);
    if (!id) return;
    const current = textFromContent(object(record.partialResult)?.content);
    if (!current) return;
    const previous = this.toolOutput.get(id) ?? '';
    const delta = current.startsWith(previous) ? current.slice(previous.length) : current;
    this.toolOutput.set(id, current);
    if (!delta) return;
    this.writer.append({
      type: 'tool_call',
      id,
      status: 'in_progress',
      outputDelta: delta,
    });
  }

  private toolEnd(record: Json): void {
    const id = string(record.toolCallId);
    const name = string(record.toolName);
    if (!id) return;
    const output = normalizedToolOutput(record.result);
    if (record.isError === true) {
      const message = typeof output === 'string' && output.trim() ? output : 'Tool failed';
      this.writer.append({
        type: 'tool_call',
        id,
        status: 'failed',
        ...(name ? { name } : {}),
        ...(output === undefined ? {} : { output }),
        error: { message },
      });
    } else {
      this.writer.append({
        type: 'tool_call',
        id,
        status: 'completed',
        ...(name ? { name } : {}),
        ...(output === undefined ? {} : { output }),
      });
    }
    this.toolOutput.delete(id);
  }

  private plan(record: Json): void {
    if (!Array.isArray(record.entries)) return;
    this.writer.append({
      type: 'plan',
      id: 'pi-plan',
      entries: record.entries.map((entry: unknown, index: number) => {
        const value = object(entry) ?? {};
        return {
          id: string(value.id) ?? `plan-${index + 1}`,
          content: string(value.content, value.text, value.step) ?? '',
          status: normalizedPlanStatus(value.status),
        };
      }),
    });
  }

  private error(record: Json): void {
    const nested = object(record.error);
    const message = string(record.message, nested?.message);
    if (!message) return;
    const code = string(record.code, nested?.code);
    this.writer.append({
      type: 'error',
      message,
      fatal: record.fatal === true,
      ...(code ? { code } : {}),
      ...(nested?.details === undefined ? {} : { details: nested.details }),
    });
  }

  private agentEnd(record: Json): void {
    if (!Array.isArray(record.messages)) return;
    const assistant = [...record.messages]
      .reverse()
      .map(object)
      .find((message) => message?.role === 'assistant');
    if (assistant && !this.endedMessages.has(messageFingerprint(assistant))) {
      this.emitAssistantMessage(assistant);
    }
  }

  private finishOpenMessage(status: 'completed' | 'interrupted' | 'failed'): void {
    if (!this.activeMessageId) return;
    const content = this.partialText.get(this.activeMessageId) ?? '';
    if (content.trim() && !this.emittedMessages.has(this.activeMessageId)) {
      this.writer.append({
        type: 'message',
        id: this.activeMessageId,
        role: 'assistant',
        content,
        format: 'markdown',
        status: status === 'completed' ? 'completed' : 'interrupted',
      });
      this.emittedMessages.add(this.activeMessageId);
    }
    this.partialText.delete(this.activeMessageId);
    this.activeMessageId = null;
  }
}
