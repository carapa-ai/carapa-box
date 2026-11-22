import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { RunContext } from './contracts';
import { createRunV1Writer, RunV1Writer } from './run-v1';
import { configureAntigravityRelay } from './harnesses/antigravity-auth';

type SdkEvent = Record<string, unknown>;

export class AgySdkRunV1Adapter {
  private started = false;
  private terminal = false;
  private text = '';
  private toolCount = 0;
  /** Open tool calls in start order: Board id -> tool name. */
  private readonly tools = new Map<string, string>();
  private thoughtId: string;
  private resultStatus = '';
  private resultFailed = false;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    private readonly writer: RunV1Writer,
    private readonly requestedModel: string,
    private readonly resumed: boolean,
    private messageId = 'agy-sdk-message-1',
  ) {
    this.thoughtId = `${messageId}-thought-1`;
  }

  private ensureStarted(sessionId: string): void {
    if (this.started) return;
    this.started = true;
    this.writer.append({ type: 'session', id: sessionId || 'agy-sdk-session', status: this.resumed ? 'resumed' : 'started' });
    this.writer.append({ type: 'run', status: 'started', ...(this.requestedModel ? { model: this.requestedModel } : {}) });
  }

  consume(event: SdkEvent): void {
    if (this.terminal) return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'init') {
      this.ensureStarted(typeof event.session_id === 'string' ? event.session_id : 'agy-sdk-session');
      return;
    }
    this.ensureStarted(typeof event.session_id === 'string' ? event.session_id : 'agy-sdk-session');
    if (type === 'text') {
      const part = event.part as Record<string, unknown> | undefined;
      const delta = part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      if (delta) {
        this.text += delta;
        this.writer.append({ type: 'message_delta', id: this.messageId, role: 'assistant', delta });
      }
      return;
    }
    if (type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'reasoning' && typeof item.text === 'string' && item.text) {
        this.writer.append({ type: 'thought', id: this.thoughtId, content: item.text, format: 'text', status: 'completed' });
      }
      return;
    }
    if (type === 'tool_use') {
      const id = `agy-sdk-tool-${++this.toolCount}`;
      const name = typeof event.tool_name === 'string' ? event.tool_name : 'tool';
      this.tools.set(id, name);
      this.writer.append({ type: 'tool_call', id, status: 'started', name, category: 'other', input: event.parameters ?? {} });
      return;
    }
    if (type === 'tool_result') {
      // The SDK's result id does not match its call id; take the oldest open call of that tool.
      const id = [...this.tools].find(([, name]) => name === event.tool_name)?.[0];
      if (!id) return;
      this.tools.delete(id);
      const error = typeof event.error === 'string' ? event.error : '';
      this.writer.append(error
        ? { type: 'tool_call', id, status: 'failed', error: { message: error } }
        : { type: 'tool_call', id, status: 'completed', output: event.output ?? '' });
      return;
    }
    if (type === 'result') {
      const result = typeof event.result === 'string' ? event.result : '';
      if (!this.text && result) {
        this.text = result;
        this.writer.append({ type: 'message_delta', id: this.messageId, role: 'assistant', delta: result });
      }
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens = Number(usage.input_tokens) || 0;
        const outputTokens = Number(usage.output_tokens) || 0;
        this.inputTokens += inputTokens;
        this.outputTokens += outputTokens;
        if (inputTokens || outputTokens) this.writer.append({ type: 'usage', scope: 'cumulative', inputTokens: this.inputTokens, outputTokens: this.outputTokens });
      }
      const failed = event.is_error === true;
      if (failed && result) this.writer.append({ type: 'error', message: result, fatal: false });
      this.resultFailed = failed;
      this.resultStatus = typeof event.stop_reason === 'string' ? event.stop_reason : 'end_turn';
    }
  }

  canContinue(): boolean { return !this.resultFailed && this.resultStatus === 'end_turn'; }

  beginContinuation(): void {
    this.flushMessage(0);
    this.text = '';
    this.messageId += '-correction';
    this.thoughtId = `${this.messageId}-thought-1`;
    this.resultStatus = '';
  }

  private flushMessage(exitCode: number): void {
    for (const id of this.tools.keys()) this.writer.append({ type: 'tool_call', id, status: 'failed', error: { message: 'No tool result was reported by agy-sdk' } });
    this.tools.clear();
    if (this.text) this.writer.append({ type: 'message', id: this.messageId, role: 'assistant', content: this.text, format: 'markdown', status: exitCode === 0 ? 'completed' : 'interrupted' });
  }

  finish(exitCode: number, stopReason = exitCode === 0 ? 'end_turn' : 'process_exit', failure = ''): void {
    if (this.terminal) return;
    this.ensureStarted('agy-sdk-session');
    this.flushMessage(exitCode);
    const interrupted = this.resultStatus === 'interrupted';
    this.writer.finish(interrupted ? 'interrupted' : exitCode === 0 && !this.resultFailed ? 'completed' : 'failed', {
      stopReason: this.resultStatus || stopReason, ...(failure ? { error: { message: failure } } : {}) });
    this.terminal = true;
  }
}

export async function runAgySdkNative(context: RunContext, command: string[]): Promise<number> {
  configureAntigravityRelay(context.env);
  const rawPath = `${context.runDir}/agy-sdk.raw.jsonl`;
  const writer = createRunV1Writer(context, 'agy-sdk');
  const adapter = new AgySdkRunV1Adapter(writer, context.args.model.trim(), Boolean(context.args.sessionId), `agy-sdk-${context.runTag}-message-1`);
  let buffer = '';
  const child = spawn(command[0], command.slice(1), { cwd: context.cwd, env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  let failure = '';
  let sawResult = false;
  const consume = (event: SdkEvent): void => {
    adapter.consume(event);
    if (event.type !== 'result') return;
    sawResult = true;
    if (adapter.canContinue() && writer.toolCallRecovery.needed() && !existsSync(`${context.runDir}/turn_interrupt`)) {
      try {
        const correction = writer.correctToolCall();
        adapter.beginContinuation();
        sawResult = false;
        child.stdin.write(`${JSON.stringify({ prompt: correction })}\n`);
        return;
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    }
    child.stdin.end();
  };
  child.stdin.on('error', (error) => { failure ||= error.message; });
  child.stdin.write(`${JSON.stringify({ prompt: context.prompt })}\n`);
  const consumeChunk = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      appendFileSync(rawPath, `${line}\n`);
      try { consume(JSON.parse(line) as SdkEvent); } catch (error) { failure = String(error); child.stdin.end(); }
    }
  };
  child.stdout.on('data', consumeChunk);
  let exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (buffer.trim()) {
    appendFileSync(rawPath, buffer);
    try { consume(JSON.parse(buffer) as SdkEvent); } catch (error) { failure = String(error); }
  }
  if (failure || !sawResult || !adapter.canContinue()) exitCode = 1;
  adapter.finish(exitCode, exitCode === 0 ? 'end_turn' : 'process_exit', failure || stderr.trim() || (!sawResult ? 'SDK process exited without a result' : ''));
  return exitCode;
}
