import { relayBaseUrl } from '../roots';
export const ANTIGRAVITY_RELAY_KEY = 'carapa-relay-placeholder';
export const ANTIGRAVITY_RELAY_URL = `${relayBaseUrl()}/google`;

export function clearGoogleCredentials(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_.*|GCLOUD_PROJECT|CLOUDSDK_CORE_PROJECT|GOOGLE_GENAI_USE_VERTEXAI|ANTIGRAVITY_ACP_API_KEY_FILE)$/i.test(name)) delete env[name];
  }
}

/** No secret-file fallback: only the external relay owns the inference key. */
export function configureAntigravityRelay(env: Record<string, string | undefined>): void {
  const endpoint = new URL(env.GOOGLE_GEMINI_BASE_URL || ANTIGRAVITY_RELAY_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Antigravity relay endpoint must be an HTTP(S) base URL without credentials, query or fragment');
  }
  clearGoogleCredentials(env);
  env.GEMINI_API_KEY = ANTIGRAVITY_RELAY_KEY;
  env.GOOGLE_GEMINI_BASE_URL = endpoint.href.replace(/\/$/, '');
  const bypass = [...new Set(`${env.NO_PROXY || ''},${env.no_proxy || ''},${endpoint.hostname}`.split(',').filter(Boolean))].join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
}
