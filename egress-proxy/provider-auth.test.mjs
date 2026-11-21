import { expect, test } from 'bun:test';
import { googleApiKeyAuth, googleApiKeyAuthFromConfig, providerRequestPath, stripClientAuthHeaders } from './api-relay/api-relay.mjs';
import { buildWebSocketUpgradeHeaders } from './api-relay/websocket-upgrade.mjs';

test('Google relay replaces every client auth form without putting credentials in the URL', () => {
  const incoming = { authorization: 'Bearer untrusted', 'X-Api-Key': 'other', 'x-goog-api-key': 'dummy', 'Private-Token': 'other', 'content-type': 'application/json' };
  const auth = googleApiKeyAuth('relay-owned-test-key');
  for (const headers of [
    { ...stripClientAuthHeaders(incoming), ...auth.headers },
    buildWebSocketUpgradeHeaders(incoming, auth.headers, 'generativelanguage.googleapis.com'),
  ]) {
    expect(headers['x-goog-api-key']).toBe('relay-owned-test-key');
    expect(headers.authorization).toBeUndefined();
    expect(Object.keys(headers).some(name => ['x-api-key', 'private-token'].includes(name.toLowerCase()))).toBe(false);
    expect(headers['content-type']).toBe('application/json');
  }
  const target = '/v1beta/models/test:streamGenerateContent?key=first&alt=sse&%6bey=second&Key=third&label=a%20b';
  expect(providerRequestPath('google', target)).toBe('/v1beta/models/test:streamGenerateContent?alt=sse&label=a%20b');
  expect(providerRequestPath('google', '/v1beta/models?key=only')).toBe('/v1beta/models');
  expect(providerRequestPath('google', '/v1beta/models')).toBe('/v1beta/models');
  expect(providerRequestPath('anthropic', target)).toBe(target);
  expect(googleApiKeyAuth('')).toBeNull();
  expect(googleApiKeyAuthFromConfig({ envKey: 'GOOGLE_API_KEY' }, name => name === 'GOOGLE_API_KEY' ? 'relay-owned-test-key' : '')).toEqual(auth);
  expect(googleApiKeyAuthFromConfig({ apiKey: 'client-google-key' }, () => { throw new Error('must not resolve other credentials'); })).toEqual(googleApiKeyAuth('client-google-key'));
  expect(googleApiKeyAuthFromConfig({}, () => 'unrelated-key')).toBeNull();
});
