import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rekeyMcpCache } from './mcp-cache';

const root = mkdtempSync(join(tmpdir(), 'mcp-cache-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Minimal stand-in for pi-mcp-adapter: one server with directTools, one without; the hash
// depends on the run token like the real one (read from process.env, as older adapters do).
const adapter = join(root, 'adapter');
mkdirSync(adapter);
writeFileSync(join(adapter, 'config.ts'), `export const loadMcpConfig = () => ({
  mcpServers: { board: { directTools: ['memorize'] }, other: {} } });`);
writeFileSync(join(adapter, 'metadata-cache.ts'),
  'export const computeServerHash = () => `hash:${process.env.TOKEN}`;');

function agentDir(name: string, servers: Record<string, unknown>): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'mcp-cache.json'), JSON.stringify({ version: 1, servers }));
  return dir;
}

describe('rekeyMcpCache', () => {
  test('re-keys only direct-tool servers to the current run hash', async () => {
    const dir = agentDir('agent-a', {
      board: { configHash: 'hash:old', tools: [{ name: 'memorize' }] },
      other: { configHash: 'hash:old' },
    });
    const log: string[] = [];
    await rekeyMcpCache({ HOME: root, PI_CODING_AGENT_DIR: dir, CARAPA_PI_MCP_ADAPTER: adapter, TOKEN: 'new' },
      root, (line) => log.push(line));

    const cache = JSON.parse(readFileSync(join(dir, 'mcp-cache.json'), 'utf8'));
    expect(cache.servers.board).toEqual({ configHash: 'hash:new', tools: [{ name: 'memorize' }] });
    expect(cache.servers.other.configHash).toBe('hash:old');
    expect(log).toEqual(['rekeyed board hash:old -> hash:new']);
    expect(process.env.TOKEN).toBeUndefined();
  });

  test('leaves the cache untouched when the adapter cannot be loaded', async () => {
    const dir = agentDir('agent-b', { board: { configHash: 'hash:old' } });
    const before = readFileSync(join(dir, 'mcp-cache.json'), 'utf8');
    const log: string[] = [];
    await rekeyMcpCache({ HOME: root, PI_CODING_AGENT_DIR: dir, CARAPA_PI_MCP_ADAPTER: join(root, 'missing'), TOKEN: 'new' },
      root, (line) => log.push(line));

    expect(readFileSync(join(dir, 'mcp-cache.json'), 'utf8')).toBe(before);
    expect(log[0]).toStartWith('skipped:');
  });
});
