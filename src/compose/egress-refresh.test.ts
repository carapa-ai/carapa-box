import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore -- plain Node module shared with the standalone relay
import { relayCodeHash } from '../../egress-proxy/api-relay/api-relay.mjs';
import {
    EGRESS_DEFINITION_LABEL, EGRESS_HASH_LABEL, RELAY_CODE_DIR, computeEgressHashes, egressAutoRecreateEnabled, egressDefinitionHash,
    parseEgressStatus, parseRecordedDefinitionHashes, parseRecordedHashes,
    refreshEgressServices, servicesWithoutRunningContainer, startMissingEgressServices,
    type EgressRefreshDeps,
} from './egress-refresh.js';

function harness(over: Partial<EgressRefreshDeps> = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps: EgressRefreshDeps = {
        enabled: true,
        hashes: { 'api-relay': 'new-a', 'llama-proxy': 'new-l' },
        // api-relay's label goes stale after in-place reloads; only its reported codeHash counts.
        recorded: { 'api-relay': 'stale-label', 'llama-proxy': 'new-l' },
        recordedDefinitions: { 'api-relay': 'def-a', 'llama-proxy': 'def-l', squid: 'def-s' },
        definitionHash: async service => ({ 'api-relay': 'def-a', 'llama-proxy': 'def-l', squid: 'def-s' })[service] ?? null,
        warn: m => logs.push(`warn:${m}`),
        recreate: async service => { calls.push(`recreate:${service}`); },
        reload: async service => { calls.push(`reload:${service}`); },
        reconnectNetworks: async () => { calls.push('reconnect'); },
        log: m => logs.push(m),
        status: async service => (service === 'api-relay' ? { inflight: 2, codeHash: 'new-a' } : { inflight: 0 }),
        ...over,
    };
    return { deps, calls, logs };
}

function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('refreshEgressServices', () => {
    test('current code runs no docker command, even with a stale api-relay label', async () => {
        const { deps, calls } = harness();
        expect(await refreshEgressServices(deps)).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('changed llama-proxy file recreates only it, then reconnects networks', async () => {
        const { deps, calls, logs } = harness({ recorded: { 'api-relay': 'x', 'llama-proxy': 'old' } });
        expect(await refreshEgressServices(deps)).toEqual(['llama-proxy']);
        expect(calls).toEqual(['recreate:llama-proxy', 'reconnect']);
        expect(logs).toEqual(['[EGRESS] recreated llama-proxy (code hash changed)']);
    });

    test('opt-out flag disables the refresh', async () => {
        const { deps, calls } = harness({
            enabled: egressAutoRecreateEnabled({ EGRESS_AUTO_RECREATE: '0' }),
            recorded: { 'api-relay': 'x', 'llama-proxy': 'old' },
            status: async () => ({ inflight: 0, codeHash: 'old-a' }),
        });
        expect(await refreshEgressServices(deps)).toEqual([]);
        expect(calls).toEqual([]);
        expect(egressAutoRecreateEnabled({})).toBe(true);
    });

    test('missing recorded hash is treated as changed', async () => {
        const ps = JSON.stringify([{ Service: 'llama-proxy', State: 'running', Labels: 'a=b' }]);
        const recorded = parseRecordedHashes(ps);
        expect(recorded).toEqual({ 'llama-proxy': '' });
        const { deps, calls } = harness({ recorded });
        expect(await refreshEgressServices(deps)).toEqual(['llama-proxy']);
        expect(calls).toEqual(['recreate:llama-proxy', 'reconnect']);
    });
});

// A recreate refuses every agent request while the old relay drains; a reload never does.
describe('api-relay in-place reload', () => {
    test('stale relay code is reloaded with SIGHUP, never recreated or detached from networks', async () => {
        let served = 'old-a';
        const { deps, calls, logs } = harness({
            ...clock(),
            status: async () => ({ inflight: 3, codeHash: served }),
            reload: async service => { calls.push(`reload:${service}`); served = 'new-a'; },
        });
        expect(await refreshEgressServices(deps)).toEqual(['api-relay']);
        expect(calls).toEqual(['reload:api-relay']);
        expect(logs).toEqual(['[EGRESS] reloaded api-relay in place (code hash changed)']);
    });

    test('a relay that keeps the previous code is reported, not recreated', async () => {
        const { deps, calls, logs } = harness({ ...clock(), status: async () => ({ inflight: 0, codeHash: 'old-a' }) });
        expect(await refreshEgressServices(deps)).toEqual([]);
        expect(calls).toEqual(['reload:api-relay']);
        expect(logs).toEqual(['[EGRESS] api-relay did not load the new code within 60s; the previous code keeps serving (see its log)']);
    });

    test('a relay without a code hash gets no SIGHUP, which would kill a relay without the supervisor', async () => {
        for (const status of [async () => ({ inflight: 1 }), async () => null]) {
            const { deps, calls, logs } = harness({ status });
            expect(await refreshEgressServices(deps)).toEqual([]);
            expect(calls).toEqual([]);
            expect(logs[0]).toContain('api-relay reports no code hash');
        }
    });
});

describe('compose definition changes', () => {
    test('a changed api-relay definition recreates it with the current code hash and never SIGHUPs it', async () => {
        const envs: Record<string, string>[] = [];
        const lookups: Record<string, string>[] = [];
        const { deps, calls, logs } = harness({
            // The relay serves older code too: a code change must not turn this into a reload.
            status: async () => ({ inflight: 0, codeHash: 'old-a' }),
            definitionHash: async (service, env) => { lookups.push(env); return service === 'api-relay' ? 'def-a2' : `def-${service === 'squid' ? 's' : 'l'}`; },
            recreate: async (service, env) => { calls.push(`recreate:${service}`); envs.push(env); },
        });
        expect(await refreshEgressServices(deps)).toEqual(['api-relay']);
        expect(calls).toEqual(['recreate:api-relay', 'reconnect']);
        expect(envs[0]).toEqual({ EGRESS_CODE_HASH_API_RELAY: 'new-a', EGRESS_CODE_HASH_LLAMA_PROXY: 'new-l' });
        // The definition is hashed with the code hashes the containers were created with.
        expect(lookups[0]).toEqual({ EGRESS_CODE_HASH_API_RELAY: 'stale-label', EGRESS_CODE_HASH_LLAMA_PROXY: 'new-l' });
        expect(logs).toEqual(['[EGRESS] recreated api-relay (compose definition changed)']);
    });

    test('a changed squid definition recreates squid without waiting', async () => {
        const { deps, calls, logs } = harness({
            recorded: { 'api-relay': 'x', 'llama-proxy': 'new-l', squid: '' },
            definitionHash: async service => (service === 'squid' ? 'def-s2' : service === 'api-relay' ? 'def-a' : 'def-l'),
        });
        expect(await refreshEgressServices(deps)).toEqual(['squid']);
        expect(calls).toEqual(['recreate:squid', 'reconnect']);
        expect(logs).toEqual(['[EGRESS] recreated squid (compose definition changed)']);
    });

    test('a code-only api-relay change reloads in place: the definition is hashed with the recorded code hash', async () => {
        let served = 'old-a';
        const lookups: string[] = [];
        const { deps, calls } = harness({
            ...clock(),
            recordedDefinitions: { 'api-relay': 'def:stale-label', 'llama-proxy': 'def-l', squid: 'def-s' },
            // Like compose: the code-hash label is part of the definition.
            definitionHash: async (service, env) => {
                lookups.push(`${service}:${env.EGRESS_CODE_HASH_API_RELAY}`);
                return service === 'api-relay' ? `def:${env.EGRESS_CODE_HASH_API_RELAY}` : service === 'squid' ? 'def-s' : 'def-l';
            },
            status: async () => ({ inflight: 0, codeHash: served }),
            reload: async service => { calls.push(`reload:${service}`); served = 'new-a'; },
        });
        expect(await refreshEgressServices(deps)).toEqual(['api-relay']);
        expect(lookups).toContain('api-relay:stale-label');
        expect(lookups).not.toContain('api-relay:new-a');
        expect(calls).toEqual(['reload:api-relay']);
    });

    test('an unavailable definition hash warns per service and keeps the code-hash behaviour', async () => {
        for (const over of [
            { definitionHash: async () => null },
            { definitionHash: async () => { throw new Error('compose failed'); } },
            { recordedDefinitions: {} },
        ] as Partial<EgressRefreshDeps>[]) {
            const { deps, calls, logs } = harness({ ...over, recorded: { 'api-relay': 'x', 'llama-proxy': 'old' }, ...clock(), status: async () => ({ inflight: 0, codeHash: 'old-a' }) });
            await refreshEgressServices(deps);
            expect(calls).toEqual(['reload:api-relay', 'recreate:llama-proxy', 'reconnect']);
            const warns = logs.filter(l => l.startsWith('warn:'));
            expect(warns.length).toBe(2);
            expect(warns[0]).toContain('[EGRESS] compose definition hash unavailable for api-relay;');
            expect(warns[1]).toContain('definition hash unavailable for llama-proxy;');
        }
    });

    test('the definition hash follows the rendered service, not its own label or key order', () => {
        const model = (service: object) => JSON.stringify({ services: { 'api-relay': service, squid: { image: 'x' } } });
        const base = { image: 'r', volumes: [{ type: 'bind', source: '/a', target: '/app/a' }], labels: { 'carapa.egress.code-hash': 'c' } };
        const hash = egressDefinitionHash(model(base), 'api-relay');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(egressDefinitionHash(model({ labels: { [EGRESS_DEFINITION_LABEL]: 'self', 'carapa.egress.code-hash': 'c' }, volumes: base.volumes, image: 'r' }), 'api-relay')).toBe(hash);
        const moreVolumes = { ...base, volumes: [...base.volumes, { type: 'bind', source: '/b', target: '/app/b' }] };
        expect(egressDefinitionHash(model(moreVolumes), 'api-relay')).not.toBe(hash);
        expect(egressDefinitionHash(model({ ...base, labels: { 'carapa.egress.code-hash': 'd' } }), 'api-relay')).not.toBe(hash);
        expect(egressDefinitionHash(model(base), 'llama-proxy')).toBeNull();
        expect(egressDefinitionHash('error: boom', 'api-relay')).toBeNull();
    });

    test('parses the definition label from ps output', () => {
        const ps = JSON.stringify([{ Service: 'squid', State: 'running', Labels: `a=b,${EGRESS_DEFINITION_LABEL}=abc123` }, { Service: 'api-relay', State: 'running', Labels: '' }]);
        expect(parseRecordedDefinitionHashes(ps)).toEqual({ squid: 'abc123', 'api-relay': '' });
    });
});

describe('hashing and parsing', () => {
    test('a replaced relay file changes only the api-relay hash, as the running relay computes it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-hash-'));
        try {
            fs.mkdirSync(path.join(dir, RELAY_CODE_DIR));
            fs.writeFileSync(path.join(dir, RELAY_CODE_DIR, 'api-relay.mjs'), 'a');
            fs.writeFileSync(path.join(dir, 'llama-proxy.mjs'), 'l');
            const before = await computeEgressHashes(dir);
            fs.writeFileSync(path.join(dir, 'next.tmp'), 'b');
            fs.renameSync(path.join(dir, 'next.tmp'), path.join(dir, RELAY_CODE_DIR, 'api-relay.mjs'));
            const after = await computeEgressHashes(dir);
            expect(after['api-relay']).not.toBe(before['api-relay']);
            expect(after['api-relay']).toBe(relayCodeHash(path.join(dir, RELAY_CODE_DIR)));
            expect(after['llama-proxy']).toBe(before['llama-proxy']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('parses NDJSON ps output and ignores non-running containers', () => {
        const ps = [
            { Service: 'api-relay', State: 'running', Labels: `x=y,${EGRESS_HASH_LABEL}=abc` },
            { Service: 'llama-proxy', State: 'exited', Labels: `${EGRESS_HASH_LABEL}=def` },
        ].map(e => JSON.stringify(e)).join('\n');
        expect(parseRecordedHashes(ps)).toEqual({ 'api-relay': 'abc' });
    });

    test('parses /_inflight bodies with and without a code hash', () => {
        expect(parseEgressStatus('{"inflight":2,"draining":false,"codeHash":"h"}\n')).toEqual({ inflight: 2, codeHash: 'h' });
        expect(parseEgressStatus('{"inflight":0,"draining":false}')).toEqual({ inflight: 0 });
        expect(parseEgressStatus('Forbidden')).toBeNull();
    });
});

describe('refreshEgressServices idle wait', () => {
    const stale = { recorded: { 'api-relay': 'x', 'llama-proxy': 'old' } };
    const relay = { inflight: 0, codeHash: 'new-a' };

    test('recreates only after inflight reports 0', async () => {
        const counts = [2, 1, 0];
        const { deps, calls } = harness({
            ...stale,
            ...clock(),
            status: async service => {
                if (service === 'api-relay') return relay;
                calls.push('inflight');
                return { inflight: counts.shift() ?? 0 };
            },
        });
        await refreshEgressServices(deps);
        expect(calls).toEqual(['inflight', 'inflight', 'inflight', 'recreate:llama-proxy', 'reconnect']);
    });

    test('null inflight recreates without waiting', async () => {
        let slept = 0;
        const { deps, calls } = harness({ ...stale, status: async s => (s === 'api-relay' ? relay : null), sleep: async () => { slept++; } });
        await refreshEgressServices(deps);
        expect(slept).toBe(0);
        expect(calls).toEqual(['recreate:llama-proxy', 'reconnect']);
    });

    test('always busy recreates after the limit and logs the warning', async () => {
        const { deps, calls, logs } = harness({ ...stale, ...clock(), idleWaitMs: 150_000, status: async s => (s === 'api-relay' ? relay : { inflight: 3 }) });
        await refreshEgressServices(deps);
        expect(calls).toEqual(['recreate:llama-proxy', 'reconnect']);
        expect(logs.filter(l => l.includes('waiting for llama-proxy to go idle (inflight=3)')).length).toBe(3);
        expect(logs).toContain('[EGRESS] llama-proxy still busy after 3m; recreating, its SIGTERM drain will finish the open requests');
    });

    test('EGRESS_AUTO_RECREATE=0 disables everything', async () => {
        let polled = false;
        const { deps, calls } = harness({ ...stale, enabled: false, status: async () => { polled = true; return { inflight: 1 }; } });
        expect(await refreshEgressServices(deps)).toEqual([]);
        expect(polled).toBe(false);
        expect(calls).toEqual([]);
    });

    test('refresh stays pending while a service is busy, so startup must not await it', async () => {
        const { deps, calls } = harness({
            ...stale,
            status: async s => (s === 'api-relay' ? relay : { inflight: 1 }),
            sleep: () => new Promise<void>(() => {}),
            now: () => 0,
        });
        let settled = false;
        void refreshEgressServices(deps).then(() => { settled = true; });
        await new Promise(r => setTimeout(r, 10));
        expect(settled).toBe(false);
        expect(calls).toEqual([]);
    });
});

describe('startMissingEgressServices', () => {
    const ps = (api: string) => [
        { Service: 'squid', State: 'running', Labels: '' },
        { Service: 'api-relay', State: api, Labels: `${EGRESS_HASH_LABEL}=old` },
        { Service: 'llama-proxy', State: 'running', Labels: `${EGRESS_HASH_LABEL}=new-l` },
    ].map(e => JSON.stringify(e)).join('\n');
    const hashes = { 'api-relay': 'new-a', 'llama-proxy': 'new-l' };

    function run(psOutput: string) {
        const calls: string[] = [];
        const logs: string[] = [];
        const envs: Record<string, string>[] = [];
        const promise = startMissingEgressServices({
            psOutput, hashes,
            start: async (service, env) => { calls.push(`up:${service}`); envs.push(env); },
            reconnectNetworks: async () => { calls.push('reconnect'); },
            log: m => logs.push(m),
        });
        return { promise, calls, logs, envs };
    }

    test('helper lists services without a running container', () => {
        expect(servicesWithoutRunningContainer(ps('exited'))).toEqual(['api-relay']);
        expect(servicesWithoutRunningContainer(ps('running'))).toEqual([]);
    });

    test('squid left stopped by an interrupted recreate is started', async () => {
        const psOut = [
            { Service: 'squid', State: 'exited', Labels: '' },
            { Service: 'api-relay', State: 'running', Labels: `${EGRESS_HASH_LABEL}=new-a` },
            { Service: 'llama-proxy', State: 'running', Labels: `${EGRESS_HASH_LABEL}=new-l` },
        ].map(e => JSON.stringify(e)).join('\n');
        const { promise, calls, logs } = run(psOut);
        expect(await promise).toEqual(['squid']);
        expect(calls).toEqual(['up:squid', 'reconnect']);
        expect(logs).toEqual(['[EGRESS] started squid (no running container)']);
    });

    test('exited api-relay is started alone with hash env, and logged', async () => {
        const { promise, calls, logs, envs } = run(ps('exited'));
        expect(await promise).toEqual(['api-relay']);
        expect(calls).toEqual(['up:api-relay', 'reconnect']);
        expect(envs[0]).toEqual({ EGRESS_CODE_HASH_API_RELAY: 'new-a', EGRESS_CODE_HASH_LLAMA_PROXY: 'new-l' });
        expect(logs).toEqual(['[EGRESS] started api-relay (no running container)']);
    });

    test('all running: no up call and no reconnect', async () => {
        const { promise, calls } = run(ps('running'));
        expect(await promise).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('started service excluded from refresh recreate list', async () => {
        const psOut = ps('exited');
        const { promise } = run(psOut);
        const started = await promise;
        const recorded = Object.fromEntries(Object.entries(parseRecordedHashes(psOut)).filter(([s]) => !started.includes(s)));
        expect(recorded).toEqual({ squid: '', 'llama-proxy': 'new-l' });
        const { deps, calls } = harness({ recorded, hashes });
        expect(await refreshEgressServices(deps)).toEqual([]);
        expect(calls).toEqual([]);
    });

    test('a failed start propagates and skips reconnect when nothing started', async () => {
        const calls: string[] = [];
        await expect(startMissingEgressServices({
            psOutput: JSON.stringify([{ Service: 'api-relay', State: 'running' }]),
            hashes,
            start: async service => { calls.push(`up:${service}`); throw new Error('boom'); },
            reconnectNetworks: async () => { calls.push('reconnect'); },
            log: () => {},
        })).rejects.toThrow('boom');
        expect(calls).toEqual(['up:llama-proxy']);
    });
});

// The relay runs from its bind-mounted code directory; an import outside it is
// missing in the container and crash-loops the relay, cutting every sandbox off.
test('the relay imports only from its code directory, which each compose file mounts and the image copies', () => {
    const dir = path.join(import.meta.dir, '..', '..', 'egress-proxy');
    const codeDir = path.join(dir, RELAY_CODE_DIR);
    for (const file of fs.readdirSync(codeDir).filter(name => name.endsWith('.mjs'))) {
        const source = fs.readFileSync(path.join(codeDir, file), 'utf8');
        for (const [, spec] of source.matchAll(/^import [^;]*? from '(\.[^']*)';/gm)) {
            expect(spec).toMatch(/^\.\/[^/]+\.mjs$/);
            expect(fs.existsSync(path.join(codeDir, spec))).toBe(true);
        }
    }
    for (const compose of ['docker-compose.yml', 'docker-compose-socat.yml']) {
        expect(fs.readFileSync(path.join(dir, compose), 'utf8')).toContain(`/${RELAY_CODE_DIR}:/app/${RELAY_CODE_DIR}:ro`);
    }
    expect(fs.readFileSync(path.join(dir, '..', 'Dockerfile'), 'utf8')).toContain(`COPY egress-proxy/${RELAY_CODE_DIR}/ ./egress-proxy/${RELAY_CODE_DIR}/`);
});
