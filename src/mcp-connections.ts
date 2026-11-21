import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEgressProxyDir } from './config.js';
// @ts-ignore -- plain Node module shared with the standalone relay
import { configuredMcpOAuthServices } from '../egress-proxy/api-relay/mcp-oauth.mjs';
// @ts-ignore -- plain Node module shared with the standalone relay
import { readRelayConfigs } from '../egress-proxy/api-relay/api-relay.mjs';

type ServiceConfig = { url: string; projects: string[] };
type Target = { service: string; project: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_PENDING = 16;
const ATTEMPT_TTL_MS = 15 * 60_000;
const IN_FLIGHT_STATES = ['starting', 'awaitingCallback'];
const PUBLIC_ATTEMPT_STATES = [...IN_FLIGHT_STATES, 'failed'];
const ERROR_CODE = /^[a-z_]{1,64}$/;
const PROJECT_STATES = ['connected', 'loginRequired', 'refreshFailed'];

function writePrivate(file: string, value: unknown) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

function readPrivate(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Box side of the relay's MCP OAuth file protocol under <PROVIDER_ACCOUNTS_DIR>/mcp.
 * Box only writes request.json / callback.json / revoke.json inside attempts and
 * never reads credentials, so tokens cannot reach Board.
 */
export class McpConnections {
  constructor(private options: { directory: string; clientsDirectory: string }) {}

  private root() {
    if (!path.isAbsolute(this.options.directory)) throw new Error('MCP connections are not configured');
    for (const child of ['', 'mcp', 'mcp/attempts']) {
      const target = path.join(this.options.directory, child);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('MCP connection directory cannot be a symlink');
      fs.chmodSync(target, 0o700);
    }
    return path.join(this.options.directory, 'mcp');
  }

  private services(): Map<string, ServiceConfig> {
    const { clients, defaults } = readRelayConfigs(this.options.clientsDirectory);
    return configuredMcpOAuthServices(defaults, clients);
  }

  private target(input: unknown): Target {
    const { service, project } = (input && typeof input === 'object' ? input : {}) as Partial<Target>;
    const config = typeof service === 'string' ? this.services().get(service) : undefined;
    if (!config || typeof project !== 'string' || !config.projects.includes(project)) throw new Error('Unknown MCP service or project');
    return { service: service as string, project };
  }

  private attemptDirectory(id: unknown, root: string) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid login ID');
    const dir = path.join(root, 'attempts', id);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Unknown login');
    return dir;
  }

  private attemptIds(root: string) {
    return fs.readdirSync(path.join(root, 'attempts')).filter(id => UUID.test(id));
  }

  /** Login attempts Board can see (not revoke intents), with their relay-reported state. */
  private attempts(root: string) {
    const attempts = [];
    for (const id of this.attemptIds(root)) {
      const dir = path.join(root, 'attempts', id);
      const request = readPrivate(path.join(dir, 'request.json'));
      if (!request || fs.existsSync(path.join(dir, 'revoke.json'))) continue;
      const status = readPrivate(path.join(dir, 'status.json'));
      const state = status ? status.state : 'starting';
      if (typeof state !== 'string' || !PUBLIC_ATTEMPT_STATES.includes(state)) continue;
      attempts.push({ id, dir, request, status, state });
    }
    return attempts;
  }

  list() {
    const root = this.root();
    const services = [...this.services()].map(([service, config]) => ({
      service, host: new URL(config.url).hostname,
      projects: config.projects.map(project => {
        const state = readPrivate(path.join(root, 'status', `${service}--${project}.json`))?.state;
        return { project, state: PROJECT_STATES.includes(state as string) ? state : 'loginRequired' };
      }),
    }));
    const logins = this.attempts(root).map(({ id, dir, request, status, state }) => {
      // Whitelist public fields; the relay's attempt files never export secrets here.
      let authorizationUrl: string | undefined;
      if (typeof status?.authorizationUrl === 'string') {
        try { authorizationUrl = new URL(status.authorizationUrl).protocol === 'https:' ? status.authorizationUrl : undefined; } catch { /* Not a URL. */ }
      }
      const expiresAt = typeof status?.expiresAt === 'number' ? status.expiresAt : fs.lstatSync(dir).mtimeMs + ATTEMPT_TTL_MS;
      // Only the relay's short error codes are public; anything else could carry upstream text.
      const error = state === 'failed' && typeof status?.error === 'string' && ERROR_CODE.test(status.error) ? status.error : undefined;
      return { id, service: request.service, project: request.project, state, authorizationUrl, expiresAt, error };
    });
    return { services, logins };
  }

  start(input: unknown) {
    const target = this.target(input);
    const root = this.root();
    // Finished, failed or revoked attempts linger for the relay's TTL; only in-flight ones block.
    const inFlight = this.attempts(root).filter(a => IN_FLIGHT_STATES.includes(a.state));
    if (inFlight.length >= MAX_PENDING) throw new Error('Too many pending logins');
    if (inFlight.some(a => a.request.service === target.service && a.request.project === target.project)) {
      throw new Error('Cancel the existing login before starting another');
    }
    return { id: this.publish(root, { 'request.json': target }) };
  }

  /** Builds the attempt privately, then renames it in so the relay never sees a partial one. */
  private publish(root: string, files: Record<string, unknown>) {
    const id = crypto.randomUUID();
    const staging = path.join(root, 'attempts', '.new-' + id);
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      for (const [name, value] of Object.entries(files)) writePrivate(path.join(staging, name), value);
      fs.renameSync(staging, path.join(root, 'attempts', id));
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    return id;
  }

  complete(id: string, value: unknown) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error('Invalid callback value');
    const dir = this.attemptDirectory(id, this.root());
    if (fs.existsSync(path.join(dir, 'revoke.json')) || fs.existsSync(path.join(dir, 'callback.json')) ||
        readPrivate(path.join(dir, 'status.json'))?.state !== 'awaitingCallback') throw new Error('Login is not waiting for input');
    writePrivate(path.join(dir, 'callback.json'), { value });
    return { ok: true };
  }

  cancel(id: string) {
    fs.rmSync(this.attemptDirectory(id, this.root()), { recursive: true, force: true });
    return { ok: true };
  }

  revoke(input: unknown) {
    const target = this.target(input);
    this.publish(this.root(), { 'request.json': target, 'revoke.json': {} });
    return { ok: true };
  }
}

let instance: McpConnections | undefined;
export function configuredMcpConnections() {
  const directory = process.env.PROVIDER_ACCOUNTS_DIR;
  if (!directory) throw new Error('MCP connections are not configured in CarapaBox');
  return instance ||= new McpConnections({ directory,
    clientsDirectory: process.env.PROVIDER_RELAY_CLIENTS_DIR || path.join(getEgressProxyDir(), 'relay-clients') });
}
