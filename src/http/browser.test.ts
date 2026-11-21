import { afterAll, describe, expect, test } from 'bun:test';
import { createBrowserHandler, BROWSER_MAX_FRAME } from './browser.js';

const previousToken = process.env.CARAPA_BOX_API_TOKEN;
process.env.CARAPA_BOX_API_TOKEN = 'browser-test-token';
afterAll(() => { if (previousToken === undefined) delete process.env.CARAPA_BOX_API_TOKEN; else process.env.CARAPA_BOX_API_TOKEN = previousToken; });
const headers = { Authorization: 'Bearer browser-test-token', 'Content-Type': 'application/json' };
const target = { stack: 'carapa-bot', service: 'agent', instance: 'test', sessionId: 'run-test' };
function request(path: string, method = 'POST', body?: unknown, signal?: AbortSignal) {
  return new Request(`http://box/api/browser/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
}
describe('browser exec transport', () => {
  test('fails closed without the API credential and rejects invalid targets before exec', async () => {
    let opened = 0;
    const handle = createBrowserHandler({ open: async () => { opened++; throw new Error('unexpected exec'); } });
    expect((await handle(new Request('http://box/api/browser/attach', { method: 'POST' }))).status).toBe(401);
    expect((await handle(request('attach', 'POST', { ...target, sessionId: '../another-run' }))).status).toBe(400);
    expect(opened).toBe(0);
  });
  test('streams output, orders input, and disconnects only the owning bridge', async () => {
    const inputs: string[][] = [];
    const ended: number[] = [];
    let sequence = 0;
    const handle = createBrowserHandler({ open: async (_target, emit, finish) => {
      const index = sequence++;
      inputs[index] = [];
      emit('{"type":"ready"}\n');
      return { input: line => inputs[index].push(line), close() { ended.push(index); finish(); } };
    } });
    const first = await handle(request('attach', 'POST', target));
    const second = await handle(request('attach', 'POST', target));
    const reader = first.body!.getReader();
    const id = JSON.parse(new TextDecoder().decode((await reader.read()).value)).viewerId;
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    const messages = [JSON.stringify({ id: 1, method: 'keydown' }), JSON.stringify({ id: 2, method: 'keyup' })];
    expect((await handle(request(`${id}/input`, 'POST', messages))).status).toBe(200);
    expect(inputs[0].join('')).toBe(messages.join('\n') + '\n');
    await reader.cancel();
    expect(ended).toEqual([0]);
    expect((await handle(request(`${id}/input`, 'POST', messages))).status).toBe(410);
    await second.body!.cancel();
    expect(ended).toEqual([0, 1]);
  });
  test('cancels an attachment that completes after its caller disconnects', async () => {
    const abort = new AbortController();
    let closed = 0;
    const handle = createBrowserHandler({ open: async () => {
      abort.abort();
      return { input() {}, close() { closed++; } };
    } });
    const response = await handle(request('attach', 'POST', target, abort.signal));
    await response.body!.cancel();
    expect(closed).toBeGreaterThan(0);
  });
  test('terminates a slow consumer instead of accumulating unbounded frames', async () => {
    let ended = 0;
    const handle = createBrowserHandler({ open: async (_target, emit, finish) => {
      emit('x'.repeat(BROWSER_MAX_FRAME));
      emit('x'.repeat(BROWSER_MAX_FRAME));
      emit('x'.repeat(BROWSER_MAX_FRAME));
      return { input() {}, close() { ended++; finish(); } };
    } });
    const response = await handle(request('attach', 'POST', target));
    await response.body!.cancel();
    expect(ended).toBeGreaterThan(0);
  });
});

test('bounds request bodies while reading and never accepts caller-selected commands or addresses', async () => {
  let cancelled = false;
  let opened = 0;
  const handle = createBrowserHandler({ open: async () => { opened++; throw new Error('unexpected exec'); } });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(70 * 1024)); },
    cancel() { cancelled = true; },
  });
  const response = await handle(new Request('http://box/api/browser/attach', {
    method: 'POST', headers, body, duplex: 'half',
  } as RequestInit));
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect((await handle(request('attach', 'POST', { ...target, instance: 123 }))).status).toBe(400);
  expect((await handle(request('attach', 'POST', { ...target, sessionId: 'run; curl http://other' }))).status).toBe(400);
  expect(opened).toBe(0);
});
