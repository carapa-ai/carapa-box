import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { execDocker, execDockerWithTimeout, onlyMissingDockerObjects, splitDockerOutput } from './utils.js';
import { logger } from './logger.js';
import { networkAddressAllocator } from './compose/network-reservations.js';
import { getStateDir } from './installation-paths.js';
import { readPublications } from './app-publications.js';
// Shared validation is also executed by the unprivileged proxy.
// @ts-ignore Pure JavaScript runtime shared with the ingress image.
import { cidr, validateSnapshot } from '../ingress-proxy/proxy.mjs';

export const INGRESS_CONTAINER = 'carapa-box-ingress';
const identifier = /^[a-z0-9][a-z0-9_-]*$/;
export const ingressEnabled = () => /^(1|true)$/i.test(process.env.ENABLE_INGRESS_PROXY ?? '');
export const ingressDirectory = () => path.resolve(process.env.INGRESS_STATE_DIR || process.env.INGRESS_STATE_HOST_DIR || 'generated/ingress');
export const isValidIngressIdentifier = (value: string): boolean => identifier.test(value);

export interface IngressIntent {
    project: string; service: string; targetPort: number; kind: 'http' | 'ssh'; listenPort: number;
}
// A sandbox can hang its own `docker exec`; ssh-control.sh itself waits at most 10 s for its lock.
const SSH_STATUS_TIMEOUT_MS = 8000;
interface IngressDeps { directory: string; execDocker: typeof execDocker; networkDirectory?: string; sshStatusTimeoutMs?: number; }
const defaults = (): IngressDeps => ({ directory: ingressDirectory(), execDocker });

function parseCidrs(value: string | undefined): string[] {
    return (value || '').split(',').map(item => item.trim()).filter(Boolean);
}

export function ingressSettings() {
    const first = Number(process.env.INGRESS_PORT_START || 22000);
    const last = Number(process.env.INGRESS_PORT_END || 22255);
    const host = process.env.INGRESS_PUBLIC_HOST?.trim() ?? '';
    const edgeIp = process.env.INGRESS_EDGE_IP || '172.29.255.2';
    const stateHostDirectory = process.env.INGRESS_STATE_HOST_DIR || '';
    const httpAllow = parseCidrs(process.env.INGRESS_HTTP_ALLOW_CIDRS);
    const sshAllow = parseCidrs(process.env.INGRESS_SSH_ALLOW_CIDRS);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1024 || last > 65535 || last < first || last - first > 1023) throw new Error('Invalid ingress port range');
    if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || isIP(edgeIp) !== 4) throw new Error('Set INGRESS_PUBLIC_HOST to the Docker host LAN address/name and INGRESS_EDGE_IP to an IPv4 address');
    if (!httpAllow.length || !sshAllow.length) throw new Error('Set explicit INGRESS_HTTP_ALLOW_CIDRS and INGRESS_SSH_ALLOW_CIDRS before enabling ingress');
    if (!path.isAbsolute(stateHostDirectory) || path.resolve(stateHostDirectory) === '/') throw new Error('Set INGRESS_STATE_HOST_DIR to a private absolute host directory outside sandbox mounts');
    [...httpAllow, ...sshAllow].forEach(cidr);
    return { first, last, host, edgeIp, httpAllow, sshAllow, stateHostDirectory: path.resolve(stateHostDirectory) };
}

export function assertIngressStatePrivate(containers: any[], stateDirectory: string) {
    for (const container of containers) {
        if (container.Name === '/carapa-box' || container.Name === `/${INGRESS_CONTAINER}`) continue;
        const sandbox = container.HostConfig?.Runtime === 'runsc' || Object.keys(container.NetworkSettings?.Networks ?? {}).some(name => name.startsWith('agent_egress'));
        if (!sandbox) continue;
        for (const mount of container.Mounts ?? []) {
            if (mount.Type !== 'bind' || typeof mount.Source !== 'string') continue;
            const source = path.resolve(mount.Source);
            if (stateDirectory === source || stateDirectory.startsWith(source + '/') || source.startsWith(stateDirectory + '/') || source === '/') {
                throw new Error(`Ingress state overlaps a sandbox-visible mount on ${container.Name}; move INGRESS_STATE_HOST_DIR outside sandbox mounts`);
            }
        }
    }
}

export async function atomicJson(destination: string, value: unknown, mode = 0o600) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
        await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
}

function checkIntent(intent: IngressIntent) {
    if (!isValidIngressIdentifier(intent.project) || !isValidIngressIdentifier(intent.service) || !Number.isInteger(intent.targetPort) || intent.targetPort < 1 || intent.targetPort > 65535 ||
        !['http', 'ssh'].includes(intent.kind) || (intent.kind === 'ssh' && intent.targetPort !== 2222)) throw new Error('Invalid ingress target');
    return `${intent.project}/${intent.service}/${intent.targetPort}/${intent.kind}`;
}

/** Every reservation on disk, even ones outside the configured range. */
async function readReservations(directory: string): Promise<Map<string, IngressIntent>> {
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw error; }
    return new Map(await Promise.all(names
        .filter(name => /^\d+\.json$/.test(name))
        .map(async file => [file, JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as IngressIntent] as const)));
}

function findReservation(reservations: Map<string, IngressIntent>, key: string, first: number, last: number): number | undefined {
    for (const old of reservations.values()) {
        if (checkIntent(old) === key) {
            if (old.listenPort < first || old.listenPort > last) throw new Error('Ingress port range excludes an existing reservation');
            return old.listenPort;
        }
    }
}

/** Immutable port reservations: atomic link prevents collisions across processes.
 * Never recycle a port automatically: a saved SSH command must not select another sandbox. */
export async function reserveIngressPort(target: Omit<IngressIntent, 'listenPort'>, deps = defaults()): Promise<number> {
    const key = checkIntent({ ...target, listenPort: 0 });
    const { first, last } = ingressSettings();
    const directory = path.join(deps.directory, 'ports');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const count = last - first + 1;
    const offset = createHash('sha256').update(key).digest().readUInt32BE(0) % count;
    const reservations = await readReservations(directory);
    const existing = findReservation(reservations, key, first, last);
    if (existing !== undefined) return existing;
    for (let i = 0; i < count; i++) {
        const listenPort = first + (offset + i) % count;
        const destination = path.join(directory, `${listenPort}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ ...target, listenPort }), { mode: 0o600, flag: 'wx' });
        try {
            await fs.link(temporary, destination);
            return listenPort;
        } catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            const old = reservations.get(`${listenPort}.json`)
                ?? JSON.parse(await fs.readFile(destination, 'utf8')) as IngressIntent;
            if (checkIntent(old) === key) return old.listenPort;
        } finally { await fs.rm(temporary, { force: true }); }
    }
    throw new Error('Ingress port range exhausted; existing reservations are never reassigned');
}

export async function setIngressProjectActive(project: string, active: boolean, deps = defaults()) {
    if (!isValidIngressIdentifier(project)) throw new Error('Invalid ingress project');
    await atomicJson(path.join(deps.directory, 'projects', `${project}.json`), { active });
}

/** Publish the SSH flag of a sandbox. Disabling never allocates a port: a sandbox that
 * never enabled SSH has no reservation and gets none (returns undefined). The flag file
 * is only rewritten when it differs. */
export async function setIngressSsh(project: string, service: string, enabled: boolean, deps = defaults()): Promise<number | undefined> {
    const target = { project, service, targetPort: 2222, kind: 'ssh' } as const;
    let port: number | undefined;
    if (enabled) port = await reserveIngressPort(target, deps);
    else {
        const key = checkIntent({ ...target, listenPort: 0 });
        const { first, last } = ingressSettings();
        port = findReservation(await readReservations(path.join(deps.directory, 'ports')), key, first, last);
        if (port === undefined) return undefined;
    }
    const file = path.join(deps.directory, 'ssh', `${port}.json`);
    if (await flag(file, 'enabled') !== enabled) await atomicJson(file, { enabled });
    return port;
}

/** Read-only view of the operator's SSH intent: never reserves a port or writes a flag.
 * Only `setIngressSsh` (start/stop) changes it; a sandbox-reported daemon state must not. */
export async function readIngressSsh(project: string, service: string, deps = defaults()): Promise<{ port?: number; enabled: boolean }> {
    const key = checkIntent({ project, service, targetPort: 2222, kind: 'ssh', listenPort: 0 });
    const { first, last } = ingressSettings();
    const port = findReservation(await readReservations(path.join(deps.directory, 'ports')), key, first, last);
    if (port === undefined) return { enabled: false };
    return { port, enabled: await flag(path.join(deps.directory, 'ssh', `${port}.json`), 'enabled') };
}

async function flag(file: string, name: string): Promise<boolean> {
    try { return JSON.parse(await fs.readFile(file, 'utf8'))[name] === true; }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

/** SSH and app publication need a sandbox that was started with ingress. */
export async function requireIngressSandbox(project: string, deps = defaults()) {
    if (!isValidIngressIdentifier(project)) throw new Error('Invalid ingress project');
    const message = `Sandbox ${project} was not started with ingress. Start the sandbox through CarapaBoard or CarapaBox with ingress enabled before enabling SSH or app publishing. Restarting interrupts active sandbox work.`;
    if (!await flag(path.join(deps.directory, 'projects', `${project}.json`), 'active')) throw new Error(message);
    try {
        await fs.access(path.join(deps.directory, 'compose', `${project}.json`));
        await fs.access(path.join(deps.directory, 'targets', `${project}.json`));
    } catch (error: any) {
        if (error.code === 'ENOENT') throw new Error(message);
        throw error;
    }
}

/** Published HTTP targets of a project: its target file plus enabled app publications. */
async function readHttpTargets(directory: string, project: string): Promise<{ service: string; targetPort: number }[]> {
    const targets = JSON.parse(await fs.readFile(path.join(directory, 'targets', `${project}.json`), 'utf8')) as { service: string; targetPort: number }[];
    targets.push(...(await readPublications(directory, project)).filter(item => item.enabled));
    return targets;
}

async function dockerJson(args: string[], deps: IngressDeps, options: { tolerateMissing?: boolean } = {}): Promise<any[]> {
    const result = await deps.execDocker(args);
    if (result.status !== 0 && options.tolerateMissing && onlyMissingDockerObjects(result.stderr)) {
        // Objects that vanished mid-pass are simply absent; keep the survivors.
        return result.stdout.trim() ? JSON.parse(result.stdout) : [];
    }
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Ingress Docker discovery failed: ${args[0]}`);
    return JSON.parse(result.stdout);
}

function addNetworkSubnetsToDenyList(network: any, denied: Set<string>): void {
    for (const subnet of network.IPAM?.Config ?? []) {
        if (!subnet.Subnet) continue;
        // The proxy drops non-IPv4 clients; IPv6 networks are withheld via EnableIPv6 checks.
        if (isIP(String(subnet.Subnet).split('/')[0]) === 6) continue;
        cidr(subnet.Subnet);
        denied.add(subnet.Subnet);
    }
}

/** Build from Docker ownership and internal-network evidence, never caller IPs.
 * Only the persistent HTTP controller runs this writer. CLI/MCP actions write intents. */
export async function reconcileIngress(deps = defaults()) {
    const settings = ingressSettings();
    const runtime = path.join(deps.directory, 'runtime');
    await fs.mkdir(runtime, { recursive: true, mode: 0o755 });
    let snapshot: any = { version: 1, revision: randomUUID(), expiresAt: Date.now() + 45_000, denyCidrs: [], routes: [] };
    try {
        const files = await fs.readdir(path.join(deps.directory, 'ports')).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
        const intents = (await Promise.all(files
            .filter(name => /^\d+\.json$/.test(name))
            .map(async file => {
                const intent = JSON.parse(await fs.readFile(path.join(deps.directory, 'ports', file), 'utf8'));
                checkIntent(intent);
                if (intent.listenPort !== Number(file.slice(0, -5))) throw new Error('Damaged ingress port reservation');
                return (await flag(path.join(deps.directory, 'projects', `${intent.project}.json`), 'active')) ? intent : undefined;
            }))).filter((intent): intent is IngressIntent => intent !== undefined);
        const [ingress] = await dockerJson(['inspect', INGRESS_CONTAINER], deps);
        if (!ingress?.State?.Running || ingress.NetworkSettings?.Networks?.carapa_ingress_edge?.IPAddress !== settings.edgeIp ||
            ingress.HostConfig?.Sysctls?.['net.ipv4.ip_forward'] !== '0' ||
            ingress.HostConfig?.Sysctls?.['net.ipv6.conf.all.forwarding'] !== '0') throw new Error('Ingress must be running on its configured edge address with IP forwarding disabled');
        const running = await deps.execDocker(['ps', '-q']);
        if (running.status !== 0) throw new Error('Cannot verify ingress state mount privacy');
        const runningIds = splitDockerOutput(running.stdout);
        const runningContainers = runningIds.length ? await dockerJson(['inspect', ...runningIds], deps, { tolerateMissing: true }) : [];
        assertIngressStatePrivate(runningContainers, settings.stateHostDirectory);
        const containersByProject = new Map<string, any[]>();
        for (const container of runningContainers) {
            const project = container.Config?.Labels?.['com.docker.compose.project'];
            if (!project || !container.State?.Running) continue;
            const peers = containersByProject.get(project) ?? [];
            peers.push(container);
            containersByProject.set(project, peers);
        }
        const denied = new Set<string>();
        const networkCache = new Map<string, any>();
        const network = (name: string) => networkCache.get(name);
        // Include inactive and unknown sandbox peers too; source denies must
        // never depend on whether a sandbox has a published ingress route.
        const networks = await deps.execDocker(['network', 'ls', '--filter', 'name=agent_egress', '--format', '{{.Name}}']);
        if (networks.status !== 0) throw new Error('Cannot discover sandbox source networks');
        // Batch fresh isolation evidence, including inactive/unknown sandbox
        // networks and every network attached to the projects being published.
        // This cache lasts only for this pass; revocation checks stay fresh.
        const sourceNetworks = splitDockerOutput(networks.stdout);
        const networkNames = new Set(sourceNetworks);
        for (const project of new Set(intents.map(intent => intent.project))) {
            const containers = containersByProject.get(project) ?? [];
            if (!containers.length) continue;
            networkNames.add(`agent_egress_${project}`);
            for (const container of containers) {
                for (const attached of Object.keys(container.NetworkSettings?.Networks ?? {})) networkNames.add(attached);
            }
        }
        if (networkNames.size) {
            for (const info of await dockerJson(['network', 'inspect', ...networkNames], deps, { tolerateMissing: true })) networkCache.set(info.Name, info);
        }
        for (const name of sourceNetworks) {
            const info = network(name);
            if (info) addNetworkSubnetsToDenyList(info, denied);
        }
        const intentsByProject = new Map<string, IngressIntent[]>();
        for (const intent of intents) {
            const projectIntents = intentsByProject.get(intent.project) ?? [];
            projectIntents.push(intent);
            intentsByProject.set(intent.project, projectIntents);
        }
        for (const [project, projectIntents] of intentsByProject) {
            const httpTargets = await readHttpTargets(deps.directory, project);
            const containers = containersByProject.get(project) ?? [];
            if (!containers.length) continue;
            const name = `agent_egress_${project}`;
            // Deny every network attached to the sandbox, including shared service
            // networks. An allowlisted LAN range must never override these denies.
            let isolated = true;
            for (const container of containers) {
                if (container.Config?.Labels?.['com.docker.compose.project'] !== project) throw new Error('Ingress container ownership mismatch');
                if (Object.values(container.NetworkSettings?.Ports ?? {}).some(value => Array.isArray(value) && value.length)) isolated = false;
                for (const attached of Object.keys(container.NetworkSettings?.Networks ?? {})) {
                    const info = network(attached);
                    if (!info) { isolated = false; continue; }
                    if (info.Internal !== true || info.EnableIPv6) isolated = false;
                    addNetworkSubnetsToDenyList(info, denied);
                }
            }
            const backend = network(name);
            if (backend?.Internal !== true || backend.Driver !== 'bridge' || backend.EnableIPv6) {
                logger.warn({ project, network: name }, 'Ingress withheld: sandbox network must be an IPv4-only internal bridge');
                continue;
            }
            if (!isolated) { logger.warn({ project }, 'Ingress withheld: recreate with ingress migration and remove non-internal sandbox network attachments'); continue; }
            const containersByService = new Map<string, any[]>();
            for (const container of containers) {
                const service = container.Config?.Labels?.['com.docker.compose.service'];
                if (!service) continue;
                const serviceContainers = containersByService.get(service) ?? [];
                serviceContainers.push(container);
                containersByService.set(service, serviceContainers);
            }
            if (!ingress.NetworkSettings.Networks[name]) {
                const allocate = await networkAddressAllocator(name, {
                    directory: deps.networkDirectory ?? path.join(getStateDir(), 'network-reservations'),
                    execDocker: deps.execDocker,
                });
                const connected = await deps.execDocker(['network', 'connect',
                    ...(allocate ? ['--ip', allocate(INGRESS_CONTAINER)] : []), name, INGRESS_CONTAINER]);
                const [updated] = await dockerJson(['inspect', INGRESS_CONTAINER], deps);
                ingress.NetworkSettings.Networks = updated.NetworkSettings.Networks;
                if (!ingress.NetworkSettings.Networks[name]) throw new Error(connected.stderr || 'Cannot attach ingress to sandbox');
            }
            const sourceIp = ingress.NetworkSettings.Networks[name].IPAddress;
            for (const intent of projectIntents) {
                if (intent.kind === 'http' && !httpTargets.some(target => target.service === intent.service && target.targetPort === intent.targetPort)) continue;
                const candidates = containersByService.get(intent.service) ?? [];
                if (!candidates.length) continue;
                if (candidates.length !== 1) {
                    logger.warn({ project, service: intent.service, count: candidates.length }, 'Ingress skipped: exactly one container is required per published service');
                    continue;
                }
                const container = candidates[0];
                const targetIp = container.NetworkSettings?.Networks?.[name]?.IPAddress;
                if (!targetIp) continue;
                if (intent.kind === 'ssh') {
                    if (!await flag(path.join(deps.directory, 'ssh', `${intent.listenPort}.json`), 'enabled')) continue;
                    const daemon = await execDockerWithTimeout(deps.execDocker, ['exec', '--user', '1000:1000', container.Id, '/bin/bash', '/usr/local/ai-cli-bin/ssh-control.sh', 'status'], deps.sshStatusTimeoutMs ?? SSH_STATUS_TIMEOUT_MS);
                    if (daemon.status !== 0 || JSON.parse(daemon.stdout).running !== true) continue;
                }
                snapshot.routes.push({ ...intent, container: container.Name.replace(/^\//, ''), containerId: container.Id, targetIp, sourceIp,
                    allowCidrs: intent.kind === 'ssh' ? settings.sshAllow : settings.httpAllow });
            }
        }
        // A stop/SSH-disable may have arrived during Docker discovery. Recheck
        // desired state before publishing so a slow pass cannot resurrect it.
        const current = [];
        for (const route of snapshot.routes) {
            if (!await flag(path.join(deps.directory, 'projects', `${route.project}.json`), 'active')) continue;
            if (route.kind === 'http') {
                const targets = await readHttpTargets(deps.directory, route.project);
                if (!targets.some(target => target.service === route.service && target.targetPort === route.targetPort)) continue;
            }
            if (route.kind === 'ssh' && !await flag(path.join(deps.directory, 'ssh', `${route.listenPort}.json`), 'enabled')) continue;
            current.push(route);
        }
        snapshot.routes = current;
        snapshot.denyCidrs = [...denied];
        validateSnapshot(snapshot, settings.first, settings.last);
    } catch (error) {
        snapshot = { ...snapshot, routes: [], denyCidrs: [], error: String(error) };
        logger.error({ err: error }, 'Ingress discovery failed; revoking all routes');
    }
    // The proxy sees only this safe routing snapshot, not Compose environments,
    // port reservations, credentials, or controller state.
    await atomicJson(path.join(runtime, 'routes.json'), snapshot, 0o644);
    return snapshot;
}

export async function listIngressEndpoints(project: string) {
    if (!ingressEnabled()) return [];
    try {
        const snapshot = JSON.parse(await fs.readFile(path.join(ingressDirectory(), 'runtime/routes.json'), 'utf8'));
        if (snapshot.expiresAt <= Date.now()) return [];
        const host = ingressSettings().host;
        return snapshot.routes.filter((route: any) => route.project === project).map((route: any) => ({
            service: route.service, targetPort: route.targetPort, kind: route.kind, host, port: route.listenPort,
        })) as { service: string; targetPort: number; kind: string; host: string; port: number }[];
    } catch { return []; }
}

type RouteAttempt = 'ok' | 'missing' | 'unacknowledged';

// One route/acknowledgement check, shared by the polling and single-check callers.
async function ingressRouteAttempt(port: number, present: boolean, deps: ReturnType<typeof defaults>): Promise<RouteAttempt> {
    let result: RouteAttempt = 'missing';
    try {
        const snapshot = JSON.parse(await fs.readFile(path.join(deps.directory, 'runtime/routes.json'), 'utf8'));
        if (snapshot.expiresAt > Date.now() && snapshot.routes.some((r: any) => r.listenPort === port) === present) {
            result = 'unacknowledged';
            const status = await deps.execDocker(['exec', INGRESS_CONTAINER, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/run/ingress-status.json','utf8'))"]);
            const acknowledged = status.status === 0 && JSON.parse(status.stdout);
            if (acknowledged?.revision === snapshot.revision && acknowledged.expiresAt > Date.now()) return 'ok';
        }
    } catch { /* Controller/proxy may be between atomic generations. */ }
    return result;
}

const NOT_ACKNOWLEDGED = 'Ingress route not acknowledged; check the HTTP controller, proxy health, network isolation, and ingress configuration';

export async function waitIngressRoute(port: number, present = true, deps = defaults()): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
        if (await ingressRouteAttempt(port, present, deps) === 'ok') return;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(NOT_ACKNOWLEDGED);
}

/** Single non-polling check: resolves when the route is published and acknowledged by the proxy. */
export async function checkIngressRoute(port: number, deps = defaults()): Promise<void> {
    const result = await ingressRouteAttempt(port, true, deps);
    if (result === 'missing') throw new Error('Ingress route is not published');
    if (result === 'unacknowledged') throw new Error(NOT_ACKNOWLEDGED);
}

export function startIngressReconciler() {
    if (!ingressEnabled()) return;
    ingressSettings();
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try { await reconcileIngress(); } catch (error) { logger.error({ err: error }, 'Ingress reconciliation failed'); }
        finally { running = false; }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    timer.unref();
    return () => clearInterval(timer);
}
