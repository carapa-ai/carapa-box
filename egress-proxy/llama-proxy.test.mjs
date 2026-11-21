import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { transformBody } from './llama-proxy.mjs';
import { spawnHarness } from './drain-test-helpers.mjs';

function transform(body, url = '/v1/messages') {
  const input = Buffer.from(JSON.stringify(body));
  const result = transformBody(input, url);
  return { ...result, body: JSON.parse(result.outBuf.toString('utf8')) };
}

test('hoists system and developer messages into Anthropic system blocks', () => {
  const result = transform({
    model: 'qwen3.8',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cch=volatile' },
      { type: 'text', text: 'Existing system', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: 'First question' },
      { role: 'developer', content: 'Developer guidance' },
      { role: 'assistant', content: 'First answer' },
      { role: 'system', content: [{ type: 'text', text: 'Late system guidance' }] },
      { role: 'user', content: 'Second question' },
    ],
  });

  assert.deepEqual(result.body.messages, [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second question' },
  ]);
  assert.deepEqual(result.body.system, [
    { type: 'text', text: 'Existing system', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Developer guidance' },
    { type: 'text', text: 'Late system guidance' },
  ]);
  assert.ok(result.applied.includes('hoist-system-messages(-2,blocks=2)'));
  assert.ok(result.applied.includes('strip-billing-header(-1)'));
});

test('normalizes a string system prompt before appending extracted messages', () => {
  const result = transform({
    model: 'qwen3.8',
    system: 'Existing system',
    messages: [
      { role: 'system', content: 'Embedded system' },
      { role: 'user', content: 'Hello' },
    ],
  });

  assert.deepEqual(result.body.system, [
    { type: 'text', text: 'Existing system' },
    { type: 'text', text: 'Embedded system' },
  ]);
  assert.deepEqual(result.body.messages, [{ role: 'user', content: 'Hello' }]);
});

test('hoists late system messages but preserves developer messages in OpenAI chat completions', () => {
  const body = {
    model: 'qwen3.8',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'developer', content: 'OpenAI developer guidance' },
      { role: 'system', content: 'OpenAI system guidance' },
    ],
  };
  const result = transform(body, '/v1/chat/completions');

  assert.deepEqual(result.body.messages, [
    { role: 'system', content: 'OpenAI system guidance' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'developer', content: 'OpenAI developer guidance' },
  ]);
  assert.deepEqual(result.applied, ['hoist-openai-system-messages(-1,conversation=3)']);
});

test('leaves a single already-leading OpenAI system message unchanged', () => {
  const body = {
    model: 'qwen3.8',
    messages: [
      { role: 'system', content: 'OpenAI system' },
      { role: 'user', content: 'Hello' },
    ],
  };
  const result = transform(body, '/v1/chat/completions');

  assert.deepEqual(result.body, body);
  assert.deepEqual(result.applied, []);
});

test('preserves a leading developer message', () => {
  const result = transform({
    model: 'qwen3.8',
    messages: [
      { role: 'developer', content: 'Developer guidance' },
      { role: 'user', content: 'Hello' },
    ],
  }, '/v1/chat/completions');

  assert.deepEqual(result.body.messages, [
    { role: 'developer', content: 'Developer guidance' },
    { role: 'user', content: 'Hello' },
  ]);
  assert.deepEqual(result.applied, []);
});

test('hoists late Responses system and developer guidance into instructions in order', () => {
  const result = transform({
    model: 'qwen3.8',
    instructions: 'Base instructions',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer guidance' }] },
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Late system guidance' }] },
    ],
  }, '/v1/responses');

  assert.equal(result.body.instructions,
    'Base instructions\n\nDeveloper guidance\n\nLate system guidance');
  assert.deepEqual(result.body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
  ]);
  assert.deepEqual(result.applied, ['hoist-openai-responses-system-messages(-2,input=1)']);
});

test('leaves a single leading Responses system item unchanged without instructions', () => {
  const body = {
    model: 'qwen3.8',
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'System' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ],
  };
  const result = transform(body, '/v1/responses');

  assert.deepEqual(result.body, body);
  assert.deepEqual(result.applied, []);
});

test('does not hoist messages on unrelated endpoints', () => {
  const body = {
    model: 'qwen3.8',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Unrelated system' },
    ],
  };
  const result = transform(body, '/api/chat');

  assert.deepEqual(result.body, body);
  assert.deepEqual(result.applied, []);
});

test('matches /v1/messages with a query string', () => {
  const result = transform({
    model: 'qwen3.8',
    messages: [
      { role: 'developer', content: ['One', { type: 'text', text: 'Two' }] },
      { role: 'user', content: 'Hello' },
    ],
  }, '/v1/messages?beta=true');

  assert.deepEqual(result.body.system, [
    { type: 'text', text: 'One' },
    { type: 'text', text: 'Two' },
  ]);
  assert.deepEqual(result.body.messages, [{ role: 'user', content: 'Hello' }]);
});

// PORTS is read at module load, so the real startProxy() runs in a child
// process (bound to 127.0.0.1; the stub upstream sits on 127.0.0.2, same port).
const HARNESS = String.raw`
import http from 'node:http';
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, cb) { return origListen.call(this, port, '127.0.0.1', cb); };
const { startProxy } = await import(${JSON.stringify(new URL('./llama-proxy.mjs', import.meta.url).href)});
startProxy();
setTimeout(() => console.log('READY ' + process.env.PORTS), 300);
`;

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { host: `127.0.0.2:${port}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('no response within 2s')));
    req.on('error', reject);
    // Node frames a body only for POST/PUT/PATCH; on other methods it would be read as a second request.
    req.end(['POST', 'PUT', 'PATCH'].includes(method) ? '{"model":"evil.example/ns/model"}' : undefined);
  });
}

test('refuses Docker Model Runner management calls but forwards listings and inference', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"stub":true}');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.2', r));
  const h = spawnHarness(HARNESS, {
    PORTS: String(upstream.address().port), UPSTREAM_HOST: '127.0.0.2',
    NO_PROXY: '*', no_proxy: '*', TOOL_PROFILES_PATH: '/nonexistent/tool_profiles.jsonc',
    // Never inherit debug capture: it would write request bodies into CAPTURE_DIR.
    LLAMA_DEBUG: '', LOG_REQUESTS: '',
    // Pin the body limits to the proxy defaults so ambient settings cannot cause a 413/503.
    MAX_BODY_BYTES: String(32 * 1024 * 1024), MAX_BUFFERED_BODY_BYTES: String(48 * 1024 * 1024),
  });
  try {
    const port = await h.ready();
    const blocked = [
      ['POST', '/models/create'], ['DELETE', '/models/ai/smollm2'],
      ['POST', '/models/ai/smollm2/tag'], ['POST', '/models/ai/smollm2/push'],
      ['DELETE', '/models'], ['DELETE', '/models/purge'], ['DELETE', '/models/PURGE/'], ['POST', '/models/package'],
      ['POST', '/models/load'], ['OPTIONS', '/models/create'], ['OPTIONS', '/models'],
      ['OPTIONS', '/v1/models/create'], ['OPTIONS', '/engines/v1/models/create'],
      ['OPTIONS', '/engines/llama.cpp/models/create'], ['OPTIONS', '/engines/llama.cpp/models/ai/smollm2/tag'],
      ['OPTIONS', '/engines/v1/models/ai/smollm2'], ['OPTIONS', '/v1/models/../models/create'],
      ['POST', '/models/ai/smollm2/TAG'], ['POST', '/models/ai/smollm2/%74ag'], ['POST', '/models/ai/x/../smollm2/tag'],
      ['POST', '/MODELS/ai/smollm2/Push'], ['POST', '/models/ai/smollm2/pu%73h'], ['POST', '/models/ai/smollm2/./push/'],
      ['POST', '/models/ai/smollm2%2Fpush'], ['DELETE', '/models/%70urge'], ['DELETE', '/models/x/../purge'],
      ['DELETE', '/Models/Purge'], ['DELETE', '/models%2fpurge'],
      ['PUT', '/models/ai/smollm2'], ['PATCH', '/models/ai/smollm2'],
      ['POST', '/MODELS/Create'], ['POST', '/models/create/'], ['POST', '/models/create?x=1'],
      ['POST', '/%6dodels/create'], ['POST', '/models%2fcreate'], ['POST', '/models%252fcreate'],
      ['POST', '//models//create'], ['POST', '/models/./create'], ['POST', '/x/../models/create'],
      ['POST', '/v1/../models/create'], ['POST', '/models/ai/x/%2e%2e/create'],
      ['POST', 'http://evil.example/models/create'], ['POST', '/models\\create'],
      ['POST', '/engines/llama.cpp/models/create'], ['DELETE', '/engines/v1/models/ai/smollm2'],
      ['POST', '/engines/llama.cpp/v1/models/create'], ['POST', '/ENGINES/llama.cpp/V1/Models/Create'],
      ['POST', '/engines/llama.cpp/%2e%2e/vllm/models/create'], ['POST', '/v1/models/create'],
    ];
    blocked.push(
      ['GET', '/models/evil.example/ns/model?remote=true'], ['GET', '/models/ai/smollm2?remote=1'],
      ['GET', '/models/ai/smollm2?remote'], ['GET', '/models/ai/smollm2?remote='],
      ['GET', '/models/ai/smollm2?remote=false&remote=true'], ['GET', '/models/ai/smollm2?remote=true&remote=false'],
      ['GET', '/models/ai/smollm2?remote=maybe'], ['GET', '/models/ai/smollm2?remote=%zz'],
      ['GET', '/models/ai/smollm2?x=1&REMOTE=true'], ['GET', '/models/ai/smollm2?%72emote=true'],
      ['GET', '/models/ai/smollm2?%2572emote=true'], ['GET', '/models/ai/smollm2?x=1;remote=true'],
      ['GET', '/MODELS/ai/smollm2?remote=true'],
      ['GET', '/models/ai/smollm2?%zz=1'],
      ['GET', '/models/ai/smollm2/export'], ['GET', '/models/ai/smollm2/export/'],
      ['GET', '/MODELS/ai/smollm2/Export'], ['GET', '/models/ai/smollm2/%65xport'],
      ['GET', '/models/ai/smollm2%2fexport'], ['GET', '/models/ai/x/../smollm2/export'],
      ['GET', '/models/ai/smollm2/export?x=1'], ['GET', '/models/ai/smollm2//export'],
      ['GET', '/models/hf.co/org/model/export'],
    );
    for (const [method, path] of blocked) {
      const r = await request(port, method, path);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.match(r.body, /blocked/, `${method} ${path}`);
    }
    assert.deepEqual(received, [], 'blocked requests must not reach the upstream');

    const allowed = [
      ['GET', '/models'], ['GET', '/models/ai/smollm2'], ['GET', '/v1/models'],
      ['GET', '/models/ai/smollm2?foo=remote'], ['GET', '/models/ai/exporter'], ['GET', '/models/export/smollm2'],
      ['GET', '/engines/v1/models/export/smollm2'], ['GET', '/engines/v1/models/ai/export'],
      ['GET', '/engines/v1/models/ai/smollm2/export'], ['GET', '/engines/llama.cpp/v1/models/ai/smollm2?remote=true'],
      ['GET', '/models/hf.co/org/model'], ['GET', '/models?limit=1'], ['GET', '/models?remote=true'],
      ['GET', '/models/ai/smollm2?remote=false'], ['GET', '/models/ai/smollm2?remote=0'], ['GET', '/models/ai/smollm2?remote=FALSE'],
      ['OPTIONS', '/v1/models'], ['OPTIONS', '/engines/llama.cpp/v1/models'], ['OPTIONS', '/engines/v1/models'],
      ['GET', '/engines/v1/models'], ['GET', '/engines/llama.cpp/v1/models'],
      ['POST', '/v1/chat/completions'], ['POST', '/engines/llama.cpp/v1/chat/completions'],
      ['POST', '/engines/v1/chat/completions'], ['POST', '/modelsx/create'],
    ];
    for (const [method, path] of allowed) {
      assert.equal((await request(port, method, path)).status, 200, `${method} ${path}`);
    }
    assert.deepEqual(received, allowed.map(([m, p]) => `${m} ${p}`));
  } finally {
    h.child.kill('SIGKILL');
    await h.exited;
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('refuses Ollama model-management paths without reaching the upstream', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"stub":true}');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.2', r));
  // Port 11434 is Ollama; the stub's random port stands in for any other port.
  const h = spawnHarness(HARNESS, {
    PORTS: String(upstream.address().port), UPSTREAM_HOST: '127.0.0.2',
    NO_PROXY: '*', no_proxy: '*', TOOL_PROFILES_PATH: '/nonexistent/tool_profiles.jsonc',
  });
  try {
    const port = await h.ready();
    const blocked = [
      '/api/pull', '/api/push', '/api/create', '/api/copy', '/api/delete',
      '/api/blobs', '/api/blobs/sha256:abc',
      '/api/pull/', '/API/PULL', '/api/pull?x=1', '/api%2Fpull', '/api%2fPuLl', '/%61pi/pull',
      '//api/pull', '/api//pull', '/api/./pull', '/x/../api/push', '/api/%2e%2e/api/delete',
      '/api%252Fpull', 'http://evil.example/api/pull', '/api\\pull', '/api/blobs%2Fsha256:abc',
      '/api/%zz',
    ];
    for (const path of blocked) {
      const r = await request(port, 'POST', path);
      assert.equal(r.status, 403, path);
      assert.match(r.body, /blocked/, path);
    }
    assert.deepEqual(received, [], 'blocked requests must not reach the upstream');

    for (const path of ['/api/chat', '/api/tags', '/v1/chat/completions', '/api/pullover']) {
      assert.equal((await request(port, 'POST', path)).status, 200, path);
    }
    assert.deepEqual(received, ['/api/chat', '/api/tags', '/v1/chat/completions', '/api/pullover']);
  } finally {
    h.child.kill('SIGKILL');
    await h.exited;
    upstream.closeAllConnections();
    upstream.close();
  }
});
