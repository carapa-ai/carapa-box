import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { join } from 'node:path';

export const opencodeHarness: HarnessAdapter = {
  command: 'opencode',
  plan(context: RunContext): HarnessPlan {
    return { kind: 'native', persistentResume: true, command: ['bun', '--no-env-file', join(context.binDir, 'runtime', 'opencode-runner.ts'), context.runDir], promptMode: 'none' };
  },
};
