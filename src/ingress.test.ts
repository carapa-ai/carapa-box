import { controlAppPublication } from './app-publications.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INGRESS_CONTAINER, assertIngressStatePrivate, atomicJson, checkIngressRoute, reconcileIngress, requireIngressMigration, reserveIngressPort, setIngressProjectActive, setIngressSsh } from './ingress.js';
import { onlyMissingDockerObjects } from './utils.js';
import { reserveInstanceNetwork } from './compose/network-reservations.js';

let root: string;
const settings = { INGRESS_STATE_HOST_DIR: '/private/ingress', INGRESS_PUBLIC_HOST: '192.168.1.10', INGRESS_HTTP_ALLOW_CIDRS: '172.19.0.2/32', INGRESS_SSH_ALLOW_CIDRS: '192.168.1.0/24', INGRESS_PORT_START: '22000', INGRESS_PORT_END: '22005', NGINX_PROXY_DOMAIN: 'ex.test' };
const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
beforeAll(async () => { Object.assign(process.env, settings); root = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-ingress-')); });
afterAll(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
});

test('concurrent durable allocations never collide, renumber, or recycle exhausted ports', async () => {
    const deps = { directory: path.join(root, 'allocation'), execDocker: null as any };
    const request = (service: string) => reserveIngressPort({ project: 'demo', service, targetPort: 80, kind: 'http' }, deps);
    const same = await Promise.all(Array.from({ length: 20 }, () => request('nginx')));
    expect(new Set(same).size).toBe(1);
    const rest = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(request));
    expect(new Set([...same, ...rest]).size).toBe(6);
    expect(await request('nginx')).toBe(same[0]);
    await expect(request('overflow')).rejects.toThrow('exhausted');
});

test('disabling SSH never reserves a port or writes a route for a sandbox that never enabled it', async () => {
    // setIngressSsh never calls execDocker; `any` only satisfies the unused dependency slot.
    const deps = { directory: path.join(root, 'ssh-status'), execDocker: null as any };
    expect(await setIngressSsh('idle', 'agent', false, deps)).toBeUndefined();
    await expect(fs.readdir(path.join(deps.directory, 'ports'))).rejects.toThrow();
    await expect(fs.readdir(path.join(deps.directory, 'ssh'))).rejects.toThrow();
    const port = await setIngressSsh('idle', 'agent', true, deps);
    expect(port).toBeNumber();
    const file = path.join(deps.directory, 'ssh', `${port}.json`);
    const before = (await fs.stat(file)).ino;
    // An unchanged flag is not rewritten (atomicJson renames a new inode into place).
    expect(await setIngressSsh('idle', 'agent', true, deps)).toBe(port);
    expect((await fs.stat(file)).ino).toBe(before);
    expect(await setIngressSsh('idle', 'agent', false, deps)).toBe(port);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ enabled: false });
    expect(await fs.readdir(path.join(deps.directory, 'ports'))).toHaveLength(1);
});

test('ingress state must be outside every sandbox-visible bind mount, including read-only mounts', () => {
    const container = (source: string) => ({ Name: '/sandbox-agent-1', HostConfig: { Runtime: 'runsc' }, Mounts: [{ Type: 'bind', Source: source, RW: false }] });
    for (const source of ['/private', '/private/ingress', '/private/ingress/runtime', '/']) {
        expect(() => assertIngressStatePrivate([container(source)], '/private/ingress')).toThrow('overlaps');
    }
    expect(() => assertIngressStatePrivate([container('/private/ingress-other')], '/private/ingress')).not.toThrow();
});

test('controller derives routes from owned isolated containers and revokes on disable, unsafe networks and discovery failure', async () => {
    const name = 'agent_egress_demo';
    const containers = ['nginx', 'agent'].map((service, index) => ({
        Id: (index ? 'b' : 'a').repeat(64), Name: `/demo-${service}-1`, State: { Running: true },
        Config: { Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.service': service } },
        HostConfig: { Runtime: service === 'agent' ? 'runsc' : 'runc' },
        NetworkSettings: { Networks: { [name]: { IPAddress: `172.26.1.${10 + index}` } }, Ports: {} },
    }));
    const ingress = { State: { Running: true }, HostConfig: { Sysctls: { 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' } },
        NetworkSettings: { Networks: { carapa_ingress_edge: { IPAddress: '172.29.255.2' }, [name]: { IPAddress: '172.26.1.2' } } } };
    let internal = true;
    let unavailable = false;
    let daemon = true;
    const deps = { directory: path.join(root, 'reconcile'), execDocker: (async (args: string[]) => {
        if (unavailable) return { status: 1, stdout: '', stderr: 'daemon unavailable' };
        const json = (value: any) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
        if (args[0] === 'inspect') return json(args[1] === INGRESS_CONTAINER ? [ingress] : containers);
        if (args[0] === 'ps') return { status: 0, stdout: containers.map(c => c.Id).join('\n'), stderr: '' };
        if (args[0] === 'exec') return json({ running: daemon });
        if (args[0] === 'network' && args[1] === 'ls') return { status: 0, stdout: name, stderr: '' };
        if (args[0] === 'network' && args[1] === 'inspect') return json([{ Name: name, Internal: internal, Driver: 'bridge', EnableIPv6: false, IPAM: { Config: [{ Subnet: '172.26.1.0/24' }] } }]);
        throw new Error(`Unexpected command ${args}`);
    }) as any };
    await reserveIngressPort({ project: 'demo', service: 'nginx', kind: 'http', targetPort: 80 }, deps);
    await atomicJson(path.join(deps.directory, 'targets/demo.json'), [{ service: 'nginx', targetPort: 80 }]);
    await setIngressSsh('demo', 'agent', true, deps);
    await setIngressProjectActive('demo', true, deps);
    let snapshot = await reconcileIngress(deps);
    expect(snapshot.routes).toHaveLength(2);
    expect(snapshot.denyCidrs).toEqual(['172.26.1.0/24']);
    expect(snapshot.routes.find((route: any) => route.kind === 'ssh')).toMatchObject({ targetIp: '172.26.1.11', sourceIp: '172.26.1.2', targetPort: 2222 });
    // A dynamically published application uses the same isolation checks and
    // revocation path as stack-declared endpoints; no container port is added.
    await atomicJson(path.join(deps.directory, 'compose/demo.json'), { services: { agent: {}, nginx: {} } });
    let rejectAcknowledgement = false;
    let rejectRevocation = false;
    let revocations = 0;
    const publishing = {
        directory: deps.directory, enabled: () => true, proxyEnabled: () => false,
        migrate: (project: string) => requireIngressMigration(project, deps),
        reserve: (target: any) => reserveIngressPort(target, deps),
        route: async () => {},
        checkHostname: async () => '',
        routePresent: async () => true,
        wait: async (port: number, present = true) => {
            const live = await reconcileIngress(deps);
            expect(live.routes.some((route: any) => route.listenPort === port)).toBe(present);
            if (!present) { revocations++; if (rejectRevocation) throw new Error('Revocation acknowledgement lost'); }
            if (rejectAcknowledgement && present) throw new Error('Proxy unavailable');
        },
        endpoints: async () => (await reconcileIngress(deps)).routes.map((route: any) => ({ ...route, host: '192.168.1.10', port: route.listenPort })),
    };
    await expect(controlAppPublication('demo', { id: 'app', action: 'publish', service: 'other', targetPort: 3000 }, publishing)).rejects.toThrow('does not belong');
    await expect(controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 2222 }, publishing)).rejects.toThrow('SSH');
    const published = await controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 3000 }, publishing);
    expect(published).toMatchObject({ enabled: true, ready: true, targetPort: 3000 });
    expect(published.url).toBe(`http://192.168.1.10:${published.port}/`);
    await expect(controlAppPublication('demo', { id: 'sibling', action: 'publish', service: 'agent', targetPort: 3000 }, publishing)).rejects.toThrow('already published');
    const replaced = await controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 3001 }, publishing);
    expect(replaced.port).not.toBe(published.port);
    expect((await reconcileIngress(deps)).routes.some((route: any) => route.targetPort === 3000)).toBe(false);
    rejectRevocation = true;
    await expect(controlAppPublication('demo', { id: 'app', action: 'unpublish' }, publishing)).rejects.toThrow('acknowledgement lost');
    const previousRevocations = revocations;
    rejectRevocation = false;
    await controlAppPublication('demo', { id: 'app', action: 'unpublish' }, publishing);
    expect(revocations).toBe(previousRevocations + 1);
    expect((await reconcileIngress(deps)).routes).toHaveLength(2);
    rejectAcknowledgement = true;
    await expect(controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 3000 }, publishing)).rejects.toThrow('Proxy unavailable');
    expect((await reconcileIngress(deps)).routes).toHaveLength(2);
    rejectAcknowledgement = false;
    const restored = await controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 3000 }, publishing);
    expect(restored.port).toBe(published.port);
    await setIngressProjectActive('demo', false, deps);
    expect((await controlAppPublication('demo', { id: 'app', action: 'status' }, publishing)).ready).toBe(false);
    await setIngressProjectActive('demo', true, deps);
    expect((await controlAppPublication('demo', { id: 'app', action: 'status' }, publishing)).ready).toBe(true);
    await controlAppPublication('demo', { id: 'app', action: 'unpublish' }, publishing);
    const shared = { service: 'agent', targetPort: 3000 };
    await controlAppPublication('demo', { id: 'owner-a', action: 'publish', ...shared }, publishing);
    await controlAppPublication('demo', { id: 'owner-a', action: 'unpublish' }, publishing);
    expect(await controlAppPublication('demo', { id: 'owner-b', action: 'publish', ...shared }, publishing)).toMatchObject({ enabled: true });
    await expect(controlAppPublication('demo', { id: 'owner-a', action: 'publish', ...shared }, publishing)).rejects.toThrow('already published');
    await controlAppPublication('demo', { id: 'owner-b', action: 'unpublish' }, publishing);
    // A refused hostname leaves the live publication and its route untouched.
    const hostnameRoutes: unknown[] = [];
    const named = { ...publishing, proxyEnabled: () => true, route: async (...args: unknown[]) => { hostnameRoutes.push(args[2]); } };
    await controlAppPublication('demo', { id: 'owner-b', action: 'publish', ...shared, hostname: 'live.ex.test' }, named);
    const refusing = { ...named, checkHostname: async () => { throw new Error('Hostname is reserved for a project default hostname'); } };
    await expect(controlAppPublication('demo', { id: 'owner-b', action: 'publish', ...shared, hostname: 'taken.ex.test' }, refusing)).rejects.toThrow('reserved');
    expect(hostnameRoutes).toEqual([expect.objectContaining({ hostname: 'live.ex.test' })]);
    expect(await controlAppPublication('demo', { id: 'owner-b', action: 'status' }, named)).toMatchObject({ enabled: true, hostname: 'live.ex.test' });
    await controlAppPublication('demo', { id: 'owner-b', action: 'unpublish' }, publishing);
    const failingRoute = { ...publishing, route: async () => { throw new Error('Route failed'); } };
    await expect(controlAppPublication('demo', { id: 'owner-a', action: 'publish', ...shared }, failingRoute)).rejects.toThrow('Route failed');
    expect(await controlAppPublication('demo', { id: 'owner-a', action: 'status' }, publishing)).toMatchObject({ enabled: false });
    expect(await controlAppPublication('demo', { id: 'owner-b', action: 'publish', ...shared }, publishing)).toMatchObject({ enabled: true });
    await controlAppPublication('demo', { id: 'owner-b', action: 'unpublish' }, publishing);
    const withProxy = { ...publishing, proxyEnabled: () => true };
    const automatic = await controlAppPublication('demo', { id: 'board-91a2e19d8fd9ec30e460ab6f', action: 'publish', service: 'agent', targetPort: 3002 }, withProxy);
    // The previous stack + publication ID exceeded a default 64-byte nginx
    // server_names_hash bucket in a real Board publication.
    expect(automatic.hostname!.length).toBeLessThanOrEqual(32);
    expect(automatic.hostname).toEndWith('.ex.test');
    expect(automatic.url).toBe(`https://${automatic.hostname}/`);
    const again = await controlAppPublication('demo', { id: 'board-91a2e19d8fd9ec30e460ab6f', action: 'publish', service: 'agent', targetPort: 3002 }, withProxy);
    expect(again.hostname).toBe(automatic.hostname);
    await controlAppPublication('demo', { id: 'board-91a2e19d8fd9ec30e460ab6f', action: 'unpublish' }, withProxy);
    for (const runtime of ['nvidia', 'runsc-gpu']) {
        containers[1].HostConfig.Runtime = runtime;
        expect((await reconcileIngress(deps)).routes.find((route: any) => route.kind === 'ssh')).toMatchObject({
            containerId: containers[1].Id, targetIp: '172.26.1.11', sourceIp: '172.26.1.2', targetPort: 2222,
        });
    }
    daemon = false;
    expect((await reconcileIngress(deps)).routes).toHaveLength(1);
    daemon = true;
    await setIngressSsh('demo', 'agent', false, deps);
    expect((await reconcileIngress(deps)).routes).toHaveLength(1);
    await setIngressProjectActive('demo', false, deps);
    expect((await reconcileIngress(deps)).routes).toHaveLength(0);
    await setIngressProjectActive('demo', true, deps);
    internal = false;
    expect((await reconcileIngress(deps)).routes).toHaveLength(0);
    internal = true;
    containers[0].Config.Labels['com.docker.compose.project'] = 'other';
    expect((await reconcileIngress(deps)).routes).toHaveLength(0);
    containers[0].Config.Labels['com.docker.compose.project'] = 'demo';
    unavailable = true;
    snapshot = await reconcileIngress(deps);
    expect(snapshot.routes).toHaveLength(0);
    expect(snapshot.error).toContain('daemon unavailable');
    const persisted = JSON.parse(await fs.readFile(path.join(deps.directory, 'runtime/routes.json'), 'utf8'));
    expect(persisted.routes).toHaveLength(0);
});


test('new ingress attachments leave stopped proxies reserved addresses available for recovery', async () => {
    const name = 'agent_egress_stopped-proxies';
    const agent = { Id: 'a'.repeat(64), Name: '/stopped-proxies-agent-1', State: { Running: true },
        Config: { Labels: { 'com.docker.compose.project': 'stopped-proxies', 'com.docker.compose.service': 'agent' } },
        NetworkSettings: { Networks: { [name]: { IPAddress: '172.26.1.11' } }, Ports: {} },
    };
    const network = { Name: name, Internal: true, Driver: 'bridge',
        IPAM: { Driver: 'default', Config: [{ Subnet: '172.26.1.0/24', Gateway: '172.26.1.1' }] },
        Containers: { [agent.Id]: { Name: agent.Name.slice(1), IPv4Address: '172.26.1.11/24' } },
    };
    const ingress = { State: { Running: true }, HostConfig: { Sysctls: { 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' } },
        NetworkSettings: { Networks: { carapa_ingress_edge: { IPAddress: '172.29.255.2' } } as Record<string, { IPAddress: string }> } };
    const deps = { directory: path.join(root, 'stopped-proxies'), networkDirectory: path.join(root, 'stopped-network-reservations'),
        execDocker: (async (args: string[]) => {
            const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
            if (args[0] === 'inspect') return ok(JSON.stringify(args[1] === INGRESS_CONTAINER ? [ingress] : [agent]));
            if (args[0] === 'ps') return ok(agent.Id);
            if (args[0] === 'network' && args[1] === 'ls') return ok(name);
            if (args[0] === 'network' && args[1] === 'inspect') return ok(JSON.stringify([network]));
            if (args[0] === 'network' && args[1] === 'connect') {
                // Emulate Docker choosing the first stopped proxy slot without --ip.
                const ip = args.includes('--ip') ? args[args.indexOf('--ip') + 1] : '172.26.1.254';
                ingress.NetworkSettings.Networks[name] = { IPAddress: ip };
                return ok('');
            }
            throw new Error(`Unexpected command ${args}`);
        }) as any };
    const saved = (await reserveInstanceNetwork('stopped-proxies', false, { directory: deps.networkDirectory, execDocker: deps.execDocker }))!;
    await reserveIngressPort({ project: 'stopped-proxies', service: 'agent', kind: 'http', targetPort: 3100 }, deps);
    await atomicJson(path.join(deps.directory, 'targets/stopped-proxies.json'), [{ service: 'agent', targetPort: 3100 }]);
    await setIngressProjectActive('stopped-proxies', true, deps);
    const snapshot = await reconcileIngress(deps);
    expect(snapshot.routes).toHaveLength(1);
    expect([saved.agentIp, saved.gateway, ...Object.values(saved.proxyIps)]).not.toContain(snapshot.routes[0].sourceIp);
});

test('migration readiness requires an active project and its saved Compose model and targets', async () => {
    const deps = { directory: path.join(root, 'migration-ready'), execDocker: null as any };
    await expect(requireIngressMigration('legacy', deps)).rejects.toThrow('Restart the sandbox');
    await atomicJson(path.join(deps.directory, 'projects/legacy.json'), { active: true });
    await expect(requireIngressMigration('legacy', deps)).rejects.toThrow('Restart the sandbox');
    await atomicJson(path.join(deps.directory, 'compose/legacy.json'), {});
    await expect(requireIngressMigration('legacy', deps)).rejects.toThrow('Restart the sandbox');
    await atomicJson(path.join(deps.directory, 'targets/legacy.json'), []);
    await requireIngressMigration('legacy', deps);
    await atomicJson(path.join(deps.directory, 'projects/legacy.json'), { active: false });
    await expect(requireIngressMigration('legacy', deps)).rejects.toThrow('Restart the sandbox');
});

test('batched discovery stays constant across projects and refreshes isolation evidence every pass', async () => {
    const projects = ['first', 'second', 'third'];
    const containers = projects.map((project, i) => ({
        Id: `${i}`.repeat(64), Name: `/${project}-nginx-1`, State: { Running: true },
        Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'nginx' } },
        NetworkSettings: { Networks: { [`agent_egress_${project}`]: { IPAddress: `172.26.${i}.10` } }, Ports: {} },
    }));
    const ingress = { State: { Running: true }, HostConfig: { Sysctls: { 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' } },
        NetworkSettings: { Networks: { carapa_ingress_edge: { IPAddress: '172.29.255.2' },
            ...Object.fromEntries(projects.map((p, i) => [`agent_egress_${p}`, { IPAddress: `172.26.${i}.2` }])) } } };
    let unsafe = false;
    let failed = false;
    const calls: string[][] = [];
    const deps = { directory: path.join(root, 'batched'), execDocker: (async (args: string[]) => {
        calls.push(args);
        const ok = (value: any) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
        if (args[0] === 'ps') return ok(containers.map(c => c.Id).join('\n'));
        if (args[0] === 'inspect') return ok(args[1] === INGRESS_CONTAINER ? [ingress] : containers);
        if (args[0] === 'network' && args[1] === 'ls') return ok([...projects, 'unknown'].map(p => `agent_egress_${p}`).join('\n'));
        if (args[0] === 'network' && args[1] === 'inspect') {
            if (failed) return { status: 1, stdout: '[]', stderr: 'network disappeared' };
            return ok(args.slice(2).map((name, i) => ({ Name: name, Internal: !unsafe, Driver: 'bridge', EnableIPv6: false, IPAM: { Config: [{ Subnet: `172.26.${i}.0/24` }] } })));
        }
        throw new Error(`Unexpected command ${args}`);
    }) as any };
    for (const project of projects) {
        await reserveIngressPort({ project, service: 'nginx', kind: 'http', targetPort: 80 }, deps);
        await atomicJson(path.join(deps.directory, `targets/${project}.json`), [{ service: 'nginx', targetPort: 80 }]);
        await setIngressProjectActive(project, true, deps);
    }
    const snapshot = await reconcileIngress(deps);
    expect(snapshot.routes).toHaveLength(3);
    expect(snapshot.denyCidrs).toHaveLength(4); // Unknown peers are still denied.
    expect(calls).toHaveLength(5); // No per-project ps/inspect or per-network spawn.
    unsafe = true;
    expect((await reconcileIngress(deps)).routes).toHaveLength(0);
    unsafe = false;
    expect((await reconcileIngress(deps)).routes).toHaveLength(3);
    failed = true;
    const revoked = await reconcileIngress(deps);
    expect(revoked.routes).toHaveLength(0);
    expect(revoked.error).toContain('network disappeared');
});

type Fixture = { projects: Record<string, { replicas?: number; internal?: boolean; subnet: string; shared?: boolean; ipv6?: boolean }>; psExtra?: string[]; inspectFail?: string; networkFail?: string; extraNetworks?: string[]; sshProjects?: string[]; hangSsh?: string };
async function reconcileFixture(label: string, fixture: Fixture) {
    const names = Object.keys(fixture.projects);
    const containers = names.flatMap((project, i) => Array.from({ length: fixture.projects[project].replicas ?? 1 }, (_, n) => ({
        Id: `${i}${n}`.padEnd(64, 'c'), Name: `/${project}-web-${n}`, State: { Running: true },
        Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'web' } },
        NetworkSettings: { Networks: { [`agent_egress_${project}`]: { IPAddress: `172.27.${i}.${10 + n}` },
            ...(fixture.projects[project].shared ? { [`${project}_shared`]: { IPAddress: `172.26.${5 + i}.${10 + n}` } } : {}) }, Ports: {} },
    })));
    const ingress = { State: { Running: true }, HostConfig: { Sysctls: { 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' } },
        NetworkSettings: { Networks: { carapa_ingress_edge: { IPAddress: '172.29.255.2' },
            ...Object.fromEntries(names.map((p, i) => [`agent_egress_${p}`, { IPAddress: `172.27.${i}.2` }])) } } };
    const netInfo = (name: string) => {
        if (name.endsWith('_shared') && fixture.projects[name.replace('_shared', '')]?.ipv6) return { Name: name, Internal: true, Driver: 'bridge', EnableIPv6: true, IPAM: { Config: [{ Subnet: '172.26.9.0/24' }, { Subnet: 'fd00::/64' }] } };
        if (name.endsWith('_shared')) return { Name: name, Internal: true, Driver: 'bridge', EnableIPv6: false, IPAM: { Config: [{ Subnet: `172.26.${5 + names.indexOf(name.replace('_shared', ''))}.0/24` }] } };
        const project = name.replace('agent_egress_', '');
        const f = fixture.projects[project];
        return { Name: name, Internal: f?.internal ?? true, Driver: 'bridge', EnableIPv6: false, IPAM: { Config: [{ Subnet: f?.subnet ?? '172.28.0.0/24' }] } };
    };
    const deps = { directory: path.join(root, label), execDocker: (async (args: string[]) => {
        const json = (value: any, status = 0, stderr = '') => ({ status, stdout: JSON.stringify(value), stderr });
        if (args[0] === 'ps') return { status: 0, stdout: [...containers.map(c => c.Id), ...(fixture.psExtra ?? [])].join('\n'), stderr: '' };
        if (args[0] === 'inspect') {
            if (args[1] === INGRESS_CONTAINER) return json([ingress]);
            return fixture.inspectFail ? json(containers, 1, fixture.inspectFail) : json(containers);
        }
        if (args[0] === 'exec') {
            if (containers.find(c => c.Id === args[3])?.Config.Labels['com.docker.compose.project'] === fixture.hangSsh) return new Promise(() => {}); // Sandbox-controlled FIFO lock: never answers, ignores the signal.
            return json({ running: true });
        }
        if (args[0] === 'network' && args[1] === 'ls') return { status: 0, stdout: [...names.map(p => `agent_egress_${p}`), ...(fixture.extraNetworks ?? [])].join('\n'), stderr: '' };
        if (args[0] === 'network' && args[1] === 'inspect') {
            const requested = args.slice(2);
            if (fixture.networkFail && requested.length > 1) {
                return json(requested.filter(n => !n.includes('gone')).map(netInfo), 1, fixture.networkFail);
            }
            return json(requested.map(netInfo));
        }
        throw new Error(`Unexpected command ${args}`);
    }) as any, sshStatusTimeoutMs: 100 };
    for (const project of names) {
        await reserveIngressPort({ project, service: 'web', kind: 'http', targetPort: 80 }, deps);
        await atomicJson(path.join(deps.directory, `targets/${project}.json`), [{ service: 'web', targetPort: 80 }]);
        await setIngressProjectActive(project, true, deps);
        if (fixture.sshProjects?.includes(project)) await setIngressSsh(project, 'web', true, deps);
    }
    return reconcileIngress(deps);
}

test('a container that vanishes between ps and inspect does not revoke healthy routes', async () => {
    const snapshot = await reconcileFixture('race-container', { projects: { p1: { subnet: '172.27.0.0/24' } }, psExtra: ['b'.repeat(12)], inspectFail: 'Error: No such object: bbb' });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: any) => r.project)).toEqual(['p1']);
});

test('a sandbox network that vanishes during the batched inspect does not revoke routes', async () => {
    const snapshot = await reconcileFixture('race-network', { projects: { p1: { subnet: '172.27.0.0/24' } }, extraNetworks: ['agent_egress_gone'], networkFail: 'Error: No such network: agent_egress_gone' });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: any) => r.project)).toEqual(['p1']);
});

test('a project with replicated services loses only its own route and stays denied', async () => {
    const snapshot = await reconcileFixture('replicas', { projects: { p1: { replicas: 2, shared: true, subnet: '172.27.0.0/24' }, p2: { subnet: '172.27.1.0/24' } } });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: any) => r.project)).toEqual(['p2']);
    expect(snapshot.denyCidrs).toContain('172.27.0.0/24');
    expect(snapshot.denyCidrs).toContain('172.26.5.0/24'); // Attached-only network, denied despite the skip.
});

test('a project with a non-internal backend network is withheld without affecting others', async () => {
    const snapshot = await reconcileFixture('backend', { projects: { p1: { internal: false, shared: true, subnet: '172.27.0.0/24' }, p2: { subnet: '172.27.1.0/24' } } });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: any) => r.project)).toEqual(['p2']);
    expect(snapshot.denyCidrs).toContain('172.27.0.0/24');
    expect(snapshot.denyCidrs).toContain('172.26.5.0/24'); // Attached-only network, denied despite the skip.
});

test('a sandbox whose ssh-control exec hangs loses only its own SSH route and the tick still finishes', async () => {
    const started = Date.now();
    const snapshot = await reconcileFixture('ssh-hang', {
        projects: { p1: { subnet: '172.27.0.0/24' }, p2: { subnet: '172.27.1.0/24' } },
        sshProjects: ['p1', 'p2'], hangSsh: 'p1',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: { project: string; kind: string }) => `${r.project}:${r.kind}`).sort()).toEqual(['p1:http', 'p2:http', 'p2:ssh']);
});

test('onlyMissingDockerObjects accepts only no-such-object stderr', () => {
    expect(onlyMissingDockerObjects('Error: No such object: x\nError: No such container: y')).toBe(true);
    expect(onlyMissingDockerObjects('')).toBe(false);
    expect(onlyMissingDockerObjects('permission denied')).toBe(false);
    expect(onlyMissingDockerObjects('Error: No such object: x\npermission denied')).toBe(false);
});

test('an IPv6 subnet withholds only its own project instead of emptying every route', async () => {
    const snapshot = await reconcileFixture('ipv6', { projects: { p1: { ipv6: true, shared: true, subnet: '172.27.0.0/24' }, p2: { subnet: '172.27.1.0/24' } } });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.routes.map((r: any) => r.project)).toEqual(['p2']);
    expect(snapshot.denyCidrs).toContain('172.26.9.0/24');
    expect(snapshot.denyCidrs).not.toContain('fd00::/64');
});

test('checkIngressRoute rejects immediately without docker exec when the route is not published', async () => {
    let execs = 0;
    const deps = { directory: path.join(root, 'check-missing'), execDocker: (async () => { execs++; return { status: 0, stdout: '{}', stderr: '' }; }) as any };
    let started = Date.now();
    await expect(checkIngressRoute(22042, deps)).rejects.toThrow('not published');
    expect(Date.now() - started).toBeLessThan(1000);
    await atomicJson(path.join(deps.directory, 'runtime/routes.json'), { revision: 'r1', expiresAt: Date.now() + 60000, routes: [{ listenPort: 22043 }] });
    started = Date.now();
    await expect(checkIngressRoute(22042, deps)).rejects.toThrow('not published');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(execs).toBe(0);
});

test('checkIngressRoute makes exactly one attempt when the proxy has not acknowledged the revision', async () => {
    const stale = [{ revision: 'old', expiresAt: Date.now() + 60000 }, { revision: 'r1', expiresAt: Date.now() - 1 }];
    for (const [index, ack] of stale.entries()) {
        let execs = 0;
        const deps = { directory: path.join(root, `check-unacked-${index}`), execDocker: (async () => { execs++; return { status: 0, stdout: JSON.stringify(ack), stderr: '' }; }) as any };
        await atomicJson(path.join(deps.directory, 'runtime/routes.json'), { revision: 'r1', expiresAt: Date.now() + 60000, routes: [{ listenPort: 22042 }] });
        const started = Date.now();
        await expect(checkIngressRoute(22042, deps)).rejects.toThrow('not acknowledged');
        expect(Date.now() - started).toBeLessThan(1000);
        expect(execs).toBe(1);
    }
});

test('checkIngressRoute resolves when the route is published and acknowledged', async () => {
    const calls: string[][] = [];
    const deps = { directory: path.join(root, 'check-ok'), execDocker: (async (args: string[]) => { calls.push(args); return { status: 0, stdout: JSON.stringify({ revision: 'r1', expiresAt: Date.now() + 60000 }), stderr: '' }; }) as any };
    await atomicJson(path.join(deps.directory, 'runtime/routes.json'), { revision: 'r1', expiresAt: Date.now() + 60000, routes: [{ listenPort: 22042 }] });
    await checkIngressRoute(22042, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(INGRESS_CONTAINER);
});
