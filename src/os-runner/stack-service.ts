/**
 * The long-lived service a stack runs beside its agents on an OpenShell sandbox
 * (CarapaBrain's HTTP API). In Docker it is the container's main process and
 * Board reaches it through the box's ingress; here the runner
 *   - starts it detached inside the project's sandbox (it survives the runner),
 *   - keeps it healthy (restarts it, and the forward below, when they die),
 *   - publishes its port on the host with `openshell forward service` (the sandbox
 *     has no network, so this is the only way in), and
 *   - reports that address to Board as an `ingress` entry of sandbox_ps.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { logger } from "../logger.js";
import type { OpenShellConfig, OpenShellService, OpenShellStack, RunnerConfig } from "./config.js";
import { stackOf } from "./openshell.js";
import { mapBoardEnv, projectTmpRoot, runtimeEnv, type NativeProject } from "./projects.js";

export interface RunResult { code: number; output: string }
export interface ServiceDeps {
    config: RunnerConfig;
    openshell: OpenShellConfig;
    /** Runs a command inside the project's sandbox. */
    run(native: NativeProject, file: string, argv: string[], options: { env: Record<string, string>; timeoutMs?: number }): Promise<RunResult>;
    /** argv of `openshell forward service` for a project's sandbox. */
    forwardArgv(native: NativeProject, service: OpenShellService): string[];
    /** Starts a process (injected by tests). */
    spawnProcess?: (argv: string[]) => ChildProcess;
    /** Health poll interval after a start (ms). */
    pollMs?: number;
    /** Health monitor interval (ms; injected by tests). */
    monitorMs?: number;
    /** Resolves true once something accepts connections at host:port (injected by tests). */
    portOpen?: (host: string, port: number) => Promise<boolean>;
}

/** `direct`: Board dials host:port as advertised (not through its local ingress edge address). */
export interface IngressEntry { service: string; kind: "http"; host: string; port: number; direct: true }

/** Board variables the service may receive. Everything else Board sends describes an agent container. */
const BOARD_ENV = ["CARAPA_BOARD_API_TOKEN"];
/** Provider keys the relay injects; their real values must not reach the sandbox from a stack file. */
const MANAGED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
const RESTART_DELAY_MS = 3_000;
const MONITOR_INTERVAL_MS = 30_000;
const HEALTH_WAIT_MS = 45_000;

/** KEY=VALUE lines of a stack's .env (comments and `export` allowed; surrounding quotes removed). */
export function parseEnvFile(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        // A quoted value may be followed by a ` # comment`; the first closing quote that leaves only a comment ends it.
        const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(value);
        value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
        env[match[1]] = value;
    }
    return env;
}

/**
 * Environment of a stack's service for one project: the runtime environment agents get, the stack's
 * own settings (container addresses rewritten to the relay forwarder), and the paths the container
 * layout would have provided as /workspace/*.
 */
export function serviceEnv(native: NativeProject, config: RunnerConfig, stack: OpenShellStack, service: OpenShellService, boardEnv: Record<string, string> = {}): Record<string, string> {
    let fromFile: Record<string, string> = {};
    if (stack.envFile) fromFile = parseEnvFile(fs.readFileSync(stack.envFile, "utf8"));
    const board = Object.fromEntries(BOARD_ENV.filter(key => boardEnv[key]).map(key => [key, boardEnv[key]]));
    const runtime = runtimeEnv(native, config);
    return {
        ...runtime,
        ...mapBoardEnv({ ...fromFile, ...stack.env, ...board }, native, config),
        // The sandbox never holds a provider credential: the relay-managed placeholders win over the stack's file.
        ...Object.fromEntries(MANAGED_KEYS.map(key => [key, runtime[key]])),
        PORT: String(service.port),
        GROUP_DIR: native.groupDir,
        IPC_RUNS_DIR: path.join(native.ipcDir, "runs"),
        BRAIN_RUN_DIR: path.join(native.ipcDir, "brain-runs"),
        SESSION_LOG_PATH: path.join(native.groupDir, "session-log.jsonl"),
    };
}

const tcpOpen = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
});

const defaultSpawn = (argv: string[]): ChildProcess => spawn(argv[0], argv.slice(1), { stdio: "ignore" });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class StackServices {
    private readonly forwards = new Map<string, ChildProcess>();
    /** Projects whose service the runner keeps running. */
    private readonly wanted = new Map<string, NativeProject>();
    private readonly starting = new Map<string, Promise<void>>();
    private monitor: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly deps: ServiceDeps) {}

    private service(native: NativeProject): { stack: OpenShellStack; service: OpenShellService } | undefined {
        const stack = stackOf(this.deps.openshell, native);
        return stack?.service ? { stack, service: stack.service } : undefined;
    }

    /** Whether this project's stack runs a service. */
    has(native: NativeProject): boolean {
        return !!this.service(native);
    }

    private async healthy(native: NativeProject, service: OpenShellService): Promise<boolean> {
        const result = await this.deps.run(native, "wget", ["-qO-", "-T", "3", `http://127.0.0.1:${service.port}${service.health}`], { env: {}, timeoutMs: 15_000 });
        return result.code === 0;
    }

    private async launch(native: NativeProject, stack: OpenShellStack, service: OpenShellService): Promise<void> {
        const env = native.serviceEnv ?? serviceEnv(native, this.deps.config, stack, service);
        const log = path.join(projectTmpRoot(native.project), "service.log");
        // Detached from the exec session: the service outlives this command and the runner.
        // It starts in the project's repository (the container's working_dir): it writes relative to it.
        const script = 'log="$1"; shift; mkdir -p "$(dirname "$log")"; setsid "$@" >>"$log" 2>&1 </dev/null & exit 0';
        const result = await this.deps.run(native, "/bin/sh", ["-c", script, "sh", log, ...service.argv], { env, timeoutMs: 30_000 });
        if (result.code !== 0) throw new Error(`could not start ${native.stack} service (${result.code}): ${result.output.trim().slice(-300)}`);
    }

    /** Make the project's service run: start it unless it answers, and wait until it does. */
    ensureRunning(native: NativeProject): Promise<void> {
        // One start per project at a time: the monitor must not launch a second copy of a service that is still starting.
        const pending = this.starting.get(native.project)
            ?? this.ensureRunningNow(native).finally(() => this.starting.delete(native.project));
        this.starting.set(native.project, pending);
        return pending;
    }

    private async ensureRunningNow(native: NativeProject): Promise<void> {
        const found = this.service(native);
        if (!found) return;
        const { stack, service } = found;
        if (await this.healthy(native, service)) return;
        logger.info({ project: native.project, stack: native.stack }, "[runner] starting stack service");
        await this.launch(native, stack, service);
        const deadline = Date.now() + HEALTH_WAIT_MS;
        while (Date.now() < deadline) {
            await sleep(this.deps.pollMs ?? 1_000);
            if (await this.healthy(native, service)) return;
        }
        throw new Error(`${native.stack} service did not become healthy within ${HEALTH_WAIT_MS / 1000}s (log: ${path.join(projectTmpRoot(native.project), "service.log")})`);
    }

    private startForward(native: NativeProject, service: OpenShellService): void {
        if (this.forwards.has(native.project)) return;
        const child = (this.deps.spawnProcess ?? defaultSpawn)(this.deps.forwardArgv(native, service));
        this.forwards.set(native.project, child);
        const onEnd = () => {
            if (this.forwards.get(native.project) !== child) return;
            this.forwards.delete(native.project);
            const current = this.wanted.get(native.project);
            if (current) setTimeout(() => { if (this.wanted.get(native.project) === current) this.startForward(current, service); }, RESTART_DELAY_MS).unref?.();
        };
        child.once("exit", onEnd);
        child.once("error", onEnd);
    }

    /** Start (or adopt) the service and publish its port; `boardEnv` is Board's sandbox_start environment. */
    async start(native: NativeProject, boardEnv?: Record<string, string>): Promise<void> {
        const found = this.service(native);
        if (!found) return;
        if (boardEnv || !native.serviceEnv) native.serviceEnv = serviceEnv(native, this.deps.config, found.stack, found.service, boardEnv);
        this.wanted.set(native.project, native);
        // Before the first start: a start that fails (slow gateway or service) is retried by the monitor.
        this.monitor ??= setInterval(() => void this.check(), this.deps.monitorMs ?? MONITOR_INTERVAL_MS);
        this.monitor.unref?.();
        await this.ensureRunning(native);
        this.startForward(native, found.service);
        await this.waitForForward(found.service);
    }

    /** Board's first request follows sandbox_start: return once the published port accepts connections. */
    private async waitForForward(service: OpenShellService): Promise<void> {
        const open = this.deps.portOpen ?? tcpOpen;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (await open(service.bind === "0.0.0.0" ? "127.0.0.1" : service.bind, service.hostPort)) return;
            await sleep(this.deps.pollMs ?? 200);
        }
        logger.warn({ port: service.hostPort }, "[runner] published service port is not accepting connections yet");
    }

    /** Keep services of the projects that were running before a runner restart. */
    async restore(projects: Iterable<NativeProject>): Promise<void> {
        for (const native of projects) {
            if (!native.running || !this.has(native)) continue;
            try {
                await this.start(native);
            } catch (error) {
                logger.warn({ project: native.project, err: error instanceof Error ? error.message : String(error) }, "[runner] stack service not restored");
            }
        }
    }

    private async check(): Promise<void> {
        for (const native of this.wanted.values()) {
            const found = this.service(native);
            if (!found || !native.running) continue;
            try {
                await this.ensureRunning(native);
                this.startForward(native, found.service);
            } catch (error) {
                logger.warn({ project: native.project, err: error instanceof Error ? error.message : String(error) }, "[runner] stack service unhealthy");
            }
        }
    }

    /** Stop publishing the project's service (the sandbox stop ends the service itself). */
    stop(native: NativeProject): void {
        this.wanted.delete(native.project);
        const forward = this.forwards.get(native.project);
        this.forwards.delete(native.project);
        forward?.kill();
        if (!this.wanted.size && this.monitor) { clearInterval(this.monitor); this.monitor = null; }
    }

    /** Runner shutdown: close the forwards, leave the services running in their sandboxes. */
    stopAll(): void {
        for (const native of [...this.wanted.values()]) this.stop(native);
    }

    /** sandbox_ps `ingress` entries: where Board reaches the project's service. */
    ingress(native: NativeProject): IngressEntry[] {
        const found = this.service(native);
        return found ? [{ service: "agent", kind: "http", host: found.service.host, port: found.service.hostPort, direct: true }] : [];
    }
}
