import { expect, test } from 'bun:test';
import { boundedStatusReader } from './status-reader.js';

test('many simultaneous polls stay bounded, share work, and refresh after success or failure', async () => {
    let active = 0, maximum = 0, calls = 0;
    const read = boundedStatusReader(async (_stack, project) => {
        calls++;
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        if (project === 'failed') throw new Error('docker unavailable');
        return project;
    });
    const polls = Array.from({ length: 80 }, (_, i) => read('/stacks/test', `instance-${i % 40}`));
    const results = await Promise.allSettled([...polls, read('/stacks/test', 'failed')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(80);
    expect(calls).toBe(41);
    expect(maximum).toBe(4);
    expect(await read('/stacks/test', 'instance-0')).toBe('instance-0');
    await expect(read('/stacks/test', 'failed')).rejects.toThrow('docker unavailable');
    expect(calls).toBe(43);
});

test('a fresh read does not join an in-flight read and leaves its own entry shared', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const read = boundedStatusReader(async () => {
        const call = ++calls;
        await new Promise<void>(resolve => releases.push(resolve));
        return `read-${call}`;
    });
    const stale = read('/stacks/test', 'p');
    await new Promise(resolve => setTimeout(resolve, 1));
    const fresh = read('/stacks/test', 'p', { fresh: true });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(calls).toBe(2);
    releases[0]();
    expect(await stale).toBe('read-1');
    // The stale read finishing must not drop the fresh read's shared entry.
    expect(read('/stacks/test', 'p')).toBe(fresh);
    releases[1]();
    expect(await fresh).toBe('read-2');
});
