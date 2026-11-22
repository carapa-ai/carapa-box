import fs from 'node:fs';
import path from 'node:path';

export const ACCOUNT_PROVIDERS = ['anthropic', 'codex', 'antigravity', 'meta', 'xai', 'cursor'];
// API-key accounts: the admin pastes a key instead of signing in. Each name is
// the relay route the key serves; a host here applies when no route config sets one.
const KEY_PROVIDERS = {
  'mistral-eu': {},
  'mistral-vibe': { host: 'api.eu.mistral.ai' },
  openrouter: {},
  'anthropic-api': {},
  openai: {},
  google: {},
  nvidia: {},
  // Typesafe's hosted Jev (route /jev).
  jev: { host: 'api.typesafe.ai' },
  // Code hosting: the server comes from the account (`host`), not from GITLAB_HOST_URL.
  gitlab: {},
  github: {},
  // Read only by the relay's API spend report; never a route agents can call.
  'anthropic-admin': { route: false },
};
export const isKeyProvider = provider => Object.hasOwn(KEY_PROVIDERS, provider);
// Code hosting accounts name their server (`host`).
export const CODE_HOST_PROVIDERS = ['gitlab', 'github'];
// A project integration (scope `project`) is a token for one relay route that
// serves only the named containers of one sandbox instance, and only for the API
// calls its rules allow. GitLab and GitHub are presets of the existing routes,
// where any other call keeps the route's ordinary key; `custom` names its own
// route, base URL and the way the token is sent.
export const INTEGRATION_PROVIDERS = ['gitlab', 'github', 'custom'];
const MAX_PROJECT_CONTAINERS = 32;
const MAX_ALLOW_RULES = 32;
const ALLOW_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// `*` stands for exactly one segment; a literal segment uses this alphabet,
// so no encoded, dotted or matrix spelling can match a rule.
const RULE_SEGMENT = /^[A-Za-z0-9_.~+=:@-]+$/;
const validRuleSegment = seg => seg === '*' || (RULE_SEGMENT.test(seg) && seg !== '.' && seg !== '..');
// One empty final segment is a trailing slash (`/contacts/`, `/`); any other empty segment is invalid.
const ruleSegments = path => {
  const segments = path.slice(1).split('/');
  if (segments.at(-1) === '') segments.pop();
  return segments;
};
export const validAllowRule = rule => !!rule && typeof rule === 'object' && !Array.isArray(rule) &&
  Object.keys(rule).every(key => key === 'method' || key === 'path') &&
  ALLOW_METHODS.includes(rule.method) && typeof rule.path === 'string' && rule.path.length <= 512 &&
  rule.path.startsWith('/') && ruleSegments(rule.path).every(validRuleSegment);
export const validAllowRules = rules => Array.isArray(rules) && rules.length >= 1 && rules.length <= MAX_ALLOW_RULES && rules.every(validAllowRule);
// Docker container names, without the network suffix the relay sees after the first dot.
const validContainerName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
export const validContainers = list => Array.isArray(list) && list.length >= 1 && list.length <= MAX_PROJECT_CONTAINERS &&
  list.every(validContainerName) && new Set(list).size === list.length;
const PROJECT_PART = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const validProjectRef = value => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === 2 && PROJECT_PART.test(value.stack) && PROJECT_PART.test(value.instance);
/** Whether a route-relative request path (query ignored; it starts with `/`, so a bare route name never matches `/`) matches one rule: same method, same segment count, `*` for any one segment. */
export function allowRuleMatches(rule, method, url) {
  if (rule.method !== method || !url.startsWith('/')) return false;
  const end = url.search(/[?#]/);
  const segments = (end === -1 ? url : url.slice(0, end)).slice(1).split('/');
  const pattern = rule.path.slice(1).split('/');
  return segments.length === pattern.length && pattern.every((seg, i) => seg === '*' ? RULE_SEGMENT.test(segments[i]) : seg === segments[i]);
}
/** The project integrations of this route for this container (the name before the first dot of its hostname). */
export function projectGrantsFor(grants, route, hostname) {
  if (!grants?.length || !hostname) return [];
  const container = hostname.split('.')[0];
  return grants.filter(g => g.name === route && g.containers.includes(container));
}
/** The project integration that serves this request, if any: the container's own route and an allowed call. */
export function selectProjectGrant(grants, route, hostname, method, url) {
  return projectGrantsFor(grants, route, hostname).find(g => g.allow.some(rule => allowRuleMatches(rule, method, url))) || null;
}

// Route names a custom integration cannot take: the relay's own providers,
// managed accounts and git routes, and its internal services.
export const RESERVED_ROUTES = new Set(['antigravity', 'anthropic', 'anthropic-api', 'openai', 'google', 'codex', 'openrouter',
  'nvidia', 'mistral-eu', 'mistral-vibe', 'meta', 'muse-code', 'xai', 'cursor', 'jev', 'jev2', 'gitlab', 'github',
  'gitlab-git', 'github-git', 'anthropic-admin', 'mcp-relay', 'board-api', 'health', 'status']);
export const validRouteName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(value);
// A base path below the host: literal segments only.
export const validPathPrefix = value => value === '' || (typeof value === 'string' && value.length <= 256 &&
  value.startsWith('/') && value.slice(1).split('/').every(seg => RULE_SEGMENT.test(seg) && seg !== '.' && seg !== '..'));
// Headers the relay or HTTP itself owns; a token header must not replace them.
const RESERVED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding',
  'content-length', 'content-type', 'content-encoding', 'accept-encoding', 'expect', 'cookie', 'proxy-authorization',
  'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
/** How the relay sends the token: `Authorization: Bearer`, a named header, HTTP Basic with a user name, or a query parameter. */
export function validTokenAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
  const keys = Object.keys(auth);
  switch (auth.type) {
    case 'bearer': return keys.length === 1;
    case 'header': return keys.length === 2 && typeof auth.name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(auth.name) && !RESERVED_HEADERS.has(auth.name);
    case 'basic': return keys.length === 2 && typeof auth.username === 'string' && /^[\x21-\x39\x3b-\x7e]{1,128}$/.test(auth.username);
    case 'query': return keys.length === 2 && typeof auth.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(auth.name);
    default: return false;
  }
}
/** The fixed route, base path and token header of the GitLab and GitHub presets. */
function integrationPreset(provider, host) {
  if (provider === 'gitlab') return { route: 'gitlab', host, pathPrefix: '', auth: { type: 'header', name: 'private-token' } };
  if (provider === 'github') return { route: 'github', ...githubApi(host), auth: { type: 'bearer' } };
  return null;
}
function validProjectIntegration(a) {
  if (!INTEGRATION_PROVIDERS.includes(a.provider) || !validProjectRef(a.project) || !validContainers(a.containers) || !validAllowRules(a.allow)) return false;
  if (a.provider !== 'custom') return a.route === undefined && a.pathPrefix === undefined && a.auth === undefined;
  // A custom route is HTTPS on the default port only (the relay's egress allows 443).
  return validRouteName(a.route) && !RESERVED_ROUTES.has(a.route) && !/:/.test(a.host) &&
    validPathPrefix(a.pathPrefix) && validTokenAuth(a.auth);
}
/** The route, upstream and token placement a project integration serves. */
export function integrationRoute(a) {
  return a.provider === 'custom' ? { route: a.route, host: a.host, pathPrefix: a.pathPrefix, auth: a.auth } : integrationPreset(a.provider, a.host);
}

/** A GitHub server's REST API: github.com answers on api.github.com, Enterprise Server under /api/v3. */
export const githubApi = host => host === 'github.com' ? { host: 'api.github.com', pathPrefix: '' } : { host, pathPrefix: '/api/v3' };
// Anthropic keys not scoped to one workspace need it named on every request.
export const validHost = value => typeof value === 'string' && value.length <= 253 &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(value);
export const validWorkspaceId = value => typeof value === 'string' && /^wrkspc_[A-Za-z0-9]{1,64}$/.test(value);
const knownProvider = provider => ACCOUNT_PROVIDERS.includes(provider) || isKeyProvider(provider);
// Route settings a managed key keeps from the route it replaces: never the
// route's own credential, nor headers that belong to another key's account.
const ROUTE_SETTINGS = ['host', 'pathPrefix', 'envHost', 'verifyTls', 'requestsPerSecond', 'gitRepos'];
const routeSettings = (config, withHeaders) => Object.fromEntries(Object.entries(config || {})
  .filter(([key]) => ROUTE_SETTINGS.includes(key) || (withHeaders && key === 'extraHeaders')));
export const accountId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
// Admin estimates for comparing accounts. They never affect routing or credentials.
export const validTier = value => typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 40;
export const validCapacity = value => Number.isSafeInteger(value) && value >= 1 && value <= 1000;
/** A calendar date `YYYY-MM-DD` that exists (UTC); a key is usable through the end of that day. */
export const validExpiryDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

// This registry contains routing metadata only. No credential paths supplied by
// a browser are accepted; credential filenames are derived from generated IDs.
export function readAccountRegistry(directory) {
  const file = path.join(directory, 'accounts.json');
  if (!fs.existsSync(file)) return [];
  const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(accounts) || accounts.length > 100) throw new Error('Invalid provider account registry');
  const targets = new Set();
  for (const a of accounts) {
    if (!accountId(a.id) || !accountId(a.credentialId) || !(knownProvider(a.provider) || (a.scope === 'project' && a.provider === 'custom')) ||
        !['shared', 'client', 'project'].includes(a.scope) || typeof a.label !== 'string' || a.label.length > 80 ||
        (a.scope === 'client' && (typeof a.client !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(a.client)))) {
      throw new Error('Invalid provider account');
    }
    // Only a project integration carries its containers, rules and (custom) route.
    if (a.scope === 'project' ? !validProjectIntegration(a)
      : ['project', 'containers', 'allow', 'route', 'pathPrefix', 'auth'].some(key => a[key] !== undefined)) throw new Error('Invalid provider account');
    if (a.workspaceId !== undefined && (a.provider !== 'anthropic-api' || !validWorkspaceId(a.workspaceId))) throw new Error('Invalid provider account');
    const named = CODE_HOST_PROVIDERS.includes(a.provider) || a.provider === 'custom';
    if (named !== (a.host !== undefined) || (a.host !== undefined && !validHost(a.host))) throw new Error('Invalid provider account');
    // A hand-edited estimate is ignored rather than failing every account.
    if (!validTier(a.tier)) delete a.tier;
    if (!validCapacity(a.capacity)) delete a.capacity;
    if (a.expiresAt !== undefined && !validExpiryDate(a.expiresAt)) delete a.expiresAt;
    // Sign-in accounts may share a target: they form a pool the relay picks from.
    const target = accountTarget(a);
    if (targets.has(target) && !ACCOUNT_PROVIDERS.includes(a.provider)) throw new Error('Duplicate provider account binding');
    targets.add(target);
  }
  return accounts;
}

/** What an account serves: its provider for the shared default or one relay client; a project integration, its route in one instance. */
export const accountTarget = a => a.scope === 'project' ? `project:${a.project.stack}/${a.project.instance}:${integrationRoute(a).route}`
  : `${a.provider}:${a.scope}:${a.scope === 'client' ? a.client : ''}`;

export function applyProviderAccounts(directory, configuration) {
  if (!directory) return configuration;
  const next = structuredClone(configuration);
  const accounts = readAccountRegistry(directory);
  const pooled = new Set();
  next.projectGrants = [];
  for (const account of accounts) {
    if (account.scope === 'project') {
      // Not a route of any client: the relay consults it per request, before the client's own key.
      const keyFile = path.join(directory, 'credentials', account.credentialId + '.json');
      const { route: name, host, pathPrefix, auth } = integrationRoute(account);
      next.projectGrants.push({ name, project: account.project, containers: account.containers, allow: account.allow,
        route: { auth: 'apikey', keyFile, host, pathPrefix, tokenAuth: auth } });
      continue;
    }
    let target;
    if (account.scope === 'shared') {
      target = next.defaults ||= { providers: {}, services: {} };
    } else {
      target = next.clients.find(client => client.name === account.client);
      // A deleted mapping must not silently turn a private account into a default.
      if (!target) throw new Error('Provider account relay client is missing');
    }
    const credentialFile = path.join(directory, 'credentials', account.credentialId + '.json');
    if (KEY_PROVIDERS[account.provider]?.route === false) continue;
    if (isKeyProvider(account.provider)) {
      // A client-specific key still needs the route's host and pacing; the
      // shared default's headers (such as a workspace ID) belong to its own key.
      const own = target.providers[account.provider];
      const inherited = own ? routeSettings(own, true)
        : account.scope === 'client' ? routeSettings(next.defaults?.providers?.[account.provider], false) : {};
      const route = { ...KEY_PROVIDERS[account.provider], ...inherited, auth: 'apikey', keyFile: credentialFile };
      if (account.host) {
        delete route.envHost;
        // The git route (`/github-git/`) reaches the server itself, not its API host.
        if (account.provider === 'github') Object.assign(route, githubApi(account.host), { gitHost: account.host });
        else route.host = account.host;
      }
      if (account.workspaceId) route.extraHeaders = { ...route.extraHeaders, 'anthropic-workspace-id': account.workspaceId };
      target.providers[account.provider] = route;
      continue;
    }
    // Accounts with the same target are one route: the first in the admin's
    // order is its `credentialFile`, and the relay picks among `credentialFiles`.
    const pool = accountTarget(account);
    if (pooled.has(pool)) continue;
    pooled.add(pool);
    const files = accounts.filter(a => accountTarget(a) === pool).map(a => path.join(directory, 'credentials', a.credentialId + '.json'));
    const credential = { auth: 'oauth', credentialFormat: account.provider, credentialFile,
      ...(files.length > 1 ? { credentialFiles: files, pool } : {}) };
    if (account.provider === 'meta') {
      // Muse sends model calls to <api_base_url>/responses (base /meta/v1) and
      // its catalog to the absolute /muse-code/...; route both to Meta.
      target.providers.meta = { ...credential, host: 'api.meta.ai', pathPrefix: '' };
      target.providers['muse-code'] = { ...credential, host: 'api.meta.ai', pathPrefix: '/muse-code' };
    } else if (account.provider === 'xai') {
      // Grok Build sends subscription traffic to its CLI chat proxy (base /xai/v1).
      target.providers.xai = { ...credential, host: 'cli-chat-proxy.grok.com', pathPrefix: '' };
    } else if (account.provider === 'cursor') {
      // The Cursor CLI sends every backend call to CURSOR_API_ENDPOINT (/cursor).
      target.providers.cursor = { ...credential, host: 'api2.cursor.sh', pathPrefix: '' };
    } else target.providers[account.provider] = credential;
  }
  return next;
}

/** Each managed Anthropic admin key and its credential file. */
export function anthropicAdminKeys(directory) {
  const accounts = directory ? readAccountRegistry(directory) : [];
  return accounts.filter(a => a.provider === 'anthropic-admin').map(account => ({ account,
    file: path.join(directory, 'credentials', account.credentialId + '.json') }));
}
