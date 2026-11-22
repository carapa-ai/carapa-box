import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { OpenShellConfig, RunnerConfig } from "./config.js";
import { OpenShellBackend, sandboxName } from "./openshell.js";
import { prepareProject, relayUrl, type NativeProject } from "./projects.js";
import { parseEnvFile, serviceEnv, StackServices, type RunResult } from "./stack-service.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const BIN = path.resolve(import.meta.dir, "..", "..", "stacks", "carapa-bot", "bin");

function setup(): { config: RunnerConfig; openshell: OpenShellConfig; native: NativeProject } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-service-"));
    roots.push(root);
    const envFile = path.join(root, "brain.env");
    fs.writeFileSync(envFile, [
        "# Brain", "PORT=3111", "BOARD_URL=http://api-relay:8080/board-api", 'LOG_LEVEL="debug"', "CARAPA_BOARD_API_TOKEN=stale", "WORKSPACE_PATH=/workspace/main", "OPENAI_API_KEY=sk-proj-real-secret",
    ].join("\n"));
    const openshell: OpenShellConfig = {
        cli: "openshell", driver: "docker", image: "agent:test", bun: "bun", relayHost: "host.openshell.internal", harnesses: [], mounts: [], readOnlyPaths: [],
        stacks: {
            "carapa-brain": {
                image: "brain:test", envFile, env: { CURATOR_ENABLED: "true" },
                service: { argv: ["bun", "run", "/app/src/index.ts"], port: 3111, hostPort: 3299, bind: "172.16.0.1", host: "host.docker.internal", health: "/health" },
            },
        },
    };
    const config: RunnerConfig = {
        root, stateDir: path.join(root, "state"), hubUrl: "wss://hub", boxId: "lab", credential: "x", relayUpstream: "https://hub:8443", relayUpstreamInsecure: false,
        relayPort: 18080, runtimeBinDir: BIN, allowedRoots: [], allowedDomains: [], denyRead: [], allowRead: [],
        llamaPorts: [], llamaToolProfiles: path.join(root, "tool_profiles.jsonc"), openshell,
    };
    return { config, openshell, native: prepareProject(config, "carapa-brain", "alpha", {}) };
}

describe("stack service environment", () => {
    it("points the stack's container addresses at the forwarder and takes only the Board token from Board", () => {
        const { config, openshell, native } = setup();
        const stack = openshell.stacks["carapa-brain"];
        const env = serviceEnv(native, config, stack, stack.service!, { CARAPA_BOARD_API_TOKEN: "fresh", CARAPA_SSH_ENABLED: "1", GROUP_DIR: "@group/x" });
        const relay = relayUrl(native, config);
        expect(env.BOARD_URL).toBe(`${relay}/board-api`);
        expect(env.CARAPA_BOARD_API_TOKEN).toBe("fresh");
        expect(env.CARAPA_SSH_ENABLED).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe("relay-managed");
        expect(env.LOG_LEVEL).toBe("debug");
        expect(env.CURATOR_ENABLED).toBe("true");
        // The layout the container provided as /workspace/* is the project's host directories.
        expect(env).toMatchObject({ PORT: "3111", GROUP_DIR: native.groupDir, IPC_RUNS_DIR: path.join(native.ipcDir, "runs"), BRAIN_RUN_DIR: path.join(native.ipcDir, "brain-runs"), HOME: native.agentHome });
        expect(env.WORKSPACE_PATH).toBe(native.workspaceRoot + "/main");
        expect(parseEnvFile("A=1 # note\nexport B='two words'\n#C=3\nnot a line")).toEqual({ A: "1", B: "two words" });
    });

    it("parseEnvFile drops quotes and the trailing comment of a quoted value", () => {
        expect(parseEnvFile("A=\"value\" # note\nB='two words'  # \"x\"\nC=\"a # b\"\nD=\"say \"hi\"\"")).toEqual({ A: "value", B: "two words", C: "a # b", D: 'say "hi"' });
    });
});

/** A fake sandbox: the service answers health checks once the launcher ran. */
function fakeSandbox() {
    const commands: Array<{ file: string; argv: string[]; env: Record<string, string> }> = [];
    let up = false;
    const run = async (_native: NativeProject, file: string, argv: string[], options: { env: Record<string, string> }): Promise<RunResult> => {
        commands.push({ file, argv, env: options.env });
        if (file === "wget") return { code: up ? 0 : 4, output: up ? '{"status":"ok"}' : "" };
        if (file === "/bin/sh") up = true;
        return { code: 0, output: "" };
    };
    return { run, commands, crash: () => { up = false; } };
}

function fakeProcesses() {
    const started: Array<{ argv: string[]; child: ChildProcess & { killed: boolean } }> = [];
    const spawnProcess = (argv: string[]) => {
        const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; return true; } }) as unknown as ChildProcess & { killed: boolean };
        started.push({ argv, child });
        return child;
    };
    return { started, spawnProcess };
}

describe("stack service lifecycle", () => {
    it("starts the service detached in the sandbox, publishes its port, and reports where Board reaches it", async () => {
        const { config, openshell, native } = setup();
        const sandbox = fakeSandbox();
        const processes = fakeProcesses();
        const backend = new OpenShellBackend(config, openshell);
        const services = new StackServices({
            config, openshell, run: sandbox.run, forwardArgv: (n, s) => backend.forwardArgv(n, s),
            spawnProcess: processes.spawnProcess, pollMs: 1, portOpen: async () => true,
        });

        await services.start(native, { CARAPA_BOARD_API_TOKEN: "fresh" });
        const launcher = sandbox.commands.find(c => c.file === "/bin/sh")!;
        expect(launcher.argv[0]).toBe("-c");
        expect(launcher.argv.slice(-3)).toEqual(["bun", "run", "/app/src/index.ts"]);
        expect(launcher.env.CARAPA_BOARD_API_TOKEN).toBe("fresh");
        expect(native.serviceEnv?.PORT).toBe("3111");
        expect(processes.started).toHaveLength(1);
        expect(processes.started[0].argv.slice(-7)).toEqual(["forward", "service", "--target-port", "3111", "--local", "172.16.0.1:3299", sandboxName(native.project)]);
        expect(services.ingress(native)).toEqual([{ service: "agent", kind: "http", host: "host.docker.internal", port: 3299, direct: true }]);

        // Already healthy: nothing is launched or forwarded twice.
        sandbox.commands.length = 0;
        await services.start(native);
        expect(sandbox.commands.some(c => c.file === "/bin/sh")).toBe(false);
        expect(processes.started).toHaveLength(1);

        services.stop(native);
        expect(processes.started[0].child.killed).toBe(true);
    });

    it("restarts a service that stopped answering and reports nothing for a stack without one", async () => {
        const { config, openshell, native } = setup();
        const sandbox = fakeSandbox();
        const services = new StackServices({ config, openshell, run: sandbox.run, forwardArgv: () => ["fwd"], spawnProcess: fakeProcesses().spawnProcess, pollMs: 1, portOpen: async () => true });
        await services.start(native);
        sandbox.crash();
        sandbox.commands.length = 0;
        await services.ensureRunning(native);
        expect(sandbox.commands.filter(c => c.file === "/bin/sh")).toHaveLength(1);
        services.stop(native);

        const plain = prepareProject(config, "carapa-bot", "beta", {});
        expect(services.has(plain)).toBe(false);
        expect(services.ingress(plain)).toEqual([]);
        await services.start(plain);
    });
    it("keeps retrying a service whose start failed, without launching a second copy while one is starting", async () => {
        const { config, openshell, native } = setup();
        const sandbox = fakeSandbox();
        const processes = fakeProcesses();
        let launchFails = true;
        const run = (n: NativeProject, file: string, argv: string[], options: { env: Record<string, string> }): Promise<RunResult> =>
            file === "/bin/sh" && launchFails ? Promise.resolve({ code: 1, output: "gateway not ready" }) : sandbox.run(n, file, argv, options);
        const services = new StackServices({ config, openshell, run, forwardArgv: () => ["fwd"], spawnProcess: processes.spawnProcess, pollMs: 1, monitorMs: 5, portOpen: async () => true });

        await expect(services.start(native)).rejects.toThrow("could not start carapa-brain service");
        expect(processes.started).toHaveLength(0);

        launchFails = false;
        const deadline = Date.now() + 2_000;
        while (!processes.started.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        services.stop(native);
        // The monitor recovered the service and its forward; overlapping monitor ticks launched it once.
        expect(processes.started).toHaveLength(1);
        expect(sandbox.commands.filter(c => c.file === "/bin/sh")).toHaveLength(1);
    });
});
