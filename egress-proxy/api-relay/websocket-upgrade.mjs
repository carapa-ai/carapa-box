import { stripClientAuthHeaders } from './api-relay.mjs';
import http from 'node:http';
import https from 'node:https';

export function allowsServiceWebSocket(config, targetPath) {
  if (!Array.isArray(config?.websocketPaths) || targetPath.includes('?') || targetPath.includes('%')) return false;
  return config.websocketPaths.some(prefix => targetPath.startsWith(prefix));
}

/** Internal services use the same direct transport/TLS convention as HTTP. */
export function forwardServiceWebSocket(config, targetPath, headers, client, head,
  { connectTimeout = 10_000, idleTimeout = 300_000, holdUnauthorized = false } = {}) {
  return new Promise((resolve, reject) => {
    const secure = config.protocol === 'https' || (!config.protocol && config.port === 3000);
    const transport = secure ? https : http;
    let upstream;
    let settled = false;
    const request = transport.request({
      hostname: config.host, port: config.port || (secure ? 443 : 80), path: targetPath,
      method: 'GET', headers,
      ...(secure ? { rejectUnauthorized: false } : {}),
    });
    const timer = setTimeout(() => request.destroy(new Error('Internal WebSocket connect timeout')), connectTimeout);
    const fail = error => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
      upstream?.destroy();
    };
    const disconnected = () => { request.destroy(); upstream?.destroy(); };
    client.once('close', disconnected);
    client.once('error', disconnected);
    request.once('error', fail);
    request.once('response', response => {
      clearTimeout(timer);
      settled = true;
      if (holdUnauthorized && [401, 403].includes(response.statusCode)) {
        client.off('close', disconnected);
        client.off('error', disconnected);
        response.resume();
        resolve(response.statusCode);
        return;
      }
      client.end(`HTTP/1.1 ${response.statusCode} ${http.STATUS_CODES[response.statusCode] || 'Rejected'}\r\nConnection: close\r\n\r\n`);
      response.resume();
      resolve(response.statusCode);
    });
    request.once('upgrade', (response, socket, upstreamHead) => {
      clearTimeout(timer);
      upstream = socket;
      settled = true;
      if (client.destroyed) { socket.destroy(); resolve(499); return; }
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      client.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.setTimeout(idleTimeout, () => socket.destroy());
      socket.once('error', () => client.destroy());
      socket.once('close', () => client.destroy());
      client.pipe(socket).pipe(client);
      client.resume();
      resolve(101);
    });
    request.end();
  });
}

const STRIP_HEADERS = new Set([
  'proxy-authorization',
  'proxy-connection',
  'content-length',
  'transfer-encoding',
]);

function assertHeaderPart(value, label) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid ${label}`);
}

export function buildWebSocketUpgradeHeaders(incoming, authHeaders, host) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(stripClientAuthHeaders(incoming))) {
    const name = rawName.toLowerCase();
    if (STRIP_HEADERS.has(name) || rawValue == null) continue;
    assertHeaderPart(name, 'header name');
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    assertHeaderPart(value, `header value for ${name}`);
    headers[name] = value;
  }

  const clientBeta = headers['anthropic-beta'] || '';
  const injected = { ...(authHeaders || {}) };
  const authBeta = injected['anthropic-beta'] || injected['Anthropic-Beta'] || '';
  delete injected['anthropic-beta'];
  delete injected['Anthropic-Beta'];

  for (const [rawName, rawValue] of Object.entries(injected)) {
    const name = rawName.toLowerCase();
    assertHeaderPart(name, 'header name');
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    assertHeaderPart(value, `header value for ${name}`);
    headers[name] = value;
  }

  if (clientBeta || authBeta) {
    const flags = new Set(`${authBeta},${clientBeta}`.split(',').map(value => value.trim()).filter(Boolean));
    headers['anthropic-beta'] = [...flags].join(',');
  }

  assertHeaderPart(host, 'host');
  headers.host = host;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  return headers;
}

export function serializeWebSocketUpgradeRequest(method, targetPath, headers) {
  assertHeaderPart(method, 'method');
  assertHeaderPart(targetPath, 'request target');
  const lines = [`${method} ${targetPath} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    assertHeaderPart(name, 'header name');
    assertHeaderPart(String(value), `header value for ${name}`);
    lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

export function splitHttpResponseHead(buffer) {
  const boundary = buffer.indexOf('\r\n\r\n');
  if (boundary === -1) return null;

  const headEnd = boundary + 4;
  const head = buffer.subarray(0, headEnd);
  const statusLine = head.toString('latin1', 0, head.indexOf('\r\n'));
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(statusLine);
  if (!match) throw new Error(`Invalid upstream HTTP response: ${statusLine}`);

  return {
    statusCode: Number(match[1]),
    head,
    remainder: buffer.subarray(headEnd),
  };
}
