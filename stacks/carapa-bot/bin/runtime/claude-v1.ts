import type { CarapaRunEventV1 } from './run-v1';
import { RunV1Writer } from './run-v1';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const string = (...values: unknown[]): string => values.find((value): value is string => typeof value === 'string' && value.length > 0) || '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function toolCategory(name: string): CarapaRunEventV1 extends infer E ? E extends { type: 'tool_call'; category?: infer C } ? C : never : never {
  if (name.startsWith('mcp__')) return 'mcp';
  const words = new Set(name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/));
  const has = (...candidates: string[]) => candidates.some(word => words.has(word));
  if (has('shell', 'bash', 'terminal', 'command')) return 'execute';
  if (has('read', 'list', 'ls')) return 'read';
  if (has('edit', 'write', 'file', 'delete')) return 'edit';
  if (has('grep', 'glob', 'find', 'search')) return 'search';
  return 'other';
}

function textBlocks(content: unknown, type: string): string {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    const block = record(item);
    if (block.type !== type) return '';
    return string(block.text, block.thinking);
  }).filter(Boolean).join('');
}

const FAILURE_TEXT_LIMIT = 4000;

/** Provider reason of a failed result frame: its errors, else the result text, else the subtype. */
function resultFailureText(event: JsonRecord): string {
  const errors = Array.isArray(event.errors) ? event.errors.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  const text = errors.length ? errors.join('; ') : event.is_error === true ? string(event.result) : '';
  return (text || `Claude result ${string(event.subtype, 'error')}`).slice(0, FAILURE_TEXT_LIMIT);
}

export class ClaudeRunV1Adapter {
  private readonly tools = new Map<string, string>();
  private readonly interactions = new Set<string>();
  private readonly emittedKinds = new Map<string, Set<string>>();
  private readonly messageUsage = new Map<string, JsonRecord>();
  private readonly streamedText = new Map<string, string>();
  private activeStreamMessageId = '';
  private usageFinalized = false;
  private readonly previousUsage: JsonRecord = {};
  private messageSequence = 0;
  private readonly seenResults = new Set<string>();
  private started = false;
  private terminal = false;
  private status: 'completed' | 'interrupted' | 'failed' = 'completed';
  private stopReason = 'end_turn';
  private sessionId = '';
  private model = '';

  constructor(
    private readonly writer: RunV1Writer,
    private readonly requestedModel: string,
    private readonly resumed: boolean,
    // Plan mode only: ExitPlanMode becomes the Board's plan answer, as for Codex.
    private readonly renderPlan?: (id: string, text: string) => string,
  ) { }

  consume(event: JsonRecord): void {
    // Sub-agent events belong to the parent's raw journal only.
    if (this.terminal || event.parent_tool_use_id) return;
    if (event.type === 'system' && event.subtype === 'init') {
      this.start(string(event.session_id, 'claude-session'));
      return;
    }
    if (event.type === 'stream_event') {
      this.consumeStreamEvent(event);
      return;
    }
    if (event.type === 'assistant') {
      this.start(string(event.session_id, this.sessionId || 'claude-session'));
      const message = record(event.message);
      const id = string(message.id) || `claude-${++this.messageSequence}`;
      // One provider message may arrive as several same-id `assistant` events
      // (e.g. a thinking segment followed by a text segment). Merge the kinds
      // already emitted for this id instead of dropping the follow-up event,
      // or a text-only follow-up would vanish from the V1 stream.
      const kinds = this.emittedKinds.get(id) ?? this.emittedKinds.set(id, new Set<string>()).get(id)!;
      const model = string(message.model);
      if (model && model !== this.model && model !== this.requestedModel) this.writer.append({ type: 'run', status: 'in_progress', model });
      if (model) this.model = model;
      const text = textBlocks(message.content, 'text');
      if (text) {
        const streamed = this.streamedText.get(id) || '';
        // Board displays deltas live and uses the completed message to close
        // that same entry. Keep a full-delta fallback for Claude versions or
        // compatible providers that do not emit partial stream events.
        if (!streamed) {
          this.writer.append({ type: 'message_delta', id, role: 'assistant', delta: text });
        } else if (text.startsWith(streamed) && text.length > streamed.length) {
          this.writer.append({ type: 'message_delta', id, role: 'assistant', delta: text.slice(streamed.length) });
        }
        kinds.add('text');
        this.writer.append({ type: 'message', id, role: 'assistant', content: text, format: 'markdown', status: 'completed' });
        this.streamedText.delete(id);
        if (this.activeStreamMessageId === id) this.activeStreamMessageId = '';
      }
      const thinking = textBlocks(message.content, 'thinking');
      if (thinking) {
        kinds.add('thought');
        this.writer.append({ type: 'thought', id: `${id}:thought`, content: thinking, format: 'markdown', status: 'completed' });
      }
      for (const blockValue of Array.isArray(message.content) ? message.content : []) {
        const block = record(blockValue);
        if (block.type !== 'tool_use') continue;
        const toolId = string(block.id) || `claude-tool-${this.tools.size + 1}`;
        const name = string(block.name, 'tool');
        if (name === 'AskUserQuestion') {
          if (kinds.has(toolId)) continue;
          kinds.add(toolId);
          const input = record(block.input);
          const questions = Array.isArray(input.questions) ? input.questions : [];
          this.interactions.add(toolId);
          this.writer.append({
            type: 'interaction',
            id: toolId,
            status: 'requested',
            questions: questions.map((value, index) => {
              const question = record(value);
              return {
                id: string(question.id, `question-${index + 1}`),
                header: string(question.header, 'Question'),
                question: string(question.question),
                options: Array.isArray(question.options)
                  ? question.options.map((option) => {
                    const entry = record(option);
                    const preview = string(entry.preview);
                    return { label: string(entry.label), description: string(entry.description), ...(preview ? { preview } : {}) };
                  })
                  : [],
                allowOther: Boolean(question.allowOther ?? question.isOther),
                secret: Boolean(question.secret ?? question.isSecret),
                ...(question.multiSelect === true ? { multiSelect: true } : {}),
              };
            }),
          });
          continue;
        }
        const plan = string(record(block.input).plan);
        if (name === 'ExitPlanMode' && this.renderPlan && plan) {
          if (kinds.has(toolId)) continue;
          kinds.add(toolId);
          const content = this.renderPlan(toolId, plan);
          this.writer.append({ type: 'message_delta', id: toolId, role: 'assistant', delta: content });
          this.writer.append({ type: 'message', id: toolId, role: 'assistant', content, format: 'markdown', status: 'completed' });
          continue;
        }
        if (kinds.has(toolId)) continue;
        this.tools.set(toolId, name);
        this.writer.append({ type: 'tool_call', id: toolId, status: 'started', name, category: toolCategory(name), input: block.input });
        kinds.add(toolId);
      }
      // Same-id segments contain usage snapshots, not additional API calls.
      if (message.usage) this.messageUsage.set(id, record(message.usage));
      return;
    }
    if (event.type === 'user') {
      for (const blockValue of Array.isArray(record(event.message).content) ? record(event.message).content as unknown[] : []) {
        const block = record(blockValue);
        if (block.type !== 'tool_result') continue;
        const id = string(block.tool_use_id);
        if (id && this.interactions.has(id)) {
          this.writer.append({ type: 'interaction', id, status: 'answered' });
          this.interactions.delete(id);
          continue;
        }
        if (!id || !this.tools.has(id)) continue;
        const name = this.tools.get(id) || 'tool';
        const failed = block.is_error === true;
        this.writer.append({ type: 'tool_call', id, status: failed ? 'failed' : 'completed', name, category: toolCategory(name), output: block.content, ...(failed ? { error: { message: 'Claude tool failed', details: block.content } } : {}) });
        this.tools.delete(id);
      }
      return;
    }
    if (event.type === 'result') {
      // A replayed result must not add its usage to the run a second time.
      const uuid = string(event.uuid);
      if (uuid && this.seenResults.has(uuid)) return;
      if (uuid) this.seenResults.add(uuid);
      this.start(string(event.session_id, this.sessionId || 'claude-session'));
      this.sessionId = string(event.session_id, this.sessionId);
      this.stopReason = string(event.stop_reason, this.stopReason);
      if (event.is_error === true || string(event.subtype).startsWith('error')) {
        this.status = 'failed';
        this.failureText = resultFailureText(event);
      } else this.failureText = '';
      this.finalizeUsage(record(event.usage));
    }
  }

  private backgroundTasks: Array<{ id: string; description: string; startedAt: number }> = [];

  /** Publishes the agents/commands still running; only changes are written. */
  setBackgroundTasks(tasks: Array<{ id: string; description: string; startedAt: number }>): void {
    if (this.terminal || JSON.stringify(tasks) === JSON.stringify(this.backgroundTasks)) return;
    this.backgroundTasks = tasks;
    this.writer.append({ type: 'background_tasks', tasks });
  }

  beginContinuation(): void {
    this.messageUsage.clear();
    this.usageFinalized = false;
  }

  /** Provider text of the latest failed result frame; a later successful result clears it. */
  private failureText = '';

  get failed(): boolean { return this.status === 'failed'; }

  finish(exitCode: number, interrupted = false, error?: string): void {
    if (this.terminal) return;
    this.finalizeUsage();
    this.setBackgroundTasks([]);
    for (const [id, name] of this.tools) this.writer.append({ type: 'tool_call', id, status: 'failed', name, category: toolCategory(name), error: { message: 'Claude run ended before the tool completed' } });
    for (const id of this.interactions) this.writer.append({ type: 'interaction', id, status: 'cancelled' });
    if (exitCode !== 0) this.status = 'failed';
    if (interrupted) this.status = 'interrupted';
    const message = error || (this.status === 'failed' ? this.failureText : '');
    this.writer.finish(this.status, {
      stopReason: interrupted ? 'interrupted' : error ? 'runtime_error' : exitCode === 0 ? this.stopReason : 'process_exit',
      ...(message ? { error: { message } } : {}),
    });
    this.terminal = true;
  }

  start(sessionId: string): void {
    if (!this.started) {
      this.started = true;
      this.sessionId = sessionId;
      this.writer.append({ type: 'session', id: sessionId, status: this.resumed ? 'resumed' : 'started' });
      this.writer.append({ type: 'run', status: 'started', ...(this.requestedModel ? { model: this.requestedModel } : {}) });
    }
  }

  private consumeStreamEvent(wrapper: JsonRecord): void {
    this.start(string(wrapper.session_id, this.sessionId || 'claude-session'));
    const event = record(wrapper.event);
    if (event.type === 'message_start') {
      const message = record(event.message);
      const id = string(message.id);
      if (id) this.activeStreamMessageId = id;
      const model = string(message.model);
      if (model && model !== this.model && model !== this.requestedModel) {
        this.writer.append({ type: 'run', status: 'in_progress', model });
      }
      if (model) this.model = model;
      return;
    }
    if (event.type !== 'content_block_delta' || !this.activeStreamMessageId) return;
    const delta = record(event.delta);
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
      const id = this.activeStreamMessageId;
      this.streamedText.set(id, (this.streamedText.get(id) || '') + delta.text);
      this.writer.append({ type: 'message_delta', id, role: 'assistant', delta: delta.text });
      return;
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
      this.writer.append({ type: 'thought_delta', id: `${this.activeStreamMessageId}:thought`, delta: delta.thinking });
    }
  }

  private finalizeUsage(total?: JsonRecord): void {
    if (this.usageFinalized) return;
    this.usageFinalized = true;
    // Per-message snapshots retain the last request's context size. The result
    // is the authoritative total for this turn and replaces, rather than adds
    // to, those snapshots. modelUsage is session-cumulative and must not be used.
    for (const usage of this.messageUsage.values()) this.usage(usage, 'incremental');
    if (total) {
      for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (number(total[field]) !== undefined) this.previousUsage[field] = Number(this.previousUsage[field] || 0) + Number(total[field]);
      }
      const reasoning = number(record(total.output_tokens_details).thinking_tokens);
      if (reasoning !== undefined) this.previousUsage.output_tokens_details = {
        thinking_tokens: Number(record(this.previousUsage.output_tokens_details).thinking_tokens || 0) + reasoning,
      };
      this.usage(this.previousUsage, 'cumulative', this.cacheTtlSeconds(total));
    }
  }

  /** Lifetime of the prompt cache written by the most recent request that wrote one. */
  private cacheTtlSeconds(total: JsonRecord): number | undefined {
    for (const usage of [...this.messageUsage.values()].reverse().concat(total)) {
      const split = record(record(usage.usage || usage).cache_creation);
      if (number(split.ephemeral_1h_input_tokens)) return 3600;
      if (number(split.ephemeral_5m_input_tokens)) return 300;
    }
    return undefined;
  }

  private usage(value: JsonRecord, scope: 'incremental' | 'cumulative', cacheTtlSeconds?: number): void {
    const usage = record(value.usage || value);
    const inputTokens = number(usage.input_tokens) ?? number(usage.inputTokens);
    const outputTokens = number(usage.output_tokens) ?? number(usage.outputTokens);
    const reasoningOutputTokens = number(record(usage.output_tokens_details).thinking_tokens);
    if (inputTokens === undefined || outputTokens === undefined) return;
    this.writer.append({ type: 'usage', scope, inputTokens, outputTokens, ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }), ...(number(usage.cache_read_input_tokens) === undefined ? {} : { cachedInputTokens: number(usage.cache_read_input_tokens) }), ...(number(usage.cache_creation_input_tokens) === undefined ? {} : { cacheWriteInputTokens: number(usage.cache_creation_input_tokens) }), ...(cacheTtlSeconds === undefined ? {} : { cacheTtlSeconds }) });
  }
}
