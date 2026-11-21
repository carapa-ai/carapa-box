import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEgressDeployDrift, getEgressDeployDrift } from './egress-drift.js';

const CHECKOUT_COMPOSE = `
services:
  api-relay:
    environment:
      - RELAY_SQUID_CONF=/app/squid-generated.conf
      - KEEP
    volumes:
      - \${CARAPA_BOX_STATE_HOST_DIR:-\${STACK_DIR:-.}/../generated}/squid-generated.conf:/app/squid-generated.conf:ro
      - \${EGRESS_SOURCE_DIR:-.}/api-relay:/app/api-relay:ro
  llama-proxy:
    environment:
      LLAMA_UPSTREAM: http://x
    volumes:
      - type: bind
        source: ./llama-proxy.mjs
        target: /app/llama-proxy.mjs
  squid:
    volumes:
      - ./squid.conf:/etc/squid/squid.conf:ro
`;

describe('checkEgressDeployDrift', () => {
    let root: string;
    let checkoutDir: string;
    let deployDir: string;
    let warnings: string[];

    const write = (dir: string, content: string) => fs.writeFileSync(path.join(dir, 'docker-compose.yml'), content);
    const check = (egressDir = deployDir, codeDir = checkoutDir) =>
        checkEgressDeployDrift({ egressDir, codeDir, warn: message => warnings.push(message) });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-drift-'));
        checkoutDir = path.join(root, 'checkout');
        deployDir = path.join(root, 'deploy');
        fs.mkdirSync(checkoutDir);
        fs.mkdirSync(deployDir);
        warnings = [];
        write(checkoutDir, CHECKOUT_COMPOSE);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reports a missing volume target and a missing env key, once per service', async () => {
        write(deployDir, `
services:
  api-relay:
    environment:
      KEEP: "1"
    volumes:
      - /private/api-relay:/app/api-relay:ro
  llama-proxy:
    environment:
      LLAMA_UPSTREAM: http://x
    volumes:
      - /private/llama-proxy.mjs:/app/llama-proxy.mjs
  squid:
    volumes:
      - /private/squid.conf:/etc/squid/squid.conf:ro
`);
        const drift = await check();
        expect(drift).toEqual({
            'api-relay': { missing_service: false, volumes: ['/app/squid-generated.conf'], env: ['RELAY_SQUID_CONF'] },
        });
        expect(getEgressDeployDrift()).toEqual(drift);
        expect(warnings).toEqual([
            '[EGRESS] deploy compose drift: api-relay missing volume /app/squid-generated.conf; missing env RELAY_SQUID_CONF',
        ]);
    });

    test('ignores differing host sources and extras in the deploy copy', async () => {
        write(deployDir, `
services:
  api-relay:
    environment:
      - RELAY_SQUID_CONF=/other
      - KEEP=1
      - EXTRA=1
    volumes:
      - /private/generated/squid-generated.conf:/app/squid-generated.conf:ro
      - /private/api-relay:/app/api-relay:ro
      - /private/extra:/app/extra
  llama-proxy:
    environment:
      - LLAMA_UPSTREAM=http://y
    volumes:
      - /private/llama-proxy.mjs:/app/llama-proxy.mjs
  squid:
    volumes:
      - /private/squid.conf:/etc/squid/squid.conf:ro
  extra-service:
    image: x
`);
        expect(await check()).toEqual({});
        expect(warnings).toEqual([]);
    });

    test('reports a service missing from the deploy copy', async () => {
        write(deployDir, `
services:
  api-relay:
    environment: [RELAY_SQUID_CONF, KEEP]
    volumes: ["/p/a:/app/squid-generated.conf", "/p/b:/app/api-relay"]
  squid:
    volumes: ["/p/s:/etc/squid/squid.conf"]
`);
        expect(await check()).toEqual({ 'llama-proxy': { missing_service: true, volumes: [], env: [] } });
        expect(warnings).toEqual(['[EGRESS] deploy compose drift: llama-proxy missing from deploy compose']);
    });

    test('warns without throwing when a file is unparsable or missing', async () => {
        write(deployDir, 'services: [unclosed');
        expect(await check()).toEqual({});
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('deploy compose drift check skipped');

        fs.rmSync(path.join(deployDir, 'docker-compose.yml'));
        warnings = [];
        expect(await check()).toEqual({});
        expect(warnings).toHaveLength(1);
    });

    test('does not compare when there is no separate deploy dir', async () => {
        write(deployDir, 'services: {}');
        expect(await check(checkoutDir, checkoutDir)).toEqual({});
        expect(getEgressDeployDrift()).toEqual({});
        expect(warnings).toEqual([]);
    });
});
