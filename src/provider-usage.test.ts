import { expect, test } from 'bun:test';
import { type KeyCheckResult, checkProviderKey, fetchAccountUsage, fetchMistralBudget, inspectProviderKey, parseMuseUsage } from './provider-usage.js';

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('Claude and Codex usage payloads normalize to percent windows', async () => {
  const claude = await fetchAccountUsage('anthropic', {}, respond({
    five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 7.5, resets_at: null },
    seven_day_overage_included: { utilization: 20, resets_at: null } }));
  expect('windows' in claude && claude.windows.map(w => [w.label, w.usedPercent])).toEqual([['5-hour', 42], ['Weekly', 7.5], ['Weekly (Fable)', 20]]);
  // Current responses carry the Fable limit only in `limits`.
  const scoped = await fetchAccountUsage('anthropic', {}, respond({ five_hour: null, seven_day: { utilization: 71, resets_at: null },
    limits: [{ kind: 'weekly_all', percent: 71, scope: null },
      { kind: 'weekly_scoped', percent: 7, resets_at: '2030-01-01T00:00:00Z', scope: { model: { display_name: 'Fable' } } }] }));
  expect('windows' in scoped && scoped.windows).toEqual([{ label: 'Weekly', usedPercent: 71, resetsAt: undefined },
    { label: 'Weekly (Fable)', usedPercent: 7, resetsAt: Date.parse('2030-01-01T00:00:00Z') }]);
  const codex = await fetchAccountUsage('codex', {}, respond({ plan_type: 'pro', rate_limit: {
    primary_window: { used_percent: 10, reset_after_seconds: 60 }, secondary_window: { used_percent: 250, reset_at: 1893456000 } } }));
  expect('windows' in codex && codex.windows.map(w => w.usedPercent)).toEqual([10, 100]);
  expect('plan' in codex && codex.plan).toBe('pro');
});

test('Grok credits report the current period, treating an omitted percentage as unused', async () => {
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-15T00:00:00+00:00', end: '2026-10-22T00:00:00+00:00' };
  const fresh = await fetchAccountUsage('xai', {}, respond({ config: { currentPeriod: period, isUnifiedBillingUser: true } }));
  expect('windows' in fresh && fresh.windows).toEqual([{ label: 'Weekly', usedPercent: 0, resetsAt: Date.parse(period.end) }]);
  const used = await fetchAccountUsage('xai', {}, respond({ config: { currentPeriod: period, creditUsagePercent: 37.5 } }));
  expect('windows' in used && used.windows.map(w => w.usedPercent)).toEqual([37.5]);
});

test('Codex window labels follow the window length, not its position', async () => {
  const free = await fetchAccountUsage('codex', {}, respond({ rate_limit: {
    primary_window: { used_percent: 3, limit_window_seconds: 2592000, reset_after_seconds: 2246400 } } }));
  expect('windows' in free && free.windows.map(w => w.label)).toEqual(['Monthly']);
  const paid = await fetchAccountUsage('codex', {}, respond({ rate_limit: {
    primary_window: { used_percent: 3, limit_window_seconds: 18000 }, secondary_window: { used_percent: 1, limit_window_seconds: 604800 } } }));
  expect('windows' in paid && paid.windows.map(w => w.label)).toEqual(['5-hour', 'Weekly']);
});

test('Antigravity quota is shown per model family, hides internal models, and calls only native backends', async () => {
  let called = '';
  const quota = (remainingFraction: number) => ({ remainingFraction, resetTime: '2030-01-01T00:00:00Z' });
  const request = (async (url: string) => { called = url; return new Response(JSON.stringify({ models: {
    a: { displayName: 'Gemini 3.1 Pro (Low)', quotaInfo: quota(0.75) },
    b: { displayName: 'Gemini 3.1 Pro (High)', quotaInfo: quota(0.25) },
    c: { displayName: 'Claude Sonnet', quotaInfo: quota(1) },
    d: { displayName: 'Gemini 3.8 Flash (Low)', quotaInfo: quota(0.9) },
    chat_20706: { quotaInfo: quota(0) }, tab_flash_lite_preview: { quotaInfo: quota(0) },
    e: { displayName: 'No quota' } } })); }) as unknown as typeof fetch;
  const usage = await fetchAccountUsage('antigravity', {}, request, { project_id: 'p', relayEndpoint: 'cloudcode-pa.googleapis.com' });
  expect('windows' in usage && usage.windows.map(w => [w.label, w.usedPercent, w.models?.length])).toEqual(
    [['Weekly · Gemini Pro', 75, 2], ['Weekly · Claude / GPT-OSS', 0, 1], ['Weekly · Gemini Flash', 10, 1]]);
  expect(called).toBe('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
});

test('Antigravity families that share one quota pool are shown as a single bar', async () => {
  const quota = { remainingFraction: 0.5, resetTime: '2030-01-01T00:00:00Z' };
  const usage = await fetchAccountUsage('antigravity', {}, (async () => new Response(JSON.stringify({ models: {
    a: { displayName: 'Gemini 3.1 Pro', quotaInfo: quota }, b: { displayName: 'Gemini 3.7 Flash', quotaInfo: quota } } }))) as unknown as typeof fetch,
    { project_id: 'p', relayEndpoint: 'cloudcode-pa.googleapis.com' });
  expect('windows' in usage && usage.windows.map(w => [w.label, w.usedPercent, w.models?.length])).toEqual([['Weekly · Gemini Pro + Gemini Flash', 50, 2]]);
  // An exhausted pool omits the zero remainingFraction and must show as fully used, not vanish.
  // A reset within hours is the 5-hour window, not the weekly cap.
  const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  const exhausted = { resetTime: soon(4) };
  const empty = await fetchAccountUsage('antigravity', {}, (async () => new Response(JSON.stringify({ models: {
    a: { displayName: 'Gemini 4 Hydrogen (High)', quotaInfo: exhausted }, c: { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 1, resetTime: soon(5) } } } }))) as unknown as typeof fetch,
    { project_id: 'p', relayEndpoint: 'cloudcode-pa.googleapis.com' });
  expect('windows' in empty && empty.windows.map(w => [w.label, w.usedPercent])).toEqual([['5-hour · Gemini (other)', 100], ['5-hour · Claude / GPT-OSS', 0]]);
});

test('Cursor usage shows the billing cycle total, Auto and API shares, treating an omitted share as unused', async () => {
  const end = 1794381647819;
  const usage = await fetchAccountUsage('cursor', {}, respond({ billingCycleStart: String(end - 31 * 86400_000), billingCycleEnd: String(end),
    planUsage: { totalSpend: 8, autoPercentUsed: 8, totalPercentUsed: 4 } }));
  expect('windows' in usage && usage.windows).toEqual([
    { label: 'Monthly', usedPercent: 4, resetsAt: end }, { label: 'Monthly (Auto)', usedPercent: 8, resetsAt: end },
    { label: 'Monthly (API)', usedPercent: 0, resetsAt: end }]);
});

test('a saved Muse window past its reset time is shown as unused', () => {
  const subscription = { window: { resets_at: 1000, used_percent: 101, window_duration_mins: 300 }, weekly: { resets_at: 3000, used_percent: 33 } };
  expect(parseMuseUsage(subscription, 2_000_000)).toEqual([
    { label: '5-hour', usedPercent: 0 }, { label: 'Weekly', usedPercent: 33, resetsAt: 3_000_000 }]);
});

test('usage failures and unsupported providers report an error instead of throwing', async () => {
  expect(await fetchAccountUsage('anthropic', {}, respond({}, 401))).toMatchObject({ error: 'Provider returned 401' });
  expect(await fetchAccountUsage('anthropic', {}, respond({ unexpected: true }))).toMatchObject({ error: expect.any(String) });
  expect(await fetchAccountUsage('antigravity', {}, respond({}), { project_id: 'p', relayEndpoint: 'evil.example' })).toMatchObject({ error: expect.any(String) });
});

test('Mistral budget reports the API and Vibe Code allowances with their amounts', async () => {
  const reset = '2026-12-01T00:00:00Z';
  const budget = await fetchMistralBudget('key', respond({
    vibe_budget: { usage_percentage: 0.0179824, initial_budget: 255, currency: 'EUR', reset_at: reset },
    api_budget: { usage_percentage: 7.3102402, initial_budget: 25.5, currency: 'EUR', reset_at: reset } }));
  expect('windows' in budget && budget.windows).toEqual([
    { label: 'API · €1.86 of €25.50', usedPercent: 7.3102402, resetsAt: Date.parse(reset) },
    { label: 'Vibe Code · €0.05 of €255.00', usedPercent: 0.0179824, resetsAt: Date.parse(reset) },
  ]);
  expect(await fetchMistralBudget('key', respond({}, 401))).toMatchObject({ error: 'Mistral billing answered 401' });
});

test('GitLab and GitHub tokens report the expiry date their host sends; failures never look like a verdict', async () => {
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  const gitlab = { host: 'gitlab.example.com' }, github = { host: 'github.com' };
  const cases: [string, { host: string }, typeof fetch, { result: KeyCheckResult; expiresAt?: string }][] = [
    ['gitlab', gitlab, reply(200, { expires_at: '2026-12-01' }), { result: 'valid', expiresAt: '2026-12-01' }],
    ['gitlab', gitlab, reply(200, { expires_at: null }), { result: 'valid' }],
    ['gitlab', gitlab, reply(200, { expires_at: '2026-13-40' }), { result: 'valid' }],
    ['github', github, reply(200, {}, { 'github-authentication-token-expiration': '2026-12-01 10:00:00 UTC' }), { result: 'valid', expiresAt: '2026-12-01' }],
    ['github', github, reply(200), { result: 'valid' }],
    ['github', github, reply(401), { result: 'rejected' }],
    ['github', github, reply(500), { result: 'unavailable' }],
    ['gitlab', gitlab, (async () => { throw new Error('offline'); }) as unknown as typeof fetch, { result: 'unavailable' }],
  ];
  for (const [provider, options, request, expected] of cases) {
    expect(await inspectProviderKey(provider, 'test-key-1234', request, undefined, options)).toEqual(expected);
    expect(await checkProviderKey(provider, 'test-key-1234', request, undefined, options)).toBe(expected.result);
  }
});

test('Claude and Codex usage report the limit resets still available', async () => {
  const future = '2030-01-01T00:00:00Z';
  const claude = await fetchAccountUsage('anthropic', {}, respond({ five_hour: { utilization: 1, resets_at: null }, cedar_ember: { eligible: true, grants: [
    { id: 'a', resets_left: 1, ends_at: future, paused: false }, { id: 'b', resets_left: 2, ends_at: '2031-01-01T00:00:00Z' },
    { id: 'spent', resets_left: 0, ends_at: future }, { id: 'old', resets_left: 3, ends_at: '2020-01-01T00:00:00Z' }] } }));
  expect('resets' in claude && claude.resets).toEqual({ available: 3, expiresAt: Date.parse(future) });
  const ineligible = await fetchAccountUsage('anthropic', {}, respond({ five_hour: { utilization: 1 }, cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] } }));
  expect('resets' in ineligible).toBe(false);
  const codex = await fetchAccountUsage('codex', {}, respond({ rate_limit: { primary_window: { used_percent: 1 } }, rate_limit_reset_credits: { available_count: 2 } }));
  expect('resets' in codex && codex.resets).toEqual({ available: 2 });
});
