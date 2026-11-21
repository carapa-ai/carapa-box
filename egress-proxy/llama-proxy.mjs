// llama-proxy.mjs — HTTP proxy from sandboxes to host's local llama.cpp / Ollama.
//
// Forwards inbound HTTP on each listen port to host.docker.internal on the
// same port, applying request-side transforms that protect llama.cpp's
// KV-cache hit-rate for Anthropic-format payloads (claude-code, Claude
// Agent SDK).
//
// Transforms (cheap Buffer.indexOf pre-check; full JSON parse only on match,
// so Ollama / plain OpenAI-chat traffic skips the parse path entirely):
//   - hoist-anthropic-system-messages: for /v1/messages only, move any
//     system/developer entries accidentally carried inside body.messages into
//     the top-level Anthropic body.system field. Strict model templates require
//     those messages to precede the conversation history.
//   - hoist-openai-system-messages: for /v1/chat/completions only, combine any
//     system entries into one leading system message. Developer entries are
//     passed through so Qwen-compatible templates can keep them after history.
//   - hoist-openai-responses-system-messages: for /v1/responses, combine
//     system AND developer items from body.input[] into body.instructions
//     before chat-completions backends (llama.cpp, LiteLLM) convert the
//     Responses request to Chat Completions. OpenAI treats "developer" as an
//     alias of "system", but Qwen-family Jinja templates only accept a system
//     message in the first slot — so the content must land in instructions
//     (which renders as the leading system message) or the model 400s.
//   - strip-billing-header: drop system[].text blocks whose text begins with
//     "x-anthropic-billing-header". These carry a per-call `cch=` hash
//     that lives at the front of the rendered system prompt and would
//     defeat prefix-cache reuse on every call.
//   - strip-tools-by-profile: when body.model matches a profile name from
//     tool_profiles.jsonc, filter body.tools[] to the profile's allow list
//     and, if the profile declares a `model`, rewrite body.model to that
//     upstream model id. llama.cpp ignores the field (always serves the
//     loaded model), but Ollama requires a real model name — the rewrite
//     lets us keep profile-named agents working against either backend.
//     Profiles are intended for local-LLM agents; the model field carries
//     the profile name (e.g. board_agents.jsonc entry with model="coder").
//     tool_profiles.jsonc is auto-reloaded on change (debounced 150 ms);
//     SIGHUP also forces a reload.
//   - reject-cloud-model: short-circuit a 404 when body.model still starts
//     with "claude-" after the profile pass. Claude Code fires hardcoded
//     `claude-haiku-*` requests in parallel with the main reply (title gen,
//     context summarization). Local llama.cpp/Ollama cannot serve them;
//     rejecting at the proxy avoids the round trip and the Ollama log
//     noise. Skipped if body.model is rewritten to a real upstream id.
//
// Blocked endpoints (all listen ports): Ollama model-management calls are
// refused with 403 before the body is read or anything reaches the upstream.
// `/api/pull` and `/api/push` make the HOST connect to any registry named in
// the model (bypassing squid); the others change host model state or stage
// data for a push:
//   /api/pull  /api/push  /api/create  /api/copy  /api/delete
//   /api/blobs and everything under /api/blobs/
// Docker Model Runner (DMR) management is refused for every method except GET
// (listings and inference stay open). DMR's API reference
// (https://docs.docker.com/ai/model-runner/api-reference/) documents
// POST /models/create, GET /models, GET /models/{namespace}/{name} and
// DELETE /models/{namespace}/{name}; it does not list tag, push, package,
// load or purge (DMR registers POST /models/{name}/tag, POST /models/{name}/push,
// POST /models/load and DELETE /models/purge), so every non-GET request is
// refused under:
//   /models  /models/...  and the same behind /engines/<engine>/ or /v1/
//   (e.g. /engines/v1/models/create, /engines/llama.cpp/v1/models/x/push)
// Only OPTIONS on the OpenAI-style model listing (/v1/models,
// /engines/.../v1/models) is let through, for CORS preflights.
// On the native /models/{ref} route GET is also refused when it can leave the
// host or export data: any `remote` query value other than an explicit false
// (GET /models/{ref}?remote=true makes the host query the registry named in
// {ref}) and a final `export` segment (GET /models/{ref}/export downloads the
// local model archive). The `/models` listing ignores the query and stays open.
// The path is matched after dropping the query string, percent-decoding
// (repeatedly), resolving `.`/`..`, collapsing `//`, and ignoring case and a
// trailing slash. Every other path is forwarded as before.
//
// Env vars:
//   RELAY_DRAIN_TIMEOUT_MS  SIGTERM drain cap in ms. Default 900000.
//   PORTS               Comma-separated listen ports. Default "8880,11434".
//                       Each port forwards to <UPSTREAM_HOST>:<same port>.
//   UPSTREAM_HOST       Host to forward to. Default "host.docker.internal".
//   LOG_REQUESTS        Set to "1"/"true" to log one short line per request.
//                       Default off (quiet — only startup + errors).
//   LLAMA_DEBUG         Set to "1"/"true" to dump every request body to
//                       CAPTURE_DIR (and imply LOG_REQUESTS). Default off.
//   CAPTURE_DIR         Where to write captures when LLAMA_DEBUG is on.
//                       Default "/app/captures" (compose mounts ./captures here;
//                       inside /app/** because the shared apparmor profile only
//                       allow-lists /app, /tmp, /var/log, /run for writes).
//   TOOL_PROFILES_PATH  Path to the profiles file (JSON or JSONC).
//                       Default "/app/tool_profiles.jsoncc". Line (`//`) and block
//                       (`/* */`) comments and trailing commas are tolerated.
//                       Missing or invalid file = no profiles loaded (transform off).
//   LOADING_RETRY_ATTEMPTS  Retries on upstream 503 (brief llama.cpp restart). Default 10;
//                           a non-integer or negative value falls back to the default.
//   LOADING_RETRY_DELAY_MS  Fixed wait between retries. Default 5000.
//   API_KEY               Optional fallback for the port-3001 FreeLLMAPI key.
//                         The Docker Compose secret is preferred.
//   MAX_BODY_BYTES        Request body cap in bytes. Larger requests get a 413
//                         and never reach the upstream. Default 33554432 (32 MiB,
//                         same as the api-relay cap); 0 disables the cap.
//   MAX_BUFFERED_BODY_BYTES  Global budget of request-body bytes buffered across all
//                         in-flight requests (the container has 128M). A request whose
//                         Content-Length, or streamed size so far, exceeds the remaining
//                         budget gets a 503 and is never forwarded. A declared
//                         Content-Length over MAX_BODY_BYTES gets the 413 even when it also
//                         exceeds the budget. A stream is judged chunk by chunk, so it can
//                         exhaust the budget (503) before it crosses MAX_BODY_BYTES. A transformed
//                         request also counts its re-serialized copy against the budget
//                         (503 if received body plus copy no longer fit). A request holds
//                         its bytes until its response closes (finished, errored or aborted).
//                         Default 50331648 (48 MiB); 0 disables the budget.
//   TRANSFORM_MAX_BYTES   Bodies above this many bytes are forwarded unchanged,
//                         without the pre-check or JSON parse (bounds the proxy's
//                         memory: the transform holds ~5 copies). Default 8388608
//                         (8 MiB); 0 disables the skip.

import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { readFileSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const truthy = v => v === '1' || v === 'true' || v === 'yes' || v === 'on';

const PORTS = (process.env.PORTS ?? '8880,11434')
  .split(',').map(s => Number(s.trim())).filter(Number.isFinite);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'host.docker.internal';
const DEBUG = truthy(process.env.LLAMA_DEBUG);
const CAPTURE_DIR = DEBUG ? (process.env.CAPTURE_DIR ?? '/app/captures') : null;
const LOG_REQUESTS = truthy(process.env.LOG_REQUESTS) || DEBUG;
const FREELLMAPI_PORT = 3001;
const OLLAMA_PORT = 11434;
const OLLAMA_API_KEY = 'ollama';

function readSecret(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`secret read failed (${path}): ${e.message}`);
    return null;
  }
}

const FREELLMAPI_KEY = readSecret('/run/secrets/freellmapi_key') || process.env.API_KEY || null;

// Non-negative integer env var; unset or malformed falls back to the default.
function byteLimitEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

const MAX_BODY_BYTES = byteLimitEnv('MAX_BODY_BYTES', 32 * 1024 * 1024);
const TRANSFORM_MAX_BYTES = byteLimitEnv('TRANSFORM_MAX_BYTES', 8 * 1024 * 1024);
const MAX_BUFFERED_BODY_BYTES = byteLimitEnv('MAX_BUFFERED_BODY_BYTES', 48 * 1024 * 1024);
// Request-body bytes currently buffered across every in-flight request.
let bufferedBodyBytes = 0;

const LOADING_RETRY_ATTEMPTS = byteLimitEnv('LOADING_RETRY_ATTEMPTS', 10);
const LOADING_RETRY_DELAY_MS = parseInt(process.env.LOADING_RETRY_DELAY_MS || '5000', 10);

const BILLING_NEEDLE = Buffer.from('x-anthropic-billing-header');
const CLOUD_MODEL_NEEDLE = Buffer.from('"model":"claude-');
// "developer" is OpenAI's alias for "system"; strict Qwen-family templates
// (via LiteLLM / tabbyAPI) rename it to a non-leading system message and 400,
// so it must be caught by the pre-check and hoisted into instructions.
const CHAT_SYSTEM_ROLE_RE = /"role"\s*:\s*"(system|developer)"/;
const TOOL_PROFILES_PATH = process.env.TOOL_PROFILES_PATH ?? '/app/tool_profiles.jsoncc';
let seq = 0;

// Profile registry: { "<name>": { allow: Set<string>, model: string|null } }
// Rebuilt on startup and on SIGHUP. Empty object disables the transform.
let profilesByName = Object.create(null);
let modelNeedles = []; // Array<Buffer> — one per profile name, for the pre-check.

// Strip JSONC line/block comments and trailing commas. Walks the text once,
// passing string literals through verbatim so `//` or `/*` inside a value are
// preserved.
function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : '';
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < n) { out += ch + text[i + 1]; i += 2; continue; }
        out += ch; i++;
        if (ch === '"') break;
      }
      continue;
    }
    if (c === '/' && next === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function loadProfiles() {
  let raw;
  try { raw = readFileSync(TOOL_PROFILES_PATH, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`tool_profiles: no file at ${TOOL_PROFILES_PATH} — profile stripping disabled`);
    } else {
      console.error(`tool_profiles: read failed (${e.message}) — profile stripping disabled`);
    }
    profilesByName = Object.create(null);
    modelNeedles = [];
    return;
  }
  let parsed;
  try { parsed = JSON.parse(stripJsonc(raw)); }
  catch (e) {
    console.error(`tool_profiles: parse failed (${e.message}) — keeping previous profile set`);
    return;
  }
  const next = Object.create(null);
  const needles = [];
  for (const [name, def] of Object.entries(parsed)) {
    const allow = Array.isArray(def?.allow) ? def.allow : [];
    const exact = new Set();
    const prefixes = [];
    for (const entry of allow) {
      if (typeof entry !== 'string' || !entry) continue;
      if (entry.endsWith('*')) prefixes.push(entry.slice(0, -1));
      else exact.add(entry);
    }
    const model = typeof def?.model === 'string' && def.model ? def.model : null;
    next[name] = { exact, prefixes, model };
    needles.push(Buffer.from(`"model":"${name}"`));
  }
  profilesByName = next;
  modelNeedles = needles;
  const names = Object.keys(profilesByName);
  console.log(`tool_profiles: loaded ${names.length} profile(s)${names.length ? ` (${names.join(', ')})` : ''}`);
}

function stripAnthropicBillingHeader(body) {
  if (!body || !Array.isArray(body.system)) return null;
  const before = body.system.length;
  body.system = body.system.filter(b => {
    const t = (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '';
    return !t.startsWith('x-anthropic-billing-header');
  });
  const removed = before - body.system.length;
  return removed > 0 ? `strip-billing-header(-${removed})` : null;
}

function asAnthropicSystemBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => {
    if (typeof block === 'string') return [{ type: 'text', text: block }];
    return block && typeof block === 'object' ? [block] : [];
  });
}

function hoistAnthropicSystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const messages = [];
  const extracted = [];
  let removed = 0;
  for (const message of body.messages) {
    if (message && typeof message === 'object' &&
      (message.role === 'system' || message.role === 'developer')) {
      removed++;
      extracted.push(...asAnthropicSystemBlocks(message.content));
    } else {
      messages.push(message);
    }
  }
  if (removed === 0) return null;

  const existing = asAnthropicSystemBlocks(body.system);
  body.messages = messages;
  body.system = [...existing, ...extracted];
  return `hoist-system-messages(-${removed},blocks=${extracted.length})`;
}

function hoistOpenAISystemMessages(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const guidance = [];
  const conversation = [];
  let sawConversation = false;
  let needsNormalization = false;

  for (const message of body.messages) {
    if (message && typeof message === 'object' && message.role === 'system') {
      guidance.push(message);
      if (sawConversation || guidance.length > 1) {
        needsNormalization = true;
      }
    } else {
      sawConversation = true;
      conversation.push(message);
    }
  }
  if (!needsNormalization) return null;

  const content = guidance.map(message => responseGuidanceText(message.content)).filter(Boolean).join('\n\n');
  body.messages = [{ ...guidance[0], role: 'system', content }, ...conversation];
  return `hoist-openai-system-messages(-${guidance.length},conversation=${conversation.length})`;
}

function responseGuidanceText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    return part && typeof part.text === 'string' ? part.text : '';
  }).filter(Boolean).join('\n').trim();
}

function hoistOpenAIResponsesSystemMessages(body) {
  if (!body || !Array.isArray(body.input)) return null;
  const guidance = [];
  const input = [];
  const hasInstructions = Object.hasOwn(body, 'instructions');
  let sawConversation = false;
  let needsNormalization = false;

  for (const item of body.input) {
    // Codex (Responses API) sends AGENTS.md / skills guidance as a
    // role:"developer" item at input[0] alongside a top-level instructions.
    // "developer" is an alias of "system" downstream (litellm normalizes it),
    // so treat both identically: merge into instructions, remove from input.
    if (item && typeof item === 'object' &&
      (item.role === 'system' || item.role === 'developer')) {
      guidance.push(item);
      if (sawConversation || guidance.length > 1 || hasInstructions) {
        needsNormalization = true;
      }
    } else {
      sawConversation = true;
      input.push(item);
    }
  }
  if (!needsNormalization) return null;

  const existing = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  const extracted = guidance.map(item => responseGuidanceText(item.content)).filter(Boolean);
  const instructions = [existing, ...extracted].filter(Boolean).join('\n\n');
  body.instructions = instructions;
  body.input = input;
  return `hoist-openai-responses-system-messages(-${guidance.length},input=${input.length})`;
}

// Extract the tool name from either request shape.
// Anthropic /v1/messages:           { name, description, input_schema }
// OpenAI /v1/chat/completions:      { type:"function", function:{ name, ... } }
function toolName(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.name === 'string') return t.name;
  if (t.function && typeof t.function.name === 'string') return t.function.name;
  return null;
}

function stripToolsByProfile(body) {
  if (!body || typeof body.model !== 'string') return null;
  const profileName = body.model;
  const profile = profilesByName[profileName];
  if (!profile) return null;
  const notes = [];
  if (Array.isArray(body.tools)) {
    const before = body.tools.length;
    body.tools = body.tools.filter(t => {
      const name = toolName(t);
      if (!name) return false;
      if (profile.exact.has(name)) return true;
      for (const p of profile.prefixes) if (name.startsWith(p)) return true;
      return false;
    });
    const kept = body.tools.length;
    if (kept !== before) notes.push(`strip-tools(profile=${profileName},kept=${kept}/${before})`);
  }
  if (profile.model && body.model !== profile.model) {
    body.model = profile.model;
    notes.push(`rewrite-model(profile=${profileName}→${profile.model})`);
  }
  return notes.length ? notes.join(' ') : null;
}

function hasModelNeedle(inBuf) {
  for (const n of modelNeedles) {
    if (inBuf.indexOf(n) >= 0) return true;
  }
  return false;
}

function isAnthropicMessagesPath(requestUrl) {
  return typeof requestUrl === 'string' && requestUrl.split('?', 1)[0] === '/v1/messages';
}

function isOpenAIChatCompletionsPath(requestUrl) {
  return typeof requestUrl === 'string' && requestUrl.split('?', 1)[0] === '/v1/chat/completions';
}

function isOpenAIResponsesPath(requestUrl) {
  if (typeof requestUrl !== 'string') return false;
  const path = requestUrl.split('?', 1)[0];
  return path === '/v1/responses' || path === '/responses';
}

function transformBody(inBuf, requestUrl = '') {
  const passthrough = { outBuf: inBuf, applied: [], reject: null, originalTools: null };
  if (inBuf.length === 0) return passthrough;
  if (TRANSFORM_MAX_BYTES > 0 && inBuf.length > TRANSFORM_MAX_BYTES) return passthrough;
  const isAnthropicMessages = isAnthropicMessagesPath(requestUrl);
  const isOpenAIChatCompletions = isOpenAIChatCompletionsPath(requestUrl);
  const isOpenAIResponses = isOpenAIResponsesPath(requestUrl);
  const hasBilling = inBuf.indexOf(BILLING_NEEDLE) >= 0;
  const hasProfile = modelNeedles.length > 0 && hasModelNeedle(inBuf);
  const hasCloudModel = inBuf.indexOf(CLOUD_MODEL_NEEDLE) >= 0;
  // Role formatting varies across clients, so use a tolerant pre-check before
  // parsing OpenAI chat/Responses requests. This keeps ordinary passthrough
  // cheap while still catching pretty-printed and compact JSON alike.
  const hasChatSystem = (isOpenAIChatCompletions || isOpenAIResponses) &&
    CHAT_SYSTEM_ROLE_RE.test(inBuf.toString('utf8'));
  // In capture mode we always parse so tools_in lands in the meta even for
  // bodies that trigger no transform (e.g. plain opencode/Ollama traffic).
  if (!isAnthropicMessages && !hasChatSystem && !hasBilling && !hasProfile && !hasCloudModel && !CAPTURE_DIR) {
    return { outBuf: inBuf, applied: [], reject: null, originalTools: null };
  }
  let body;
  try { body = JSON.parse(inBuf.toString('utf8')); }
  catch { return passthrough; }
  // `null`, arrays and primitives are valid JSON but not request objects.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return passthrough;
  const originalTools = Array.isArray(body.tools)
    ? body.tools.map(toolName).filter(Boolean)
    : null;
  const applied = [];
  const transforms = isAnthropicMessages
    ? [hoistAnthropicSystemMessages, stripAnthropicBillingHeader, stripToolsByProfile]
    : isOpenAIChatCompletions
      ? [hoistOpenAISystemMessages, stripAnthropicBillingHeader, stripToolsByProfile]
      : isOpenAIResponses
        ? [hoistOpenAIResponsesSystemMessages, stripAnthropicBillingHeader, stripToolsByProfile]
        : [stripAnthropicBillingHeader, stripToolsByProfile];
  for (const fn of transforms) {
    const note = fn(body);
    if (note) applied.push(note);
  }
  let reject = null;
  if (typeof body.model === 'string' && body.model.startsWith('claude-')) {
    reject = { model: body.model };
    applied.push(`reject-cloud-model(${body.model})`);
  }
  if (applied.length === 0) return { outBuf: inBuf, applied: [], reject: null, originalTools };
  return { outBuf: Buffer.from(JSON.stringify(body), 'utf8'), applied, reject, originalTools };
}

async function writeCapture(id, startMs, req, port, inBuf, outBuf, applied, status, ttfbMs, totalMs, errorMsg, originalTools) {
  if (!CAPTURE_DIR) return;
  const meta = {
    id,
    ts: new Date(startMs).toISOString(),
    port,
    method: req.method,
    url: req.url,
    headers: req.headers,
    body_bytes_in: inBuf.length,
    body_bytes_out: outBuf.length,
    tools_in: originalTools ?? null,
    transform: { applied, changed: applied.length > 0 },
    response: { status, ttfb_ms: ttfbMs, total_ms: totalMs, error: errorMsg ?? null },
  };
  try {
    const writes = [
      writeFile(join(CAPTURE_DIR, `${id}.body`), outBuf),
      writeFile(join(CAPTURE_DIR, `${id}.json`), JSON.stringify(meta, null, 2)),
    ];
    if (applied.length > 0 && inBuf.length !== outBuf.length) {
      writes.push(writeFile(join(CAPTURE_DIR, `${id}.body.in`), inBuf));
    }
    await Promise.all(writes);
  } catch (e) {
    console.error(`[${id}] capture write failed: ${e.message}`);
  }
}

function parseRetryAfterMs(headers) {
  const retryAfterS = parseInt(headers?.['retry-after'], 10);
  // HTTP-date values parse to NaN; fall back to the default delay instead.
  return Number.isNaN(retryAfterS) ? 0 : Math.min(Math.max(0, retryAfterS) * 1000, 120_000);
}

function isRetryable503(statusCode) {
  return statusCode === 503;
}

function describe503Body(body) {
  if (!body?.length) return '(empty body)';
  const text = body.toString('utf8').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function sleep(ms, link) {
  return new Promise(r => {
    const timer = setTimeout(r, ms);
    link.wake = () => { clearTimeout(timer); r(); };
  });
}

/**
 * One upstream round-trip. Non-503 responses are returned as a live stream so
 * SSE / chunked bodies are not buffered. 503 responses are buffered for inspection.
 */
function forwardUpstreamOnce(port, method, url, headers, body, link) {
  return new Promise((resolve, reject) => {
    if (link.closed) {
      reject(new Error('client closed'));
      return;
    }
    const proxyReq = http.request({
      host: UPSTREAM_HOST,
      port,
      method,
      path: url,
      headers,
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 503) {
        resolve({ mode: 'stream', proxyRes });
        return;
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        resolve({
          mode: 'buffer',
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks),
        });
      });
      link.proxyRes = proxyRes;
      proxyRes.on('error', reject);
    });
    link.proxyReq = proxyReq;
    proxyReq.on('error', reject);
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

function pipeUpstreamResponse(port, req, res, proxyRes, ctx) {
  const { id, startMs, inBuf, outBuf, applied, changed, originalTools } = ctx;
  const ttfbMs = Date.now() - startMs;
  res.writeHead(proxyRes.statusCode, proxyRes.headers);
  proxyRes.pipe(res);
  proxyRes.on('end', () => {
    const totalMs = Date.now() - startMs;
    if (LOG_REQUESTS) {
      const xform = changed ? ` xform=[${applied.join(',')}]` : '';
      const tag = id ? `[${id}] ` : '';
      console.log(`${tag}:${port} ${req.method} ${req.url} ${proxyRes.statusCode} ${totalMs}ms${xform}`);
    }
    if (CAPTURE_DIR) writeCapture(id, startMs, req, port, inBuf, outBuf, applied, proxyRes.statusCode, ttfbMs, totalMs, null, originalTools);
  });
  proxyRes.on('close', () => {
    if (!proxyRes.complete && !res.destroyed) res.destroy(new Error('upstream closed mid-stream'));
  });
  proxyRes.on('error', e => {
    console.error(`:${port} upstream stream error: ${e.message}`);
    res.destroy(e);
    if (CAPTURE_DIR) writeCapture(id, startMs, req, port, inBuf, outBuf, applied, proxyRes.statusCode, ttfbMs, Date.now() - startMs, e.message, originalTools);
  });
}

async function forwardUpstreamWithRetry(port, req, res, outHeaders, outBuf, ctx) {
  const { link } = ctx;
  for (let attempt = 1; attempt <= LOADING_RETRY_ATTEMPTS + 1; attempt++) {
    if (link.closed) return;
    let result;
    try {
      result = await forwardUpstreamOnce(port, req.method, req.url, outHeaders, outBuf, link);
    } catch (e) {
      if (link.closed) return;
      console.error(`:${port} upstream error: ${e.message}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(`bad gateway: ${e.message}`);
      }
      if (CAPTURE_DIR) writeCapture(ctx.id, ctx.startMs, req, port, ctx.inBuf, outBuf, ctx.applied, 0, null, Date.now() - ctx.startMs, e.message, ctx.originalTools);
      return;
    }

    if (link.closed) {
      result.proxyRes?.destroy();
      return;
    }

    if (result.mode === 'stream') {
      pipeUpstreamResponse(port, req, res, result.proxyRes, ctx);
      return;
    }

    if (isRetryable503(result.statusCode) && attempt <= LOADING_RETRY_ATTEMPTS) {
      const retryAfterMs = parseRetryAfterMs(result.headers);
      const waitMs = Math.max(LOADING_RETRY_DELAY_MS, retryAfterMs);
      const tag = ctx.id ? `[${ctx.id}] ` : '';
      console.log(`${tag}:${port} upstream 503 (${describe503Body(result.body)}), retry ${attempt}/${LOADING_RETRY_ATTEMPTS} in ${waitMs}ms`);
      await sleep(waitMs, link);
      continue;
    }

    if (isRetryable503(result.statusCode)) {
      const tag = ctx.id ? `[${ctx.id}] ` : '';
      console.warn(`${tag}:${port} upstream 503 after ${LOADING_RETRY_ATTEMPTS} retries (${describe503Body(result.body)})`);
    }

    const totalMs = Date.now() - ctx.startMs;
    const ttfbMs = totalMs;
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
    if (LOG_REQUESTS) {
      const xform = ctx.changed ? ` xform=[${ctx.applied.join(',')}]` : '';
      const tag = ctx.id ? `[${ctx.id}] ` : '';
      console.log(`${tag}:${port} ${req.method} ${req.url} ${result.statusCode} ${totalMs}ms${xform}`);
    }
    if (CAPTURE_DIR) writeCapture(ctx.id, ctx.startMs, req, port, ctx.inBuf, outBuf, ctx.applied, result.statusCode, ttfbMs, totalMs, null, ctx.originalTools);
    return;
  }
}

// ── In-flight tracking and graceful drain ────────────────────────────────────
// Duplicated in api-relay.mjs / llama-proxy.mjs (separate Dockerfile COPY lists).
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createDrainTracker() {
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
      res.end(JSON.stringify({ inflight, draining }) + '\n');
      return true;
    },
  };
}

// Stop accepting connections, wait for in-flight work, then exit(0). `servers`
// are closed immediately (idle keep-alive sockets too); RELAY_DRAIN_TIMEOUT_MS
// caps the wait (default 15 min). A second signal is ignored.
function drainAndExit(tracker, servers, { name, env = process.env, cleanup = () => {} } = {}) {
  if (tracker.draining) return;
  const parsed = parseInt(env.RELAY_DRAIN_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 900_000;
  console.log(`[drain] start inflight=${tracker.inflight} (${name})`);
  let cap = null;
  const finish = (msg) => {
    clearTimeout(cap);
    console.log(msg);
    process.exit(0);
  };
  tracker.startDraining(() => finish('[drain] done'));
  try { cleanup(); } catch { }
  for (const s of servers) {
    try { s.close(); } catch { }
    try { s.closeIdleConnections?.(); } catch { }
  }
  if (tracker.inflight > 0) {
    cap = setTimeout(() => finish(`[drain] timeout after ${timeoutMs}ms, inflight=${tracker.inflight} — exiting`), timeoutMs);
  }
}

const tracker = createDrainTracker();

// Ollama endpoints that pull/push from arbitrary registries or change host model state.
const BLOCKED_API_PATHS = new Set(['/api/pull', '/api/push', '/api/create', '/api/copy', '/api/delete', '/api/blobs']);

// Normalise a request target to the path an upstream router would match.
// Returns null when it cannot be normalised (caller treats that as blocked).
function normalizeRequestPath(url) {
  let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
  try {
    for (let i = 0; ; i++) {
      if (i > 8) return null;
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { return null; }
  const out = [];
  for (const seg of path.replaceAll('\\', '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg.toLowerCase());
  }
  return '/' + out.join('/');
}

// Docker Model Runner management lives under /models (optionally behind
// /engines/<engine>/ and /v1/); non-GET there creates, pulls, deletes, tags,
// pushes or prunes models. See the header comment for the API reference.
// Only the native GET /models/{ref}[?remote=...] and GET /models/{ref}/export
// routes (docker/model-runner pkg/inference/models/http_handler.go) can query a
// registry or export an archive; the OpenAI-style /v1/models/{ref} and
// /engines/.../v1/models/{ref} getters are local-only.
const DMR_NATIVE_MODELS_PATH = /^\/models(?:\/|$)/;
const DMR_MODELS_PATH = /^\/(?:engines\/[^/]+\/)?(?:v1\/)?models(?:\/|$)/;
// OPTIONS (CORS preflight) is let through only for the OpenAI-style model listing.
const DMR_OPENAI_LISTING_PATH = /^\/(?:v1|engines\/v1|engines\/[^/]+\/v1)\/models$/;
const LOCAL_ONLY_VALUES = new Set(['0', 'f', 'false']);

function decodeRepeatedly(text) {
  for (let n = 0; n < 8; n++) {
    const decoded = decodeURIComponent(text);
    if (decoded === text) return text;
    text = decoded;
  }
  return text;
}

// True when the query string has a `remote` key (key decoded repeatedly and
// case-folded) with any value other than an explicit false: absent value,
// true, garbage and undecodable text all count as a registry query. Every
// repeated occurrence is checked.
function queriesRegistry(url) {
  const i = url.indexOf('?');
  if (i < 0) return false;
  for (const pair of url.slice(i + 1).split(/[&;]/)) {
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    try {
      if (decodeRepeatedly(rawKey.replaceAll('+', ' ')).trim().toLowerCase() !== 'remote') continue;
      if (eq < 0) return true;
      const value = decodeRepeatedly(pair.slice(eq + 1).replaceAll('+', ' ')).trim().toLowerCase();
      if (!LOCAL_ONLY_VALUES.has(value)) return true;
    } catch { return true; }
  }
  return false;
}

function isBlockedManagementPath(url, method) {
  const path = normalizeRequestPath(url);
  if (path === null || BLOCKED_API_PATHS.has(path) || path.startsWith('/api/blobs/')) return true;
  if (!DMR_MODELS_PATH.test(path)) return false;
  const native = DMR_NATIVE_MODELS_PATH.test(path);
  if (method === 'OPTIONS' && DMR_OPENAI_LISTING_PATH.test(path)) return false;
  if (method !== 'GET') return true;
  return native && path !== '/models' && (queriesRegistry(url) || path.endsWith('/export'));
}

function makeHandler(port) {
  return (req, res) => {
    if (req.url === '/_health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (isBlockedManagementPath(req.url, req.method)) {
      console.warn(`:${port} 403 blocked model-management ${req.method} ${req.url}`);
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Forbidden: model-management endpoints are blocked\n');
      return;
    }
    if (port === PORTS[0] && tracker.handleStatus(req, res)) return;
    tracker.hold(res, 'close', 'finish');

    const startMs = Date.now();
    const id = CAPTURE_DIR ? `${startMs}-${(++seq).toString().padStart(6, '0')}` : null;
    if (LOG_REQUESTS) {
      const tag = id ? `[${id}] ` : '';
      console.log(`${tag}:${port} ${req.method} ${req.url} <- ${req.headers['user-agent'] ?? '?'}`);
    }
    let chunks = [];
    let received = 0;
    let overflowed = false;
    // Bytes this request holds in the global budget; returned once, on response close.
    let held = 0;
    const releaseBudget = () => {
      bufferedBodyBytes -= held;
      held = 0;
    };
    const rejectBody = (status, type, message) => {
      overflowed = true;
      chunks = [];
      releaseBudget();
      const errBody = JSON.stringify({ type: 'error', error: { type, message } });
      // Destroy the request only once the error is out; earlier the client sees a reset.
      res.once('finish', () => req.destroy());
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(errBody)),
        connection: 'close',
      });
      res.end(errBody);
    };
    const budgetMessage = 'proxy request-body buffer budget exhausted; retry later';
    const declared = Number(req.headers['content-length']);
    if (MAX_BODY_BYTES > 0 && declared > MAX_BODY_BYTES) {
      // Can never fit: answer 413 (not a retryable 503), whatever the budget has left.
      console.warn(`:${port} 413 ${declared} > ${MAX_BODY_BYTES} ${req.url}`);
      rejectBody(413, 'request_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    } else if (MAX_BUFFERED_BODY_BYTES > 0 && declared > MAX_BUFFERED_BODY_BYTES - bufferedBodyBytes) {
      console.warn(`:${port} 503 content-length ${declared} over remaining buffer budget ${req.url}`);
      rejectBody(503, 'overloaded_error', budgetMessage);
    }
    req.on('data', c => {
      if (overflowed) return;
      received += c.length;
      if (MAX_BODY_BYTES > 0 && received > MAX_BODY_BYTES) {
        console.warn(`:${port} 413 ${received} > ${MAX_BODY_BYTES} ${req.url}`);
        rejectBody(413, 'request_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      if (MAX_BUFFERED_BODY_BYTES > 0 && bufferedBodyBytes + c.length > MAX_BUFFERED_BODY_BYTES) {
        console.warn(`:${port} 503 buffer budget ${MAX_BUFFERED_BODY_BYTES} exhausted at ${received} bytes ${req.url}`);
        rejectBody(503, 'overloaded_error', budgetMessage);
        return;
      }
      bufferedBodyBytes += c.length;
      held += c.length;
      chunks.push(c);
    });
    req.on('error', e => console.error(`:${port} client req error: ${e.message}`));
    res.on('error', e => console.error(`:${port} client res error: ${e.message}`));
    // Client left before the response finished: stop retries and abort upstream.
    // Use res 'close' (req 'close' fires as soon as the request body is read).
    const link = { closed: false, proxyReq: null, proxyRes: null, wake: null };
    let resClosed = false;
    res.on('close', () => {
      resClosed = true;
      releaseBudget();
      if (res.writableFinished) return;
      link.closed = true;
      link.wake?.();
      link.proxyRes?.destroy();
      link.proxyReq?.destroy();
    });
    req.on('end', () => {
      if (overflowed) return;
      const inBuf = Buffer.concat(chunks);
      chunks = [];
      let result;
      try { result = transformBody(inBuf, req.url); }
      catch (e) {
        // The proxy is only an optimisation layer: send the original bytes on.
        console.error(`:${port} transform-error passthrough: ${e.message}`);
        result = { outBuf: inBuf, applied: [], reject: null, originalTools: null };
      }
      const { outBuf, applied, reject, originalTools } = result;
      const changed = applied.length > 0;

      // A transformed request also holds its re-serialized copy until the response closes.
      if (outBuf !== inBuf && !resClosed) {
        if (MAX_BUFFERED_BODY_BYTES > 0 && bufferedBodyBytes + outBuf.length > MAX_BUFFERED_BODY_BYTES) {
          console.warn(`:${port} 503 buffer budget ${MAX_BUFFERED_BODY_BYTES} exhausted by transformed body of ${outBuf.length} bytes ${req.url}`);
          rejectBody(503, 'overloaded_error', budgetMessage);
          return;
        }
        bufferedBodyBytes += outBuf.length;
        held += outBuf.length;
      }

      if (reject) {
        const errBody = JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: `model: ${reject.model}` },
        });
        res.writeHead(404, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(errBody)) });
        res.end(errBody);
        const totalMs = Date.now() - startMs;
        if (LOG_REQUESTS) {
          const tag = id ? `[${id}] ` : '';
          console.log(`${tag}:${port} ${req.method} ${req.url} 404 ${totalMs}ms xform=[${applied.join(',')}]`);
        }
        if (CAPTURE_DIR) writeCapture(id, startMs, req, port, inBuf, outBuf, applied, 404, totalMs, totalMs, null, originalTools);
        return;
      }

      const outHeaders = { ...req.headers };
      if (port === FREELLMAPI_PORT && FREELLMAPI_KEY) {
        // The key belongs to the proxy boundary; never trust or forward a
        // caller-supplied credential from an agent sandbox.
        outHeaders.authorization = `Bearer ${FREELLMAPI_KEY}`;
        outHeaders['x-api-key'] = FREELLMAPI_KEY;
      }
      if (port === OLLAMA_PORT) {
        // Ollama itself does not require auth, but clients such as Claude Code
        // require a credential to be configured. Keep that plumbing at the
        // proxy boundary instead of repeating it in every connection.
        outHeaders.authorization = `Bearer ${OLLAMA_API_KEY}`;
        outHeaders['x-api-key'] = OLLAMA_API_KEY;
      }
      if (changed) {
        outHeaders['content-length'] = String(outBuf.length);
        delete outHeaders['transfer-encoding'];
      }

      forwardUpstreamWithRetry(port, req, res, outHeaders, outBuf, {
        id, startMs, inBuf: CAPTURE_DIR ? inBuf : null, outBuf, applied, changed, originalTools, link,
      }).catch(e => {
        console.error(`:${port} proxy error: ${e.message}`);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end(`bad gateway: ${e.message}`);
        }
      });
    });
  };
}

function startProxy() {
  if (!FREELLMAPI_KEY) {
    console.warn('freellmapi: no API key found; port 3001 requests will be unauthenticated');
  }
  loadProfiles();
  process.on('SIGHUP', () => {
    console.log('tool_profiles: SIGHUP — reloading');
    loadProfiles();
  });

  // Auto-reload on file change. fs.watch can fire multiple events for a single
  // edit (and editors that do atomic-rename invalidate the inode), so debounce
  // and re-establish the watcher on each fire.
  let reloadTimer = null;
  let watcher = null;
  function startWatcher() {
    try { watcher?.close(); } catch { }
    try {
      watcher = fsWatch(TOOL_PROFILES_PATH, () => {
        if (reloadTimer) return;
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          console.log('tool_profiles: file changed — reloading');
          loadProfiles();
          startWatcher(); // re-attach after atomic-rename writes
        }, 150);
      });
      watcher.on('error', e => console.error(`tool_profiles: watch error (${e.message}) — falling back to SIGHUP-only`));
    } catch (e) {
      console.error(`tool_profiles: watch unavailable (${e.message}) — SIGHUP still works`);
    }
  }
  startWatcher();
  process.on('uncaughtException', (e) => {
    console.error(`uncaughtException: ${e?.stack || e}`);
  });
  process.on('unhandledRejection', (e) => {
    console.error(`unhandledRejection: ${e?.stack || e}`);
  });

  const servers = [];
  const onTerm = () => drainAndExit(tracker, servers, { name: 'llama-proxy' });
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);

  for (const port of PORTS) {
    const server = http.createServer(makeHandler(port));
    servers.push(server);
    server.on('clientError', (e, socket) => {
      console.error(`:${port} clientError: ${e?.message}`);
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { }
    });
    server.on('error', e => console.error(`:${port} server error: ${e?.message}`));
    server.listen(port, () => {
      const cap = CAPTURE_DIR ? `  [DEBUG: capturing to ${CAPTURE_DIR}]` : '';
      console.log(`llama-proxy listening :${port} → ${UPSTREAM_HOST}:${port}${cap}`);
    });
  }
}

export {
  startProxy,
  makeHandler,
  loadProfiles,
  asAnthropicSystemBlocks,
  hoistAnthropicSystemMessages,
  hoistOpenAISystemMessages,
  hoistOpenAIResponsesSystemMessages,
  isOpenAIChatCompletionsPath,
  isOpenAIResponsesPath,
  isAnthropicMessagesPath,
  stripAnthropicBillingHeader,
  transformBody,
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startProxy();
