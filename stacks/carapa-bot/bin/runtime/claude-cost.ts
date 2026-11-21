type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const usageFields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export interface ClaudeCostSnapshot {
  sessionId: string;
  total: number;
  tokens: number[] | null;
}

/** Native costs can include previous warm/resumed turns. Verify the counter
 * boundary before taking a delta; unknown histories use the price calculator. */
export function claudeTurnCost(event: Json, previous: unknown, newSession: boolean, sameProcess = false): { amount: number | null; snapshot: ClaudeCostSnapshot | null } {
  const total = event.total_cost_usd;
  if (!nonnegative(total) || typeof event.session_id !== 'string' || !event.session_id) return { amount: null, snapshot: null };
  const models = Object.values(object(event.modelUsage)).map(object);
  const tokens = models.length && models.every(model => fields.every(field => nonnegative(model[field] ?? 0)))
    ? fields.map(field => models.reduce((sum, model) => sum + Number(model[field] ?? 0), 0)) : null;
  const usage = object(event.usage);
  const turn = nonnegative(usage.input_tokens) && nonnegative(usage.output_tokens) && usageFields.every(field => nonnegative(usage[field] ?? 0))
    ? usageFields.map(field => Number(usage[field] ?? 0)) : null;
  const snapshot = { sessionId: event.session_id, total, tokens };
  // The CLI guesses a price for models it does not know (e.g. Ollama Cloud
  // models behind the Claude harness); the configured pricing is authoritative.
  if (models.some(model => model.costBasis === 'unknown')) return { amount: null, snapshot };
  // A restarted CLI may reset its accounting even when it resumes the same ID.
  if (newSession || (tokens && turn && tokens.every((value, i) => value === turn[i]))) return { amount: total, snapshot };
  const prior = object(previous);
  const priorTokens = prior.tokens;
  const grew = prior.sessionId === event.session_id && nonnegative(prior.total) && total >= prior.total
    && tokens && Array.isArray(priorTokens) && priorTokens.length === tokens.length
    && tokens.every((value, i) => nonnegative(priorTokens[i]) && value >= priorTokens[i]);
  // Sub-agents and side models (e.g. Haiku for WebFetch) add to modelUsage and
  // total_cost_usd but not to the parent's result.usage, so the counters may
  // grow by more than this turn's own usage. Consecutive results of one CLI
  // process share its counters; a resumed CLI restores them, so they must have
  // grown by at least this turn's usage. A reset CLI fails that check unless
  // its first turn alone exceeds the whole prior session in every counter.
  if (grew && (sameProcess || (turn && tokens.every((value, i) => value - (priorTokens as number[])[i] >= turn[i])))) {
    return { amount: total - (prior.total as number), snapshot };
  }
  return { amount: null, snapshot };
}
