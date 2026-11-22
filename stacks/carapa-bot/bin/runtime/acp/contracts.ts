import type { HarnessPlan, RunContext } from '../contracts';
import type { RunV1Writer } from '../run-v1';
import type { AcpRequest } from '../protocol/acp';

export type AcpRestoreStrategy = 'load' | 'resume' | 'process-argument';

export interface AcpProcessSpec {
  command: string[];
  env?: Record<string, string>;
}

export type { AcpRequest } from '../protocol/acp';

export interface AcpSessionConfiguration {
  readonly newDaemon: boolean;
  readonly model: string;
  readonly thinking: string;
  /** The model a brand-new session started on, recorded when the session was created; '' if unknown. */
  readonly defaultModel?: string;
}

export interface AcpDesiredConfiguration {
  readonly model?: string;
  readonly thinking?: string;
}

/** What an agent is still doing after a prompt returned, read from outside ACP. */
export interface AcpBackgroundState {
  /** Sub-agents still working. */
  tasks: Array<{ id: string; description: string; startedAt: number }>;
  /** A sub-agent, or a turn of the main agent that one of them started, is in progress. */
  busy: boolean;
  /** `session/update` messages for what the main agent did since the prompt returned. */
  updates: Array<Record<string, unknown>>;
  /** Tokens not reported by any prompt, shaped like ACP PromptResponse.usage. */
  usage?: Record<string, unknown>;
}

export interface AcpBackground {
  /** `promptReturned`: a prompt just ended, so the main agent's steps so far were already reported. */
  poll(promptReturned: boolean): AcpBackgroundState;
  /** True for a prompt's message that repeats one `poll` already returned; the runner drops it. */
  replayed(message: Record<string, unknown>): boolean;
}

export interface AcpHarnessContract {
  readonly id: 'antigravity-acp' | 'cursor-acp' | 'grok-acp' | 'hermes-acp' | 'muse-acp' | 'omp-acp' | 'prime-agent-acp' | 'vibe-acp';
  readonly restore: AcpRestoreStrategy;
  readonly restoreFailure?: 'fail' | 'new-session';
  /** The agent takes a second `session/prompt` while one is running: it ends the first
   * at once and delivers the new text between steps of the same work. */
  readonly steerMidTurn?: boolean;
  /** True when a failed turn left the agent process unable to take another
   * prompt; the runner then stops it so the next run starts a fresh process. */
  retireDaemonAfter?(failure: string): boolean;
  /** For a failure `retireDaemonAfter` accepted: the correction prompt. The runner then
   * restarts the agent, reloads the session and sends this once in the same run. */
  recoveryPrompt?(failure: string): string;
  /** The original request as a session that replaced an unloadable one takes it again, ahead of the
   * correction; null when that session cannot repeat it, and the run then fails with the crash. */
  freshSessionRequest?(prompt: string): string | null;
  sessionIdentity?(context: RunContext): string;
  sessionIdentityPath?(context: RunContext, sessionId: string): string;
  reply?(message: Record<string, unknown>): Record<string, unknown> | null;
  createV1?(context: RunContext, writer: RunV1Writer, resumed: boolean): {
    start(sessionId: string): void;
    consume(message: Record<string, unknown>): void;
    /** A message the agent sent before this run's prompt, oldest first: counters it reports then are
     * history of a restored or warm session, not this run's spend. */
    restored?(message: Record<string, unknown>): void;
    /** The session/prompt result, before finish. */
    result?(result: Record<string, unknown>): void;
    /** The agent crashed and the run goes on with a retry: settle what the attempt streamed, without ending the run. */
    abandonAttempt?(): void;
    /** A new session replaced the crashed one for the retry, so nothing of the crashed attempt was restored. */
    retryInNewSession?(): void;
    finish(exitCode: number, failure?: string): void;
  };
  /** For agents that keep working after a prompt returns without reporting it over ACP.
   * The runner then keeps the run open, and takes follow-up messages, until they finish. */
  background?(context: RunContext, sessionId: string, sessionDir: string): AcpBackground;
  prepare?(context: RunContext): void;
  /** Board MCP servers to attach to a session; defaults to all of them. */
  sessionMcpServers?<T extends { name: string }>(context: RunContext, servers: T[]): T[];
  process(context: RunContext, resumeSessionId?: string): AcpProcessSpec;
  /** Settings that `process` fixes at launch and the agent cannot change later.
   * The runner replaces a warm process whose recorded value differs from this turn's. */
  launchIdentity?(context: RunContext): string;
  afterInitialize?(context: RunContext): AcpRequest[];
  desiredConfiguration?(context: RunContext): AcpDesiredConfiguration;
  configure?(
    context: RunContext,
    sessionId: string,
    current?: AcpSessionConfiguration,
  ): AcpRequest[];
}

export type ManagedAcpRunner = (
  context: RunContext,
  contract: AcpHarnessContract,
) => Promise<number>;

export function planAcpHarness(
  context: RunContext,
  contract: AcpHarnessContract,
  managedRunner: ManagedAcpRunner,
): HarnessPlan {
  contract.prepare?.(context);
  return {
    kind: 'managed',
    execute: (runContext) => managedRunner(runContext, contract),
  };
}
