import { afterAll, expect, test } from 'bun:test';
import { carapaMailMcpServers } from './carapa-mail';

// Stands in for api-relay + carapa-mail: 200 when the relay injected a working token.
const relay = Bun.serve({
  port: 0,
  fetch: (request) => new Response('{}', { status: new URL(request.url).pathname === '/enabled/mcp' ? 200 : 401 }),
});
afterAll(() => relay.stop(true));

test('Carapa-Mail tools are exposed only when the relay accepts the project token', async () => {
  const enabled = `http://127.0.0.1:${relay.port}/enabled/mcp`;
  expect(await carapaMailMcpServers(enabled)).toEqual([{ name: 'carapa-mail', url: enabled }]);
  expect(await carapaMailMcpServers(`http://127.0.0.1:${relay.port}/disabled/mcp`)).toEqual([]);
  relay.stop(true);
  expect(await carapaMailMcpServers(enabled)).toEqual([]);
});
