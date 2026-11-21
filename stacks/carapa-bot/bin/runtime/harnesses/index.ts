import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { antigravityAcpHarness } from './antigravity-acp';
import { agySdkHarness } from './agy-sdk';
import { claudeHarness } from './claude';
import { codexHarness } from './codex';
import { cursorAcpHarness } from './cursor-acp';
import { grokAcpHarness } from './grok-acp';
import { hermesAcpHarness } from './hermes-acp';
import { museAcpHarness } from './muse-acp';
import { ompAcpHarness } from './omp-acp';
import { opencodeHarness } from './opencode';
import { piHarness } from './pi';
import { primeAgentAcpHarness } from './prime-agent-acp';
import { vibeAcpHarness } from './vibe-acp';

const adapters: HarnessAdapter[] = [
  agySdkHarness,
  antigravityAcpHarness,
  claudeHarness,
  codexHarness,
  cursorAcpHarness,
  grokAcpHarness,
  hermesAcpHarness,
  museAcpHarness,
  ompAcpHarness,
  opencodeHarness,
  piHarness,
  primeAgentAcpHarness,
  vibeAcpHarness,
];

const byCommand = new Map(adapters.map((adapter) => [adapter.command, adapter]));

export async function planHarness(context: RunContext): Promise<HarnessPlan> {
  const adapter = byCommand.get(context.args.agentCmd);
  if (!adapter) throw new Error(`unsupported agent harness: ${context.args.agentCmd}`);
  return adapter.plan(context);
}

export { adapters as harnessAdapters };
