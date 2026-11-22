/**
 * Relay forwarding between a box's api-relay (RELAY_MODE=forward) and the
 * central api-relay on the hub.
 *
 * The forwarder identifies the calling sandbox locally (Docker reverse DNS,
 * as before), attaches that sandbox's Board/service credentials from its own
 * box, and signs the request with HMAC-SHA256. The key is the SHA-256 of the
 * box's hub connection secret: the box derives it, Board stores it, and the
 * central relay fetches it from Board. Provider credentials never leave the
 * hub.
 */
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const FORWARD_HEADERS = Object.freeze({
  box: 'x-carapa-box',
  sandbox: 'x-carapa-sandbox',
  timestamp: 'x-carapa-timestamp',
  nonce: 'x-carapa-nonce',
  signature: 'x-carapa-signature',
  credentials: 'x-carapa-client-credentials',
});

const MAX_CLOCK_SKEW_MS = 60_000;

/** Per-request identity of a verified forwarded request (central relay). */
export const forwardContext = new AsyncLocalStorage();

export function forwarderKeyFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function canonical({ method, path, timestamp, nonce, box, sandbox, credentials }) {
  const credentialDigest = crypto.createHash('sha256').update(credentials || '').digest('hex');
  return [String(method).toUpperCase(), path, String(timestamp), nonce, box, sandbox, credentialDigest].join('\n');
}

function forwardSignature(keyHex, fields) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(canonical(fields)).digest('hex');
}

function encodeCredentials(map) {
  const entries = Object.entries(map || {}).filter(([, value]) => typeof value === 'string' && value);
  return entries.length ? Buffer.from(JSON.stringify(Object.fromEntries(entries))).toString('base64url') : '';
}

function decodeCredentials(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v));
  } catch {
    return {};
  }
}

/** Headers a forwarder adds to an outgoing request. */
export function signForwardHeaders({ keyHex, method, path, box, sandbox, credentials, now = Date.now() }) {
  const encoded = encodeCredentials(credentials);
  const timestamp = String(now);
  // A fresh nonce keeps concurrent identical requests in one millisecond from sharing a signature.
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    [FORWARD_HEADERS.box]: box,
    [FORWARD_HEADERS.sandbox]: sandbox,
    [FORWARD_HEADERS.timestamp]: timestamp,
    [FORWARD_HEADERS.nonce]: nonce,
    [FORWARD_HEADERS.signature]: forwardSignature(keyHex, { method, path, timestamp, nonce, box, sandbox, credentials: encoded }),
    ...(encoded ? { [FORWARD_HEADERS.credentials]: encoded } : {}),
  };
}

/** Remove forwarding headers (never trust them from agents, never send upstream). */
export function stripForwardHeaders(headers) {
  for (const name of Object.values(FORWARD_HEADERS)) delete headers[name];
  return headers;
}

/** Compose project of a sandbox hostname ('<container>.agent_egress_<project>'). */
export function sandboxAllowed(hostname, projects) {
  if (typeof hostname !== 'string' || !hostname || !Array.isArray(projects)) return false;
  // A dotted name must be exactly '<container>.agent_egress_<project>' (one label
  // before the dot, project without dots, as the hub parses it); anything else fails closed.
  const egress = hostname.includes('.') ? hostname.match(/^([^.]+)\.agent_egress_([\w-]+)$/) : null;
  if (hostname.includes('.') && !egress) return false;
  const container = egress ? egress[1] : hostname;
  // Compose names containers <project>-<service>-<n>; services have no '-',
  // so a project can never claim a longer sibling project's containers.
  const owns = project => new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9_]+-\\d+$`).test(container);
  if (egress) return projects.includes(egress[2]) && owns(egress[2]);
  return projects.some(owns);
}

/** Signatures seen within the clock-skew window (a signed request is accepted once). */
export function createReplayGuard(windowMs = MAX_CLOCK_SKEW_MS * 2) {
  const seen = new Map();
  return (signature, now = Date.now()) => {
    for (const [value, at] of seen) if (now - at > windowMs) seen.delete(value); else break;
    if (seen.has(signature)) return false;
    seen.set(signature, now);
    return true;
  };
}

/**
 * Cheap checks that need no box policy: all signed headers present and a fresh
 * timestamp. Run before any policy lookup so unauthenticated requests cost nothing.
 * Returns { ok: true, fields } or { ok: false, reason }.
 */
export function precheckForwardedHeaders(headers, now = Date.now()) {
  const box = headers[FORWARD_HEADERS.box];
  const sandbox = headers[FORWARD_HEADERS.sandbox];
  const timestamp = headers[FORWARD_HEADERS.timestamp];
  const nonce = headers[FORWARD_HEADERS.nonce];
  const signature = headers[FORWARD_HEADERS.signature];
  const credentials = headers[FORWARD_HEADERS.credentials] || '';
  if (![box, sandbox, timestamp, nonce, signature].every(value => typeof value === 'string' && value)) {
    return { ok: false, reason: 'missing forwarding headers' };
  }
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(now - time) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale timestamp' };
  return { ok: true, fields: { box, sandbox, timestamp, nonce, signature, credentials } };
}

/**
 * Verify a forwarded request against the box policy ({ key, projects }).
 * Returns { ok: true, box, sandbox, credentials } or { ok: false, reason }.
 */
export function verifyForwardedRequest({ headers, method, path }, policyFor, now = Date.now()) {
  const pre = precheckForwardedHeaders(headers, now);
  if (!pre.ok) return pre;
  const { box, sandbox, timestamp, nonce, signature, credentials } = pre.fields;
  const policy = policyFor(box);
  if (!policy?.key) return { ok: false, reason: 'unknown box' };
  const expected = forwardSignature(policy.key, { method, path, timestamp, nonce, box, sandbox, credentials });
  const given = Buffer.from(signature, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return { ok: false, reason: 'bad signature' };
  if (!sandboxAllowed(sandbox, policy.projects)) return { ok: false, reason: 'sandbox not placed on this box' };
  return { ok: true, box, sandbox, credentials: decodeCredentials(credentials) };
}
