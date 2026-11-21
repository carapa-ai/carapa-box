import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectHost } from "./sandbox-host.js";

const env = { PATH: "/usr/bin:/bin" };
const dir = mkdtempSync(join(tmpdir(), "sandbox-host-test-"));
const hosts: ProjectHost[] = [];
const strays: number[] = [];

function newHost(): ProjectHost {
    const host = new ProjectHost((argv) => argv, dir);
    hosts.push(host);
    return host;
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDead(pid: number): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
        if (!alive(pid)) return true;
        await Bun.sleep(50);
    }
    return !alive(pid);
}

function readPid(file: string): number {
    const pid = Number(readFileSync(file, "utf8").trim());
    strays.push(pid);
    return pid;
}

afterAll(() => {
    for (const host of hosts) host.close();
    for (const pid of strays) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
});

describe("ProjectHost timeout and kill", () => {
    test("a command that exited in time is not killed by its timeout and leaves its background process running", async () => {
        const pidFile = join(dir, "exited.pid");
        const started = Date.now();
        const result = await newHost().run("/bin/sh", ["-c", `sleep 5 & echo $! > '${pidFile}'; exit 0`], { env, timeoutMs: 300 });
        expect(result.code).toBe(0);
        // The background process holds the pipes: the bounded drain, not the descendant, ends the request.
        expect(Date.now() - started).toBeLessThan(2500);
        const pid = readPid(pidFile);
        await Bun.sleep(400);
        expect(alive(pid)).toBe(true);
    });

    test("a timeout kills the whole process group", async () => {
        const pidFile = join(dir, "timeout.pid");
        const started = Date.now();
        const result = await newHost().run("/bin/sh", ["-c", `sleep 5 & echo $! > '${pidFile}'; wait; true`], { env, timeoutMs: 300 });
        expect(result.code).toBe(137);
        expect(Date.now() - started).toBeLessThan(2500);
        expect(await waitDead(readPid(pidFile))).toBe(true);
    });

    test("aborting kills the command and its descendants", async () => {
        const pidFile = join(dir, "abort.pid");
        const controller = new AbortController();
        const started = Date.now();
        const run = newHost().run("/bin/sh", ["-c", `sleep 5 & echo $! > '${pidFile}'; sleep 5`], { env, signal: controller.signal });
        await Bun.sleep(300);
        controller.abort();
        const result = await run;
        expect(result.code).toBe(137);
        expect(Date.now() - started).toBeLessThan(2500);
        expect(await waitDead(readPid(pidFile))).toBe(true);
    });

    test("retainOutput:false keeps no output; a live stream is not cut but the drain ends the request after exit", async () => {
        const pidFile = join(dir, "stream.pid");
        const chunks: string[] = [];
        const started = Date.now();
        const result = await newHost().run("/bin/sh", ["-c", `echo first; sleep 1.5; echo second; sleep 5 & echo $! > '${pidFile}'; exit 0`], { env, retainOutput: false, onOutput: (chunk) => chunks.push(chunk) });
        const elapsed = Date.now() - started;
        readPid(pidFile);
        expect(result.code).toBe(0);
        expect(result.output).toBe("");
        expect(chunks.join("")).toBe("first\nsecond\n");
        expect(elapsed).toBeGreaterThanOrEqual(1400);
        expect(elapsed).toBeLessThan(3500);
    });
});

describe("sandbox host standalone", () => {
    test("--serve from this file alone replies after the drain although a descendant holds the pipes", async () => {
        // OpenShell mounts only src/os-runner for the host: ../utils.js (and its config/logger graph) is absent there.
        const isolated = join(dir, "isolated", "os-runner");
        const pidFile = join(dir, "isolated.pid");
        mkdirSync(isolated, { recursive: true });
        copyFileSync(join(import.meta.dir, "sandbox-host.ts"), join(isolated, "sandbox-host.ts"));
        const host = Bun.spawn([process.execPath, join(isolated, "sandbox-host.ts"), "--serve"], {
            cwd: isolated, env: { PATH: "/usr/bin:/bin", LOG_LEVEL: "not-a-pino-level" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        try {
            const request = { id: 1, file: "/bin/sh", argv: ["-c", `sleep 5 & echo $! > '${pidFile}'; echo hello; exit 0`], cwd: isolated, env: {}, timeoutMs: 300 };
            const started = Date.now();
            host.stdin.write(`${JSON.stringify(request)}\n`);
            host.stdin.flush();
            const lines: string[] = [];
            const decoder = new TextDecoder();
            let buffer = "";
            for await (const chunk of host.stdout) {
                buffer += decoder.decode(chunk, { stream: true });
                lines.push(...buffer.split("\n").slice(0, -1));
                buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
                if (lines.some((line) => line.includes('"code"'))) break;
            }
            const elapsed = Date.now() - started;
            readPid(pidFile);
            expect(lines.map((line) => JSON.parse(line))).toEqual([{ id: 1, out: "hello\n" }, { id: 1, code: 0 }]);
            expect(elapsed).toBeLessThan(2500);
        } finally {
            host.kill();
        }
    });
});

describe("ProjectHost dead host", () => {
    test("a host that exits with unflushed stdin fails its requests instead of crashing the runner with EPIPE", async () => {
        const host = new ProjectHost(() => ["/bin/sh", "-c", "sleep 0.3"], dir);
        hosts.push(host);
        const result = await host.run("/bin/true", [], {
            env,
            timeoutMs: 5000,
            onStdin: (stdin) => { setTimeout(() => stdin.write("x".repeat(1024 * 1024)), 100); },
        });
        expect(result.code).toBe(137);
        expect(result.output).toContain("sandbox host exited");
        // The late write above must not surface as an uncaught error after the request settled.
        await Bun.sleep(300);
    });

    test("a host that cannot be launched fails its request", async () => {
        const host = new ProjectHost(() => [join(dir, "missing-host")], dir);
        hosts.push(host);
        const result = await host.run("/bin/true", [], { env, timeoutMs: 5000 });
        expect(result.code).toBe(137);
    });
});

describe("ProjectHost output cap", () => {
    test("retained output is capped while onOutput streams everything", async () => {
        const total = 24 * 1024 * 1024;
        let streamed = 0;
        const result = await newHost().run("/bin/sh", ["-c", `head -c ${total} /dev/zero | tr '\\0' a`], { env, timeoutMs: 60_000, onOutput: (chunk) => { streamed += chunk.length; } });
        expect(result.code).toBe(0);
        expect(result.output.length).toBeLessThanOrEqual(10 * 1024 * 1024 + "\n...[truncated]".length);
        expect(streamed).toBe(total);
    });
});
