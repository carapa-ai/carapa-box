import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract, type AcpRequest } from '../acp/contracts';
import { runAcpHarness } from '../acp/runner';
import { atomicWrite } from '../files';
import { hostEnvValue } from '../roots';
import { StandardAcpRunV1Adapter } from '../standard-acp-v1';

// Host-lifetime posture for `muse serve`, never overridable per run:
// contributor mode would train on workspace code, and Muse's bubblewrap
// sandbox cannot start inside the CarapaBox container, which is the boundary.
export const MUSE_SERVE_ARGS = '--contributor-mode off --disable-sandbox --trust-workspace';

/** Muse sends model calls to <api_base_url>/responses and its catalog to the
 * absolute /muse-code/... on that origin, with api_key as a bearer. Point it at
 * the relay with a placeholder; the relay's `meta` and `muse-code` routes add the
 * managed Meta account's real key (Board Provider accounts). */
export function writeMuseRelayLogin(context: Pick<RunContext, 'env'>, config: string): void {
  mkdirSync(join(config, 'muse'), { recursive: true, mode: 0o700 });
  const file = join(config, 'muse', 'auth.json');
  atomicWrite(file, JSON.stringify({ schema_version: 1, providers: { meta: {
    mechanism: 'oauth', obtained_via: 'device_code', access_token: 'carapa-relay', api_key: 'carapa-relay',
    api_base_url: hostEnvValue('http://api-relay:8080/meta/v1', context.env), subs_active: true,
    user_email: 'relay@carapa.invalid', user_full_name: 'Carapa relay',
  } } }));
  chmodSync(file, 0o600);
}

// Muse's built-in reminder agents run extra model calls after every turn and
// hold the turn open; the memory reminder sends the conversation to Meta to
// decide what to remember. Board owns memory, goals and review instead.
const REMINDERS = ['memory-reminder', 'skill-reminder', 'todo-reminder', 'goal-reminder', 'verify-reminder', 'scope-reminder'];

/** `muse plugins reject` records the bundled definition hash, so re-run it
 * whenever the Muse version changes or any reject failed. Fail closed if memory stays enabled. */
export function disableMuseReminders(context: Pick<RunContext, 'env'>, config: string): void {
  const muse = context.env.MUSE_CLI || 'muse';
  const env = { ...context.env, XDG_CONFIG_HOME: config };
  const run = (args: string[]) => spawnSync(muse, args, { env, encoding: 'utf8', timeout: 20_000 });
  const version = run(['--version']).stdout?.trim();
  const marker = join(config, 'muse', 'reminders-disabled');
  let previous = '';
  try { previous = readFileSync(marker, 'utf8'); } catch { /* First run for this config. */ }
  if (version && previous === version) return;
  let allRejected = true;
  for (const reminder of REMINDERS) {
    if (run(['plugins', 'reject', reminder]).status === 0) continue;
    if (reminder === 'memory-reminder') {
      throw new Error('muse-acp: could not disable the Muse memory reminder; refusing to run');
    }
    allRejected = false;
  }
  // A failed non-memory reject must be retried on the next turn, so no marker then.
  if (version && allRejected) atomicWrite(marker, version);
}

/** Names the trusted workspace's .mcp.json already declares; Muse loads them itself. */
function workspaceMcpNames(cwd: string): Set<string> {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers ?? {}));
  } catch {
    return new Set();
  }
}

const setOption = (sessionId: string, configId: string, value: string): AcpRequest => ({
  method: 'session/set_config_option',
  params: { sessionId, configId, value },
});

export const museAcpContract: AcpHarnessContract = {
  id: 'muse-acp',
  restore: 'load',
  restoreFailure: 'new-session',
  reportModel: true,
  prepare(context) {
    // META_API_KEY outranks the login and would bypass the relay.
    delete context.env.META_API_KEY;
    // One config per conversation: runs in a conversation are serialized.
    const config = join(dirname(dirname(context.runDir)), 'muse-config',
      (context.args.conversationKey || context.runTag).replace(/[^A-Za-z0-9_.-]/g, '_'));
    writeMuseRelayLogin(context, config);
    disableMuseReminders(context, config);
    context.env.XDG_CONFIG_HOME = config;
    // ACP has no separate system-prompt field; carry instructions as leading prompt text.
    if (context.args.systemPrompt) context.prompt = `${context.args.systemPrompt}\n\nUser request:\n${context.prompt}`;
  },
  // Muse refuses a session server whose name the workspace already declares.
  sessionMcpServers(context, servers) {
    const declared = workspaceMcpNames(context.cwd);
    return servers.filter((server) => !declared.has(server.name));
  },
  process() {
    return {
      command: ['muse-acp'],
      env: { MUSE_SERVE_ARGS, MUSE_APPROVAL_MODE: 'allowAll' },
    };
  },
  desiredConfiguration(context) {
    return { model: context.args.model, thinking: context.args.reasoningEffort };
  },
  configure(context, sessionId, current = { newDaemon: true, model: '', thinking: '' }) {
    // Mode is cheap and must follow every turn: a reused session may still be in Plan.
    const requests = [setOption(sessionId, 'mode', context.args.chatMode === 'plan' ? 'plan' : 'default')];
    const { model, reasoningEffort } = context.args;
    if (model && (current.newDaemon || current.model !== model)) requests.push(setOption(sessionId, 'model', model));
    if (reasoningEffort && (current.newDaemon || current.thinking !== reasoningEffort)) {
      requests.push(setOption(sessionId, 'reasoning_effort', reasoningEffort));
    }
    return requests;
  },
  createV1: (context, writer, resumed) => new StandardAcpRunV1Adapter(writer, context.args.model, resumed, `muse-acp-${context.runTag}-message-1`),
};

export const museAcpHarness: HarnessAdapter = {
  command: 'muse-acp',
  plan: (context) => planAcpHarness(context, museAcpContract, runAcpHarness),
};
