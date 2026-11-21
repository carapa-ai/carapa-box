import fsp from "node:fs/promises";
import path from "node:path";
import { UNSAFE_MOUNT_CHARS, ensureBaseVolume, pinMountSource } from "./security.js";
import type { execDocker } from "./utils.js";

/** Create bind-mount directories as the controller user before Compose can create them as root. */
export async function prepareSandboxDirectory(
    directory: string,
    purpose: "workspace" | "IPC",
    docker?: typeof execDocker,
    pin: typeof pinMountSource = pinMountSource,
): Promise<void> {
    try {
        if (!docker) {
            await fsp.mkdir(directory, { recursive: true });
            await fsp.access(directory, fsp.constants.W_OK | fsp.constants.X_OK);
            return;
        }

        // Host paths may not be mounted in the controller. Mount the existing
        // parent through the allowlist base volume (volume-subpath is resolved
        // without following symlinks; a bind of the path would follow them), then
        // create only the named child. No chown/chmod: existing projects retain their ownership/mode.
        // A root helper under runsc can leave host files owned by nobody.
        const parent = path.dirname(directory);
        if (UNSAFE_MOUNT_CHARS.test(parent) || UNSAFE_MOUNT_CHARS.test(path.basename(directory))) {
            throw new Error("path contains a comma, quote or control character");
        }
        // A directory that is itself an allowlist base has a parent outside the
        // allowlist: mount the base itself and only check it is usable.
        const self = await pin(directory);
        const isBase = self.subpath === ".";
        const pinned = isBase ? self : await pin(parent);
        await ensureBaseVolume(pinned.base, pinned.volume, docker);
        const target = isBase ? "/parent" : `/parent/${path.basename(directory)}`;
        const result = await docker([
            "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true",
            "--user", `${process.getuid!()}:${process.getgid!()}`,
            "--mount", `type=volume,src=${pinned.volume},dst=/parent,volume-subpath=${pinned.subpath},volume-nocopy`,
            "--entrypoint", "/bin/sh", "alpine", "-ec",
            isBase ? 'test -w "$1" && test -x "$1"' : 'mkdir -p -- "$1"; test -w "$1" && test -x "$1"',
            "prepare-directory", target,
        ]);
        if (result.status !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || `helper exited ${result.status}`);
        }
    } catch (error) {
        throw new Error(`Cannot prepare sandbox ${purpose} directory ${directory}: ${error instanceof Error ? error.message : String(error)}. Its parent must exist and the directory must be writable by controller user ${process.getuid!()}:${process.getgid!()}.`);
    }
}
