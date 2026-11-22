import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract } from '../acp/contracts';
import { preparePrimeRelay } from '../acp/preparations';
import { runAcpHarness } from '../acp/runner';

const primeThinking = (context: RunContext): string =>
  context.args.reasoningEffort === 'none' ? 'off' : context.args.reasoningEffort;

export const primeAgentAcpContract: AcpHarnessContract = {
  id: 'prime-agent-acp',
  restore: 'process-argument',
  prepare: preparePrimeRelay,
  // Model and thinking are launch flags only; a warm process keeps the old ones.
  launchIdentity: (context) => JSON.stringify([context.args.model, primeThinking(context)]),
  process(context, resumeSessionId) {
    const command = ['prime-agent', '--mode', 'acp', '--cwd', context.cwd];
    if (resumeSessionId) command.push('--resume', resumeSessionId);
    if (context.args.model) {
      const slash = context.args.model.indexOf('/');
      if (slash > 0) {
        command.push(
          '--provider',
          context.args.model.slice(0, slash),
          '--model',
          context.args.model.slice(slash + 1),
        );
      } else {
        command.push('--model', context.args.model);
      }
    }
    const thinking = primeThinking(context);
    if (thinking) command.push('--thinking', thinking);
    return { command };
  },
};

export const primeAgentAcpHarness: HarnessAdapter = {
  command: 'prime-agent-acp',
  plan: (context) => planAcpHarness(context, primeAgentAcpContract, runAcpHarness),
};
