import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { carapaMailMcpServers, type HttpMcpServer } from './carapa-mail';
import type { RunContext } from './contracts';
import { ClaudeRunV1Adapter } from './claude-v1';
import { claudeTurnCost } from './claude-cost';
import { createPlanRenderer } from './codex-app-server/plans';
import { atomicWrite, writeRunFile } from './files';
import { claudeGroupRulesFile, claudeModelDecisionFiles } from './instructions';
import { containerInstanceId, matchesCurrentInstance, terminateProcessTree } from './processes';
import { daemonIdentity, sendProtocol, startProtocolDaemon } from './protocol/daemon';
import { decodeObject, readJournal } from './protocol/journal';
import { startResourceGuard } from './resource-guard';
import { createRunV1Writer } from './run-v1';
import { acquireSessionLock, readText, releaseSessionLock, safeSessionKey } from './sessions';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};

export function claudeLaunch(context: RunContext, sessionId = '', mcpServers: HttpMcpServer[] = []): { command: string[]; env: Record<string, string> } {
  // Native plan mode exposes AskUserQuestion/ExitPlanMode only when a host
  // answers permission prompts; the runner answers them over stdio.
  const permissions = context.args.chatMode === 'plan'
    ? ['--permission-mode', 'plan', '--permission-prompt-tool', 'stdio']
    : ['--dangerously-skip-permissions'];
  const command = ['claude', ...permissions, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const env = { ...context.env };
  // API-key sessions default to a 5-minute prompt cache; a conversation can opt
  // into 1 hour. Local model proxies are left alone: they may reject that TTL.
  const base = env.ANTHROPIC_BASE_URL || '';
  if (context.args.promptCacheTtl === '1h' && !env.CLAUDE_CODE_PROMPT_CACHE_TTL
    && (!base || /^https:\/\/api\.anthropic\.com|^http:\/\/api-relay:\d+\/anthropic(-api)?\/?$/.test(base))) {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h';
  }
  if (context.args.bare === '1') command.push('--bare');
  if (sessionId) command.push(`--resume=${sessionId}`);
  if (context.args.forkSession === '1') command.push('--fork-session');
  if (context.args.model) command.push('--model', context.args.model);
  const effort = env.CLAUDE_CODE_EFFORT || context.args.reasoningEffort;
  if (effort === 'none') {
    // Preserve the existing NInfer workaround: this CLI build cannot express
    // disabled thinking in its request body, so the proxy honors this header.
    env.ANTHROPIC_CUSTOM_HEADERS = 'x-ninfer-reasoning: none';
  } else if (effort) command.push('--effort', effort);
  if (context.args.agent) command.push('--agent', context.args.agent);
  if (context.args.systemPrompt) command.push('--system-prompt', context.args.systemPrompt);
  // Repository runs sit outside the group directory, so Claude does not find
  // the group's .claude/rules by itself; append them (bare runs load nothing).
  if (context.args.bare !== '1') {
    const groupRules = claudeGroupRulesFile(context);
    if (groupRules) command.push('--append-system-prompt-file', groupRules);
    // Claude ignores `trigger:`, so it would load model_decision rules in full on
    // every step; exclude them and append a link index instead.
    try {
      const files = claudeModelDecisionFiles(context);
      if (files) {
        command.push('--settings', files.settingsFile);
        if (files.indexFile) command.push('--append-system-prompt-file', files.indexFile);
      }
    } catch (error) {
      process.stderr.write(`claude-runner: model_decision rules stay in full, could not write their files: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const lspPlugin = claudeLspPlugin(env);
  if (lspPlugin) command.push('--plugin-dir', lspPlugin);
  // Project-scoped servers join the user-scope carapa-board registration. One
  // `=` argument: the flag is variadic and would take a following value as a file.
  if (mcpServers.length) {
    command.push(`--mcp-config=${JSON.stringify({
      mcpServers: Object.fromEntries(mcpServers.map(({ name, url }) => [name, { type: 'http', url }])),
    })}`);
  }
  return { command, env };
}

/**
 * The agent view links shared rules into .claude/rules from the agent home,
 * outside the working directory. Claude loads such external rule files only
 * once the project approved them, and a headless run cannot show that prompt,
 * so it silently skips them. Record the approval for the run's directory.
 */
export function approveExternalRuleIncludes(context: RunContext): void {
  let config = join(context.env.CLAUDE_CONFIG_DIR || context.env.HOME || '/home/ubuntu', '.claude.json');
  let settings: Json = {};
  let mode = 0o600;
  if (existsSync(config)) {
    config = realpathSync(config); // Write through a linked config instead of replacing the link.
    const parsed: unknown = JSON.parse(readFileSync(config, 'utf8')); // Unreadable config: leave it to Claude.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    settings = parsed as Json;
    mode = statSync(config).mode & 0o777;
  }
  const projects = object(settings.projects);
  const project = object(projects[context.cwd]);
  if (project.hasClaudeMdExternalIncludesApproved === true) return;
  settings.projects = { ...projects, [context.cwd]: { ...project, hasClaudeMdExternalIncludesApproved: true } };
  atomicWrite(config, JSON.stringify(settings, null, 2));
  chmodSync(config, mode);
}

// Language servers Claude Code's LSP tool may use. The shared harness volume
// ships tsc; component images add their own (PHP: intelephense, llama-cpp: clangd).
const LSP_SERVERS: Record<string, { command: string; args?: string[]; extensionToLanguage: Record<string, string>; env?: Record<string, string>; settings?: unknown }> = {
  typescript: {
    command: 'tsc', args: ['--lsp', '--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact'
    },
  },
  php: {
    command: 'intelephense', args: ['--stdio'], extensionToLanguage: { '.php': 'php' },
    env: { NODE_OPTIONS: '--max-old-space-size=2048' },
    // Task worktrees and the project's runtime storage held ~97% of the PHP files in a demo-site
    // workspace. The list replaces Intelephense's defaults, so they are repeated; patterns are
    // relative to the workspace folder, so `storage/**` matches only the project's own.
    settings: { intelephense: { files: { exclude: [
      '**/.git/**', '**/.svn/**', '**/.hg/**', '**/CVS/**', '**/.DS_Store/**', '**/node_modules/**', '**/bower_components/**',
      '**/vendor/**/{Tests,tests}/**', '**/.history/**', '**/vendor/**/vendor/**', '**/.worktrees/**', 'storage/**',
    ] } } },
  },
  clangd: {
    command: 'clangd',
    extensionToLanguage: {
      '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp',
      '.hxx': 'cpp', '.cu': 'cuda-cpp', '.cuh': 'cuda-cpp'
    },
  },
};

/** Last non-empty stderr lines the provider wrote after `offset`; empty when there are none. */
function providerStderrTail(path: string, offset: number): string {
  try {
    const size = statSync(path).size;
    const start = size < offset ? 0 : offset;
    const bytes = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, bytes, 0, bytes.length, start); } finally { closeSync(fd); }
    return bytes.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean).slice(-5).join('\n').slice(-4_000);
  } catch {
    return '';
  }
}

/** Session-only plugin declaring the servers this container has; '' when it has none. */
function claudeLspPlugin(env: Record<string, string>): string {
  const servers = Object.fromEntries(Object.entries(LSP_SERVERS).filter(([, server]) => Bun.which(server.command, { PATH: env.PATH ?? '' })));
  if (!Object.keys(servers).length) return '';
  const lsp = JSON.stringify(servers, null, 2);
  // Content-addressed, so concurrent launches agree and a changed server set restarts warm sessions.
  const dir = join(env.TMPDIR || tmpdir(), `carapa-claude-lsp-${createHash('sha256').update(lsp).digest('hex').slice(0, 12)}`);
  if (!existsSync(join(dir, '.lsp.json'))) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    atomicWrite(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'carapa-lsp', version: '1.0.0', description: 'Language servers installed in this container' }));
    atomicWrite(join(dir, '.lsp.json'), lsp); // Written last: its presence marks a complete plugin.
  }
  return dir;
}

function launchIdentity(context: RunContext, mcpServers: HttpMcpServer[]): string {
  const { command, env } = claudeLaunch({ ...context, args: { ...context.args, forkSession: '' } }, '', mcpServers);
  // Provider configuration and credentials are immutable in an existing child.
  // Run/browser routing is refreshed through the supervisor's active_run pointer.
  const providerEnv = Object.entries(env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_|NINFER_|AWS_|GOOGLE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|SSL_CERT_|HOME$|PATH$)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({ command, cwd: context.cwd, providerEnv })).digest('hex');
}

// Delay between the last background task finishing and its follow-up turn starting.
const BACKGROUND_TURN_GRACE_MS = 20_000;
// A run that only waits on background tasks, with nothing from the CLI for this long, is
// abandoned: a task that can never finish (a wait loop that matches itself) would otherwise
// hold the run until the turn timeout. Override with CARAPA_BACKGROUND_IDLE_LIMIT_SECONDS.
const BACKGROUND_IDLE_LIMIT_SECONDS = 1_800;

/**
 * The user's raw slash command (`user-command.txt`), when Board wrote one and its name is
 * allowlisted. Claude only treats a message as a command when it starts with `/`, which the
 * composed prompt never does, so the command is sent as its own frame after the prompt turn.
 */
export function claudeForwardedCommand(context: RunContext): string {
  const text = readText(join(context.runDir, 'user-command.txt')).trim().split(/\r?\n[ \t]*\r?\n/)[0].trim();
  const name = /^\/(\S+)/.exec(text)?.[1];
  if (!name) return '';
  const allowed = (context.env.CARAPA_CLAUDE_FORWARD_COMMANDS ?? 'goal').split(',').map(entry => entry.trim().replace(/^\//, '')).filter(Boolean);
  return allowed.includes(name) ? text : '';
}

/** One stream-json implementation for run-scoped tasks and retained chat sessions. */
export async function runClaudeHarness(context: RunContext): Promise<number> {
  const persistent = context.args.persistent === '1' && !!context.args.conversationKey;
  const sessionDir = persistent
    ? join(dirname(dirname(context.runDir)), 'sessions', safeSessionKey(context.args.conversationKey))
    : join(context.runDir, 'claude-session');
  mkdirSync(sessionDir, { recursive: true });
  const instance = containerInstanceId();
  if (!instance) throw new Error('Could not determine container instance');
  const previousInstance = readText(join(sessionDir, 'container_instance'));
  if (previousInstance && !matchesCurrentInstance(join(sessionDir, 'container_instance'), previousInstance)) {
    // PIDs from an earlier container must never be signalled in this one.
    for (const name of ['lock', 'lifecycle.lock', 'daemon.pid', 'supervisor.pid']) rmSync(join(sessionDir, name), { recursive: true, force: true });
  }
  writeRunFile(context.runDir, 'session_dir', sessionDir);
  for (const name of ['control-requests', 'control-responses']) mkdirSync(join(context.runDir, name), { recursive: true });
  const raw = join(context.runDir, 'claude.raw.jsonl');
  writeFileSync(raw, '');
  rmSync(join(context.runDir, 'claude-turn-cost.json'), { force: true });
  const input = join(sessionDir, 'claude-input');
  const journal = join(sessionDir, 'claude.out');
  const inFlight = join(sessionDir, 'turn_in_flight');
  const stderrPath = join(sessionDir, 'claude.stderr.log');
  // The log accumulates across launches; only what this run wrote after taking the lock explains its failure.
  let stderrOffset: number | undefined;
  let lock = '';
  let pid: number | undefined;
  let adapter: ClaudeRunV1Adapter | undefined;
  let interrupted = false;
  let reusable = false;
  let guard: ReturnType<typeof startResourceGuard> | undefined;
  const pending = new Map<string, { path: string; deadline: number; interrupt: boolean }>();
  // Steering prompts queued in the CLI, keyed by message UUID until the CLI
  // reports them started. An unstarted steer at a result becomes another turn.
  const steers = new Map<string, { path?: string; started: boolean }>();
  let cancelSteers = false;
  // Background agents/commands the CLI is still running. A result while any are
  // outstanding is not the end of the run: their notifications start new turns.
  const background = new Map<string, { description: string; startedAt: number }>();
  let turnActive = false;
  // A task that finishes during a turn still gets its own notification turn
  // after that turn's result, so the run must stay open for it.
  let notificationsOwed = 0;
  // The forwarded command, while the CLI reports it queued behind another turn.
  let commandUuid = '';
  let commandQueued = false;
  let backgroundChangedAt = 0;
  let lastCliMessageAt = Date.now();
  // The turn ended with background work outstanding, so the run stays open for the turns it triggers.
  let waitingOnBackground = false;
  // Slash command still to send. It goes out only once nothing else is outstanding (no steer,
  // no background task or its notification turn), so the next result is certainly its own.
  let userCommand = claudeForwardedCommand(context);
  // Commands the CLI lists in system/init; absent means the allowlist alone decides.
  let slashCommands: string[] | undefined;
  let abandonedBackground = false;
  // AskUserQuestion permission requests stay open until Board answers them.
  const questions = new Map<string, { requestId: unknown; input: Json }>();
  try {
    lock = await acquireSessionLock(sessionDir, context.runDir);
    stderrOffset = statSync(stderrPath, { throwIfNoEntry: false })?.size ?? 0;
    // Read after the lock: the preceding turn may just have published its ID.
    const savedSession = readText(join(sessionDir, 'session_id'));
    const sessionId = context.args.sessionId || savedSession;
    const costPath = join(sessionDir, 'claude_cost_snapshot.json');
    let previousCost: unknown;
    if (!existsSync(inFlight) && context.args.forkSession !== '1') {
      try { previousCost = JSON.parse(readText(costPath)); } catch { /* Unknown history: use configured pricing. */ }
    }
    // Board supplies bootstrap instructions only on the first turn. An omitted
    // follow-up prompt means keep those instructions, not replace them with the
    // CLI default (which would also force a needless process restart).
    const promptPath = join(sessionDir, 'claude_system_prompt');
    const sameSession = !context.args.sessionId || context.args.sessionId === savedSession;
    const systemPrompt = context.args.systemPrompt || (sameSession && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '');
    context = { ...context, args: { ...context.args, systemPrompt } };
    atomicWrite(promptPath, systemPrompt);
    chmodSync(promptPath, 0o600);
    const writer = createRunV1Writer(context, 'claude');
    adapter = new ClaudeRunV1Adapter(writer, context.args.model.trim(), Boolean(sessionId),
      context.args.chatMode === 'plan' ? createPlanRenderer(context.args) : undefined);
    const mcpServers = await carapaMailMcpServers();
    const identity = launchIdentity(context, mcpServers);
    let owner = daemonIdentity(input);
    const restart = context.args.forkSession === '1' || (context.args.sessionId && context.args.sessionId !== savedSession)
      || readText(join(sessionDir, 'claude_launch_identity')) !== identity || existsSync(inFlight);
    if (owner && restart) {
      await terminateProcessTree(owner.pid);
      owner = undefined;
    }
    let offset = statSync(journal, { throwIfNoEntry: false })?.size ?? 0;
    const fresh = !owner;
    // A retained process emits system/init only once, so its list is kept for later runs.
    const slashPath = join(sessionDir, 'claude_slash_commands');
    if (owner) {
      pid = owner.pid;
      try { slashCommands = JSON.parse(readText(slashPath)); } catch { /* Not advertised: the allowlist decides. */ }
    } else {
      rmSync(slashPath, { force: true });
      if (context.args.bare !== '1') {
        try { approveExternalRuleIncludes(context); } catch { /* Rules stay skipped; the run still starts. */ }
      }
      const launched = await startProtocolDaemon({
        ...claudeLaunch(context, sessionId, mcpServers), cwd: context.cwd, sessionDir, input, output: journal,
        stderr: stderrPath,
        idleMs: persistent ? Math.max(1, Number(context.env.CARAPA_PERSIST_IDLE_MIN || 30)) * 60_000 : 0,
      });
      pid = launched.pid;
      offset = launched.offset;
      atomicWrite(join(sessionDir, 'claude_launch_identity'), identity);
    }
    atomicWrite(join(sessionDir, 'daemon.pid'), String(pid));
    atomicWrite(join(sessionDir, 'supervisor.pid'), String(pid));
    writeRunFile(context.runDir, 'pid', String(pid));
    guard = startResourceGuard(context, pid);
    const cursor = { offset };
    const read = (): Json[] => readJournal(journal, cursor, raw).flatMap(line => {
      const message = decodeObject(line);
      if (!message) throw new Error('Claude emitted invalid stream-json; see claude.raw.jsonl');
      return [message];
    });
    const connected = (): void => {
      if (daemonIdentity(input)?.pid !== pid) throw new Error('Claude stream-json process disconnected');
    };
    const permit = (requestId: unknown, response: Json): void => {
      sendProtocol(input, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    };
    const handleProviderRequest = (message: Json): boolean => {
      if (message.type === 'control_cancel_request') {
        for (const [id, question] of questions) if (question.requestId === message.request_id) questions.delete(id);
        return false;
      }
      if (message.type !== 'control_request') return false;
      const request = object(message.request);
      const toolInput = object(request.input);
      if (request.subtype !== 'can_use_tool') {
        sendProtocol(input, { type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: `Unsupported Claude control request: ${String(request.subtype)}` } });
      } else if (request.tool_name === 'AskUserQuestion' && typeof request.tool_use_id === 'string') {
        questions.set(request.tool_use_id, { requestId: message.request_id, input: toolInput });
      } else if (request.tool_name === 'ExitPlanMode') {
        // The adapter already published the plan for approval in Board.
        permit(message.request_id, { behavior: 'deny', message: 'The plan has been shown to the user for approval. End your turn now and wait for their reply.' });
      } else {
        // Plan mode prompts for writes; the sandbox, not the CLI, is the boundary.
        permit(message.request_id, { behavior: 'allow', updatedInput: toolInput });
      }
      return true;
    };
    const answerQuestion = (request: Json): boolean => {
      const question = questions.get(String(request.requestId));
      if (!question) return false;
      const answers: Record<string, string> = {};
      const submitted = object(request.answers);
      (Array.isArray(question.input.questions) ? question.input.questions : []).forEach((value, index) => {
        const entry = object(value);
        // Question IDs match the ones the adapter published for this card.
        const id = typeof entry.id === 'string' && entry.id ? entry.id : `question-${index + 1}`;
        const selected = object(submitted[id]).answers;
        if (typeof entry.question === 'string' && Array.isArray(selected)) answers[entry.question] = selected.map(String).join(', ');
      });
      permit(question.requestId, { behavior: 'allow', updatedInput: { ...question.input, answers } });
      questions.delete(String(request.requestId));
      return true;
    };
    if (fresh) {
      const requestId = randomUUID();
      sendProtocol(input, { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } });
      const deadline = Date.now() + 60_000;
      let initialized = false;
      while (!initialized && Date.now() < deadline) {
        for (const message of read()) {
          if (handleProviderRequest(message)) continue;
          const response = object(message.response);
          if (message.type !== 'control_response' || response.request_id !== requestId) continue;
          if (response.subtype !== 'success') throw new Error(`Claude initialization failed: ${String(response.error)}`);
          initialized = true;
        }
        if (!initialized) { connected(); await Bun.sleep(25); }
      }
      if (!initialized) throw new Error('Claude initialization timed out');
    }
    if (sessionId && context.args.forkSession !== '1') adapter.start(sessionId);
    atomicWrite(join(context.runDir, 'agent-control.json'), JSON.stringify({ version: 1, harness: 'claude', pid, sessionId }));
    atomicWrite(inFlight, context.runDir);
    // A crash or missing result must not leave a trusted accounting boundary.
    rmSync(costPath, { force: true });
    const promptUuid = randomUUID();
    // The CLI can run an earlier queued command (for example the notification
    // for a background task that died with the previous session) before this
    // prompt. Its result is not this turn's result.
    let promptQueued = false;
    sendProtocol(input, { type: 'user', uuid: promptUuid, session_id: sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: context.prompt } });
    writeRunFile(context.runDir, 'prompt_dispatched_at_ms', String(Date.now()));
    // Sends the user's slash command as its own turn when the run would otherwise be complete.
    const turnAdapter = adapter;
    const forwardCommand = (): boolean => {
      const command = userCommand;
      userCommand = '';
      if (!command || interrupted || cancelSteers || existsSync(join(context.runDir, 'turn_interrupt'))) return false;
      if (slashCommands && !slashCommands.includes(/^\/(\S+)/.exec(command)![1])) return false;
      turnAdapter.beginContinuation();
      commandUuid = randomUUID();
      sendProtocol(input, {
        type: 'user', uuid: commandUuid, session_id: readText(join(sessionDir, 'session_id')), parent_tool_use_id: null,
        message: { role: 'user', content: command }
      });
      return true;
    };
    const deadline = Date.now() + Math.max(1, Number(context.env.CARAPA_PERSIST_TURN_TIMEOUT || 9_800)) * 1_000;
    const backgroundIdleLimitMs = Math.max(0.1, Number(context.env.CARAPA_BACKGROUND_IDLE_LIMIT_SECONDS || BACKGROUND_IDLE_LIMIT_SECONDS)) * 1_000;
    let completed = false;
    let firstOutput = false;
    let resultCount = 0;
    let totalCost: number | null = 0;
    while (Date.now() < deadline) {
      for (const name of readdirSync(join(context.runDir, 'control-requests')).filter(name => name.endsWith('.json')).sort()) {
        const source = join(context.runDir, 'control-requests', name);
        const target = join(context.runDir, 'control-responses', name);
        let request: Json = {};
        try { request = object(JSON.parse(readFileSync(source, 'utf8'))); } catch { /* reject below */ }
        if (request.action === 'interrupt' && (!completed || writer.toolCallRecovery.needed())) {
          const id = randomUUID();
          pending.set(id, { path: target, deadline: Date.now() + 8_000, interrupt: true });
          // The CLI still runs queued steers after an interrupt; stop them too.
          cancelSteers = true;
          sendProtocol(input, { type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
        } else if (request.action === 'steer' && !completed && !cancelSteers && typeof request.text === 'string' && request.text) {
          // Acknowledged when the CLI reports the command queued.
          const uuid = randomUUID();
          steers.set(uuid, { path: target, started: false });
          sendProtocol(input, {
            type: 'user', uuid, session_id: readText(join(sessionDir, 'session_id')), parent_tool_use_id: null,
            message: { role: 'user', content: request.text }
          });
        } else if (request.action === 'stopTask' && typeof request.taskId === 'string' && background.has(request.taskId)) {
          // Ends one background task; its notification then drives the next turn as usual.
          const id = randomUUID();
          pending.set(id, { path: target, deadline: Date.now() + 8_000, interrupt: false });
          sendProtocol(input, { type: 'control_request', request_id: id, request: { subtype: 'stop_task', task_id: request.taskId } });
        } else if (request.action === 'answerUserInput' && !completed && answerQuestion(request)) {
          atomicWrite(target, JSON.stringify({ ok: true, result: {} }));
        } else atomicWrite(target, JSON.stringify({ ok: false, error: 'Unsupported Claude control request or turn already completed' }));
        rmSync(source, { force: true });
      }
      for (const message of read()) {
        lastCliMessageAt = Date.now();
        if (handleProviderRequest(message)) continue;
        if (message.type === 'control_response') {
          const response = object(message.response);
          const control = pending.get(String(response.request_id));
          if (control) {
            const ok = response.subtype === 'success';
            atomicWrite(control.path, JSON.stringify(ok ? { ok, result: response.response ?? {} } : { ok, error: String(response.error || 'Claude rejected interruption') }));
            pending.delete(String(response.request_id));
            interrupted ||= ok && control.interrupt;
          }
          continue;
        }
        if (message.type === 'command_lifecycle') {
          if (message.command_uuid === promptUuid) promptQueued = message.state === 'queued';
          if (message.command_uuid === commandUuid) {
            commandQueued = message.state === 'queued';
            // The CLI runs a queued command after an interrupt too; stop it as it starts.
            if (message.state === 'started' && cancelSteers) sendProtocol(input, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
          }
          const steer = steers.get(String(message.command_uuid));
          if (!steer) continue;
          if (steer.path) {
            atomicWrite(steer.path, JSON.stringify({ ok: true, result: {} }));
            steer.path = undefined;
          }
          if (message.state === 'started') {
            steer.started = true;
            if (cancelSteers) sendProtocol(input, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
          } else if (message.state !== 'queued') steers.delete(String(message.command_uuid));
          continue;
        }
        if (completed || message.type === 'control_cancel_request') continue;
        if (!message.parent_tool_use_id) {
          if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.slash_commands)) {
            slashCommands = message.slash_commands.map(entry => String(entry).replace(/^\//, ''));
            atomicWrite(slashPath, JSON.stringify(slashCommands));
          }
          if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
            const previous = new Map(background);
            background.clear();
            for (const task of Array.isArray(message.tasks) ? message.tasks : []) {
              const entry = object(task);
              if (typeof entry.task_id !== 'string') continue;
              background.set(entry.task_id, {
                description: typeof entry.description === 'string' ? entry.description : entry.task_id,
                startedAt: previous.get(entry.task_id)?.startedAt ?? Date.now(),
              });
            }
            notificationsOwed += [...previous.keys()].filter(id => !background.has(id)).length;
            backgroundChangedAt = Date.now();
            adapter.setBackgroundTasks([...background].map(([id, task]) => ({ id, ...task })));
          } else if (['stream_event', 'assistant'].includes(String(message.type)) || (message.type === 'system' && message.subtype === 'init')) {
            // A steer's turn does not consume the notification turn a finished task still owes.
            // With a command waiting to be sent, each started turn answers one owed notification;
            // otherwise one turn answers all of them.
            if (!turnActive && ![...steers.values()].some(steer => steer.started)) notificationsOwed = userCommand ? Math.max(0, notificationsOwed - 1) : 0;
            turnActive = true;
          }
        }
        if (promptQueued && message.type === 'result' && !message.parent_tool_use_id) continue;
        if (typeof message.session_id === 'string' && message.session_id && !message.parent_tool_use_id) {
          atomicWrite(join(sessionDir, 'session_id'), message.session_id);
        }
        // Sub-agent events stay in the raw journal only; the parent shows its own turn.
        if (!message.parent_tool_use_id) adapter.consume(message);
        if (!firstOutput && ['assistant', 'result'].includes(String(message.type))) {
          firstOutput = true;
          writeRunFile(context.runDir, 'first_output_at_ms', String(Date.now()));
        }
        if (message.type === 'result' && !message.parent_tool_use_id) {
          const cost = claudeTurnCost(message, previousCost, resultCount === 0 && !sessionId && fresh, resultCount > 0);
          if (cost.snapshot) atomicWrite(costPath, JSON.stringify(cost.snapshot));
          previousCost = cost.snapshot;
          resultCount++;
          totalCost = totalCost !== null && cost.amount !== null ? totalCost + cost.amount : null;
          if (totalCost !== null) atomicWrite(join(context.runDir, 'claude-turn-cost.json'), JSON.stringify({ amount: totalCost }));
          else rmSync(join(context.runDir, 'claude-turn-cost.json'), { force: true });
          // A started steer was answered by this result; an unstarted one runs next.
          for (const [id, steer] of steers) if (steer.started) steers.delete(id);
          turnActive = false;
          if (steers.size || commandQueued) adapter.beginContinuation();
          else if (background.size || notificationsOwed) {
            waitingOnBackground = true;
            adapter.beginContinuation();
            backgroundChangedAt = Date.now();
          } else if (!forwardCommand()) {
            waitingOnBackground = false;
            completed = true;
          }
        }
      }
      if (waitingOnBackground && !completed && !turnActive && pending.size === 0 && !steers.size) {
        // The notification of a finished task starts the next turn within moments;
        // none arriving means nothing is left to wait for.
        if (interrupted) {
          abandonedBackground = background.size > 0;
          completed = true;
        } else if (!background.size && Date.now() - backgroundChangedAt > BACKGROUND_TURN_GRACE_MS) {
          waitingOnBackground = false;
          completed = !forwardCommand();
        } else if (background.size && Date.now() - Math.max(lastCliMessageAt, backgroundChangedAt) > backgroundIdleLimitMs) {
          const waiting = [...background.values()].map(task => task.description).join('; ');
          appendFileSync(join(context.runDir, 'agent-stderr.log'),
            `managed Claude: abandoned background tasks after ${backgroundIdleLimitMs / 1_000}s without activity: ${waiting}\n`);
          abandonedBackground = true;
          completed = true;
        }
      }
      for (const control of pending.values()) if (Date.now() >= control.deadline) throw new Error('Claude interruption acknowledgement timed out');
      if (completed && pending.size === 0) {
        interrupted ||= existsSync(join(context.runDir, 'turn_interrupt'));
        if (!interrupted && !adapter.failed && writer.toolCallRecovery.needed()) {
          // Return through the control loop before sending a continuation.
          if (readdirSync(join(context.runDir, 'control-requests')).some(name => name.endsWith('.json'))) {
            continue;
          }
          const correction = writer.correctToolCall();
          adapter.beginContinuation();
          sendProtocol(input, {
            type: 'user', uuid: randomUUID(), session_id: readText(join(sessionDir, 'session_id')), parent_tool_use_id: null,
            message: { role: 'user', content: correction }
          });
          completed = false;
        } else break;
      }
      connected();
      await Bun.sleep(25);
    }
    if (!completed) throw new Error('Claude turn timed out');
    if (pending.size) throw new Error('Claude turn ended before interruption acknowledgement');
    reusable = true;
    rmSync(inFlight, { force: true });
    writeFileSync(join(sessionDir, 'last_used'), '');
    adapter.finish(0, interrupted);
    return adapter.failed ? 1 : 0;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const stderrTail = stderrOffset === undefined ? '' : providerStderrTail(stderrPath, stderrOffset);
    const message = stderrTail ? `${failure}: ${stderrTail}` : failure;
    adapter ??= new ClaudeRunV1Adapter(createRunV1Writer(context, 'claude'), context.args.model.trim(), Boolean(context.args.sessionId));
    adapter.finish(1, interrupted, message);
    appendFileSync(join(context.runDir, 'agent-stderr.log'), `managed Claude: ${message}; provider stderr: ${stderrPath}\n`);
    return 1;
  } finally {
    guard?.stop();
    for (const control of pending.values()) atomicWrite(control.path, JSON.stringify({ ok: false, error: 'Claude turn ended before interruption acknowledgement' }));
    for (const steer of steers.values()) if (steer.path) atomicWrite(steer.path, JSON.stringify({ ok: false, error: 'Claude turn ended before steer acknowledgement' }));
    // Only retire a process whose supervisor identity we verified or launched.
    if (pid !== undefined && (!persistent || !reusable || abandonedBackground)) {
      await terminateProcessTree(pid);
      for (const name of ['daemon.pid', 'supervisor.pid']) rmSync(join(sessionDir, name), { force: true });
    }
    if (lock) releaseSessionLock(lock);
  }
}
