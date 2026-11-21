import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Container mounts override host paths; unconfigured development keeps local defaults. */
export function getConfigDir(): string {
    return path.resolve(process.env.CARAPA_BOX_CONFIG_DIR ||
        (process.env.CARAPA_BOX_HOME ? path.join(process.env.CARAPA_BOX_HOME, 'config') : path.join(repositoryRoot, 'config')));
}

export function getStateDir(): string {
    return path.resolve(process.env.CARAPA_BOX_STATE_DIR ||
        (process.env.CARAPA_BOX_HOME ? path.join(process.env.CARAPA_BOX_HOME, 'state') : path.join(repositoryRoot, 'generated')));
}
