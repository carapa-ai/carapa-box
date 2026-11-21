import { expect, test } from 'bun:test';
import { claudeTurnCost } from './claude-cost';

// Captured turn/session totals from conv-1790155314372-ksa3tp.
const first = {
  session_id: 'session', total_cost_usd: 0.257788,
  usage: { input_tokens: 2, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 51388 },
  modelUsage: { opus: { inputTokens: 2, outputTokens: 42, cacheReadInputTokens: 0, cacheCreationInputTokens: 51388 } },
};
const second = {
  session_id: 'session', total_cost_usd: 0.31396100000000005,
  usage: { input_tokens: 4, output_tokens: 25, cache_read_input_tokens: 42410, cache_creation_input_tokens: 9435 },
  modelUsage: { opus: { inputTokens: 6, outputTokens: 67, cacheReadInputTokens: 42410, cacheCreationInputTokens: 60823 } },
};

test('native cost charges only the current warm/resumed turn', () => {
  const initial = claudeTurnCost(first, undefined, true);
  expect(initial.amount).toBe(0.257788);
  expect(claudeTurnCost(second, initial.snapshot, false).amount).toBeCloseTo(0.056173, 10);
});

test('unknown, mismatched, and incomplete histories fall back instead of charging session totals', () => {
  const initial = claudeTurnCost(first, undefined, true).snapshot!;
  for (const previous of [undefined, {}, { ...initial, sessionId: 'other' }, { ...initial, tokens: [1e9, 1, 0, 0] }, { ...initial, total: 1 }]) {
    const cost = claudeTurnCost(second, previous, false);
    expect(cost.amount).toBeNull();
    expect(cost.snapshot?.total).toBe(second.total_cost_usd);
  }
});

test('a resumed CLI with reset counters uses its current-turn native cost', () => {
  // Higher than the prior total: merely checking for a negative delta is unsafe.
  const reset = { ...first, total_cost_usd: 0.4 };
  expect(claudeTurnCost(reset, claudeTurnCost(second, undefined, false).snapshot, false).amount).toBe(0.4);
});

test('a guessed native price for a model the CLI does not know leaves the calculator in charge', () => {
  // Captured from conv-1792522164764-6xnj7n: Opus-level guess for an Ollama Cloud model.
  const minimax = {
    session_id: 'session', total_cost_usd: 0.18240649999999997,
    usage: { input_tokens: 36396, output_tokens: 13, cache_read_input_tokens: 203, cache_creation_input_tokens: 0 },
    modelUsage: { 'minimax-m3.1-flash:cloud': { inputTokens: 36396, outputTokens: 13, cacheReadInputTokens: 203, cacheCreationInputTokens: 0, costBasis: 'unknown' } },
  };
  const cost = claudeTurnCost(minimax, undefined, true);
  expect(cost.amount).toBeNull();
  expect(cost.snapshot?.total).toBe(minimax.total_cost_usd);
});

test.each([undefined, null, -1, NaN, Infinity, '0.2'])('unusable native cost %s leaves the calculator in charge', (cost) => {
  expect(claudeTurnCost({ ...first, total_cost_usd: cost }, undefined, true)).toEqual({ amount: null, snapshot: null });
});

// Real 4-result run: background sub-agents add to modelUsage but not to result.usage.
const multi = ([total, u, m]: [number, number[], number[]]) => ({
  session_id: 's', total_cost_usd: total,
  usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] },
  modelUsage: { opus: { inputTokens: m[0], outputTokens: m[1], cacheReadInputTokens: m[2], cacheCreationInputTokens: m[3] } },
});
const results = [
  multi([1.4439708, [18, 5928, 860986, 68917], [38, 9076, 1584744, 189070]]),
  multi([10.916334199999993, [16, 8207, 780692, 85748], [14267, 120151, 28077431, 566152]]),
  multi([11.476580599999993, [4, 101, 129432, 417], [14281, 131321, 29364408, 582031]]),
  multi([12.111418399999991, [12, 8347, 685504, 17192], [14297, 145688, 30534752, 604704]]),
];

test('same-process results take the native delta despite sub-agent tokens', () => {
  let previous: unknown;
  let sum = 0;
  results.forEach((result, i) => {
    const cost = claudeTurnCost(result, previous, i === 0, i > 0);
    expect(cost.amount).not.toBeNull();
    sum += cost.amount!;
    previous = cost.snapshot;
  });
  expect(sum).toBeCloseTo(12.1114184, 6);
});

test('a later run of the same session charges sub-agent usage through the native delta', () => {
  let previous = claudeTurnCost(results[0], undefined, true).snapshot;
  let sum = results[0].total_cost_usd;
  for (const result of results.slice(1)) {
    const cost = claudeTurnCost(result, previous, false);
    expect(cost.amount).not.toBeNull();
    sum += cost.amount!;
    previous = cost.snapshot;
  }
  expect(sum).toBeCloseTo(12.1114184, 6);
});

test('sameProcess rejects other sessions, lower totals and decreasing counters', () => {
  const prior = claudeTurnCost(results[0], undefined, true).snapshot!;
  const current = results[1];
  for (const previous of [
    { ...prior, sessionId: 'other' },
    { ...prior, total: current.total_cost_usd + 1 },
    { ...prior, tokens: [prior.tokens![0], prior.tokens![1], prior.tokens![2] + 1e9, prior.tokens![3]] },
  ]) expect(claudeTurnCost(current, previous, false, true).amount).toBeNull();
});
