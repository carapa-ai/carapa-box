#!/usr/bin/env node
/**
 * API credential injection relay.
 *
 * Agents hit http://api-relay:8080/<provider>/... over the internal network
 * using HTTP/SSE or WebSocket upgrades.
 * The relay strips incoming auth headers, injects the real credential, and
 * forwards the request upstream over HTTPS through Squid.
 *
 * Auth modes (per provider, checked in order):
 *   1. OAuth credentials file (access_token + refresh_token, auto-refresh on 401)
 *   2. Static API key from environment variable
 *
 * Providers (tested):
 *   /anthropic/... → api.anthropic.com                  (Bearer / x-api-key)
 *   /anthropic-api/... → api.anthropic.com              (x-api-key only: API credits, never OAuth)
 *   /codex/...     → chatgpt.com/backend-api/codex/...  (Bearer + chatgpt-account-id)
 *
 * Providers (untested):
 *   /openai/...    → api.openai.com                     (Bearer)
 *   /google/...    → generativelanguage.googleapis.com  (x-goog-api-key)
 *   /nvidia/...    → integrate.api.nvidia.com           (Bearer)
 *   /mistral-eu/... → api.eu.mistral.ai                 (Bearer; EU-processed only, never api.mistral.ai)
 *
 * Internal services (plain HTTP, no Squid — configured in relay-clients/*.json):
 *   /<service>/...  → http://<host>:<port>/...  (Bearer token injection)
 *   Defined under "services" key in client configs.
 *
 * See docs/api-relay-setup.md for per-provider setup instructions.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import cluster from 'node:cluster';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { anthropicAdminKeys, applyProviderAccounts, projectGrantsFor, selectProjectGrant } from './provider-account-config.mjs';
import { createAccountPool, quotaExhaustedUntil, requestSession } from './account-pool.mjs';
import { configureCredentialSealing, readCredentialFile, sealPlaintextCredentials, writeCredentialFile } from './credential-crypto.mjs';
import { MCP_AUTH, configuredMcpOAuthServices, createMcpOAuthProcessor, validateMcpOAuthConfig } from './mcp-oauth.mjs';
import { URL, fileURLToPath } from 'node:url';
import {
  buildWebSocketUpgradeHeaders,
  serializeWebSocketUpgradeRequest,
  splitHttpResponseHead,
  allowsServiceWebSocket,
  forwardServiceWebSocket,
} from './websocket-upgrade.mjs';
import {
  FORWARD_HEADERS,
  createReplayGuard,
  forwardContext,
  forwarderKeyFromSecret,
  precheckForwardedHeaders,
  signForwardHeaders,
  stripForwardHeaders,
  verifyForwardedRequest,
} from './relay-forwarding.mjs';

// Shared HTTP/WebSocket credential boundary. Client credentials never survive
// alongside the relay's selected account, including Google's query-key form.
export const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'private-token'];

export function googleApiKeyAuth(key) {
  return key ? { type: 'static', headers: { 'x-goog-api-key': key } } : null;
}

export function googleApiKeyAuthFromConfig(config, readSecret) {
  const auth = googleApiKeyAuth(config.apiKey || (config.envKey ? readSecret(config.envKey) : ''));
  if (auth && config.extraHeaders) Object.assign(auth.headers, config.extraHeaders);
  return auth;
}

export function stripClientAuthHeaders(incoming) {
  return Object.fromEntries(Object.entries(incoming).filter(([name]) => !AUTH_HEADERS.includes(name.toLowerCase())));
}

// Anthropic's Admin API (/v1/organizations/*) accepts an unscoped API key as an
// admin credential. Sandboxes only need inference, so neither Anthropic route
// reaches it, however the path is spelled.
export function isAnthropicAdminPath(provider, target) {
  if (provider !== 'anthropic' && provider !== 'anthropic-api') return false;
  const end = target.search(/[?#]/);
  let pathname = end === -1 ? target : target.slice(0, end);
  try { pathname = decodeURIComponent(pathname); } catch { return true; }
  return /^\/v1\/organizations(\/|$)/.test(pathname.replace(/\/{2,}/g, '/').toLowerCase());
}

/** Month-to-date Anthropic API spend in US dollars from cost_report pages
 * (amounts are decimal strings in cents), in total and per model. */
export function summarizeAnthropicCost(pages) {
  let cents = 0;
  const models = {};
  for (const page of pages) for (const bucket of page?.data || []) for (const result of bucket?.results || []) {
    const amount = Number(result?.amount);
    if (!Number.isFinite(amount)) continue;
    cents += amount;
    const name = result.model || result.description || 'Other';
    models[name] = (models[name] || 0) + amount;
  }
  return { spent: cents / 100, models: Object.fromEntries(Object.entries(models).map(([name, value]) => [name, value / 100])) };
}

export function providerRequestPath(provider, target) {
  if (!['google', 'antigravity'].includes(provider)) return target;
  const query = target.indexOf('?');
  if (query === -1) return target;
  // Keep all other parameters byte-for-byte (including SSE alt=sse). Decode
  // names only, so repeated and percent-encoded key parameters are removed.
  const params = target.slice(query + 1).split('&').filter(part => {
    const rawName = part.split('=', 1)[0];
    try { return decodeURIComponent(rawName.replace(/\+/g, ' ')).toLowerCase() !== 'key'; }
    catch { return true; }
  });
  return target.slice(0, query) + (params.length ? `?${params.join('&')}` : '');
}

export function jwtExpiresAt(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(value) ? value * 1000 : null;
  } catch { return null; }
}

export function antigravityUserAgent(data) {
  const version = String(data.relayAcpVersion || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '-');
  return `antigravity/acp/${version} (aidev_client; os_type=linux; arch=${process.arch === 'x64' ? 'x86_64' : process.arch}; host_path=carapa-box/1; proxy_client=antigravity/sdk)`;
}

function antigravityClientError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// Client-side validation only; needs no credential, so it can run before OAuth retry.
export function parseAntigravityRequest(target, body) {
  let url;
  try { url = new URL(target, 'http://relay.invalid'); } catch { throw antigravityClientError(400, 'Malformed Antigravity request URL'); }
  const match = /^\/v1(?:beta)?\/models\/([a-zA-Z0-9._-]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
  if (!match) throw antigravityClientError(404, 'Unsupported Antigravity request path');
  let request;
  try { request = JSON.parse(body.toString('utf8')); } catch { throw antigravityClientError(400, 'Invalid JSON request body'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw antigravityClientError(400, 'Invalid Gemini request');
  return { requestedModel: match[1], method: match[2], request };
}

export function antigravityRequest(target, body, credential) {
  return antigravityWireRequest(parseAntigravityRequest(target, body), credential);
}

function antigravityWireRequest({ requestedModel, method, request }, credential) {
  if (!credential.project_id || !['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'].includes(credential.relayEndpoint)) {
    throw new Error('Antigravity account is not ready');
  }
  let model = requestedModel;
  const rawLevel = request.generationConfig?.thinkingConfig?.thinkingLevel;
  // The native ACP SDK sends lowercase; Gemini API callers may use uppercase.
  const level = typeof rawLevel === 'string' ? rawLevel.toLowerCase() : '';
  // The CLI's Gemini-key mode maps its picker variants to a Gemini API base model
  // plus thinkingLevel. CCPA OAuth expects the variant ID instead. Reverse
  // that mapping only for these model families; preserve literal IDs and the
  // request (including thinking settings), without choosing a fallback model.
  if (/^(gemini-3\.\d+-flash|gemini-4-[a-z]+)$/.test(model) && ['low', 'medium', 'high', 'xhigh'].includes(level)) {
    model += '-' + level;
  }
  return { host: credential.relayEndpoint, path: '/v1internal:' + method + (method === 'streamGenerateContent' ? '?alt=sse' : ''),
    streaming: method === 'streamGenerateContent', requestedModel, model,
    body: Buffer.from(JSON.stringify({ project: credential.project_id, model, request })) };
}

export function antigravityResponse(streaming) {
  let pending = '';
  const unwrap = text => {
    const value = JSON.parse(text);
    return JSON.stringify(value.response ?? value);
  };
  const frame = text => text.split('\n').map(line => {
    if (!line.startsWith('data:')) return line;
    const value = line.slice(5).trim();
    return value && value !== '[DONE]' ? 'data: ' + unwrap(value) : line;
  }).join('\n');
  // StringDecoder preserves UTF-8 across network chunk boundaries.
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, _, done) {
      try {
        pending += decoder.decode(chunk, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        if (streaming) {
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            this.push(frame(pending.slice(0, end)) + '\n\n'); pending = pending.slice(end + 2);
          }
        }
        if (pending.length > 8 * 1024 * 1024) throw new Error('Antigravity response frame too large');
        done();
      } catch { done(new Error('Invalid Antigravity response')); }
    },
    flush(done) {
      try {
        pending += decoder.decode();
        if (pending.trim()) this.push(streaming ? frame(pending) + '\n\n' : unwrap(pending));
        done();
      } catch { done(new Error('Invalid Antigravity response')); }
    },
  });
}

/** Cursor CLI telemetry: analytics events and logs, client metrics, AI-written
 * code statistics, and OpenTelemetry exports. Model and account calls differ. */
export function cursorTelemetryRequest(targetPath) {
  const path = targetPath.split('?')[0];
  return path.startsWith('/aiserver.v1.AnalyticsService/') || path.startsWith('/aiserver.v1.MetricsService/') ||
    path.endsWith('/ReportAiCodeChangeMetrics') || ['/v1/traces', '/v1/logs', '/v1/metrics'].includes(path);
}

/** Muse contributor mode (Meta trains on prompts and code) is requested with a
 * `-contributor` model id plus `x-tbh-contributor-mode: 1`; "off" is a plain model id
 * with the header absent (Muse before 1.4.13) or exactly `0`. */
const MUSE_CONTRIBUTOR_MODEL = /"model"\s*:\s*"[^"]*-contributor"/;
/** Decoded top-level keys of a valid JSON object text, duplicates kept (JSON.parse keeps only the last). */
function topLevelKeys(text) {
  const keys = [];
  let depth = 0, expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey) keys.push(JSON.parse(text.slice(i, j + 1)));
      expectKey = false; i = j;
    } else if (c === '{' || c === '[') { depth++; expectKey = depth === 1 && c === '{'; }
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = text.trimStart()[0] === '{';
  }
  return keys;
}

export function museContributorRequest(headers, body) {
  // Any value but a single `0` (repeated headers arrive joined, e.g. "0, 1") counts as on.
  if (Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'x-tbh-contributor-mode'
    && String(value).trim() !== '0')) return true;
  const text = body.toString('utf8');
  if (MUSE_CONTRIBUTOR_MODEL.test(text)) return true;
  if (!text) return false;
  // JSON escapes (\u002d, \u006d) evade the regex while the upstream decodes them.
  try {
    const model = JSON.parse(text)?.model;
    // A duplicate `model` key is resolved first-wins or last-wins depending on the parser: refuse it.
    if (topLevelKeys(text).filter(key => key === 'model').length > 1) return true;
    return typeof model === 'string' && model.endsWith('-contributor');
  } catch {
    const type = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    return !type || String(type).toLowerCase().includes('json');
  }
}

/** Passive SSE scan for Muse's `response.subscription_usage` event: Meta only
 * reports subscription usage inside model streams, never via its own endpoint. */
export function museUsageScanner(onUsage) {
  const decoder = new TextDecoder();
  let pending = '';
  // A listener that throws would surface as an uncaught relay error.
  return chunk => {
    try {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line.startsWith('data:') || !line.includes('response.subscription_usage')) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === 'response.subscription_usage' && event.subscription) onUsage(event.subscription);
      }
      // Long output lines are never usage events; bound the scan buffer.
      if (pending.length > 1 << 20) pending = '';
    } catch { pending = ''; }
  };
}

// One lifecycle; adapters describe only provider wire/file formats.
function grokSessionEntry(data) {
  const entries = Object.entries(data || {}).filter(([scope]) => scope.startsWith('https://auth.x.ai::'));
  return entries.length === 1 ? entries[0] : [];
}

function grokSession(data) {
  return grokSessionEntry(data)[1];
}

export function oauthAdapters(env = {}) {
  return {
    antigravity: {
      refreshBeforeMs: 5 * 60_000,
      allowRefreshOnly: true,
      needsMetadata: data => !data.relayEndpoint,
      endpoint: 'https://oauth2.googleapis.com/token',
      read(data) {
        return { access: data.access_token || '', refresh: data.refresh_token, expiresAt: data.expiresAt || 0,
          headers: { authorization: 'Bearer ' + (data.access_token || '') } };
      },
      payload(data, token) {
        if (!data.client_id || !data.client_secret) throw new Error('Missing Antigravity OAuth client');
        return { client_id: data.client_id, client_secret: data.client_secret,
          grant_type: 'refresh_token', refresh_token: token.refresh };
      },
      format: 'form',
      async enrich(data, response, request, signal) {
        // Native ACP already performed onboarding. Re-resolve the account's
        // backend instead of guessing consumer vs enterprise from the token file.
        const loaded = await request('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
          { metadata: { ideType: 'ANTIGRAVITY' } }, { signal,
            headers: { authorization: 'Bearer ' + response.access_token, 'user-agent': antigravityUserAgent(data) } });
        if (loaded.status !== 200 || !loaded.body?.currentTier || typeof loaded.body.cloudaicompanionProject !== 'string' || !loaded.body.cloudaicompanionProject) {
          throw new Error('Antigravity onboarding is required');
        }
        return { ...data, project_id: loaded.body.cloudaicompanionProject,
          relayEndpoint: loaded.body.paidTier?.usesGcpTos ? 'cloudcode-pa.googleapis.com' : 'daily-cloudcode-pa.googleapis.com' };
      },
      write(data, response, now) {
        if (!(Number(response.expires_in) > 0)) throw new Error('Missing Antigravity token expiry');
        return { ...data, access_token: response.access_token, refresh_token: response.refresh_token || data.refresh_token,
          expiresAt: now + Number(response.expires_in) * 1000 };
      },
    },
    anthropic: {
      refreshBeforeMs: 30 * 60_000,
      endpoint: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      read(data) {
        const value = data.claudeAiOauth || data.oauthAccount;
        return value && { access: value.accessToken, refresh: value.refreshToken, expiresAt: value.expiresAt,
          headers: { authorization: 'Bearer ' + value.accessToken, 'anthropic-beta': 'oauth-2025-04-20' } };
      },
      write(data, response, now) {
        const key = data.claudeAiOauth ? 'claudeAiOauth' : 'oauthAccount';
        const expiresIn = Number(response.expires_in);
        return { ...data, [key]: { ...data[key], accessToken: response.access_token,
          refreshToken: response.refresh_token || data[key].refreshToken,
          expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined } };
      },
    },
    meta: {
      // Muse's subscription login mints a long-lived API key that Muse sends as
      // a bearer token. There is no refresh grant; a revoked key needs login.
      refreshBeforeMs: 0,
      read(data) {
        const value = data.providers?.meta;
        return value?.api_key ? { access: value.api_key, expiresAt: NaN,
          headers: { authorization: 'Bearer ' + value.api_key } } : undefined;
      },
    },
    cursor: {
      // Cursor's browser login stores a JWT access token (about 60 days). The CLI
      // renews it only with an API key, so there is no refresh grant: an expired
      // login needs reconnecting. The refresh token is deliberately not read.
      refreshBeforeMs: 0,
      read(data) {
        if (typeof data?.accessToken !== 'string' || !data.accessToken) return undefined;
        let expiresAt = NaN;
        try { expiresAt = JSON.parse(Buffer.from(data.accessToken.split('.')[1], 'base64url').toString()).exp * 1000; } catch { /* Opaque token. */ }
        return { access: data.accessToken, expiresAt, headers: { authorization: 'Bearer ' + data.accessToken } };
      },
    },
    xai: {
      // Grok Build's auth.json maps "<issuer>::<client_id>" to one session.
      // Refresh tokens are single-use, so only this relay may renew them.
      refreshBeforeMs: 5 * 60_000,
      endpoint: 'https://auth.x.ai/oauth2/token',
      format: 'form',
      read(data) {
        const value = grokSession(data);
        return value && { access: value.key, refresh: value.refresh_token,
          expiresAt: value.expires_at ? Date.parse(value.expires_at) : NaN,
          headers: { authorization: 'Bearer ' + value.key } };
      },
      payload(data, token) {
        const client = grokSession(data)?.oidc_client_id;
        if (!client) throw new Error('Missing Grok OAuth client');
        return { client_id: client, grant_type: 'refresh_token', refresh_token: token.refresh };
      },
      write(data, response, now) {
        const [scope, value] = grokSessionEntry(data);
        const expiresIn = Number(response.expires_in);
        return { ...data, [scope]: { ...value, key: response.access_token,
          refresh_token: response.refresh_token || value.refresh_token,
          expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : undefined } };
      },
    },
    codex: {
      refreshBeforeMs: 5 * 60_000,
      endpoint: env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || 'https://auth.openai.com/oauth/token',
      clientId: env.CODEX_APP_SERVER_LOGIN_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
      read(data) {
        const value = data.tokens || data;
        return { access: value.access_token, refresh: value.refresh_token, expiresAt: jwtExpiresAt(value.access_token),
          headers: { authorization: 'Bearer ' + value.access_token,
            ...(value.account_id ? { 'chatgpt-account-id': value.account_id } : {}) } };
      },
      write(data, response, now) {
        const old = data.tokens || data;
        const updated = { ...old, access_token: response.access_token,
          refresh_token: response.refresh_token || old.refresh_token,
          ...(response.id_token ? { id_token: response.id_token } : {}) };
        return data.tokens ? { ...data, tokens: updated, last_refresh: new Date(now).toISOString() }
          : { ...updated, last_refresh: new Date(now).toISOString() };
      },
    },
  };
}

function canonicalCredential(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('OAuth credentialFile must be absolute');
  try { return fs.realpathSync(file); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return path.resolve(file); }
  }
}

function atomicCredentials(file, data) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

export class OAuthManager {
  constructor({ adapters = oauthAdapters(), request, now = Date.now, timeoutMs = 20_000,
    log = message => console.error(message), onStatus = () => {} } = {}) {
    this.adapters = adapters;
    this.request = request;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.onStatus = (entry, state) => { try { onStatus(entry, state); } catch { /* Status cannot break credential refresh. */ } };
    this.locks = new Map();
    this.failures = new Map();
    this.entries = [];
  }

  descriptor(value) {
    const provider = value.credentialFormat || value.provider;
    if (!this.adapters[provider]) throw new Error('Unsupported OAuth credential provider');
    return { provider, credentialFile: canonicalCredential(value.credentialFile) };
  }

  configure(entries) {
    const files = new Map();
    for (const value of entries) {
      const entry = this.descriptor(value);
      const previous = files.get(entry.credentialFile);
      if (previous && previous.provider !== entry.provider) throw new Error('OAuth file has conflicting provider formats');
      if (previous && (previous.isolated || value.isolated) && previous.owner !== value.owner) {
        throw new Error('Isolated OAuth credentials cannot be shared with another client or defaults');
      }
      files.set(entry.credentialFile, { ...entry, owner: value.owner, isolated: value.isolated });
    }
    this.entries = [...files.values()];
  }

  snapshot(value) {
    const entry = this.descriptor(value);
    const data = readCredentialFile(entry.credentialFile);
    const token = this.adapters[entry.provider].read(data);
    if (!token?.access && !(token?.refresh && this.adapters[entry.provider].allowRefreshOnly)) throw new Error('OAuth access token is missing');
    return { entry, data, token };
  }

  read(value) {
    const { entry, token } = this.snapshot(value);
    if (!token.access) throw new Error('OAuth access token is missing');
    return { type: 'oauth', headers: { ...token.headers }, credentialFile: entry.credentialFile, oauthProvider: entry.provider };
  }

  async getAuth(value) {
    const { token, entry, data } = this.snapshot(value);
    const needsMetadata = this.adapters[entry.provider].needsMetadata?.(data);
    if (token.refresh && (!token.access || needsMetadata || (Number.isFinite(token.expiresAt) &&
        token.expiresAt - this.now() <= this.adapters[entry.provider].refreshBeforeMs))) {
      try { await this.refresh(entry, token.access); }
      catch {
        if (needsMetadata || token.expiresAt <= this.now()) throw new Error('OAuth renewal unavailable');
      }
    }
    return this.read(entry);
  }

  async refresh(value, previousAccess) {
    const entry = this.descriptor(value);
    const key = entry.credentialFile;
    if (this.locks.has(key)) return this.locks.get(key);
    const operation = this.performRefresh(entry, previousAccess).finally(() => this.locks.delete(key));
    this.locks.set(key, operation);
    return operation;
  }

  async performRefresh(entry, previousAccess) {
    const { credentialFile: file, provider } = entry;
    const adapter = this.adapters[provider];
    const snapshot = this.snapshot(entry);
    let token = snapshot.token;
    if (previousAccess && previousAccess !== token.access) return this.read(entry);
    let signature = token.access + '\0' + token.refresh;
    const failure = this.failures.get(file);
    if (failure?.signature === signature && failure.nextAttempt > this.now()) throw new Error('OAuth refresh is backing off');
    if (!token.refresh) throw new Error('OAuth refresh token is missing');

    const controller = new AbortController();
    this.onStatus(entry, 'refreshing');
    let terminal = false;
    let reason = '';
    let timer;
    try {
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('OAuth refresh timed out'));
        }, this.timeoutMs);
      });
      const metadataOnly = adapter.needsMetadata?.(snapshot.data) && token.access && token.expiresAt - this.now() > adapter.refreshBeforeMs;
      const response = metadataOnly ? { status: 200, body: { access_token: token.access, expires_in: (token.expiresAt - this.now()) / 1000 } } : await Promise.race([
        Promise.resolve().then(() => this.request(adapter.endpoint, adapter.payload ? adapter.payload(snapshot.data, token) : {
          client_id: adapter.clientId, grant_type: 'refresh_token', refresh_token: token.refresh,
        }, { signal: controller.signal, format: adapter.format })),
        timedOut,
      ]);
      if (response.status < 200 || response.status >= 300 ||
          typeof response.body?.access_token !== 'string' || !response.body.access_token) {
        terminal = response.body?.error === 'invalid_grant' || response.status === 401;
        const code = typeof response.body?.error === 'string' && /^[\w.-]{1,40}$/.test(response.body.error) ? response.body.error : '';
        reason = 'HTTP ' + response.status + (code ? ' ' + code : '');
        throw new Error('OAuth refresh rejected');
      }
      const latest = this.snapshot(entry);
      if (latest.token.access !== token.access || latest.token.refresh !== token.refresh) {
        this.failures.delete(file);
        return this.read(entry);
      }
      // Persist a rotated refresh token before optional backend discovery. A
      // transient discovery failure must never lose the only renewable token.
      let base = latest.data;
      if (adapter.enrich && !metadataOnly) {
        base = adapter.write(base, response.body, this.now());
        writeCredentialFile(file, base);
        token = this.snapshot(entry).token;
        signature = token.access + '\0' + token.refresh;
      }
      const enriched = adapter.enrich ? await Promise.race([
        adapter.enrich(base, response.body, this.request, controller.signal), timedOut,
      ]) : base;
      // Enrichment may perform network I/O. Do not overwrite a login completed meanwhile.
      const beforeWrite = this.snapshot(entry);
      if (beforeWrite.token.access !== token.access || beforeWrite.token.refresh !== token.refresh) return this.read(entry);
      writeCredentialFile(file, adapter.write(enriched, response.body, this.now()));
      this.failures.delete(file);
      this.log('[relay] ' + provider + ' OAuth refreshed');
      this.onStatus(entry, 'connected');
      return this.read(entry);
    } catch (error) {
      try {
        const latest = this.snapshot(entry);
        if (latest.token.access !== token.access || latest.token.refresh !== token.refresh) {
          this.failures.delete(file);
          return this.read(entry);
        }
      } catch { /* invalid/deleted files fail closed */ }
      const attempts = failure?.signature === signature ? failure.attempts + 1 : 1;
      this.failures.set(file, { signature, attempts, nextAttempt: this.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts - 1, 6)) });
      // Never log parser errors verbatim: JSON.parse messages can quote credential file content.
      const detail = reason || (error?.name === 'Error' ? error.message : error?.name) || 'unknown';
      this.log('[relay] ' + provider + ' OAuth renewal failed (' + detail + '); retry is bounded/backed off');
      this.onStatus(entry, terminal ? 'loginRequired' : 'retrying');
      throw new Error('OAuth renewal failed');
    } finally { clearTimeout(timer); }
  }

  async tick() {
    const pending = [...this.entries];
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const entry = pending.shift();
        try { await this.getAuth(entry); }
        catch { this.log('[relay] ' + entry.provider + ' OAuth credential unavailable'); }
      }
    }));
  }
}

/** One bounded renewal path for HTTP/SSE and WebSocket handshakes. A WS send
 * must withhold a retryable 401 until this function decides to retry it. */
export async function withOAuthRetry(manager, auth, send, discard = () => {}) {
  const renewable = auth?.type === 'oauth' && !!auth.oauthProvider;
  const first = await send(auth, renewable);
  if ((typeof first === 'number' ? first : first.statusCode) !== 401 || !renewable) return first;
  discard(first);
  let renewed;
  try {
    renewed = await manager.refresh({ provider: auth.oauthProvider, credentialFile: auth.credentialFile },
      auth.headers.authorization?.replace(/^Bearer\s+/i, ''));
  } catch { throw Object.assign(new Error('OAuth renewal failed'), { code: 'OAUTH_REFRESH_FAILED' }); }
  return send({ ...auth, ...renewed, headers: { ...auth.headers, ...renewed.headers } }, false);
}

/** TLS-verified request through the Squid CONNECT tunnel. No redirects, 1 MB cap.
 * Resolves { status, headers, body } where body is parsed JSON or null. */
export function requestJsonThroughProxy(proxyUrl, endpoint, { method = 'POST', payload, signal, format, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const destination = new URL(endpoint);
    const proxy = new URL(proxyUrl);
    if (destination.protocol !== 'https:' || proxy.protocol !== 'http:') return reject(new Error('Unsupported OAuth transport'));
    let tunnel, request, agent;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      request?.destroy(); tunnel?.destroy(); connect.destroy(); agent?.destroy();
      error ? reject(new Error('OAuth transport failed')) : resolve(result);
    };
    const abort = () => finish(new Error('OAuth transport cancelled'));
    const connect = http.request({ hostname: proxy.hostname, port: proxy.port,
      method: 'CONNECT', path: destination.host + (destination.port ? '' : ':443') });
    signal?.addEventListener('abort', abort, { once: true });
    connect.on('error', error => finish(error));
    connect.on('connect', (response, socket) => {
      tunnel = socket;
      if (response.statusCode !== 200) return finish(new Error('OAuth tunnel refused'));
      agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tls.connect({ socket, servername: destination.hostname });
      const body = method === 'GET' ? null : format === 'form' ? new URLSearchParams(payload).toString() : JSON.stringify(payload);
      const requestHeaders = body === null ? headers
        : { ...headers, 'content-type': format === 'form' ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(body) };
      request = https.request(destination, { method, agent, headers: requestHeaders }, upstream => {
        let data = '';
        upstream.on('error', error => finish(error));
        upstream.on('aborted', () => finish(new Error('OAuth response aborted')));
        upstream.on('data', chunk => {
          data += chunk;
          if (data.length > 1024 * 1024) finish(new Error('OAuth response too large'));
        });
        upstream.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = null; }
          finish(null, { status: upstream.statusCode, headers: upstream.headers, body: parsed });
        });
      });
      request.on('error', error => finish(error));
      request.end(body ?? undefined);
    });
    if (signal?.aborted) abort(); else connect.end();
  });
}

export async function requestOAuthThroughProxy(proxyUrl, endpoint, payload, options = {}) {
  const { status, body } = await requestJsonThroughProxy(proxyUrl, endpoint, { ...options, method: 'POST', payload });
  return { status, body };
}

/** GET variant: resolves { status, headers, body }. */
/** First 12 hex chars of sha256 over the relay's own mcp-oauth.mjs and api-relay.mjs, so a stale bind mount is visible. */
export function computeRelayCode(readFile = file => fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)))) {
  const hash = crypto.createHash('sha256');
  for (const file of ['./mcp-oauth.mjs', './api-relay.mjs']) hash.update(readFile(file));
  return hash.digest('hex').slice(0, 12);
}

/** sha256 over every .mjs in the relay's code directory (name + content, sorted by name).
 * CarapaBox computes the same hash with this function and compares it to /_inflight's codeHash. */
export function relayCodeHash(dir = path.dirname(fileURLToPath(import.meta.url))) {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.mjs')).sort()) {
    hash.update(name).update('\0').update(fs.readFileSync(path.join(dir, name))).update('\0');
  }
  return hash.digest('hex');
}

export function requestOAuthGetThroughProxy(proxyUrl, endpoint, options = {}) {
  return requestJsonThroughProxy(proxyUrl, endpoint, { ...options, method: 'GET' });
}

function globMatch(pattern, str) {
  const re = new RegExp('^' + pattern.replace(/[.+^{}$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(str);
}

// `allowRoute`: the container has its own project grant for this route, so a strict client's route list does not apply.
// A route name comes from the request URL: only a registered entry counts, never an inherited property such as `constructor`.
const ownEntry = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined;

export function selectClientRoute({ clients, defaults, requireKnownClients = false }, hostname, route, { allowRoute = false } = {}) {
  const exact = requireKnownClients || clients.some(value => value.isolation === 'strict');
  const matches = hostname ? clients.filter(client => client.patterns.some(pattern => exact
    ? pattern === hostname || pattern === hostname.split('.')[0]
    : globMatch(pattern, hostname))) : [];
  const strict = matches.filter(client => client.isolation === 'strict');
  if (strict.length > 1 || (exact && matches.length > 1)) throw new Error('Ambiguous isolated relay client');
  const client = strict[0] || matches[0] || null;
  if (!client && exact) {
    throw new Error('Unrecognized relay client');
  }
  if (client?.isolation === 'strict' && !allowRoute && (!Object.hasOwn(client.providers, route) && !Object.hasOwn(client.services, route))) {
    throw new Error('Route not configured for isolated relay client');
  }
  return { clientMatch: client, clientConfig: client || defaults || null,
    clientLabel: client?.name || hostname || 'unknown' };
}

export function configuredOAuthEntries(defaults, clients) {
  const entries = [];
  for (const client of [defaults && { ...defaults, name: 'default' }, ...clients].filter(Boolean)) {
    for (const [provider, config] of [...Object.entries(client.services || {}), ...Object.entries(client.providers || {})]) {
      // Every account of a pool is kept refreshed, not only the one in use.
      if (config.auth === 'oauth') for (const credentialFile of config.credentialFiles || [config.credentialFile]) {
        entries.push({ provider, credentialFormat: config.credentialFormat,
          credentialFile, owner: client.name, isolated: client.isolation === 'strict' });
      }
    }
  }
  return entries;
}

/**
 * Expand `${VAR}` / `${VAR:-default}` in internal service endpoints so relay
 * client files need no host-specific values (e.g. the Board upstream).
 */
export function expandServiceEndpoint(config, env = process.env) {
  const expand = (value) => typeof value !== 'string' ? value
    : value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) => env[name] || fallback || '');
  const next = { ...config };
  for (const key of ['host', 'protocol', 'pathPrefix']) if (next[key] !== undefined) next[key] = expand(next[key]);
  if (next.port !== undefined) {
    const port = Number(expand(next.port));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay service port');
    next.port = port;
  }
  if (next.protocol === '') delete next.protocol;
  if (next.protocol !== undefined && !['http', 'https'].includes(next.protocol)) throw new Error('Invalid relay service protocol');
  return next;
}

export function readRelayConfigs(directory, env = process.env) {
  const clients = [];
  let defaults = null;
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object' && !Array.isArray(raw.services)) {
      raw.services = Object.fromEntries(Object.entries(raw.services).map(([name, config]) =>
        [name, config && typeof config === 'object' ? expandServiceEndpoint(config, env) : config]));
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid relay client configuration');
    const name = file.slice(0, -5);
    if (raw.isolation !== undefined && !['shared', 'strict'].includes(raw.isolation)) throw new Error('Invalid relay isolation mode');
    if (raw.requireKnownClients !== undefined && typeof raw.requireKnownClients !== 'boolean') throw new Error('Invalid relay identity policy');
    const providers = raw.providers || (name === 'default' ? Object.fromEntries(Object.entries(raw).filter(([key]) => !['services', 'requireKnownClients', 'isolation'].includes(key))) : {});
    const services = raw.services || {};
    for (const routes of [providers, services]) {
      if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('Invalid relay routes');
      for (const [routeName, config] of Object.entries(routes)) {
        const authModes = routes === services ? ['oauth', 'apikey', 'none', MCP_AUTH] : ['oauth', 'apikey', 'none'];
        if (!config || typeof config !== 'object' || !authModes.includes(config.auth)) throw new Error('Invalid relay authentication configuration');
        if (config.auth === MCP_AUTH) validateMcpOAuthConfig(routeName, config);
        if (config.requestsPerSecond !== undefined && !(Number.isFinite(config.requestsPerSecond) && config.requestsPerSecond > 0)) {
          throw new Error('Invalid relay requestsPerSecond');
        }
        if (config.gitRepos !== undefined && (!Array.isArray(config.gitRepos) || !config.gitRepos.every(validGitRepoPattern))) {
          throw new Error('Invalid relay gitRepos');
        }
        if (config.websocketPaths !== undefined && (!Array.isArray(config.websocketPaths) ||
          config.websocketPaths.some(value => typeof value !== 'string' || !/^\/[a-zA-Z0-9/_-]+\/$/.test(value)))) {
          throw new Error('Invalid internal WebSocket paths');
        }
      }
    }
    if (name === 'default') {
      if (raw.isolation === 'strict') throw new Error('Strict isolation requires a named client');
      defaults = { providers, services, requireKnownClients: raw.requireKnownClients === true };
    } else {
      const patterns = raw.match || [name + '-*', name + '_*'];
      if (!Array.isArray(patterns) || !patterns.length || patterns.some(value => typeof value !== 'string' || !value)) throw new Error('Invalid relay client match');
      if (raw.isolation === 'strict' && patterns.some(value => /[?*]/.test(value))) throw new Error('Strict clients require exact container identities');
      clients.push({ name, patterns, providers, services, isolation: raw.isolation || 'shared' });
      if (raw.isolation === 'strict' && Object.keys(services).some(route => ['anthropic', 'anthropic-api', 'codex', 'google', 'antigravity', 'openai', 'openrouter', 'nvidia', 'mistral-eu'].includes(route))) {
        throw new Error('An isolated service cannot shadow a built-in provider');
      }
    }
  }
  return { clients, defaults };
}

/** Sets one query parameter on a request path, dropping any value the client sent under that name. */
export function withQueryParam(target, name, value) {
  const at = target.indexOf('?');
  const pathname = at === -1 ? target : target.slice(0, at);
  const kept = at === -1 ? [] : target.slice(at + 1).split('&').filter(part => {
    if (!part) return false;
    const raw = part.split('=')[0];
    try { return decodeURIComponent(raw.replace(/\+/g, ' ')) !== name; } catch { return false; }
  });
  return `${pathname}?${[...kept, `${encodeURIComponent(name)}=${encodeURIComponent(value)}`].join('&')}`;
}

// Response headers that carry a URL the upstream may build from the request it saw.
const URL_RESPONSE_HEADERS = ['location', 'content-location', 'link', 'refresh'];

/**
 * Replaces an injected query token in the URL-carrying response headers (a redirect that
 * keeps the query would otherwise hand the token to the sandbox). Matches the raw value
 * and its percent-encoded spellings; every other header is returned unchanged.
 */
export function redactQueryTokenHeaders(headers, token) {
  if (!token) return headers;
  const encoded = encodeURIComponent(token);
  const spellings = [...new Set([
    token, encoded, encodeURI(token), encoded.replace(/%20/g, '+'),
    encoded.replace(/%[0-9A-F]{2}/g, hex => hex.toLowerCase()),
  ])].sort((a, b) => b.length - a.length);
  const redact = value => spellings.reduce((text, spelling) => text.split(spelling).join('[REDACTED]'), String(value));
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    if (!URL_RESPONSE_HEADERS.includes(name.toLowerCase())) continue;
    out[name] = Array.isArray(out[name]) ? out[name].map(redact) : redact(out[name]);
  }
  return out;
}

// A provider prefix is only a boundary if the remainder cannot climb out of it.
// Fail closed on dot segments, encoded dot/slash/backslash, raw backslash and NUL.
export function hasUnsafeRelayPath(url) {
  const end = url.search(/[?#]/);
  const pathname = end === -1 ? url : url.slice(0, end);
  const unsafe = (value) => /[\\\0]/.test(value) || value.split('/').some(seg => seg === '.' || seg === '..');
  if (unsafe(pathname) || /%(2e|2f|5c)/i.test(pathname)) return true;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return true; }
  return unsafe(decoded) || /%(2e|2f|5c)/i.test(decoded);
}

// Read-only git smart HTTP (`/gitlab-git/<repo>.git/...`, `/github-git/...`):
// only upload-pack (clone/fetch) is served. Repo segments use GitLab's path
// alphabet (GitHub's is a subset), so encoded or dotted spellings never reach
// the allowlist match or the upstream. Each route serves its provider's token.
export const GIT_ROUTES = { 'gitlab-git': 'gitlab', 'github-git': 'github' };
const gitRouteProvider = route => Object.hasOwn(GIT_ROUTES, route) ? GIT_ROUTES[route] : undefined;
// The user name git sends with the token: GitLab expects oauth2, GitHub accepts any.
const GIT_BASIC_USER = { gitlab: 'oauth2', github: 'x-access-token' };
const GIT_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const GIT_ENDPOINTS = {
  GET: { suffix: '.git/info/refs', query: 'service=git-upload-pack' },
  POST: { suffix: '.git/git-upload-pack', query: '' },
};

export function validGitRepoPattern(pattern) {
  return typeof pattern === 'string' && pattern.split('/').every(seg => seg === '*' || (GIT_REPO_SEGMENT.test(seg) && seg !== '.' && seg !== '..'));
}

/** `rest` is the route-relative target including its query. Returns { repo, path } or null when not an allowed upload-pack request. */
export function parseGitRequest(method, rest) {
  const endpoint = GIT_ENDPOINTS[method];
  const end = (rest || '').indexOf('?');
  const pathname = end === -1 ? rest || '' : rest.slice(0, end);
  const query = end === -1 ? '' : rest.slice(end + 1);
  if (!endpoint || query !== endpoint.query || !pathname.startsWith('/') || !pathname.endsWith(endpoint.suffix)) return null;
  const repo = pathname.slice(1, pathname.length - endpoint.suffix.length);
  if (!validGitRepoPattern(repo) || repo.includes('*')) return null;
  return { repo, path: `/${repo}${endpoint.suffix}${query ? `?${query}` : ''}` };
}

/** `*` matches exactly one path segment; every other segment must match exactly. */
export function gitRepoAllowed(patterns, repo) {
  const parts = repo.split('/');
  return Array.isArray(patterns) && patterns.some(pattern => {
    const expected = pattern.split('/');
    return expected.length === parts.length && expected.every((seg, i) => seg === '*' || seg === parts[i]);
  });
}

export function parseRetryAfterMs(headers, now = Date.now()) {
  const retryAfter = headers?.['retry-after'];
  if (!retryAfter) return 0;

  const retryAfterS = parseInt(retryAfter, 10);
  const delayMs = Number.isNaN(retryAfterS)
    ? Date.parse(retryAfter) - now
    : retryAfterS * 1000;
  return Number.isFinite(delayMs) ? Math.min(Math.max(0, delayMs), 60_000) : 0;
}

function decodeThrottleBody(rawBody, encoding) {
  try {
    if (!encoding || encoding === 'identity') return rawBody.toString('utf8');
    if (encoding === 'gzip') return zlib.gunzipSync(rawBody).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(rawBody).toString('utf8');
    if (encoding === 'deflate') return zlib.inflateSync(rawBody).toString('utf8');
  } catch { /* reported as unreadable below */ }
  return `(unreadable ${encoding} body)`;
}

/**
 * What a provider said when it throttled us: its rate-limit headers and error
 * text. Omit rawBody when the body still has to reach the client.
 */
export function describeUpstreamThrottle(headers = {}, rawBody) {
  const limits = Object.fromEntries(
    Object.entries(headers).filter(([name]) => /^retry-after$|rate-?limit/i.test(name)),
  );
  if (!rawBody) return JSON.stringify({ limits });
  const body = rawBody.length ? decodeThrottleBody(rawBody, headers['content-encoding']) : '(empty)';
  return JSON.stringify({ limits, body: body.slice(0, 1000) });
}

const NO_WAIT_TICKET = { waitMs: () => 0, release() {}, onMove: () => () => {} };

/**
 * Spaces out request starts per key. `pacer(key, rps)` reserves the next free
 * slot and returns how many milliseconds the caller must wait for it (0
 * without a limit). `pacer.reserve(key, rps)` returns a ticket instead:
 * `waitMs()` is the time left to its slot, `release()` gives the slot back so
 * later tickets move up, and `onMove(fn)` calls `fn` when that happens.
 */
export function createRequestPacer(now = Date.now) {
  const queues = new Map(); // key -> { tail, tickets } in slot order
  function reserve(key, requestsPerSecond) {
    if (!requestsPerSecond) return NO_WAIT_TICKET;
    const current = now();
    const queue = queues.get(key) ?? { tail: 0, tickets: [] };
    queues.set(key, queue);
    queue.tickets = queue.tickets.filter(t => t.slot > current);
    const interval = 1000 / requestsPerSecond;
    const listeners = new Set();
    const ticket = {
      slot: Math.max(current, queue.tail),
      waitMs: () => Math.max(0, ticket.slot - now()),
      onMove: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      notify: () => listeners.forEach(fn => fn()),
      release() {
        const index = queue.tickets.indexOf(ticket);
        if (index < 0 || ticket.slot <= now()) return;
        queue.tickets.splice(index, 1);
        queue.tail -= interval;
        for (const later of queue.tickets.slice(index)) {
          later.slot -= interval;
          later.notify();
        }
      },
    };
    queue.tail = ticket.slot + interval;
    queue.tickets.push(ticket);
    return ticket;
  }
  const pace = (key, requestsPerSecond) => reserve(key, requestsPerSecond).waitMs();
  pace.reserve = reserve;
  return pace;
}

/** Import-safe entry point. Only invoking this function starts listeners/timers. */
const REDACTED = '[REDACTED]';

export const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,                     // OpenAI / Stripe
  /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,                  // Anthropic
  /\bsk-or-[a-zA-Z0-9_-]{20,}\b/g,                   // OpenRouter
  /\bpk-[a-zA-Z0-9_-]{20,}\b/g,                      // Stripe publishable
  /\bAKIA[A-Z0-9]{16}\b/g,                            // AWS access key
  /\bghp_[a-zA-Z0-9]{36,}\b/g,                        // GitHub PAT
  /\bglpat-[a-zA-Z0-9_-]{20,}\b/g,                    // GitLab PAT
  /\bnpm_[a-zA-Z0-9]{36,}\b/g,                        // npm token
  /\bxoxb-[0-9]+-[a-zA-Z0-9]+\b/g,                    // Slack bot token
  /\b(?:mysql|postgres|postgresql|mongodb|redis|amqp):\/\/[^\s"'`,}{]+/g,
  // Env style: UPPER_SNAKE name with a keyword, single '=', value not '$', space or '='.
  // Matched forward (name is group 1, kept by scrubString): a lookbehind over the name
  // backtracks quadratically on a long [A-Z0-9_] run.
  /(?<![\w.$])(?=[A-Z0-9_]*(?:PASSWORD|PASSWD|_PWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH))([A-Z][A-Z0-9_]*=)(?![=$\s])[^\s"'`,}{]+/g,
];

// Query/CLI style: ?name=v, &name=v, --name=v; value stops at & whitespace or quotes.
// Not a single regex: a lazy keyword search inside the name run is rescanned per keyword occurrence
// when no value follows ('?' + 'auth'.repeat(n) + '='), and per-character lookaheads are slow.
// Instead the regex only finds a whole [\w.-] name run followed by '=' and a value (each run is
// consumed once), and the name is checked here: keyword anywhere after '?'/'&', or after the first
// '--'. A rejected name is skipped without its value, so a nested secret in it is still found.
const QUERY_CLI_NAME = /(?<![\w.-])([\w.-]+=)(?=[^&\s"'`])/g;
const QUERY_CLI_VALUE = /[^&\s"'`]+/y;
const SECRET_KEYWORD = /password|passwd|secret|token|api_key|auth/i;

function isQueryCliSecretName(str, start, name) {
  const before = str[start - 1];
  if (before === '?' || before === '&') return SECRET_KEYWORD.test(name);
  const dashes = name.indexOf('--');
  return dashes !== -1 && SECRET_KEYWORD.test(name.slice(dashes + 2));
}

function scrubQueryCliSecrets(str) {
  let out = '';
  let copied = 0;
  let count = 0;
  QUERY_CLI_NAME.lastIndex = 0;
  for (let match; (match = QUERY_CLI_NAME.exec(str)) !== null;) {
    const name = match[1];
    const valueStart = match.index + name.length;
    QUERY_CLI_NAME.lastIndex = valueStart;
    if (!isQueryCliSecretName(str, match.index, name)) continue;
    QUERY_CLI_VALUE.lastIndex = valueStart;
    QUERY_CLI_VALUE.test(str);
    out += str.slice(copied, valueStart) + REDACTED;
    copied = QUERY_CLI_NAME.lastIndex = QUERY_CLI_VALUE.lastIndex;
    count++;
  }
  return { text: copied === 0 ? str : out + str.slice(copied), count };
}

export function scrubString(str) {
  let scrubbed = str;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    // Only the env-style pattern has a capture group: the name prefix survives.
    scrubbed = scrubbed.replace(pattern, (_match, prefix) => {
      count++;
      return typeof prefix === 'string' ? prefix + REDACTED : REDACTED;
    });
  }
  const query = scrubQueryCliSecrets(scrubbed);
  return { text: query.text, count: count + query.count };
}

// ── In-flight tracking and graceful drain ────────────────────────────────────
// Duplicated in api-relay.mjs / llama-proxy.mjs (separate Dockerfile COPY lists).
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createDrainTracker({ codeHash } = {}) {
  let inflight = 0;
  let draining = false;
  let onIdle = null;
  return {
    get inflight() { return inflight; },
    get draining() { return draining; },
    startDraining(cb) { draining = true; onIdle = cb; if (inflight === 0) cb(); },
    // Count one unit of work until the first of `events` fires on `emitter`.
    hold(emitter, ...events) {
      let done = false;
      inflight++;
      const leave = () => {
        if (done) return;
        done = true;
        inflight--;
        if (draining && inflight === 0) onIdle?.();
      };
      for (const ev of events) emitter.once(ev, leave);
    },
    // GET /_inflight — loopback only; returns true when the request was handled.
    handleStatus(req, res) {
      if (req.url !== '/_inflight') return false;
      if (!LOOPBACK_ADDRS.has(req.socket.remoteAddress)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden\n');
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ inflight, draining, codeHash }) + '\n');
      return true;
    },
  };
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

function requestBodyLimit(value) {
  const limit = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

/**
 * Buffers a request body of at most `maxBytes`. A larger body (declared by
 * Content-Length, or crossing the cap while streaming) gets a 413 with
 * `connection: close`; the chunks read so far are dropped and `null` is
 * returned. The request is destroyed only after the 413 has been sent.
 * Rejects if the client aborts before the body is complete.
 */
export function readCappedBody(req, res, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      chunks = [];
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      settle(value);
    };
    const tooLarge = () => {
      finish(resolve, null);
      req.on('error', () => {});
      req.pause();
      const errBody = JSON.stringify({ error: 'request_too_large', message: `request body exceeds ${maxBytes} bytes` });
      res.once('finish', () => req.destroy());
      res.writeHead(413, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(errBody)),
        connection: 'close',
      });
      res.end(errBody);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return tooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks));
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error('request aborted before the body was complete'));
    // A client that aborted while the handler was awaiting (e.g. an OAuth refresh) has already
    // emitted 'close'; no further event would settle this promise.
    if (req.destroyed || req.readableAborted) { finish(reject, new Error('request aborted before the body was complete')); return; }
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) { tooLarge(); return; }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// Per http server, every accepted socket: whether it has sent a request yet and how
// many responses it is still owed. Node's http.Server#close() calls
// this.closeIdleConnections() first, which also drops a socket that was accepted just
// before the drain and has not sent its first request yet, and resets that client; a
// worker with nothing in flight would also exit under such a client. The drain
// shadows that call, closes only sockets that were served and owe nothing (idle
// keep-alive, never one with a pipelined response still streaming or an upgraded
// WebSocket, which the drain tracker holds until it closes), and waits for the rest,
// so a reload never resets a connection.
const socketStates = new WeakMap();
function trackKeepAlive(server) {
  const state = { sockets: new Map(), onChange: null };
  socketStates.set(server, state);
  const entry = socket => {
    let e = state.sockets.get(socket);
    if (!e) {
      e = { owed: 0, served: false, upgraded: false };
      state.sockets.set(socket, e);
      socket.once('close', () => { state.sockets.delete(socket); state.onChange?.(); });
    }
    return e;
  };
  server.on('connection', entry);
  server.on('upgrade', req => {
    const e = entry(req.socket);
    e.served = true;
    e.upgraded = true;
  });
  server.on('request', (req, res) => {
    const e = entry(req.socket);
    e.owed++;
    e.served = true;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      e.owed--;
      state.onChange?.();
    };
    res.once('finish', settle);
    res.once('close', settle);
  });
  return server;
}
const socketEntries = server => socketStates.get(server)?.sockets ?? new Map();
function closeIdleKeepAlive(server) {
  for (const [socket, e] of socketEntries(server)) if (e.served && !e.upgraded && e.owed === 0) socket.destroy();
}

// How long a drain waits for accepted connections to send their first request.
const DRAIN_ACCEPT_GRACE_MS = 5000;

// Stop accepting connections, wait for in-flight work and for accepted connections
// that have not sent their request yet (at most DRAIN_ACCEPT_GRACE_MS), then exit(0).
// `servers` stop listening immediately and their idle keep-alive sockets close;
// RELAY_DRAIN_TIMEOUT_MS caps the wait for in-flight work (default 15 min). A second
// signal is ignored.
function drainAndExit(tracker, servers, { name, env = process.env, cleanup = () => {} } = {}) {
  if (tracker.draining) return;
  const parsed = parseInt(env.RELAY_DRAIN_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 900_000;
  console.log(`[drain] start inflight=${tracker.inflight} (${name})`);
  let cap = null;
  let graceTimer = null;
  let graceOver = false;
  const finish = (msg) => {
    clearTimeout(cap);
    clearTimeout(graceTimer);
    console.log(msg);
    process.exit(0);
  };
  const awaitingClients = () => servers.some(s => [...socketEntries(s).values()].some(e => !e.served || e.owed > 0));
  const tryFinish = () => {
    if (tracker.inflight === 0 && (graceOver || !awaitingClients())) finish('[drain] done');
  };
  for (const s of servers) {
    const state = socketStates.get(s);
    if (state) state.onChange = tryFinish;
  }
  tracker.startDraining(tryFinish);
  try { cleanup(); } catch { }
  for (const s of servers) {
    s.closeIdleConnections &&= () => {};
    try { s.close(); } catch { }
    try { closeIdleKeepAlive(s); } catch { }
  }
  // Also armed for accepted clients that have not sent a request yet: one that
  // arrives during the grace is in-flight work and needs the same deadline.
  if (tracker.inflight > 0 || awaitingClients()) {
    cap = setTimeout(() => finish(`[drain] timeout after ${timeoutMs}ms, inflight=${tracker.inflight} — exiting`), timeoutMs);
  }
  if (awaitingClients()) {
    graceTimer = setTimeout(() => { graceOver = true; tryFinish(); }, DRAIN_ACCEPT_GRACE_MS);
  }
}

export function startApiRelay({ env = process.env, port = 8080, host, clientsDir, hostnameResolver,
  oauthRequest, mcpOAuthRequest, relayFileReader, externalRequest, pathCapability, localRoute } = {}) {
  const proxyUrl = env.HTTP_PROXY || env.HTTPS_PROXY;
  if (!proxyUrl) throw new Error('HTTP_PROXY is required');
  const proxy = new URL(proxyUrl);
  const timers = [];
  // OAuth validates upstream TLS. Existing forwarding behavior is unchanged.

  const PORT = port;
  // RELAY_MODE=forward: this relay (on a box) holds no provider credentials
  // and forwards every request to the hub's central relay, signed.
  const FORWARD_MODE = env.RELAY_MODE === 'forward';

  // ── Secret reading (Docker Compose file-based secrets) ──────────────────
  // Secrets are mounted at /run/secrets/<name> by Docker Compose.
  // Falls back to environment variables for backward compatibility.
  // Env var names are normalised to lowercase with underscores for the
  // secret file lookup: ANTHROPIC_API_KEY → /run/secrets/anthropic_api_key

  const SECRETS_DIR = env.SECRETS_DIR || '/run/secrets';

  function readSecret(envName) {
    const secretName = envName.toLowerCase();

    try {
      const val = fs.readFileSync(path.join(SECRETS_DIR, secretName), 'utf8').trim();
      if (val) return val;
    } catch { /* ignore */ }

    return env[envName] || '';
  }


  // A Board-managed API key (provider-accounts credentials/<id>.json). A
  // missing or unreadable file fails the request rather than using another key.
  function readKeyFile(file) {
    try {
      const key = readCredentialFile(file)?.apiKey;
      return typeof key === 'string' && key ? key : null;
    } catch { return null; }
  }

  /** The shared default's key for a provider route: a managed key when one is connected, else the Compose secret. */
  function sharedRouteKey(route, envName) {
    const keyFile = ownEntry(defaultConfig?.providers, route)?.keyFile;
    return keyFile ? readKeyFile(keyFile) || '' : readSecret(envName);
  }


  // ── Secret scrubbing ────────────────────────────────────────────────────
  // Redacts common secret patterns from outbound LLM request bodies to
  // prevent exfiltration via prompts. Disable with SCRUB_SECRETS=0.

  const SCRUB_ENABLED = env.SCRUB_SECRETS !== '0';

  // Cap for every buffered request body (provider, service, MCP OAuth, antigravity).
  const MAX_REQUEST_BODY_BYTES = requestBodyLimit(env.RELAY_MAX_REQUEST_BODY_BYTES);

  function scrubSecrets(bodyStr) {
    if (!SCRUB_ENABLED) return { text: bodyStr, count: 0 };

    // Try JSON-aware scrubbing: only scrub inside string values to avoid
    // corrupting JSON structure (replacement text differs in length)
    try {
      const obj = JSON.parse(bodyStr);
      let count = 0;
      const scrubValues = (node) => {
        if (typeof node === 'string') {
          const { text, count: c } = scrubString(node);
          count += c;
          return text;
        }
        if (Array.isArray(node)) return node.map(scrubValues);
        if (node && typeof node === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(node)) out[k] = scrubValues(v);
          return out;
        }
        return node;
      };
      const scrubbed = scrubValues(obj);
      return { text: count > 0 ? JSON.stringify(scrubbed) : bodyStr, count };
    } catch {
      // Not valid JSON — fall back to raw string scrubbing
      const { text, count } = scrubString(bodyStr);
      return { text, count };
    }
  }

  const TEXT_OR_JSON_TYPE = /^text\/|\/(?:[\w.+-]*\+)?(?:x-)?(?:nd)?json$/;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Scrub an outbound request body, but only when it is text: a text or JSON
   * content type, identity encoding and valid UTF-8. Anything else (Connect/protobuf,
   * compressed, truncated multibyte) is returned byte-identical, since rewriting it
   * changes lengths and breaks the framing.
   */
  function scrubRequestBody(body, headers) {
    const unchanged = { body, count: 0 };
    if (!SCRUB_ENABLED || body.length === 0) return unchanged;
    const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
    if (!TEXT_OR_JSON_TYPE.test(type) || (encoding && encoding !== 'identity')) return unchanged;
    let bodyStr;
    try { bodyStr = utf8Decoder.decode(body); } catch { return unchanged; }
    const { text, count } = scrubSecrets(bodyStr);
    return count > 0 ? { body: Buffer.from(text, 'utf8'), count } : unchanged;
  }

  // ── Per-client configuration ─────────────────────────────────────────────

  const CLIENTS_DIR = clientsDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay-clients');

  let clientConfigs = [];   // [{ name, patterns: string[], providers: {...}, services: {...} }]
  let defaultConfig = null; // { providers, services } from default.json
  let projectGrants = [];   // project keys: [{ provider, project, containers, allow, route }]
  let configHealthy = false;


  // Encryption at rest (opt-in): a named but unusable key stops the relay rather
  // than writing secrets in the clear. Existing unsealed files are sealed before
  // the first refresh can rewrite them.
  if (env.PROVIDER_ACCOUNTS_DIR && !FORWARD_MODE && configureCredentialSealing(env, env.PROVIDER_ACCOUNTS_DIR)) {
    const sealed = sealPlaintextCredentials(env.PROVIDER_ACCOUNTS_DIR);
    console.log(`[relay] Credential encryption on${sealed ? `; sealed ${sealed} existing file(s)` : ''}`);
  }

  const accountPool = createAccountPool({ directory: env.PROVIDER_ACCOUNTS_DIR });

  const oauthManager = new OAuthManager({
    adapters: oauthAdapters(env),
    request: oauthRequest || ((endpoint, payload, options) => requestOAuthThroughProxy(proxyUrl, endpoint, payload, options)),
    onStatus(entry, state) {
      if (!env.PROVIDER_ACCOUNTS_DIR || path.dirname(entry.credentialFile) !== path.join(env.PROVIDER_ACCOUNTS_DIR, 'credentials')) return;
      const directory = path.join(env.PROVIDER_ACCOUNTS_DIR, 'status');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicCredentials(path.join(directory, path.basename(entry.credentialFile)), { state, updatedAt: Date.now() });
    },
  });

  // Last observed Muse subscription usage beside the managed account, for Box.
  function recordMuseUsage(upstream, credentialFile) {
    if (!env.PROVIDER_ACCOUNTS_DIR || path.dirname(credentialFile) !== path.join(env.PROVIDER_ACCOUNTS_DIR, 'credentials')) return;
    upstream.on('data', museUsageScanner(subscription => {
      try {
        const directory = path.join(env.PROVIDER_ACCOUNTS_DIR, 'usage');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicCredentials(path.join(directory, path.basename(credentialFile)), { observedAt: Date.now(), subscription });
      } catch { /* Usage display never affects the stream. */ }
    }));
  }

  // OpenRouter is prepaid credits, not a login. Only the relay holds its key,
  // so it records the balance beside the managed accounts for Box to display.
  async function recordOpenRouterCredits() {
    const key = sharedRouteKey('openrouter', 'OPENROUTER_API_KEY');
    if (FORWARD_MODE || !env.PROVIDER_ACCOUNTS_DIR || !key) return;
    try {
      const { status, body } = await requestOAuthGetThroughProxy(proxyUrl, 'https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      const totalCredits = Number(body?.data?.total_credits), totalUsage = Number(body?.data?.total_usage);
      if (status !== 200 || !Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return;
      const directory = path.join(env.PROVIDER_ACCOUNTS_DIR, 'usage');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicCredentials(path.join(directory, 'openrouter.json'), { observedAt: Date.now(), totalCredits, totalUsage });
    } catch { /* Balance display never affects routing; Box shows the last recorded value. */ }
  }

  // Anthropic reports API spend only to an admin credential, never to the key
  // the relay injects, so a separate admin key is read for this alone. Each
  // admin key records its organisation's spend; the shared one (or the legacy
  // secret) also records the default spend in anthropic-api.json.
  async function recordAnthropicApiCost() {
    if (FORWARD_MODE || !env.PROVIDER_ACCOUNTS_DIR) return;
    let admins;
    try { admins = anthropicAdminKeys(env.PROVIDER_ACCOUNTS_DIR); } catch { return; }
    const targets = admins.map(({ account, file }) => ({ key: readKeyFile(file),
      files: [account.credentialId + '.json', ...(account.scope === 'shared' ? ['anthropic-api.json'] : [])] }));
    if (!admins.some(({ account }) => account.scope === 'shared')) {
      targets.push({ key: readSecret('ANTHROPIC_ADMIN_KEY'), files: ['anthropic-api.json'] });
    }
    for (const target of targets) if (target.key) await recordAnthropicApiCostWith(target);
  }
  async function recordAnthropicApiCostWith({ key, files }) {
    try {
      const start = new Date();
      start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      const periodStart = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pages = [];
      let page;
      do {
        const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${periodStart}&group_by[]=description&limit=31`
          + (page ? `&page=${encodeURIComponent(page)}` : '');
        const { status, body } = await requestOAuthGetThroughProxy(proxyUrl, url, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (status !== 200 || !Array.isArray(body?.data)) return;
        pages.push(body);
        page = body.has_more ? body.next_page : undefined;
      } while (page && pages.length < 10);
      const directory = path.join(env.PROVIDER_ACCOUNTS_DIR, 'usage');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const spend = { observedAt: Date.now(), periodStart, ...summarizeAnthropicCost(pages) };
      for (const file of files) atomicCredentials(path.join(directory, file), spend);
    } catch { /* Spend display never affects routing; Box shows the last recorded value. */ }
  }

  // OpenRouter's public model list carries each model's price; recorded as USD per million tokens.
  async function recordOpenRouterPrices() {
    if (FORWARD_MODE || !env.PROVIDER_ACCOUNTS_DIR || !sharedRouteKey('openrouter', 'OPENROUTER_API_KEY')) return;
    try {
      const { status, body } = await requestOAuthGetThroughProxy(proxyUrl, 'https://openrouter.ai/api/v1/models', {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (status !== 200 || !Array.isArray(body?.data)) return;
      const perMillion = value => { const n = Number(value) * 1e6; return Number.isFinite(n) && n >= 0 ? Number(n.toPrecision(6)) : undefined; };
      const models = {};
      for (const model of body.data) {
        const input = perMillion(model?.pricing?.prompt), output = perMillion(model?.pricing?.completion);
        if (typeof model?.id !== 'string' || input === undefined || output === undefined) continue;
        models[model.id] = { name: String(model.name || model.id), input, output, cacheRead: perMillion(model.pricing.input_cache_read) };
      }
      if (!Object.keys(models).length) return;
      const directory = path.join(env.PROVIDER_ACCOUNTS_DIR, 'usage');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicCredentials(path.join(directory, 'openrouter-prices.json'), { observedAt: Date.now(), models });
    } catch { /* Prices are informational; Box shows the last recorded list. */ }
  }

  function loadClientConfigs(initial = false) {
    try {
      const base = fs.existsSync(CLIENTS_DIR) ? readRelayConfigs(CLIENTS_DIR, env)
        : initial ? { clients: [], defaults: null } : (() => { throw new Error('Relay config directory disappeared'); })();
      const next = applyProviderAccounts(env.PROVIDER_ACCOUNTS_DIR, base);
      if (next.clients.some(client => client.isolation === 'strict') && env.RELAY_REQUIRE_KNOWN_CLIENTS !== '1') {
        throw new Error('Strict profiles require RELAY_REQUIRE_KNOWN_CLIENTS=1');
      }
      configuredMcpOAuthServices(next.defaults, next.clients); // rejects conflicting definitions
      // A forwarder holds no provider credentials: the hub's relay is the
      // single OAuth refresher.
      if (!FORWARD_MODE) oauthManager.configure(configuredOAuthEntries(next.defaults, next.clients));
      clientConfigs = next.clients;
      defaultConfig = next.defaults;
      projectGrants = next.projectGrants || [];
      configHealthy = true;
      console.log('[relay] Loaded ' + clientConfigs.length + ' client configuration(s), ' + projectGrants.length + ' project key(s)');
    } catch {
      if (initial) throw new Error('Invalid relay configuration; refusing startup');
      configHealthy = false;
      console.error('[relay] Invalid configuration reload; credential routing disabled until corrected');
    }
  }
  loadClientConfigs(true);

  // MCP OAuth login processor: only where provider accounts live and this relay
  // holds credentials (never a forwarder).
  const mcpOAuth = env.PROVIDER_ACCOUNTS_DIR && !FORWARD_MODE ? createMcpOAuthProcessor({
    accountsDir: env.PROVIDER_ACCOUNTS_DIR,
    getServices: () => configuredMcpOAuthServices(defaultConfig, clientConfigs),
    request: mcpOAuthRequest || (options => requestJsonThroughProxy(proxyUrl, options.url, options)),
    readSecret,
  }) : null;
  mcpOAuth?.start();

  let _watchTimer;
  let configWatcher;
  try {
    if (fs.existsSync(CLIENTS_DIR)) {
      configWatcher = fs.watch(CLIENTS_DIR, { persistent: false }, () => {
        clearTimeout(_watchTimer);
        _watchTimer = setTimeout(() => loadClientConfigs(), 500);
      });
      configWatcher.on('error', () => console.error('[relay] Config watcher unavailable; polling remains active'));
    }
  } catch { console.error('[relay] Config watcher unavailable; polling remains active'); }
  function configSignature() {
    try {
      const files = fs.readdirSync(CLIENTS_DIR).filter(name => name.endsWith('.json')).sort().map(name => path.join(CLIENTS_DIR, name));
      if (env.PROVIDER_ACCOUNTS_DIR && fs.existsSync(path.join(env.PROVIDER_ACCOUNTS_DIR, 'accounts.json'))) files.push(path.join(env.PROVIDER_ACCOUNTS_DIR, 'accounts.json'));
      return files.map(file => {
        const stat = fs.statSync(file);
        return [file, stat.ino, stat.size, stat.mtimeMs].join(':');
      }).join('|');
    } catch { return null; }
  }
  let lastConfigSignature = configSignature();
  timers.push(setInterval(() => {
    const signature = configSignature();
    if (signature !== lastConfigSignature) {
      lastConfigSignature = signature;
      loadClientConfigs();
    }
  }, 5000));

  // ── Hostname resolution (Docker reverse DNS) ────────────────────────────

  const hostnameCache = new Map(); // ip -> { hostname, ts }
  const HOSTNAME_TTL = 60_000;

  async function resolveClientHostname(ip) {
    if (hostnameResolver) {
      try { return await hostnameResolver(ip); } catch { return null; }
    }
    const clean = ip.replace(/^::ffff:/, '');
    const cached = hostnameCache.get(clean);
    if (cached && Date.now() - cached.ts < HOSTNAME_TTL) return cached.hostname;
    try {
      const names = await dns.reverse(clean);
      const hostname = names[0] || null;
      hostnameCache.set(clean, { hostname, ts: Date.now() });
      return hostname;
    } catch {
      hostnameCache.set(clean, { hostname: null, ts: Date.now() });
      return null;
    }
  }

  const CARAPA_BOX_URL = env.CARAPA_BOX_URL || 'http://host.docker.internal:3100';
  const CARAPA_BOX_ADMIN_TOKEN = readSecret('CARAPA_BOX_ADMIN_TOKEN') || readSecret('CARAPA_BOX_API_TOKEN');
  // positive: token is stable for the sandbox's life. A forwarder re-reads its
  // box's local store almost every time: the hub cannot refresh a forwarded
  // credential, so a token cached across a rotation would be sent until expiry.
  const TOKEN_CACHE_TTL_MS = FORWARD_MODE ? 5 * 1000 : 5 * 60 * 1000;
  const TOKEN_CACHE_NEG_TTL_MS = 15 * 1000;        // negative: re-check soon (sandbox may be starting)
  const tokenCache = new Map(); // name -> { token: string|null, exp: number }

  function fetchBoxToken(name, service) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const url = new URL(`/api/admin/relay-token/${encodeURIComponent(name)}`, CARAPA_BOX_URL);
        // Service scope (e.g. carapa-mail) selects a per-service token instead
        // of the bare board token. Omitted → unchanged board behaviour.
        if (service) url.searchParams.set('service', service);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${CARAPA_BOX_ADMIN_TOKEN}` },
          timeout: 4000,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const tok = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.token;
                return done(typeof tok === 'string' && tok ? tok : null);
              } catch { return done(null); }
            }
            if (res.statusCode !== 404) {
              console.error(`[relay] carapa-box token lookup for "${name}" -> HTTP ${res.statusCode}`);
            }
            done(null);
          });
        });
        req.on('error', (err) => { console.error(`[relay] carapa-box token lookup error for "${name}":`, err.code || err.message); done(null); });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.end();
      } catch (err) {
        console.error(`[relay] carapa-box token lookup failed for "${name}":`, err.message);
        done(null);
      }
    });
  }

  // Egress network suffix (compose project name) -> board project instance, resolved by
  // the Box that registered the sandbox. Fails closed: null on any error, never the raw suffix.
  const identityCache = new Map(); // suffix -> { instance: string|null, exp: number }
  function fetchBoxInstance(suffix) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const url = new URL(`/api/admin/relay-identity/${encodeURIComponent(suffix)}`, CARAPA_BOX_URL);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${CARAPA_BOX_ADMIN_TOKEN}` },
          timeout: 4000,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const instance = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.instance;
                return done(typeof instance === 'string' && /^[\w-]{1,128}$/.test(instance) ? instance : null);
              } catch { return done(null); }
            }
            if (res.statusCode !== 404) console.error(`[relay] carapa-box identity lookup for "${suffix}" -> HTTP ${res.statusCode}`);
            done(null);
          });
        });
        req.on('error', (err) => { console.error(`[relay] carapa-box identity lookup error for "${suffix}":`, err.code || err.message); done(null); });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.end();
      } catch (err) {
        console.error(`[relay] carapa-box identity lookup failed for "${suffix}":`, err.message);
        done(null);
      }
    });
  }

  async function resolveProjectInstance(suffix) {
    const hit = identityCache.get(suffix);
    if (hit && hit.exp > Date.now()) return hit.instance;
    const instance = await fetchBoxInstance(suffix);
    identityCache.set(suffix, { instance, exp: Date.now() + (instance ? TOKEN_CACHE_TTL_MS : TOKEN_CACHE_NEG_TTL_MS) });
    return instance;
  }

  // Candidate identities to look up a per-sandbox token under, in precedence
  // order (same scheme the old file resolver used).
  function buildTokenCandidates(clientHostname) {
    const candidates = new Set();
    if (!clientHostname) return candidates;
    candidates.add(clientHostname);

    // 1. Name before the first dot (just the container name)
    const dotIndex = clientHostname.indexOf('.');
    if (dotIndex > 0) {
      candidates.add(clientHostname.substring(0, dotIndex));
    }

    // 2. Project name from agent_egress suffix
    // e.g. "carapa-agent-1.agent_egress_my-project" -> "my-project"
    const egressMatch = clientHostname.match(/\.agent_egress_([\w-]+)$/);
    if (egressMatch) {
      const projectName = egressMatch[1];
      candidates.add(projectName);
      candidates.add(`${projectName}-sandbox-1`); // Matches register.ts default
    }
    return candidates;
  }

  // Drop cached tokens for this client so the next resolve re-pulls from
  // carapa-box. Called when the board rejects an injected token (it was rotated
  // by the sandbox lifecycle while our cache was still warm).
  // Cache key namespaces service-scoped tokens so a sandbox's board token and
  // its carapa-mail token don't clobber each other under the same candidate name.
  function tokenCacheKey(name, service) {
    return service ? `${service}::${name}` : name;
  }

  function invalidatePerClientToken(clientHostname, service) {
    if (forwardContext.getStore()) return; // forwarded credentials are not cached here
    for (const name of buildTokenCandidates(clientHostname)) {
      tokenCache.delete(tokenCacheKey(name, service));
    }
  }

  async function resolvePerClientToken(clientHostname, service) {
    // A verified forwarded request carries the sandbox's credentials from
    // the box that runs it.
    const forwarded = forwardContext.getStore();
    if (forwarded) return forwarded.credentials[service || ''] || null;
    if (!clientHostname) return null;
    if (!CARAPA_BOX_ADMIN_TOKEN) return null; // not configured — fall back to envKey upstream

    const scope = service ? ` [${service}]` : '';
    for (const name of buildTokenCandidates(clientHostname)) {
      const cacheKey = tokenCacheKey(name, service);
      const now = Date.now();
      const cached = tokenCache.get(cacheKey);
      if (cached && cached.exp > now) {
        if (cached.token) {
          console.log(`[relay] using cached auto-token${scope} for ${clientHostname} (candidate "${name}")`);
          return cached.token;
        }
        continue; // cached negative — skip without re-fetching
      }

      const token = await fetchBoxToken(name, service);
      tokenCache.set(cacheKey, {
        token,
        exp: now + (token ? TOKEN_CACHE_TTL_MS : TOKEN_CACHE_NEG_TTL_MS),
      });
      if (token) {
        console.log(`[relay] discovered auto-token${scope} for ${clientHostname} via carapa-box (candidate "${name}")`);
        return token;
      }
    }

    return null;
  }

  // `selection` names the request's session and the pooled accounts it must
  // not use again ({ session, skip }); it matters only to a route with several accounts.
  async function resolveAuthFromConfig(config, providerName, clientHostname, internalService = false, selection = {}) {
    if (config.auth === 'none') return { type: 'none', headers: {} };

    if (config.auth === 'oauth') {
      const files = config.credentialFiles || [config.credentialFile];
      const skip = new Set(selection.skip);
      // An account whose sign-in cannot be used is passed over for the next one.
      for (let attempt = 0; attempt < files.length; attempt++) {
        const credentialFile = config.credentialFiles
          ? accountPool.choose(config.pool, files, selection.session || clientHostname || 'unknown', skip) : config.credentialFile;
        if (!credentialFile) return null;
        try {
          const result = await oauthManager.getAuth({ provider: providerName, credentialFormat: config.credentialFormat, credentialFile });
          if (config.extraHeaders) Object.assign(result.headers, config.extraHeaders);
          if (config.credentialFiles) result.pool = { files };
          return result;
        } catch { skip.add(credentialFile); }
      }
      return null;
    }

    if (config.auth === 'apikey') {
      // Box auto-tokens authenticate internal Board/Mail services, not external APIs.
      // A managed key file replaces the route's secret; a missing file fails closed.
      if (providerName === 'google') return googleApiKeyAuthFromConfig(config.keyFile
        ? { ...config, apiKey: readKeyFile(config.keyFile) || undefined, envKey: undefined } : config, readSecret);
      // 1. Try dedicated per-client token first. `tokenService` opts a service
      //    into a service-scoped lookup (e.g. carapa-mail's per-account MCP
      //    token); without it the bare board token is used as before.
      let key = internalService ? await resolvePerClientToken(clientHostname, config.tokenService) : null;

      // 2. Fall back to a managed key, a static key or the shared envKey
      if (!key) {
        key = config.keyFile ? readKeyFile(config.keyFile)
          : config.apiKey || (config.envKey ? readSecret(config.envKey) : null);
      }

      if (!key) return null;
      const headers = {};
      // A project integration says how its token is sent.
      const tokenAuth = config.tokenAuth;
      if (tokenAuth) {
        if (tokenAuth.type === 'bearer') headers.authorization = `Bearer ${key}`;
        else if (tokenAuth.type === 'header') headers[tokenAuth.name] = key;
        else if (tokenAuth.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${tokenAuth.username}:${key}`).toString('base64')}`;
        else if (tokenAuth.type === 'query') return { type: 'static', headers, query: { name: tokenAuth.name, value: key } };
        else return null;
        return { type: 'static', headers };
      }
      if (providerName === 'anthropic' || providerName === 'anthropic-api') {
        headers['x-api-key'] = key;
      } else if (providerName === 'gitlab') {
        headers['PRIVATE-TOKEN'] = key;
      } else {
        headers.authorization = `Bearer ${key}`;
      }
      const result = { type: 'static', headers };
      if (config.extraHeaders) Object.assign(result.headers, config.extraHeaders);
      return result;
    }

    return null;
  }

  async function resolveAuth(providerName, provider, clientConfig, clientHostname, selection) {
    const perClient = ownEntry(clientConfig?.providers, providerName);
    const config = perClient || (clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, providerName) : null);
    if (!config) {
      if (clientConfig?.isolation === 'strict') return null;
      const auth = provider.getAuth();
      if (auth?.oauthProvider) {
        try { return await oauthManager.getAuth({ provider: auth.oauthProvider, credentialFile: auth.credentialFile }); }
        catch { return null; }
      }
      return auth;
    }
    return await resolveAuthFromConfig(config, providerName, clientHostname, false, selection);
  }

  // ── Internal service resolution ─────────────────────────────────────────
  // Services are defined in relay-clients config under "services" key:
  //   { "services": { "mcp-relay": { "host": "mcp-relay", "port": 3000, "auth": "apikey", "envKey": "MCP_RELAY_TOKEN" } } }

  async function resolveService(serviceName, clientConfig) {
    const perClient = ownEntry(clientConfig?.services, serviceName);
    const fromDefault = ownEntry(defaultConfig?.services, serviceName);
    return perClient || (clientConfig?.isolation === 'strict' ? null : fromDefault) || null;
  }

  async function resolveServiceAuth(serviceName, serviceConfig, clientHostname) {
    if (!serviceConfig) return null;
    return await resolveAuthFromConfig(serviceConfig, serviceName, clientHostname, true);
  }

  // ── Provider definitions ─────────────────────────────────────────────────

  const PROVIDERS = {
    antigravity: {
      host: 'cloudcode-pa.googleapis.com',
      getAuth() { return null; },
    },
    anthropic: {
      host: 'api.anthropic.com',
      envKey: 'ANTHROPIC_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { 'x-api-key': key } };
        return null;
      },

    },
    // Same API as /anthropic, but always the API key, so an agent can choose
    // API credits over the subscription OAuth that /anthropic usually carries.
    'anthropic-api': {
      host: 'api.anthropic.com',
      envKey: 'ANTHROPIC_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { 'x-api-key': key } };
        return null;
      },
    },
    openai: {
      host: 'api.openai.com',
      envKey: 'OPENAI_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
        return null;
      },
    },
    google: {
      host: 'generativelanguage.googleapis.com',
      envKey: 'GOOGLE_API_KEY',
      getAuth() {
        // Google OAuth cannot go through the relay — the CLI hardcodes
        // cloudcode-pa.googleapis.com and the token scopes don't match
        // generativelanguage.googleapis.com.  Only API key auth is supported.
        const key = readSecret(this.envKey);
        return googleApiKeyAuth(key);
      },
    },
    codex: {
      host: 'chatgpt.com',
      pathPrefix: '/backend-api/codex',  // chatgpt.com expects /backend-api/codex/...
      envKey: 'OPENAI_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
        return null;
      },

    },
    openrouter: {
      host: 'openrouter.ai',
      pathPrefix: '/api',
      envKey: 'OPENROUTER_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
        return null;
      },
    },
    nvidia: {
      host: 'integrate.api.nvidia.com',
      envKey: 'NVIDIA_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
        return null;
      },
    },
    // Mistral's EU regional endpoint. api.mistral.ai is the global default and
    // does not guarantee EU processing, so the host is fixed here on purpose
    // and Squid allows only this name.
    'mistral-eu': {
      host: 'api.eu.mistral.ai',
      envKey: 'MISTRAL_API_KEY',
      getAuth() {
        const key = readSecret(this.envKey);
        if (key) return { type: 'static', headers: { authorization: `Bearer ${key}` } };
        return null;
      },
    },
  };

  // ── Proxy setup ──────────────────────────────────────────────────────────

  // ── Request forwarding ───────────────────────────────────────────────────

  // Upstream timeouts. A squid reconfigure (triggered on every agent stack
  // start/stop) briefly closes port 3128 and can sever an in-flight CONNECT
  // tunnel without a FIN/RST the TLS client notices — leaving the request hanging
  // forever with no data and no error, until the board's stall watchdog kills the
  // whole run minutes later. These bound that:
  //   RELAY_UPSTREAM_CONNECT_TIMEOUT_MS — max wait to establish the CONNECT tunnel
  //   RELAY_UPSTREAM_IDLE_TIMEOUT_MS    — max gap with no bytes on an open tunnel.
  // The idle timer resets on every byte read/written, including the periodic SSE
  // keepalives cloud LLM providers send, so a live (even slow) stream never trips
  // it — only a genuinely dead tunnel does. On trip the socket is destroyed,
  // which surfaces as an error so the agent fails fast and retries.
  const UPSTREAM_CONNECT_TIMEOUT_MS = parseInt(env.RELAY_UPSTREAM_CONNECT_TIMEOUT_MS || '30000', 10);
  const UPSTREAM_IDLE_TIMEOUT_MS = parseInt(env.RELAY_UPSTREAM_IDLE_TIMEOUT_MS || '120000', 10);

  // Internal services are contacted directly (without Squid). Bound both the
  // initial connection and an otherwise silent response so a wedged MCP/HTTP
  // service cannot leave an agent tool call pending forever. MCP SSE streams
  // send keep-alives, so the idle limit is safe for long-lived sessions.
  const INTERNAL_CONNECT_TIMEOUT_MS = parseInt(env.RELAY_INTERNAL_CONNECT_TIMEOUT_MS || '10000', 10);
  const INTERNAL_IDLE_TIMEOUT_MS = parseInt(env.RELAY_INTERNAL_IDLE_TIMEOUT_MS || '120000', 10);

  /**
   * Pipe an upstream response to the client with error wiring. Without an 'error'
   * listener, a socket destroyed mid-stream (e.g. by the idle timeout above) would
   * throw an uncaught 'error' on the upstream stream and crash the relay; instead
   * we tear down the client response so the agent sees a broken connection.
   */
  function pipeUpstreamToClient(upstream, res, label) {
    let upstreamEnded = false;
    const destroyUpstreamOnClientClose = () => {
      if (!upstreamEnded) upstream.destroy();
    };
    upstream.once('end', () => {
      upstreamEnded = true;
      res.removeListener('close', destroyUpstreamOnClientClose);
    });
    res.once('close', destroyUpstreamOnClientClose);
    upstream.on('error', (err) => {
      console.error(`[relay] upstream stream error${label ? ` (${label})` : ''}: ${err.message}`);
      if (!res.writableEnded) res.destroy(err);
    });
    upstream.pipe(res, { end: true });
  }

  // Squid CONNECT tunnels are end-to-end TLS (no ssl_bump), so verify the real
  // provider certificate unless the provider explicitly opts out.
  const verifiesUpstreamTls = (provider) => provider.verifyTls !== false;
  const TLS_VERIFY_ERROR = /CERT|SIGNATURE|ISSUER|SELF_SIGNED|EXPIRED|ERR_TLS/;

  function upstreamTlsError(provider, err) {
    if (!verifiesUpstreamTls(provider) || !TLS_VERIFY_ERROR.test(err?.code || '')) return err;
    const wrapped = new Error(`Upstream TLS verification failed for ${provider.host}: ${err.code}`);
    wrapped.code = err.code;
    wrapped.tlsHost = provider.host;
    return wrapped;
  }

  function badGatewayMessage(err) {
    return err?.tlsHost ? `Bad Gateway: upstream TLS verification failed for ${err.tlsHost} (${err.code})` : 'Bad Gateway';
  }

  /** The upstream host a provider route (or its managed account) resolves to. */
  function upstreamHost(overrides, baseHost = '') {
    const rawEnvHost = overrides.envHost ? env[overrides.envHost] : null;
    return (rawEnvHost ? rawEnvHost.replace(/^https?:\/\//, '') : null) || overrides.host || baseHost;
  }

  function forwardRequest(provider, targetPath, method, headers, body) {
    if (externalRequest) return externalRequest(provider, targetPath, method, headers, body);
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: `${provider.host}:443`,
      });

      // Tunnel-establishment timeout. Cleared once connected — a streaming
      // response legitimately outlives this, so it must NOT stay armed on the
      // tunnel socket (that would kill every response longer than the timeout).
      const connectTimer = setTimeout(() => {
        connectReq.destroy(new Error(`CONNECT tunnel timeout after ${UPSTREAM_CONNECT_TIMEOUT_MS}ms`));
      }, UPSTREAM_CONNECT_TIMEOUT_MS);

      connectReq.on('connect', (_res, socket) => {
        clearTimeout(connectTimer);
        if (_res.statusCode !== 200) { socket.destroy(); reject(new Error('Upstream tunnel refused')); return; }

        // Idle timeout on the live tunnel socket (covers waiting-for-headers and
        // mid-stream stalls). On inactivity, destroy → tlsReq/upstream emits error.
        socket.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS);
        socket.on('timeout', () => {
          socket.destroy(new Error(`upstream idle timeout after ${UPSTREAM_IDLE_TIMEOUT_MS}ms`));
        });

        // Ensure Content-Length is correct if body was provided
        const streamed = typeof body?.pipe === 'function';
        if (body && !streamed) {
          headers['content-length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body));
          delete headers['transfer-encoding'];
        }

        let verifiedAgent;
        const verify = verifiesUpstreamTls(provider);
        if (verify) {
          verifiedAgent = new https.Agent({ keepAlive: false });
          verifiedAgent.createConnection = () => tls.connect({ socket, servername: provider.host });
        }
        const tlsReq = https.request(
          `https://${provider.host}${targetPath}`,
          {
            method,
            headers,
            socket,
            agent: verifiedAgent || false,
            rejectUnauthorized: verify,
          },
          (upstream) => {
            if (verifiedAgent) upstream.on('close', () => { verifiedAgent.destroy(); socket.destroy(); });
            // Crash guard: an idle-timeout socket.destroy() makes the response
            // emit 'error'. Piped responses get a teardown listener via
            // pipeUpstreamToClient; discarded ones (.resume() on 401/429/529) get
            // none — so attach a baseline listener here to prevent an uncaught
            // 'error' from taking down the relay. Both listeners fire when piped.
            upstream.on('error', (err) => {
              console.error(`[relay] upstream response error (${provider.host}): ${err.message}`);
            });
            resolve(upstream);
          }
        );

        tlsReq.on('error', error => { verifiedAgent?.destroy(); socket.destroy(); reject(upstreamTlsError(provider, error)); });
        if (streamed) {
          // A client that vanishes mid-upload must not leave the upstream request open.
          body.once('close', () => { if (!body.readableEnded) tlsReq.destroy(); });
          body.pipe(tlsReq);
        } else {
          if (body) tlsReq.write(body);
          tlsReq.end();
        }
      });

      connectReq.on('error', (err) => {
        clearTimeout(connectTimer);
        reject(err);
      });
      connectReq.end();
    });
  }

  function forwardWebSocketUpgrade(provider, targetPath, headers, clientSocket, clientHead, holdUnauthorized = false) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let tunnelSocket;
      let upstreamSocket;

      const finishWithError = (err) => {
        if (settled) return;
        settled = true;
        tunnelSocket?.destroy();
        upstreamSocket?.destroy();
        reject(err);
      };

      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: `${provider.host}:443`,
      });
      const connectTimer = setTimeout(() => {
        connectReq.destroy(new Error(`CONNECT tunnel timeout after ${UPSTREAM_CONNECT_TIMEOUT_MS}ms`));
      }, UPSTREAM_CONNECT_TIMEOUT_MS);

      clientSocket.once('close', () => {
        if (!settled) finishWithError(new Error('WebSocket client disconnected during upgrade'));
        upstreamSocket?.destroy();
        tunnelSocket?.destroy();
      });
      clientSocket.once('error', finishWithError);

      connectReq.on('connect', (connectResponse, socket, connectHead) => {
        tunnelSocket = socket;
        if (connectResponse.statusCode !== 200) {
          clearTimeout(connectTimer);
          finishWithError(new Error(`Squid CONNECT returned ${connectResponse.statusCode}`));
          return;
        }
        if (connectHead.length > 0) socket.unshift(connectHead);

        socket.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS);
        socket.on('timeout', () => {
          socket.destroy(new Error(`upstream idle timeout after ${UPSTREAM_IDLE_TIMEOUT_MS}ms`));
        });

        upstreamSocket = tls.connect({
          socket,
          servername: provider.host,
          rejectUnauthorized: verifiesUpstreamTls(provider),
        });
        upstreamSocket.once('error', err => finishWithError(upstreamTlsError(provider, err)));
        upstreamSocket.once('secureConnect', () => {
          clearTimeout(connectTimer);
          upstreamSocket.write(serializeWebSocketUpgradeRequest('GET', targetPath, headers));
        });

        let responseBuffer = Buffer.alloc(0);
        const onHandshakeData = (chunk) => {
          responseBuffer = Buffer.concat([responseBuffer, chunk]);
          if (responseBuffer.length > 64 * 1024) {
            finishWithError(new Error('Upstream WebSocket response headers exceed 64 KiB'));
            return;
          }

          let parsed;
          try {
            parsed = splitHttpResponseHead(responseBuffer);
          } catch (err) {
            finishWithError(err);
            return;
          }
          if (!parsed) return;
          upstreamSocket.off('data', onHandshakeData);

          if (parsed.statusCode === 401 && holdUnauthorized) {
            settled = true;
            upstreamSocket.destroy();
            tunnelSocket.destroy();
            resolve(401);
            return;
          }

          clientSocket.write(parsed.head);
          if (parsed.remainder.length > 0) clientSocket.write(parsed.remainder);

          if (parsed.statusCode !== 101) {
            settled = true;
            upstreamSocket.pipe(clientSocket);
            upstreamSocket.once('end', () => clientSocket.end());
            resolve(parsed.statusCode);
            return;
          }

          settled = true;
          upstreamSocket.on('error', () => clientSocket.destroy());
          clientSocket.on('error', () => upstreamSocket.destroy());
          upstreamSocket.once('close', () => clientSocket.destroy());
          if (clientHead.length > 0) upstreamSocket.write(clientHead);
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
          clientSocket.resume();
          resolve(101);
        };
        upstreamSocket.on('data', onHandshakeData);
      });

      connectReq.once('error', (err) => {
        clearTimeout(connectTimer);
        finishWithError(err);
      });
      connectReq.end();
    });
  }

  // ── Direct HTTP/HTTPS forwarding (internal services, no Squid) ─────────

  function forwardDirectRequest(provider, targetPath, method, headers, body) {
    return new Promise((resolve, reject) => {
      // Ensure Content-Length is correct if body was provided
      if (body) {
        headers['content-length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body));
        delete headers['transfer-encoding'];
      }

      // Default to https for port 3000 (carapa-board) if not explicitly set
      let effectiveProtocol = provider.protocol;
      if (!effectiveProtocol && provider.port === 3000) {
        effectiveProtocol = 'https';
      }

      const protocol = effectiveProtocol === 'https' ? 'https:' : 'http:';
      const transport = effectiveProtocol === 'https' ? https : http;
      const targetUrl = `${protocol}//${provider.host}:${provider.port || (effectiveProtocol === 'https' ? 443 : 80)}${targetPath}`;

      const options = {
        method,
        headers,
      };

      if (effectiveProtocol === 'https') {
        options.rejectUnauthorized = false;
        options.checkServerIdentity = () => undefined;
      }

      let req;
      const connectTimer = setTimeout(() => {
        req?.destroy(new Error(`internal upstream connect timeout after ${INTERNAL_CONNECT_TIMEOUT_MS}ms`));
      }, INTERNAL_CONNECT_TIMEOUT_MS);

      req = transport.request(targetUrl, options, (upstream) => {
        clearTimeout(connectTimer);
        upstream.setTimeout(INTERNAL_IDLE_TIMEOUT_MS, () => {
          upstream.destroy(new Error(`internal upstream idle timeout after ${INTERNAL_IDLE_TIMEOUT_MS}ms`));
        });
        resolve(upstream);
      });

      // The connect timeout covers only establishing the connection. Slow
      // services (e.g. image generation) may take longer than it to send
      // headers; the request timeout below bounds that wait.
      req.on('socket', (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        else socket.once('connect', () => clearTimeout(connectTimer));
      });

      req.on('error', (err) => {
        clearTimeout(connectTimer);
        console.error(`[relay] Internal request error to ${targetUrl}:`, err.message, err.code);
        reject(err);
      });

      // A request timeout covers the period before response headers arrive.
      req.setTimeout(INTERNAL_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`internal upstream response timeout after ${INTERNAL_IDLE_TIMEOUT_MS}ms`));
      });

      if (body) req.write(body);
      req.end();
    });
  }

  // Transient errors worth retrying (service restarting / not yet ready)
  const RETRY_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTCONN', 'EPIPE']);

  /**
   * Retry wrapper for forwardDirectRequest.
   * retryConfig: { attempts: number, delayMs: number } — both optional.
   * Only retries on transient connection errors; other errors propagate immediately.
   */
  async function forwardDirectRequestWithRetry(provider, targetPath, method, headers, body, retryConfig) {
    const maxAttempts = Math.max(1, retryConfig?.attempts ?? 1);
    const delayMs = retryConfig?.delayMs ?? 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await forwardDirectRequest(provider, targetPath, method, headers, body);
      } catch (err) {
        const isRetryable = RETRY_ERRORS.has(err.code);
        if (!isRetryable || attempt >= maxAttempts) throw err;
        const wait = delayMs * (2 ** (attempt - 1));
        console.log(`[relay] ${provider.host}:${provider.port} ${err.code} — retrying in ${wait}ms (retry ${attempt - 1} of ${maxAttempts - 1})`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }


  // ── Upstream throttle retry configuration ────────────────────────────────
  // Retries on 429 (rate limit) and 529 (overloaded) from cloud LLM providers.
  // The upstream Retry-After header (in seconds or as an HTTP-date) is honoured as a minimum wait time;
  // exponential backoff is the fallback when the header is absent.
  //   OVERLOAD_RETRY_ATTEMPTS  — max number of retries after the initial attempt (default 3)
  //   OVERLOAD_RETRY_DELAY_MS  — base delay in ms before the first retry (default 1000)

  const OVERLOAD_RETRY_ATTEMPTS = parseInt(env.OVERLOAD_RETRY_ATTEMPTS || '3', 10);
  const OVERLOAD_RETRY_DELAY_MS = parseInt(env.OVERLOAD_RETRY_DELAY_MS || '1000', 10);
  const UPSTREAM_THROTTLE_STATUSES = new Set([429, 529]);

  /**
   * Retry upstream when the provider returns 429 or 529. Returns the final response
   * (may still be throttled if all retries were exhausted).
   */
  async function retryThrottledUpstream(upstream, ctx) {
    if (!UPSTREAM_THROTTLE_STATUSES.has(upstream.statusCode)) return upstream;

    const initialStatus = upstream.statusCode;
    let current = upstream;

    for (let attempt = 1; attempt <= OVERLOAD_RETRY_ATTEMPTS; attempt++) {
      // Consume the throttled body and log it: it says which limit was hit.
      const body = await readThrottleBody(current);
      console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: upstream ${current.statusCode} ${describeUpstreamThrottle(current.headers, body)}`);
      // A used-up plan does not recover by waiting: hand over to another account of the pool.
      const exhaustedUntil = ctx.auth?.pool ? quotaExhaustedUntil(ctx.auth.oauthProvider, current.statusCode, current.headers,
        decodeThrottleBody(body, current.headers['content-encoding'])) : null;
      if (exhaustedUntil) {
        accountPool.markExhausted(ctx.auth.credentialFile, exhaustedUntil);
        if (accountPool.hasAlternative(ctx.auth.pool.files, ctx.skip)) {
          throw Object.assign(new Error('Account usage limit reached'), { code: 'ACCOUNT_QUOTA' });
        }
      }
      const retryAfterMs = parseRetryAfterMs(current.headers);
      const backoffMs = OVERLOAD_RETRY_DELAY_MS * (2 ** (attempt - 1));
      const waitMs = Math.max(backoffMs, retryAfterMs);
      const label = current.statusCode === 429 ? '429 Too Many Requests' : '529 Overloaded';
      console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: ${label}, retrying in ${waitMs}ms (attempt ${attempt}/${OVERLOAD_RETRY_ATTEMPTS})`);
      await waitUnlessClientGone(waitMs, ctx.clientGone);
      if (ctx.clientGone?.isGone()) {
        console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: client gone, retries stopped`);
        return current;
      }
      current = await forwardPaced(ctx, ctx.buildHeaders(ctx.authHeaders));
      if (!UPSTREAM_THROTTLE_STATUSES.has(current.statusCode)) {
        console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: recovered from ${initialStatus} on attempt ${attempt}`);
        break;
      }
    }

    if (UPSTREAM_THROTTLE_STATUSES.has(current.statusCode)) {
      console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: upstream ${current.statusCode} after ${OVERLOAD_RETRY_ATTEMPTS} retries, returned to client ${describeUpstreamThrottle(current.headers)}`);
    }
    return current;
  }

  function waitUnlessClientGone(waitMs, clientGone) {
    if (clientGone?.isGone()) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, waitMs);
      function done() { clearTimeout(timer); clientGone?.offGone(done); resolve(); }
      clientGone?.onGone(done);
    });
  }

  // One queue per provider route: `requestsPerSecond` in relay-clients describes
  // a limit on the provider account, so every client shares it.
  const reserveRequestSlot = createRequestPacer();

  /** Wait for a pacer ticket's slot, following it when earlier tickets are released. */
  function waitForSlot(ticket, clientGone) {
    if (clientGone?.isGone()) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const stop = ticket.onMove(arm);
      function done() { clearTimeout(timer); stop(); clientGone?.offGone(done); resolve(); }
      function arm() {
        clearTimeout(timer);
        const ms = ticket.waitMs();
        if (ms <= 0) done(); else timer = setTimeout(arm, ms);
      }
      clientGone?.onGone(done);
      arm();
    });
  }

  /** Forward once the provider's `requestsPerSecond` allows another request to start. */
  async function forwardPaced(ctx, headers) {
    const ticket = reserveRequestSlot.reserve(ctx.name, ctx.requestsPerSecond);
    const waitMs = ticket.waitMs();
    if (waitMs > 0) {
      console.log(`[relay] ${ctx.clientLabel} -> ${ctx.name}: paced, waiting ${Math.ceil(waitMs)}ms (${ctx.requestsPerSecond}/s)`);
      await waitForSlot(ticket, ctx.clientGone);
      if (ctx.clientGone?.isGone()) {
        ticket.release();
        throw new Error('client gone while waiting for a paced slot');
      }
    }
    return forwardRequest(ctx.effectiveProvider, ctx.targetPath, ctx.method, headers, ctx.body);
  }

  /** Read up to 16 KB of a throttled response; never hold a retry for over 2 s. */
  async function readThrottleBody(response) {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => response.destroy(), 2000);
    try {
      for await (const chunk of response) {
        if (size < 16_384) chunks.push(chunk);
        size += chunk.length;
      }
    } catch { /* keep whatever arrived */ } finally {
      clearTimeout(timer);
    }
    return Buffer.concat(chunks);
  }

  // ── Rate limiting (sliding window) ──────────────────────────────────────
  // Per-client-per-provider and global-per-provider request limits.
  // Configurable via environment variables:
  //   RATE_LIMIT_PER_CLIENT  — max requests per sandbox per provider per window (default 100)
  //   RATE_LIMIT_GLOBAL      — max requests per provider per window (default 300)
  //   RATE_LIMIT_WINDOW_S    — window size in seconds (default 60)

  const RL_PER_CLIENT = parseInt(env.RATE_LIMIT_PER_CLIENT || '100', 10);
  const RL_GLOBAL = parseInt(env.RATE_LIMIT_GLOBAL || '300', 10);
  const RL_WINDOW = parseInt(env.RATE_LIMIT_WINDOW_S || '60', 10) * 1000;

  class SlidingWindowCounter {
    constructor() { this.buckets = new Map(); } // key -> [timestamps]

    /** Record a hit and return { allowed, remaining, retryAfterMs } */
    check(key, limit) {
      const now = Date.now();
      const cutoff = now - RL_WINDOW;
      let timestamps = this.buckets.get(key);
      if (!timestamps) { timestamps = []; this.buckets.set(key, timestamps); }

      // Evict expired entries
      while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();

      if (timestamps.length >= limit) {
        const retryAfterMs = timestamps[0] + RL_WINDOW - now;
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      timestamps.push(now);
      return { allowed: true, remaining: limit - timestamps.length, retryAfterMs: 0 };
    }
  }

  const rateLimiter = new SlidingWindowCounter();

  // Periodic cleanup of stale buckets (every 5 minutes)
  timers.push(setInterval(() => {
    const cutoff = Date.now() - RL_WINDOW;
    for (const [key, timestamps] of rateLimiter.buckets) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length === 0) rateLimiter.buckets.delete(key);
    }
  }, 5 * 60_000));

  /**
   * Check both per-client and global rate limits.
   * The per-client bucket is keyed on the resolved sandbox identity (clientHostname), not the
   * relay-client config name, so sandboxes matching one config do not share a bucket. The
   * config name (clientLabel) is only the fallback when no identity is known.
   * Returns null if allowed, or { retryAfter, remaining } if blocked.
   */
  function checkRateLimit(clientLabel, providerName, clientHostname) {
    const clientKey = `${clientHostname || clientLabel}:${providerName}`;
    const globalKey = `*:${providerName}`;

    const clientCheck = rateLimiter.check(clientKey, RL_PER_CLIENT);
    if (!clientCheck.allowed) {
      const retryAfter = Math.ceil(clientCheck.retryAfterMs / 1000);
      console.log(`[rate-limit] BLOCKED ${clientLabel} -> ${providerName} (per-client: ${RL_PER_CLIENT}/${RL_WINDOW / 1000}s, retry in ${retryAfter}s)`);
      return { retryAfter, scope: 'per-client' };
    }

    const globalCheck = rateLimiter.check(globalKey, RL_GLOBAL);
    if (!globalCheck.allowed) {
      const retryAfter = Math.ceil(globalCheck.retryAfterMs / 1000);
      console.log(`[rate-limit] BLOCKED ${clientLabel} -> ${providerName} (global: ${RL_GLOBAL}/${RL_WINDOW / 1000}s, retry in ${retryAfter}s)`);
      return { retryAfter, scope: 'global' };
    }

    return null;
  }

  // ── Forwarder (RELAY_MODE=forward, on a box) ─────────────────────────────

  const RELAY_UPSTREAM = FORWARD_MODE ? new URL(env.CARAPA_RELAY_UPSTREAM || 'invalid:') : null;
  const FORWARD_BOX_ID = env.CARAPA_BOX_ID || '';
  const FORWARD_KEY = FORWARD_MODE && readSecret('CARAPA_HUB_BOX_SECRET') ? forwarderKeyFromSecret(readSecret('CARAPA_HUB_BOX_SECRET')) : '';
  if (FORWARD_MODE && (!RELAY_UPSTREAM || !['http:', 'https:'].includes(RELAY_UPSTREAM.protocol) || !FORWARD_BOX_ID || !FORWARD_KEY)) {
    throw new Error('RELAY_MODE=forward requires CARAPA_RELAY_UPSTREAM (http(s) URL), CARAPA_BOX_ID and CARAPA_HUB_BOX_SECRET');
  }

  /** Credential scopes a forwarder attaches: the Board token plus service-scoped tokens. */
  function forwardTokenScopes() {
    const scopes = new Set(['', 'carapa-mail']);
    for (const client of [defaultConfig, ...clientConfigs].filter(Boolean)) {
      for (const service of Object.values(client.services || {})) if (typeof service.tokenService === 'string') scopes.add(service.tokenService);
    }
    return scopes;
  }

  /** Sign and send one agent request to the central relay; resolves with the upstream request. */
  async function openForwardRequest(req, sandbox) {
    // The sandbox's Board/mail credentials live on this box (Board pushes them).
    const credentials = {};
    for (const service of forwardTokenScopes()) {
      const value = await resolvePerClientToken(sandbox, service);
      if (value) credentials[service] = value;
    }
    const target = new URL(RELAY_UPSTREAM.toString());
    target.pathname = target.pathname.replace(/\/+$/, '') + req.url.split('?')[0];
    target.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const signedPath = target.pathname + target.search;
    const headers = stripForwardHeaders({ ...req.headers });
    delete headers.host;
    Object.assign(headers, signForwardHeaders({
      keyHex: FORWARD_KEY, method: req.method, path: signedPath, box: FORWARD_BOX_ID, sandbox, credentials,
    }));
    const transport = target.protocol === 'https:' ? https : http;
    return transport.request(target, {
      method: req.method,
      headers,
      ...(target.protocol === 'https:' && env.CARAPA_RELAY_UPSTREAM_INSECURE === '1'
        ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : {}),
    });
  }

  /**
   * Sandbox identity of a forwarded request. Containers are identified by
   * Docker reverse DNS. A native runner has no per-sandbox network identity:
   * with RELAY_FORWARD_PATH_IDENTITY=1 its agents address the forwarder as
   * /s/<project>/<capability>/..., where the capability is a per-project
   * secret only that project's sandbox receives (pathCapability). Without it
   * any agent on the box could claim another project and its credentials.
   */
  async function forwardedSandbox(req) {
    if (env.RELAY_FORWARD_PATH_IDENTITY !== '1') return resolveClientHostname(req.socket.remoteAddress);
    const match = req.url.match(/^\/s\/([a-z0-9][a-z0-9_.-]{0,120})\/([a-f0-9]{32,128})(\/.*)?$/);
    if (!match) return null;
    const expected = typeof pathCapability === 'function' ? pathCapability(match[1]) : undefined;
    if (typeof expected !== 'string' || expected.length !== match[2].length
      || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) return null;
    req.url = match[3] || '/';
    return `${match[1]}-agent-1.agent_egress_${match[1]}`;
  }

  async function forwardHttpRequest(req, res) {
    const sandbox = await forwardedSandbox(req);
    if (!sandbox) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Relay client is not a known sandbox\n');
      return;
    }
    // Served on this box for an identified sandbox (native runner llama-proxy).
    if (typeof localRoute === 'function' && localRoute(req, res, sandbox)) return;
    let upstreamReq;
    try {
      upstreamReq = await openForwardRequest(req, sandbox);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Relay forwarding failed\n');
      console.error('[relay-forward] request setup failed:', err.message);
      return;
    }
    upstreamReq.on('response', (upstream) => {
      // The hub rejected a forwarded credential: drop it so the next request
      // reads the box's current one (the hub's own 401 retry cannot).
      if (upstream.statusCode === 401 || upstream.statusCode === 403) {
        for (const service of forwardTokenScopes()) invalidatePerClientToken(sandbox, service);
      }
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      res.flushHeaders?.();
      upstream.pipe(res);
    });
    upstreamReq.on('error', (err) => {
      console.error(`[relay-forward] ${sandbox} ${req.method} ${req.url.split('?')[0]}: ${err.code || err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    res.on('close', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  async function forwardUpgrade(req, socket, head) {
    const sandbox = await forwardedSandbox(req);
    if (!sandbox) { rejectWebSocketUpgrade(socket, 403, 'Relay client is not a known sandbox'); return; }
    let upstreamReq;
    try {
      upstreamReq = await openForwardRequest(req, sandbox);
    } catch {
      rejectWebSocketUpgrade(socket, 502, 'Relay forwarding failed');
      return;
    }
    upstreamReq.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage || ''}`.trim()];
      for (let i = 0; i < upstream.rawHeaders.length; i += 2) lines.push(`${upstream.rawHeaders[i]}: ${upstream.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const cleanup = () => { socket.destroy(); upstreamSocket.destroy(); };
      socket.on('error', cleanup);
      upstreamSocket.on('error', cleanup);
    });
    upstreamReq.on('response', (upstream) => {
      rejectWebSocketUpgrade(socket, upstream.statusCode || 502, 'Upstream refused the upgrade');
      upstream.resume();
    });
    upstreamReq.on('error', () => rejectWebSocketUpgrade(socket, 502, 'Relay forwarding failed'));
    upstreamReq.end();
  }

  // ── Forwarder listener (central relay on the hub) ─────────────────────────

  // Policies come from Board: the key a box signs with and the sandbox
  // projects placed on it. Cached briefly; unknown boxes are re-checked soon.
  const forwarderPolicies = new Map(); // boxId -> { policy, exp }
  const HUB_SECRET = readSecret('CARAPA_RELAY_HUB_SECRET');
  function boardBaseUrl() {
    if (env.CARAPA_BOARD_URL) return new URL(env.CARAPA_BOARD_URL);
    const port = Number(env.CARAPA_BOARD_PORT || 3000);
    const protocol = env.CARAPA_BOARD_PROTOCOL || (port === 3000 ? 'https' : 'http');
    return new URL(`${protocol}://${env.CARAPA_BOARD_HOST || 'host.docker.internal'}:${port}`);
  }
  function fetchForwarderPolicy(boxId) {
    return new Promise((resolve) => {
      const url = new URL(`/api/relay/forwarders/${encodeURIComponent(boxId)}`, boardBaseUrl());
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${HUB_SECRET}` },
        timeout: 4000,
        // Board is reached on the hub's internal network (as the board-api service).
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(typeof body?.key === 'string' && Array.isArray(body.projects) ? body : null);
          } catch { resolve(null); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }
  const FORWARDER_POLICY_MAX = 256;
  const forwarderLookups = new Map(); // boxId -> in-flight Promise
  async function forwarderPolicy(boxId) {
    const cached = forwarderPolicies.get(boxId);
    if (cached && cached.exp > Date.now()) return cached.policy;
    let lookup = forwarderLookups.get(boxId);
    if (!lookup) {
      lookup = fetchForwarderPolicy(boxId).then((policy) => {
        const now = Date.now();
        for (const [id, entry] of forwarderPolicies) if (entry.exp <= now) forwarderPolicies.delete(id);
        // Map order is insertion order, so the oldest entries go first.
        for (const id of forwarderPolicies.keys()) {
          if (forwarderPolicies.size < FORWARDER_POLICY_MAX) break;
          forwarderPolicies.delete(id);
        }
        forwarderPolicies.set(boxId, { policy, exp: now + (policy ? 60_000 : 10_000) });
        return policy;
      }).finally(() => forwarderLookups.delete(boxId));
      forwarderLookups.set(boxId, lookup);
    }
    return lookup;
  }
  const acceptOnce = createReplayGuard();
  async function verifyForwarder(req) {
    // Reject missing headers and out-of-skew timestamps before any Board lookup.
    const pre = precheckForwardedHeaders(req.headers);
    if (!pre.ok) return pre;
    const boxId = pre.fields.box;
    const policy = /^[a-z0-9][a-z0-9-]{0,62}$/.test(boxId) ? await forwarderPolicy(boxId) : null;
    const verdict = verifyForwardedRequest({ headers: req.headers, method: req.method, path: req.url }, () => policy);
    if (verdict.ok && !acceptOnce(req.headers[FORWARD_HEADERS.signature])) return { ok: false, reason: 'replayed request' };
    return verdict;
  }
  function startForwarderListener() {
    if (FORWARD_MODE || env.RELAY_FORWARDER_PORT === undefined || env.RELAY_FORWARDER_PORT === '') return null;
    const listenPort = Number(env.RELAY_FORWARDER_PORT);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error('Invalid RELAY_FORWARDER_PORT');
    if (!HUB_SECRET) {
      console.error('[relay] RELAY_FORWARDER_PORT requires CARAPA_RELAY_HUB_SECRET; forwarder listener disabled');
      return null;
    }
    const tlsOptions = env.RELAY_FORWARDER_TLS_CERT && env.RELAY_FORWARDER_TLS_KEY
      ? { cert: fs.readFileSync(env.RELAY_FORWARDER_TLS_CERT), key: fs.readFileSync(env.RELAY_FORWARDER_TLS_KEY) }
      : null;
    const onRequest = async (req, res) => {
      const verdict = await verifyForwarder(req);
      if (!verdict.ok) {
        console.warn(`[relay] Rejected forwarded request from box ${req.headers[FORWARD_HEADERS.box] || '?'}: ${verdict.reason}`);
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Forwarder not authorized\n');
        return;
      }
      stripForwardHeaders(req.headers);
      forwardContext.run(verdict, () => server.emit('request', req, res));
    };
    const listener = trackKeepAlive(tlsOptions ? https.createServer(tlsOptions, onRequest) : http.createServer(onRequest));
    listener.on('upgrade', async (req, socket, head) => {
      const verdict = await verifyForwarder(req);
      if (!verdict.ok) { rejectWebSocketUpgrade(socket, 401, 'Forwarder not authorized'); return; }
      stripForwardHeaders(req.headers);
      forwardContext.run(verdict, () => server.emit('upgrade', req, socket, head));
    });
    listener.listen(listenPort, env.RELAY_FORWARDER_HOST || '0.0.0.0', () => {
      console.log(`[api-relay] Forwarder listener on :${listenPort} (${tlsOptions ? 'TLS' : 'plain HTTP — terminate TLS in front'})`);
      if (!tlsOptions) console.warn('[api-relay] Forwarder listener without TLS: request bodies are not signed; expose it only behind TLS or on a private network');
    });
    return listener;
  }

  // ── HTTP server ──────────────────────────────────────────────────────────

  const tracker = createDrainTracker({ codeHash: relayCodeHash() });

  // ── Remote MCP OAuth services ──────────────────────────────────────────
  // The sandbox calls http://api-relay:8080/<service>; the relay injects the Bearer of the
  // sandbox's own project. Project identity comes only from the verified client hostname.
  const MCP_OAUTH_PASSTHROUGH = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
  const MCP_OAUTH_PROJECT = /\.agent_egress_([\w-]+)$/;

  // Sandbox-initiated login: the project always comes from the verified caller identity and the
  // request is never forwarded upstream. Revoke is deliberately not exposed here.
  const MCP_LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MCP_CALLBACK_MAX = 16 * 1024;
  const RELAY_CODE = computeRelayCode(relayFileReader);

  function matchMcpOAuthSandboxRoute(method, subpath) {
    if (method === 'GET' && subpath === '/.status') return { action: 'status' };
    if (method === 'POST' && subpath === '/.login') return { action: 'login' };
    const complete = method === 'POST' && /^\/\.login\/([^/]+)\/complete$/.exec(subpath);
    return complete ? { action: 'complete', id: complete[1] } : null;
  }

  async function handleMcpOAuthSandboxRoute(req, res, { name, project, route }) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const logCall = id => console.log('[relay] MCP OAuth sandbox', JSON.stringify({ service: name, project, action: route.action, id: id ?? null }));
    // Drain (bounded) so keep-alive connections stay usable; the body is never used except for `complete`.
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= 4 * MCP_CALLBACK_MAX) chunks.push(chunk);
    }
    if (!mcpOAuth) return reply(503, { error: 'mcp_oauth_unavailable' });
    try {
      if (route.action === 'status') {
        logCall();
        return reply(200, { service: name, project, state: mcpOAuth.projectState(name, project),
          logins: mcpOAuth.listLogins(name, project), relayCode: RELAY_CODE });
      }
      if (route.action === 'login') {
        const id = mcpOAuth.createAttempt(name, project);
        logCall(id);
        return reply(202, { id });
      }
      logCall(route.id);
      if (!MCP_LOGIN_ID.test(route.id)) return reply(404, { error: 'unknown_login' });
      let value;
      try { value = size <= 4 * MCP_CALLBACK_MAX ? JSON.parse(Buffer.concat(chunks).toString('utf8'))?.value : undefined; } catch { /* invalid */ }
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MCP_CALLBACK_MAX) return reply(400, { error: 'invalid_value' });
      if (!mcpOAuth.submitCallback(route.id, name, project, value)) return reply(404, { error: 'unknown_login' });
      return reply(202, { id: route.id });
    } catch (error) {
      if (error?.code === 'login_in_progress' || error?.code === 'too_many_logins') return reply(429, { error: error.code });
      console.error('[relay] MCP OAuth sandbox route failed:', error?.code || 'internal_error');
      return reply(500, { error: 'internal_error' });
    }
  }

  // The configured query always reaches the upstream; sandbox parameters with the same name are
  // dropped so the sandbox cannot override them. Without a configured query the sandbox's is kept as is.
  function mcpOAuthQuery(url, sandboxQuery, hasSandboxQuery) {
    if (!url.search) return hasSandboxQuery ? `?${sandboxQuery}` : '';
    const pinned = new Set(url.searchParams.keys());
    const extra = sandboxQuery.split('&').filter(pair => pair && !pinned.has(new URLSearchParams(pair).keys().next().value));
    return `?${[url.search.slice(1), ...extra].join('&')}`;
  }

  async function handleMcpOAuthRequest(req, res, { name, rest, config, clientHostname, clientLabel }) {
    const suffix = MCP_OAUTH_PROJECT.exec(clientHostname ?? '')?.[1];
    const project = suffix ? await resolveProjectInstance(suffix) : null;
    if (!project || !Array.isArray(config.projects) || !config.projects.includes(project)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Relay client or route is not authorized\n');
      return;
    }
    const queryAt = (rest || '').indexOf('?');
    const subpath = queryAt === -1 ? (rest || '') : rest.slice(0, queryAt);
    const sandboxRoute = matchMcpOAuthSandboxRoute(req.method, subpath);
    if (subpath !== '' && subpath !== '/' && !sandboxRoute) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Unknown path for service: ${name}\n`);
      return;
    }
    const limited = checkRateLimit(clientLabel, name, clientHostname);
    if (limited) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(limited.retryAfter) });
      res.end(JSON.stringify({ error: 'Too Many Requests', scope: limited.scope, provider: name, retryAfter: limited.retryAfter }));
      return;
    }
    if (sandboxRoute) return handleMcpOAuthSandboxRoute(req, res, { name, project, route: sandboxRoute });

    const body = await readCappedBody(req, res, MAX_REQUEST_BODY_BYTES);
    if (!body) return;
    let rpcMethod;
    let tool;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      rpcMethod = typeof parsed?.method === 'string' ? parsed.method : undefined;
      tool = typeof parsed?.params?.name === 'string' ? parsed.params.name : undefined;
    } catch { /* not JSON-RPC: the upstream reports it */ }
    const startedAt = Date.now();
    res.once('close', () => console.log('[relay] MCP OAuth request', JSON.stringify({
      service: name, project, http_method: req.method, rpc_method: rpcMethod, tool,
      session_id: req.headers['mcp-session-id'] || null, status: res.statusCode, duration_ms: Date.now() - startedAt })));

    const notConnected = error => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error, service: name, project }));
    };
    const url = new URL(config.url);
    const targetPath = url.pathname + mcpOAuthQuery(url, queryAt === -1 ? '' : rest.slice(queryAt + 1), queryAt !== -1);
    const send = auth => {
      const headers = stripClientAuthHeaders(Object.fromEntries(MCP_OAUTH_PASSTHROUGH
        .filter(key => req.headers[key] !== undefined).map(key => [key, req.headers[key]])));
      return forwardRequest({ host: url.hostname }, targetPath, req.method,
        { ...headers, ...auth.headers, host: url.hostname, 'accept-encoding': 'identity' }, body.length ? body : undefined);
    };

    try {
      const auth = await mcpOAuth?.getMcpAuth(name, project);
      if (!auth) return notConnected('mcp_oauth_not_connected');
      let upstream = await send(auth);
      if (upstream.statusCode === 401) {
        upstream.resume();
        const refreshed = await mcpOAuth.getMcpAuth(name, project, { force: true });
        if (!refreshed) return notConnected('mcp_oauth_refresh_failed');
        upstream = await send(refreshed);
        if (upstream.statusCode === 401) {
          upstream.resume();
          return notConnected('mcp_oauth_refresh_failed');
        }
      }
      // The sandbox's MCP client must never start its own OAuth flow.
      const headers = { ...upstream.headers };
      delete headers['www-authenticate'];
      const stream = String(headers['content-type'] || '').includes('event-stream');
      if (stream) Object.assign(headers, { 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.writeHead(upstream.statusCode || 502, headers);
      if (stream) res.flushHeaders();
      pipeUpstreamToClient(upstream, res, name);
    } catch (err) {
      console.error(`[relay] Error (${name}):`, err.message, err.code);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`${badGatewayMessage(err)}\n`);
      }
    }
  }

  // Headers a git client may send upstream; everything else (cookies, client
  // credentials, hop-by-hop) is dropped.
  const GIT_FORWARD_HEADERS = ['accept', 'accept-encoding', 'content-type', 'content-length', 'content-encoding', 'git-protocol', 'user-agent'];

  // Read-only git over the `gitlab` or `github` provider: allowlisted repos,
  // upload-pack only, HTTP Basic with the token the provider resolves. Bodies are streamed.
  async function handleGitRequest(req, res, { route, rest, clientHostname, clientConfig, clientLabel }) {
    const providerName = GIT_ROUTES[route];
    const reply = (status, message) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(`${message}\n`);
    };
    const overrides = ownEntry(clientConfig?.providers, providerName) || (clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, providerName) : null);
    if (!overrides?.gitRepos?.length) return reply(403, 'Forbidden: git access is not enabled for this client');
    const git = parseGitRequest(req.method, rest);
    if (!git) return reply(403, 'Forbidden: only git-upload-pack (clone and fetch) is allowed');
    if (!gitRepoAllowed(overrides.gitRepos, git.repo)) return reply(403, 'Forbidden: repository is not allowed for this client');

    const limited = checkRateLimit(clientLabel, route, clientHostname);
    if (limited) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(limited.retryAfter) });
      res.end(JSON.stringify({ error: 'Too Many Requests', scope: limited.scope, provider: route, retryAfter: limited.retryAfter }));
      return;
    }
    // A GitHub account's API host (api.github.com, or /api/v3) is not its git host.
    const host = overrides.gitHost || upstreamHost(overrides);
    if (!host) return reply(503, `No host configured for provider: ${providerName}`);
    const auth = (await resolveAuthFromConfig(overrides, providerName, clientHostname))?.headers;
    const token = providerName === 'gitlab' ? auth?.['PRIVATE-TOKEN'] : auth?.authorization?.replace(/^Bearer /, '');
    if (!token) {
      console.error(`[relay] ${clientLabel} -> ${route}: No credentials configured (clientHostname: ${clientHostname})`);
      return reply(503, `No credentials configured for ${providerName}`);
    }

    const headers = Object.fromEntries(GIT_FORWARD_HEADERS.filter(key => req.headers[key] !== undefined).map(key => [key, req.headers[key]]));
    headers.host = host;
    headers.authorization = `Basic ${Buffer.from(`${GIT_BASIC_USER[providerName]}:${token}`).toString('base64')}`;
    const targetPath = (overrides.gitHost ? '' : overrides.pathPrefix || '') + git.path;
    console.log(`[relay] ${clientLabel} -> ${route} ${req.method} ${host}${targetPath.split('?')[0]} (basic)`);
    try {
      const provider = { host, ...('verifyTls' in overrides ? { verifyTls: overrides.verifyTls } : {}) };
      const upstream = await forwardRequest(provider, targetPath, req.method, headers, req.method === 'POST' ? req : undefined);
      const responseHeaders = { ...upstream.headers };
      delete responseHeaders['set-cookie'];
      delete responseHeaders['www-authenticate'];
      res.writeHead(upstream.statusCode || 502, responseHeaders);
      pipeUpstreamToClient(upstream, res, route);
    } catch (err) {
      console.error(`[relay] Error (${route}):`, err.message);
      if (!res.headersSent) reply(502, badGatewayMessage(err));
    }
  }

  async function handleRelayRequest(req, res) {
    if (tracker.handleStatus(req, res)) return;
    tracker.hold(res, 'close', 'finish');
    if (FORWARD_MODE) return forwardHttpRequest(req, res);
    const clientHostname = forwardContext.getStore()?.sandbox ?? await resolveClientHostname(req.socket.remoteAddress);
    let selected;
    try {
      if (!configHealthy) throw new Error('Invalid relay configuration');
      const routeName = req.url.split('/')[1];
      // Only a route served by a project grant (never a built-in or git route, never a forwarded request).
      const ownRoute = !forwardContext.getStore() && !ownEntry(PROVIDERS, routeName) && !gitRouteProvider(routeName) &&
        projectGrantsFor(projectGrants, routeName, clientHostname).length > 0;
      selected = selectClientRoute({ clients: clientConfigs, defaults: defaultConfig,
        requireKnownClients: env.RELAY_REQUIRE_KNOWN_CLIENTS === '1' || defaultConfig?.requireKnownClients }, clientHostname, gitRouteProvider(routeName) || routeName, { allowRoute: ownRoute });
    } catch {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Relay client or route is not authorized\n');
      return;
    }
    const { clientMatch, clientConfig, clientLabel } = selected;
    const match = req.url.match(/^\/([\w-]+)(\/.*)?$/);
    if (!match) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request: expected /<provider>/...\n');
      return;
    }
    if (hasUnsafeRelayPath(req.url)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request: unsafe path\n');
      return;
    }

    const [, name, rest] = match;
    if (isAnthropicAdminPath(name, rest || '/')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: Anthropic Admin API is not available to sandboxes\n');
      return;
    }
    if (gitRouteProvider(name)) return handleGitRequest(req, res, { route: name, rest, clientHostname, clientConfig, clientLabel });
    const provider = ownEntry(PROVIDERS, name);

    // A project integration serves its own containers' allowed calls; anything else
    // keeps the client's own route, if it has one. Forwarded requests name a
    // sandbox on another box, whose containers this box never verified.
    const ownGrants = !provider && !forwardContext.getStore() ? projectGrantsFor(projectGrants, name, clientHostname) : [];
    const grant = ownGrants.length ? selectProjectGrant(ownGrants, name, clientHostname, req.method, rest ?? '') : null;

    // ── Client-only provider check (e.g. gitlab — no global PROVIDERS entry) ──
    const clientOnlyProvider = grant ? grant.route
      : !provider ? (ownEntry(clientConfig?.providers, name) || (clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, name) : null)) : null;

    // ── Internal service handling ──────────────────────────────────────────
    let serviceConfig = !provider && !clientOnlyProvider ? await resolveService(name, clientConfig) : null;
    let effectiveName = name;
    let effectiveRest = rest;

    // Fallback: If service not found but client is recognized, try mcp-relay (the board)
    // and treat the unknown service name as part of the path if it's a handshake probe.
    // An integration's own route has nothing else behind it: a call no rule allows stops here.
    if (ownGrants.length && !grant && !clientOnlyProvider && !serviceConfig) {
      console.warn(`[relay] ${clientLabel} -> ${name}: ${req.method} not allowed for the project integration`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: this call is not allowed for the project integration\n');
      return;
    }

    if (!provider && !clientOnlyProvider && !serviceConfig && clientMatch && clientMatch.isolation !== 'strict') {
      const fallbackSvc = await resolveService('mcp-relay', clientConfig);
      if (fallbackSvc) {
        serviceConfig = fallbackSvc;
        effectiveName = 'mcp-relay';
        // Remap probes like /register to /mcp/carapa-board/register
        // Avoid double slashes and ensure we don't add a trailing slash if rest is empty
        const suffix = rest || '';
        effectiveRest = `/mcp/carapa-board${suffix}`;
        console.log(`[relay] Fallback: /${name}${suffix} -> mcp-relay ${effectiveRest} for ${clientLabel}`);
      }
    }

    if (!provider && !clientOnlyProvider && !serviceConfig) {
      console.log(`[relay] 404 /${name}/ from ${clientHostname || req.socket.remoteAddress} (client: ${clientLabel}, matched: ${clientMatch ? 'yes' : 'no'})`);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Unknown provider or service: ${name}\n`);
      return;
    }

    // mcp-oauth services never take the internal-service path (plain HTTP, no Squid, no TLS checks).
    if (serviceConfig?.auth === MCP_AUTH) {
      return handleMcpOAuthRequest(req, res, { name, rest, config: serviceConfig, clientHostname, clientLabel });
    }

    // ── Rate limiting ─────────────────────────────────────────────────────
    const rlResult = checkRateLimit(clientLabel, effectiveName, clientHostname);
    if (rlResult) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': String(rlResult.retryAfter),
      });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        scope: rlResult.scope,
        provider: name,
        retryAfter: rlResult.retryAfter,
      }));
      return;
    }

    if (serviceConfig) {
      // Internal service — forward via plain HTTP/HTTPS, no Squid
      const auth = await resolveServiceAuth(effectiveName, serviceConfig, clientHostname);
      const targetPath = (serviceConfig.pathPrefix || '') + (effectiveRest || '/');
      const targetHost = serviceConfig.host || effectiveName;
      const targetPort = serviceConfig.port || (serviceConfig.protocol === 'https' ? 443 : 80);

      if (!auth) {
        console.log(`[relay] ${clientLabel} -> ${effectiveName} ${req.method} ${targetPath} (no-auth)`);
      } else {
        console.log(`[relay] ${clientLabel} -> ${effectiveName} ${req.method} ${targetPath} (${auth.type})`);
      }

      const body = await readCappedBody(req, res, MAX_REQUEST_BODY_BYTES);
      if (!body) return;

      const isMcpRequest = effectiveName === 'mcp-relay' && effectiveRest?.startsWith('/mcp/');
      let mcpRpcMethod;
      let mcpToolName;
      if (isMcpRequest && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          mcpRpcMethod = typeof parsed?.method === 'string' ? parsed.method : undefined;
          mcpToolName = typeof parsed?.params?.name === 'string' ? parsed.params.name : undefined;
        } catch {
          // The upstream will report malformed JSON; logging remains safe.
        }
      }
      const mcpStartedAt = isMcpRequest ? Date.now() : 0;
      let mcpCompletionLogged = false;
      const logMcpCompletion = (event, status, error) => {
        if (!isMcpRequest || mcpCompletionLogged) return;
        mcpCompletionLogged = true;
        console.log('[relay] MCP request completed', JSON.stringify({
          event,
          client: clientLabel,
          http_method: req.method,
          path: effectiveRest,
          rpc_method: mcpRpcMethod,
          tool: mcpToolName,
          session_id: req.headers['mcp-session-id'] || null,
          status: status || null,
          duration_ms: Date.now() - mcpStartedAt,
          error: error || null,
        }));
      };
      if (isMcpRequest) {
        console.log('[relay] MCP request started', JSON.stringify({
          client: clientLabel,
          http_method: req.method,
          path: effectiveRest,
          rpc_method: mcpRpcMethod,
          tool: mcpToolName,
          session_id: req.headers['mcp-session-id'] || null,
        }));
        res.once('finish', () => logMcpCompletion('finish', res.statusCode));
        res.once('close', () => logMcpCompletion('close', res.statusCode));
      }

      const buildHeaders = (authObj) => {
        const h = stripClientAuthHeaders(req.headers);
        delete h.host;
        if (authObj) Object.assign(h, authObj.headers);
        h.host = targetPort !== (serviceConfig.protocol === 'https' ? 443 : 80) ? `${targetHost}:${targetPort}` : targetHost;
        // Tell carapa-mail the base URL the client reached us at, so attachment download
        // links it mints point back through the relay (the only path sandboxes can use).
        if (effectiveName === 'carapa-mail' && req.headers.host) {
          h['x-carapamail-public-base'] = `http://${req.headers.host}/${effectiveName}`;
        }
        return h;
      };

      try {
        let upstream = await withOAuthRetry(oauthManager, auth, currentAuth =>
          forwardDirectRequestWithRetry({ host: targetHost, port: targetPort, protocol: serviceConfig.protocol }, targetPath, req.method, buildHeaders(currentAuth), body, serviceConfig.retry),
          response => response.resume());

        // The board rejected the injected per-sandbox token — it was rotated by
        // the sandbox lifecycle (stop/restart/reconcile/sweep) while our token
        // cache was still warm. Drop the stale entry, re-pull a fresh token
        // from carapa-box, and retry once. Self-heals rotation instead of a
        // multi-minute 401 window now that there is no master fallback.
        if (
          auth &&
          serviceConfig.auth === 'apikey' &&
          CARAPA_BOX_ADMIN_TOKEN &&
          (upstream.statusCode === 401 || upstream.statusCode === 403)
        ) {
          console.log(`[relay] ${clientLabel} -> ${effectiveName} ${upstream.statusCode}; refreshing per-sandbox token, retrying once`);
          invalidatePerClientToken(clientHostname, serviceConfig.tokenService);
          const retryAuth = await resolveServiceAuth(effectiveName, serviceConfig, clientHostname);
          if (retryAuth) {
            // Drain only once a replacement exists; otherwise the original 401 body is relayed as is.
            upstream.resume();
            upstream = await forwardDirectRequestWithRetry({ host: targetHost, port: targetPort, protocol: serviceConfig.protocol }, targetPath, req.method, buildHeaders(retryAuth), body, serviceConfig.retry);
          }
        }

        // SSE optimization: Disable buffering and caching for streams
        if (upstream.headers['content-type']?.includes('event-stream')) {
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
        }

        // Remap Location and session headers to point back to the relay
        const upstreamHeaders = { ...upstream.headers };
        const relayBaseUrl = `http://${req.headers.host}/${effectiveName}`;

        ['location', 'x-mcp-session-url'].forEach(key => {
          if (upstreamHeaders[key] && typeof upstreamHeaders[key] === 'string') {
            const val = upstreamHeaders[key];
            if (val.includes('host.docker.internal') || val.includes('127.0.0.1')) {
              try {
                const url = new URL(val);
                upstreamHeaders[key] = `${relayBaseUrl}${url.pathname}${url.search}`;
                console.log(`[relay] Remapped ${key}: ${val} -> ${upstreamHeaders[key]}`);
              } catch (e) {
                // Not a valid URL, skip
              }
            }
          }
        });

        res.writeHead(upstream.statusCode || 502, upstreamHeaders);
        // MCP clients await the GET stream headers before finishing startup.
        // writeHead alone buffers them until the first event/25s keepalive.
        if (upstream.headers['content-type']?.includes('event-stream')) res.flushHeaders();
        pipeUpstreamToClient(upstream, res, effectiveName);
      } catch (err) {
        console.error(`[relay] Error (${effectiveName}):`, err.message, err.code);
        logMcpCompletion('error', 502, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Bad Gateway\n');
        }
      }
      return;
    }

    // ── External provider handling ─────────────────────────────────────────
    if (name === 'antigravity') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      try {
        const auth = await resolveAuth(name, provider, clientConfig, clientHostname, { session: requestSession(req.headers, clientHostname) });
        if (!auth || auth.oauthProvider !== 'antigravity') { res.writeHead(503); res.end('Antigravity OAuth account is not ready\n'); return; }
        const rawBody = await readCappedBody(req, res, MAX_REQUEST_BODY_BYTES);
        if (!rawBody) return;
        const body = Buffer.from(scrubSecrets(rawBody.toString('utf8')).text);
        let parsedRequest;
        try { parsedRequest = parseAntigravityRequest(providerRequestPath(name, rest || '/'), body); } catch (err) {
          console.error(`[relay] ${clientLabel} -> antigravity rejected request (${err.statusCode}): ${err.message}`);
          res.writeHead(err.statusCode, { 'content-type': 'text/plain' }); res.end(err.message + '\n'); return;
        }
        let streaming;
        const upstream = await withOAuthRetry(oauthManager, auth, current => {
          const data = oauthManager.snapshot({ provider: 'antigravity', credentialFile: current.credentialFile }).data;
          const wire = antigravityWireRequest(parsedRequest, data);
          streaming = wire.streaming;
          if (!wire.model.startsWith(wire.requestedModel)) console.log(`[relay] ${clientLabel} -> antigravity model ${wire.requestedModel} served as ${wire.model}`);
          // Construct headers afresh: never forward client authorization,
          // compression, project IDs, or ACP proxy tokens to the backend.
          return forwardRequest({ host: wire.host, verifyTls: true }, wire.path, 'POST', {
            ...current.headers, 'content-type': 'application/json', 'accept-encoding': 'identity',
            'user-agent': antigravityUserAgent(data),
          }, wire.body);
        }, response => response.resume());
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          res.writeHead(upstream.statusCode, { 'content-type': 'application/json' });
          pipeUpstreamToClient(upstream, res, name); return;
        }
        const transformed = antigravityResponse(streaming);
        res.writeHead(upstream.statusCode, { 'content-type': streaming ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
        res.on('close', () => { upstream.destroy(); transformed.destroy(); });
        upstream.on('error', () => res.destroy()); transformed.on('error', () => { upstream.destroy(); res.destroy(); });
        upstream.pipe(transformed).pipe(res);
      } catch (err) {
        console.error(`[relay] Error (${name}):`, err?.message, err?.code);
        if (!res.headersSent) { res.writeHead(502); res.end('Antigravity request failed\n'); }
      }
      return;
    }
    // Per-client config can override host and pathPrefix (e.g. codex → api.openai.com for API key auth)
    const perClientProvider = ownEntry(clientConfig?.providers, name);
    const defaultProvider = clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, name) : null;
    const providerOverrides = grant ? grant.route : perClientProvider || defaultProvider || {};
    const baseHost = provider ? provider.host : '';
    const effectiveHost = upstreamHost(providerOverrides, baseHost);
    const effectivePathPrefix = 'pathPrefix' in providerOverrides ? providerOverrides.pathPrefix : (provider?.pathPrefix || '');
    const effectiveProvider = {
      ...(provider || {}),
      host: effectiveHost,
      ...('verifyTls' in providerOverrides ? { verifyTls: providerOverrides.verifyTls } : {}),
    };

    if (!effectiveHost) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(`No host configured for provider: ${name}\n`);
      return;
    }

    // Client-only providers (no global PROVIDERS entry) resolve auth from relay-clients config
    const selection = { session: requestSession(req.headers, clientHostname), skip: new Set() };
    const selectAuth = () => clientOnlyProvider
      ? resolveAuthFromConfig(providerOverrides, name, clientHostname, false, selection)
      : resolveAuth(name, provider, clientConfig, clientHostname, selection);
    let auth = await selectAuth();
    if (!auth) {
      console.error(`[relay] ${clientLabel} -> ${name}: No credentials configured (clientHostname: ${clientHostname})`);
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(`No credentials configured for ${name}\n`);
      return;
    }

    const targetPath = providerRequestPath(name, effectivePathPrefix + (rest || '/'));
    console.log(`[relay] ${clientLabel} -> ${name} ${req.method} ${effectiveHost}${targetPath} (${auth.type}${grant ? `, project ${grant.project.stack}/${grant.project.instance}` : ''})`);

    // Buffer request body so we can retry on 401
    let body = await readCappedBody(req, res, MAX_REQUEST_BODY_BYTES);
    if (!body) return;

    // Scrub secrets from outbound request body
    const scrubbed = scrubRequestBody(body, req.headers);
    if (scrubbed.count > 0) {
      console.log(`[scrub] ${clientLabel} -> ${name}: redacted ${scrubbed.count} secret(s), body ${body.length} -> ${scrubbed.body.length} bytes`);
      body = scrubbed.body;
    }

    // A managed Meta account never receives compressed bodies: they cannot be inspected for contributor mode.
    const contentEncoding = String(req.headers['content-encoding'] ?? '').trim().toLowerCase();
    if (auth.oauthProvider === 'meta' && contentEncoding && contentEncoding !== 'identity') {
      console.warn(`[relay] ${clientLabel} -> ${name}: refused compressed request body (${contentEncoding})`);
      res.writeHead(415, { 'content-type': 'text/plain' });
      res.end('Compressed request bodies are not accepted for this account\n');
      return;
    }

    // A managed Meta account never serves contributor mode, from any harness.
    if (auth.oauthProvider === 'meta' && museContributorRequest(req.headers, body)) {
      console.warn(`[relay] ${clientLabel} -> ${name}: refused Muse contributor mode request`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Muse contributor mode is disabled for this account\n');
      return;
    }

    // A managed Cursor account never forwards the CLI's telemetry; answer with an
    // empty message so the CLI carries on.
    if (auth.oauthProvider === 'cursor' && cursorTelemetryRequest(targetPath)) {
      const json = String(req.headers['content-type'] ?? '').includes('json');
      res.writeHead(200, { 'content-type': json ? 'application/json' : 'application/proto' });
      res.end(json ? '{}' : '');
      return;
    }

    // Build outbound headers — pass through everything, only override auth
    function buildHeaders(authHeaders) {
      authHeaders = { ...authHeaders };
      const h = stripClientAuthHeaders(req.headers);
      delete h.host;
      // Remove existing auth headers before injecting ours
      // Merge anthropic-beta: preserve client flags, add any from auth
      const clientBeta = h['anthropic-beta'] || '';
      const authBeta = authHeaders['anthropic-beta'] || '';
      delete authHeaders['anthropic-beta'];
      Object.assign(h, authHeaders);
      if (clientBeta || authBeta) {
        const flags = new Set([...authBeta.split(','), ...clientBeta.split(',')].map(s => s.trim()).filter(Boolean));
        h['anthropic-beta'] = [...flags].join(',');
      }
      h.host = effectiveHost;
      return h;
    }

    let clientIsGone = res.destroyed || res.writableEnded;
    const goneListeners = new Set();
    res.on('close', () => {
      clientIsGone = true;
      for (const cb of [...goneListeners]) cb();
    });
    const clientGone = {
      isGone: () => clientIsGone,
      onGone: cb => goneListeners.add(cb),
      offGone: cb => goneListeners.delete(cb),
    };

    // The token that is added to the upstream path; kept out of the response headers below.
    const queryToken = auth.query?.value;
    const upstreamCtx = {
      clientLabel, name, effectiveProvider, method: req.method,
      // A query-parameter token is added after logging, replacing any the client sent.
      targetPath: auth.query ? withQueryParam(targetPath, auth.query.name, auth.query.value) : targetPath,
      buildHeaders, body, clientGone, requestsPerSecond: providerOverrides.requestsPerSecond,
      skip: selection.skip,
    };

    try {
      let upstream;
      for (;;) {
        try {
          upstream = await withOAuthRetry(oauthManager, auth, async currentAuth => {
            const response = await forwardPaced(upstreamCtx, buildHeaders(currentAuth.headers));
            // Throttle retries remain inside the auth attempt, so a 401 reached after
            // backoff takes exactly the same bounded OAuth refresh path.
            return retryThrottledUpstream(response, { ...upstreamCtx, authHeaders: currentAuth.headers, auth });
          }, response => response.resume());
          break;
        } catch (err) {
          if (err.code !== 'ACCOUNT_QUOTA') throw err;
          // This account's plan is used up: the session continues on another one.
          selection.skip.add(auth.credentialFile);
          const next = await selectAuth();
          if (!next) {
            res.writeHead(429, { 'content-type': 'text/plain' });
            res.end('Usage limit reached and no other account is usable\n');
            return;
          }
          console.log(`[relay] ${clientLabel} -> ${name}: usage limit reached, continuing on another account`);
          auth = next;
        }
      }

      if (res.destroyed || res.writableEnded) {
        upstream.destroy();
        console.log(`[relay] ${clientLabel} -> ${name}: client gone, retries stopped`);
        return;
      }

      // Normal path: pipe upstream response to client (supports streaming/SSE)
      res.writeHead(upstream.statusCode || 502, queryToken ? redactQueryTokenHeaders(upstream.headers, queryToken) : upstream.headers);
      if (auth?.oauthProvider === 'meta') recordMuseUsage(upstream, auth.credentialFile);
      pipeUpstreamToClient(upstream, res, name);
    } catch (err) {
      console.error(`[relay] Error (${name}):`, err.message);
      if (!res.headersSent) {
        res.writeHead(err.code === 'OAUTH_REFRESH_FAILED' ? 401 : 502, { 'content-type': 'text/plain' });
        res.end(`${badGatewayMessage(err)}\n`);
      }
    }
  }

  // A sandbox aborting a request mid-body rejects the body read (ECONNRESET 'aborted').
  // That ends only this request; an escaped rejection would exit the shared worker.
  const server = trackKeepAlive(http.createServer((req, res) => {
    handleRelayRequest(req, res).catch(err => {
      console.error(`[relay] Request failed (${String(req.url).split('?')[0]}): ${err?.code || err?.message}`);
      if (!res.headersSent && !res.destroyed) {
        try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Internal relay error\n'); return; } catch { /* fall through */ }
      }
      res.destroy();
    });
  }));

  function rejectWebSocketUpgrade(socket, statusCode, message, extraHeaders = {}) {
    if (socket.destroyed) return;
    const body = `${message}\n`;
    const reason = http.STATUS_CODES[statusCode] || 'Error';
    const headers = {
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      ...extraHeaders,
    };
    const lines = [`HTTP/1.1 ${statusCode} ${reason}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  }

  server.on('upgrade', async (req, socket, head) => {
    tracker.hold(socket, 'close');
    if (FORWARD_MODE) return forwardUpgrade(req, socket, head);
    socket.pause();

    try {
      if (req.method !== 'GET') {
        rejectWebSocketUpgrade(socket, 405, 'WebSocket upgrades require GET');
        return;
      }

      const match = req.url?.match(/^\/([\w-]+)(\/.*)?$/);
      if (!match) {
        rejectWebSocketUpgrade(socket, 400, 'Bad request: expected /<provider>/...');
        return;
      }
      if (hasUnsafeRelayPath(req.url)) {
        rejectWebSocketUpgrade(socket, 400, 'Bad request: unsafe path');
        return;
      }

      const [, name, rest] = match;
      if (isAnthropicAdminPath(name, rest || '/')) { rejectWebSocketUpgrade(socket, 403, 'Anthropic Admin API is not available to sandboxes'); return; }
      if (name === 'antigravity') { rejectWebSocketUpgrade(socket, 405, 'Antigravity supports HTTP generation only'); return; }
      const provider = ownEntry(PROVIDERS, name);
      const clientHostname = forwardContext.getStore()?.sandbox ?? await resolveClientHostname(req.socket.remoteAddress);
      let selected;
      try {
        if (!configHealthy) throw new Error('Invalid relay configuration');
        selected = selectClientRoute({ clients: clientConfigs, defaults: defaultConfig,
          requireKnownClients: env.RELAY_REQUIRE_KNOWN_CLIENTS === '1' || defaultConfig?.requireKnownClients }, clientHostname, name);
      } catch {
        rejectWebSocketUpgrade(socket, 403, 'Relay client or route is not authorized');
        return;
      }
      const { clientMatch, clientConfig, clientLabel } = selected;
      const service = await resolveService(name, clientConfig);
      if (service?.auth === MCP_AUTH) {
        rejectWebSocketUpgrade(socket, 404, 'MCP OAuth services do not support WebSocket');
        return;
      }
      if (service) {
        if (!allowsServiceWebSocket(service, rest || '/')) {
          rejectWebSocketUpgrade(socket, 403, 'Internal WebSocket route is not enabled');
          return;
        }
        const limited = checkRateLimit(clientLabel, name, clientHostname);
        if (limited) {
          rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', { 'Retry-After': String(limited.retryAfter) });
          return;
        }
        let auth = await resolveServiceAuth(name, service, clientHostname);
        if (service.auth !== 'none' && !auth) {
          rejectWebSocketUpgrade(socket, 503, 'Internal service credentials unavailable');
          return;
        }
        const target = { ...service, host: service.host || name };
        const targetPath = (service.pathPrefix || '') + (rest || '/');
        const send = (currentAuth, holdUnauthorized) => forwardServiceWebSocket(target, targetPath,
          buildWebSocketUpgradeHeaders(req.headers, currentAuth?.headers, target.host), socket, head, {
            connectTimeout: INTERNAL_CONNECT_TIMEOUT_MS, idleTimeout: INTERNAL_IDLE_TIMEOUT_MS, holdUnauthorized,
          });
        const refreshable = service.auth === 'apikey' && !!CARAPA_BOX_ADMIN_TOKEN;
        const status = await send(auth, refreshable);
        if (refreshable && [401, 403].includes(status)) {
          invalidatePerClientToken(clientHostname, service.tokenService);
          auth = await resolveServiceAuth(name, service, clientHostname);
          if (!auth) rejectWebSocketUpgrade(socket, 503, 'Internal service credentials unavailable');
          else await send(auth, false);
        }
        return;
      }
      const clientOnlyProvider = !provider
        ? (ownEntry(clientConfig?.providers, name) || (clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, name) : null))
        : null;

      if (!provider && !clientOnlyProvider) {
        rejectWebSocketUpgrade(socket, 404, `Unknown external provider: ${name}`);
        return;
      }

      const rlResult = checkRateLimit(clientLabel, name, clientHostname);
      if (rlResult) {
        rejectWebSocketUpgrade(socket, 429, 'Too Many Requests', {
          'Retry-After': String(rlResult.retryAfter),
        });
        return;
      }

      const perClientProvider = ownEntry(clientConfig?.providers, name);
      const defaultProvider = clientConfig?.isolation !== 'strict' ? ownEntry(defaultConfig?.providers, name) : null;
      const providerOverrides = perClientProvider || defaultProvider || {};
      const baseHost = provider?.host || '';
      const effectiveHost = upstreamHost(providerOverrides, baseHost);
      const effectivePathPrefix = 'pathPrefix' in providerOverrides
        ? providerOverrides.pathPrefix
        : (provider?.pathPrefix || '');
      const effectiveProvider = {
        ...(provider || {}),
        host: effectiveHost,
        ...('verifyTls' in providerOverrides ? { verifyTls: providerOverrides.verifyTls } : {}),
      };

      if (!effectiveHost) {
        rejectWebSocketUpgrade(socket, 503, `No host configured for provider: ${name}`);
        return;
      }

      const selection = { session: requestSession(req.headers, clientHostname) };
      const auth = clientOnlyProvider
        ? await resolveAuthFromConfig(providerOverrides, name, clientHostname, false, selection)
        : await resolveAuth(name, provider, clientConfig, clientHostname, selection);
      if (!auth) {
        console.error(`[relay] ${clientLabel} -> ${name} WS: No credentials configured (clientHostname: ${clientHostname})`);
        rejectWebSocketUpgrade(socket, 503, `No credentials configured for ${name}`);
        return;
      }

      // WebSocket frames are never inspected, so contributor mode cannot be policed: refuse all upgrades.
      if (auth.oauthProvider === 'meta') {
        console.warn(`[relay] ${clientLabel} -> ${name} WS: refused, managed Meta account serves HTTP only`);
        rejectWebSocketUpgrade(socket, 403, 'WebSocket is disabled for this account');
        return;
      }

      const targetPath = providerRequestPath(name, effectivePathPrefix + (rest || '/'));
      console.log('[relay] ' + clientLabel + ' -> ' + name + ' WS ' + effectiveHost + targetPath + ' (' + auth.type + ')');
      const statusCode = await withOAuthRetry(oauthManager, auth, (currentAuth, holdUnauthorized) =>
        forwardWebSocketUpgrade(effectiveProvider, targetPath,
          buildWebSocketUpgradeHeaders(req.headers, currentAuth.headers, effectiveHost),
          socket, head, holdUnauthorized));
      if (statusCode !== 101) {
        console.log(`[relay] ${clientLabel} -> ${name} WS rejected upstream (${statusCode})`);
      }
    } catch (err) {
      console.error('[relay] WebSocket upgrade error:', err.message);
      rejectWebSocketUpgrade(socket, err.code === 'OAUTH_REFRESH_FAILED' ? 401 : 502,
        err.code === 'OAUTH_REFRESH_FAILED' ? 'OAuth renewal failed' : badGatewayMessage(err));
    }
  });

  server.listen(PORT, host, () => {
    console.log(`[api-relay] Listening on :${PORT}`);
    for (const [name, p] of Object.entries(PROVIDERS)) {
      const auth = p.getAuth();
      const mode = auth ? auth.type : 'MISSING';
      console.log(`[api-relay]   /${name}/ -> ${p.host}  [global: ${mode}]`);
    }
    console.log(`[api-relay] Rate limits: ${RL_PER_CLIENT} req/client/provider/${RL_WINDOW / 1000}s, ${RL_GLOBAL} req/provider/${RL_WINDOW / 1000}s`);
    // Log default services
    if (defaultConfig?.services) {
      for (const [name, svc] of Object.entries(defaultConfig.services)) {
        const target = `${svc.host || name}:${svc.port || 80}`;
        console.log(`[api-relay]   /${name}/ -> ${target}  [service, auth: ${svc.auth || 'none'}]`);
      }
    }
    for (const c of clientConfigs) {
      const providers = Object.keys(c.providers || {});
      const services = Object.keys(c.services || {});
      const parts = [...providers, ...services.map(s => `${s} (service)`)];
      console.log(`[api-relay]   client "${c.name}" (${c.patterns.join(', ')}): ${parts.join(', ') || 'no overrides'}`);
    }
  });

  // ── SNI passthrough bridge (:443) ──────────────────────────────────────────
  // Some CLIs (notably the Antigravity CLI `agy`) hard-dial Google hosts on :443
  // and IGNORE https_proxy. Agents point those hostnames at this container (via
  // /etc/hosts → api-relay's IP; see stacks/*/bin/agy). We peek the TLS SNI on the
  // incoming connection, open a CONNECT tunnel to the same host through squid, and
  // pipe bytes both ways. TLS stays end-to-end — we never decrypt; the SNI is
  // cleartext in the ClientHello. squid's domain allowlist still gates every
  // tunnel, and one listener serves every host by SNI (no per-host config).
  //
  // This moves the single privileged :443 bind here (cap_add NET_BIND_SERVICE)
  // so agent sandboxes need no port relaxation: connecting OUT to :443 is
  // unprivileged. Disable by setting SNI_BRIDGE_PORT=0.
  const SNI_BRIDGE_PORT = parseInt(env.SNI_BRIDGE_PORT ?? '443', 10);
  const SNI_ALLOWED_SUFFIXES = (env.SNI_ALLOWED_SUFFIXES
    ?? '.googleapis.com,.googleusercontent.com,.antigravity.google,antigravity-unleash.goog,accounts.google.com')
    .split(',').map(s => s.trim()).filter(Boolean);

  const SNI_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  function validSniHostname(host) {
    return host.length <= 253 && SNI_HOSTNAME.test(host);
  }

  // Squid dstdomain semantics: a leading dot matches the bare domain and every
  // subdomain; no leading dot matches exactly. Case-insensitive.
  function hostMatchesDomain(host, domain) {
    host = host.toLowerCase();
    domain = domain.toLowerCase();
    return domain.startsWith('.') ? (host === domain.slice(1) || host.endsWith(domain)) : host === domain;
  }

  function sniAllowed(host) {
    return SNI_ALLOWED_SUFFIXES.some(suf => hostMatchesDomain(host, suf));
  }

  // Relay-only hosts (network-base.yaml relay_domains and relay_private_hosts) reach squid from this
  // container's IP, so the bridge must not tunnel them for sandboxes. The list is
  // read from the squid config carapa-box generates, so it is exactly what squid
  // enforces. Read per connection (small file, rare connections). Returns null
  // when the file cannot be read: callers fail closed.
  const RELAY_SQUID_CONF = env.RELAY_SQUID_CONF || '/app/squid-generated.conf';
  let relayConfError;
  function readRelayOnlyDomains() {
    let text;
    try {
      text = fs.readFileSync(RELAY_SQUID_CONF, 'utf8');
    } catch (err) {
      const code = err.code || err.message;
      if (relayConfError !== code) {
        relayConfError = code;
        console.warn(`[sni-bridge] cannot read ${RELAY_SQUID_CONF} (${code}) - refusing all SNI tunnels`);
      }
      return null;
    }
    relayConfError = undefined;
    const domains = [];
    for (const line of text.split('\n')) {
      const tokens = line.split('#')[0].trim().split(/\s+/);
      if (tokens[0] !== 'acl' || !/^relay_(allowed|private_host_\d+)$/.test(tokens[1]) || tokens[2] !== 'dstdomain') continue;
      for (const token of tokens.slice(3)) if (!token.startsWith('-')) domains.push(token);
    }
    return domains;
  }

  // Parse the SNI host_name out of a (possibly partial) TLS ClientHello buffer.
  // Returns the hostname, null (definitively no SNI / not a ClientHello), or
  // 'incomplete' (need more bytes).
  function extractSNI(buf) {
    if (buf.length < 5) return 'incomplete';
    if (buf[0] !== 0x16) return null;                       // not a TLS handshake
    const recEnd = 5 + buf.readUInt16BE(3);
    if (buf.length < recEnd) return 'incomplete';
    let p = 5;
    if (buf[p] !== 0x01) return null;                       // not a ClientHello
    p += 4;                                                 // handshake type + length
    p += 2 + 32;                                            // client_version + random
    if (p + 1 > buf.length) return 'incomplete';
    p += 1 + buf[p];                                        // session_id
    if (p + 2 > buf.length) return 'incomplete';
    p += 2 + buf.readUInt16BE(p);                           // cipher_suites
    if (p + 1 > buf.length) return 'incomplete';
    p += 1 + buf[p];                                        // compression_methods
    if (p + 2 > buf.length) return 'incomplete';
    const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;     // extensions block
    while (p + 4 <= buf.length && p < extEnd) {
      const type = buf.readUInt16BE(p);
      const len = buf.readUInt16BE(p + 2);
      p += 4;
      if (type === 0x0000) {                                // server_name
        if (p + 5 > buf.length) return 'incomplete';
        const nameType = buf[p + 2];                        // skip list length (2)
        const nameLen = buf.readUInt16BE(p + 3);
        if (nameType !== 0) return null;                    // not host_name
        if (p + 5 + nameLen > buf.length) return 'incomplete';
        return buf.toString('ascii', p + 5, p + 5 + nameLen);
      }
      p += len;
    }
    return null;                                            // no SNI extension
  }

  function openSniTunnel(client, host, initialBuf) {
    try {
      openSniTunnelUnchecked(client, host, initialBuf);
    } catch (err) {
      console.error(`[sni-bridge] tunnel setup failed: ${err.message}`);
      client.destroy();
    }
  }

  function openSniTunnelUnchecked(client, host, initialBuf) {
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { host: `${host}:443` },
    });
    connectReq.on('connect', (res, upstream) => {
      if (res.statusCode !== 200) {
        console.error(`[sni-bridge] squid refused ${host}: ${res.statusCode} ${res.statusMessage || ''}`.trim());
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(initialBuf);                           // replay the ClientHello we peeked
      client.pipe(upstream);
      upstream.pipe(client);
      const cleanup = () => { client.destroy(); upstream.destroy(); };
      client.on('error', cleanup);
      upstream.on('error', cleanup);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    connectReq.on('error', (err) => {
      console.error(`[sni-bridge] CONNECT ${host} via squid failed: ${err.message}`);
      client.destroy();
    });
    connectReq.end();
  }

  let sniServer;
  if (SNI_BRIDGE_PORT > 0) {
    sniServer = net.createServer((client) => {
      tracker.hold(client, 'close');
      client.setTimeout(30000);
      let buf = Buffer.alloc(0);
      let resolved = false;
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const r = extractSNI(buf);
        if (r === 'incomplete') {
          if (buf.length > 8192) { console.error('[sni-bridge] no SNI in 8KB — dropping'); client.destroy(); }
          return;
        }
        resolved = true;
        client.removeListener('data', onData);
        client.pause();                                     // hold remaining bytes until the tunnel is up
        const sni = r ? r.toLowerCase() : r;
        if (!sni || !validSniHostname(sni) || !sniAllowed(sni)) {
          console.error(`[sni-bridge] reject SNI=${r ? JSON.stringify(r.slice(0, 100)) : '(none)'} (invalid or not in allowlist)`);
          client.destroy();
          return;
        }
        const relayOnly = readRelayOnlyDomains();
        if (!relayOnly || relayOnly.some(domain => hostMatchesDomain(sni, domain))) {
          if (relayOnly) console.warn(`[sni-bridge] reject SNI=${sni} (relay-only host)`);
          client.destroy();
          return;
        }
        openSniTunnel(client, sni, buf);
      };
      client.on('data', onData);
      client.on('error', () => {});
      client.on('timeout', () => { if (!resolved) client.destroy(); });
    });
    sniServer.on('error', (err) => console.error(`[sni-bridge] listener error: ${err.message}`));
    sniServer.listen(SNI_BRIDGE_PORT, () => {
      console.log(`[api-relay] SNI bridge on :${SNI_BRIDGE_PORT} -> squid CONNECT (allow: ${SNI_ALLOWED_SUFFIXES.join(', ')})`);
    });
  }

  let refreshTick;
  const refreshAll = () => {
    if (!configHealthy) return;
    if (!refreshTick) refreshTick = oauthManager.tick().finally(() => { refreshTick = null; });
    return refreshTick;
  };
  timers.push(setInterval(refreshAll, 60_000));
  void refreshAll();
  timers.push(setInterval(recordOpenRouterCredits, 5 * 60_000));
  void recordOpenRouterCredits();
  timers.push(setInterval(recordOpenRouterPrices, 60 * 60_000));
  void recordOpenRouterPrices();
  timers.push(setInterval(recordAnthropicApiCost, 5 * 60_000));
  void recordAnthropicApiCost();
  const forwarderListener = startForwarderListener();

  const stopBackground = () => {
    for (const timer of timers) clearInterval(timer);
    clearTimeout(_watchTimer);
    configWatcher?.close();
    mcpOAuth?.stop();
  };

  return {
    server, sniServer, oauthManager, mcpOAuth, forwarderListener, reload: () => loadClientConfigs(),
    tracker,
    drain() {
      drainAndExit(tracker, [server, sniServer, forwarderListener].filter(Boolean), { name: 'api-relay', env, cleanup: stopBackground });
    },
    close() {
      stopBackground();
      server.close();
      sniServer?.close();
      forwarderListener?.close();
    },
  };
}

// ── In-place code reload ─────────────────────────────────────────────────────
// The container's main process is a supervisor; one cluster worker runs the relay.
// SIGHUP forks a worker that loads the current code from disk. Once it listens,
// the old worker stops accepting connections and drains its open requests, so no
// connection is refused. A worker that fails to start leaves the old one serving.
// SIGTERM drains every worker, then the supervisor exits.
export function superviseRelay({ readyTimeoutMs = 30_000 } = {}) {
  const live = new Set();
  let current = null;
  let stopping = false;
  let failures = 0;
  let chain = Promise.resolve();
  const drain = worker => { try { worker.send({ type: 'drain' }); } catch { /* already gone */ } };

  // Resolves the worker once it reports all listeners up, or null if it exits first.
  const fork = () => new Promise(resolve => {
    const worker = cluster.fork();
    live.add(worker);
    const timer = setTimeout(() => {
      console.error(`[supervisor] worker ${worker.process.pid} not ready after ${readyTimeoutMs}ms; stopping it`);
      worker.process.kill('SIGKILL');
    }, readyTimeoutMs);
    worker.on('message', message => {
      if (message?.type === 'ready') { clearTimeout(timer); resolve(worker); }
    });
    worker.once('exit', (code, signal) => {
      clearTimeout(timer);
      live.delete(worker);
      resolve(null);
      if (worker === current) {
        current = null;
        if (!stopping) {
          console.error(`[supervisor] serving worker ${worker.process.pid} exited (code ${code}, signal ${signal}); starting a new one`);
          schedule('restart', 1000);
        }
      }
      if (stopping && live.size === 0) process.exit(0);
    });
  });

  const replace = async reason => {
    if (stopping) return;
    const next = await fork();
    if (!next) {
      failures++;
      if (current) {
        console.error(`[supervisor] new worker failed to start (${reason}); worker ${current.process.pid} keeps serving the previous code`);
      } else {
        console.error(`[supervisor] worker failed to start (${reason}); retrying`);
        schedule(reason, Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)));
      }
      return;
    }
    failures = 0;
    if (stopping) { drain(next); return; }
    const old = current;
    current = next;
    console.log(`[supervisor] worker ${next.process.pid} serving (${reason})` +
      (old ? `; worker ${old.process.pid} drains its open requests` : ''));
    if (old) drain(old);
  };
  // Starts, reloads and restarts run one at a time.
  const schedule = (reason, delayMs = 0) => setTimeout(() => { chain = chain.then(() => replace(reason)); }, delayMs);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log(`[supervisor] stopping; ${live.size} worker(s) drain`);
    if (live.size === 0) process.exit(0);
    for (const worker of live) drain(worker);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => schedule('reload'));
  schedule('start');
}

function runRelayWorker() {
  // The worker serves every sandbox's streams: log a stray rejection instead of exiting.
  process.on('unhandledRejection', reason => console.error('[relay] Unhandled rejection:', reason?.stack || reason));
  const relay = startApiRelay({ port: Number(process.env.RELAY_PORT) || 8080 });
  process.on('message', message => { if (message?.type === 'drain') relay.drain(); });
  process.on('disconnect', () => relay.drain());
  process.on('SIGTERM', () => relay.drain());
  process.on('SIGINT', () => relay.drain());
  const listeners = [relay.server, relay.sniServer, relay.forwarderListener].filter(Boolean);
  Promise.all(listeners.map(server => server.listening || once(server, 'listening')))
    .then(() => { if (process.connected) process.send({ type: 'ready' }); });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'api-relay.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cluster.isPrimary) superviseRelay();
  else runRelayWorker();
}
