import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../files';

type Env = Record<string, string | undefined>;

/**
 * pi-mcp-adapter registers `directTools` at startup only from a metadata cache entry whose hash
 * matches the server definition, and that hash expands `${CARAPA_BOARD_API_TOKEN}` from the
 * environment. Board mints a new token per run, so every fresh Pi process would see a stale cache
 * and fall back to the `mcp` gateway. Re-key the entry to this run's hash before Pi starts.
 * Best effort: any failure leaves the cache untouched, which is the pre-existing behavior.
 */
export async function rekeyMcpCache(
  env: Env, cwd: string, log: (line: string) => void,
): Promise<void> {
  try {
    const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME || '/home/ubuntu', '.pi', 'agent');
    const cachePath = join(agentDir, 'mcp-cache.json');
    if (!existsSync(cachePath)) return log('no metadata cache yet');
    const adapter = adapterDirectory(env, agentDir);
    if (!adapter) return log('pi-mcp-adapter not found');

    const { loadMcpConfig } = await import(pathToFileURL(join(adapter, 'config.ts')).href);
    const { computeServerHash } = await import(pathToFileURL(join(adapter, 'metadata-cache.ts')).href);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));

    let changed = false;
    withEnvironment(env, () => {
      const config = loadMcpConfig(undefined, cwd);
      for (const [name, definition] of Object.entries<Record<string, unknown>>(config.mcpServers ?? {})) {
        const direct = definition.directTools !== undefined ? definition.directTools : config.settings?.directTools;
        const entry = cache.servers?.[name];
        if (!direct || !entry) continue;
        const hash = computeServerHash(definition, env);
        if (entry.configHash === hash) continue;
        log(`rekeyed ${name} ${String(entry.configHash).slice(0, 8)} -> ${hash.slice(0, 8)}`);
        entry.configHash = hash;
        changed = true;
      }
    });
    if (changed) atomicWrite(cachePath, JSON.stringify(cache));
    else log('cache already current');
  } catch (error) {
    log(`skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Older adapters hash from process.env and ignore an environment argument.
export function withEnvironment<T>(env: Env, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// Use the adapter Pi will load. carapa-harness-exec adds its own copy only when settings.json does
// not already configure the package; otherwise Pi runs the installed one.
function adapterDirectory(env: Env, agentDir: string): string | undefined {
  try {
    const packages: unknown[] = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).packages ?? [];
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
