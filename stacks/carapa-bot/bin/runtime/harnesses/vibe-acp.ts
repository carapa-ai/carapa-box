import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessAdapter, RunContext } from '../contracts';
import { planAcpHarness, type AcpHarnessContract, type AcpRequest } from '../acp/contracts';
import { runAcpHarness } from '../acp/runner';
import { atomicWrite } from '../files';
import { hostEnvValue } from '../roots';
import { StandardAcpRunV1Adapter } from '../standard-acp-v1';

/** Read-only Board plan mode. Vibe removed its own plan agent; a profile whose
 * tool list omits bash, edit and write_file makes the runtime deny them. */
export const VIBE_PLAN_MODE = 'carapa-plan';
const PLAN_PROFILE = `display_name = "Plan"
description = "Read-only: investigate and propose a plan, change nothing"
safety = "safe"
enabled_tools = ["grep", "read_file", "skill", "todo", "web_fetch", "web_search", "ask_user_question"]
bypass_tool_permissions = true
`;

/** Vibe 3.1.0's run_typescript `tools.process.start` takes `{ command, cwd?, env? }`
 * (its `_ProcessStartArguments`); a plain string crashes the harness. */
const PROCESS_START_GUIDANCE = "In run_typescript, call tools.process.start with an object, e.g. { command: 'bun run build' }, " +
  'never a plain string (it crashes Vibe); use the bash tool for ordinary shell commands.';

/** Vibe's built-in slash commands (acp/commands/registry.py); it answers them itself, never the model. */
const NATIVE_COMMANDS = new Set(['help', 'compact', 'reload', 'log', 'mcp', 'teleport', 'proxy-setup', 'retry', 'leanstall',
  'unleanstall', 'data-retention']);

/** Vibe trims a prompt and reads a first token like `/name` as a command or skill (case-insensitive). */
const slashName = (prompt: string): string | null => prompt.match(/^\s*\/([^\s/]+)(?:\s|$)/)?.[1].toLowerCase() ?? null;

/** Vibe handles `/loop` outside its command registry: a first word `/loop` (case-insensitive) makes it add its
 * scheduling instructions to the turn. */
const isLoop = (prompt: string): boolean => prompt.trimStart().split(/\s/, 1)[0].toLowerCase() === '/loop';

/** True when Vibe would run the prompt's first token as a command or skill, so nothing may precede it:
 * a built-in command, or the name of an installed skill. Any other `/token` (a path such as `/results.json`)
 * reaches the model as ordinary text. */
function startsWithCommand(context: RunContext): boolean {
  const name = slashName(context.prompt);
  if (!name) return false;
  if (NATIVE_COMMANDS.has(name)) return true;
  const home = context.env.HOME || '';
  return [join(context.env.VIBE_HOME || '', 'skills'), join(home, '.agents', 'skills'), join(context.cwd, '.vibe', 'skills'),
    join(context.cwd, '.agents', 'skills')].some((root) => existsSync(join(root, name, 'SKILL.md')));
}

export const vibeRelayUrl = (env: NodeJS.ProcessEnv): string => hostEnvValue('http://api-relay:8080/mistral-vibe/v1', env);

/** VIBE_* variables outrank user and project config.toml, so a repository's
 * .vibe/config.toml cannot point Vibe elsewhere or turn uploads back on.
 * Model calls go to the relay's `mistral-vibe` route, which holds the Vibe CLI
 * key (billed to the plan's included Vibe Code usage); Vibe sees a placeholder. */
export function vibePrivateEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    MISTRAL_API_KEY: 'carapa-relay',
    VIBE_PROVIDERS: JSON.stringify([{
      name: 'mistral', api_base: vibeRelayUrl(env), api_key_env_var: 'MISTRAL_API_KEY', backend: 'mistral',
    }]),
    // Merged with Vibe's default Medium 3.5 by alias. Thinking levels are the
    // reasoning_effort values Mistral accepts for each model (checked 2026-11-08).
    VIBE_MODELS: JSON.stringify([
      { name: 'mistral-vibe-cli-fast', provider: 'mistral', alias: 'mistral-small-4', display_name: 'Mistral Small 4',
        temperature: 0.3, thinking: 'off', thinking_levels: ['off', 'high'], supports_images: true, max_context_length: 262144 },
      { name: 'mistral-large-4', provider: 'mistral', alias: 'mistral-large-4', display_name: 'Mistral Large 4',
        temperature: 1.0, thinking: 'medium', thinking_levels: ['low', 'medium', 'high'], supports_images: true, max_context_length: 1048576 },
      { name: 'zai-glm-5-3', provider: 'mistral', alias: 'glm-5.3', display_name: 'GLM 5.3',
        temperature: 0.7, thinking: 'high', thinking_levels: ['low', 'high', 'max'], supports_images: false, max_context_length: 1048576 },
      { name: 'zai-glm-5-3-flash', provider: 'mistral', alias: 'glm-5.3-flash', display_name: 'GLM 5.3 Flash',
        temperature: 0.7, thinking: 'high', thinking_levels: ['low', 'high', 'max'], supports_images: true, max_context_length: 1048576 },
    ]),
    // Default to Large 4 instead of Vibe's built-in Medium 3.5: smarter and cheaper.
    VIBE_ACTIVE_MODEL: 'mistral-large-4',
    VIBE_ENABLE_TELEMETRY: 'false',
    VIBE_ENABLE_OTEL: 'false',
    VIBE_ENABLE_CONNECTORS: 'false',
    VIBE_ENABLE_UPDATE_CHECKS: 'false',
    VIBE_ENABLE_AUTO_UPDATE: 'false',
    VIBE_ENABLE_NOTIFICATIONS: 'false',
    VIBE_EXPERIMENTS: JSON.stringify({ enable: false }),
  };
}

/** A Vibe home with the plan profile and, when given, the workspace trusted so
 * Vibe reads its AGENTS.md and project skills. */
export function writeVibeHome(home: string, trusted?: string): void {
  mkdirSync(join(home, 'agents'), { recursive: true, mode: 0o700 });
  atomicWrite(join(home, 'agents', `${VIBE_PLAN_MODE}.toml`), PLAN_PROFILE);
  if (trusted) atomicWrite(join(home, 'trusted_folders.toml'), `trusted = [${JSON.stringify(trusted)}]\nuntrusted = []\n`);
}

const setOption = (sessionId: string, configId: string, value: string): AcpRequest => ({
  method: 'session/set_config_option',
  params: { sessionId, configId, value },
});

export const vibeAcpContract: AcpHarnessContract = {
  id: 'vibe-acp',
  restore: 'load',
  restoreFailure: 'new-session',
  reportModel: true,
  // Vibe 3.1.0: a run_typescript `tools.process.start('<command>')` call makes
  // its Python layer reject the Core's own transition, and the in-memory Core
  // then refuses every later prompt (state='running'). A new process reloads
  // the saved session and accepts prompts again.
  retireDaemonAfter: (failure) =>
    failure.includes('Core rejected durable input') || failure.includes('RustAcceptedApplyResult'),
  recoveryPrompt: () => 'Your last run_typescript call to tools.process.start passed a plain string, which crashed the agent ' +
    `process, which was restarted. ${PROCESS_START_GUIDANCE} Retry what you were doing.`,
  // A fresh session has no failed response for a built-in command such as /retry to act on.
  freshSessionRequest: (prompt) => NATIVE_COMMANDS.has(slashName(prompt) ?? '') ? null : prompt,
  prepare(context: RunContext) {
    // One home per conversation: it holds the sessions that session/load restores.
    const home = join(dirname(dirname(context.runDir)), 'vibe-home',
      (context.args.conversationKey || context.runTag).replace(/[^A-Za-z0-9_.-]/g, '_'));
    writeVibeHome(home, context.cwd);
    context.env.VIBE_HOME = home;
    // ACP has no separate system-prompt field; carry instructions as leading prompt text.
    // A prompt Vibe runs as a command or skill, or reads as `/loop`, gets no guidance that would push it off the front.
    const loop = isLoop(context.prompt);
    const instructions = [context.args.systemPrompt, startsWithCommand(context) || loop ? '' : PROCESS_START_GUIDANCE]
      .filter(Boolean).join('\n\n');
    if (instructions) context.prompt = `${instructions}\n\nUser request:\n${context.prompt}`;
    if (loop) context.prompt = `${context.prompt}\n\n${PROCESS_START_GUIDANCE}`;
  },
  process(context) {
    return { command: ['vibe-acp'], env: vibePrivateEnv(context.env) };
  },
  desiredConfiguration(context) {
    return { model: context.args.model, thinking: context.args.reasoningEffort };
  },
  configure(context, sessionId, current = { newDaemon: true, model: '', thinking: '' }) {
    // Mode must follow every turn: a reused session may still be in plan mode.
    const requests = [setOption(sessionId, 'mode', context.args.chatMode === 'plan' ? VIBE_PLAN_MODE : 'auto-approve')];
    const { model, reasoningEffort } = context.args;
    if (model && (current.newDaemon || current.model !== model)) requests.push(setOption(sessionId, 'model', model));
    if (reasoningEffort && (current.newDaemon || current.thinking !== reasoningEffort)) {
      requests.push(setOption(sessionId, 'thinking', reasoningEffort));
    }
    return requests;
  },
  createV1: (context, writer, resumed) => new StandardAcpRunV1Adapter(writer, context.args.model, resumed, `vibe-acp-${context.runTag}-message-1`),
};

export const vibeAcpHarness: HarnessAdapter = {
  command: 'vibe-acp',
  plan: (context) => planAcpHarness(context, vibeAcpContract, runAcpHarness),
};
