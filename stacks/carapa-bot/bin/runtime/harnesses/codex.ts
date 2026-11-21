import { dirname, join } from 'node:path';
import type { HarnessAdapter, HarnessPlan, RunContext } from '../contracts';
import { generateAgentOverrides, ensureAgentSkillLinks, prepareCodexHome } from '../instructions';

function projectCodexHome(context: RunContext): string {
  // The IPC root belongs to one project agent instance. Keep Codex databases
  // there while the app-server keeps daemon and thread routing per conversation.
  const ipcRoot = dirname(dirname(context.runDir));
  return join(ipcRoot, 'codex-home');
}

export const codexHarness: HarnessAdapter = {
  command: 'codex',
  plan(context: RunContext): HarnessPlan {
    generateAgentOverrides(context);
    ensureAgentSkillLinks(context);
    const profile = context.env.CODEX_PROFILE || '';
    if (profile && !/^[A-Za-z0-9_-]+$/.test(profile)) {
      throw new Error(`codex: invalid CODEX_PROFILE ${JSON.stringify(profile)}`);
    }
    const codexHome = projectCodexHome(context);
    prepareCodexHome(context, codexHome);
    context.env.CODEX_HOME = codexHome;
    return {
      kind: 'native',
      command: [
        'bun',
        '--no-env-file',
        join(context.binDir, 'runtime', 'codex-app-server', 'main.ts'),
        context.runDir,
      ],
      promptMode: 'none',
    };
  },
};
