#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const runDir = process.argv[2];
const startedAtMs = Number(process.argv[3]) || null;
if (!runDir) process.exit(0);

const read = async (name) => readFile(join(runDir, name), 'utf8').catch(() => '');
const [rawArgs, rawEvents, rawManifest, rawExit, rawPromptDispatchedAt, rawFirstOutputAt] = await Promise.all([
  read('args.json'),
  read('output.v1.jsonl'),
  read('output.v1.meta.json'),
  read('exit_code'),
  read('prompt_dispatched_at_ms'),
  read('first_output_at_ms'),
]);
let args = {};
try { args = JSON.parse(rawArgs); } catch {}
const parseJsonc = (raw) => JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, string) => string || '').replace(/,(\s*[}\]])/g, '$1'));
const wildcardMatches = (pattern, value) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i').test(value);
const loadPricing = async () => {
  if (args.pricing?.version === 1) return args.pricing;
  for (const file of [args.pricingPath, process.env.MODEL_PRICING_PATH, '/workspace/group/model_pricing.jsonc', '/workspace/ai-knowledge-base/data/model_pricing.jsonc'].filter(Boolean)) {
    try { return parseJsonc(await readFile(file, 'utf8')); } catch {}
  }
  return null;
};
const resolveRate = (pricing, modelName) => {
  if (!pricing?.models || !modelName) return null;
  if (pricing.models[modelName]) return { id: modelName, rate: pricing.models[modelName] };
  for (const [id, rate] of Object.entries(pricing.models)) if ((rate.aliases || []).some((alias) => wildcardMatches(alias, modelName))) return { id, rate };
  return null;
};
const calculateCost = (pricing, modelName, normalizedUsage) => {
  const resolved = resolveRate(pricing, modelName);
  if (!resolved || !normalizedUsage) return null;
  const { rate } = resolved;
  return { amount: ((normalizedUsage.inputTokens ?? 0) * rate.input + (normalizedUsage.cachedInputTokens ?? 0) * rate.cachedInput + (normalizedUsage.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.input) + (normalizedUsage.outputTokens ?? 0) * rate.output) / 1_000_000, currency: pricing.currency || 'USD', pricingModel: resolved.id, source: 'model_pricing.jsonc' };
};
let exitCode = Number.parseInt(rawExit.trim(), 10);
if (!Number.isFinite(exitCode)) exitCode = Number(process.env.RUN_EXIT_CODE || 1);
let manifest = {};
try { manifest = JSON.parse(rawManifest) ?? {}; } catch {}
let sessionId = null;
let model = null;
let terminalDurationMs = null;
let usage = null;
let assistantMessages = 0;
const usageEvents = [];
const tools = new Map();
const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
const usageFields = (event) => ({
  inputTokens: event.inputTokens ?? null,
  outputTokens: event.outputTokens ?? null,
  cachedInputTokens: event.cachedInputTokens ?? null,
  cacheWriteTokens: event.cacheWriteInputTokens ?? null,
  reasoningOutputTokens: event.reasoningOutputTokens ?? null,
});
const toolName = (name) => String(name).split('__').pop();
for (const line of rawEvents.split('\n')) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (!event || typeof event !== 'object') continue;
  if (event.type === 'session' && event.id) sessionId = event.id;
  else if (event.type === 'run') {
    if (event.model) model = event.model;
    if (['completed', 'interrupted', 'failed'].includes(event.status)) terminalDurationMs = typeof event.metrics?.durationMs === 'number' ? event.metrics.durationMs : null;
  } else if (event.type === 'message' && event.role === 'assistant' && event.status === 'completed') assistantMessages++;
  else if (event.type === 'usage') {
    usageEvents.push(event);
    const next = usageFields(event);
    if (event.scope === 'cumulative' || !usage) usage = next;
    else usage = Object.fromEntries(Object.keys(next).map((key) => [key, add(usage[key], next[key])]));
  } else if (event.type === 'tool_call' && event.id) {
    const tool = tools.get(event.id) ?? tools.set(event.id, { id: event.id, name: null, category: null, input: undefined }).get(event.id);
    tool.name ??= event.name ? toolName(event.name) : null;
    tool.category ??= event.category ?? null;
    if (event.input !== undefined) tool.input = event.input;
  }
}
if (usage) usage = { ...usage, raw: usageEvents };
sessionId ??= args.sessionId || null;
model ??= manifest.requestedModel || args.model || null;
const toolCalls = [...tools.values()].map((tool) => ({ id: tool.id, name: tool.name ?? tool.category ?? 'tool', kind: tool.category ?? 'tool', input: tool.input ?? {} }));
const steps = assistantMessages + toolCalls.length;
let durationMs = terminalDurationMs;
if (durationMs == null && startedAtMs != null) durationMs = Math.max(0, Date.now() - startedAtMs);
const pricing = await loadPricing();
let cost = null;
if (args.agentCmd === 'claude') {
  // The adapter validates the native session counters and publishes a per-turn
  // amount while holding the session lock. Never charge raw total_cost_usd here.
  try {
    const reported = JSON.parse(await read('claude-turn-cost.json'));
    if (typeof reported.amount === 'number' && Number.isFinite(reported.amount) && reported.amount >= 0) {
      cost = { amount: reported.amount, currency: 'USD', pricingModel: model, source: 'claude' };
    }
  } catch {}
}
cost ??= calculateCost(pricing, model, usage);
// Codex delegated threads (sub-agents) inherit the run's model unless told
// otherwise. Their usage is billed to this run but kept out of its token counts.
const subagentUsage = (await read('subagent-usage.jsonl')).split('\n').reduce((total, line) => {
  let value;
  try { value = JSON.parse(line); } catch { return total; }
  total ??= { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  total.inputTokens += Math.max(0, (value.inputTokens ?? 0) - (value.cachedInputTokens ?? 0));
  total.cachedInputTokens += value.cachedInputTokens ?? 0;
  total.cacheWriteTokens += value.cacheWriteInputTokens ?? 0;
  total.outputTokens += value.outputTokens ?? 0;
  return total;
}, null);
const subagentCost = calculateCost(pricing, model, subagentUsage);
if (subagentCost) {
  cost = !cost ? subagentCost : cost.currency === subagentCost.currency ? { ...cost, amount: cost.amount + subagentCost.amount } : cost;
}
const timestamp = (raw) => {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};
const promptDispatchedAtMs = timestamp(rawPromptDispatchedAt);
const firstOutputAtMs = timestamp(rawFirstOutputAt);
const timeToFirstOutputMs = promptDispatchedAtMs != null && firstOutputAtMs != null
  ? Math.max(0, firstOutputAtMs - promptDispatchedAtMs)
  : null;
const metrics = { version: 1, harness: args.agentCmd || null, model, sessionId, durationMs, promptDispatchedAtMs, firstOutputAtMs, timeToFirstOutputMs, exitCode, status: exitCode === 0 ? 'success' : 'error', usage, cost, costUsd: cost?.currency === 'USD' ? cost.amount : null, steps, toolCalls };
const target = join(runDir, 'metrics.json');
const tmp = `${target}.tmp.${process.pid}`;
await writeFile(tmp, JSON.stringify(metrics), 'utf8');
await rename(tmp, target);
