import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract } from '../acp/contracts';
import { runAcpHarness } from '../acp/runner';
import { StandardAcpRunV1Adapter } from '../standard-acp-v1';
import { atomicWrite } from '../files';
import { object } from '../protocol/rpc';
import { antigravitySessionIdentity, antigravityIdentityPath } from './antigravity-profile';
import { clearGoogleCredentials, configureAntigravityRelay } from './antigravity-auth';
import { AntigravityBackground } from './antigravity-background';

function authMethod(context: RunContext): string {
  return context.env.ANTIGRAVITY_ACP_AUTH_METHOD || 'gemini-api-key';
}

function profileDirectory(context: RunContext): string {
  if (context.env.ANTIGRAVITY_ACP_HOME) return resolve(context.env.ANTIGRAVITY_ACP_HOME);
  return join(dirname(dirname(context.runDir)), 'antigravity-home');
}

/** Questions share the permission envelope; never mistake a choice for an approval. */
export function antigravityReply(message: Record<string, unknown>): Record<string, unknown> | null {
  if (message.method !== 'session/request_permission' || message.id == null) return null;
  const params = object(message.params);
  const tool = object(params.toolCall);
  if (String(tool.toolCallId).startsWith('interaction_')) {
    throw new Error('antigravity-acp: a user choice is required; interactive questions are not supported yet');
  }
  const options = Array.isArray(params.options) ? params.options.map(object) : [];
  const selected = options.find(option => option.kind === 'allow_once');
  if (!selected || typeof selected.optionId !== 'string' || !selected.optionId) {
    throw new Error('antigravity-acp: no allow-once permission option; refusing an implicit persistent grant');
  }
  return { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: selected.optionId } } };
}

const setModel = (sessionId: string, value: string) =>
  ({ method: 'session/set_config_option' as const, params: { sessionId, configId: 'model', value } });

export const antigravityAcpContract: AcpHarnessContract = {
  id: 'antigravity-acp',
  restore: 'resume',
  restoreFailure: 'fail',
  steerMidTurn: true,
  prepare(context) {
    const method = authMethod(context);
    if (!['gemini-api-key', 'oauth-personal'].includes(method)) {
      throw new Error('antigravity-acp: supported auth methods are gemini-api-key and oauth-personal');
    }
    if (context.args.chatMode === 'plan') throw new Error('antigravity-acp: use the native /plan command, not Board Plan mode');
    // ACP has no separate system-prompt field; carry instructions as leading prompt text.
    if (context.args.systemPrompt) context.prompt = `${context.args.systemPrompt}\n\nUser request:\n${context.prompt}`;
    // No accidental credential crossover from another Google harness.
    clearGoogleCredentials(context.env);
    for (const name of Object.keys(context.env)) {
      if (/^(AGY_ACP_.*|GEMINI_HOME|ANTIGRAVITY_HARNESS_PATH)$/i.test(name)) delete context.env[name];
    }
    if (method === 'gemini-api-key') configureAntigravityRelay(context.env);
    else delete context.env.GOOGLE_GEMINI_BASE_URL;
    const profile = profileDirectory(context);
    if (method === 'oauth-personal' && (!context.env.ANTIGRAVITY_ACP_HOME || !existsSync(join(profile, 'antigravity-cli')))) {
      throw new Error('antigravity-acp: OAuth requires an explicitly selected, pre-authenticated ANTIGRAVITY_ACP_HOME; browser setup is not implemented');
    }
    // The CLI ignores GEMINI_HOME; it is this adapter's profile path, passed as --gemini-dir.
    context.env.GEMINI_HOME = profile;
    context.env.BROWSER = '/bin/false';
  },
  process(context) {
    const binary = context.env.ANTIGRAVITY_ACP_BIN || '/opt/carapa-harness/antigravity-acp/antigravity';
    if (!existsSync(binary)) throw new Error('antigravity-acp: install the Antigravity CLI executable');
    const config = join(context.env.GEMINI_HOME!, 'antigravity-cli');
    mkdirSync(config, { recursive: true, mode: 0o700 });
    // Do not overwrite externally managed OAuth profile settings. Without
    // modelProvider the CLI ignores the relay URL and calls Google directly.
    if (authMethod(context) === 'gemini-api-key') {
      atomicWrite(join(config, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }));
      chmodSync(join(config, 'settings.json'), 0o600);
    }
    // The CLI has no yolo mode; skipping permissions keeps the previous unattended behavior.
    return { command: [binary, 'acp', '--gemini-dir', context.env.GEMINI_HOME!, '--disable-telemetry', '--dangerously-skip-permissions'] };
  },
  afterInitialize(context) {
    return [{ method: 'authenticate', params: { methodId: authMethod(context) } }];
  },
  desiredConfiguration(context) {
    return { model: context.args.model };
  },
  configure(context, sessionId, current) {
    const { model } = context.args;
    // Full picker names (gemini-4-hydrogen-xhigh) also set the thinking level.
    if (model && model !== 'auto') return [setModel(sessionId, model)];
    // The CLI keeps an explicitly chosen model for the session; 'auto' must put back the one it started on.
    const configured = current?.model;
    return configured && configured !== 'auto' && current.defaultModel ? [setModel(sessionId, current.defaultModel)] : [];
  },
  sessionIdentity: antigravitySessionIdentity,
  sessionIdentityPath: antigravityIdentityPath,
  reply: antigravityReply,
  background: (context, sessionId, sessionDir) => new AntigravityBackground(
    context.env.GEMINI_HOME!, sessionId, sessionDir,
    Math.max(0.1, Number(context.env.CARAPA_BACKGROUND_IDLE_LIMIT_SECONDS || 1_800)) * 1_000,
  ),
  createV1: (context, writer, resumed) => new StandardAcpRunV1Adapter(writer, context.args.model, resumed, `antigravity-acp-${context.runTag}-message-1`),
};

export const antigravityAcpHarness: HarnessAdapter = {
  command: 'antigravity-acp',
  plan: context => planAcpHarness(context, antigravityAcpContract, runAcpHarness),
};
