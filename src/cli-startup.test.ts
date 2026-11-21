import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
let fixture: string;

beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), "carapa-box-cli-startup-"));
    await mkdir(path.join(fixture, "bin"));
    await mkdir(path.join(fixture, "stacks", "example"), { recursive: true });
    await writeFile(path.join(fixture, "stacks", "example", "docker-compose.yml"), "services: {}\n");
    await writeFile(path.join(fixture, "stacks", "example", "policy.wasm"), "");
    // Exercise the real package scripts and bundled CLI/server, with no host .env or Docker access.
    await writeFile(path.join(fixture, "package.json"), await readFile(path.join(root, "package.json")));
    await writeFile(path.join(fixture, "bin", "docker"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> docker-calls\nexit 1\n', { mode: 0o755 });
    const build = await Bun.build({
        entrypoints: [path.join(root, "src/index.ts"), path.join(root, "src/cli.ts")],
        outdir: path.join(fixture, "dist"),
        target: "node",
        // Avoid a bundled development logger worker in the standalone fixture.
        define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!build.success) throw new AggregateError(build.logs, "CLI fixture build failed");
});

afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
});

async function callList(extraEnv: Record<string, string> = {}): Promise<{ stacks: string[]; stderr: string }> {
    const child = spawn(process.execPath, ["run", "call", "list"], {
        cwd: fixture,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            PATH: [path.join(fixture, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
            HOME: fixture,
            NODE_ENV: "production",
            ...extraEnv,
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    // Kill this test's process group, including the CLI's temporary MCP server.
    const stop = () => {
        if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
    };
    const timer = setTimeout(stop, 10_000);
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        expect(code, stderr).toBe(0);
        return { stacks: JSON.parse(stdout).map((stack: { name: string }) => stack.name), stderr };
    } finally {
        clearTimeout(timer);
        stop();
    }
}

test("bun call list returns stacks without global Docker maintenance", async () => {
    const { stacks, stderr } = await callList();
    expect(stacks).toEqual(["example"]);
    expect(existsSync(path.join(fixture, "docker-calls")), stderr).toBe(false);
}, 15_000);

test("bun call passes shell-exported config such as SANDBOX_STACKS_DIR to the MCP server", async () => {
    const exported = path.join(fixture, "exported-stacks");
    await mkdir(path.join(exported, "from-shell"), { recursive: true });
    await writeFile(path.join(exported, "from-shell", "docker-compose.yml"), "services: {}\n");
    await writeFile(path.join(exported, "from-shell", "policy.wasm"), "");
    const { stacks } = await callList({ SANDBOX_STACKS_DIR: exported });
    expect(stacks).toEqual(["from-shell"]);
}, 15_000);
