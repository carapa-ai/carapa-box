/**
 * Box-owned sandbox IPC store.
 *
 * Each sandbox project (`<stack>-<instance>`) has an IPC directory that is
 * bind-mounted into the agent container at /workspace/ipc. Board no longer
 * reads or writes it directly: every access goes through the scoped
 * operations below, so Board and Box can live on different hosts.
 *
 * Paths are always relative to the project IPC directory, use a strict
 * segment grammar, and are re-checked after symlink resolution.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseEnvFile } from "../utils.js";
import { IpcPathError, isInside, openContained, readdirContained, realRoot } from "./safe-open.js";
import { closeFd, openDirChain, openFileAt, removeTreeAt, renameAt, withParent, writeAllSync, writeAtomicAt } from "./fd-path.js";

export { IpcPathError };

/** Largest payload returned by a single read (bytes, before base64). */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Largest payload accepted by a single write (bytes, after decoding). */
export const MAX_WRITE_BYTES = 64 * 1024 * 1024;

// Dot-files (.mcp.json, .claude/, .cleanup-complete) are allowed; "." and ".." never.
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9._@+=-]{0,199}$/;

/**
 * IPC root as visible to this Box process.
 *
 * The host path matches sandbox_start (stack .env IPC_MOUNT > IPC_MOUNT >
 * CARAPA_DATA_DIR/data/ipc). A containerised Box sees the host directory
 * CARAPA_BOX_IPC_HOST_DIR mounted at CARAPA_BOX_IPC_DIR and translates; without
 * that host directory the IPC tree is not mounted and the host path is returned.
 */
export async function resolveIpcRoot(stackPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
    const stackEnv = stackPath ? await parseEnvFile(path.join(stackPath, ".env")) : {};
    const hostRoot = stackEnv.IPC_MOUNT
        || env.IPC_MOUNT
        || (env.CARAPA_DATA_DIR ? path.join(env.CARAPA_DATA_DIR, "data", "ipc") : undefined)
        || env.CARAPA_BOX_IPC_HOST_DIR;
    if (!hostRoot) throw new IpcPathError("IPC directory is not configured (set IPC_MOUNT)");
    const hostBase = env.CARAPA_BOX_IPC_HOST_DIR;
    if (!env.CARAPA_BOX_IPC_DIR || !hostBase) return hostRoot;
    const relative = path.relative(path.resolve(hostBase), path.resolve(hostRoot));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new IpcPathError(`IPC_MOUNT ${hostRoot} is outside the IPC directory mounted into CarapaBox (${hostBase})`);
    }
    return path.join(env.CARAPA_BOX_IPC_DIR, relative);
}

/**
 * Group directories root as seen by this Box process (multi-host placement).
 * CARAPA_BOX_GROUPS_ROOT is the host path used for sandbox bind mounts; a
 * containerised Box reads it at CARAPA_BOX_GROUPS_DIR.
 */
export function resolveGroupsRoot(env: NodeJS.ProcessEnv = process.env): string {
    const root = env.CARAPA_BOX_GROUPS_DIR || env.CARAPA_BOX_GROUPS_ROOT;
    if (!root) throw new IpcPathError("Group directories are not configured on this box (set CARAPA_BOX_GROUPS_ROOT)");
    return root;
}

/**
 * Resolve a logical mount reference sent by Board for a remote box:
 *   @group[/<folder>...] -> CARAPA_BOX_GROUPS_ROOT[/...]
 *   @repo/<name>[/...]   -> CARAPA_BOX_REPOS_ROOT/<name>[/...]
 * Other values are returned unchanged (legacy absolute host paths).
 */
export function resolveLogicalMount(value: string, env: NodeJS.ProcessEnv = process.env): string {
    const match = /^@(group|repo)(?:\/(.*))?$/.exec(value);
    if (!match) return value;
    const [, kind, rest = ""] = match;
    const root = kind === "group" ? env.CARAPA_BOX_GROUPS_ROOT : env.CARAPA_BOX_REPOS_ROOT;
    if (!root) {
        throw new IpcPathError(`${value} needs ${kind === "group" ? "CARAPA_BOX_GROUPS_ROOT" : "CARAPA_BOX_REPOS_ROOT"} on this box`);
    }
    if (kind === "repo" && !rest) throw new IpcPathError("@repo requires a repository name");
    const segments = validateRelativePath(rest, kind === "group");
    return path.join(root, ...segments);
}

export function validateRelativePath(rel: string, allowEmpty = false): string[] {
    if (typeof rel !== "string") throw new IpcPathError("IPC path must be a string");
    const trimmed = rel.replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
        if (allowEmpty) return [];
        throw new IpcPathError("IPC path is empty");
    }
    const segments = trimmed.split("/");
    for (const segment of segments) {
        if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
            throw new IpcPathError(`Invalid IPC path segment: ${JSON.stringify(segment)}`);
        }
    }
    return segments;
}

/** A project-scoped view of the IPC tree. */
export class IpcStore {
    constructor(readonly projectDir: string) {}

    static async forProject(projectName: string, stackPath?: string): Promise<IpcStore> {
        validateRelativePath(projectName);
        if (projectName.includes("/")) throw new IpcPathError("Invalid project name");
        return new IpcStore(path.join(await resolveIpcRoot(stackPath), projectName));
    }

    /** Resolve a relative path, refusing anything that escapes the project dir via symlinks. */
    async resolve(rel: string, allowEmpty = false): Promise<string> {
        const segments = validateRelativePath(rel, allowEmpty);
        const target = path.join(this.projectDir, ...segments);
        const root = await realRoot(this.projectDir);
        // A dangling symlink must not be treated as "does not exist yet".
        const link = await fsp.lstat(target).catch(() => null);
        if (link?.isSymbolicLink() && !(await fsp.realpath(target).then(() => true, () => false))) {
            throw new IpcPathError(`IPC path is a dangling symlink: ${rel}`);
        }
        // Walk up to the deepest existing ancestor and check its real path.
        let probe = target;
        while (true) {
            try {
                const real = await fsp.realpath(probe);
                if (!isInside(root, real)) {
                    throw new IpcPathError(`IPC path escapes project directory: ${rel}`);
                }
                break;
            } catch (error) {
                if (error instanceof IpcPathError) throw error;
                const parent = path.dirname(probe);
                if (parent === probe || !parent.startsWith(this.projectDir)) break;
                probe = parent;
            }
        }
        return target;
    }

    async stat(rel: string): Promise<IpcStat> {
        const file = await this.resolve(rel, true);
        try {
            const st = await fsp.stat(file);
            return { exists: true, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
        } catch {
            return { exists: false, isDir: false, size: 0, mtimeMs: 0 };
        }
    }

    async read(rel: string, offset = 0, maxBytes = MAX_READ_BYTES): Promise<IpcRead> {
        const file = await this.resolve(rel);
        const limit = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES));
        let handle: fsp.FileHandle;
        try {
            handle = await openContained(this.projectDir, file, fs.constants.O_RDONLY);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, data: "", offset, nextOffset: offset, size: 0, eof: true };
            throw error;
        }
        try {
            const { size } = await handle.stat();
            const start = Math.max(0, Math.min(offset, size));
            const length = Math.min(limit, size - start);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
            return {
                exists: true,
                data: buffer.subarray(0, bytesRead).toString("base64"),
                offset: start,
                nextOffset: start + bytesRead,
                size,
                eof: start + bytesRead >= size,
            };
        } finally {
            await handle.close();
        }
    }

    async write(rel: string, data: Buffer, mode: IpcWriteMode = "atomic"): Promise<void> {
        if (data.length > MAX_WRITE_BYTES) throw new IpcPathError(`IPC write exceeds ${MAX_WRITE_BYTES} bytes`);
        const segments = validateRelativePath(rel);
        const c = fs.constants;
        withParent(this.projectDir, segments, { create: true }, (dirFd, leaf) => {
            if (mode === "atomic") return writeAtomicAt(dirFd, leaf, data);
            const fd = openFileAt(dirFd, leaf, mode === "append" ? c.O_WRONLY | c.O_APPEND | c.O_CREAT : c.O_WRONLY | c.O_CREAT | c.O_EXCL);
            try {
                writeAllSync(fd, data);
            } finally {
                closeFd(fd);
            }
        });
    }

    async list(rel: string): Promise<IpcEntry[]> {
        const dir = await this.resolve(rel, true);
        let entries: fs.Dirent[];
        try {
            entries = await readdirContained(this.projectDir, dir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        const out: IpcEntry[] = [];
        for (const entry of entries) {
            try {
                const st = await fsp.lstat(path.join(dir, entry.name));
                out.push({ name: entry.name, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs });
            } catch { /* removed while listing */ }
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    async remove(rel: string, recursive = false): Promise<void> {
        const segments = validateRelativePath(rel);
        try {
            withParent(this.projectDir, segments, {}, (dirFd, leaf) => removeTreeAt(dirFd, leaf, recursive));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }

    async mkdir(rel: string): Promise<void> {
        closeFd(openDirChain(this.projectDir, validateRelativePath(rel, true), { create: true }));
    }

    async rename(from: string, to: string): Promise<void> {
        const source = validateRelativePath(from);
        const target = validateRelativePath(to);
        withParent(this.projectDir, source, {}, (srcFd, srcName) =>
            withParent(this.projectDir, target, { create: true }, (dstFd, dstName) => renameAt(srcFd, srcName, dstFd, dstName)));
    }
}

export type IpcWriteMode = "atomic" | "append" | "exclusive";
export interface IpcStat { exists: boolean; isDir: boolean; size: number; mtimeMs: number }
export interface IpcRead { exists: boolean; data: string; offset: number; nextOffset: number; size: number; eof: boolean }
export interface IpcEntry { name: string; isDir: boolean; size: number; mtimeMs: number }

export type IpcOp =
    | { op: "stat"; path: string }
    | { op: "read"; path: string; offset?: number; maxBytes?: number }
    | { op: "write"; path: string; data: string; encoding?: "utf8" | "base64"; mode?: IpcWriteMode }
    | { op: "list"; path: string }
    | { op: "remove"; path: string; recursive?: boolean }
    | { op: "mkdir"; path: string }
    | { op: "rename"; path: string; to: string };

export type IpcOpResult =
    | ({ ok: true; op: "stat" } & IpcStat)
    | ({ ok: true; op: "read" } & IpcRead)
    | { ok: true; op: "list"; entries: IpcEntry[] }
    | { ok: true; op: "write" | "remove" | "mkdir" | "rename" }
    | { ok: false; op: string; error: string };

/** Apply a batch of operations in order. A failing op does not abort the batch. */
export async function applyIpcOps(store: IpcStore, ops: IpcOp[]): Promise<IpcOpResult[]> {
    const results: IpcOpResult[] = [];
    for (const op of ops) {
        try {
            switch (op.op) {
                case "stat": results.push({ ok: true, op: "stat", ...(await store.stat(op.path)) }); break;
                case "read": results.push({ ok: true, op: "read", ...(await store.read(op.path, op.offset ?? 0, op.maxBytes ?? MAX_READ_BYTES)) }); break;
                case "list": results.push({ ok: true, op: "list", entries: await store.list(op.path) }); break;
                case "write":
                    await store.write(op.path, Buffer.from(op.data, op.encoding === "base64" ? "base64" : "utf8"), op.mode ?? "atomic");
                    results.push({ ok: true, op: "write" });
                    break;
                case "remove": await store.remove(op.path, op.recursive === true); results.push({ ok: true, op: "remove" }); break;
                case "mkdir": await store.mkdir(op.path); results.push({ ok: true, op: "mkdir" }); break;
                case "rename": await store.rename(op.path, op.to); results.push({ ok: true, op: "rename" }); break;
                default: results.push({ ok: false, op: String((op as { op?: unknown }).op), error: "Unknown IPC operation" });
            }
        } catch (error) {
            results.push({ ok: false, op: op.op, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}
