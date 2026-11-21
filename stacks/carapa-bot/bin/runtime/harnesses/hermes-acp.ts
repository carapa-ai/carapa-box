import { hostEnvValue, relayBaseUrl } from '../roots';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessAdapter } from '../contracts';
import { planAcpHarness, type AcpHarnessContract } from '../acp/contracts';
import { prepareHermesProviderState } from '../acp/preparations';
import { runAcpHarness } from '../acp/runner';

const codexProvider = 'carapa-codex';
const codexRelayBaseUrl = `${relayBaseUrl()}/codex`;

const safeSessionKey = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '_');

function isCodexRelay(context: Parameters<NonNullable<AcpHarnessContract['prepare']>>[0]): boolean {
  return context.env.HERMES_INFERENCE_PROVIDER === codexProvider;
}

function hermesModel(context: Parameters<AcpHarnessContract['process']>[0]): string {
  return isCodexRelay(context)
    ? context.args.model.replace(/^carapa-codex\//, '')
    : context.args.model;
}

function linkSharedHermesAsset(sourceHome: string, targetHome: string, name: string): void {
  const source = join(sourceHome, name);
  const target = join(targetHome, name);
  if (!existsSync(source) || existsSync(target)) return;
  symlinkSync(source, target, statSync(source).isDirectory() ? 'dir' : 'file');
}

function prepareHermesCodexRelay(context: Parameters<NonNullable<AcpHarnessContract['prepare']>>[0]): void {
  const model = hermesModel(context);
  if (!model) throw new Error('hermes-acp: Codex relay requires a model');
  const sourceHome = context.env.HERMES_HOME || join(context.env.HOME || '/home/ubuntu', '.hermes');
  const persistent = context.args.persistent === '1' && !!context.args.conversationKey;
  const hermesHome = persistent
    ? join(
        dirname(dirname(context.runDir)),
        'sessions',
        safeSessionKey(context.args.conversationKey),
        'hermes-home',
      )
    : join(context.runDir, 'hermes-home');
  mkdirSync(hermesHome, { recursive: true });
  for (const name of ['.env', 'SOUL.md', 'auth.json', 'hooks', 'memories', 'plugins', 'skills']) {
    linkSharedHermesAsset(sourceHome, hermesHome, name);
  }
  writeFileSync(
    join(hermesHome, 'config.yaml'),
    [
      'model:',
      `  default: ${JSON.stringify(model)}`,
      `  provider: ${JSON.stringify(codexProvider)}`,
      `  base_url: ${JSON.stringify(codexRelayBaseUrl)}`,
      '  api_mode: codex_responses',
      'providers:',
      `  ${codexProvider}:`,
      '    name: Carapa Codex relay',
      `    base_url: ${JSON.stringify(codexRelayBaseUrl)}`,
      '    key_env: OPENAI_API_KEY',
      '    transport: codex_responses',
      `    default_model: ${JSON.stringify(model)}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  context.env.HERMES_HOME = hermesHome;
}

export const hermesAcpContract: AcpHarnessContract = {
  id: 'hermes-acp',
  restore: 'load',
  restoreFailure: 'new-session',
  reportModel: true,
  prepare(context) {
    if (isCodexRelay(context)) prepareHermesCodexRelay(context);
    else prepareHermesProviderState(context);
  },
  process(context) {
    const provider = isCodexRelay(context) ? codexProvider : 'openai-api';
    const model = hermesModel(context);
    return {
      command: ['hermes-acp'],
      env: {
        HERMES_INFERENCE_PROVIDER: provider,
        OPENAI_BASE_URL: context.env.OPENAI_BASE_URL || hostEnvValue('http://llama-proxy:8881/v1', context.env),
        OPENAI_API_KEY: context.env.OPENAI_API_KEY || 'llama-proxy-no-auth',
        ...(model ? { HERMES_INFERENCE_MODEL: model } : {}),
      },
    };
  },
  // Hermes guesses a provider for a bare model name (gpt-6-* became OpenRouter, gpt-5.6-* openai-api),
  // so the relay's named provider is selected explicitly.
  configure(context, sessionId) {
    const provider = isCodexRelay(context) ? codexProvider : 'openai-api';
    const model = hermesModel(context);
    return model
      ? [{
          method: 'session/set_model',
          params: { sessionId, modelId: isCodexRelay(context) ? `custom:${provider}:${model}` : `${provider}:${model}` },
        }]
      : [];
  },
};

export const hermesAcpHarness: HarnessAdapter = {
  command: 'hermes-acp',
  plan: (context) => planAcpHarness(context, hermesAcpContract, runAcpHarness),
};
