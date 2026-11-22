/**
 * Generic OAuth 2.1 client for operator-allowlisted REMOTE MCP servers
 * (MCP authorization spec: RFC 9728 PRM, RFC 8414 AS metadata, RFC 7591 DCR,
 * PKCE S256, RFC 8707 resource). Tokens live only in the relay, per
 * (service, project). The HTTP `request` is injected; api-relay supplies one
 * that goes through Squid with TLS verification.
 *
 * request({ method, url, headers, payload, format }) -> { status, headers, body }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { credentialText, parseCredentialText } from './credential-crypto.mjs';

export const MCP_AUTH = 'mcp-oauth';
const RESERVED_SERVICE_NAMES = ['anthropic', 'anthropic-api', 'codex', 'google', 'antigravity', 'openai', 'openrouter', 'nvidia',
  'meta', 'xai', 'muse-code', 'mcp-relay', 'board-api'];
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const ATTEMPT_TTL_MS = 15 * 60_000;
const REFRESH_BEFORE_MS = 60_000;
// Matches Box MAX_PENDING; per (service, project) at most 2 login attempts run at once.
const MAX_IN_FLIGHT = 16;
const MAX_PROJECT_IN_FLIGHT = 2;
// One project holds at most 4 in-flight attempts across all services, and sandboxes never take the
// last 4 global slots, which stay free for Box/admin-started logins.
const MAX_PROJECT_TOTAL_IN_FLIGHT = 4;
const ADMIN_RESERVED_SLOTS = 4;
const SAFE_NAME = /^[\w-]+$/;
const DNS_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

class McpOAuthError extends Error {
  constructor(code, { terminal = false } = {}) {
    super(code);
    this.code = code;
    this.terminal = terminal;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

/** Lower-cased DNS host or null: no IP literal, localhost, host.docker.internal, *.internal, *.local. */
function dnsHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.toLowerCase();
  if (!DNS_HOST.test(host) || host === 'host.docker.internal' || host.endsWith('.internal') || host.endsWith('.local')) return null;
  return host;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.includes('#')) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.hash) return null;
  return url;
}

function validRedirectUri(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
}

/** Throws on an invalid service definition; returns the normalised config. */
export function validateMcpOAuthConfig(name, config) {
  const invalid = () => new Error('Invalid mcp-oauth service configuration');
  if (!SAFE_NAME.test(name) || name.includes('--') || RESERVED_SERVICE_NAMES.includes(name)) throw invalid();
  const url = httpsUrl(config.url);
  if (!url || !dnsHost(url.hostname)) throw invalid();
  if (!Array.isArray(config.projects) || !config.projects.length ||
      config.projects.some(project => typeof project !== 'string' || !SAFE_NAME.test(project))) throw invalid();
  const authHosts = config.authHosts === undefined ? [] : config.authHosts;
  if (!Array.isArray(authHosts) || authHosts.some(host => !dnsHost(host))) throw invalid();
  if (config.clientId !== undefined && (typeof config.clientId !== 'string' || !config.clientId)) throw invalid();
  if (config.clientSecretEnv !== undefined && (typeof config.clientSecretEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(config.clientSecretEnv))) throw invalid();
  if (config.clientSecretEnv !== undefined && config.clientId === undefined) throw invalid();
  if (config.redirectUri !== undefined && !validRedirectUri(config.redirectUri)) throw invalid();
  if (['host', 'port', 'protocol', 'pathPrefix'].some(key => config[key] !== undefined)) throw invalid();
  if (config.scopes !== undefined && (!Array.isArray(config.scopes) || config.scopes.some(scope => typeof scope !== 'string' || !scope || /\s/.test(scope)))) throw invalid();
  return { ...config, name, redirectUri: config.redirectUri || DEFAULT_REDIRECT_URI, authHosts: authHosts.map(host => host.toLowerCase()) };
}

/** name -> normalised config for every mcp-oauth service across defaults and clients. */
export function configuredMcpOAuthServices(defaults, clients) {
  const services = new Map();
  for (const client of [defaults, ...clients]) {
    for (const [name, config] of Object.entries(client?.services || {})) {
      if (config.auth !== MCP_AUTH) continue;
      const normalised = validateMcpOAuthConfig(name, config);
      const existing = services.get(name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(normalised)) throw new Error('Conflicting mcp-oauth service definitions');
      services.set(name, normalised);
    }
  }
  return services;
}

const trustedHosts = config => new Set([new URL(config.url).hostname, ...(config.authHosts || [])]);

function trustedUrl(value, config) {
  const url = httpsUrl(value);
  if (!url || !trustedHosts(config).has(url.hostname)) throw new McpOAuthError('untrusted_metadata_host');
  return url;
}

// ── Discovery ───────────────────────────────────────────────────────────────

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'CarapaBox relay', version: '1' } } };

function parseChallenge(header) {
  const values = {};
  if (typeof header !== 'string') return values;
  for (const [, key, quoted, bare] of header.matchAll(/([\w-]+)=(?:"([^"]*)"|([^\s,]+))/g)) values[key.toLowerCase()] ??= quoted ?? bare;
  return values;
}

const getJson = async (request, url) => {
  const response = await request({ method: 'GET', url, headers: { accept: 'application/json' } });
  return response.status === 200 && response.body && typeof response.body === 'object' && !Array.isArray(response.body) ? response.body : null;
};

async function fetchProtectedResource(config, challenge, request) {
  const resource = new URL(config.url);
  const path = resource.pathname === '/' ? '' : resource.pathname;
  const candidates = [];
  if (challenge.resource_metadata) candidates.push(trustedUrl(challenge.resource_metadata, config).href);
  for (const candidate of [`${resource.origin}/.well-known/oauth-protected-resource${path}`, `${resource.origin}/.well-known/oauth-protected-resource`]) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  const wanted = resource.href;
  let covering = null;
  let fetched = false;
  for (const candidate of candidates) {
    const body = await getJson(request, candidate).catch(() => null);
    if (!body) continue;
    fetched = true;
    let advertised;
    try { advertised = new URL(body.resource); } catch { continue; }
    if (advertised.href === wanted) return { prm: body, resource: advertised.href };
    // A document for a parent path (e.g. a root-only server) covers the MCP URL on a `/` segment boundary.
    const base = advertised.pathname.replace(/\/+$/, '');
    if (!covering && advertised.origin === resource.origin && !advertised.search && !advertised.hash &&
        resource.pathname.startsWith(`${base}/`)) covering = { prm: body, resource: advertised.href };
  }
  if (covering) return covering;
  throw new McpOAuthError(fetched ? 'resource_mismatch' : 'protected_resource_metadata_unavailable');
}

async function fetchAuthorizationServer(issuerValue, config, request) {
  const issuer = trustedUrl(issuerValue, config);
  if (issuer.search || issuer.hash) throw new McpOAuthError('invalid_metadata');
  const path = issuer.pathname === '/' ? '' : issuer.pathname;
  const candidates = [`${issuer.origin}/.well-known/oauth-authorization-server${path}`, `${issuer.origin}/.well-known/openid-configuration${path}`];
  if (path) candidates.push(`${issuer.origin}${path}/.well-known/openid-configuration`);
  for (const candidate of candidates) {
    const meta = await getJson(request, candidate).catch(() => null);
    if (!meta) continue;
    if (meta.issuer !== issuerValue) throw new McpOAuthError('issuer_mismatch');
    return meta;
  }
  return null;
}

export async function discover(config, { request }) {
  const probe = await request({ method: 'POST', url: config.url, payload: INITIALIZE, format: 'json',
    headers: { accept: 'application/json, text/event-stream' } }).catch(() => null);
  const challenge = probe?.status === 401 ? parseChallenge(probe.headers?.['www-authenticate']) : {};
  const { prm, resource } = await fetchProtectedResource(config, challenge, request);
  if (!Array.isArray(prm.authorization_servers) || !prm.authorization_servers.length ||
      prm.authorization_servers.some(issuer => typeof issuer !== 'string')) throw new McpOAuthError('invalid_metadata');
  for (const issuer of prm.authorization_servers) trustedUrl(issuer, config);
  for (const issuer of prm.authorization_servers) {
    const meta = await fetchAuthorizationServer(issuer, config, request);
    if (!meta) continue;
    const endpoint = key => meta[key] === undefined ? undefined : trustedUrl(meta[key], config).href;
    const authorizationEndpoint = endpoint('authorization_endpoint');
    const tokenEndpoint = endpoint('token_endpoint');
    if (!authorizationEndpoint || !tokenEndpoint) throw new McpOAuthError('invalid_metadata');
    const registrationEndpoint = endpoint('registration_endpoint');
    const revocationEndpoint = endpoint('revocation_endpoint');
    if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes('S256')) {
      throw new McpOAuthError('pkce_s256_unsupported');
    }
    const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    return { issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint,
      tokenAuthMethods: strings(meta.token_endpoint_auth_methods_supported),
      resource, challengeScope: challenge.scope, scopesSupported: strings(prm.scopes_supported) };
  }
  throw new McpOAuthError('authorization_server_metadata_unavailable');
}

// ── Registration ────────────────────────────────────────────────────────────

function secretAuthMethod(methods) {
  if (!methods.length || methods.includes('client_secret_basic')) return 'client_secret_basic';
  return methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
}

export async function register(asMeta, config, { request, readSecret = () => '' }) {
  if (config.clientId) {
    const clientSecret = config.clientSecretEnv ? readSecret(config.clientSecretEnv) : '';
    if (config.clientSecretEnv && !clientSecret) throw new McpOAuthError('client_secret_missing');
    return { clientId: config.clientId, ...(clientSecret ? { clientSecret, authMethod: secretAuthMethod(asMeta.tokenAuthMethods || []) } : { authMethod: 'none' }) };
  }
  if (!asMeta.registrationEndpoint) throw new McpOAuthError('client_registration_unavailable');
  const response = await request({ method: 'POST', url: trustedUrl(asMeta.registrationEndpoint, config).href, format: 'json',
    headers: { accept: 'application/json' }, payload: {
      redirect_uris: [config.redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], client_name: 'CarapaBox relay' } });
  const body = response.body;
  if (![200, 201].includes(response.status) || typeof body?.client_id !== 'string' || !body.client_id) throw new McpOAuthError('client_registration_failed');
  const clientSecret = typeof body.client_secret === 'string' && body.client_secret ? body.client_secret : '';
  const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method
    : clientSecret ? 'client_secret_basic' : 'none';
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) throw new McpOAuthError('client_registration_failed');
  return { clientId: body.client_id, ...(clientSecret ? { clientSecret } : {}), authMethod };
}

// ── Authorization request and token endpoint ────────────────────────────────

export function authorizationRequest({ config, asMeta, client }) {
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const scope = (config.scopes?.length ? config.scopes.join(' ') : '') || asMeta.challengeScope || (asMeta.scopesSupported || []).join(' ');
  const url = trustedUrl(asMeta.authorizationEndpoint, config);
  const params = { response_type: 'code', client_id: client.clientId, redirect_uri: config.redirectUri, state,
    code_challenge: challenge, code_challenge_method: 'S256', resource: asMeta.resource ?? config.url, ...(scope ? { scope } : {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { authorizationUrl: url.href, state, verifier, scope };
}

/** Adds client authentication to a form payload / headers (RFC 6749 §2.3.1 form-encoded Basic). */
function clientAuth(client, payload, headers) {
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    const encode = value => encodeURIComponent(value).replace(/%20/g, '+');
    headers.authorization = 'Basic ' + Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString('base64');
  } else {
    payload.client_id = client.clientId;
    if (client.authMethod === 'client_secret_post' && client.clientSecret) payload.client_secret = client.clientSecret;
  }
}

async function tokenRequest(endpoint, client, params, config, resource, { request, now = Date.now }) {
  const payload = { ...params, resource: resource ?? config.url };
  const headers = { accept: 'application/json' };
  clientAuth(client, payload, headers);
  const response = await request({ method: 'POST', url: trustedUrl(endpoint, config).href, format: 'form', headers, payload });
  const body = response.body;
  if (response.status < 200 || response.status >= 300 || typeof body?.access_token !== 'string' || !body.access_token ||
      (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer')) {
    throw new McpOAuthError('token_request_rejected', { terminal: body?.error === 'invalid_grant' || response.status === 401 });
  }
  const seconds = Number(body.expires_in);
  return { accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : '',
    expiresAt: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : '' };
}

export function exchangeCode({ config, asMeta, client, code, verifier }, io) {
  return tokenRequest(asMeta.tokenEndpoint, client, { grant_type: 'authorization_code', code,
    redirect_uri: config.redirectUri, code_verifier: verifier }, config, asMeta.resource, io);
}

export async function refresh({ config, asMeta, client, refreshToken }, io) {
  const tokens = await tokenRequest(asMeta.tokenEndpoint, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, config, asMeta.resource, io);
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

/** RFC 7009. Best effort: never throws. */
async function revoke({ config, asMeta, client, token, hint = 'refresh_token' }, { request }) {
  if (!asMeta.revocationEndpoint || !token) return false;
  try {
    const headers = {};
    const payload = { token, token_type_hint: hint };
    clientAuth(client, payload, headers);
    const response = await request({ method: 'POST', url: trustedUrl(asMeta.revocationEndpoint, config).href, format: 'form', headers, payload });
    return response.status >= 200 && response.status < 300;
  } catch { return false; }
}

/** Returns the authorization code of a pasted loopback callback, or throws. */
export function validateCallback(value, redirectUri, state) {
  const mismatch = () => new McpOAuthError('callback_mismatch');
  if (typeof value !== 'string' || value.length > 16384) throw mismatch();
  let callback;
  try { callback = new URL(value); } catch { throw mismatch(); }
  const expected = new URL(redirectUri);
  const states = callback.searchParams.getAll('state');
  const codes = callback.searchParams.getAll('code');
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash ||
      states.length !== 1 || states[0] !== state || codes.length !== 1 || !codes[0] || callback.searchParams.has('error')) throw mismatch();
  return codes[0];
}

// ── Private file helpers (0600 files, 0700 directories, no symlinks) ────────

function ensureDir(directory, root) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpOAuthError('unsafe_path');
    if (current === root || current === path.dirname(current)) break;
  }
}

/** `secret` files (tokens, PKCE verifiers) are sealed when credential encryption is on. */
function writeJson(file, data, { secret = false } = {}) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  try {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new McpOAuthError('unsafe_path');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, secret ? credentialText(file, data) : JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function readJson(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return parseCredentialText(file, fs.readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ── Login processor and credential store ────────────────────────────────────

/**
 * Owns <accountsDir>/mcp. Box writes only request.json / callback.json /
 * revoke.json inside an attempt; the relay writes everything else.
 */
export function createMcpOAuthProcessor({ accountsDir, getServices, request: rawRequest, timeoutMs = 20_000, readSecret = () => '', now = Date.now,
  log = message => console.error(message), pollMs = 2000 }) {
  const root = path.join(accountsDir, 'mcp');
  const attemptsDir = path.join(root, 'attempts');
  const credentialsDir = path.join(root, 'credentials');
  const statusDir = path.join(root, 'status');
  // Every upstream call is bounded so a stalled endpoint becomes a normal failure.
  const request = options => rawRequest({ ...options, signal: AbortSignal.timeout(timeoutMs) });
  const io = { request, now };
  const busy = new Set();
  const locks = new Map();
  const failures = new Map();
  /**
   * Rotated credentials whose disk write failed, by key. `base` is the refresh token still on disk; the entry
   * is dropped as soon as the disk no longer holds it (new login, revoke) and retried on every read until saved.
   */
  const unsaved = new Map();
  let timer;

  const keyOf = (service, project) => `${service}--${project}`;
  const credentialFile = key => path.join(credentialsDir, key + '.json');
  const writeStatus = (key, state) => {
    ensureDir(statusDir, root);
    writeJson(path.join(statusDir, key + '.json'), { state, updatedAt: now() });
  };
  /** Informational status for the token-serving paths: a store that cannot be written must not turn into a 502. */
  const writeStatusBestEffort = (key, state) => {
    try { writeStatus(key, state); }
    catch (error) { log('[relay] mcp-oauth status write failed for ' + key + ': ' + (error?.code || 'internal_error')); }
  };
  const allowed = (service, project) => {
    const config = getServices().get(service);
    return config && typeof project === 'string' && config.projects.includes(project) ? config : null;
  };

  async function startLogin(dir, request_) {
    const config = allowed(request_.service, request_.project);
    if (!config) throw new McpOAuthError('project_not_allowed');
    const asMeta = await discover(config, io);
    const client = await register(asMeta, config, { ...io, readSecret });
    const auth = authorizationRequest({ config, asMeta, client });
    const expiresAt = now() + ATTEMPT_TTL_MS;
    const { authorizationUrl, state, verifier } = auth;
    writeJson(path.join(dir, 'attempt-secret.json'), { service: request_.service, project: request_.project, state, verifier, client, asMeta, expiresAt }, { secret: true });
    writeJson(path.join(dir, 'status.json'), { state: 'awaitingCallback', authorizationUrl, expiresAt });
  }

  async function finishLogin(dir, secret, callbackValue) {
    const config = allowed(secret.service, secret.project);
    if (!config) throw new McpOAuthError('project_not_allowed');
    const code = validateCallback(callbackValue, config.redirectUri, secret.state);
    const tokens = await exchangeCode({ config, asMeta: secret.asMeta, client: secret.client, code, verifier: secret.verifier }, io);
    const key = keyOf(secret.service, secret.project);
    ensureDir(credentialsDir, root);
    writeJson(credentialFile(key), { service: secret.service, project: secret.project, url: config.url, asMeta: secret.asMeta,
      client: secret.client, ...tokens, updatedAt: now() }, { secret: true });
    failures.delete(key);
    writeStatus(key, 'connected');
    fs.rmSync(path.join(dir, 'attempt-secret.json'), { force: true });
  }

  async function revokeCredential(service, project) {
    const config = allowed(service, project);
    if (!config) throw new McpOAuthError('project_not_allowed');
    const key = keyOf(service, project);
    const credential = currentCredential(key);
    if (credential?.url === config.url && credential.asMeta && credential.client) {
      const args = { config, asMeta: credential.asMeta, client: credential.client };
      if (credential.refreshToken) await revoke({ ...args, token: credential.refreshToken }, io);
      await revoke({ ...args, token: credential.accessToken, hint: 'access_token' }, io);
    }
    fs.rmSync(credentialFile(key), { force: true });
    unsaved.delete(key);
    failures.delete(key);
    writeStatus(key, 'loginRequired');
  }

  const fail = (dir, error) => {
    log('[relay] mcp-oauth attempt failed: ' + (error?.code || 'internal_error'));
    writeJson(path.join(dir, 'status.json'), { state: 'failed', error: error?.code || 'internal_error', expiresAt: now() + ATTEMPT_TTL_MS });
  };

  async function processAttempt(id) {
    const dir = path.join(attemptsDir, id);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    const status = readJson(path.join(dir, 'status.json'));
    if (status && now() >= Number(status.expiresAt)) { fs.rmSync(dir, { recursive: true, force: true }); return; }
    if (!status && now() - stat.mtimeMs > ATTEMPT_TTL_MS) { fs.rmSync(dir, { recursive: true, force: true }); return; }
    const request_ = readJson(path.join(dir, 'request.json'));
    if (fs.existsSync(path.join(dir, 'revoke.json')) && status?.state !== 'revoked') {
      try {
        await revokeCredential(request_?.service, request_?.project);
        writeJson(path.join(dir, 'status.json'), { state: 'revoked', expiresAt: now() + ATTEMPT_TTL_MS });
      } catch (error) { fail(dir, error); }
      fs.rmSync(path.join(dir, 'revoke.json'), { force: true });
      return;
    }
    if (!status) {
      if (!request_) return;
      try { await startLogin(dir, request_); } catch (error) { fail(dir, error); }
      return;
    }
    const callbackFile = path.join(dir, 'callback.json');
    if (status.state !== 'awaitingCallback' || !fs.existsSync(callbackFile)) return;
    const callback = readJson(callbackFile);
    const secret = readJson(path.join(dir, 'attempt-secret.json'));
    fs.rmSync(callbackFile, { force: true });
    try {
      if (!callback || !secret) throw new McpOAuthError('callback_mismatch');
      await finishLogin(dir, secret, callback.value);
      writeJson(path.join(dir, 'status.json'), { state: 'connected', expiresAt: now() + ATTEMPT_TTL_MS });
    } catch (error) {
      fs.rmSync(path.join(dir, 'attempt-secret.json'), { force: true });
      fail(dir, error);
    }
  }

  async function scan() {
    ensureDir(attemptsDir, root);
    ensureDir(credentialsDir, root);
    for (const entry of fs.readdirSync(attemptsDir, { withFileTypes: true })) {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(id) || busy.has(id)) continue;
      busy.add(id);
      try { await processAttempt(id); }
      catch (error) { log('[relay] mcp-oauth attempt error: ' + (error?.code || 'internal_error')); }
      finally { busy.delete(id); }
    }
  }

  const bearer = credential => ({ headers: { authorization: 'Bearer ' + credential.accessToken } });

  function persist(key, credential) {
    try {
      writeJson(credentialFile(key), credential, { secret: true });
      unsaved.delete(key);
      return true;
    } catch (error) {
      log('[relay] mcp-oauth credential write failed for ' + key + ': ' + (error?.code || 'internal_error'));
      return false;
    }
  }

  /** The credential in force: the unsaved rotated one (retrying its write) while the disk still holds its base. */
  function currentCredential(key) {
    const disk = readJson(credentialFile(key));
    const held = unsaved.get(key);
    if (!held) return disk;
    if (disk?.refreshToken !== held.base) { unsaved.delete(key); return disk; }
    persist(key, held.credential);
    return held.credential;
  }

  async function performRefresh(key, config, credential) {
    const signature = credential.refreshToken;
    const failure = failures.get(key);
    const valid = credential.expiresAt > now();
    if (failure?.signature === signature && failure.nextAttempt > now()) return valid ? bearer(credential) : null;
    try {
      const tokens = await refresh({ config, asMeta: credential.asMeta, client: credential.client, refreshToken: credential.refreshToken }, io);
      const latest = currentCredential(key);
      if (!latest || latest.refreshToken !== credential.refreshToken) return latest ? bearer(latest) : null;
      const next = { ...credential, ...tokens, updatedAt: now() };
      // The old refresh token is consumed upstream: a failed write must not discard the rotated tokens.
      if (!persist(key, next)) unsaved.set(key, { base: unsaved.get(key)?.base ?? credential.refreshToken, credential: next });
      failures.delete(key);
      writeStatusBestEffort(key, 'connected');
      return bearer(next);
    } catch (error) {
      const latest = currentCredential(key);
      if (latest && latest.refreshToken !== credential.refreshToken) return bearer(latest);
      const attempts = failure?.signature === signature ? failure.attempts + 1 : 1;
      failures.set(key, { signature, attempts, nextAttempt: now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6)) });
      log('[relay] mcp-oauth refresh failed for ' + key + ': ' + (error?.code || 'internal_error'));
      writeStatusBestEffort(key, error?.terminal ? 'loginRequired' : 'refreshFailed');
      return valid ? bearer(credential) : null;
    }
  }

  /** Bearer headers for (service, project), or null when login is required / unavailable. */
  async function getMcpAuth(service, project, { force = false } = {}) {
    const config = allowed(service, project);
    if (!config) return null;
    const key = keyOf(service, project);
    const credential = currentCredential(key);
    if (!credential || credential.url !== config.url || !credential.accessToken || !credential.asMeta || !credential.client) {
      writeStatusBestEffort(key, 'loginRequired');
      return null;
    }
    if (!force && credential.expiresAt - now() > REFRESH_BEFORE_MS) return bearer(credential);
    if (!credential.refreshToken) {
      if (credential.expiresAt > now()) return bearer(credential);
      writeStatusBestEffort(key, 'loginRequired');
      return null;
    }
    if (!locks.has(key)) locks.set(key, performRefresh(key, config, credential).finally(() => locks.delete(key)));
    return locks.get(key);
  }

  const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const SANDBOX_STATES = ['starting', 'awaitingCallback', 'failed', 'connected'];
  const IN_FLIGHT = ['starting', 'awaitingCallback'];
  const ERROR_CODE = /^[a-z_]{1,64}$/;

  /** Attempts (any project) that are not revoke intents or expired; state mirrors what Box lists. */
  function liveAttempts() {
    ensureDir(attemptsDir, root);
    const result = [];
    for (const id of fs.readdirSync(attemptsDir)) {
      if (!ATTEMPT_ID.test(id)) continue;
      const dir = path.join(attemptsDir, id);
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      const req = readJson(path.join(dir, 'request.json'));
      if (!req || fs.existsSync(path.join(dir, 'revoke.json'))) continue;
      const status = readJson(path.join(dir, 'status.json'));
      const expiresAt = Number(status?.expiresAt) || stat.mtimeMs + ATTEMPT_TTL_MS;
      if (expiresAt <= now()) continue;
      const state = status ? status.state : 'starting';
      if (!SANDBOX_STATES.includes(state)) continue;
      result.push({ id, dir, req, status, state, expiresAt });
    }
    return result;
  }

  const kick = () => { void scan().catch(() => log('[relay] mcp-oauth scan failed')); };

  /** Project status for (service, project): connected | loginRequired | refreshFailed. */
  function projectState(service, project) {
    const state = readJson(path.join(statusDir, keyOf(service, project) + '.json'))?.state;
    return ['connected', 'loginRequired', 'refreshFailed'].includes(state) ? state : 'loginRequired';
  }

  /** The project's own attempts for a service, reduced to public fields. */
  function listLogins(service, project) {
    return liveAttempts().filter(a => a.req.service === service && a.req.project === project).map(({ id, status, state, expiresAt }) => {
      const login = { id, state, expiresAt };
      if (typeof status?.authorizationUrl === 'string' && state === 'awaitingCallback') login.authorizationUrl = status.authorizationUrl;
      if (state === 'failed' && typeof status?.error === 'string' && ERROR_CODE.test(status.error)) login.error = status.error;
      return login;
    });
  }

  /** Starts a login attempt for an allowed (service, project); throws McpOAuthError on limits. */
  function createAttempt(service, project) {
    if (!allowed(service, project)) throw new McpOAuthError('project_not_allowed');
    const inFlight = liveAttempts().filter(a => IN_FLIGHT.includes(a.state));
    if (inFlight.filter(a => a.req.service === service && a.req.project === project).length >= MAX_PROJECT_IN_FLIGHT) {
      throw new McpOAuthError('login_in_progress');
    }
    if (inFlight.filter(a => a.req.project === project).length >= MAX_PROJECT_TOTAL_IN_FLIGHT) {
      throw new McpOAuthError('too_many_logins');
    }
    if (inFlight.length >= MAX_IN_FLIGHT - ADMIN_RESERVED_SLOTS) throw new McpOAuthError('too_many_logins');
    const id = crypto.randomUUID();
    const staging = path.join(attemptsDir, '.' + id + '.tmp');
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      writeJson(path.join(staging, 'request.json'), { service, project });
      fs.renameSync(staging, path.join(attemptsDir, id));
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    kick();
    return id;
  }

  /** Hands a callback value to an awaitingCallback attempt of the same (service, project); false otherwise. */
  function submitCallback(id, service, project, value) {
    if (typeof id !== 'string' || !ATTEMPT_ID.test(id)) return false;
    const attempt = liveAttempts().find(a => a.id === id);
    if (!attempt || attempt.req.service !== service || attempt.req.project !== project || attempt.state !== 'awaitingCallback') return false;
    writeJson(path.join(attempt.dir, 'callback.json'), { value });
    kick();
    return true;
  }

  return {
    scan, getMcpAuth, createAttempt, submitCallback, listLogins, projectState,
    start() {
      if (timer) return;
      timer = setInterval(() => { void scan().catch(() => log('[relay] mcp-oauth scan failed')); }, pollMs);
      timer.unref?.();
      void scan().catch(() => log('[relay] mcp-oauth scan failed'));
    },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
