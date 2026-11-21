/** Interactive `grok` / `muse` / `vibe` / Cursor's `agent` in a sandbox terminal. Board runs prepare a
 * per-conversation home themselves; a terminal gets the same relay login and
 * privacy settings in one home-wide folder, then the real CLI. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { GROK_PRIVATE_ENV, grokRelayUrl, writeGrokRelayLogin } from './harnesses/grok-acp';
import { disableMuseReminders, writeMuseRelayLogin } from './harnesses/muse-acp';
import { useCursorRelay } from './harnesses/cursor-acp';
import { vibePrivateEnv, writeVibeHome } from './harnesses/vibe-acp';

// Muse subcommands take their own options; only session runs get run flags.
const MUSE_SESSIONS = new Set(['resume', 'exec']);
const MUSE_COMMANDS = new Set([...MUSE_SESSIONS, 'config', 'export', 'trace', 'model-profile', 'skills', 'voice',
  'plugins', 'sandbox', 'schema', 'serve', 'session-message', 'mcp', 'auth', 'login', 'logout', 'init', 'help']);

const [name, real, ...args] = process.argv.slice(2);
if (!real || !['grok', 'muse', 'vibe', 'agent', 'cursor-agent'].includes(name)) {
  console.error('usage: terminal-cli.ts grok|muse|vibe|agent|cursor-agent <real-binary> [args...]');
  process.exit(2);
}
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
const root = join(env.HOME || '/home/ubuntu', '.carapa');
let argv = args;

if (name === 'grok') {
  // An API key would send traffic to api.x.ai at API prices, bypassing the relay.
  delete env.XAI_API_KEY;
  env.GROK_HOME = join(root, 'grok-home');
  writeGrokRelayLogin(env.GROK_HOME);
  Object.assign(env, GROK_PRIVATE_ENV, { GROK_CLI_CHAT_PROXY_BASE_URL: grokRelayUrl(env) });
} else if (name === 'vibe') {
  // Vibe asks before trusting a folder in a terminal; Board runs pre-trust their workspace.
  env.VIBE_HOME = join(root, 'vibe-home');
  writeVibeHome(env.VIBE_HOME);
  Object.assign(env, vibePrivateEnv(env));
} else if (name === 'agent' || name === 'cursor-agent') {
  useCursorRelay(env, join(root, 'cursor-config'));
} else {
  // META_API_KEY outranks the login and would bypass the relay.
  delete env.META_API_KEY;
  env.MUSE_CLI = real;
  const config = join(root, 'muse-config');
  writeMuseRelayLogin({ env }, config);
  disableMuseReminders({ env }, config);
  env.XDG_CONFIG_HOME = config;
  // Contributor mode would train on workspace code (the relay refuses it), and
  // Muse's bubblewrap sandbox cannot start in the container, which is the boundary.
  const flags = ['--contributor-mode', 'off', '--disable-sandbox'];
  if (MUSE_SESSIONS.has(args[0])) argv = [args[0], ...flags, ...args.slice(1)];
  else if (!MUSE_COMMANDS.has(args[0] ?? '')) argv = [...flags, ...args];
}

const result = spawnSync(real, argv, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
