import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { ensureAgentSkillLinks, generateAgentOverrides } from '../instructions';
import { runPiRpcHarness } from '../pi-rpc/runner';

export const piHarness: HarnessAdapter = {
  command: 'pi',
  plan(context: RunContext): HarnessPlan {
    generateAgentOverrides(context);
    ensureAgentSkillLinks(context);
    context.env.PI_CODEX_WEBSOCKET ??= '1';
    return { kind: 'managed', execute: runPiRpcHarness };
  },
};
