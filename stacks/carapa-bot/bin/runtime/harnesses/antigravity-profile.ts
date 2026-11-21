import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RunContext } from '../contracts';

export function antigravityIdentityPath(context: RunContext, sessionId: string): string {
  if (!/^[\w-]{1,128}$/.test(sessionId)) throw new Error('Invalid Antigravity session ID');
  return join(context.env.GEMINI_HOME!, 'identities', sessionId);
}

export function antigravitySessionIdentity(context: RunContext): string {
  const authMethod = (ctx: RunContext) => ctx.env.ANTIGRAVITY_ACP_AUTH_METHOD || 'gemini-api-key';
  return (authMethod(context) === 'gemini-api-key' ? 'relay-v1:' : '') + createHash('sha256').update(JSON.stringify([
    authMethod(context), context.env.GEMINI_API_KEY, context.env.GEMINI_HOME,
    context.cwd, context.env.ANTIGRAVITY_ACP_BIN,
    ...(authMethod(context) === 'gemini-api-key' ? [context.env.GOOGLE_GEMINI_BASE_URL] : []),
  ])).digest('hex');
}
