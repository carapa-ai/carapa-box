// Read-only model lists for managed provider accounts, from the endpoints each
// vendor's own CLI uses. They are undocumented, so parsing is tolerant; Board
// combines them with the models each harness reports.
import { antigravityModelsRequest, providerJson } from './provider-usage.js';

export type DiscoveredModel = {
  id: string; name?: string; contextSize?: number; maxOutputTokens?: number;
  reasoning?: string[]; defaultReasoning?: string; inputs?: string[];
  /** Oldest harness client the provider serves this model to. */
  minClientVersion?: string;
};
export type AccountModels = { models: DiscoveredModel[]; fetchedAt: number } | { error: string; fetchedAt: number };

const count = (value: unknown) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const texts = (value: unknown) => Array.isArray(value) ? value.filter(text) : undefined;
const compact = (model: DiscoveredModel) =>
  Object.fromEntries(Object.entries(model).filter(([, v]) => v !== undefined)) as DiscoveredModel;

export function parseAnthropicModels(body: any): DiscoveredModel[] {
  return (Array.isArray(body?.data) ? body.data : []).flatMap((m: any) => !text(m?.id) ? [] : [compact({
    id: m.id, name: text(m.display_name), contextSize: count(m.max_input_tokens), maxOutputTokens: count(m.max_tokens) })]);
}

// Hidden entries are Codex's own helpers (auto review, reserve capacity).
export function parseCodexModels(body: any): DiscoveredModel[] {
  return (Array.isArray(body?.models) ? body.models : []).flatMap((m: any) => !text(m?.slug) || m.visibility === 'hide' ? [] : [compact({
    id: m.slug, name: text(m.display_name), contextSize: count(m.context_window),
    reasoning: texts(Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((r: any) => r?.effort) : undefined),
    defaultReasoning: text(m.default_reasoning_level), inputs: texts(m.input_modalities),
    minClientVersion: text(m.minimal_client_version) })]);
}

// Unnamed and chat_*/tab_* entries are the backend's internal helper models.
export function parseAntigravityModels(body: any): DiscoveredModel[] {
  return Object.entries<any>(body?.models ?? {}).flatMap(([id, m]) =>
    !text(m?.displayName) || m.isInternal || /^(chat|tab)_/.test(id) ? [] : [compact({
      id, name: m.displayName, contextSize: count(m.maxTokens), maxOutputTokens: count(m.maxOutputTokens),
      inputs: m.supportsImages ? ['text', 'image'] : undefined })]);
}

type Spec = { url: string; init?: RequestInit; headers?: Record<string, string>; parse: (body: any) => DiscoveredModel[] };
function specFor(provider: string, credential: any): Spec | undefined {
  if (provider === 'anthropic') return { url: 'https://api.anthropic.com/v1/models?limit=1000',
    headers: { 'anthropic-version': '2023-06-01' }, parse: parseAnthropicModels };
  // Codex omits models newer than the client; ask as the newest client and
  // report each model's minimum version instead.
  if (provider === 'codex') return { url: 'https://chatgpt.com/backend-api/codex/models?client_version=999.0.0', parse: parseCodexModels };
  if (provider === 'antigravity') {
    const call = antigravityModelsRequest(credential);
    return call && { ...call, parse: parseAntigravityModels };
  }
}

export async function fetchAccountModels(provider: string, headers: Record<string, string>, request: typeof fetch = fetch,
  credential?: any, proxy = process.env.PROVIDER_USAGE_PROXY): Promise<AccountModels> {
  const fetchedAt = Date.now();
  const spec = specFor(provider, credential);
  // Grok and Muse report their models through their harness instead.
  if (!spec) return { error: provider === 'antigravity' ? 'Antigravity onboarding is incomplete' : 'Model list is not available for this provider', fetchedAt };
  try {
    const { status, body } = await providerJson(spec.url, spec.init, { ...headers, ...spec.headers }, request, proxy);
    if (!body) return { error: `Provider returned ${status}`, fetchedAt };
    const models = spec.parse(body);
    return models.length ? { models, fetchedAt } : { error: 'Provider returned no models', fetchedAt };
  } catch { return { error: 'Model lookup failed', fetchedAt }; }
}
