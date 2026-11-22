import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract, type AcpRequest } from '../acp/contracts';
import { runAcpHarness } from '../acp/runner';
import { atomicWrite } from '../files';
import { hostEnvValue } from '../roots';
import { StandardAcpRunV1Adapter } from '../standard-acp-v1';

// Grok Build's own OAuth client; auth.json is keyed by "<issuer>::<client_id>".
const XAI_SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';

// Grok uploads per-turn traces (prompts, tool definitions, git metadata) to
// cloud storage when telemetry is on, and keeps cross-session memory and
// workspace snapshots. Board owns memory; nothing leaves except model calls.
export const GROK_PRIVATE_ENV = {
  GROK_TELEMETRY_ENABLED: '0',
  GROK_TELEMETRY_TRACE_UPLOAD: '0',
  GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
  GROK_FEEDBACK_ENABLED: '0',
  GROK_MEMORY: '0',
  GROK_DISABLE_AUTOUPDATER: '1',
  // Claude MCP compat imports the workspace's Claude MCP entries, which win over
  // same-named session servers and do not connect here: Board tools vanish.
  GROK_CLAUDE_MCPS_ENABLED: '0',
};

/** A session login without a refresh token, so Grok never renews it itself.
 * Subscription traffic goes to the CLI chat proxy, which is the relay's `xai`
 * route; the relay swaps the placeholder for the managed xAI account. */
export function writeGrokRelayLogin(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'auth.json');
  atomicWrite(file, JSON.stringify({ [XAI_SCOPE]: {
    key: 'carapa-relay', auth_mode: 'oidc', create_time: '2026-01-01T00:00:00Z', user_id: 'carapa-relay',
    email: 'relay@carapa.invalid', expires_at: '2099-01-01T00:00:00Z', coding_data_retention_opt_out: true,
    oidc_issuer: 'https://auth.x.ai', oidc_client_id: XAI_SCOPE.split('::')[1],
  } }));
  chmodSync(file, 0o600);
  atomicWrite(join(home, 'config.toml'), '[harness]\ndisable_workspace_teleport = true\n');
}

/** Grok reports turn usage in PromptResponse._meta.usage, not ACP's `usage`. */
class GrokRunV1Adapter extends StandardAcpRunV1Adapter {
  override result(result: Record<string, unknown>): void {
    const meta = result._meta as { usage?: Record<string, unknown> } | undefined;
    const usage = result.usage ?? (meta?.usage && { ...meta.usage, thoughtTokens: meta.usage.reasoningTokens });
    super.result({ ...result, usage } as Parameters<StandardAcpRunV1Adapter['result']>[0]);
  }
}

export const grokRelayUrl = (env: NodeJS.ProcessEnv): string => hostEnvValue('http://api-relay:8080/xai/v1', env);

const setOption = (sessionId: string, configId: string, value: string): AcpRequest => ({
  method: 'session/set_config_option',
  params: { sessionId, configId, value },
});

export const grokAcpContract: AcpHarnessContract = {
  id: 'grok-acp',
  restore: 'load',
  restoreFailure: 'new-session',
  prepare(context: RunContext) {
    // An API key would send traffic to api.x.ai at API prices, bypassing the relay.
    delete context.env.XAI_API_KEY;
    // One home per conversation: it holds the sessions that session/load restores.
    const home = join(dirname(dirname(context.runDir)), 'grok-home',
      (context.args.conversationKey || context.runTag).replace(/[^A-Za-z0-9_.-]/g, '_'));
    writeGrokRelayLogin(home);
    context.env.GROK_HOME = home;
    // ACP has no separate system-prompt field; carry instructions as leading prompt text.
    if (context.args.systemPrompt) context.prompt = `${context.args.systemPrompt}\n\nUser request:\n${context.prompt}`;
  },
  process(context) {
    return {
      command: ['grok', 'agent', '--always-approve', 'stdio'],
      env: { ...GROK_PRIVATE_ENV, GROK_CLI_CHAT_PROXY_BASE_URL: grokRelayUrl(context.env) },
    };
  },
  desiredConfiguration(context) {
    return { model: context.args.model, thinking: context.args.reasoningEffort };
  },
  configure(context, sessionId, current = { newDaemon: true, model: '', thinking: '' }) {
    // Mode is cheap and must follow every turn: a reused session may still be in Plan.
    const requests: AcpRequest[] = [{ method: 'session/set_mode',
      params: { sessionId, modeId: context.args.chatMode === 'plan' ? 'plan' : 'default' } }];
    const { model, reasoningEffort } = context.args;
    if (model && (current.newDaemon || current.model !== model)) requests.push(setOption(sessionId, 'model', model));
    if (reasoningEffort && (current.newDaemon || current.thinking !== reasoningEffort)) {
      requests.push(setOption(sessionId, 'reasoning_effort', reasoningEffort));
    }
    return requests;
  },
  createV1: (context, writer, resumed) => new GrokRunV1Adapter(writer, context.args.model, resumed, `grok-acp-${context.runTag}-message-1`),
};

export const grokAcpHarness: HarnessAdapter = {
  command: 'grok-acp',
  plan: (context) => planAcpHarness(context, grokAcpContract, runAcpHarness),
};
