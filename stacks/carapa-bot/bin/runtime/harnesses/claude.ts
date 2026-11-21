import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { runClaudeHarness } from '../claude-runner';

export const claudeHarness: HarnessAdapter = {
  command: 'claude',
  plan(context: RunContext): HarnessPlan {
    return { kind: 'managed', execute: runClaudeHarness };
  },
};
