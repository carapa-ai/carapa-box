import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { IpcStore } from "./ipc-store.js";
import { REPLICA_MARKER, SMALL_FILE_BYTES, syncIpcRoot, type BaseEntry, type SyncResponse } from "./ipc-sync.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-sync-"));
    dirs.push(root);
    const store = new IpcStore(path.join(root, "carapa-bot-demo"));
    const run = path.join(store.projectDir, "runs", "r1");
    fs.mkdirSync(run, { recursive: true });
    return { root, store, run };
}
const decode = (response: SyncResponse, rel: string) => {
    const file = response.files.find(f => f.path === rel);
    return file ? Buffer.from(file.data, "base64").toString() : undefined;
};
/** Base manifest a replica would hold after applying a response. */
function nextBase(base: Record<string, BaseEntry>, response: SyncResponse): Record<string, BaseEntry> {
    const next = { ...base };
    for (const rel of response.deleted) delete next[rel];
    for (const f of response.files) {
        const length = Buffer.from(f.data, "base64").length;
        next[f.path] = [f.offset + length, f.complete ? f.mtimeMs : null];
    }
    for (const p of response.pushed) if (p.ok && p.size !== undefined) next[p.path] = [p.size, p.mtimeMs ?? null];
    return next;
}

describe("syncIpcRoot", () => {
    it("sends new files, then only appended bytes of large streams", async () => {
        const { store, run } = setup();
        const big = "x".repeat(SMALL_FILE_BYTES + 10) + "\n";
        fs.writeFileSync(path.join(run, "output.jsonl"), big);
        fs.writeFileSync(path.join(run, "pid"), "42");
        const first = await syncIpcRoot(store, { root: "runs/r1" });
        expect(decode(first, "output.jsonl")).toBe(big);
        expect(decode(first, "pid")).toBe("42");
        let base = nextBase({}, first);

        fs.appendFileSync(path.join(run, "output.jsonl"), "tail\n");
        fs.writeFileSync(path.join(run, "pid"), "77");
        const second = await syncIpcRoot(store, { root: "runs/r1", base });
        const out = second.files.find(f => f.path === "output.jsonl")!;
        expect(out.replace).toBe(false);
        expect(out.offset).toBe(big.length);
        expect(decode(second, "output.jsonl")).toBe("tail\n");
        expect(decode(second, "pid")).toBe("77");
        base = nextBase(base, second);

        const third = await syncIpcRoot(store, { root: "runs/r1", base });
        expect(third.files).toEqual([]);
        expect(third.more).toBe(false);
    });

    it("withholds completion markers until the data is complete", async () => {
        const { store, run } = setup();
        fs.writeFileSync(path.join(run, "output.v1.jsonl"), "y".repeat(SMALL_FILE_BYTES + 5000));
        fs.writeFileSync(path.join(run, "exit_code"), "0");
        fs.writeFileSync(path.join(run, "metrics_complete"), "ok");
        const partial = await syncIpcRoot(store, { root: "runs/r1", maxBytes: 1000 });
        expect(partial.files[0].complete).toBe(false);
        expect(partial.more).toBe(true);
        expect(partial.files.map(f => f.path)).toEqual(["output.v1.jsonl"]);
        const rest = await syncIpcRoot(store, { root: "runs/r1", base: nextBase({}, partial) });
        expect(rest.more).toBe(false);
        expect(rest.files.map(f => f.path).sort()).toEqual(["exit_code", "metrics_complete", "output.v1.jsonl"]);
        expect(rest.files.find(f => f.path === "output.v1.jsonl")!.offset).toBe(1000);
    });

    it("applies pushes before diffing and reports remote deletions", async () => {
        const { store, run } = setup();
        fs.writeFileSync(path.join(run, "clean_stop"), "");
        const base: Record<string, BaseEntry> = { "clean_stop": [0, null], "gone": [3, 1] };
        const response = await syncIpcRoot(store, {
            root: "runs/r1",
            base,
            push: [
                { op: "write", path: "control-requests/a.json", data: Buffer.from("{\"id\":\"a\"}").toString("base64") },
                { op: "remove", path: "clean_stop" },
            ],
        });
        expect(response.pushed.every(p => p.ok)).toBe(true);
        expect(fs.readFileSync(path.join(run, "control-requests", "a.json"), "utf8")).toBe("{\"id\":\"a\"}");
        expect(fs.existsSync(path.join(run, "clean_stop"))).toBe(false);
        expect(response.deleted).toEqual(["gone"]);
        expect(response.files.map(f => f.path)).not.toContain("control-requests/a.json");
        expect(response.dirs).toContain("control-requests");
    });

    it("skips runtime-private dirs, FIFOs and symlinks", async () => {
        const { store, run } = setup();
        fs.mkdirSync(path.join(run, "launch.lock"));
        fs.writeFileSync(path.join(run, "launch.lock", "pid"), "1");
        fs.symlinkSync("/etc/hostname", path.join(run, "link"));
        Bun.spawnSync(["mkfifo", path.join(run, "stdin.fifo")]);
        const response = await syncIpcRoot(store, { root: "runs/r1" });
        expect(response.files).toEqual([]);
    });

    it("detects a tree shared with the caller's replica", async () => {
        const { root, store } = setup();
        fs.writeFileSync(path.join(root, REPLICA_MARKER), "replica-1\n");
        expect((await syncIpcRoot(store, { root: "runs/r1", replicaId: "replica-1" })).shared).toBe(true);
        expect((await syncIpcRoot(store, { root: "runs/r1", replicaId: "other" })).shared).toBeUndefined();
    });
});

describe("syncIpcRoot offset pushes", () => {
    it("extends a remote stream without resending its prefix", async () => {
        const { store, run } = setup();
        fs.writeFileSync(path.join(run, "output.jsonl"), "a\n");
        const response = await syncIpcRoot(store, { root: "runs/r1", push: [{ op: "write", path: "output.jsonl", offset: 2, data: Buffer.from("b\n").toString("base64") }] });
        expect(response.pushed[0]).toMatchObject({ ok: true, size: 4 });
        expect(fs.readFileSync(path.join(run, "output.jsonl"), "utf8")).toBe("a\nb\n");
        const short = await syncIpcRoot(store, { root: "runs/r1", push: [{ op: "write", path: "output.jsonl", offset: 99, data: "" }] });
        expect(short.pushed[0].ok).toBe(false);
    });
});

describe("syncIpcRoot rewritten files", () => {
    it("re-sends a grown non-stream file whole instead of appending", async () => {
        const { store, run } = setup();
        const image = path.join(run, "image.png");
        fs.writeFileSync(image, "a".repeat(SMALL_FILE_BYTES + 1));
        const first = await syncIpcRoot(store, { root: "runs/r1" });
        fs.writeFileSync(image, "b".repeat(SMALL_FILE_BYTES + 50));
        fs.utimesSync(image, new Date(), new Date(Date.now() + 5000));
        const second = await syncIpcRoot(store, { root: "runs/r1", base: nextBase({}, first) });
        const file = second.files.find(f => f.path === "image.png")!;
        expect(file.replace).toBe(true);
        expect(file.offset).toBe(0);
        expect(decode(second, "image.png")).toBe("b".repeat(SMALL_FILE_BYTES + 50));
    });
});

describe("syncIpcRoot exclusions", () => {
    it("skips caller-owned directories", async () => {
        const { store, run } = setup();
        fs.mkdirSync(path.join(run, "logs"));
        fs.writeFileSync(path.join(run, "logs", "a.log"), "x");
        fs.writeFileSync(path.join(run, "keep"), "y");
        const response = await syncIpcRoot(store, { root: "runs/r1", exclude: ["logs"] });
        expect(response.files.map(f => f.path)).toEqual(["keep"]);
    });
});

describe("syncIpcRoot availability", () => {
    it("reports a tree this Box cannot see instead of writing elsewhere", async () => {
        const store = new IpcStore(path.join(os.tmpdir(), `missing-${Date.now()}`, "carapa-bot-x"));
        const response = await syncIpcRoot(store, { root: "runs/r", push: [{ op: "write", path: "a", data: "" }] });
        expect(response.unavailable).toContain("not accessible");
        expect(response.pushed).toEqual([]);
    });

    describe("unreadable files", () => {
        /** Make opening one file fail with `code`; everything else is untouched. */
        function failOpen(suffix: string, code: string) {
            const original = fsp.open.bind(fsp);
            return spyOn(fsp, "open").mockImplementation((async (file: any, ...rest: any[]) => {
                if (String(file).endsWith(suffix)) throw Object.assign(new Error(`${code}: injected`), { code });
                return (original as any)(file, ...rest);
            }) as any);
        }

        it("reports a file that fails with EACCES and still returns markers", async () => {
            const { store, run } = setup();
            fs.writeFileSync(path.join(run, "secret.txt"), "nope");
            fs.writeFileSync(path.join(run, "pid"), "42");
            fs.writeFileSync(path.join(run, "exit_code"), "0");
            const spy = failOpen("secret.txt", "EACCES");
            try {
                const response = await syncIpcRoot(store, { root: "runs/r1" });
                expect(response.unreadable).toEqual([{ path: "secret.txt", code: "EACCES" }]);
                expect(decode(response, "secret.txt")).toBeUndefined();
                expect(decode(response, "pid")).toBe("42");
                expect(decode(response, "exit_code")).toBe("0");
                expect(response.more).toBe(false);
            } finally {
                spy.mockRestore();
            }
        });

        it("does not report a file removed between walk and read (ENOENT)", async () => {
            const { store, run } = setup();
            fs.writeFileSync(path.join(run, "gone.txt"), "x");
            fs.writeFileSync(path.join(run, "exit_code"), "0");
            const spy = failOpen("gone.txt", "ENOENT");
            try {
                const response = await syncIpcRoot(store, { root: "runs/r1" });
                expect(response.unreadable).toBeUndefined();
                expect(decode(response, "exit_code")).toBe("0");
            } finally {
                spy.mockRestore();
            }
        });
    });
});

describe("syncIpcRoot unreadable directories", () => {
    /** Make listing (O_DIRECTORY open of) one directory fail with `code`. */
    function failDirOpen(target: string, code: string) {
        const original = fsp.open.bind(fsp);
        return spyOn(fsp, "open").mockImplementation((async (file: Parameters<typeof fsp.open>[0], flags?: Parameters<typeof fsp.open>[1], ...rest: unknown[]) => {
            if (String(file) === target && typeof flags === "number" && (flags & fs.constants.O_DIRECTORY)) {
                throw Object.assign(new Error(`${code}: injected`), { code });
            }
            // @ts-expect-error forwarding the remaining variadic arguments unchanged
            return original(file, flags, ...rest);
        }) as typeof fsp.open);
    }

    function seed() {
        const ctx = setup();
        fs.mkdirSync(path.join(ctx.run, "sessions"));
        fs.writeFileSync(path.join(ctx.run, "stdout.log"), "out");
        fs.writeFileSync(path.join(ctx.run, "sessions", "out.jsonl"), "{}\n");
        return ctx;
    }

    it("does not report files under a subdirectory that fails with EACCES as deleted", async () => {
        const { store, run } = seed();
        const base = nextBase({ "gone.txt": [1, 1] }, await syncIpcRoot(store, { root: "runs/r1" }));
        const spy = failDirOpen(path.join(run, "sessions"), "EACCES");
        try {
            const response = await syncIpcRoot(store, { root: "runs/r1", base });
            expect(response.deleted).toEqual(["gone.txt"]);
            expect(response.unreadable).toEqual([{ path: "sessions", code: "EACCES" }]);
        } finally {
            spy.mockRestore();
        }
    });

    it("reports nothing as deleted when the root itself fails with EACCES", async () => {
        const { store, run } = seed();
        const base = nextBase({ "gone.txt": [1, 1] }, await syncIpcRoot(store, { root: "runs/r1" }));
        const spy = failDirOpen(run, "EACCES");
        try {
            const response = await syncIpcRoot(store, { root: "runs/r1", base });
            expect(response.deleted).toEqual([]);
            expect(response.unreadable).toEqual([{ path: ".", code: "EACCES" }]);
        } finally {
            spy.mockRestore();
        }
    });

    it("still reports files of a subdirectory that was really removed (ENOENT)", async () => {
        const { store, run } = seed();
        const base = nextBase({}, await syncIpcRoot(store, { root: "runs/r1" }));
        fs.rmSync(path.join(run, "sessions"), { recursive: true });
        const response = await syncIpcRoot(store, { root: "runs/r1", base });
        expect(response.deleted).toEqual(["sessions/out.jsonl"]);
        expect(response.unreadable).toBeUndefined();
    });
});
