import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execDocker, resolveStackAndProject, unquoteEnvValue } from './utils.js';
import { getEgressProxyCodeDir, getEgressProxyDir } from './config.js';
import { getStackStatus, toHostPath } from './compose/client.js';
import { scheduleNetworkPolicyReload } from './network-policy.js';
import { logger } from './logger.js';
import { fetchAccountUsage, inspectProviderKey, fetchMistralBudget, parseMuseUsage } from './provider-usage.js';
import { fetchAccountModels } from './provider-models.js';
// Runtime-shared registry and OAuth formats, not a second refresh implementation.
// @ts-ignore -- plain Node module also used by the standalone relay
import { antigravityUserAgent, oauthAdapters, readRelayConfigs, selectClientRoute } from '../egress-proxy/api-relay/api-relay.mjs';
// @ts-ignore -- shared with the standalone relay
import { ACCOUNT_PROVIDERS, CODE_HOST_PROVIDERS, INTEGRATION_PROVIDERS, RESERVED_ROUTES, accountId, accountTarget, integrationRoute, isKeyProvider, readAccountRegistry, validAllowRules, validCapacity, validContainers, validExpiryDate, validHost, validPathPrefix, validProjectRef, validRouteName, validTier, validTokenAuth, validWorkspaceId } from '../egress-proxy/api-relay/provider-account-config.mjs';
// @ts-ignore -- shared encryption at rest for the account store
import { configureCredentialSealing, credentialText, parseCredentialText } from '../egress-proxy/api-relay/credential-crypto.mjs';
// @ts-ignore -- the same callback validation runs again inside the login worker
import { authorization, validateCallback } from '../egress-proxy/provider-login/worker.mjs';

type ProjectRef = { stack: string; instance: string };
type AllowRule = { method: string; path: string };
type TokenAuth = { type: 'bearer' } | { type: 'header'; name: string } | { type: 'basic'; username: string } | { type: 'query'; name: string };
type Account = { id: string; credentialId: string; provider: string; label: string; scope: 'shared' | 'client' | 'project'; client?: string; tier?: string; capacity?: number; workspaceId?: string; host?: string; expiresAt?: string;
  /** Project integrations: the sandbox instance, its containers and the API calls the token may serve;
   * a custom one also names its route, base path and how the token is sent. */
  project?: ProjectRef; containers?: string[]; allow?: AllowRule[]; route?: string; pathPrefix?: string; auth?: TokenAuth };
/** The last daily or save-time check of a key, kept in memory only. */
type KeyStatus = { keyCheck: 'valid' | 'rejected'; keyCheckedAt: number; providerExpiresAt?: string };
/** Matches the account that holds the provider's credential for this scope (shared, or one relay client). */
const sameAccountTarget = (input: { provider: string; scope: string; client?: string }) => (a: Account) =>
  a.provider === input.provider && a.scope === input.scope && (a.scope === 'shared' || a.client === input.client);
/** Accounts holding a pasted key rather than a sign-in: API-key providers and every project integration. */
const isKeyAccount = (a: Account) => isKeyProvider(a.provider) || a.scope === 'project';
type Attempt = { id: string; account: Account; expiresAt: number; submitted?: boolean };
type Options = { directory: string; hostDirectory: string; clientsDirectory: string; helperDirectory: string;
  image: string; network: string; uid: string; proxy: string; harnessVolume?: string; request?: typeof fetch;
  docker?: (args: string[]) => Promise<{ status: number; stdout?: string; stderr?: string }>;
  /** The container names of a sandbox instance, as the relay sees them. */
  projectContainers?: (project: ProjectRef) => Promise<string[]>;
  /** A project integration was saved or removed: its host may change the relay's egress allowlist. */
  onIntegrationsChanged?: () => void;
  /** The relay's own env file; its RELAY_REQUIRE_KNOWN_CLIENTS decides how the relay matches clients. */
  relayEnvFile?: string };

/** A refusal whose message is safe to show the admin (never contains provider output or the key). */
export class ProviderAccountError extends Error {}

/** Replaces an account with the same id where it is; a new account goes last. */
function upsertAccount(accounts: Account[], account: Account): Account[] {
  return accounts.some(a => a.id === account.id) ? accounts.map(a => a.id === account.id ? account : a) : [...accounts, account];
}

function atomic(file: string, value: unknown, text = JSON.stringify(value)) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

function readPrivate(file: string, parse: (text: string) => any = JSON.parse) {
  // O_NONBLOCK lets a worker-planted FIFO open without waiting for a writer; the isFile() check then rejects it.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid login file');
    return parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

/** An installed credential, opened when it is sealed. */
const readCredential = (root: string, credentialId: string) => {
  const file = path.join(root, 'credentials', credentialId + '.json');
  return readPrivate(file, text => parseCredentialText(file, text));
};
/** Installs a credential, sealed when encryption at rest is on. */
const writeCredential = (root: string, credentialId: string, value: unknown) => {
  const file = path.join(root, 'credentials', credentialId + '.json');
  atomic(file, value, credentialText(file, value));
};

const CLIENT_NAME = /^[a-zA-Z0-9_-]{1,100}$/;
/** Box-owned attempt.json is trusted only when it has the shape Box writes and its profile/ directory exists. */
function validAttempt(dir: string, id: string): Attempt | undefined {
  try {
    const attempt = readPrivate(path.join(dir, 'attempt.json'));
    const account = attempt?.account;
    const valid = attempt?.id === id && accountId(account?.id) && accountId(account?.credentialId) &&
      ACCOUNT_PROVIDERS.includes(account.provider) && typeof account.label === 'string' && account.label.length >= 1 && account.label.length <= 80 &&
      (account.scope === 'client' ? typeof account.client === 'string' && CLIENT_NAME.test(account.client)
        : account.scope === 'shared' && account.client === undefined) &&
      Number.isFinite(attempt.expiresAt) && (attempt.submitted === undefined || typeof attempt.submitted === 'boolean') &&
      fs.lstatSync(path.join(dir, 'profile')).isDirectory();
    return valid ? attempt : undefined;
  } catch { return undefined; }
}

const USAGE_TTL_MS = 60_000;
const MODELS_TTL_MS = 10 * 60_000;
const MISTRAL_BUDGET_TTL_MS = 5 * 60_000;
const POOL_USAGE_INTERVAL_MS = 5 * 60_000;
const KEY_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const KEY_CHECK_STARTUP_DELAY_MS = 30_000;
const INVALID_EXPIRY = 'Enter the expiry date as YYYY-MM-DD';
const INVALID_ALLOW = 'Each allowed call is a method (GET, POST, PUT, PATCH or DELETE) and a path such as /api/v4/projects/99/issues; * stands for one path segment';
const waitingForRefresh = () => ({ error: 'Waiting for relay to refresh the credential', fetchedAt: Date.now() });

export class ProviderAccounts {
  private usageCache = new Map<string, { at: number; value: any }>();
  private modelsCache = new Map<string, { at: number; value: any }>();
  private mistralBudgetCache?: { at: number; value: any };
  // Per key file, so a replaced key never inherits the old key's check.
  private keyStatus = new Map<string, KeyStatus>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: Options) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  private root() {
    const dir = this.options.directory;
    if (!path.isAbsolute(dir) || !path.isAbsolute(this.options.hostDirectory)) throw new Error('Provider account directory is not configured');
    for (const child of ['', 'credentials', 'attempts']) {
      const target = path.join(dir, child);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Provider account directory cannot be a symlink');
      fs.chmodSync(target, 0o700);
    }
    return dir;
  }
  private clients(): any[] { return readRelayConfigs(this.options.clientsDirectory).clients; }
  private async projectContainers(project: ProjectRef): Promise<string[]> {
    let names: string[] = [];
    try { names = this.options.projectContainers ? await this.options.projectContainers(project) : []; }
    catch { /* Reported below as no containers. */ }
    if (!validContainers(names)) throw new ProviderAccountError(`Start the sandbox ${project.stack}/${project.instance} first: Box reads its container names from the running instance`);
    return names;
  }
  /** A custom integration's route name, HTTPS base URL and token placement, checked against the relay's own routes. */
  private customIntegration(input: any): { route: string; host: string; pathPrefix: string; auth: TokenAuth } {
    const route = typeof input.route === 'string' ? input.route.trim() : '';
    if (!validRouteName(route)) throw new ProviderAccountError('The route name uses lowercase letters, digits and dashes (2–40), starting with a letter');
    const relay = readRelayConfigs(this.options.clientsDirectory);
    const taken = [relay.defaults, ...relay.clients].some((c: any) => c && (Object.hasOwn(c.providers || {}, route) || Object.hasOwn(c.services || {}, route)));
    if (RESERVED_ROUTES.has(route) || taken) throw new ProviderAccountError(`/${route} is already a relay route; choose another name`);
    let url: URL | undefined;
    try { url = new URL(String(input.baseUrl || '')); } catch { /* Reported below. */ }
    const pathPrefix = url ? url.pathname.replace(/\/+$/, '') : '';
    if (!url || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash ||
        !validHost(url.hostname) || !validPathPrefix(pathPrefix)) {
      throw new ProviderAccountError('Enter the service base URL with https://, like https://api.example.com/v1 (no port, query or credentials)');
    }
    if (!validTokenAuth(input.auth)) throw new ProviderAccountError('Choose how the token is sent: Bearer, a header name, Basic with a user name, or a query parameter name');
    const auth = input.auth.type === 'header' ? { type: 'header', name: input.auth.name } : input.auth;
    return { route, host: url.hostname, pathPrefix, auth };
  }
  private async docker(args: string[]) { return (this.options.docker || execDocker)(args); }
  private attemptDirectory(id: string, root = this.root()) {
    if (!accountId(id)) throw new Error('Invalid login ID');
    return path.join(root, 'attempts', id);
  }
  // Only profile/ is mounted into the worker; everything Box trusts stays in the attempt directory.
  private profileDirectory(id: string, root = this.root()) {
    return path.join(this.attemptDirectory(id, root), 'profile');
  }
  /** One entry per attempt directory; `attempt` is undefined when Box cannot trust it. */
  private attempts(root = this.root()): { id: string; attempt?: Attempt }[] {
    const dir = path.join(root, 'attempts');
    return fs.readdirSync(dir).filter(accountId).map(id => ({ id, attempt: validAttempt(path.join(dir, id), id) }));
  }
  private async cleanup(id: string) {
    // Deterministic name derived only from the validated attempt ID.
    const result = await this.docker(['rm', '-f', 'carapa-provider-login-' + id]);
    if (result.status !== 0) {
      // Already removed by --rm is normal; verify absence before deleting its mount.
      const inspect = await this.docker(['inspect', 'carapa-provider-login-' + id]);
      if (inspect.status === 0 || !/No such (object|container)/i.test(inspect.stderr || '')) throw new Error('Login worker could not be stopped');
    }
    // Revalidate the account root after Docker I/O and immediately before the
    // recursive delete. The directory may have been replaced while the worker
    // stop/inspect calls were awaiting external state.
    const verifiedRoot = this.root();
    fs.rmSync(this.attemptDirectory(id, verifiedRoot), { recursive: true, force: true });
  }
  private validateCredential(provider: string, data: any) {
    const token = oauthAdapters()[provider]?.read(data);
    // Meta mints a long-lived subscription API key and Cursor a long-lived
    // access token instead of refreshable tokens.
    if (['meta', 'cursor'].includes(provider) ? !token?.access : !token?.refresh || (provider !== 'antigravity' && !token.access)) {
      throw new Error('Login did not produce renewable credentials');
    }
    if (provider === 'antigravity' && (!data.client_id || !data.client_secret || !data.project_id)) throw new Error('Antigravity onboarding is incomplete');
  }
  private async reconcile() {
    const root = this.root();
    let accounts: Account[] = readAccountRegistry(root);
    for (const { id, attempt } of this.attempts(root)) {
      try {
        if (!attempt) {
          // Missing or corrupt attempt.json, or a pre-profile/ attempt whose metadata the worker could write.
          logger.warn({ attemptId: id }, 'Removing invalid provider login attempt');
          await this.cleanup(id);
          continue;
        }
        const profile = this.profileDirectory(id, root);
        const status = fs.existsSync(path.join(profile, 'status.json')) ? readPrivate(path.join(profile, 'status.json')) : {};
        if (status.state !== 'completed') {
          if (attempt.expiresAt < Date.now()) await this.cleanup(id);
          continue;
        }
        // Installation may already have committed before Docker cleanup failed.
        // Never replay stale native credentials over tokens rotated by the relay.
        if (accounts.some(a => a.id === attempt.account.id && a.credentialId === attempt.account.credentialId)) {
          await this.cleanup(id);
          continue;
        }
        try {
          const data = readPrivate(path.join(profile, 'result.json'));
          this.validateCredential(attempt.account.provider, data);
          // Recheck client existence before installing. Do not create a fallback mapping.
          if (attempt.account.scope === 'client' && !this.clients().some(c => c.name === attempt.account.client)) throw new Error('Relay client no longer exists');
          writeCredential(root, attempt.account.credentialId, data);
          // A re-login replaces the credential, not the operator's tier and capacity estimates.
          const previous = accounts.find(a => a.id === attempt.account.id);
          accounts = upsertAccount(accounts, { ...attempt.account, tier: previous?.tier, capacity: previous?.capacity });
          atomic(path.join(root, 'accounts.json'), accounts);
        } catch (error) {
          // One unusable login must not make list()/start() throw forever or block other attempts.
          const message = error instanceof Error ? error.message : String(error);
          logger.warn({ attemptId: id, provider: attempt.account.provider, message }, 'Provider login could not be installed; marking failed');
          atomic(path.join(profile, 'status.json'), { state: 'failed', error: message });
        }
        await this.cleanup(id);
      } catch (error) {
        // Account-root failures are not per-attempt and must still propagate.
        this.root();
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ attemptId: id, message }, 'Provider login attempt could not be reconciled; retrying later');
      }
    }
  }
  private listing(root: string, a: Account) {
    let state = 'loginRequired';
    if (isKeyAccount(a)) {
      try { if (this.key(root, a)) state = 'connected'; } catch { /* Missing key file: enter the key again. */ }
      const status = this.keyStatus.get(a.credentialId);
      // A date the provider reports wins over the admin's own.
      const expiresAt = status?.providerExpiresAt ?? a.expiresAt;
      return { id: a.id, provider: a.provider, label: a.label, scope: a.scope, client: a.client, tier: a.tier, capacity: a.capacity, workspaceId: a.workspaceId, host: a.host, state,
        ...(a.scope === 'project' ? { project: a.project, containers: a.containers, allow: a.allow,
          route: a.route, pathPrefix: a.pathPrefix, auth: a.auth } : {}),
        ...(expiresAt ? { expiresAt, expirySource: status?.providerExpiresAt ? 'provider' : 'manual' } : {}),
        ...(status ? { keyCheck: status.keyCheck, keyCheckedAt: status.keyCheckedAt } : {}) };
    }
    try {
      const data = readCredential(root, a.credentialId);
      const adapter = oauthAdapters()[a.provider];
      const token = adapter.read(data);
      state = !adapter.needsMetadata?.(data) && token?.access && (!Number.isFinite(token.expiresAt) || token.expiresAt > Date.now()) ? 'connected'
        : token?.refresh ? 'refreshPending' : 'loginRequired';
      try {
        const status = readPrivate(path.join(root, 'status', a.credentialId + '.json'));
        if (status.state === 'loginRequired') state = 'loginRequired';
        else if (status.state === 'refreshing' && Date.now() - status.updatedAt < 30_000) state = 'refreshPending';
      } catch { /* Relay has not attempted refresh yet. */ }
    } catch { /* Missing/corrupt credentials require login. */ }
    return { id: a.id, provider: a.provider, label: a.label, scope: a.scope, client: a.client, tier: a.tier, capacity: a.capacity, state };
  }
  private snapshot(root: string) {
    const accounts = readAccountRegistry(root).map((a: Account) => this.listing(root, a));
    const logins = this.attempts(root).flatMap(({ attempt }) => attempt ? [this.login(root, attempt)] : []);
    return { accounts, logins, clients: this.clients().map(c => ({ name: c.name, isolation: c.isolation, patterns: c.patterns })) };
  }
  list() { return this.exclusive(async () => {
    await this.reconcile();
    return this.snapshot(this.root());
  }); }
  /** Stores the admin's manual order. `ids` must be exactly the current account ids; order never affects routing. */
  reorder(ids: unknown) { return this.exclusive(async () => {
    await this.reconcile();
    const root = this.root();
    const accounts: Account[] = readAccountRegistry(root);
    const byId = new Map(accounts.map(a => [a.id, a]));
    if (!Array.isArray(ids) || ids.length !== accounts.length || new Set(ids).size !== ids.length || !ids.every(id => typeof id === 'string' && byId.has(id)))
      throw new ProviderAccountError('The account list changed; reload and try again');
    atomic(path.join(root, 'accounts.json'), (ids as string[]).map(id => byId.get(id)));
    return this.snapshot(root);
  }); }
  private login(root: string, attempt: Attempt) {
    // Worker-written JSON: each field is unknown until narrowed below.
    let status: Record<string, unknown> = { state: 'starting' };
    let authorizationUrl: string | undefined;
    try {
      const file = path.join(this.profileDirectory(attempt.id, root), 'status.json');
      if (fs.existsSync(file)) status = readPrivate(file);
      if (typeof status !== 'object' || status === null) throw new Error('Invalid login status');
      if (status.authorizationUrl) {
        if (typeof status.authorizationUrl !== 'string') throw new Error('Invalid login status');
        authorizationUrl = authorization(attempt.account.provider, status.authorizationUrl).url;
      }
    } catch {
      // A broken worker status fails only this login; list() keeps serving the others.
      status = { state: 'failed' }; authorizationUrl = undefined;
    }
    if (attempt.expiresAt < Date.now()) { status = { state: 'expired' }; authorizationUrl = undefined; }
    // Whitelist public fields: a worker status file can never export token fields.
    return { id: attempt.id, accountId: attempt.account.id, provider: attempt.account.provider, label: attempt.account.label,
      state: typeof status.state === 'string' && ['starting', 'waiting', 'authorizing', 'failed', 'expired'].includes(status.state) ? status.state : 'failed',
      expiresAt: attempt.expiresAt, authorizationUrl,
      userCode: typeof status.userCode === 'string' && /^[A-Z0-9-]{4,30}$/.test(status.userCode) ? status.userCode : undefined,
      input: typeof status.input === 'string' && ['code', 'callback', 'none'].includes(status.input) ? status.input : 'none' };
  }
  /** Sets the admin's label, tier and capacity estimate and a key's manual expiry date; clears (null) tier, capacity or expiry. Omitted keys are unchanged. */
  update(id: string, edit: unknown) { return this.exclusive(async () => {
    await this.reconcile();
    const root = this.root();
    const accounts: Account[] = readAccountRegistry(root);
    const account = accounts.find(a => a.id === id);
    if (!account || !edit || typeof edit !== 'object' || Array.isArray(edit) ||
        Object.keys(edit).some(key => !['label', 'tier', 'capacity', 'expiresAt', 'allow'].includes(key))) throw new Error('Choose an existing account and editable fields');
    const fields = edit as { label?: unknown; tier?: unknown; capacity?: unknown; expiresAt?: unknown; allow?: unknown };
    const updated: Account = { ...account };
    if ('allow' in fields) {
      if (account.scope !== 'project') throw new ProviderAccountError('Allowed calls apply only to project keys');
      if (!validAllowRules(fields.allow)) throw new ProviderAccountError(INVALID_ALLOW);
      updated.allow = fields.allow as AllowRule[];
      // The instance may have gained or renamed containers since the key was saved.
      updated.containers = await this.projectContainers(account.project!);
    }
    if ('label' in fields) {
      const label = typeof fields.label === 'string' ? fields.label.trim() : fields.label;
      if (typeof label === 'string' && label.length > 0 && label.length <= 80) updated.label = label;
      else throw new Error('Invalid provider account label');
    }
    if ('tier' in fields) {
      const tier = typeof fields.tier === 'string' ? fields.tier.trim() : fields.tier;
      if (tier === null) delete updated.tier;
      else if (typeof tier === 'string' && validTier(tier)) updated.tier = tier;
      else throw new Error('Invalid provider account tier');
    }
    if ('capacity' in fields) {
      if (fields.capacity === null) delete updated.capacity;
      else if (typeof fields.capacity === 'number' && validCapacity(fields.capacity)) updated.capacity = fields.capacity;
      else throw new Error('Invalid provider account capacity');
    }
    if ('expiresAt' in fields) {
      if (!isKeyAccount(account)) throw new ProviderAccountError('An expiry date applies only to API-key accounts');
      if (fields.expiresAt === null) delete updated.expiresAt;
      else if (validExpiryDate(fields.expiresAt)) updated.expiresAt = fields.expiresAt as string;
      else throw new ProviderAccountError(INVALID_EXPIRY);
    }
    atomic(path.join(root, 'accounts.json'), accounts.map(a => a.id === id ? updated : a));
    return this.listing(root, updated);
  }); }
  /** Removes an account, its stored credential and its open login. The relay
   * stops using it at its next registry read; nothing is revoked at the provider. */
  remove(id: string) { return this.exclusive(async () => {
    await this.reconcile();
    const root = this.root();
    const accounts: Account[] = readAccountRegistry(root);
    const account = accounts.find(a => a.id === id);
    if (!account) throw new ProviderAccountError('The account list changed; reload and try again');
    // An open login would install the account again when it completes.
    for (const { id: attemptId, attempt } of this.attempts(root)) if (attempt?.account.id === id) await this.cleanup(attemptId);
    // The registry stops naming the credential before its file is deleted.
    atomic(path.join(root, 'accounts.json'), accounts.filter(a => a.id !== id));
    for (const child of ['credentials', 'status', 'quota', 'usage']) fs.rmSync(path.join(root, child, account.credentialId + '.json'), { force: true });
    if (account.scope === 'project') this.options.onIntegrationsChanged?.();
    this.usageCache.delete(account.credentialId); this.modelsCache.delete(account.credentialId); this.keyStatus.delete(account.credentialId);
    return this.snapshot(root);
  }); }
  // Read-only: uses the relay-refreshed access token, never refreshes or rewrites credentials.
  // Errors are retried after USAGE_TTL_MS even where results are kept longer.
  private async perAccount(cache: Map<string, { at: number; value: any }>, ttl: number,
    lookup: (account: Account, root: string) => Promise<any>) {
    const root = this.root();
    const accounts: Account[] = readAccountRegistry(root);
    const result: Record<string, any> = {};
    await Promise.all(accounts.map(async a => {
      const cached = cache.get(a.credentialId);
      if (cached && Date.now() - cached.at < ('error' in cached.value ? USAGE_TTL_MS : ttl)) { result[a.id] = cached.value; return; }
      let value: any;
      try { value = await lookup(a, root); }
      catch { value = { error: 'Credentials unavailable', fetchedAt: Date.now() }; }
      if (value === undefined) return; // Nothing to report for this account.
      cache.set(a.credentialId, { at: Date.now(), value });
      result[a.id] = value;
    }));
    return result;
  }
  private key(root: string, a: Account): string | undefined {
    const key = readCredential(root, a.credentialId)?.apiKey;
    return typeof key === 'string' && key ? key : undefined;
  }
  /** Whether the relay requires exact client names: its own env file, else the relay-clients defaults alone. */
  private relayRequiresKnownClients(defaults: { requireKnownClients?: boolean } | null | undefined): boolean {
    let fromEnv = false;
    try {
      const text = this.options.relayEnvFile ? fs.readFileSync(this.options.relayEnvFile, 'utf8') : '';
      const last = [...text.matchAll(/^\s*(?:export\s+)?RELAY_REQUIRE_KNOWN_CLIENTS=(.*)$/gm)].at(-1);
      fromEnv = !!last && unquoteEnvValue(last[1]) === '1';
    } catch { /* No readable relay env: the defaults decide. */ }
    return fromEnv || defaults?.requireKnownClients === true;
  }
  /**
   * The code hosting account the relay serves to this container for the
   * repository's server, for Box's own issue requests: per provider, its relay
   * client's account, else the shared one. As in the relay, a client with its
   * own route for that provider, or an isolated client, has no shared fallback.
   * `hostnames` are the names the relay's reverse DNS can report for the
   * container (qualified with each network), then the bare name; the first one
   * a relay client matches decides.
   */
  codeHostAccountFor(hostnames: string | string[], repoHost: string): { provider: 'gitlab' | 'github'; label: string; host: string; key: string } {
    const root = this.root();
    const relay = readRelayConfigs(this.options.clientsDirectory);
    const registry = readAccountRegistry(root) as Account[];
    const candidates = typeof hostnames === 'string' ? [hostnames] : hostnames;
    const requireKnownClients = this.relayRequiresKnownClients(relay.defaults);
    let scope = 'shared accounts';
    for (const provider of CODE_HOST_PROVIDERS as ('gitlab' | 'github')[]) {
      let clientMatch: any;
      let denied = false;
      let unmatched = false;
      for (const hostname of candidates) {
        try {
          ({ clientMatch } = selectClientRoute({ clients: relay.clients, defaults: relay.defaults, requireKnownClients }, hostname, provider));
          if (clientMatch) break;
          unmatched = true;
        } catch (error) {
          // An unrecognized name may still be matched by another network's name; any other refusal is final.
          if ((error as Error).message === 'Unrecognized relay client') continue;
          denied = true;
          break;
        }
      }
      // An isolated client without this provider's route gets no account for it.
      if (denied || (!clientMatch && !unmatched)) continue;
      if (clientMatch) scope = `relay client ${clientMatch.name}`;
      const accounts = registry.filter(a => a.provider === provider);
      const account = clientMatch
        ? accounts.find(a => a.scope === 'client' && a.client === clientMatch.name)
          || (!clientMatch.providers[provider] && clientMatch.isolation !== 'strict' ? accounts.find(a => a.scope === 'shared') : undefined)
        : accounts.find(a => a.scope === 'shared');
      if (!account?.host || account.host.split(':')[0] !== repoHost) continue;
      const key = this.key(root, account);
      if (!key) throw new ProviderAccountError(`${provider === 'github' ? 'GitHub' : 'GitLab'} account "${account.label}" (${scope}) has no saved key`);
      return { provider, label: `${account.label} (${scope})`, host: account.host, key };
    }
    throw new ProviderAccountError(`No GitLab or GitHub account for ${repoHost} in Provider accounts for ${scope}`);
  }
  /** Native request headers, or undefined until the relay has refreshed the credential. */
  private access(root: string, a: Account) {
    const data = readCredential(root, a.credentialId);
    const token = oauthAdapters()[a.provider].read(data);
    if (!token?.access || (Number.isFinite(token.expiresAt) && token.expiresAt <= Date.now())) return undefined;
    return { data, headers: { ...token.headers, ...(a.provider === 'antigravity' ? { 'user-agent': antigravityUserAgent(data) } : {}) } };
  }
  async usage(request?: typeof fetch) {
    const accounts: Account[] = readAccountRegistry(this.root());
    return { usage: await this.perAccount(this.usageCache, USAGE_TTL_MS, async (a, root) => {
      if (a.provider === 'meta') return museUsage(root, a.credentialId);
      if (isKeyAccount(a)) {
        // Either Mistral key reads the organisation's API and Vibe Code allowances.
        if (!a.provider.startsWith('mistral-')) return undefined;
        const key = this.key(root, a);
        return key ? fetchMistralBudget(key, request) : { error: 'Enter the key again', fetchedAt: Date.now() };
      }
      const access = this.access(root, a);
      if (!access) return waitingForRefresh();
      const value = await fetchAccountUsage(a.provider, access.headers, request, access.data);
      // The relay chooses among several accounts of one provider from these windows.
      if ('windows' in value) {
        fs.mkdirSync(path.join(root, 'quota'), { recursive: true, mode: 0o700 });
        atomic(path.join(root, 'quota', a.credentialId + '.json'), { windows: value.windows, fetchedAt: value.fetchedAt });
      }
      return value;
    }), credits: openRouterCredits(this.root()), openRouterPrices: openRouterPrices(this.root()), apiSpend: anthropicApiSpend(this.root(), 'anthropic-api.json'),
      // Each admin key's spend, keyed by its account; Board shows it on the paired API account.
      apiSpendByAccount: Object.fromEntries(accounts.filter(a => a.provider === 'anthropic-admin')
        .flatMap(a => { const spend = anthropicApiSpend(this.root(), a.credentialId + '.json'); return spend ? [[a.id, spend]] : []; })),
      // A connected Mistral account shows the allowances on its own row instead.
      mistralBudget: accounts.some(a => a.provider.startsWith('mistral-')) ? undefined : await this.mistralBudget(request) };
  }
  /** Keeps the usage readings current while several accounts share one provider,
   * so the relay's choice does not depend on the admin screen being open. */
  async refreshPoolUsage() {
    const targets = readAccountRegistry(this.root()).map(accountTarget);
    if (new Set(targets).size < targets.length) await this.usage();
  }
  /** Asks each provider whether every saved key still works and when a code host token expires, one account at a time.
   * Only a verdict replaces the previous result: an unreachable provider never makes a key look rejected.
   * The queue is not held: the calls are slow and only the in-memory results change. */
  async checkKeys() {
    const root = this.root();
    const accounts = (readAccountRegistry(root) as Account[]).filter(a => isKeyProvider(a.provider));
    for (const credentialId of this.keyStatus.keys()) if (!accounts.some(a => a.credentialId === credentialId)) this.keyStatus.delete(credentialId);
    for (const a of accounts) {
      let key: string | undefined;
      try { key = this.key(root, a); } catch { /* No key file: nothing to check. */ }
      if (!key) continue;
      const { result, expiresAt } = await inspectProviderKey(a.provider, key, this.options.request, undefined, { workspaceId: a.workspaceId, host: a.host });
      if (result !== 'valid' && result !== 'rejected') continue;
      // The account may have been removed or its key replaced during the call.
      if (!(readAccountRegistry(root) as Account[]).some(x => x.credentialId === a.credentialId)) continue;
      const previous = this.keyStatus.get(a.credentialId);
      this.keyStatus.set(a.credentialId, { keyCheck: result, keyCheckedAt: Date.now(),
        providerExpiresAt: result === 'valid' ? expiresAt : previous?.providerExpiresAt });
    }
  }
  /** Mistral's API and Vibe Code allowances, read with the Vibe CLI key
   * (Compose secret mistral_vibe_api_key); absent when no key is mounted. */
  private async mistralBudget(request?: typeof fetch) {
    let key = '';
    try { key = fs.readFileSync(path.join(process.env.SECRETS_DIR || '/run/secrets', 'mistral_vibe_api_key'), 'utf8').trim(); }
    catch { /* No key mounted. */ }
    if (!key) return undefined;
    const cached = this.mistralBudgetCache;
    if (cached && Date.now() - cached.at < ('error' in cached.value ? USAGE_TTL_MS : MISTRAL_BUDGET_TTL_MS)) return cached.value;
    const value = await fetchMistralBudget(key, request);
    this.mistralBudgetCache = { at: Date.now(), value };
    return value;
  }
  async models(request?: typeof fetch) {
    return { models: await this.perAccount(this.modelsCache, MODELS_TTL_MS, async (a, root) => {
      // Board reads API-key models from its own catalog, not from the account.
      if (isKeyAccount(a)) return undefined;
      const access = this.access(root, a);
      return access ? fetchAccountModels(a.provider, access.headers, request, access.data) : waitingForRefresh();
    }) };
  }
  start(input: any) {
    if (isKeyProvider(input?.provider) || input?.scope === 'project') return this.saveKey(input);
    return this.exclusive(async () => {
    await this.reconcile();
    const root = this.root();
    if (!input || !ACCOUNT_PROVIDERS.includes(input.provider) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 ||
        !['shared', 'client'].includes(input.scope)) throw new Error('Choose a provider, label and account scope');
    if (input.expiresAt !== undefined) throw new ProviderAccountError('An expiry date applies only to API-key accounts');
    if (input.scope === 'client' && !this.clients().some(c => c.name === input.client)) throw new Error('Choose an existing relay client');
    // `accountId` signs an existing account in again; without it the login adds
    // an account, which shares the provider with any other account of that scope.
    const existing = input.accountId === undefined ? undefined
      : (readAccountRegistry(root) as Account[]).find(a => a.id === input.accountId && sameAccountTarget(input)(a));
    if (input.accountId !== undefined && !existing) throw new ProviderAccountError('The account list changed; reload and try again');
    const active = this.attempts(root).flatMap(({ attempt }) => attempt ? [attempt] : []);
    if (existing && active.some(a => a.account.id === existing.id)) throw new ProviderAccountError('A login for this account is already open. Finish it or cancel it before starting another.');
    if (active.length >= 4) throw new ProviderAccountError('Four logins are already open. Finish or cancel one before starting another.');
    const id = crypto.randomUUID();
    const account: Account = { id: existing?.id || crypto.randomUUID(), credentialId: crypto.randomUUID(),
      label: input.label.trim(), provider: input.provider, scope: input.scope, ...(input.scope === 'client' ? { client: input.client } : {}) };
    const attempt: Attempt = { id, account, expiresAt: Date.now() + 15 * 60_000 };
    const dir = this.attemptDirectory(id, root);
    // attempt.json stays outside the worker mount; a crash before it is written leaves an invalid attempt that reconcile removes.
    fs.mkdirSync(dir, { mode: 0o700 }); fs.mkdirSync(this.profileDirectory(id, root), { mode: 0o700 });
    atomic(path.join(dir, 'attempt.json'), attempt);
    const args = ['run', '-d', '--rm', '--pull=never', '--name', 'carapa-provider-login-' + id,
      '--label', 'carapa.provider-login=true', '--user', this.options.uid, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=1', '--log-driver=none',
      '--network', this.options.network, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
      '--mount', `type=bind,source=${path.join(this.options.hostDirectory, 'attempts', id, 'profile')},target=/profile`,
      '--mount', `type=bind,source=${this.options.helperDirectory},target=/helper,readonly`,
      '-e', 'HTTP_PROXY=' + this.options.proxy, '-e', 'HTTPS_PROXY=' + this.options.proxy,
      ...(this.options.harnessVolume ? ['--mount', `type=volume,source=${this.options.harnessVolume},target=/opt/carapa-harness,readonly,volume-nocopy`,
        '--mount', `type=volume,source=${this.options.harnessVolume},target=/opt/carapa-harness-store,readonly,volume-nocopy`] : []),
      '--entrypoint', 'node', this.options.image, '/helper/worker.mjs', input.provider];
    try {
      const result = await this.docker(args);
      if (result.status !== 0) throw new Error('Unable to start provider login worker; check the configured image and network');
    } catch (error) { await this.cleanup(id); throw error; }
    return { id };
  }); }
  /** API-key accounts have no login: Box checks the key with the provider and installs it at once. */
  private async saveKey(input: any) {
    const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || !['shared', 'client', 'project'].includes(input.scope)) {
      throw new ProviderAccountError('Choose a provider, label and account scope');
    }
    const project: ProjectRef | undefined = input.scope === 'project' ? input.project : undefined;
    // A custom integration's own route, base URL and token placement; presets fix them.
    let custom: { route: string; host: string; pathPrefix: string; auth: TokenAuth } | undefined;
    if (input.scope === 'project') {
      if (!INTEGRATION_PROVIDERS.includes(input.provider)) throw new ProviderAccountError('Choose GitLab, GitHub or another service');
      if (!validProjectRef(project)) throw new ProviderAccountError('Choose the project sandbox instance');
      if (!validAllowRules(input.allow)) throw new ProviderAccountError(INVALID_ALLOW);
      if (input.provider === 'custom') custom = this.customIntegration(input);
    } else if (['project', 'allow', 'route', 'baseUrl', 'auth'].some(key => input[key] !== undefined)) {
      throw new ProviderAccountError('Allowed calls apply only to project integrations');
    }
    if (!/^[\x21-\x7e]{8,4096}$/.test(apiKey)) throw new ProviderAccountError('Paste the API key');
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId.trim() ? input.workspaceId.trim() : undefined;
    if (workspaceId !== undefined && (input.provider !== 'anthropic-api' || !validWorkspaceId(workspaceId))) {
      throw new ProviderAccountError('A workspace ID looks like wrkspc_… and applies only to Anthropic API keys');
    }
    // The admin's own expiry replaces any earlier one: none supplied clears it.
    const expiresAt = input.expiresAt ?? undefined;
    if (expiresAt !== undefined && !validExpiryDate(expiresAt)) throw new ProviderAccountError(INVALID_EXPIRY);
    // Code hosting accounts name their server, e.g. https://gitlab.example.com or https://github.com.
    let host: string | undefined;
    if (CODE_HOST_PROVIDERS.includes(input.provider)) {
      try { const url = new URL(String(input.host || '')); if (url.protocol === 'https:' && url.pathname === '/' && !url.search) host = url.host; }
      catch { /* Invalid URL. */ }
      if (!host || !validHost(host)) throw new ProviderAccountError(input.provider === 'github'
        ? 'Enter the GitHub server address: https://github.com, or your GitHub Enterprise server'
        : 'Enter the GitLab server address, like https://gitlab.example.com');
    }
    return this.exclusive(async () => {
      const root = this.root();
      if (input.scope === 'client' && !this.clients().some(c => c.name === input.client)) throw new ProviderAccountError('Choose an existing relay client');
      const containers = project ? await this.projectContainers(project) : undefined;
      // No standard request tells whether another service accepts a token: it is saved unchecked.
      const { result, expiresAt: providerExpiresAt } = custom ? { result: 'valid', expiresAt: undefined }
        : await inspectProviderKey(input.provider, apiKey, this.options.request, undefined, { workspaceId, host });
      if (result !== 'valid') throw new ProviderAccountError(result === 'rejected' ? 'The provider rejected this key'
        : result === 'needsWorkspace' ? 'This key is not scoped to one workspace: add its workspace ID (Claude Console → Workspaces)'
          : 'Could not reach the provider to check the key; try again');
      const accounts: Account[] = readAccountRegistry(root);
      const account: Account = { id: '', credentialId: crypto.randomUUID(),
        label: input.label.trim(), provider: input.provider, scope: input.scope, ...(input.scope === 'client' ? { client: input.client } : {}),
        ...(workspaceId ? { workspaceId } : {}), ...(custom ? custom : host ? { host } : {}), ...(expiresAt ? { expiresAt } : {}),
        ...(project ? { project: { stack: project.stack, instance: project.instance }, containers, allow: input.allow } : {}) };
      // The same target (provider and scope; for a project, its route) is replaced, keeping its id and estimates.
      const existing = accounts.find(a => accountTarget(a) === accountTarget(account));
      if (input.scope === 'project' && existing && existing.provider !== account.provider) {
        throw new ProviderAccountError(`This project already has another integration on /${integrationRoute(account).route}`);
      }
      account.id = existing?.id || crypto.randomUUID();
      if (existing?.tier) account.tier = existing.tier;
      if (existing?.capacity) account.capacity = existing.capacity;
      // The key file exists before the registry points the relay at it. Unlike a
      // replaced login, a replaced key is deleted: it is no rollback, only a stale secret.
      writeCredential(root, account.credentialId, { apiKey });
      atomic(path.join(root, 'accounts.json'), upsertAccount(accounts, account));
      if (existing) { fs.rmSync(path.join(root, 'credentials', existing.credentialId + '.json'), { force: true }); this.keyStatus.delete(existing.credentialId); }
      if (!custom) this.keyStatus.set(account.credentialId, { keyCheck: 'valid', keyCheckedAt: Date.now(), providerExpiresAt });
      if (project) this.options.onIntegrationsChanged?.();
      return { id: account.id, installed: true };
    });
  }
  complete(id: string, value: unknown) { return this.exclusive(async () => {
    const dir = this.attemptDirectory(id);
    const attempt = validAttempt(dir, id);
    if (!attempt) throw new Error('Login is not waiting for input');
    if (attempt.expiresAt < Date.now()) throw new Error('Login expired');
    const profile = this.profileDirectory(id);
    const status = readPrivate(path.join(profile, 'status.json'));
    if (attempt.submitted || status.state !== 'waiting' || fs.existsSync(path.join(profile, 'input.json'))) throw new Error('Login is not waiting for input');
    const auth = authorization(attempt.account.provider, status.authorizationUrl);
    if (attempt.account.provider === 'antigravity') validateCallback(auth, value);
    else if (attempt.account.provider !== 'anthropic' || typeof value !== 'string' || !/^[^\s]{1,4096}$/.test(value)) throw new Error('Invalid authorization code');
    atomic(path.join(dir, 'attempt.json'), { ...attempt, submitted: true });
    atomic(path.join(profile, 'input.json'), { value });
    return { ok: true };
  }); }
  cancel(id: string) { return this.exclusive(async () => {
    // Validates the ID only: a broken attempt must stay cancellable.
    this.attemptDirectory(id);
    await this.cleanup(id); return { ok: true };
  }); }
}

/** Meta reports usage only inside model streams; api-relay records the last one. */
function museUsage(root: string, credentialId: string) {
  let observed: any;
  try { observed = readPrivate(path.join(root, 'usage', credentialId + '.json')); } catch { /* None yet. */ }
  const windows = observed ? parseMuseUsage(observed.subscription) : [];
  return windows.length ? { windows, fetchedAt: observed.observedAt }
    : { error: 'Usage appears after the next Muse reply', fetchedAt: Date.now() };
}

/** OpenRouter is prepaid credits rather than a managed login; api-relay alone holds its key and records the balance. */
function openRouterCredits(root: string) {
  try {
    const observed = readPrivate(path.join(root, 'usage', 'openrouter.json'));
    const totalCredits = Number(observed.totalCredits), totalUsage = Number(observed.totalUsage);
    if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return undefined;
    return { provider: 'openrouter', totalCredits, totalUsage, remaining: totalCredits - totalUsage, fetchedAt: observed.observedAt };
  } catch { return undefined; /* Not recorded yet, or no OpenRouter key. */ }
}

/** Month-to-date Anthropic API spend (US dollars) as api-relay last recorded it with an admin key. */
function anthropicApiSpend(root: string, file: string) {
  try {
    const observed = readPrivate(path.join(root, 'usage', file));
    const spent = Number(observed.spent);
    if (!Number.isFinite(spent) || typeof observed.periodStart !== 'string') return undefined;
    const models = Object.fromEntries(Object.entries<any>(observed.models || {}).filter(([, value]) => Number.isFinite(value)));
    return { provider: 'anthropic-api', spent, periodStart: observed.periodStart, models, fetchedAt: observed.observedAt };
  } catch { return undefined; /* Not recorded yet, or no admin key. */ }
}

/** Per-model OpenRouter prices (USD per million tokens) as api-relay last recorded them from the public model list. */
function openRouterPrices(root: string) {
  try {
    const observed = readPrivate(path.join(root, 'usage', 'openrouter-prices.json'));
    return observed.models && typeof observed.models === 'object' ? { models: observed.models, fetchedAt: observed.observedAt } : undefined;
  } catch { return undefined; /* Not recorded yet. */ }
}

let instance: ProviderAccounts | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
export function configuredProviderAccounts() {
  if (!process.env.PROVIDER_ACCOUNTS_DIR) throw new Error('Provider accounts are not configured in CarapaBox');
  const harnessVolume = process.env.PROVIDER_LOGIN_HARNESS_VOLUME;
  if (harnessVolume && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(harnessVolume)) throw new Error('Invalid provider login harness volume');
  // Box installs credentials: it seals them with the relay's key when encryption at rest is on.
  if (!instance) configureCredentialSealing(process.env, process.env.PROVIDER_ACCOUNTS_DIR);
  return instance ||= new ProviderAccounts({ directory: process.env.PROVIDER_ACCOUNTS_DIR,
    hostDirectory: process.env.PROVIDER_ACCOUNTS_HOST_DIR || process.env.PROVIDER_ACCOUNTS_DIR,
    clientsDirectory: process.env.PROVIDER_RELAY_CLIENTS_DIR || path.join(getEgressProxyDir(), 'relay-clients'),
    helperDirectory: toHostPath(path.join(getEgressProxyCodeDir(), 'provider-login')),
    image: process.env.PROVIDER_LOGIN_IMAGE || 'carapa-bot:0.1.0', harnessVolume,
    network: process.env.PROVIDER_LOGIN_NETWORK || 'egress_proxy',
    uid: process.env.PROVIDER_LOGIN_UID || `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    proxy: process.env.PROVIDER_LOGIN_PROXY || 'http://squid:3128', projectContainers,
    relayEnvFile: path.join(getEgressProxyDir(), '.env'),
    // The relay's egress allowlist includes each integration's host.
    onIntegrationsChanged: scheduleNetworkPolicyReload });
}

/** Every container of a sandbox instance, by the name Docker gives it (what the relay matches). */
async function projectContainers({ stack, instance }: ProjectRef): Promise<string[]> {
  const { stackPath, projectName } = await resolveStackAndProject(stack, instance);
  if (!stackPath || projectName !== `${stack}-${instance}`) return [];
  // Imported on use: the tools module imports this one.
  const { parseComposePsOutput } = await import('./tools/register.js');
  const ps = parseComposePsOutput((await getStackStatus(stackPath, projectName)).stdout || '');
  return [...new Set(ps.map(service => service.hostname).filter(Boolean))].sort();
}

// Box, not Board, completes credential installation even if the UI disconnects.
// Refresh remains exclusively in api-relay's OAuthManager.
export function startProviderAccountReconciler() {
  if (poller || !process.env.PROVIDER_ACCOUNTS_DIR) return;
  const reconcile = () => { void configuredProviderAccounts().list().catch(() => {}); };
  reconcile();
  poller = setInterval(reconcile, 3000); poller.unref();
  setInterval(() => { void configuredProviderAccounts().refreshPoolUsage().catch(() => {}); }, POOL_USAGE_INTERVAL_MS).unref();
  const checkKeys = () => { void configuredProviderAccounts().checkKeys().catch(() => {}); };
  setTimeout(checkKeys, KEY_CHECK_STARTUP_DELAY_MS).unref();
  setInterval(checkKeys, KEY_CHECK_INTERVAL_MS).unref();
}
