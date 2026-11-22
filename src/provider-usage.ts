// Read-only subscription usage lookups for managed provider accounts.
// These endpoints are the ones each vendor's own CLI uses; they are
// undocumented, so parsing is tolerant and failures never affect login state.
// @ts-ignore -- shared with the standalone relay
import { githubApi, validExpiryDate } from '../egress-proxy/api-relay/provider-account-config.mjs';

export type UsageWindow = { label: string; usedPercent: number; resetsAt?: number; models?: string[] };
/** Limit resets the plan has banked: each one refills the usage windows when redeemed in the vendor's own app. */
type UsageResets = { available: number; expiresAt?: number };
export type AccountUsage = { windows: UsageWindow[]; plan?: string; resets?: UsageResets; fetchedAt: number } | { error: string; fetchedAt: number };

const pct = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
};
const seconds = (value: unknown) => {
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isNaN(t) ? undefined : t; }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
};

function parseClaudeUsage(body: any): UsageWindow[] {
  // Windows the account does not have are omitted (Max 20x reports no 5-hour
  // window). `seven_day_overage_included` is the Fable-only weekly limit; the
  // Claude CLI names it "Fable limit".
  const labels: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_overage_included: 'Weekly (Fable)', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' };
  const windows: UsageWindow[] = Object.entries(labels).flatMap(([key, label]) => {
    const usedPercent = pct(body?.[key]?.utilization);
    return usedPercent === undefined ? [] : [{ label, usedPercent, resetsAt: seconds(body[key].resets_at) }];
  });
  // Newer responses report per-model limits (e.g. Fable) only in `limits`, as
  // `weekly_scoped` entries naming the model, with the old keys left null.
  for (const limit of Array.isArray(body?.limits) ? body.limits : []) {
    const model = limit?.scope?.model?.display_name;
    const usedPercent = pct(limit?.percent);
    if (limit?.kind !== 'weekly_scoped' || typeof model !== 'string' || usedPercent === undefined) continue;
    const label = `Weekly (${model})`;
    if (!windows.some(w => w.label === label)) windows.push({ label, usedPercent, resetsAt: seconds(limit.resets_at) });
  }
  return windows;
}

/** Claude's free limit resets (`cedar_ember`, returned only when the request asks for it). Each grant
 * counts its remaining resets until its end; an ineligible account reports none. */
function parseClaudeResets(body: any, now = Date.now()): UsageResets | undefined {
  const grants = body?.cedar_ember?.eligible === false ? [] : body?.cedar_ember?.grants;
  const live = (Array.isArray(grants) ? grants : []).flatMap((g: any) => {
    const left = Math.floor(Number(g?.resets_left)), end = seconds(g?.ends_at);
    return g?.paused || !(left > 0) || (end !== undefined && end <= now) ? [] : [{ left, end }];
  });
  if (!live.length) return undefined;
  const ends = live.flatMap(g => g.end === undefined ? [] : [g.end]);
  return { available: live.reduce((sum, g) => sum + g.left, 0), ...(ends.length ? { expiresAt: Math.min(...ends) } : {}) };
}

/** Codex's banked rate-limit resets; the expiry times are only on a separate endpoint. */
function parseCodexResets(body: any): UsageResets | undefined {
  const available = Math.floor(Number(body?.rate_limit_reset_credits?.available_count));
  return available > 0 ? { available } : undefined;
}

/** Muse subscription windows as api-relay last observed them in a model stream.
 * The snapshot can outlive a window, so a window past its reset is shown unused. */
export function parseMuseUsage(subscription: any, now = Date.now()): UsageWindow[] {
  return [[windowLabel(Number(subscription?.window?.window_duration_mins) * 60, '5-hour'), subscription?.window],
    ['Weekly', subscription?.weekly]].flatMap(([label, w]: any) => {
    const usedPercent = pct(w?.used_percent);
    if (usedPercent === undefined) return [];
    const resetsAt = seconds(w.resets_at);
    return [resetsAt !== undefined && resetsAt <= now ? { label, usedPercent: 0 } : { label, usedPercent, resetsAt }];
  });
}

// Codex's window names are positional: a free plan reports a monthly limit as
// "primary", so the label must come from the window's own length.
function windowLabel(secondsLong: unknown, fallback: string) {
  const days = Number(secondsLong) / 86400;
  if (!Number.isFinite(days) || days <= 0) return fallback;
  if (days < 1) return `${Math.round(days * 24)}-hour`;
  if (days < 6.5) return `${Math.round(days)}-day`;
  if (days < 8) return 'Weekly';
  return days >= 27 && days <= 32 ? 'Monthly' : `${Math.round(days)}-day`;
}

function parseCodexUsage(body: any): UsageWindow[] {
  const windows: Array<[string, any]> = [['5-hour', body?.rate_limit?.primary_window], ['Weekly', body?.rate_limit?.secondary_window]];
  return windows.flatMap(([fallback, w]) => {
    const usedPercent = pct(w?.used_percent);
    if (usedPercent === undefined) return [];
    const resetsAt = w.reset_at ? seconds(w.reset_at)
      : Number(w.reset_after_seconds) >= 0 ? Date.now() + Number(w.reset_after_seconds) * 1000 : undefined;
    return [{ label: windowLabel(w.limit_window_seconds, fallback), usedPercent, resetsAt }];
  });
}

// Antigravity reports remaining quota per model (~30 of them). Show one bar per
// model family instead, using its most-consumed model so the bar never understates
// usage, and hide the backend's internal helper models (chat_*, tab_*).
function antigravityFamily(id: string, name: string) {
  const text = `${id} ${name}`.toLowerCase();
  if (/^(chat|tab)_/.test(id)) return undefined;
  if (/claude|gpt-oss/.test(text)) return 'Claude / GPT-OSS';
  if (/pro/.test(text)) return 'Gemini Pro';
  if (/flash/.test(text)) return 'Gemini Flash';
  return /gemini/.test(text) ? 'Gemini (other)' : undefined;
}

// Each model reports one reset time for whichever of its two limits binds: a
// 5-hour window that opens on the first request, or a weekly cap. Name the
// window from that distance so a bar is not mistaken for the other limit.
function antigravityWindow(resetsAt: number | undefined, now: number) {
  if (resetsAt === undefined) return undefined;
  return resetsAt - now <= 6 * 3600_000 ? '5-hour' : 'Weekly';
}

function parseAntigravityUsage(body: any, now = Date.now()): UsageWindow[] {
  const families = new Map<string, UsageWindow & { models: string[] }>();
  for (const [id, model] of Object.entries<any>(body?.models ?? {})) {
    // proto3 JSON omits a zero fraction: an exhausted model reports only its reset time.
    const info = model?.quotaInfo;
    const remaining = info?.remainingFraction === undefined && info?.resetTime ? 0 : Number(info?.remainingFraction);
    if (!info || !Number.isFinite(remaining)) continue;
    const name = String(model.displayName || id);
    const label = antigravityFamily(id, name);
    if (!label) continue;
    const usedPercent = Math.round(pct((1 - remaining) * 100)! * 10) / 10;
    const family = families.get(label) ?? { label, usedPercent, resetsAt: seconds(model.quotaInfo.resetTime), models: [] };
    if (usedPercent > family.usedPercent) { family.usedPercent = usedPercent; family.resetsAt = seconds(model.quotaInfo.resetTime); }
    family.models.push(name === id ? name : `${name} (${id})`);
    families.set(label, family);
  }
  // Families reporting identical usage and reset time draw on one shared pool
  // (typical on free plans), so show them as a single bar.
  const pools = new Map<string, UsageWindow & { models: string[] }>();
  for (const family of families.values()) {
    const key = `${family.usedPercent}|${family.resetsAt}`;
    const pool = pools.get(key);
    if (!pool) { pools.set(key, { ...family, models: [...family.models] }); continue; }
    pool.label += ' + ' + family.label;
    pool.models.push(...family.models);
  }
  return [...pools.values()].map(pool => {
    const window = antigravityWindow(pool.resetsAt, now);
    return window ? { ...pool, label: `${window} · ${pool.label}` } : pool;
  });
}

/** Grok Build credits: proto3 JSON omits zero values, so a period without a
 * percentage has used none of its allowance. */
function parseGrokUsage(body: any): UsageWindow[] {
  const config = body?.config;
  const period = config?.currentPeriod;
  if (!period) return [];
  const limit = Number(config.monthlyLimit?.val);
  const usedPercent = pct(config.creditUsagePercent ?? (limit > 0 ? (Number(config.used?.val) || 0) / limit * 100 : 0));
  if (usedPercent === undefined) return [];
  const type = String(period.type || '');
  const label = type.endsWith('_WEEKLY') ? 'Weekly' : type.endsWith('_MONTHLY') ? 'Monthly'
    : windowLabel((Date.parse(period.end) - Date.parse(period.start)) / 1000, 'Credits');
  return [{ label, usedPercent, resetsAt: seconds(period.end) }];
}

/** Antigravity's quota and model list share one call. Only the native backend
 * hosts the relay itself accepts, never a stored arbitrary host. */
export function antigravityModelsRequest(credential: any): { url: string; init: RequestInit } | undefined {
  if (!credential?.project_id || !['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'].includes(credential.relayEndpoint)) return undefined;
  return { url: `https://${credential.relayEndpoint}/v1internal:fetchAvailableModels`,
    init: { method: 'POST', body: JSON.stringify({ project: credential.project_id }) } };
}

/** One read-only provider call; a non-2xx status returns no body. */
export async function providerJson(url: string, init: RequestInit | undefined, headers: Record<string, string>,
  request: typeof fetch, proxy: string | undefined): Promise<{ status: number; body?: any; headers?: Headers }> {
  const response = await request(url, { ...init, headers: { accept: 'application/json',
    ...(init?.body ? { 'content-type': 'application/json' } : {}), ...headers },
    redirect: 'error', signal: AbortSignal.timeout(10_000), ...(proxy ? { proxy } : {}) } as RequestInit);
  return response.ok ? { status: response.status, body: await response.json(), headers: response.headers } : { status: response.status };
}

/** Cursor's included usage for the billing cycle, as its CLI reports it: total,
 * Auto and API shares. Proto3 JSON omits zero values, so a missing share is unused. */
function parseCursorUsage(body: any): UsageWindow[] {
  const plan = body?.planUsage;
  const start = Number(body?.billingCycleStart), end = Number(body?.billingCycleEnd);
  if (!plan || !Number.isFinite(end) || end <= 0) return [];
  const period = windowLabel((end - start) / 1000, 'Billing cycle');
  return ([['', plan.totalPercentUsed], [' (Auto)', plan.autoPercentUsed], [' (API)', plan.apiPercentUsed]] as const)
    .map(([suffix, value]) => ({ label: period + suffix, usedPercent: pct(value ?? 0)!, resetsAt: end }));
}

type Spec = { url: string; init?: RequestInit; headers?: Record<string, string>; parse: (body: any) => UsageWindow[]; resets?: (body: any) => UsageResets | undefined };

// The reset grants are returned only to a request that asks for them as the Claude CLI does.
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.326 (external, cli)';
function specFor(provider: string, credential: any): Spec | undefined {
  if (provider === 'anthropic') return { url: 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1',
    headers: { 'user-agent': CLAUDE_CLI_USER_AGENT }, parse: parseClaudeUsage, resets: parseClaudeResets };
  if (provider === 'codex') return { url: 'https://chatgpt.com/backend-api/wham/usage', parse: parseCodexUsage, resets: parseCodexResets };
  if (provider === 'xai') return { url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', parse: parseGrokUsage };
  // Connect's JSON encoding of the dashboard call the CLI makes in binary.
  if (provider === 'cursor') return { url: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    init: { method: 'POST', body: '{}' }, headers: { 'connect-protocol-version': '1' }, parse: parseCursorUsage };
  if (provider === 'antigravity') {
    const call = antigravityModelsRequest(credential);
    return call && { ...call, parse: parseAntigravityUsage };
  }
}

export async function fetchAccountUsage(provider: string, headers: Record<string, string>, request: typeof fetch = fetch,
  credential?: any, proxy = process.env.PROVIDER_USAGE_PROXY): Promise<AccountUsage> {
  const fetchedAt = Date.now();
  const spec = specFor(provider, credential);
  if (!spec) return { error: provider === 'antigravity' ? 'Antigravity onboarding is incomplete' : 'Usage is not available for this provider', fetchedAt };
  try {
    const { status, body } = await providerJson(spec.url, spec.init, { ...headers, ...spec.headers }, request, proxy);
    if (!body) return { error: `Provider returned ${status}`, fetchedAt };
    const windows = spec.parse(body);
    if (!windows.length) return { error: 'Provider returned no usage windows', fetchedAt };
    const resets = spec.resets?.(body);
    return { windows, plan: typeof body?.plan_type === 'string' ? body.plan_type : undefined, ...(resets ? { resets } : {}), fetchedAt };
  } catch { return { error: 'Usage lookup failed', fetchedAt }; }
}

/** Mistral's monthly allowances from /v1/billing/budget: the API/Studio
 * allowance and the plan's included Vibe Code usage, each as a usage window
 * with its amount. Only the global host serves it; the EU host has no billing. */
const MISTRAL_BUDGET_URL = 'https://api.mistral.ai/v1/billing/budget';

function parseMistralBudget(body: any): UsageWindow[] {
  const money = (value: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
  return ([['api_budget', 'API'], ['vibe_budget', 'Vibe Code']] as const).flatMap(([key, name]) => {
    const budget = body?.[key];
    const percent = Number(budget?.usage_percentage), limit = Number(budget?.initial_budget);
    if (!Number.isFinite(percent) || !Number.isFinite(limit) || limit <= 0) return [];
    const currency = typeof budget.currency === 'string' && /^[A-Z]{3}$/.test(budget.currency) ? budget.currency : 'EUR';
    const resetsAt = Date.parse(budget.reset_at);
    return [{ label: `${name} · ${money(limit * percent / 100, currency)} of ${money(limit, currency)}`,
      usedPercent: Math.max(0, percent), ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }];
  });
}

export async function fetchMistralBudget(key: string, request: typeof fetch = fetch,
  proxy = process.env.PROVIDER_USAGE_PROXY): Promise<AccountUsage> {
  try {
    const { status, body } = await providerJson(MISTRAL_BUDGET_URL, undefined, { authorization: `Bearer ${key}` }, request, proxy);
    const windows = body ? parseMistralBudget(body) : [];
    return windows.length ? { windows, fetchedAt: Date.now() } : { error: `Mistral billing answered ${status}`, fetchedAt: Date.now() };
  } catch {
    return { error: 'Mistral billing unavailable', fetchedAt: Date.now() };
  }
}

/** Read-only endpoints that accept exactly the key each API-key account route sends. */
type KeyCheck = { url: string; headers: (key: string) => Record<string, string>; init?: (key: string) => RequestInit };
const KEY_CHECKS: Record<string, KeyCheck> = {
  'mistral-eu': { url: 'https://api.eu.mistral.ai/v1/models', headers: key => ({ authorization: `Bearer ${key}` }) },
  'mistral-vibe': { url: 'https://api.eu.mistral.ai/v1/models', headers: key => ({ authorization: `Bearer ${key}` }) },
  openrouter: { url: 'https://openrouter.ai/api/v1/key', headers: key => ({ authorization: `Bearer ${key}` }) },
  'anthropic-api': { url: 'https://api.anthropic.com/v1/models', headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }) },
  openai: { url: 'https://api.openai.com/v1/models', headers: key => ({ authorization: `Bearer ${key}` }) },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: key => ({ 'x-goog-api-key': key }) },
  // NVIDIA's model list is public; its NGC account lookup checks the key.
  nvidia: { url: 'https://api.ngc.nvidia.com/v3/keys/get-caller-info',
    headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
    init: key => ({ method: 'POST', body: new URLSearchParams({ credentials: key }).toString() }) },
  // Typesafe answers 401 to a wrong key before it reads the request.
  jev: { url: 'https://api.typesafe.ai/v1/systemone', headers: key => ({ authorization: `Bearer ${key}` }),
    init: () => ({ method: 'POST', body: '{}' }) },
  'anthropic-admin': { url: 'https://api.anthropic.com/v1/organizations/me', headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }) },
};

/** GitHub answers its user lookup only with a User-Agent. */
function githubKeyCheck(host: string): KeyCheck {
  const api = githubApi(host);
  return { url: `https://${api.host}${api.pathPrefix}/user`,
    headers: key => ({ authorization: `Bearer ${key}`, accept: 'application/vnd.github+json', 'user-agent': 'carapa-box' }) };
}

export type KeyCheckResult = 'valid' | 'rejected' | 'needsWorkspace' | 'unavailable';

/** The expiry date (`YYYY-MM-DD`) a code host reports for a valid token; undefined when it reports none or never expires. */
function reportedExpiry(provider: string, body: any, headers?: Headers): string | undefined {
  // GitLab: `expires_at` is null for a token that never expires. GitHub: `2026-12-01 10:00:00 UTC`, absent when unknown.
  const date = provider === 'gitlab' ? body?.expires_at : headers?.get('github-authentication-token-expiration')?.slice(0, 10);
  return validExpiryDate(date) ? date : undefined;
}

/** Whether the provider accepts an API key, and for GitLab and GitHub tokens the expiry date it reports. */
export async function inspectProviderKey(provider: string, key: string, request: typeof fetch = fetch,
  proxy = process.env.PROVIDER_USAGE_PROXY, options: { workspaceId?: string; host?: string } = {}): Promise<{ result: KeyCheckResult; expiresAt?: string }> {
  const { workspaceId, host } = options;
  const check = provider === 'gitlab' && host
    ? { url: `https://${host}/api/v4/personal_access_tokens/self`, headers: (k: string) => ({ 'PRIVATE-TOKEN': k }) } as KeyCheck
    : provider === 'github' && host ? githubKeyCheck(host) : KEY_CHECKS[provider];
  if (!check) return { result: 'unavailable' };
  try {
    const headers = { ...check.headers(key), ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}) };
    const { status, body, headers: responseHeaders } = await providerJson(check.url, check.init?.(key), headers, request, proxy);
    if (status === 200) {
      const expiresAt = reportedExpiry(provider, body, responseHeaders);
      return expiresAt ? { result: 'valid', expiresAt } : { result: 'valid' };
    }
    // Typesafe checks the key before the (empty) request: any other client error means the key passed.
    if (provider === 'jev' && status !== 401 && status !== 403 && status < 500) return { result: 'valid' };
    // Anthropic answers 400 when an organisation-wide key names no workspace.
    if (status === 400 && provider === 'anthropic-api' && !workspaceId) return { result: 'needsWorkspace' };
    return { result: [400, 401, 403, 404].includes(status) ? 'rejected' : 'unavailable' };
  } catch { return { result: 'unavailable' }; }
}
