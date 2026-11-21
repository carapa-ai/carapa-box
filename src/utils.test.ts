import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_OUTPUT_BYTES } from "./capped-append.js";
// Other test files mock ./utils.js process-wide; load the real module via a unique specifier.
const { acquireProcessSlot, execDocker, execDockerWithTimeout, getProcessSlotStats, releaseProcessSlot, mergeEnvFile, parseEnvFile } = (await import(`./utils.ts?real-${Date.now()}`)) as typeof import("./utils.js");

let dir: string;
let origPath: string | undefined;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakedocker-"));
    const script = `#!/bin/sh\ntouch "${dir}/marker-$$"\nsleep "\${FAKE_SLEEP:-0}"\necho ran\n`;
    fs.writeFileSync(path.join(dir, "docker"), script, { mode: 0o755 });
    origPath = process.env.PATH;
    process.env.PATH = `${dir}:${origPath}`;
});

afterEach(() => {
    process.env.PATH = origPath;
    fs.rmSync(dir, { recursive: true, force: true });
});

const markers = () => fs.readdirSync(dir).filter(f => f.startsWith("marker-"));

describe("execDocker abort handling", () => {
    test("normal call returns stdout and status 0", async () => {
        const r = await execDocker(["x"]);
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe("ran");
    });

    test("pre-aborted signal returns 130 without spawning", async () => {
        const t = Date.now();
        const r = await execDocker(["x"], { signal: AbortSignal.abort(), env: { FAKE_SLEEP: "2" } });
        expect(Date.now() - t).toBeLessThan(200);
        expect(r).toEqual({ status: 130, stdout: "", stderr: "aborted" });
        await Bun.sleep(100);
        expect(markers()).toHaveLength(0);
        expect(getProcessSlotStats()).toEqual({ active: 0, queued: 0 });
    });

    test("abort while queued returns 130, never runs, semaphore balanced", async () => {
        const busy = Array.from({ length: 10 }, () => execDocker(["x"], { env: { FAKE_SLEEP: "1" } }));
        await Bun.sleep(300);
        expect(markers()).toHaveLength(10);
        const ac = new AbortController();
        const queued = execDocker(["x"], { signal: ac.signal, env: { FAKE_SLEEP: "1" } });
        await Bun.sleep(50);
        expect(getProcessSlotStats()).toEqual({ active: 10, queued: 1 });
        ac.abort();
        const r = await queued;
        expect(r.status).toBe(130);
        expect(getProcessSlotStats().queued).toBe(0);
        const results = await Promise.all(busy);
        expect(results.every(x => x.status === 0)).toBe(true);
        expect(markers()).toHaveLength(10);
        expect(getProcessSlotStats()).toEqual({ active: 0, queued: 0 });
        const t = Date.now();
        const next = await execDocker(["x"]);
        expect(next.status).toBe(0);
        expect(Date.now() - t).toBeLessThan(500);
    }, 10000);
});

describe("execDockerWithTimeout slot queue", () => {
    const ok = { status: 0, stdout: "ok", stderr: "" };

    test("queue wait does not count toward the timeout; a started hang still returns 124", async () => {
        for (let i = 0; i < 10; i++) await acquireProcessSlot();
        let started = false;
        const queued = execDockerWithTimeout((async () => { started = true; return ok; }) as typeof execDocker, ["exec"], 50);
        await Bun.sleep(150); // Longer than the timeout, while every slot is held.
        expect(started).toBe(false);
        expect(getProcessSlotStats()).toEqual({ active: 10, queued: 1 });
        releaseProcessSlot();
        expect(await queued).toEqual(ok);
        for (let i = 0; i < 9; i++) releaseProcessSlot();

        // A child that takes 150ms to die after the abort: 124 returns promptly, the slot stays held until it exits.
        let aborted = false;
        const hang = ((_args: string[], o?: { signal?: AbortSignal }) => new Promise<typeof ok>(resolve => o?.signal?.addEventListener("abort", () => {
            aborted = true;
            setTimeout(() => resolve(ok), 150);
        }))) as typeof execDocker;
        const r = await execDockerWithTimeout(hang, ["exec"], 50);
        expect(r.status).toBe(124);
        expect(aborted).toBe(true);
        expect(getProcessSlotStats()).toEqual({ active: 1, queued: 0 });
        await Bun.sleep(250);
        expect(getProcessSlotStats()).toEqual({ active: 0, queued: 0 });
    });
});

describe("execDocker output cap", () => {
    const marker = "\n...[truncated]";
    const writeFake = (body: string) =>
        fs.writeFileSync(path.join(dir, "docker"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

    test("caps 30 MB of stdout with one trailing marker", async () => {
        writeFake(`head -c 31457280 /dev/zero | tr '\\0' 'a'`);
        const r = await execDocker(["x"]);
        expect(r.status).toBe(0);
        expect(r.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + marker.length);
        expect(r.stdout.endsWith(marker)).toBe(true);
        expect(r.stdout.indexOf("[truncated]")).toBe(r.stdout.lastIndexOf("[truncated]"));
    }, 20000);

    test("caps stderr the same way", async () => {
        writeFake(`head -c 31457280 /dev/zero | tr '\\0' 'b' >&2`);
        const r = await execDocker(["x"]);
        expect(r.status).toBe(0);
        expect(r.stderr.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + marker.length);
        expect(r.stderr.endsWith(marker)).toBe(true);
        expect(r.stdout).toBe("");
    }, 20000);

    test("under-cap multi-byte output is byte-identical across chunk boundaries", async () => {
        const text = "héllo→世界😀\n".repeat(20000);
        fs.writeFileSync(path.join(dir, "payload.txt"), text);
        writeFake(`cat "${dir}/payload.txt"`);
        const r = await execDocker(["x"]);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(text);
    });
});

describe("parseEnvFile inline comments and quotes", () => {
    test("strips quotes and a trailing comment, keeps # inside values", async () => {
        const file = path.join(dir, "stack.env");
        fs.writeFileSync(file, [
            'LOCAL_REPO="/repos/app" # main repo',
            "SINGLE='/s/app' # c",
            "IPC_MOUNT=/x # c",
            "HASH=a#b",
            'QUOTED_HASH="a # b"',
            "PLAIN='two words'",
            "# COMMENT=1",
        ].join("\n"));
        expect(await parseEnvFile(file)).toEqual({
            LOCAL_REPO: "/repos/app",
            SINGLE: "/s/app",
            IPC_MOUNT: "/x",
            HASH: "a#b",
            QUOTED_HASH: "a # b",
            PLAIN: "two words",
        });
    });

    test("mergeEnvFile keeps a line whose parsed value is unchanged", async () => {
        const file = path.join(dir, "merge.env");
        const original = 'LOCAL_REPO="/repos/app" # main repo\nIPC_MOUNT=/x # c\n';
        fs.writeFileSync(file, original);
        await mergeEnvFile(file, { LOCAL_REPO: "/repos/app", IPC_MOUNT: "/x" });
        expect(fs.readFileSync(file, "utf-8")).toBe(original);
    });
});
