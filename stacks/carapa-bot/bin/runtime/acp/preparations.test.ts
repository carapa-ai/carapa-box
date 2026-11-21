import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../contracts';
import { prepareHermesProviderState, preparePrimeRelay } from './preparations';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string): RunContext {
  return {
    runDir: join(root, 'run'),
    prompt: '',
    cwd: root,
    runTag: 'run',
    binDir: root,
    env: { HOME: root },
    args: {
      agentCmd: 'prime-agent-acp',
      sessionId: '',
      forkSession: '',
      model: '',
      fallbackModel: '',
      reasoningEffort: '',
      fallbackReasoningEffort: '',
      chatMode: '',
      agent: '',
      bare: '',
      systemPrompt: '',
      workDir: root,
      conversationKey: '',
      persistent: '',
      conversationId: '',
      env: {},
    },
  };
}

describe('ACP harness preparation', () => {
  test('normalizes Prime relay authentication without discarding unrelated providers', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-prime-acp-'));
    roots.push(root);
    const value = context(root);
    const configDir = join(root, 'prime');
    const template = join(root, 'prime-models.json');
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, 'models.json'),
      JSON.stringify({ providers: { custom: { baseUrl: 'https://example.test' } } }),
    );
    writeFileSync(template, JSON.stringify({ providers: { 'carapa-codex': { models: [] } } }));
    value.env.PRIME_AGENT_CODING_AGENT_DIR = configDir;
    value.env.PRIME_AGENT_MODELS_TEMPLATE = template;

    preparePrimeRelay(value);

    const models = JSON.parse(readFileSync(join(configDir, 'models.json'), 'utf8'));
    expect(models.providers.custom.baseUrl).toBe('https://example.test');
    expect(models.providers['carapa-codex']).toMatchObject({
      baseUrl: 'http://api-relay:8080/codex',
      api: 'openai-codex-responses',
      authHeader: true,
    });
    expect(models.providers['carapa-codex'].apiKey).toEndWith('.relay');
  });

  test('quarantines Hermes state only when its latest provider conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'carapa-hermes-acp-'));
    roots.push(root);
    const value = context(root);
    const hermesHome = join(root, '.hermes');
    const state = join(hermesHome, 'state.db');
    mkdirSync(hermesHome);
    const database = new Database(state);
    database.exec('CREATE TABLE sessions (started_at INTEGER, model_config TEXT)');
    database
      .query('INSERT INTO sessions VALUES (?, ?)')
      .run(1, JSON.stringify({ provider: 'openrouter' }));
    database.close();

    prepareHermesProviderState(value);

    expect(existsSync(state)).toBe(false);
    expect(
      Array.from(new Bun.Glob('state.db.capa-backup-*').scanSync({ cwd: hermesHome })).length,
    ).toBe(1);
  });
});
