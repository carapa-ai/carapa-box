import { execDocker, onlyMissingDockerObjects, splitDockerOutput } from '../utils.js';
import type { ServiceInfo } from '../tools/schemas.js';

/** Only status fields: never copy container environment or credentials into a listing. */
export interface ContainerStatus {
    Id: string;
    Name: string;
    State: { Running: boolean; Status: string; StartedAt: string };
    Config: { Labels: Record<string, string> | null };
    NetworkSettings: {
        Networks: Record<string, { IPAddress?: string }>;
        Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    };
}

/** One discovery and one batched inspection, regardless of project count. */
export async function readContainerInventory(run = execDocker): Promise<ContainerStatus[]> {
    const listed = await run(['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project']);
    if (listed.status !== 0) throw new Error(listed.stderr || 'Cannot list sandbox containers');
    const ids = splitDockerOutput(listed.stdout);
    if (!ids.length) return [];
    const format = '{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}}},"Config":{"Labels":{{json .Config.Labels}}},"NetworkSettings":{{json .NetworkSettings}}}';
    const inspected = await run(['inspect', '--format', format, ...ids]);
    if (inspected.status !== 0 && !onlyMissingDockerObjects(inspected.stderr)) throw new Error(inspected.stderr || 'Cannot inspect sandbox containers');
    return inspected.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function containerServiceInfo(container: ContainerStatus): ServiceInfo {
    const ports: string[] = [];
    for (const [target, bindings] of Object.entries(container.NetworkSettings.Ports ?? {})) {
        for (const binding of bindings ?? []) {
            if (!Number(binding.HostPort)) continue;
            const host = binding.HostIp && !['0.0.0.0', '::'].includes(binding.HostIp) ? `${binding.HostIp}:` : '';
            ports.push(`${host}${binding.HostPort}->${target}`);
        }
    }
    return {
        service: container.Config.Labels?.['com.docker.compose.service'] ?? '',
        hostname: container.Name.replace(/^\//, ''),
        status: container.State.Status,
        ports: [...new Set(ports)],
        ip: Object.values(container.NetworkSettings.Networks ?? {}).find(network => network.IPAddress)?.IPAddress ?? '',
    };
}
