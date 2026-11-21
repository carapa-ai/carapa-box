/**
 * Descriptor-based containment helpers for the sandbox-writable IPC/group trees.
 *
 * A sandbox agent can plant or swap symlinks in these trees at any time, so a
 * path check followed by a path-based open is racy. Reads therefore open with
 * O_NOFOLLOW|O_NONBLOCK, require a regular file, and verify the descriptor's
 * own location (/proc/self/fd/<fd>) is inside the root; data is only read from
 * that verified handle.
 * Mutations (write/remove/mkdir/rename) live in fd-path.ts and are fully
 * directory-handle relative.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { darwinFdPath } from "./fd-path.js";

export class IpcPathError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
    }
}

export function isInside(root: string, real: string): boolean {
    return real === root || real.startsWith(root + path.sep);
}

export async function realRoot(root: string): Promise<string> {
    return fsp.realpath(root).catch(() => root);
}

let darwinResolver: (fd: number) => string = darwinFdPath;
/** Test hook: replace the macOS F_GETPATH resolver. Returns a restore function. */
export function setDarwinFdResolver(resolver: (fd: number) => string): () => void {
    const prev = darwinResolver;
    darwinResolver = resolver;
    return () => { darwinResolver = prev; };
}

/** Real path of an open fd: /proc/self/fd on linux, F_GETPATH on macOS (no /proc there). */
async function resolveFd(fd: number): Promise<string> {
    if (process.platform === "darwin") return fsp.realpath(darwinResolver(fd));
    return fsp.realpath(`/proc/self/fd/${fd}`);
}

async function fdPath(handle: fsp.FileHandle, rootReal: string, what: string): Promise<string> {
    const real = await resolveFd(handle.fd);
    if (!isInside(rootReal, real)) throw new IpcPathError(`IPC path escapes project directory: ${what}`, "EESCAPE");
    return real;
}

/** Open a regular file without following a leaf symlink and verify it lives inside root. */
export async function openContained(root: string, abs: string, flags: number, mode = 0o644): Promise<fsp.FileHandle> {
    const c = fs.constants;
    const rootReal = await realRoot(root);
    let handle: fsp.FileHandle;
    try {
        handle = await fsp.open(abs, flags | c.O_NOFOLLOW | c.O_NONBLOCK, mode);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw new IpcPathError(`IPC path is a symlink: ${path.basename(abs)}`, "ELOOP");
        // A write-open of a FIFO without a reader fails with ENXIO instead of blocking.
        if (code === "ENXIO") throw new IpcPathError(`IPC path is not a regular file: ${path.basename(abs)}`, "ENOTREG");
        throw error;
    }
    try {
        if (!(await handle.stat()).isFile()) throw new IpcPathError(`IPC path is not a regular file: ${path.basename(abs)}`, "ENOTREG");
        await fdPath(handle, rootReal, path.basename(abs));
        return handle;
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
}

/** List a directory through a verified descriptor (never trusts a swapped-in symlink). */
export async function readdirContained(root: string, abs: string): Promise<fs.Dirent[]> {
    const c = fs.constants;
    const rootReal = await realRoot(root);
    const handle = await fsp.open(abs, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW | c.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ELOOP" || error.code === "ENOTDIR") throw new IpcPathError(`IPC path is not a directory: ${path.basename(abs)}`, "ENOTDIR");
        throw error;
    });
    try {
        const real = await fdPath(handle, rootReal, path.basename(abs));
        return await fsp.readdir(process.platform === "darwin" ? real : `/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    } finally {
        await handle.close();
    }
}

/**
 * Immediately before a mutation: the parent must be a real directory (not a
 * symlink) inside root and the leaf must not be a symlink.
 */
export async function assertParentSafe(root: string, abs: string): Promise<void> {
    const rootReal = await realRoot(root);
    const parent = path.dirname(abs);
    const st = await fsp.lstat(parent);
    if (!st.isDirectory()) throw new IpcPathError(`IPC parent is not a directory: ${path.basename(parent)}`, "ENOTDIR");
    const real = await fsp.realpath(parent);
    if (!isInside(rootReal, real)) throw new IpcPathError(`IPC path escapes project directory: ${path.basename(abs)}`, "EESCAPE");
    const leaf = await fsp.lstat(abs).catch(() => null);
    if (leaf?.isSymbolicLink()) throw new IpcPathError(`IPC path is a symlink: ${path.basename(abs)}`, "ELOOP");
}
