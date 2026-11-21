import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../bin/measure-agent-run.mjs', import.meta.url).pathname;

test('normalizes Codex cached input and computes one USD cost', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'carapa-metrics-'));
  const pricingPath = join(runDir, 'pricing.jsonc');
  try {
    await writeFile(pricingPath, JSON.stringify({
      version: 1,
      currency: 'USD',
      models: {
        'gpt-test': { aliases: ['gpt-test-*'], input: 2, cachedInput: 0.2, output: 10 },
      },
    }));
    await writeFile(join(runDir, 'args.json'), JSON.stringify({
      agentCmd: 'codex',
      model: 'gpt-test-snapshot',
      pricingPath,
    }));
    await writeFile(join(runDir, 'exit_code'), '0');
    // Reproduce the real host lifecycle: it can archive output.jsonl as soon
    // as exit_code appears, just before the runner's EXIT trap measures it.
    await writeFile(join(runDir, 'output.jsonl.archived'), [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100 },
      }),
    ].join('\n'));

    const result = spawnSync(process.execPath, [script, runDir, String(Date.now() - 100)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const metrics = JSON.parse(await readFile(join(runDir, 'metrics.json'), 'utf8'));
    assert.equal(metrics.usage.inputTokens, 400);
    assert.equal(metrics.usage.cachedInputTokens, 600);
    assert.equal(metrics.costUsd, 0.00192);
    assert.equal(metrics.cost.pricingModel, 'gpt-test');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('sums Codex app-server per-request usage for one turn', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'carapa-metrics-'));
  const pricingPath = join(runDir, 'pricing.jsonc');
  try {
    await writeFile(pricingPath, JSON.stringify({
      version: 1,
      currency: 'USD',
      models: {
        'gpt-test': { input: 2, cachedInput: 0.2, output: 10 },
      },
    }));
    await writeFile(join(runDir, 'args.json'), JSON.stringify({
      agentCmd: 'codex',
      model: 'gpt-test',
      pricingPath,
    }));
    await writeFile(join(runDir, 'exit_code'), '0');
    await writeFile(join(runDir, 'output.jsonl'), [
      JSON.stringify({
        type: 'turn.usage',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 600,
          output_tokens: 100,
          reasoning_output_tokens: 40,
        },
      }),
      JSON.stringify({
        type: 'turn.usage',
        usage: {
          input_tokens: 800,
          cached_input_tokens: 500,
          output_tokens: 50,
          reasoning_output_tokens: 10,
        },
      }),
    ].join('\n'));

    const result = spawnSync(process.execPath, [script, runDir, String(Date.now() - 100)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const metrics = JSON.parse(await readFile(join(runDir, 'metrics.json'), 'utf8'));
    assert.equal(metrics.usage.inputTokens, 700);
    assert.equal(metrics.usage.cachedInputTokens, 1100);
    assert.equal(metrics.usage.outputTokens, 150);
    assert.equal(metrics.usage.reasoningOutputTokens, 50);
    assert.equal(metrics.costUsd, 0.00312);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('Claude metrics use turn usage instead of resumed-session model totals', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'carapa-metrics-'));
  try {
    await writeFile(join(runDir, 'args.json'), JSON.stringify({ agentCmd: 'claude', model: 'claude-opus-5-5',
      pricing: { version: 1, currency: 'USD', models: { 'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 } } },
    }));
    await writeFile(join(runDir, 'output.jsonl'), JSON.stringify({
      type: 'result', duration_ms: 1838, total_cost_usd: 0.31396100000000005,
      usage: { input_tokens: 4, output_tokens: 25, cache_read_input_tokens: 42410, cache_creation_input_tokens: 9435 },
      modelUsage: { opus: { inputTokens: 6, outputTokens: 67, cacheReadInputTokens: 42410, cacheCreationInputTokens: 60823 } },
    }) + '\n');
    const result = spawnSync(process.execPath, [script, runDir, String(Date.now())], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(await readFile(join(runDir, 'metrics.json'), 'utf8'));
    assert.equal(metrics.usage.inputTokens, 4);
    assert.equal(metrics.usage.outputTokens, 25);
    assert.equal(metrics.usage.cachedInputTokens, 42410);
    assert.equal(metrics.usage.cacheWriteTokens, 9435);
    assert.equal(metrics.costUsd, 0.056173);
    assert.equal(metrics.cost.source, 'model_pricing.jsonc');

    // A validated native per-turn cost wins, even if configured prices differ.
    await writeFile(join(runDir, 'claude-turn-cost.json'), JSON.stringify({ amount: 0.05 }));
    const measured = spawnSync(process.execPath, [script, runDir], { encoding: 'utf8' });
    assert.equal(measured.status, 0, measured.stderr);
    const reported = JSON.parse(await readFile(join(runDir, 'metrics.json'), 'utf8'));
    assert.equal(reported.costUsd, 0.05);
    assert.equal(reported.cost.source, 'claude');
  } finally { await rm(runDir, { recursive: true, force: true }); }
});
