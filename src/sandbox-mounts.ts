import path from "node:path";
import fsp from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ensureBaseVolume, MOUNT_PATH_ENV_KEYS, mountVolumeName, pinMountSource, type DockerRunner, type MountPin } from "./security.js";

const STACK_MOUNTS_FILE = "stack-mounts.yaml";

/**
 * Read the extra host mounts a stack declares in stack-mounts.yaml:
 *   mounts: [{ name: CARAPA_BOX, path: "${CARAPA_REPO}/carapa-box" }]
 * `${VAR}` in a path expands from the compose env only. Compose consumes each
 * as MOUNT_<name>_VOLUME + MOUNT_<name>_SUBPATH, like the fixed mount keys.
 */
async function loadStackMounts(stackDir: string, composeEnv: Record<string, string>): Promise<Array<{ name: string; path: string }>> {
    let raw: string;
    try {
        raw = await fsp.readFile(path.join(stackDir, STACK_MOUNTS_FILE), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const entries: unknown = (parseYaml(raw) as { mounts?: unknown } | null)?.mounts ?? [];
    if (!Array.isArray(entries)) {
        throw new Error(`[SECURITY] ${STACK_MOUNTS_FILE}: mounts must be a list`);
    }
    const seen = new Set<string>(MOUNT_PATH_ENV_KEYS);
    return entries.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new Error(`[SECURITY] ${STACK_MOUNTS_FILE}: each mount must be an object with name and path`);
        }
        const { name, path: entryPath } = entry as { name?: unknown; path?: unknown };
        if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name) || seen.has(name)) {
            throw new Error(`[SECURITY] ${STACK_MOUNTS_FILE}: mount name ${JSON.stringify(name)} is invalid or duplicated`);
        }
        seen.add(name);
        if (typeof entryPath !== "string" || !entryPath) {
            throw new Error(`[SECURITY] ${STACK_MOUNTS_FILE}: mount ${name} has no path`);
        }
        const expanded = entryPath.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
            const value = composeEnv[key];
            if (!value) throw new Error(`[SECURITY] ${STACK_MOUNTS_FILE}: mount ${name} uses unset variable ${key}`);
            return value;
        });
        return { name, path: expanded };
    });
}

/**
 * Describe each validated mount source as <KEY>_VOLUME + <KEY>_SUBPATH for
 * compose, creating the per-base bind volumes. Unset EXTRA slots and GROUP_DIR use a
 * box-owned volume for the stack directory (subpath "empty"). Throws on any
 * failure; nothing is exported as a host path.
 */
export async function pinSandboxMounts(
    composeEnv: Record<string, string>,
    projectName: string,
    stackDirHost: string,
    docker: DockerRunner,
    stackDir: string = stackDirHost,
): Promise<{ env: Record<string, string>; pins: MountPin[] }> {
    const env: Record<string, string> = {};
    const pins: MountPin[] = [];
    const volumes = new Map<string, string>();
    const pinMount = async (key: string, value: string): Promise<void> => {
        const pinned = await pinMountSource(value);
        volumes.set(pinned.volume, pinned.base);
        env[`${key}_VOLUME`] = pinned.volume;
        env[`${key}_SUBPATH`] = pinned.subpath;
        pins.push({ key, value, base: pinned.base, subpath: pinned.subpath });
    };
    for (const key of MOUNT_PATH_ENV_KEYS) {
        const configured = composeEnv[key];
        if (!configured) {
            if (key.startsWith("EXTRA_MOUNT_") || key === "GROUP_DIR") {
                const volume = mountVolumeName(stackDirHost);
                volumes.set(volume, stackDirHost);
                env[`${key}_VOLUME`] = volume;
                env[`${key}_SUBPATH`] = "empty";
            }
            continue;
        }
        const value = key === "IPC_MOUNT" ? path.join(configured, projectName) : configured;
        await pinMount(key, value);
    }
    for (const mount of await loadStackMounts(stackDir, composeEnv)) {
        await pinMount(`MOUNT_${mount.name}`, mount.path);
    }
    for (const [volume, base] of volumes) await ensureBaseVolume(base, volume, docker);
    return { env, pins };
}
