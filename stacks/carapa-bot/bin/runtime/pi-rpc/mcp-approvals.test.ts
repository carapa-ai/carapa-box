import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectMcpApprovals } from './mcp-approvals';

const root = mkdtempSync(join(tmpdir(), 'mcp-approvals-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Minimal stand-in for pi-mcp-adapter: loadMcpConfig reads the project's
// .mcp.json and tags the config with the same config-source-metadata symbol
// (projectServers map), and approveProjectServer persists the same store the
// real one writes under PI_CODING_AGENT_DIR.
const adapter = join(root, 'adapter');
mkdirSync(adapter, { recursive: true });
writeFileSync(join(adapter, 'config.ts'), `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const loadMcpConfig = (_overridePath, cwd) => {
  const projectFile = join(cwd, '.mcp.json');
  const mcpServers = existsSync(projectFile)
    ? (JSON.parse(readFileSync(projectFile, 'utf8')).mcpServers ?? {})
    : {};
  const projectServers = new Map(Object.keys(mcpServers).map((name) => [name, { path: projectFile }]));
  const config = { mcpServers, settings: {} };
  Object.defineProperty(config, Symbol.for('pi-mcp-adapter/config-source-metadata'), {
    value: { projectServers, projectServerPolicy: 'ask' },
  });
  return config;
};`);
writeFileSync(join(adapter, 'project-server-trust.ts'), `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const hashProjectServerDefinition = () => 'hash';
export const approveProjectServer = (cwd, serverName) => {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || join(process.env.HOME || '/home/ubuntu', '.pi', 'agent');
  const path = join(agentDir, 'mcp-project-approvals.json');
  const store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, approvals: [] };
  store.approvals = (store.approvals ?? []).filter(
    (e) => !(e.projectRoot === cwd && e.serverName === serverName));
  store.approvals.push({ projectRoot: cwd, serverName, definitionHash: 'hash', approvedAt: 'test' });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
};`);
const projectMcpJson = (project: string, servers: Record<string, unknown>) => {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
};

function agentDir(name: string, approvals?: { version: number; approvals: unknown[] }): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: [] }));
  if (approvals) writeFileSync(join(dir, 'mcp-project-approvals.json'),
    JSON.stringify(approvals, null, 2));
  return dir;
}

function store(name: string, adapterPath: string): Record<string, string> {
  const dir = join(root, `store-${name}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(dir, 'current'), 'snap1');
  writeFileSync(join(dir, 'snapshots', 'snap1.json'), JSON.stringify({
    entries: { pi: { env: { CARAPA_PI_MCP_ADAPTER: adapterPath } } },
  }));
  return { CARAPA_HARNESS_STORE: dir };
}

describe('ensureProjectMcpApprovals', () => {
  test('records an approval for the board relay project server only', async () => {
    const dir = agentDir('agent-a');
    const project = join(root, 'proj-a');
    projectMcpJson(project, {
      'carapa-board': { url: 'http://api-relay:8080/mcp-relay/mcp/carapa-board' },
      rogue: { command: 'curl', args: ['http://evil.example'] },
    });
    const log: string[] = [];
    await ensureProjectMcpApprovals({ HOME: root, PI_CODING_AGENT_DIR: dir, ...store('a', adapter) },
      project, (line) => log.push(line));

    // The fake approveProjectServer persists to the same store file the real
    // adapter writes; only the board relay server may land there — the project
    // command server keeps the adapter's interactive-approval behavior.
    const storeJson = JSON.parse(readFileSync(join(dir, 'mcp-project-approvals.json'), 'utf8'));
    expect(storeJson.version).toBe(1);
    expect(storeJson.approvals.map((a: { serverName: string }) => a.serverName)).toEqual(['carapa-board']);
    expect(storeJson.approvals[0].projectRoot).toBe(project);
    expect(log).toContain(`approved project MCP server "carapa-board" from ${join(project, '.mcp.json')}`);
    expect(log.some((l) => l.includes('pending interactive approval: rogue'))).toBe(true);
  });

  test('is a no-op for runs with no project servers', async () => {
    const dir = agentDir('agent-b', { version: 1, approvals: [{ projectRoot: '/x', serverName: 'n' }] });
    const existing = readFileSync(join(dir, 'mcp-project-approvals.json'), 'utf8');
    const log: string[] = [];
    // proj-b has no .mcp.json: nothing to approve.
    await ensureProjectMcpApprovals({ HOME: root, PI_CODING_AGENT_DIR: dir, ...store('b', adapter) },
      join(root, 'proj-b'), (line) => log.push(line));
    expect(readFileSync(join(dir, 'mcp-project-approvals.json'), 'utf8')).toBe(existing);
    expect(log).toEqual([]);
  });

  test('leaves the store untouched when the adapter cannot be loaded', async () => {
    const dir = agentDir('agent-c');
    const before = JSON.stringify({ version: 1, approvals: [] });
    writeFileSync(join(dir, 'mcp-project-approvals.json'), before);
    const log: string[] = [];
    await ensureProjectMcpApprovals({ HOME: root, PI_CODING_AGENT_DIR: dir, ...store('c', join(root, 'missing')) },
      join(root, 'proj-c'), (line) => log.push(line));
    expect(readFileSync(join(dir, 'mcp-project-approvals.json'), 'utf8')).toBe(before);
    expect(log[0]).toStartWith('skipped:');
  });

  test('seeds the store then records the approval when none existed', async () => {
    const dir = join(root, 'agent-d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: [] }));
    const project = join(root, 'proj-d');
    projectMcpJson(project, { 'carapa-board': { url: 'http://api-relay:8080/mcp-relay/mcp/carapa-board' } });
    const log: string[] = [];
    await ensureProjectMcpApprovals({ HOME: root, PI_CODING_AGENT_DIR: dir, ...store('d', adapter) },
      project, (line) => log.push(line));
    expect(existsSync(join(dir, 'mcp-project-approvals.json'))).toBe(true);
    const seed = JSON.parse(readFileSync(join(dir, 'mcp-project-approvals.json'), 'utf8'));
    expect(seed.version).toBe(1);
    expect(seed.approvals.map((a: { serverName: string }) => a.serverName)).toEqual(['carapa-board']);
  });
});
