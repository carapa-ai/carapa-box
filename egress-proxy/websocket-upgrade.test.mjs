import { describe, expect, test } from 'bun:test';
import {
  buildWebSocketUpgradeHeaders,
  serializeWebSocketUpgradeRequest,
  splitHttpResponseHead,
} from './api-relay/websocket-upgrade.mjs';

describe('WebSocket upgrade helpers', () => {
  test('replaces sandbox credentials while preserving handshake headers', () => {
    const headers = buildWebSocketUpgradeHeaders({
      host: 'api-relay:8080',
      connection: 'upgrade',
      upgrade: 'websocket',
      authorization: 'Bearer sandbox-dummy',
      'x-api-key': 'sandbox-key',
      'sec-websocket-key': 'abc123==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'openai-insecure-api-key.test',
    }, {
      authorization: 'Bearer real-token',
      'chatgpt-account-id': 'acct-123',
    }, 'chatgpt.com');

    expect(headers).toEqual({
      host: 'chatgpt.com',
      connection: 'Upgrade',
      upgrade: 'websocket',
      authorization: 'Bearer real-token',
      'chatgpt-account-id': 'acct-123',
      'sec-websocket-key': 'abc123==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'openai-insecure-api-key.test',
    });
  });

  test('serializes an upstream upgrade request', () => {
    const request = serializeWebSocketUpgradeRequest('GET', '/backend-api/codex/responses?x=1', {
      host: 'chatgpt.com',
      connection: 'Upgrade',
      upgrade: 'websocket',
    });

    expect(request.toString('latin1')).toBe(
      'GET /backend-api/codex/responses?x=1 HTTP/1.1\r\n' +
      'host: chatgpt.com\r\n' +
      'connection: Upgrade\r\n' +
      'upgrade: websocket\r\n\r\n'
    );
  });

  test('splits a 101 response from an immediately following frame', () => {
    const frame = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
    const response = Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', 'latin1'),
      frame,
    ]);

    const parsed = splitHttpResponseHead(response);
    expect(parsed?.statusCode).toBe(101);
    expect(parsed?.head.toString('latin1')).toContain('101 Switching Protocols');
    expect(parsed?.remainder).toEqual(frame);
  });
});
