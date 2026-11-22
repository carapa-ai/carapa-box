/**
 * Unit tests for src/compose/client.ts — Docker Compose orchestration layer.
 *
 * All child-process execution (spawn / execSync / spawnSync) is mocked so
 * no real Docker daemon is required.
 *
 * Run with:  bun test src/compose/client.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Mutable mock state ───────────────────────────────────────────────────────

interface SpawnResult {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: Error;
}

const state = {
    spawnCalls: [] as Array<{ cmd: string; args: string[]; opts: any }>,
    spawnQueue: [] as SpawnResult[],
    spawnResponses: null as Map<string, SpawnResult> | null,
    fileExistsMocks: {} as Record<string, boolean>,
    unregisterCalls: [] as string[],
};

function reset() {
    state.spawnCalls = [];
    state.spawnQueue = [];
    state.spawnResponses = null;
    state.fileExistsMocks = {};
    state.unregisterCalls = [];
}

function queueSpawn(result: SpawnResult = {}) {
    state.spawnQueue.push(result);
}

/** Parallel cleanup calls must resolve by command, never by arrival order. */
function mockNetworkCleanup(networks: Record<string, number | null>, listFails = false) {
    const responses = new Map<string, SpawnResult>();
    responses.set(JSON.stringify(["network", "ls", "--filter", "name=agent_egress_", "--format", "{{.Name}}"]), {
        stdout: Object.keys(networks).join("\n"), exitCode: listFails ? 1 : 0,
    });
    for (const [name, count] of Object.entries(networks)) {
        responses.set(JSON.stringify(["network", "inspect", name, "--format", "{{len .Containers}}"]), {
            stdout: count === null ? "" : String(count), exitCode: count === null ? 1 : 0,
        });
        if (count === 0) responses.set(JSON.stringify(["network", "rm", name]), { exitCode: 0 });
    }
    state.spawnResponses = responses;
}

// ── Module mocks (Bun hoists these before all imports) ───────────────────────

// mock.module outlives this file; keep the real modules for afterAll.
const realConfig = { ...(await import("../config.js")) };
const realUtils = { ...(await import("../utils.js")) };
afterAll(() => {
    mock.module("../config.js", () => realConfig);
    mock.module("../utils.js", () => realUtils);
});

mock.module("../utils.js", () => ({
    fileExists: async (p: string) => state.fileExistsMocks[p] ?? fs.existsSync(p),
    splitDockerOutput: (output: string) => output.trim().split(/\s+/).filter(Boolean),
    execDocker: async (args: string[], options?: any) => {
        state.spawnCalls.push({ cmd: "docker", args, opts: options });
        const queued = state.spawnResponses
            ? state.spawnResponses.get(JSON.stringify(args))
            : state.spawnQueue.shift();
        if (state.spawnResponses && !queued) {
            throw new Error(`Unexpected Docker command: ${JSON.stringify(args)}`);
        }
        
        // Real execDocker reports spawn failures as a result, it does not throw.
        if (queued?.error) {
            return { status: 1, stdout: "", stderr: queued.error.message, spawnFailed: true };
        }

        const resp = { 
            exitCode: queued?.exitCode ?? 0, 
            stdout: queued?.stdout ?? "", 
            stderr: queued?.stderr ?? "" 
        };
        
        if (options?.onLog) {
            if (resp.stdout) options.onLog(resp.stdout);
            if (resp.stderr) options.onLog(resp.stderr);
        }

        return { 
            status: resp.exitCode, 
            stdout: resp.stdout, 
            stderr: resp.stderr 
        };
    },
    acquireProcessSlot: () => Promise.resolve(),
    releaseProcessSlot: () => {},
}));

mock.module("../config.js", () => ({
    getStacksDir: () => "/app/stacks",
}));

mock.module("../network-policy.js", () => ({
    registerStackProject: () => {},
    unregisterStackProject: (name: string) => { state.unregisterCalls.push(name); },
    scheduleNetworkPolicyReload: () => {},
}));

mock.module("../logger.js", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop };
    return { logger };
});

import {
    execCompose,
    startStack,
    stopStack,
    getStackStatus,
    execInService,
    execArgvInService,
    listProjects,
    getServiceLogs,
    cleanupOrphanedAgentNetworks,
} from "./client.js";

// ── Filesystem helpers ───────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "compose-client-test-"));
}

function rmDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// ── execCompose ──────────────────────────────────────────────────────────────

describe("execCompose", () => {
    let tmpDir: string;

    beforeEach(() => {
        reset();
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it("invokes 'docker compose' with the supplied args", async () => {
        queueSpawn({ stdout: "", exitCode: 0 });
        await execCompose(tmpDir, ["up", "-d"]);
        const call = state.spawnCalls[0];
        expect(call.cmd).toBe("docker");
        expect(call.args).toEqual(["compose", "up", "-d"]);
    });

    it("prepends --project-name <projectName> when projectName is provided", async () => {
        queueSpawn({});
        await execCompose(tmpDir, ["up", "-d"], { projectName: "myproject" });
        expect(state.spawnCalls[0].args).toEqual(["compose", "--project-name", "myproject", "up", "-d"]);
    });

    it("sets STACK_DIR env var to the (possibly mapped) stack directory", async () => {
        queueSpawn({});
        await execCompose(tmpDir, ["ps"]);
        expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe(tmpDir);
    });

    it("sets COMPOSE_PROJECT_NAME env var when projectName is provided", async () => {
        queueSpawn({});
        await execCompose(tmpDir, ["ps"], { projectName: "proj" });
        expect(state.spawnCalls[0].opts.env.COMPOSE_PROJECT_NAME).toBe("proj");
    });

    it("merges caller-supplied env vars into the process environment", async () => {
        queueSpawn({});
        await execCompose(tmpDir, ["ps"], { env: { MY_VAR: "hello" } });
        expect(state.spawnCalls[0].opts.env.MY_VAR).toBe("hello");
    });

    it("appends override file to COMPOSE_FILE when project-specific override exists", async () => {
        const overrideFile = path.join(tmpDir, "docker-compose.override.myproj.yml");
        fs.writeFileSync(overrideFile, "version: '3'\n");
        queueSpawn({});
        await execCompose(tmpDir, ["up", "-d"], { projectName: "myproj" });
        const composeFile = state.spawnCalls[0].opts.env.COMPOSE_FILE as string;
        expect(composeFile).toContain("docker-compose.override.myproj.yml");
    });

    it("uses /tmp as cwd and adds --project-directory when stackDir does not exist", async () => {
        queueSpawn({});
        await execCompose("/nonexistent/stack/dir", ["up", "-d"]);
        const call = state.spawnCalls[0];
        expect(call.opts.cwd).toBe("/tmp");
        expect(call.args).toContain("--project-directory");
        expect(call.args).toContain("/nonexistent/stack/dir");
    });

    it("calls onLog with stdout chunks", async () => {
        queueSpawn({ stdout: "line one\n", exitCode: 0 });
        const logs: string[] = [];
        await execCompose(tmpDir, ["up", "-d"], { onLog: (s) => logs.push(s) });
        expect(logs.join("")).toContain("line one");
    });

    it("calls onLog with stderr chunks", async () => {
        queueSpawn({ stdout: "", stderr: "warn: something\n", exitCode: 0 });
        const logs: string[] = [];
        await execCompose(tmpDir, ["up", "-d"], { onLog: (s) => logs.push(s) });
        expect(logs.join("")).toContain("warn: something");
    });

    it("rejects when docker exits non-zero (default behaviour)", async () => {
        queueSpawn({ stdout: "", stderr: "Error: pull failed", exitCode: 1 });
        await expect(execCompose(tmpDir, ["up", "-d"])).rejects.toThrow("Error: pull failed");
    });

    it("reports the exit status and stderr of a non-zero compose exit without a spawn prefix", async () => {
        queueSpawn({ stdout: "", stderr: "Error: pull failed", exitCode: 17 });
        const err = await execCompose(tmpDir, ["up", "-d"]).catch((e: Error) => e);
        expect((err as Error).message).toBe("docker compose up -d failed with exit code 17: Error: pull failed");
    });

    it("uses a generic message when stderr is empty on non-zero exit", async () => {
        queueSpawn({ stdout: "", stderr: "", exitCode: 2 });
        await expect(execCompose(tmpDir, ["up", "-d"])).rejects.toThrow("docker compose up -d failed with exit code 2");
    });

    it("resolves with non-zero code when allowFailure is true", async () => {
        queueSpawn({ stdout: "", stderr: "minor warning", exitCode: 1 });
        const result = await execCompose(tmpDir, ["ps"], { allowFailure: true });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("minor warning");
    });

    it("rejects on spawn error event (e.g. docker not found)", async () => {
        queueSpawn({ error: new Error("ENOENT: spawn docker failed") });
        await expect(execCompose(tmpDir, ["up", "-d"])).rejects.toThrow(
            "Failed to spawn docker compose"
        );
    });

    it("returns stdout and stderr in the result object", async () => {
        queueSpawn({ stdout: "out content", stderr: "err content", exitCode: 0 });
        const result = await execCompose(tmpDir, ["ps"]);
        expect(result.stdout).toBe("out content");
        expect(result.stderr).toBe("err content");
        expect(result.code).toBe(0);
    });

    describe("toHostPath mapping via STACK_DIR", () => {
        let origHostDir: string | undefined;
        let origStacksHostDir: string | undefined;

        beforeEach(() => {
            origHostDir = process.env.SANDBOX_HOST_DIR;
            origStacksHostDir = process.env.SANDBOX_STACKS_HOST_DIR;
        });

        afterEach(() => {
            if (origHostDir === undefined) delete process.env.SANDBOX_HOST_DIR;
            else process.env.SANDBOX_HOST_DIR = origHostDir;

            if (origStacksHostDir === undefined) delete process.env.SANDBOX_STACKS_HOST_DIR;
            else process.env.SANDBOX_STACKS_HOST_DIR = origStacksHostDir;
        });

        it("passes the path unchanged when SANDBOX_HOST_DIR is not set", async () => {
            delete process.env.SANDBOX_HOST_DIR;
            queueSpawn({});
            await execCompose(tmpDir, ["ps"]);
            expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe(tmpDir);
        });

        it("rewrites stacks path using SANDBOX_STACKS_HOST_DIR", async () => {
            process.env.SANDBOX_HOST_DIR = "/host/project";
            process.env.SANDBOX_STACKS_HOST_DIR = "/host/stacks";
            // stacksDir (from mocked getStacksDir) = /app/stacks
            const stackDir = "/app/stacks/mybot";
            queueSpawn({});
            await execCompose(stackDir, ["ps"]);
            expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe("/host/stacks/mybot");
        });

        it("resolves a relative SANDBOX_STACKS_HOST_DIR against SANDBOX_HOST_DIR", async () => {
            // docker-compose.yml's default when SANDBOX_STACKS_DIR is empty.
            process.env.SANDBOX_HOST_DIR = "/host/project";
            process.env.SANDBOX_STACKS_HOST_DIR = "./stacks";
            queueSpawn({});
            await execCompose("/app/stacks/mybot", ["ps"]);
            expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe("/host/project/stacks/mybot");
        });

        it("rewrites app root path using SANDBOX_HOST_DIR when not under stacks dir", async () => {
            process.env.SANDBOX_HOST_DIR = "/host/project";
            delete process.env.SANDBOX_STACKS_HOST_DIR;
            // /app/stacks/../ = /app; /app/egress-proxy → /host/project/egress-proxy
            const stackDir = "/app/egress-proxy";
            queueSpawn({});
            await execCompose(stackDir, ["ps"]);
            expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe("/host/project/egress-proxy");
        });

        it("leaves unrelated paths unchanged even when SANDBOX_HOST_DIR is set", async () => {
            process.env.SANDBOX_HOST_DIR = "/host/project";
            // tmpDir is under /tmp, not under /app
            queueSpawn({});
            await execCompose(tmpDir, ["ps"]);
            expect(state.spawnCalls[0].opts.env.STACK_DIR).toBe(tmpDir);
        });
    });
});

// ── startStack ───────────────────────────────────────────────────────────────

describe("startStack", () => {
    let tmpDir: string;

    beforeEach(() => {
        reset();
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it("calls docker compose up -d", async () => {
        queueSpawn({});
        await startStack(tmpDir);
        const call = state.spawnCalls[0];
        expect(call.args).toContain("up");
        expect(call.args).toContain("-d");
    });

    it("forwards projectName to compose via --project-name flag", async () => {
        queueSpawn({});
        await startStack(tmpDir, "myproject");
        expect(state.spawnCalls[0].args).toContain("--project-name");
        expect(state.spawnCalls[0].args).toContain("myproject");
    });

    it("does not create an instance network when no projectName is given", async () => {
        queueSpawn({});
        await startStack(tmpDir);
        const creates = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("create") && c.args.includes("network")
        );
        expect(creates).toHaveLength(0);
    });

    it("does not create an instance network when compose file lacks AGENT_NETWORK", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "version: '3'\n");
        queueSpawn({});
        await startStack(tmpDir, "myproject");
        const creates = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("create") && c.args.includes("--internal")
        );
        expect(creates).toHaveLength(0);
    });

    it("only ensures external networks declared under top-level networks:", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), [
            "services:",
            "  agent:",
            "    image: x",
            "volumes:",
            "  mount_ipc:",
            "    external: true",
            "    name: ${IPC_MOUNT_VOLUME:-carapa-mount-unset}",
            "  mount_extra_1:",
            "    external: true",
            "networks:",
            "  agent_egress:",
            "    external: true",
            "    name: ${AGENT_NETWORK:-agent_egress}",
            "  shared:",
            "    external: true",
            "    name: shared_net",
            "  plain_ext:",
            "    external: true",
            "  internal_only:",
            "    driver: bridge",
            "",
        ].join("\n"));
        queueSpawn({ exitCode: 1 });   // inspect shared_net → not found
        queueSpawn({ exitCode: 1 });   // inspect plain_ext → not found
        await startStack(tmpDir);
        const created = state.spawnCalls
            .filter((c) => c.cmd === "docker" && c.args[0] === "network" && c.args[1] === "create")
            .map((c) => c.args[c.args.length - 1]);
        expect(created.sort()).toEqual(["plain_ext", "shared_net"]);
    });

    it("creates per-instance network when stack uses AGENT_NETWORK variable", async () => {
        fs.writeFileSync(
            path.join(tmpDir, "docker-compose.yml"),
            "# uses ${AGENT_NETWORK} for isolation\n"
        );
        // network inspect → fails (doesn't exist) → network create proceeds
        queueSpawn({ exitCode: 1 });   // inspect → not found
        queueSpawn({ exitCode: 0 });   // create → OK
        queueSpawn({});                 // docker compose up
        // connectProxyContainers: 4 parallel connects
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        await startStack(tmpDir, "proj42");
        const creates = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("create") && c.args.includes("--internal") && c.args.includes("agent_egress_proj42")
        );
        expect(creates).toHaveLength(1);
    });

    it("injects AGENT_NETWORK env var into the compose call", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK placeholder\n");
        queueSpawn({ exitCode: 1 });   // inspect → not found
        queueSpawn({ exitCode: 0 });   // create → OK
        queueSpawn({});                 // docker compose up
        queueSpawn({}); queueSpawn({}); queueSpawn({}); // 3 connects
        await startStack(tmpDir, "agentX");
        // The compose call is the one with env (execDocker doesn't pass env)
        const composeCall = state.spawnCalls.find((c) => c.opts?.env?.AGENT_NETWORK);
        expect(composeCall?.opts.env.AGENT_NETWORK).toBe("agent_egress_agentX");
    });

    it("connects all proxy containers to the instance network", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK=yes\n");
        queueSpawn({ exitCode: 1 });   // inspect → not found
        queueSpawn({ exitCode: 0 });   // create → OK
        queueSpawn({});                 // docker compose up
        queueSpawn({}); queueSpawn({}); queueSpawn({}); // 3 connects
        await startStack(tmpDir, "agentY");
        const connects = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("connect") && c.args.includes("network")
        );
        // One connect per proxy in INSTANCE_PROXIES (squid, api-relay, llama-proxy)
        expect(connects.length).toBe(3);
    });

    it("passes caller-supplied env vars into the compose call", async () => {
        queueSpawn({});
        await startStack(tmpDir, undefined, { MY_TOKEN: "secret" });
        expect(state.spawnCalls[0].opts.env.MY_TOKEN).toBe("secret");
    });

    it("forwards onLog to execCompose", async () => {
        queueSpawn({ stdout: "starting service\n", exitCode: 0 });
        const logs: string[] = [];
        await startStack(tmpDir, undefined, undefined, (s) => logs.push(s));
        expect(logs.join("")).toContain("starting service");
    });

    it("returns the ComposeResult from the underlying execCompose", async () => {
        queueSpawn({ stdout: "done", stderr: "", exitCode: 0 });
        const result = await startStack(tmpDir);
        expect(result.stdout).toBe("done");
        expect(result.code).toBe(0);
    });

    it("uses existing network without re-creating when inspect succeeds", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK=yes\n");
        // inspect succeeds → no create needed
        queueSpawn({ exitCode: 0 });   // inspect → exists
        queueSpawn({});                 // docker compose up
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({}); // 4 connects
        await startStack(tmpDir, "existing");
        const creates = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("create") && c.args.includes("--internal")
        );
        expect(creates).toHaveLength(0);
    });

    it("resolves without throwing when create AND the fallback inspect both fail (double-failure race condition)", async () => {
        // Stack uses AGENT_NETWORK so createInstanceNetwork is invoked
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK placeholder\n");
        // 1st: initial inspect → network not found
        queueSpawn({ exitCode: 1 });
        // 2nd: network create → fails (e.g. another process raced us)
        queueSpawn({ exitCode: 1 });
        // 3rd: fallback inspect → also fails
        queueSpawn({ exitCode: 1 });
        // docker compose up -d succeeds
        queueSpawn({});
        // connectProxyContainers: 4 parallel connects
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        // startStack must resolve — the warn path must not propagate as an exception
        await expect(startStack(tmpDir, "raceprojX")).resolves.toMatchObject({ code: 0 });
    });

    it("rejects with spawn stderr when docker compose up fails (documents missing network cleanup on start failure)", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK placeholder\n");
        // createInstanceNetwork: initial inspect → not found
        queueSpawn({ exitCode: 1 });
        // createInstanceNetwork: network create → succeeds
        queueSpawn({ exitCode: 0 });
        // proxies are connected + api-relay IP inspected BEFORE up
        queueSpawn({}); queueSpawn({}); queueSpawn({}); // 3 connects
        queueSpawn({ stdout: "172.20.0.5" });                           // api-relay IP inspect
        // docker compose up -d → fails (e.g. image pull denied)
        queueSpawn({ stderr: "pull access denied", exitCode: 1 });
        await expect(startStack(tmpDir, "proj")).rejects.toThrow("pull access denied");
    });

    it("injects API_RELAY_IP (api-relay's IP on the instance network) into the compose call", async () => {
        fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "AGENT_NETWORK placeholder\n");
        queueSpawn({ exitCode: 1 });   // createInstanceNetwork inspect → not found
        queueSpawn({ exitCode: 0 });   // create → OK
        queueSpawn({}); queueSpawn({}); queueSpawn({}); // 3 proxy connects
        queueSpawn({ stdout: "172.20.0.7\n" });   // getContainerIpOnNetwork → api-relay IP
        queueSpawn({});                 // docker compose up
        await startStack(tmpDir, "agentZ");
        const composeCall = state.spawnCalls.find((c) => c.opts?.env?.API_RELAY_IP);
        expect(composeCall?.opts.env.API_RELAY_IP).toBe("172.20.0.7");
        expect(composeCall?.opts.env.AGENT_NETWORK).toBe("agent_egress_agentZ");
    });

    it("rejects Docker's literal 'invalid IP' inspect result before invoking compose", async () => {
        fs.writeFileSync(
            path.join(tmpDir, "docker-compose.yml"),
            "AGENT_NETWORK placeholder\nAPI_RELAY_IP placeholder\n",
        );
        queueSpawn({ exitCode: 0 });   // instance network already exists
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({}); // 4 proxy connects
        queueSpawn({ stdout: "invalid IP\n" }); // stale stopped-container endpoint

        await expect(startStack(tmpDir, "agentBad")).rejects.toThrow(
            "api-relay has no valid IPv4 address",
        );
        expect(state.spawnCalls.some((c) => c.args.includes("compose"))).toBe(false);
    });
});

// ── stopStack ────────────────────────────────────────────────────────────────

describe("stopStack", () => {
    let tmpDir: string;

    beforeEach(() => {
        reset();
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it("calls docker compose down with -v --remove-orphans (no --timeout, uses stop_grace_period)", async () => {
        queueSpawn({ exitCode: 0 });    // down
        await stopStack(tmpDir, "myproject");
        const downCall = state.spawnCalls.find((c) => c.args.includes("down"))!;
        expect(downCall.args).toContain("-v");
        expect(downCall.args).toContain("--remove-orphans");
        expect(downCall.args).not.toContain("--timeout");
    });

    it("force-disconnects proxies so stopped endpoints do not become stale", async () => {
        queueSpawn({ exitCode: 0 }); // compose down
        queueSpawn({}); queueSpawn({}); // ghost-container ps calls
        queueSpawn({}); queueSpawn({}); queueSpawn({}); // disconnects
        queueSpawn({}); // network rm

        await stopStack(tmpDir, "myproject");

        const disconnects = state.spawnCalls.filter((c) => c.args.includes("disconnect"));
        expect(disconnects).toHaveLength(3);
        for (const call of disconnects) {
            expect(call.args).toContain("--force");
        }
    });

    it("force-removes orphaned containers found by ps -a -q", async () => {
        queueSpawn({ exitCode: 0 });    // down
        // Ghost detection: two async ps calls (label filter + name filter)
        queueSpawn({ stdout: "abc123\n" });   // ps by label
        queueSpawn({ stdout: "def456 proj-web-1\n" });   // ps by name
        queueSpawn({ stdout: "web\n" });      // compose config --services
        // docker rm -f (async)
        queueSpawn({});
        // cleanupInstanceNetwork: 4 disconnects + 1 rm (async)
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        queueSpawn({});
        await stopStack(tmpDir, "proj");
        const rmCalls = state.spawnCalls.filter(
            (c) => c.cmd === "docker" && c.args.includes("rm")
        );
        // One rm for ghost containers + one rm for network cleanup
        expect(rmCalls.length).toBeGreaterThanOrEqual(1);
        const ghostRm = rmCalls.find(c => c.args.includes("abc123"));
        expect(ghostRm).toBeTruthy();
        expect(ghostRm!.args).toContain("def456");
        expect(ghostRm!.args).toContain("-f");
    });

    it("does not remove containers of a sibling project sharing the name prefix", async () => {
        queueSpawn({ exitCode: 0 });                       // down
        queueSpawn({ stdout: "" });                        // ps by label
        queueSpawn({ stdout: "id1 a-b-web-1\nid2 a-b-c-web-1\n" }); // ps by name
        queueSpawn({ stdout: "web\n" });                   // compose config --services
        await stopStack(tmpDir, "a-b");
        const rm = state.spawnCalls.find(c => c.args[0] === "rm" && c.args.includes("-f") && c.args.includes("id1"))!;
        expect(rm).toBeDefined();
        expect(rm.args).not.toContain("id2");
    });

    it("skips docker rm when ps -a -q returns no containers", async () => {
        queueSpawn({ exitCode: 0 });          // down
        queueSpawn({ stdout: "" });            // ps by label — empty (async)
        queueSpawn({ stdout: "" });            // ps by name — empty (async)
        // cleanupInstanceNetwork: 4 disconnects + 1 rm (async)
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        queueSpawn({});
        await stopStack(tmpDir, "proj");
        // Only network cleanup rm calls, no ghost rm
        const ghostRmCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("-f") &&
            !c.args.includes("network")
        );
        expect(ghostRmCalls).toHaveLength(0);
        // The network rm is separate from ghost rm; ghost should be skipped
    });

    it("cleans up per-instance agent network after stop", async () => {
        queueSpawn({ exitCode: 0 });          // down
        // cleanupInstanceNetwork: 4 parallel disconnects + 1 rm
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        queueSpawn({});                        // network rm
        await stopStack(tmpDir, "myproject");
        const disconnects = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("disconnect") && c.args.includes("network")
        );
        expect(disconnects.length).toBeGreaterThan(0);
        const rmNet = state.spawnCalls.find((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("agent_egress_myproject")
        );
        expect(rmNet).toBeDefined();
    });

    it("does not interact with networks when no projectName is given", async () => {
        queueSpawn({ exitCode: 0 });
        await stopStack(tmpDir);
        const netCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("network")
        );
        expect(netCalls).toHaveLength(0);
    });

    it("returns the ComposeResult from the down call", async () => {
        queueSpawn({ stdout: "shutdown complete", stderr: "", exitCode: 0 }); // down
        // cleanupInstanceNetwork: 4 disconnects + 1 rm
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        queueSpawn({});
        const result = await stopStack(tmpDir, "proj");
        expect(result.stdout).toBe("shutdown complete");
        expect(result.code).toBe(0);
    });

    it("forwards onLog to the down execCompose call", async () => {
        queueSpawn({ stdout: "removing network\n", exitCode: 0 }); // down
        // cleanupInstanceNetwork: 4 disconnects + 1 rm
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({});
        queueSpawn({});
        const logs: string[] = [];
        await stopStack(tmpDir, "proj", (s) => logs.push(s));
        expect(logs.join("")).toContain("removing network");
    });

    it("propagates rejection when down fails", async () => {
        queueSpawn({ stderr: "compose down failed", exitCode: 1 });
        await expect(stopStack(tmpDir)).rejects.toThrow("compose down failed");
    });

    it("still runs leftover and network cleanup when down fails, then rejects with docker's stderr", async () => {
        queueSpawn({ stderr: "timeout stopping container", exitCode: 1 }); // down
        queueSpawn({ stdout: "leftover1\n" }); // ps by label
        queueSpawn({ stdout: "" });            // ps by name
        queueSpawn({});                        // rm -f
        queueSpawn({}); queueSpawn({}); queueSpawn({}); queueSpawn({}); // disconnects
        queueSpawn({});                        // network rm
        await expect(stopStack(tmpDir, "x-p")).rejects.toThrow("timeout stopping container");
        const argsList = state.spawnCalls.map((c) => c.args.join(" "));
        expect(argsList).toContain("ps -a -q --filter label=com.docker.compose.project=x-p");
        expect(argsList).toContain("rm -f leftover1");
        expect(argsList.some((a) => a.includes("agent_egress_x-p"))).toBe(true);
        expect(state.unregisterCalls).toEqual(["x-p"]);
    });
});

// ── getStackStatus ───────────────────────────────────────────────────────────

describe("getStackStatus", () => {
    let tmpDir: string;

    beforeEach(() => {
        reset();
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it("calls docker compose ps -a --format json", async () => {
        queueSpawn({ stdout: "[]", exitCode: 0 });
        await getStackStatus(tmpDir);
        const call = state.spawnCalls[0];
        expect(call.args).toContain("ps");
        expect(call.args).toContain("-a");
        expect(call.args).toContain("--format");
        expect(call.args).toContain("json");
    });

    it("returns the raw stdout from docker compose ps", async () => {
        const row = '{"Name":"web","State":"running","ExitCode":0}';
        queueSpawn({ stdout: row, exitCode: 0 });
        const result = await getStackStatus(tmpDir);
        expect(result.stdout).toBe(row);
    });

    it("resolves even when exit code is non-zero (allowFailure)", async () => {
        queueSpawn({ stdout: "", stderr: "no services running", exitCode: 1 });
        const result = await getStackStatus(tmpDir);
        expect(result.code).toBe(1);
    });

    it("handles NDJSON output (multiple JSON objects)", async () => {
        const ndjson =
            '{"Name":"web","State":"running"}\n{"Name":"db","State":"exited"}';
        queueSpawn({ stdout: ndjson, exitCode: 0 });
        const result = await getStackStatus(tmpDir);
        expect(result.stdout).toBe(ndjson);
    });

    it("passes projectName to compose via --project-name flag", async () => {
        queueSpawn({ stdout: "[]", exitCode: 0 });
        await getStackStatus(tmpDir, "myproject");
        expect(state.spawnCalls[0].args).toContain("--project-name");
        expect(state.spawnCalls[0].args).toContain("myproject");
    });
});

// ── execInService ────────────────────────────────────────────────────────────

describe("execInService", () => {
    let tmpDir: string;

    beforeEach(() => {
        reset();
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it("calls docker compose exec -T <service> sh -c <command>", async () => {
        queueSpawn({ stdout: "output", exitCode: 0 });
        await execInService(tmpDir, "web", "ls /app");
        const call = state.spawnCalls[0];
        expect(call.args).toContain("exec");
        expect(call.args).toContain("-T");
        expect(call.args).toContain("web");
        expect(call.args).toContain("sh");
        expect(call.args).toContain("-c");
        expect(call.args).toContain("ls /app");
    });

    it("returns stdout from the exec command", async () => {
        queueSpawn({ stdout: "file1\nfile2\n", exitCode: 0 });
        const result = await execInService(tmpDir, "web", "ls /app");
        expect(result.stdout).toBe("file1\nfile2\n");
    });

    it("resolves with non-zero exit code (allowFailure behaviour)", async () => {
        queueSpawn({ stdout: "", stderr: "command not found", exitCode: 127 });
        const result = await execInService(tmpDir, "web", "badcmd");
        expect(result.code).toBe(127);
        expect(result.stderr).toBe("command not found");
    });

    it("passes projectName to compose via --project-name flag", async () => {
        queueSpawn({ stdout: "", exitCode: 0 });
        await execInService(tmpDir, "web", "echo hi", "myproj");
        expect(state.spawnCalls[0].args).toContain("--project-name");
        expect(state.spawnCalls[0].args).toContain("myproj");
    });

    it("passes env values through process env without putting values in argv", async () => {
        queueSpawn({ stdout: "", exitCode: 0 });
        await execInService(tmpDir, "web", "echo hi", undefined, undefined, undefined, {
            PROVISION_DB_PASS: "secret-pass",
            PROVISION_DB_USER: "provisioner",
        });
        const call = state.spawnCalls[0];

        expect(call.args).toContain("-e");
        expect(call.args).toContain("PROVISION_DB_PASS");
        expect(call.args).toContain("PROVISION_DB_USER");
        expect(call.args).not.toContain("PROVISION_DB_PASS=secret-pass");
        expect(call.args).not.toContain("PROVISION_DB_USER=provisioner");
        expect(call.opts.env.PROVISION_DB_PASS).toBe("secret-pass");
        expect(call.opts.env.PROVISION_DB_USER).toBe("provisioner");
    });

    it("calls onLog with stdout output", async () => {
        queueSpawn({ stdout: "log output\n", exitCode: 0 });
        const logs: string[] = [];
        await execInService(tmpDir, "web", "echo hi", undefined, (s) => logs.push(s));
        expect(logs.join("")).toContain("log output");
    });

    it("calls onLog with stderr output", async () => {
        queueSpawn({ stdout: "", stderr: "stderr line\n", exitCode: 0 });
        const logs: string[] = [];
        await execInService(tmpDir, "web", "cmd", undefined, (s) => logs.push(s));
        expect(logs.join("")).toContain("stderr line");
    });
});

describe("execArgvInService", () => {
    it("passes argv directly without sh -c", async () => {
        reset();
        const tmpDir = makeTempDir();
        queueSpawn({ stdout: "", exitCode: 0 });
        try {
            await execArgvInService(tmpDir, "agent", ["/usr/local/ai-cli-bin/tool", "two words"]);
            const args = state.spawnCalls[0].args;
            expect(args).toContain("/usr/local/ai-cli-bin/tool");
            expect(args).toContain("two words");
            expect(args).not.toContain("sh");
            expect(args).not.toContain("-c");
        } finally { rmDir(tmpDir); }
    });

    it("forwards env values without putting them in argv", async () => {
        reset();
        const tmpDir = makeTempDir();
        queueSpawn({ stdout: "", exitCode: 0 });
        try {
            await execArgvInService(tmpDir, "agent", ["env"], undefined, undefined, undefined, {
                PROVISION_DB_PASS: "secret-pass",
            });
            const call = state.spawnCalls[0];
            expect(call.args).toContain("-e");
            expect(call.args).toContain("PROVISION_DB_PASS");
            expect(call.args).not.toContain("PROVISION_DB_PASS=secret-pass");
            expect(call.opts.env.PROVISION_DB_PASS).toBe("secret-pass");
        } finally { rmDir(tmpDir); }
    });
});

describe("getServiceLogs", () => {
    it("defaults to --tail 1000 and honors an explicit tail", async () => {
        reset();
        const tmpDir = makeTempDir();
        queueSpawn({ stdout: "" });
        queueSpawn({ stdout: "" });
        try {
            await getServiceLogs(tmpDir, "agent");
            await getServiceLogs(tmpDir, "agent", 50);
            const a = state.spawnCalls[0].args;
            const b = state.spawnCalls[1].args;
            expect(a.slice(a.indexOf("--tail"), a.indexOf("--tail") + 2)).toEqual(["--tail", "1000"]);
            expect(b.slice(b.indexOf("--tail"), b.indexOf("--tail") + 2)).toEqual(["--tail", "50"]);
        } finally { rmDir(tmpDir); }
    });
});

// ── listProjects ─────────────────────────────────────────────────────────────

describe("listProjects", () => {
    beforeEach(() => {
        reset();
    });

    it("calls docker compose ls --format json", async () => {
        queueSpawn({ stdout: "[]", exitCode: 0 });
        await listProjects();
        const call = state.spawnCalls[0];
        expect(call.cmd).toBe("docker");
        expect(call.args).toEqual(["compose", "ls", "--format", "json"]);
    });

    it("returns the raw stdout from docker compose ls", async () => {
        const payload =
            '[{"Name":"proj1","Status":"running(1)","ConfigFiles":"/stacks/proj1/docker-compose.yml"}]';
        queueSpawn({ stdout: payload, exitCode: 0 });
        const result = await listProjects();
        expect(result.stdout).toBe(payload);
        expect(result.code).toBe(0);
    });

    it("rejects when docker exits non-zero", async () => {
        queueSpawn({ stdout: "", stderr: "Cannot connect to docker daemon", exitCode: 1 });
        await expect(listProjects()).rejects.toThrow("Cannot connect to docker daemon");
    });

    it("uses generic message when stderr is empty on failure", async () => {
        queueSpawn({ stdout: "", stderr: "", exitCode: 1 });
        await expect(listProjects()).rejects.toThrow("docker compose ls failed");
    });

    it("returns empty array JSON when no projects running", async () => {
        queueSpawn({ stdout: "[]", exitCode: 0 });
        const result = await listProjects();
        expect(JSON.parse(result.stdout)).toEqual([]);
    });
});

// ── cleanupOrphanedAgentNetworks ─────────────────────────────────────────────

describe("cleanupOrphanedAgentNetworks", () => {
    beforeEach(() => {
        reset();
    });

    it("removes networks that have 0 connected containers", async () => {
        mockNetworkCleanup({ agent_egress_foo: 0, agent_egress_bar: 2 });

        await cleanupOrphanedAgentNetworks();

        const rmCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("agent_egress_foo")
        );
        expect(rmCalls).toHaveLength(1);
    });

    it("does not remove networks that have connected containers", async () => {
        mockNetworkCleanup({ agent_egress_busy: 3 });

        await cleanupOrphanedAgentNetworks();

        const rmCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("agent_egress_busy")
        );
        expect(rmCalls).toHaveLength(0);
    });

    it("handles docker not being available without throwing", async () => {
        // docker network ls fails (docker not installed / daemon down)
        mockNetworkCleanup({}, true);
        await expect(cleanupOrphanedAgentNetworks()).resolves.toBeUndefined();
    });

    it("skips networks whose inspect fails without throwing", async () => {
        mockNetworkCleanup({ agent_egress_mystery: null });

        await expect(cleanupOrphanedAgentNetworks()).resolves.toBeUndefined();

        // rm should NOT have been called
        const rmCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("network")
        );
        expect(rmCalls).toHaveLength(0);
    });

    it("handles empty network list gracefully", async () => {
        mockNetworkCleanup({});
        await cleanupOrphanedAgentNetworks();
        // No inspect / rm calls beyond the ls
        const netCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && (c.args.includes("inspect") || (c.args.includes("rm") && c.args.includes("network")))
        );
        expect(netCalls).toHaveLength(0);
    });

    it("removes all orphaned networks in a mixed list", async () => {
        mockNetworkCleanup({ agent_egress_a: 0, agent_egress_b: 1, agent_egress_c: 0 });

        await cleanupOrphanedAgentNetworks();

        const rmCalls = state.spawnCalls.filter((c) =>
            c.cmd === "docker" && c.args.includes("rm") && c.args.includes("network")
        );
        expect(rmCalls).toHaveLength(2);
        expect(rmCalls.some((c) => c.args.includes("agent_egress_a"))).toBe(true);
        expect(rmCalls.some((c) => c.args.includes("agent_egress_c"))).toBe(true);
        expect(rmCalls.some((c) => c.args.includes("agent_egress_b"))).toBe(false);
    });
});
