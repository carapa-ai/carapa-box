import path from 'node:path';
import { assertIngressStatePrivate, atomicJson, ingressDirectory, ingressSettings, isValidIngressIdentifier, reserveIngressPort, setIngressProjectActive } from '../ingress.js';
import { networkAddressAllocator, readNetworkReservation } from './network-reservations.js';

export function ingressComposePath(project: string) {
    if (!isValidIngressIdentifier(project)) throw new Error('Invalid ingress Compose project');
    return path.join(ingressDirectory(), 'compose', `${project}.json`);
}

/** Operate on Docker's resolved Compose model, so overrides, env files, and
 * short/long port syntax have already been interpreted by Compose itself. */
export function migrateIngressCompose(model: any, project: string) {
    const result = structuredClone(model);
    const targets: { service: string; targetPort: number; kind: 'http' | 'ssh' }[] = [];
    if (!result.services || !result.networks?.agent_egress) throw new Error('Ingress migration requires an agent_egress stack');
    if (result.networks.agent_egress.name !== `agent_egress_${project}`) throw new Error('Ingress migration requires the project-specific agent network');
    for (const [service, config] of Object.entries(result.services) as [string, any][]) {
        if (config.network_mode || config.privileged) throw new Error(`Ingress refuses network_mode/privileged service ${service}`);
        let hasTarget = false;
        for (const port of config.ports ?? []) {
            if (port.protocol && port.protocol !== 'tcp') throw new Error(`Ingress cannot migrate ${service} UDP port ${port.target}`);
            const targetPort = Number(port.target);
            if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error(`Unsupported ingress port for ${service}`);
            // SSH is activated only by the managed SSH control path.
            if (targetPort !== 2222) {
                targets.push({ service, targetPort, kind: 'http' });
                hasTarget = true;
            }
        }
        delete config.ports;
        if (config.networks) delete config.networks.portonly;
        if (service === 'nginx' && !targets.some(t => t.service === service && t.targetPort === 80)) {
            targets.push({ service, targetPort: 80, kind: 'http' });
            hasTarget = true;
        }
        if (hasTarget) {
            config.networks ??= {};
            config.networks.agent_egress ??= null;
        }
        if (config.networks && !Object.keys(config.networks).length) throw new Error(`Service ${service} would lose all networks`);
    }
    delete result.networks.portonly;
    result.name = project;
    return { model: result, targets };
}

export async function prepareIngressCompose(model: any, project: string) {
    const migrated = migrateIngressCompose(model, project);
    await assignIngressServiceAddresses(migrated.model, project);
    // Check before starting a container: detecting a writable state overlap only
    // after `up` would already have exposed the controller's routing state.
    assertIngressStatePrivate(Object.entries(migrated.model.services).map(([service, value]: [string, any]) => ({
        Name: `/${project}-${service}`, HostConfig: { Runtime: value.runtime },
        NetworkSettings: { Networks: { agent_egress: {} } },
        Mounts: (value.volumes ?? []).map((volume: any) => ({ Type: volume.type, Source: volume.source?.replaceAll('$$', '$') })),
    })), ingressSettings().stateHostDirectory);
    await setIngressProjectActive(project, false);
    for (const target of migrated.targets) await reserveIngressPort({ project, ...target });
    await atomicJson(path.join(ingressDirectory(), 'targets', `${project}.json`), migrated.targets);
    // `docker compose config --format json` already doubles literal dollars so
    // its output can be used as input. Preserve those escapes exactly.
    await atomicJson(ingressComposePath(project), migrated.model);
}

/** Published services newly attached by migration must not take a stopped
 * agent/proxy's address. Preserve existing service addresses when possible. */
export async function assignIngressServiceAddresses(model: any, project: string, deps?: Parameters<typeof readNetworkReservation>[1]) {
    const network = `agent_egress_${project}`;
    const reservation = await readNetworkReservation(network, deps);
    if (!reservation) return;
    const allocate = (await networkAddressAllocator(network, deps))!;
    const services = (Object.entries(model.services) as [string, any][]).filter(([service, config]) =>
        config.networks && Object.hasOwn(config.networks, 'agent_egress') && service !== (reservation.service ?? 'agent'));
    // Claim declared addresses before allocating dynamic peers, regardless of
    // their order in the Compose model.
    for (const [service, config] of services) {
        const ip = config.networks.agent_egress?.ipv4_address;
        if (ip) allocate(config.container_name ?? `${project}-${service}-1`, ip);
    }
    for (const [service, config] of services) {
        const attachment = config.networks.agent_egress ?? {};
        config.networks.agent_egress = {
            ...attachment,
            ipv4_address: allocate(config.container_name ?? `${project}-${service}-1`, attachment.ipv4_address),
        };
    }
}
