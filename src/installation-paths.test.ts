import { expect, test } from 'bun:test';
import path from 'node:path';
import { getConfigDir, getStateDir } from './installation-paths.js';

test('private host paths and container overrides select the same installation independently of the checkout', () => {
    const keys = ['CARAPA_BOX_HOME', 'CARAPA_BOX_CONFIG_DIR', 'CARAPA_BOX_STATE_DIR'] as const;
    const previous = keys.map(key => process.env[key]);
    try {
        for (const key of keys) delete process.env[key];
        expect(getConfigDir()).toBe(path.resolve(import.meta.dir, '../config'));
        expect(getStateDir()).toBe(path.resolve(import.meta.dir, '../generated'));
        process.env.CARAPA_BOX_HOME = '/private/box';
        expect(getConfigDir()).toBe('/private/box/config');
        expect(getStateDir()).toBe('/private/box/state');
        process.env.CARAPA_BOX_CONFIG_DIR = '/app/config';
        process.env.CARAPA_BOX_STATE_DIR = '/app/generated';
        expect(getConfigDir()).toBe('/app/config');
        expect(getStateDir()).toBe('/app/generated');
    } finally {
        keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
});
