/**
 * Two-way IPC replication between Box (owner of the IPC tree) and Board
 * (which keeps a local replica for its run lifecycle, transcripts and
 * recovery sweeps).
 *
 * Board sends the last state both sides agreed on (`base`) plus its own local
 * changes (`push`). Box applies the pushes first, then returns everything that
 * differs remotely from `base`:
 *  - large files grow append-only (logs, JSONL streams) and are resumed by
 *    byte offset;
 *  - small files are re-sent whole whenever they change;
 *  - paths in `base` that no longer exist are reported as deleted.
 *
 * Completion markers (exit_code, metrics_complete, metrics.json) are only
 * returned once every other file in the root has been sent completely, so a
 * replica never observes "finished" before it holds the full output.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import { IpcStore, validateRelativePath } from "./ipc-store.js";
import { assertParentSafe, openContained, readdirContained } from "./safe-open.js";

export const REPLICA_MARKER = ".carapa-board-replica";
export const SMALL_FILE_BYTES = 64 * 1024;
export const DEFAULT_SYNC_BUDGET = 8 * 1024 * 1024;
export const MAX_SYNC_BUDGET = 32 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_DEPTH = 8;

/** Written last by the runtime; never replicate them ahead of their data. */
export const MARKER_NAMES = new Set(["exit_code", "metrics_complete", "metrics.json"]);

/** Runtime-private directories Board never reads. */
export const EXCLUDED_DIRS = new Set([
    "launch.lock", "lifecycle.lock", "claude-session", "pi-rpc", "hermes-home", "native-history", "node_modules", ".git",
]);

/**
 * Streams that only ever grow: a larger size means appended bytes. Every other
 * file is re-sent whole when it changes (a rewritten artifact must never be
 * reassembled from an old prefix).
 */
export function isAppendOnly(rel: string): boolean {
    return /\.(jsonl|log|out)$/.test(path.basename(rel));
}

export type BaseEntry = [size: number, mtimeMs: number | null];

export interface SyncPushOp {
    op: "write" | "remove" | "mkdir";
    path: string;
    data?: string;
    /** Write at this byte offset (truncating there first) instead of replacing. */
    offset?: number;
    recursive?: boolean;
}

export interface SyncRequest {
    root: string;
    base?: Record<string, BaseEntry>;
    push?: SyncPushOp[];
    maxBytes?: number;
    replicaId?: string;
    /** Extra directory names to skip (caller-owned data, e.g. Board logs). */
    exclude?: string[];
}

export interface SyncFile {
    path: string;
    size: number;
    mtimeMs: number;
    offset: number;
    data: string;
    replace: boolean;
    complete: boolean;
}

export interface SyncResponse {
    shared?: boolean;
    pushed: Array<{ path: string; ok: boolean; error?: string; size?: number; mtimeMs?: number }>;
    files: SyncFile[];
    dirs: string[];
    deleted: string[];
    more: boolean;
    /** The walk hit its file limit: deletions are not reported this cycle. */
    truncated?: boolean;
    /** This Box cannot see the tree (e.g. IPC_MOUNT not mounted into a containerised Box). */
    unavailable?: string;
    /**
     * Files that exist but could not be read (EACCES, EISDIR, EIO, ...). They are
     * absent from `files` but do not set `more`, so completion markers are still
     * sent and the client does not loop. Files removed mid-sync (ENOENT) are not listed.
     * Directories whose listing failed are named too (`.` for the root); nothing
     * below them is reported as deleted.
     */
    unreadable?: Array<{ path: string; code: string }>;
}

interface WalkEntry { rel: string; abs: string; size: number; mtimeMs: number }

async function walk(root: string, dir: string, prefix: string, depth: number, files: WalkEntry[], dirs: string[], excluded: Set<string>, blocked: Array<{ path: string; code: string }>): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
        entries = await readdirContained(root, dir);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
        // ENOENT: the directory is really gone, so deleting its files is correct.
        if (code === "ENOENT") return;
        // Anything else must not look like deletions below it.
        blocked.push({ path: prefix, code });
        logger.warn({ path: prefix || ".", code }, "[IPC] Sync skipped an unreadable directory");
        return;
    }
    for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (excluded.has(entry.name)) continue;
            dirs.push(rel);
            await walk(root, abs, rel, depth + 1, files, dirs, excluded, blocked);
        } else if (entry.isFile()) {
            // In-flight atomic writes (IpcStore.write temp files) are not content.
            if (/^\..+\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
            // Never follow symlinks or touch FIFOs/sockets (stdin.fifo would block).
            try {
                const st = await fsp.lstat(abs);
                if (st.isFile()) files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
            } catch { /* removed while walking */ }
        }
    }
}

/** Test-only seam: runs between the walk and the file reads. */
export const syncTestHooks: { afterWalk?: () => Promise<void> } = {};

async function readRange(root: string, file: string, offset: number, length: number): Promise<{ data: Buffer; size: number; mtimeMs: number }> {
    const handle = await openContained(root, file, fs.constants.O_RDONLY);
    try {
        const st = await handle.stat();
        const start = Math.min(offset, st.size);
        const len = Math.max(0, Math.min(length, st.size - start));
        const buffer = Buffer.alloc(len);
        const { bytesRead } = len > 0 ? await handle.read(buffer, 0, len, start) : { bytesRead: 0 };
        return { data: buffer.subarray(0, bytesRead), size: st.size, mtimeMs: st.mtimeMs };
    } finally {
        await handle.close();
    }
}

/** Append-style write for large streams the caller extends (never replaces the prefix). */
async function writeAt(store: IpcStore, rel: string, offset: number, data: Buffer): Promise<void> {
    const file = await store.resolve(rel);
    await assertParentSafe(store.projectDir, file);
    const handle = await openContained(store.projectDir, file, fs.constants.O_RDWR);
    try {
        const { size } = await handle.stat();
        if (size < offset) throw new Error(`Cannot write at offset ${offset}: remote file has ${size} bytes`);
        await handle.truncate(offset);
        if (data.length) await handle.write(data, 0, data.length, offset);
    } finally {
        await handle.close();
    }
}

async function isSharedWithBoard(store: IpcStore, replicaId?: string): Promise<boolean> {
    if (!replicaId) return false;
    try {
        const marker = await fsp.readFile(path.join(path.dirname(store.projectDir), REPLICA_MARKER), "utf8");
        return marker.trim() === replicaId;
    } catch {
        return false;
    }
}

export async function syncIpcRoot(store: IpcStore, request: SyncRequest): Promise<SyncResponse> {
    const response: SyncResponse = { pushed: [], files: [], dirs: [], deleted: [], more: false };
    if (await isSharedWithBoard(store, request.replicaId)) return { ...response, shared: true };
    const treeRoot = path.dirname(store.projectDir);
    try {
        await fsp.access(treeRoot, fsp.constants.W_OK | fsp.constants.X_OK);
    } catch {
        return { ...response, unavailable: `${treeRoot} is not accessible to CarapaBox (containerised Box: set CARAPA_BOX_IPC_HOST_DIR / CARAPA_BOX_GROUPS_ROOT)` };
    }

    const rootSegments = validateRelativePath(request.root ?? "", true);
    const root = rootSegments.join("/");
    const join = (rel: string) => (root ? `${root}/${rel}` : rel);
    const pushedPaths = new Set<string>();

    for (const op of request.push ?? []) {
        try {
            validateRelativePath(op.path);
            const full = join(op.path);
            if (op.op === "write") {
                const data = Buffer.from(op.data ?? "", "base64");
                if (typeof op.offset === "number" && op.offset > 0) await writeAt(store, full, op.offset, data);
                else await store.write(full, data, "atomic");
                const st = await fsp.stat(await store.resolve(full));
                response.pushed.push({ path: op.path, ok: true, size: st.size, mtimeMs: st.mtimeMs });
                pushedPaths.add(op.path);
            } else if (op.op === "remove") {
                await store.remove(full, op.recursive === true);
                response.pushed.push({ path: op.path, ok: true });
                pushedPaths.add(op.path);
            } else if (op.op === "mkdir") {
                await store.mkdir(full);
                response.pushed.push({ path: op.path, ok: true });
            } else {
                response.pushed.push({ path: op.path, ok: false, error: "Unknown push operation" });
            }
        } catch (error) {
            response.pushed.push({ path: op.path, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }

    const rootAbs = await store.resolve(root, true);
    const files: WalkEntry[] = [];
    const excluded = new Set([...EXCLUDED_DIRS, ...(request.exclude ?? []).filter(name => typeof name === "string")]);
    const blocked: Array<{ path: string; code: string }> = [];
    await walk(store.projectDir, rootAbs, "", 0, files, response.dirs, excluded, blocked);
    if (blocked.length) response.unreadable = blocked.map(b => ({ path: b.path || ".", code: b.code }));
    await syncTestHooks.afterWalk?.();
    const base = request.base ?? {};
    const present = new Set(files.map(f => f.rel));
    if (files.length >= MAX_FILES) {
        response.truncated = true;
    } else {
        for (const rel of Object.keys(base)) {
            if (present.has(rel) || pushedPaths.has(rel)) continue;
            if (blocked.some(b => b.path === "" || rel === b.path || rel.startsWith(`${b.path}/`))) continue;
            response.deleted.push(rel);
        }
    }

    // Markers last: their presence must imply the data before them is complete.
    files.sort((a, b) => Number(MARKER_NAMES.has(path.basename(a.rel))) - Number(MARKER_NAMES.has(path.basename(b.rel))));
    let budget = Math.max(1, Math.min(request.maxBytes ?? DEFAULT_SYNC_BUDGET, MAX_SYNC_BUDGET));
    let incomplete = false;

    for (const file of files) {
        if (pushedPaths.has(file.rel)) continue;
        const isMarker = MARKER_NAMES.has(path.basename(file.rel));
        if (isMarker && incomplete) { response.more = true; continue; }
        const known = base[file.rel];
        let offset = 0;
        let replace = true;
        const small = file.size <= SMALL_FILE_BYTES;
        if (known) {
            const [size, mtime] = known;
            const stream = !small && isAppendOnly(file.rel);
            if (file.size === size && (mtime === file.mtimeMs || (mtime === null && stream))) continue;
            if (file.size === size && stream) {
                // Same length, new mtime on an append-only stream: metadata only.
                response.files.push({ path: file.rel, size: file.size, mtimeMs: file.mtimeMs, offset: size, data: "", replace: false, complete: true });
                continue;
            }
            // Resume a stream (also a partially received one: mtime null).
            if (file.size > size && (stream || (mtime === null && !small))) { offset = size; replace = false; }
        }
        // Small files are never split: a partial copy could not be told apart
        // from a stale one. Only large append-only streams resume by offset.
        if (budget <= 0 || (small && file.size > budget && response.files.length > 0)) { incomplete = true; response.more = true; continue; }
        let chunk;
        try {
            chunk = await readRange(store.projectDir, file.abs, offset, small ? Math.max(budget, SMALL_FILE_BYTES) : budget);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") continue; // removed between walk and read; reported next cycle
            const reported = code ?? "UNKNOWN";
            (response.unreadable ??= []).push({ path: file.rel, code: reported });
            logger.warn({ path: file.rel, code: reported }, "[IPC] Sync skipped an unreadable file");
            continue;
        }
        budget -= chunk.data.length;
        const complete = offset + chunk.data.length >= chunk.size;
        if (!complete) { incomplete = true; response.more = true; }
        response.files.push({
            path: file.rel,
            size: chunk.size,
            mtimeMs: chunk.mtimeMs,
            offset,
            data: chunk.data.toString("base64"),
            replace,
            complete,
        });
    }
    return response;
}
