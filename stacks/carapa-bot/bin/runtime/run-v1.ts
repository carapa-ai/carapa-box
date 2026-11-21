import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './contracts';
import { atomicWrite } from './files';
import { ToolCallRecovery, TOOL_CALL_CORRECTION_NOTICE } from './tool-call-recovery';

export type RunV1Role = 'user' | 'assistant' | 'system';
export type RunV1TerminalStatus = 'completed' | 'interrupted' | 'failed';
export type RunV1ToolStatus = 'started' | 'in_progress' | 'completed' | 'failed';

export interface CarapaRunManifestV1 {
  format: 'carapa-run';
  version: 1;
  harness: string;
  requestedModel: string | null;
}

export interface RunV1Error {
  message: string;
  code?: string;
  details?: unknown;
}

export type CarapaRunEventV1 =
  | { type: 'session'; id: string; status: 'started' | 'resumed' }
  | {
      type: 'run';
      status: 'started' | 'in_progress' | RunV1TerminalStatus;
      model?: string;
      reasoningEffort?: string;
      mode?: string;
      stopReason?: string;
      error?: RunV1Error;
      metrics?: {
        durationMs?: number;
        timeToFirstOutputMs?: number;
        costUsd?: number;
        contextSize?: number;
      };
    }
  | { type: 'message_delta'; id: string; role: 'assistant' | 'system'; delta: string }
  | {
      type: 'message';
      id: string;
      role: RunV1Role;
      content: string;
      format?: 'markdown' | 'text';
      status: 'completed' | 'interrupted';
    }
  | { type: 'thought_delta'; id: string; delta: string }
  | {
      type: 'thought';
      id: string;
      content: string;
      format?: 'markdown' | 'text';
      status: 'completed' | 'interrupted';
    }
  | {
      type: 'tool_call';
      id: string;
      status: RunV1ToolStatus;
      name?: string;
      category?: 'execute' | 'read' | 'edit' | 'search' | 'mcp' | 'other';
      input?: unknown;
      outputDelta?: unknown;
      output?: unknown;
      exitCode?: number | null;
      error?: RunV1Error;
    }
  | {
      type: 'interaction';
      id: string;
      status: 'requested' | 'answered' | 'cancelled';
      questions?: Array<{
        id: string;
        header: string;
        question: string;
        // preview: optional mockup or snippet shown beside the option list.
        options?: Array<{ label: string; description: string; preview?: string }>;
        allowOther?: boolean;
        secret?: boolean;
        multiSelect?: boolean;
      }>;
      answers?: Record<string, string[]>;
    }
  | {
      type: 'plan';
      id: string;
      entries: Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
      }>;
    }
  | {
      type: 'usage';
      scope: 'incremental' | 'cumulative';
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
      reasoningOutputTokens?: number;
      // Prompt-cache lifetime the provider applied to this turn's cache writes.
      cacheTtlSeconds?: number;
    }
  | {
      // Snapshot of agents/commands still running after the turn; empty when none.
      type: 'background_tasks';
      tasks: Array<{ id: string; description: string; startedAt: number }>;
    }
  | {
      type: 'error';
      message: string;
      fatal: boolean;
      code?: string;
      details?: unknown;
    };

export class RunV1Writer {
  readonly eventPath: string;
  readonly manifestPath: string;
  private terminal = false;
  readonly toolCallRecovery = new ToolCallRecovery();

  constructor(private readonly runDir: string, manifest: CarapaRunManifestV1) {
    this.eventPath = join(runDir, 'output.v1.jsonl');
    this.manifestPath = join(runDir, 'output.v1.meta.json');
    atomicWrite(this.manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(this.eventPath, '');
  }

  append(event: CarapaRunEventV1): void {
    if (this.terminal) throw new Error('cannot append after terminal V1 run event');
    if (event.type === 'run' && ['completed', 'interrupted', 'failed'].includes(event.status) &&
        existsSync(join(this.runDir, 'turn_interrupt'))) {
      event = { ...event, status: 'interrupted', stopReason: 'interrupted' };
    }
    this.toolCallRecovery.consume(event);
    appendFileSync(this.eventPath, `${JSON.stringify(event)}\n`);
    if (
      event.type === 'run' &&
      ['completed', 'interrupted', 'failed'].includes(event.status)
    ) {
      this.terminal = true;
    }
  }

  correctToolCall(): string {
    const prompt = this.toolCallRecovery.next();
    this.append({ type: 'message', id: 'tool-protocol-correction', role: 'system',
      content: TOOL_CALL_CORRECTION_NOTICE, format: 'text', status: 'completed' });
    return prompt;
  }

  finish(
    status: RunV1TerminalStatus,
    options: { stopReason?: string; error?: RunV1Error } = {},
  ): void {
    if (this.terminal) return;
    this.append({
      type: 'run',
      status,
      ...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
      ...(options.error === undefined ? {} : { error: options.error }),
    });
  }
}

export function createRunV1Writer(context: RunContext, harness: string): RunV1Writer {
  return new RunV1Writer(context.runDir, {
    format: 'carapa-run',
    version: 1,
    harness,
    requestedModel: context.args.model.trim() || null,
  });
}

/** Startup/transport failures must complete the same contract as normal provider turns. */
export function ensureRunTerminal(context: RunContext, exitCode: number, error?: unknown): void {
  const eventPath = join(context.runDir, 'output.v1.jsonl');
  const events: Array<Record<string, unknown>> = existsSync(eventPath)
    ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  if (events.some(event => event.type === 'run' && ['completed', 'interrupted', 'failed'].includes(String(event.status)))) return;
  if (!existsSync(join(context.runDir, 'output.v1.meta.json'))) {
    atomicWrite(join(context.runDir, 'output.v1.meta.json'), JSON.stringify({
      format: 'carapa-run', version: 1, harness: context.args.agentCmd, requestedModel: context.args.model || null,
    } satisfies CarapaRunManifestV1));
  }
  if (!events.some(event => event.type === 'run' && event.status === 'started')) {
    appendFileSync(eventPath, `${JSON.stringify({ type: 'run', status: 'started' })}\n`);
  }
  const interrupted = existsSync(join(context.runDir, 'turn_interrupt'));
  const message = error instanceof Error ? error.message : error ? String(error) : 'Harness ended without a terminal event';
  const terminal: CarapaRunEventV1 = {
    type: 'run', status: interrupted ? 'interrupted' : 'failed',
    stopReason: interrupted ? 'interrupted' : 'runtime_error',
    ...(interrupted ? {} : { error: { message, details: { exitCode } } }),
  };
  appendFileSync(eventPath, `${JSON.stringify(terminal)}\n`);
}
