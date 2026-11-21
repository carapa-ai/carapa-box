import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { configureAntigravityRelay } from './antigravity-auth';

export const agySdkHarness: HarnessAdapter = {
  command: 'agy-sdk',
  plan(context: RunContext): HarnessPlan {
    configureAntigravityRelay(context.env);
    return { kind: 'native', persistentResume: true, command: ['bun', '--no-env-file', `${context.binDir}/runtime/agy-sdk-runner.ts`, context.runDir], promptMode: 'none' };
  },
};
