export type JsonRecord = Record<string, unknown>;
export type RpcId = string | number;

export interface RpcMessage extends JsonRecord {
  id?: RpcId;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: unknown;
}

export interface CodexRunnerArgs extends JsonRecord {
  codexControlContract?: unknown;
  sessionId: string;
  model: string;
  fallbackModel: string;
  reasoningEffort: string;
  fallbackReasoningEffort: string;
  chatMode: string;
  systemPrompt: string;
  conversationKey?: string;
  persistent?: string;
  groupDir?: unknown;
  env: Record<string, string>;
}

export function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
