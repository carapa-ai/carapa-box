import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../files';
import { withEnvironment } from './mcp-cache';

type Env = Record<string, string | undefined>;

/** Server definitions shipped by the board that are safe to approve without human review. */
const BOARD_SERVERS = new Set(['carapa-board']);

const BOARD_SYNC_MARKER = 'api-relay:8080/mcp-relay';

/**
 * pi-mcp-adapter (5.0.0+, as of the f1de57d9 pi 1.0.0 release) gates every
 * server defined by a project-level `.mcp.json` behind an interactive
 * "Allow project MCP server …?" prompt. The Pi RPC harness never serves that
 * UI, so the daemon exits while awaiting the response and the turn fails.
 *
 * Before Pi starts, record the same approval an interactive "Allow" would
 * write (`mcp-project-approvals.json` in the shared agent dir, keyed by
 * project approval scope + server name + definition hash) but restricted to
 * board-shipped relay definitions: the board is the only producer of those
 * entries and the harness runs inside the sandbox the board already verified
 * the task against, so no per-project human prompt is needed. The RPC launch
 * also passes `--mcp-project-servers allow`, which admits every project
 * server in a trusted project, so RPC runs no longer depend on these records.
 *
 * Best effort, like rekeyMcpCache: any failure leaves the store untouched
 * (then a project server with an interactive UI would still prompt; RPC has
 * none and simply lacks that server, as before).
 */
export async function ensureProjectMcpApprovals(
  env: Env, cwd: string, log: (line: string) => void,
): Promise<void> {
  try {
    const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME || '/home/ubuntu', '.pi', 'agent');
    const adapter = adapterDirectory(env, agentDir);
    if (!adapter) return log('pi-mcp-adapter not found');
    const approvalPath = join(agentDir, 'mcp-project-approvals.json');
    if (!existsSync(approvalPath)) atomicWrite(approvalPath, JSON.stringify({ version: 1, approvals: [] }));

    // Import the adapter source Pi loads, not the built dist: project-
    // server-trust.js has no standalone entry and the hash function must stay
    // in lockstep with the adapter that applies it.
    const { loadMcpConfig } = await import(pathToFileURL(join(adapter, 'config.ts')).href);
    const { approveProjectServer } = await import(
      pathToFileURL(join(adapter, 'project-server-trust.ts')).href) as {
        approveProjectServer: (cwd: string, serverName: string, definition: unknown) => void;
      };

    const config = withEnvironment(env, () => loadMcpConfig(undefined, cwd));
    const metadata = (config as { [key: symbol]: { projectServers: Map<string, { path: string }> } })[
      Symbol.for('pi-mcp-adapter/config-source-metadata')];
    const projectServers: string[] = [];
    for (const [name, source] of metadata?.projectServers ?? new Map<string, { path: string }>()) {
      projectServers.push(name);
      const definition = (config.mcpServers as Record<string, unknown> | undefined)?.[name];
      if (typeof definition !== 'object' || definition === null || !shouldApprove(name, definition)) continue;
      withEnvironment(env, () => approveProjectServer(cwd, name, definition));
      log(`approved project MCP server "${name}" from ${source.path}`);
    }
    const unapproved = projectServers.filter((name) => !BOARD_SERVERS.has(name));
    if (metadata && unapproved.length > 0) {
      log(`project MCP servers pending interactive approval: ${unapproved.join(', ')}`);
    }
  } catch (error) {
    log(`skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shouldApprove(name: string, definition: unknown): boolean {
  if (!BOARD_SERVERS.has(name)) return false;
  const value = definition as Record<string, unknown>;
  if (typeof value.command === 'string') return false;
  if (typeof value.url === 'string' && value.url.includes(BOARD_SYNC_MARKER)) return true;
  if (value.headers !== undefined) {
    // The board-synced file may carry a Bearer ${CARAPA_BOARD_API_TOKEN}
    // header the adapter expands from the run environment; approve the relay
    // URL or the token-bearing variant only.
    return JSON.stringify(value.headers).includes('CARAPA_BOARD_API_TOKEN');
  }
  // directTools-only entry (no transport of its own) never needs an approval.
  return value.directTools !== undefined;
}

// Use the adapter Pi will load. carapa-harness-exec adds its own copy only when settings.json does
// not already configure the package; otherwise Pi runs the installed one.
function adapterDirectory(env: Env, agentDir: string): string | undefined {
  try {
    const raw = readFileSyncSafe(join(agentDir, 'settings.json'));
    const packages: unknown[] = raw ? (JSON.parse(raw).packages ?? []) : [];
    const configured = packages.some((p) => /(^|\/|npm:)pi-mcp-adapter(@[^/]+)?\/?$/.test(
      typeof p === 'string' ? p : String((p as { source?: string }).source ?? '')));
    const installed = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter');
    if (configured && existsSync(join(installed, 'config.ts'))) return installed;
  } catch { /* no settings.json: Pi uses the harness copy */ }
  if (env.CARAPA_PI_MCP_ADAPTER) return env.CARAPA_PI_MCP_ADAPTER;
  const store = env.CARAPA_HARNESS_STORE || '/opt/carapa-harness-store';
  const selected = env.CARAPA_HARNESS_SNAPSHOT || readFileSync(join(store, 'current'), 'utf8').trim();
  const snapshot = JSON.parse(readFileSync(join(store, 'snapshots', `${selected}.json`), 'utf8'));
  for (const entry of Object.values<{ env?: Env }>(snapshot.entries ?? {})) {
    if (entry.env?.CARAPA_PI_MCP_ADAPTER) return entry.env.CARAPA_PI_MCP_ADAPTER;
  }
  return undefined;
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
