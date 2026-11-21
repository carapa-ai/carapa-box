import { expect, test } from 'bun:test';
import { configureAntigravityRelay } from './antigravity-auth';

test('Antigravity replaces inherited credentials with a dummy key and bypasses Squid for the relay', () => {
  const env: Record<string, string> = {
    GEMINI_API_KEY: 'secret-from-parent', GOOGLE_API_KEY: 'secret-from-another-harness',
    GOOGLE_APPLICATION_CREDENTIALS: '/unreadable/credentials.json', GOOGLE_CLOUD_PROJECT: 'unrelated',
    ANTIGRAVITY_ACP_API_KEY_FILE: '/unreadable/key',
    HTTP_PROXY: 'http://squid:3128', NO_PROXY: 'localhost', no_proxy: '127.0.0.1',
  };
  configureAntigravityRelay(env);
  expect(env).toEqual({ GEMINI_API_KEY: 'carapa-relay-placeholder', GOOGLE_GEMINI_BASE_URL: 'http://api-relay:8080/google',
    HTTP_PROXY: 'http://squid:3128', NO_PROXY: 'localhost,127.0.0.1,api-relay', no_proxy: 'localhost,127.0.0.1,api-relay' });
  configureAntigravityRelay(env);
  expect(env.NO_PROXY).toBe('localhost,127.0.0.1,api-relay');
  expect(() => configureAntigravityRelay({ GOOGLE_GEMINI_BASE_URL: 'https://user:secret@example.com' })).toThrow('without credentials');
});
