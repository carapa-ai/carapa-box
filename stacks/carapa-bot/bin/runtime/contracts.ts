import { hostEnvValue, hostPath, hostPathsInText } from './roots';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { discardedSessionIds, discardMarker, readText, safeSessionKey } from './sessions';

export type PromptMode = 'argument' | 'stdin' | 'none';

export interface AgentArgs {
  agentCmd: string;
  sessionId: string;
  forkSession: string;
  model: string;
  fallbackModel: string;
  reasoningEffort: string;
  fallbackReasoningEffort: string;
  chatMode: string;
  /** Claude prompt-cache lifetime the conversation chose ('1h'), or ''. */
  promptCacheTtl?: string;
  agent: string;
  bare: string;
  systemPrompt: string;
  workDir: string;
  conversationKey: string;
  persistent: string;
  conversationId: string;
  env: Record<string, string>;
  [key: string]: unknown;
}

export interface RunContext {
  runDir: string;
  args: AgentArgs;
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  runTag: string;
  binDir: string;
}

export interface NativeHarnessPlan {
  kind: 'native';
  command: string[];
  promptMode: PromptMode;
  /** CLI supports history resume, but has no persistent stdio session adapter. */
  persistentResume?: boolean;
  sidecars?: NativeSidecarPlan[];
  afterExit?(context: RunContext, exitCode: number): Promise<void> | void;
}

export interface NativeSidecarPlan {
  command: string[];
  ready?: { host: string; port: number; timeoutMs: number };
}

export interface ManagedHarnessPlan {
  kind: 'managed';
  execute(context: RunContext): Promise<number>;
}

export type HarnessPlan = NativeHarnessPlan | ManagedHarnessPlan;

export interface HarnessAdapter {
  readonly command: string;
  plan(context: RunContext): Promise<HarnessPlan> | HarnessPlan;
}

// The legacy `basename | tr -c ... _` pipeline converts basename's terminating
// newline into an underscore before command substitution. Keep that byte-level
// behavior because existing descendants and cleanup tests use the exact tag.
export const runTagForDirectory = (runDir: string): string =>
  `${basename(runDir).replace(/[^A-Za-z0-9_.-]/g, '_')}_`;

const stringField = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

function parseEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new Error(`invalid environment variable name: ${JSON.stringify(key)}`);
    }
    const normalized = typeof item === 'string' ? item : String(item);
    if (normalized.includes('\0')) {
      throw new Error(`environment variable ${key} contains NUL`);
    }
    result[key] = normalized;
  }
  return result;
}

export function loadAgentArgs(runDir: string): AgentArgs {
  const raw = JSON.parse(readFileSync(resolve(runDir, 'args.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  let sessionId = stringField(raw.sessionId);
  const key = stringField(raw.conversationKey);
  if (key && raw.persistent === '1') {
    const marker = discardMarker(runDir, key);
    // The marker rejects only the discarded IDs; a later session for this key resumes normally.
    if (existsSync(marker) && (discardedSessionIds(marker)?.includes(sessionId) ?? true)) sessionId = '';
    sessionId ||= readText(join(dirname(dirname(runDir)), 'sessions', safeSessionKey(key), 'session_id'));
  }
  return {
    ...raw,
    agentCmd: stringField(raw.agentCmd, 'claude'),
    sessionId,
    forkSession: stringField(raw.forkSession),
    model: stringField(raw.model),
    fallbackModel: stringField(raw.fallbackModel),
    reasoningEffort: stringField(raw.reasoningEffort),
    fallbackReasoningEffort: stringField(raw.fallbackReasoningEffort),
    chatMode: stringField(raw.chatMode),
    promptCacheTtl: stringField(raw.promptCacheTtl),
    agent: stringField(raw.agent),
    bare: stringField(raw.bare),
    systemPrompt: stringField(raw.systemPrompt),
    workDir: hostPath(stringField(raw.workDir)),
    ...(typeof raw.groupDir === 'string' ? { groupDir: hostPath(raw.groupDir) } : {}),
    conversationKey: stringField(raw.conversationKey),
    persistent: stringField(raw.persistent),
    conversationId: stringField(raw.conversationId),
    env: Object.fromEntries(Object.entries(parseEnvironment(raw.env)).map(([key, value]) => [key, hostEnvValue(value)])),
  };
}

export function createRunContext(
  runDirInput: string,
  binDir: string,
  resolvedWorkDir?: string,
): RunContext {
  const runDir = resolve(runDirInput);
  const argsPath = resolve(runDir, 'args.json');
  const promptPath = resolve(runDir, 'prompt.txt');
  if (!statSync(argsPath).isFile()) throw new Error(`${argsPath} not found`);
  if (!statSync(promptPath).isFile()) throw new Error(`${promptPath} not found`);
  const args = loadAgentArgs(runDir);
  const cwd = resolvedWorkDir
    ? resolve(resolvedWorkDir)
    : args.workDir
      ? resolve(args.workDir)
      : process.cwd();
  if (!statSync(cwd).isDirectory()) throw new Error(`cannot use workDir: ${cwd}`);
  const runTag = runTagForDirectory(runDir);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...args.env,
    CARAPA_AGENT_RUN_ID: runTag,
  };
  // The child already launches with `cwd`. Repository-shaping Git variables
  // override that directory and make `git -C <other-checkout>` keep operating
  // on the run's original worktree. That breaks recovery and review commands
  // which intentionally inspect both the managed worktree and its main repo.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  if (args.agentCmd === 'codex' && args.model === 'auto' && !env.CODEX_PROFILE) {
    env.CODEX_PROFILE = 'freellmapi';
  }
  if (env.CARAPA_RECORD === '1') {
    env.CARAPA_RECORD_DAEMON_DIR ??= env.PLAYWRIGHT_DAEMON_SESSION_DIR ?? '';
    env.CARAPA_RECORD_SOCKETS_DIR ??= env.PLAYWRIGHT_DAEMON_SOCKETS_DIR ?? '';
    env.CARAPA_RECORD_SESSION ??= env.PLAYWRIGHT_CLI_SESSION ?? '';
  }

  return {
    runDir,
    args,
    prompt: hostPathsInText(readFileSync(promptPath, 'utf8')),
    cwd,
    env,
    runTag,
    binDir,
  };
}

export const modelIsClaude = (model: string): boolean => model.startsWith('claude');
