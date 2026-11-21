import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { CodexRpcClient } from './client';
import type { JsonRecord, RpcId } from './types';
import { errorMessage, record, string } from './types';

export interface ControlState {
  threadId: string;
  turnId: string;
  completed: boolean;
}

export class ControlRequestPoller {
  private timer?: ReturnType<typeof setInterval>;
  private handling?: Promise<void>;
  interrupted = false;

  constructor(
    private readonly requestsDir: string,
    private readonly responsesDir: string,
    private readonly client: CodexRpcClient,
    private readonly pendingUserInput: Map<string, RpcId>,
    private readonly state: () => ControlState,
    private readonly stderr: WriteStream,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.handle().catch((error) => this.stderr.write(`control: ${error}\n`));
    }, 100);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  handle(): Promise<void> {
    return this.handling ??= this.handlePending().finally(() => { this.handling = undefined; });
  }

  private async handlePending(): Promise<void> {
    const state = this.state();
    if (!state.turnId) return;
    const names = readdirSync(this.requestsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of names) await this.handleOne(name, state);
  }

  private async handleOne(name: string, state: ControlState): Promise<void> {
    const requestPath = join(this.requestsDir, name);
    const responsePath = join(this.responsesDir, name);
    let handled = false;
    try {
      const request = record(JSON.parse(readFileSync(requestPath, 'utf8')));
      // Interrupts also cancel an automatic correction between provider turns.
      // Leave steering/input requests queued until a turn can receive them.
      if (state.completed && request.action !== 'interrupt') return;
      handled = true;
      const result = await this.dispatch(request, state);
      writeFileSync(responsePath, JSON.stringify({ ok: true, result }));
    } catch (error) {
      handled = true;
      writeFileSync(responsePath, JSON.stringify({ ok: false, error: errorMessage(error) }));
    } finally {
      if (handled) unlinkSync(requestPath);
    }
  }

  private async dispatch(request: JsonRecord, state: ControlState): Promise<JsonRecord> {
    if (request.action === 'steer') {
      return this.client.send('turn/steer', {
        threadId: state.threadId,
        expectedTurnId: state.turnId,
        clientUserMessageId: request.clientMessageId || request.id,
        input: [{ type: 'text', text: string(request.text) }],
      });
    }
    if (request.action === 'interrupt') {
      this.interrupted = true;
      if (state.completed) return {};
      return this.client.send('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.turnId,
      });
    }
    if (request.action === 'answerUserInput') {
      const requestId = string(request.requestId);
      const wireId = this.pendingUserInput.get(requestId);
      if (wireId === undefined) throw new Error('Codex user-input request is no longer pending');
      this.client.respond(wireId, { answers: record(request.answers) });
      this.pendingUserInput.delete(requestId);
      return {};
    }
    throw new Error(`unknown control action: ${String(request.action)}`);
  }
}
