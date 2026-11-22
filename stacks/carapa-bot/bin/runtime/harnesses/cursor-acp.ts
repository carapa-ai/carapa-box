import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract } from '../acp/contracts';
import { runAcpHarness } from '../acp/runner';
import { atomicWrite } from '../files';
import { hostEnvValue } from '../roots';

const splitFlags = (value: string): string[] => value.split(/\s+/).filter(Boolean);

export const cursorRelayUrl = (env: NodeJS.ProcessEnv): string => hostEnvValue('http://api-relay:8080/cursor', env);

// An unsigned token the CLI only reads the expiry of; the relay's `cursor`
// route replaces it with the managed Cursor login.
const PLACEHOLDER = [{ alg: 'none', typ: 'JWT' }, { sub: 'carapa-relay', exp: 4102444800 }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.carapa-relay';

const exists = (path: string) => {
  try { lstatSync(path); return true; } catch { return false; }
};

/** Cursor reads its login and CLI settings from `$XDG_CONFIG_HOME/cursor`.
 * Write the placeholder login there with the shared settings, forcing HTTP/1.1
 * agent traffic so it stays on CURSOR_API_ENDPOINT instead of Cursor's own
 * agent hosts. The folder is also the config home of every command the agent
 * runs, so the rest of the shared ~/.config is linked in (never its cursor/). */
export function writeCursorRelayConfig(configHome: string, home: string): void {
  const dir = join(configHome, 'cursor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shared = join(home, '.config');
  let names: string[] = [];
  try { names = readdirSync(shared); } catch { /* No shared config yet. */ }
  for (const name of names) {
    if (name !== 'cursor' && !exists(join(configHome, name))) symlinkSync(join(shared, name), join(configHome, name));
  }
  let settings: Record<string, any> = { version: 1 };
  try { settings = JSON.parse(readFileSync(join(home, '.cursor', 'cli-config.json'), 'utf8')); } catch { /* Defaults. */ }
  atomicWrite(join(dir, 'cli-config.json'), JSON.stringify({ ...settings, network: { ...settings.network, useHttp1ForAgent: true } }, null, 2));
  const auth = join(dir, 'auth.json');
  atomicWrite(auth, JSON.stringify({ accessToken: PLACEHOLDER, refreshToken: PLACEHOLDER }));
  chmodSync(auth, 0o600);
}

/** Point a Cursor CLI environment at the relay with the placeholder login. */
export function useCursorRelay(env: Record<string, string | undefined>, configHome: string): void {
  // Either would replace the placeholder and bypass the managed account.
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  writeCursorRelayConfig(configHome, env.HOME || homedir());
  env.XDG_CONFIG_HOME = configHome;
  env.CURSOR_API_ENDPOINT = cursorRelayUrl(env as NodeJS.ProcessEnv);
}

export const cursorAcpContract: AcpHarnessContract = {
  id: 'cursor-acp',
  restore: 'load',
  restoreFailure: 'new-session',
  prepare(context: RunContext) {
    // One config per conversation: runs in a conversation are serialized.
    useCursorRelay(context.env, join(dirname(dirname(context.runDir)), 'cursor-config',
      (context.args.conversationKey || context.runTag).replace(/[^A-Za-z0-9_.-]/g, '_')));
  },
  process(context) {
    const flags =
      context.env.CARAPA_CURSOR_ACP_AGENT_FLAGS ||
      context.env.CURSOR_ACP_AGENT_FLAGS ||
      '--yolo --approve-mcps';
    const command = ['agent', ...splitFlags(flags), '--workspace', context.cwd];
    if (context.args.model) command.push('--model', context.args.model);
    command.push('acp');
    return { command };
  },
  // The model is a launch flag only; a warm process keeps the old one.
  launchIdentity: (context) => JSON.stringify([context.args.model]),
  afterInitialize() {
    return [{ method: 'authenticate', params: { methodId: 'cursor_login' }, optional: true }];
  },
};

export const cursorAcpHarness: HarnessAdapter = {
  command: 'cursor-acp',
  plan: (context) => planAcpHarness(context, cursorAcpContract, runAcpHarness),
};
