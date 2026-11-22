import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../bin/measure-agent-run.mjs', import.meta.url).pathname;
const runtime = new URL('../bin/runtime/', import.meta.url).pathname;

// Writes output.v1.jsonl and output.v1.meta.json through the real adapter for
// `harness`, so the fixture is what the runner writes, not a hand-built copy.
const writeV1 = (runDir, harness, model, messages) => {
  const source = `
    import { ClaudeRunV1Adapter } from ${JSON.stringify(`${runtime}claude-v1.ts`)};
    import { CodexRunV1Adapter } from ${JSON.stringify(`${runtime}codex-app-server/v1.ts`)};
    import { RunV1Writer } from ${JSON.stringify(`${runtime}run-v1.ts`)};
    const [runDir, harness, model, raw] = process.argv.slice(1);
    const messages = JSON.parse(raw);
    const writer = new RunV1Writer(runDir, { format: 'carapa-run', version: 1, harness, requestedModel: model });
    if (harness === 'codex') {
      const adapter = new CodexRunV1Adapter(writer, { model, chatMode: '', reasoningEffort: '', groupDir: runDir, env: {} });
      adapter.beginTurn(model, '');
      for (const message of messages) adapter.consume(message);
      adapter.finish();
    } else {
      const adapter = new ClaudeRunV1Adapter(writer, model, false);
      for (const message of messages) adapter.consume(message);
      adapter.finish(0);
    }
  `;
  const result = spawnSync('bun', ['-e', source, runDir, harness, model, JSON.stringify(messages)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const tokenUsage = (last) => ({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last } } });

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
    writeV1(runDir, 'codex', 'gpt-test-snapshot', [
      tokenUsage({ inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 100 }),
    ]);

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
    writeV1(runDir, 'codex', 'gpt-test', [
      tokenUsage({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100, reasoningOutputTokens: 40 }),
      tokenUsage({ inputTokens: 800, cachedInputTokens: 500, outputTokens: 50, reasoningOutputTokens: 10 }),
    ]);

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
    writeV1(runDir, 'claude', 'claude-opus-5-5', [{
      type: 'result', duration_ms: 1838, total_cost_usd: 0.31396100000000005,
      usage: { input_tokens: 4, output_tokens: 25, cache_read_input_tokens: 42410, cache_creation_input_tokens: 9435 },
      modelUsage: { opus: { inputTokens: 6, outputTokens: 67, cacheReadInputTokens: 42410, cacheCreationInputTokens: 60823 } },
    }]);
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
