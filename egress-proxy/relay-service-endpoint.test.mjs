import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandServiceEndpoint, readRelayConfigs } from './api-relay/api-relay.mjs';

test('service endpoints expand environment settings with defaults', () => {
  const config = { host: '${CARAPA_BOARD_HOST:-host.docker.internal}', port: '${CARAPA_BOARD_PORT:-3000}', protocol: '${CARAPA_BOARD_PROTOCOL:-}', auth: 'apikey' };
  assert.deepEqual(expandServiceEndpoint(config, {}), { host: 'host.docker.internal', port: 3000, auth: 'apikey' });
  assert.deepEqual(expandServiceEndpoint(config, { CARAPA_BOARD_HOST: 'hub.lan', CARAPA_BOARD_PORT: '8443', CARAPA_BOARD_PROTOCOL: 'https' }),
    { host: 'hub.lan', port: 8443, protocol: 'https', auth: 'apikey' });
  assert.throws(() => expandServiceEndpoint({ port: '${P:-nope}', auth: 'none' }, {}), /port/);
  assert.throws(() => expandServiceEndpoint({ protocol: 'ftp', auth: 'none' }, {}), /protocol/);
});

test('shipped carapa-bot client keeps its previous Board endpoint by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-clients-'));
  try {
    fs.copyFileSync(new URL('./relay-clients/carapa-bot.json', import.meta.url), path.join(dir, 'carapa-bot.json'));
    const { clients } = readRelayConfigs(dir, {});
    assert.deepEqual(clients[0].services['board-api'], { host: 'host.docker.internal', port: 3000, auth: 'apikey' });
    assert.equal(readRelayConfigs(dir, { CARAPA_BOARD_HOST: 'hub' }).clients[0].services['mcp-relay'].host, 'hub');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
