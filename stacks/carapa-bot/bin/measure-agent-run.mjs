#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const runDir = process.argv[2];
const startedAtMs = Number(process.argv[3]) || null;
if (!runDir) process.exit(0);

const read = async (name) => readFile(join(runDir, name), 'utf8').catch(() => '');
const [rawArgs, liveOutput, archivedOutput, rawExit, rawPromptDispatchedAt, rawFirstOutputAt] = await Promise.all([
  read('args.json'),
  read('output.jsonl'),
  read('output.jsonl.archived'),
  read('exit_code'),
  read('prompt_dispatched_at_ms'),
  read('first_output_at_ms'),
]);
// The host may observe exit_code and archive output.jsonl before this EXIT trap
// runs. Prefer the live stream, but measure the archived copy when that race
// has already happened.
const output = liveOutput || archivedOutput;
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
let sessionId = args.sessionId || null;
let model = args.model || null;
let durationMs = null;
let usage = null;
let incrementalCodexUsage = null;
let piUsage = null;
const seenPiMessages = new Set();
let steps = 0;
let claudeResults = 0;
const seenResults = new Set();
const toolCalls = [];
const seenItems = new Set();
const addTool = (id, name, kind, input = {}) => {
  const key = id || `${kind}:${toolCalls.length}`;
  if (seenItems.has(key)) return;
  seenItems.add(key);
  toolCalls.push({ id: id || null, name: String(name).split('__').pop(), kind, input });
};
const normalizeClaudeUsage = (event) => {
  // result.usage belongs to this turn; modelUsage includes earlier resumed or
  // warm turns and would charge/count the conversation again on every run.
  if (event.usage) return { inputTokens: event.usage.input_tokens ?? null, outputTokens: event.usage.output_tokens ?? null, cachedInputTokens: event.usage.cache_read_input_tokens ?? null, cacheWriteTokens: event.usage.cache_creation_input_tokens ?? null, reasoningOutputTokens: event.usage.output_tokens_details?.thinking_tokens ?? null, raw: event.usage };
  const models = event.modelUsage && typeof event.modelUsage === 'object' ? Object.values(event.modelUsage) : [];
  if (models.length) return {
    inputTokens: models.reduce((n, value) => n + (value?.inputTokens ?? 0), 0),
    outputTokens: models.reduce((n, value) => n + (value?.outputTokens ?? 0), 0),
    cachedInputTokens: models.reduce((n, value) => n + (value?.cacheReadInputTokens ?? 0), 0),
    cacheWriteTokens: models.reduce((n, value) => n + (value?.cacheCreationInputTokens ?? 0), 0),
    reasoningOutputTokens: null,
    raw: event.modelUsage,
  };
  return null;
};
for (const line of output.split('\n')) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
  if ((event.type === 'system' || event.type === 'result') && event.session_id) sessionId = event.session_id;
  if (event.model || event.model_name || event.message?.model) model = event.model || event.model_name || event.message.model;
  if (event.type === 'result' && !event.parent_tool_use_id && !(event.uuid && seenResults.has(event.uuid))) {
    // A run kept open by background tasks, steers or corrections emits one
    // top-level result per turn; result.usage/num_turns/duration_ms are per turn.
    if (event.uuid) seenResults.add(event.uuid);
    const first = claudeResults++ === 0;
    if (typeof event.duration_ms === 'number') durationMs = (first ? 0 : durationMs ?? 0) + event.duration_ms;
    if (typeof event.num_turns === 'number') steps = (first ? 0 : steps) + event.num_turns;
    const turn = normalizeClaudeUsage(event);
    if (turn && event.usage && usage && !first) {
      const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
      usage = {
        inputTokens: add(usage.inputTokens, turn.inputTokens),
        outputTokens: add(usage.outputTokens, turn.outputTokens),
        cachedInputTokens: add(usage.cachedInputTokens, turn.cachedInputTokens),
        cacheWriteTokens: add(usage.cacheWriteTokens, turn.cacheWriteTokens),
        reasoningOutputTokens: add(usage.reasoningOutputTokens, turn.reasoningOutputTokens),
        raw: [].concat(usage.raw, turn.raw),
      };
    } else usage = turn ?? usage;
  }
  if (event.type === 'turn.completed' && event.usage) {
    const cachedInputTokens = event.usage.cached_input_tokens ?? 0;
    usage = { inputTokens: event.usage.input_tokens == null ? null : Math.max(0, event.usage.input_tokens - cachedInputTokens), outputTokens: event.usage.output_tokens ?? null, cachedInputTokens, cacheWriteTokens: event.usage.cache_write_input_tokens ?? null, reasoningOutputTokens: event.usage.reasoning_output_tokens ?? null, raw: event.usage };
  }
  if (event.type === 'turn.usage' && event.usage) {
    const value = event.usage;
    incrementalCodexUsage ??= {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
      raw: [],
    };
    incrementalCodexUsage.inputTokens += Math.max(0, (value.input_tokens ?? 0) - (value.cached_input_tokens ?? 0));
    incrementalCodexUsage.outputTokens += value.output_tokens ?? 0;
    incrementalCodexUsage.cachedInputTokens += value.cached_input_tokens ?? 0;
    incrementalCodexUsage.cacheWriteTokens += value.cache_write_input_tokens ?? 0;
    incrementalCodexUsage.reasoningOutputTokens += value.reasoning_output_tokens ?? 0;
    incrementalCodexUsage.raw.push(value);
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage && typeof event.message.usage === 'object') {
    // Pi emits one message_end per assistant turn; agent_end only repeats them
    // (and may carry earlier runs of a resumed session), so it is not summed.
    const message = event.message;
    const key = message.responseId ?? message.id;
    if (key == null || !seenPiMessages.has(key)) {
      if (key != null) seenPiMessages.add(key);
      const value = message.usage;
      const add = (total, next) => (total == null && next == null ? null : (total ?? 0) + (next ?? 0));
      piUsage ??= { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningOutputTokens: null, raw: [] };
      piUsage.inputTokens = add(piUsage.inputTokens, value.input);
      piUsage.outputTokens = add(piUsage.outputTokens, value.output);
      piUsage.cachedInputTokens = add(piUsage.cachedInputTokens, value.cacheRead);
      piUsage.cacheWriteTokens = add(piUsage.cacheWriteTokens, value.cacheWrite);
      piUsage.reasoningOutputTokens = add(piUsage.reasoningOutputTokens, value.reasoning);
      piUsage.raw.push(value);
      // A message_end without usage (e.g. an aborted turn) adds no step.
      steps++;
      for (const block of Array.isArray(message.content) ? message.content : []) if (block?.type === 'toolCall' && block.name) addTool(block.id, String(block.name).split('__').pop(), 'tool', block.arguments || {});
    }
  }
  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    const assistant = event.messages.findLast?.((message) => message?.role === 'assistant')
      ?? [...event.messages].reverse().find((message) => message?.role === 'assistant');
    if (assistant?.model) model = assistant.model;
    if (assistant?.usage) {
      const value = assistant.usage;
      usage = {
        inputTokens: value.input ?? null,
        outputTokens: value.output ?? null,
        cachedInputTokens: value.cacheRead ?? null,
        cacheWriteTokens: value.cacheWrite ?? null,
        reasoningOutputTokens: value.reasoning ?? null,
        raw: value,
      };
    }
  }
  if ((event.type === 'item.started' || event.type === 'item.completed') && event.item) {
    const item = event.item;
    if (event.type === 'item.completed' && item.type !== 'reasoning') steps++;
    if (item.type === 'mcp_tool_call' && item.tool) addTool(item.id, item.tool, 'mcp', item.arguments || {});
    else if (['command_execution', 'file_change', 'web_search'].includes(item.type)) addTool(item.id, item.type, item.type, item);
  }
  if (event.type === 'tool_use' && event.name) addTool(event.id, String(event.name).split('__').pop(), 'tool', event.input || {});
  for (const block of event.message?.content || []) if (block.type === 'tool_use' && block.name) addTool(block.id, String(block.name).split('__').pop(), 'tool', block.input || {});
}
usage = incrementalCodexUsage ?? piUsage ?? usage;
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
