/**
 * Directory-handle based filesystem mutations for sandbox-writable trees.
 *
 * Bun/Node expose no openat/mkdirat/renameat/unlinkat, so a path-based write
 * races with a sandbox agent swapping a parent directory for a symlink between
 * check and use. This module calls those syscalls through bun:ffi: the tree is
 * walked once with O_NOFOLLOW directory handles and every later operation is
 * relative to a held handle, so a swapped path can no longer redirect it.
 *
 * Note: O_DIRECTORY is deliberately NOT combined with O_NOFOLLOW (gVisor
 * followed symlinks for that combination); directories are verified with fstat.
 */
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { logger } from "../logger.js";
import { IpcPathError } from "./safe-open.js";

interface Libc {
    openat(dirFd: number, name: Buffer, flags: number, mode: number): number;
    mkdirat(dirFd: number, name: Buffer, mode: number): number;
    renameat(srcFd: number, src: Buffer, dstFd: number, dst: Buffer): number;
    unlinkat(dirFd: number, name: Buffer, flags: number): number;
    fcntl(fd: number, cmd: number, arg: Buffer): number;
    errno(): number;
}

const IS_DARWIN = process.platform === "darwin";
const AT_REMOVEDIR = IS_DARWIN ? 0x80 : 0x200;
const F_GETPATH = 50;
// openat/fcntl are variadic in libc and bun:ffi cannot declare that. On Apple
// arm64 variadic arguments are passed on the stack, so the argument after the
// fixed ones must be pushed past x7 with padding to land at [sp].
const DARWIN_ARM64 = IS_DARWIN && process.arch === "arm64";
const PAD = (n: number): FFIType[] => Array.from({ length: n }, () => FFIType.i32);

const errnoNames = new Map<number, string>(Object.entries(os.constants.errno).map(([name, num]) => [num as number, name]));

let libc: Libc | undefined;
let unavailable: string | undefined;

function load(): Libc {
    if (libc) return libc;
    if (unavailable) throw new IpcPathError(unavailable, "EUNSUPPORTED");
    try {
        const candidates = IS_DARWIN ? ["libc.dylib", "libSystem.B.dylib"] : process.platform === "linux" ? ["libc.so.6"] : [];
        if (!candidates.length) throw new Error(`unsupported platform ${process.platform}`);
        const errnoSymbol = IS_DARWIN ? "__error" : "__errno_location";
        let lastError: unknown;
        for (const candidate of candidates) {
            try {
                const lib = dlopen(candidate, {
                    openat: { args: DARWIN_ARM64 ? [FFIType.i32, FFIType.ptr, FFIType.i32, ...PAD(5), FFIType.u32] : [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
                    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
                    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
                    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
                    fcntl: { args: DARWIN_ARM64 ? [FFIType.i32, FFIType.i32, ...PAD(6), FFIType.ptr] : [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
                    [errnoSymbol]: { args: [], returns: FFIType.ptr },
                });
                const s = lib.symbols;
                const errnoFn = s[errnoSymbol] as unknown as () => Pointer | null;
                // Padded variadic bindings take the extra zero arguments here.
                const rawOpenat = s.openat as unknown as (...a: unknown[]) => number;
                const rawFcntl = s.fcntl as unknown as (...a: unknown[]) => number;
                libc = {
                    openat: DARWIN_ARM64
                        ? (d, n, f, m) => rawOpenat(d, n, f, 0, 0, 0, 0, 0, m)
                        : (d, n, f, m) => rawOpenat(d, n, f, m),
                    fcntl: DARWIN_ARM64
                        ? (fd, cmd, a) => rawFcntl(fd, cmd, 0, 0, 0, 0, 0, 0, a)
                        : (fd, cmd, a) => rawFcntl(fd, cmd, a),
                    mkdirat: s.mkdirat, renameat: s.renameat, unlinkat: s.unlinkat,
                    errno: () => { const p = errnoFn(); return p ? read.i32(p) : 0; },
                } as Libc;
                return libc;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    } catch (error) {
        unavailable = `fd-relative IPC syscalls are unavailable (${error instanceof Error ? error.message : String(error)}); refusing path-based writes`;
        throw new IpcPathError(unavailable, "EUNSUPPORTED");
    }
}

/** Whether fd-relative syscalls work on this host. Logs once. */
let reported = false;
export function fdPathAvailable(): boolean {
    try {
        load();
        if (!reported) { reported = true; logger.info("[IPC] fd-path active: IPC/group writes use openat/renameat/unlinkat"); }
        return true;
    } catch (error) {
        if (!reported) { reported = true; logger.error({ err: (error as Error).message }, "[IPC] fd-path unavailable: IPC/group writes are refused"); }
        return false;
    }
}

/** A directory entry name: a string, or raw bytes when listed from disk (names need not be UTF-8). */
type EntryName = string | Buffer;

function errnoError(syscall: string, name: EntryName): NodeJS.ErrnoException {
    const errno = load().errno();
    const code = errnoNames.get(errno) ?? `E${errno}`;
    const error: NodeJS.ErrnoException = new Error(`${code}: ${syscall} '${name}'`);
    error.code = code;
    error.errno = -errno;
    error.syscall = syscall;
    return error;
}

function cstr(name: EntryName): Buffer {
    return Buffer.concat([Buffer.from(name), Buffer.alloc(1)]);
}

function checkName(name: EntryName): void {
    const bytes = Buffer.from(name);
    if (!bytes.length || bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from("..")) || bytes.includes(0x2f) || bytes.includes(0)) {
        throw new IpcPathError(`Invalid IPC path segment: ${JSON.stringify(bytes.toString("latin1"))}`);
    }
}

function closeQuiet(fd: number): void {
    try { fs.closeSync(fd); } catch { /* already closed */ }
}

const c = fs.constants;
// fs.constants has no O_CLOEXEC in Node/Bun; the value is platform specific.
const O_CLOEXEC = IS_DARWIN ? 0x1000000 : 0x80000;
const NOFOLLOW_FLAGS = c.O_NOFOLLOW | O_CLOEXEC | c.O_NONBLOCK;

function rawOpen(dirFd: number, name: EntryName, flags: number, mode = 0): number {
    checkName(name);
    const fd = load().openat(dirFd, cstr(name), flags, mode);
    if (fd < 0) throw errnoError("openat", name);
    return fd;
}

/** Open a child directory handle without following symlinks. Caller closes. */
function openDirAt(dirFd: number, name: EntryName): number {
    let fd: number;
    try {
        fd = rawOpen(dirFd, name, c.O_RDONLY | NOFOLLOW_FLAGS);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new IpcPathError(`IPC path escapes project directory: ${name} is a symlink`, "ELOOP");
        }
        throw error;
    }
    let isDir = false;
    try { isDir = fs.fstatSync(fd).isDirectory(); } catch (error) { closeQuiet(fd); throw error; }
    if (!isDir) {
        closeQuiet(fd);
        throw new IpcPathError(`IPC parent is not a directory: ${name}`, "ENOTDIR");
    }
    return fd;
}

/**
 * Walk `segments` below `rootAbs` with directory handles and return the handle
 * of the final directory (caller closes it). Symlinked components are refused.
 */
export function openDirChain(rootAbs: string, segments: string[], opts: { create?: boolean } = {}): number {
    load();
    if (opts.create) fs.mkdirSync(rootAbs, { recursive: true });
    let fd = fs.openSync(rootAbs, c.O_RDONLY | c.O_DIRECTORY | O_CLOEXEC);
    try {
        for (const segment of segments) {
            let next: number;
            try {
                next = openDirAt(fd, segment);
            } catch (error) {
                if (!opts.create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                try {
                    mkdirAt(fd, segment);
                } catch (mkErr) {
                    if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr; // lost a race: re-open below
                }
                next = openDirAt(fd, segment);
            }
            closeQuiet(fd);
            fd = next;
        }
        return fd;
    } catch (error) {
        closeQuiet(fd);
        throw error;
    }
}

/** Open a regular file relative to dirFd (never follows a leaf symlink). Caller closes. */
export function openFileAt(dirFd: number, name: string, flags: number, mode = 0o644): number {
    let fd: number;
    try {
        fd = rawOpen(dirFd, name, flags | NOFOLLOW_FLAGS, mode);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw new IpcPathError(`IPC path is a symlink: ${name}`, "ELOOP");
        // A write-open of a FIFO without a reader fails with ENXIO instead of blocking.
        if (code === "ENXIO") throw new IpcPathError(`IPC path is not a regular file: ${name}`, "ENOTREG");
        throw error;
    }
    // Newly created files get an explicit mode even if a variadic ABI mismatch dropped it.
    if (flags & c.O_EXCL && flags & c.O_CREAT) {
        try { fs.fchmodSync(fd, mode); } catch (error) { closeQuiet(fd); throw error; }
    }
    let isFile = false;
    try { isFile = fs.fstatSync(fd).isFile(); } catch (error) { closeQuiet(fd); throw error; }
    if (!isFile) {
        closeQuiet(fd);
        throw new IpcPathError(`IPC path is not a regular file: ${name}`, "ENOTREG");
    }
    return fd;
}

export function unlinkAt(dirFd: number, name: EntryName, removeDir = false): void {
    checkName(name);
    if (load().unlinkat(dirFd, cstr(name), removeDir ? AT_REMOVEDIR : 0) < 0) throw errnoError("unlinkat", name);
}

export function mkdirAt(dirFd: number, name: string, mode = 0o755): void {
    checkName(name);
    if (load().mkdirat(dirFd, cstr(name), mode) < 0) throw errnoError("mkdirat", name);
}

export function renameAt(srcDirFd: number, srcName: string, dstDirFd: number, dstName: string): void {
    checkName(srcName);
    checkName(dstName);
    if (load().renameat(srcDirFd, cstr(srcName), dstDirFd, cstr(dstName)) < 0) throw errnoError("renameat", srcName);
}

/** Write all of `data` to `fd`, looping over short writes. */
export function writeAllSync(fd: number, data: Buffer): void {
    let written = 0;
    while (written < data.length) written += fs.writeSync(fd, data, written, data.length - written);
}

/** Write a temp file in dirFd then rename over `name`; a symlink at `name` is replaced, not followed. */
export function writeAtomicAt(dirFd: number, name: string, data: Buffer): void {
    checkName(name);
    const tmp = `.${name}.${randomUUID()}.tmp`;
    const fd = openFileAt(dirFd, tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL, 0o644);
    try {
        try {
            writeAllSync(fd, data);
            fs.fsyncSync(fd);
        } finally {
            closeQuiet(fd);
        }
        renameAt(dirFd, tmp, dirFd, name);
    } catch (error) {
        try { unlinkAt(dirFd, tmp); } catch { /* tmp already gone */ }
        throw error;
    }
}

/** Real path of an open descriptor on macOS (fcntl F_GETPATH). */
export function darwinFdPath(fd: number): string {
    return darwinFdPathBytes(fd).toString("utf8");
}

function darwinFdPathBytes(fd: number): Buffer {
    const buf = Buffer.alloc(1024);
    if (load().fcntl(fd, F_GETPATH, buf) < 0) throw errnoError("fcntl", "F_GETPATH");
    return buf.subarray(0, buf.indexOf(0));
}

/** Entry names of an open directory handle, as raw bytes so non-UTF-8 names round-trip to unlinkat. */
function listDirFd(fd: number): Buffer[] {
    return fs.readdirSync(IS_DARWIN ? darwinFdPathBytes(fd) : `/proc/self/fd/${fd}`, { encoding: "buffer" });
}

/**
 * Remove `name` below dirFd. Symlinks are unlinked, never followed. A missing
 * entry is not an error. A directory needs `recursive`.
 */
export function removeTreeAt(dirFd: number, name: EntryName, recursive: boolean): void {
    checkName(name);
    try {
        unlinkAt(dirFd, name);
        return;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        // Linux reports EISDIR for a directory, POSIX/darwin EPERM.
        if (code !== "EISDIR" && code !== "EPERM") throw error;
    }
    if (!recursive) {
        const error: NodeJS.ErrnoException = new Error(`EISDIR: ${name} is a directory`);
        error.code = "EISDIR";
        throw error;
    }
    let fd: number;
    try {
        fd = openDirAt(dirFd, name);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    try {
        for (const entry of listDirFd(fd)) removeTreeAt(fd, entry, true);
    } finally {
        closeQuiet(fd);
    }
    try {
        unlinkAt(dirFd, name, true);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/** Run `fn` with the handle of the parent directory of `segments`, closing it afterwards. */
export function withParent<T>(rootAbs: string, segments: string[], opts: { create?: boolean }, fn: (dirFd: number, leaf: string) => T): T {
    if (!segments.length) throw new IpcPathError("IPC path is empty");
    const fd = openDirChain(rootAbs, segments.slice(0, -1), opts);
    try {
        return fn(fd, segments[segments.length - 1]);
    } finally {
        closeQuiet(fd);
    }
}

export { closeQuiet as closeFd };
