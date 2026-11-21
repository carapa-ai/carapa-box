import { Database } from 'bun:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from '../contracts';

const primePlaceholder =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicmVsYXktcGxhY2Vob2xkZXIifX0.relay';

function objectWithProviders(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const providers = (value as Record<string, unknown>).providers;
  return !!providers && typeof providers === 'object' && !Array.isArray(providers);
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function preparePrimeRelay(context: RunContext): void {
  const home = context.env.HOME || '/home/ubuntu';
  const configDir = context.env.PRIME_AGENT_CODING_AGENT_DIR || join(home, '.prime', 'agent');
  const modelsPath = join(configDir, 'models.json');
  const templatePath =
    context.env.PRIME_AGENT_MODELS_TEMPLATE || '/usr/local/share/carapa/prime-models.json';
  mkdirSync(configDir, { recursive: true });
  let models = parseJson(modelsPath);
  if (!objectWithProviders(models)) models = parseJson(templatePath);
  if (!objectWithProviders(models)) throw new Error(`Prime Agent model template is invalid: ${templatePath}`);
  models.providers['carapa-codex'] = {
    ...(models.providers['carapa-codex'] ?? {}),
    baseUrl: 'http://api-relay:8080/codex',
    api: 'openai-codex-responses',
    apiKey: primePlaceholder,
    authHeader: true,
  };
  const temporary = join(configDir, `.models.json.relay.${process.pid}`);
  writeFileSync(temporary, `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, modelsPath);
}

export function prepareHermesProviderState(context: RunContext): void {
  const home = context.env.HOME || '/home/ubuntu';
  const hermesHome = context.env.HERMES_HOME || join(home, '.hermes');
  const statePath = join(hermesHome, 'state.db');
  if (!existsSync(statePath)) return;
  let provider = '';
  try {
    const database = new Database(statePath, { readonly: true });
    try {
      const row = database
        .query('SELECT model_config FROM sessions ORDER BY started_at DESC LIMIT 1')
        .get() as { model_config?: string } | null;
      if (row?.model_config) provider = String(JSON.parse(row.model_config)?.provider ?? '');
    } finally {
      database.close();
    }
  } catch {
    return;
  }
  if (!provider || provider === 'openai-api') return;
  renameSync(statePath, `${statePath}.capa-backup-${Date.now()}`);
  rmSync(`${statePath}-shm`, { force: true });
  rmSync(`${statePath}-wal`, { force: true });
}
