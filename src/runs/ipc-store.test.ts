import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyIpcOps, IpcPathError, IpcStore, validateRelativePath } from "./ipc-store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function store(): IpcStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-store-"));
    dirs.push(root);
    return new IpcStore(path.join(root, "carapa-bot-demo"));
}

describe("IpcStore", () => {
    it("rejects traversal and malformed segments", () => {
        for (const bad of ["../x", "runs/../../x", "runs/./x", "", "a//b/\u0000", "runs/..", "-flag"]) {
            expect(() => validateRelativePath(bad)).toThrow();
        }
        expect(validateRelativePath("runs/run-1_a/output.v1.jsonl")).toEqual(["runs", "run-1_a", "output.v1.jsonl"]);
        expect(validateRelativePath(".claude/settings.json")).toEqual([".claude", "settings.json"]);
    });

    it("refuses paths escaping through symlinks", async () => {
        const s = store();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-outside-"));
        dirs.push(outside);
        fs.mkdirSync(path.join(s.projectDir, "runs"), { recursive: true });
        fs.symlinkSync(outside, path.join(s.projectDir, "runs", "evil"));
        await expect(s.write("runs/evil/x", Buffer.from("x"))).rejects.toThrow("escapes");
        expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
    });

    it("rejects append to a dangling symlink pointing outside and creates nothing", async () => {
        const s = store();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-outside-"));
        dirs.push(outside);
        fs.mkdirSync(s.projectDir, { recursive: true });
        fs.symlinkSync(path.join(outside, "created.txt"), path.join(s.projectDir, "out.log"));
        await expect(s.write("out.log", Buffer.from("x"), "append")).rejects.toThrow(IpcPathError);
        expect(fs.existsSync(path.join(outside, "created.txt"))).toBe(false);
    });

    it("rejects append to a symlink to an existing outside file and leaves it unchanged", async () => {
        const s = store();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-outside-"));
        dirs.push(outside);
        const victim = path.join(outside, "victim.txt");
        fs.writeFileSync(victim, "original");
        fs.mkdirSync(s.projectDir, { recursive: true });
        fs.symlinkSync(victim, path.join(s.projectDir, "out.log"));
        await expect(s.write("out.log", Buffer.from("x"), "append")).rejects.toThrow(IpcPathError);
        expect(fs.readFileSync(victim, "utf8")).toBe("original");
    });

    it("rejects append to a symlink inside the project dir; regular and new files still append", async () => {
        const s = store();
        fs.mkdirSync(s.projectDir, { recursive: true });
        fs.writeFileSync(path.join(s.projectDir, "real.log"), "a");
        fs.symlinkSync(path.join(s.projectDir, "real.log"), path.join(s.projectDir, "link.log"));
        await expect(s.write("link.log", Buffer.from("x"), "append")).rejects.toThrow("symlink");
        expect(fs.readFileSync(path.join(s.projectDir, "real.log"), "utf8")).toBe("a");
        await s.write("real.log", Buffer.from("b"), "append");
        await s.write("new/fresh.log", Buffer.from("c"), "append");
        expect(fs.readFileSync(path.join(s.projectDir, "real.log"), "utf8")).toBe("ab");
        expect(fs.readFileSync(path.join(s.projectDir, "new", "fresh.log"), "utf8")).toBe("c");
    });

    it.skipIf(process.platform === "win32")("rejects append to a FIFO without hanging", async () => {
        const s = store();
        fs.mkdirSync(s.projectDir, { recursive: true });
        execFileSync("mkfifo", [path.join(s.projectDir, "f")]);
        const outcome = await Promise.race([
            s.write("f", Buffer.from("x"), "append").then(() => "resolved", (error) => error),
            new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
        ]);
        expect(outcome).toBeInstanceOf(IpcPathError);
        expect((outcome as Error).message).toContain("not a regular file");
    });

    it("keeps read/stat/list unchanged for regular files", async () => {
        const s = store();
        await s.write("a/file.txt", Buffer.from("hello"));
        expect(Buffer.from((await s.read("a/file.txt")).data, "base64").toString("utf8")).toBe("hello");
        expect((await s.stat("a/file.txt")).size).toBe(5);
        expect((await s.list("a")).map((e) => e.name)).toEqual(["file.txt"]);
        expect((await s.read("a/missing.txt")).exists).toBe(false);
    });

    it("reads by offset, writes atomically, appends, lists and removes", async () => {
        const s = store();
        const results = await applyIpcOps(s, [
            { op: "write", path: "runs/r1/prompt.txt", data: "hello" },
            { op: "write", path: "runs/r1/output.jsonl", data: "a\n", mode: "append" },
            { op: "write", path: "runs/r1/output.jsonl", data: "b\n", mode: "append" },
            { op: "read", path: "runs/r1/output.jsonl", offset: 2 },
            { op: "read", path: "runs/r1/missing" },
            { op: "list", path: "runs/r1" },
            { op: "write", path: "runs/r1/prompt.txt", data: "again", mode: "exclusive" },
        ]);
        const read = results[3] as { data: string; nextOffset: number; eof: boolean };
        expect(Buffer.from(read.data, "base64").toString()).toBe("b\n");
        expect(read.nextOffset).toBe(4);
        expect(read.eof).toBe(true);
        expect((results[4] as { exists: boolean }).exists).toBe(false);
        expect((results[5] as { entries: { name: string }[] }).entries.map(e => e.name)).toEqual(["output.jsonl", "prompt.txt"]);
        expect(results[6].ok).toBe(false);
        await s.remove("runs/r1", true);
        expect((await s.stat("runs/r1")).exists).toBe(false);
    });
});

describe("resolveIpcRoot", () => {
    it("translates the host IPC path for a containerised Box", async () => {
        const { resolveIpcRoot } = await import("./ipc-store.js");
        expect(await resolveIpcRoot(undefined, { IPC_MOUNT: "/srv/ipc" })).toBe("/srv/ipc");
        expect(await resolveIpcRoot(undefined, { IPC_MOUNT: "/srv/ipc", CARAPA_BOX_IPC_DIR: "/app/ipc" })).toBe("/srv/ipc");
        expect(await resolveIpcRoot(undefined, { IPC_MOUNT: "/srv/ipc", CARAPA_BOX_IPC_DIR: "/app/ipc", CARAPA_BOX_IPC_HOST_DIR: "/srv/ipc" })).toBe("/app/ipc");
        expect(await resolveIpcRoot(undefined, { IPC_MOUNT: "/srv/ipc/a", CARAPA_BOX_IPC_DIR: "/app/ipc", CARAPA_BOX_IPC_HOST_DIR: "/srv/ipc" })).toBe("/app/ipc/a");
        await expect(resolveIpcRoot(undefined, { IPC_MOUNT: "/other", CARAPA_BOX_IPC_DIR: "/app/ipc", CARAPA_BOX_IPC_HOST_DIR: "/srv/ipc" })).rejects.toThrow("outside");
    });
});

describe("resolveLogicalMount", () => {
    it("maps @group and @repo under the box roots and rejects traversal", async () => {
        const { resolveLogicalMount } = await import("./ipc-store.js");
        const env = { CARAPA_BOX_GROUPS_ROOT: "/srv/groups", CARAPA_BOX_REPOS_ROOT: "/srv/repos" };
        expect(resolveLogicalMount("@group", env)).toBe("/srv/groups");
        expect(resolveLogicalMount("@group/proj", env)).toBe("/srv/groups/proj");
        expect(resolveLogicalMount("@repo/proj", env)).toBe("/srv/repos/proj");
        expect(resolveLogicalMount("/home/u/repo", env)).toBe("/home/u/repo");
        expect(() => resolveLogicalMount("@group/../etc", env)).toThrow();
        expect(() => resolveLogicalMount("@repo", env)).toThrow();
        expect(() => resolveLogicalMount("@group/x", {})).toThrow("CARAPA_BOX_GROUPS_ROOT");
    });
});

describe("IpcStore fd-relative writes", () => {
    function setup() {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ipc-fd-")));
        const projectDir = path.join(base, "p");
        const outside = path.join(base, "outside");
        fs.mkdirSync(projectDir);
        fs.mkdirSync(outside);
        return { base, store: new IpcStore(projectDir), projectDir, outside };
    }

    it("atomic write over a leaf symlink replaces the link and leaves the target", async () => {
        const { base, store, projectDir, outside } = setup();
        fs.writeFileSync(path.join(outside, "t"), "keep");
        fs.symlinkSync(path.join(outside, "t"), path.join(projectDir, "f"));
        await store.write("f", Buffer.from("new"));
        expect(fs.lstatSync(path.join(projectDir, "f")).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(projectDir, "f"), "utf8")).toBe("new");
        expect(fs.readFileSync(path.join(outside, "t"), "utf8")).toBe("keep");
        fs.rmSync(base, { recursive: true, force: true });
    });

    it("append and exclusive over a leaf symlink are refused", async () => {
        const { base, store, projectDir, outside } = setup();
        fs.writeFileSync(path.join(outside, "t"), "keep");
        fs.symlinkSync(path.join(outside, "t"), path.join(projectDir, "f"));
        await expect(store.write("f", Buffer.from("x"), "append")).rejects.toThrow();
        await expect(store.write("f", Buffer.from("x"), "exclusive")).rejects.toThrow();
        expect(fs.readFileSync(path.join(outside, "t"), "utf8")).toBe("keep");
        fs.rmSync(base, { recursive: true, force: true });
    });

    it("recursive remove deletes a symlink to an outside dir but not its contents", async () => {
        const { base, store, projectDir, outside } = setup();
        fs.writeFileSync(path.join(outside, "keep"), "x");
        fs.mkdirSync(path.join(projectDir, "t"));
        fs.symlinkSync(outside, path.join(projectDir, "t", "link"));
        await store.remove("t", true);
        expect(fs.existsSync(path.join(projectDir, "t"))).toBe(false);
        expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("x");
        fs.rmSync(base, { recursive: true, force: true });
    });

    it("mkdir through a symlinked intermediate component is refused and creates nothing outside", async () => {
        const { base, store, projectDir, outside } = setup();
        fs.symlinkSync(outside, path.join(projectDir, "a"));
        await expect(store.mkdir("a/b/c")).rejects.toThrow();
        expect(fs.readdirSync(outside)).toEqual([]);
        fs.rmSync(base, { recursive: true, force: true });
    });
});
