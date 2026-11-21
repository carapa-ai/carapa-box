import { expect, test } from 'bun:test';
import { containerServiceInfo, readContainerInventory, type ContainerStatus } from './inventory.js';

test('one inventory covers many projects and preserves stopped services, ports and addresses', async () => {
    const containers: ContainerStatus[] = Array.from({ length: 30 }, (_, i) => ({
        Id: `container-${i}`, Name: `/project-${i}-agent-1`,
        State: { Running: i !== 0, Status: i === 0 ? 'exited' : 'running', StartedAt: '2026-01-01T00:00:00Z' },
        Config: { Labels: { 'com.docker.compose.project': `project-${i}`, 'com.docker.compose.service': 'agent' } },
        NetworkSettings: { Networks: { internal: { IPAddress: i === 0 ? '' : '172.20.0.2' } },
            Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }, { HostIp: '::', HostPort: '8080' }], '2222/tcp': null } },
    }));
    const calls: string[][] = [];
    const run = async (args: string[]) => {
        calls.push(args);
        return { status: 0, stderr: '', stdout: args[0] === 'ps' ? containers.map(c => c.Id).join('\n') : containers.map(c => JSON.stringify(c)).join('\n') };
    };
    const snapshot = await readContainerInventory(run);
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(3)).toEqual(containers.map(c => c.Id));
    expect(snapshot).toHaveLength(30);
    expect(containerServiceInfo(snapshot[0])).toEqual({ service: 'agent', hostname: 'project-0-agent-1', status: 'exited', ports: ['8080->80/tcp'], ip: '' });
    expect(containerServiceInfo(snapshot[1]).ip).toBe('172.20.0.2');
    await expect(readContainerInventory(async () => ({ status: 1, stderr: 'daemon unavailable', stdout: '' }))).rejects.toThrow('daemon unavailable');
});

const minimalContainer = (id: string): ContainerStatus => ({
    Id: id, Name: `/${id}`,
    State: { Running: true, Status: 'running', StartedAt: '2026-01-01T00:00:00Z' },
    Config: { Labels: {} },
    NetworkSettings: { Networks: {}, Ports: {} },
});

test('inventory returns surviving containers when one is removed before inspect', async () => {
    const run = async (args: string[]) => args[0] === 'ps'
        ? { status: 0, stderr: '', stdout: 'aaa\nbbb' }
        : { status: 1, stderr: 'Error: No such object: bbb', stdout: `${JSON.stringify(minimalContainer('aaa'))}\n` };
    const snapshot = await readContainerInventory(run);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].Id).toBe('aaa');
});

test('inventory still throws on non-missing inspect failures', async () => {
    const run = async (args: string[]) => args[0] === 'ps'
        ? { status: 0, stderr: '', stdout: 'aaa\nbbb' }
        : { status: 1, stderr: 'permission denied', stdout: '' };
    await expect(readContainerInventory(run)).rejects.toThrow('permission denied');
});
