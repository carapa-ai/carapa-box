import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IpcStore } from "./ipc-store.js";
import { syncIpcRoot, syncTestHooks } from "./ipc-sync.js";
import { assertParentSafe, IpcPathError, openContained, readdirContained, setDarwinFdResolver } from "./safe-open.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}
function fixture() {
    const base = tmp("safe-open-");
    const root = path.join(base, "proj");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "TOPSECRET");
    return { root, outside };
}

describe("safe-open", () => {
    it("rejects a leaf symlink swapped in after resolve (store.read)", async () => {
        const { root, outside } = fixture();
        fs.writeFileSync(path.join(root, "f.txt"), "inside");
        const store = new IpcStore(root);
        const file = await store.resolve("f.txt");
        fs.rmSync(file);
        fs.symlinkSync(path.join(outside, "secret"), file);
        await expect(openContained(root, file, fs.constants.O_RDONLY)).rejects.toBeInstanceOf(IpcPathError);
        await expect(store.read("f.txt")).rejects.toBeInstanceOf(IpcPathError);
    });

    it("sync rejects a file replaced by a symlink after the walk and reports it unreadable", async () => {
        const { root, outside } = fixture();
        fs.writeFileSync(path.join(root, "f.txt"), "inside");
        syncTestHooks.afterWalk = async () => {
            fs.rmSync(path.join(root, "f.txt"));
            fs.symlinkSync(path.join(outside, "secret"), path.join(root, "f.txt"));
        };
        try {
            const response = await syncIpcRoot(new IpcStore(root), { root: "" });
            expect(JSON.stringify(response)).not.toContain(Buffer.from("TOPSECRET").toString("base64"));
            expect(response.files).toEqual([]);
            expect(response.unreadable).toEqual([{ path: "f.txt", code: "ELOOP" }]);
        } finally {
            syncTestHooks.afterWalk = undefined;
        }
    });

    it("mkdir never deletes a pre-existing outside directory when the parent is swapped", async () => {
        const { root, outside } = fixture();
        fs.mkdirSync(path.join(outside, "nginx-routes"));
        fs.writeFileSync(path.join(outside, "nginx-routes", "keep"), "x");
        fs.symlinkSync(outside, path.join(root, "a"));
        await expect(new IpcStore(root).mkdir("a/nginx-routes")).rejects.toThrow();
        expect(fs.readFileSync(path.join(outside, "nginx-routes", "keep"), "utf8")).toBe("x");
    });

    it("rejects a FIFO promptly with a type error", async () => {
        const { root } = fixture();
        execFileSync("mkfifo", [path.join(root, "exit_code")]);
        const started = Date.now();
        await expect(new IpcStore(root).read("exit_code")).rejects.toThrow("not a regular file");
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("refuses write and remove when the parent is a symlink to outside", async () => {
        const { root, outside } = fixture();
        fs.mkdirSync(path.join(root, "d"));
        const store = new IpcStore(root);
        const target = await store.resolve("d/x");
        fs.rmSync(path.join(root, "d"), { recursive: true });
        fs.symlinkSync(outside, path.join(root, "d"));
        await expect(assertParentSafe(root, target)).rejects.toBeInstanceOf(IpcPathError);
        await expect(store.write("d/x", Buffer.from("x"))).rejects.toThrow();
        expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
        await expect(store.remove("d/secret")).rejects.toThrow();
        expect(fs.existsSync(path.join(outside, "secret"))).toBe(true);
    });

    it("refuses to list a directory swapped for a symlink", async () => {
        const { root, outside } = fixture();
        fs.symlinkSync(outside, path.join(root, "d"));
        await expect(readdirContained(root, path.join(root, "d"))).rejects.toBeInstanceOf(IpcPathError);
    });
});

describe("safe-open on darwin (stubbed platform)", () => {
    // Stand-in for F_GETPATH: Linux can only resolve an fd through /proc.
    const resolver = (fd: number) => fs.readlinkSync(`/proc/self/fd/${fd}`);
    async function withDarwin<T>(fn: () => Promise<T>): Promise<T> {
        const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
        const restore = setDarwinFdResolver(resolver);
        Object.defineProperty(process, "platform", { value: "darwin" });
        try { return await fn(); } finally {
            Object.defineProperty(process, "platform", desc);
            restore();
        }
    }

    it("openContained succeeds for a file inside root", async () => {
        const { root } = fixture();
        fs.writeFileSync(path.join(root, "f.txt"), "inside");
        const handle = await withDarwin(() => openContained(root, path.join(root, "f.txt"), fs.constants.O_RDONLY));
        expect(await handle.readFile("utf8")).toBe("inside");
        await handle.close();
    });

    it("openContained throws EESCAPE for a file behind a symlinked-out parent", async () => {
        const { root, outside } = fixture();
        fs.symlinkSync(outside, path.join(root, "link"));
        const err = await withDarwin(() => openContained(root, path.join(root, "link", "secret"), fs.constants.O_RDONLY)).catch((e) => e);
        expect((err as IpcPathError).code).toBe("EESCAPE");
    });

    it("readdirContained lists a directory inside root", async () => {
        const { root } = fixture();
        fs.writeFileSync(path.join(root, "a.txt"), "a");
        const entries = await withDarwin(() => readdirContained(root, root));
        expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
    });

    it("readdirContained throws EESCAPE for a symlinked-out directory", async () => {
        const { root, outside } = fixture();
        fs.symlinkSync(outside, path.join(root, "link"));
        const err = await withDarwin(() => readdirContained(root, path.join(root, "link") + "/.")).catch((e) => e);
        expect((err as IpcPathError).code).toBe("EESCAPE");
    });
});
