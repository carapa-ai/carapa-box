import type { HarnessAdapter } from '../contracts';
import { planAcpHarness, type AcpHarnessContract } from '../acp/contracts';
import { generateOmpAlwaysRule } from '../instructions';
import { runAcpHarness } from '../acp/runner';

function thinkingLevel(context: Parameters<NonNullable<AcpHarnessContract['prepare']>>[0]): string {
  const configured = context.env.OMP_THINKING_LEVEL || context.args.reasoningEffort;
  return configured === 'none' ? 'off' : configured;
}

export const ompAcpContract: AcpHarnessContract = {
  id: 'omp-acp',
  restore: 'resume',
  prepare(context) {
    generateOmpAlwaysRule(context);
    context.env.PI_CODEX_WEBSOCKET ??= '1';
  },
  process(context) {
    const command = ['omp'];
    if (context.args.model) command.push('--model', context.args.model);
    const thinking = thinkingLevel(context);
    if (thinking) command.push('--thinking', thinking);
    if (context.args.systemPrompt) command.push('--system-prompt', context.args.systemPrompt);
    command.push('acp');
    return { command };
  },
  desiredConfiguration(context) {
    return { model: context.args.model, thinking: thinkingLevel(context) };
  },
  configure(
    context,
    sessionId,
    current = { newDaemon: true, model: '', thinking: '' },
  ) {
    const requests = [];
    if (context.args.model && (current.newDaemon || current.model !== context.args.model)) {
      requests.push({
        method: 'session/set_config_option' as const,
        params: { sessionId, configId: 'model', value: context.args.model },
      });
    }
    const thinking = thinkingLevel(context);
    if (thinking && (current.newDaemon || current.thinking !== thinking)) {
      requests.push({
        method: 'session/set_config_option' as const,
        params: { sessionId, configId: 'thinking', value: thinking },
      });
    }
    return requests;
  },
};

export const ompAcpHarness: HarnessAdapter = {
  command: 'omp-acp',
  plan: (context) => planAcpHarness(context, ompAcpContract, runAcpHarness),
};
