import { expect, test } from 'bun:test';
import { resolveOwnedProjects } from './utils.js';

test('private ingress Compose projects resolve the original approved stack across host/container paths', async () => {
    const project = { Name: 'carapa-brain-main', ConfigFiles: '/app/ingress/compose/carapa-brain-main.json' };
    let workingDir = '/app/stacks/carapa-brain';
    let modelName = project.Name;
    const deps = {
        listStacks: async () => [{ name: 'carapa-brain', path: '/host/stacks/carapa-brain' }],
        readFile: async () => JSON.stringify({ name: modelName }),
        execDocker: async () => ({ status: 0, stderr: '', stdout: workingDir + '\n' }),
    } as unknown as NonNullable<Parameters<typeof resolveOwnedProjects>[2]>;
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([{ name: project.Name, localStackPath: '/host/stacks/carapa-brain' }]);
    workingDir = '/app/stacks/unknown';
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([]);
    workingDir = '/app/stacks/carapa-brain\n/app/stacks/unknown';
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([]);
    workingDir = '/app/stacks/carapa-brain';
    modelName = 'another-project';
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([]);
    expect(await resolveOwnedProjects([{ ...project, ConfigFiles: '/untrusted/compose/carapa-brain-main.json' }], '/host/stacks', deps)).toEqual([]);
    modelName = project.Name;
    deps.execDocker = async () => { throw new Error('Inventory should avoid another Docker query'); };
    const directories = new Map([[project.Name, ['/app/stacks/carapa-brain']]]);
    deps.workingDirectories = directories;
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([{ name: project.Name, localStackPath: '/host/stacks/carapa-brain' }]);
    directories.set(project.Name, ['/app/stacks/carapa-brain', '/app/stacks/unknown']);
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([]);
    directories.delete(project.Name);
    expect(await resolveOwnedProjects([project], '/host/stacks', deps)).toEqual([]);
});

test('only compose files inside the stacks directory are owned, not sibling-prefix directories', async () => {
    const deps = {
        listStacks: async () => [],
        readFile: async () => '',
        execDocker: async () => ({ status: 1, stderr: '', stdout: '' }),
    } as unknown as NonNullable<Parameters<typeof resolveOwnedProjects>[2]>;
    const evil = { Name: 'evil', ConfigFiles: '/host/stacks-evil/evil/docker-compose.yml' };
    expect(await resolveOwnedProjects([evil], '/host/stacks', deps)).toEqual([]);
    const brain = { Name: 'carapa-brain', ConfigFiles: '/host/stacks/carapa-brain/docker-compose.yml' };
    const owned = [{ name: 'carapa-brain', localStackPath: '/host/stacks/carapa-brain' }];
    expect(await resolveOwnedProjects([brain], '/host/stacks', deps)).toEqual(owned);
    expect(await resolveOwnedProjects([brain], '/host/stacks/', deps)).toEqual(owned);
});
