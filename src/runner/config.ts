/**
 * Configuration of the native (Docker-less) runner, e.g. on a Mac.
 *
 * Read from ~/.carapa-runner/config.json (or CARAPA_RUNNER_CONFIG), with
 * environment overrides. The runner keeps everything under one root:
 *   <root>/ipc/<project>      Box-owned IPC trees (replicated by Board)
 *   <root>/groups/<folder>    group directories of projects placed here
 *   <root>/repos/<name>       repositories (@repo/<name>)
 *   <root>/home/<project>     agent HOME (harness config, Claude sandbox settings)
 *   <root>/workspaces/<project>  /workspace view (symlinks) for path mapping
 *   <root>/state              runner-private state (relay credentials)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** An extra mount of an OpenShell sandbox (e.g. the harness volume). Bind sources must be daemon-host paths. */
interface OpenShellMount {
    type: "bind" | "volume";
    source: string;
    target: string;
    readOnly: boolean;
    /** Directory inside a volume to mount (volumes only). */
    subpath?: string;
}

/** A long-lived service a stack runs next to its agents (CarapaBrain's HTTP API). */
export interface OpenShellService {
    /** Command that starts the service inside the sandbox. */
    argv: string[];
    /** Loopback port the service listens on inside the sandbox (passed as PORT). */
    port: number;
    /** Port `openshell forward` opens on the host for Board. */
    hostPort: number;
    /** Host address of that port. Containers reach the host through its Docker bridge address. */
    bind: string;
    /** Address Board dials (advertised through sandbox_ps). */
    host: string;
    /** HTTP path that answers 200 while the service is healthy. */
    health: string;
}

/** Per-stack differences of a project's sandbox, keyed by the stack name Board starts (e.g. carapa-brain). */
export interface OpenShellStack {
    /** Sandbox image of this stack's projects (default: the OpenShell image). */
    image?: string;
    /** KEY=VALUE file (the stack's .env) read at every service start. */
    envFile?: string;
    env: Record<string, string>;
    service?: OpenShellService;
}

/**
 * OpenShell backend: agents run in OpenShell sandboxes (one per project) instead of a
 * macOS Seatbelt profile, so the runner can serve a Linux host. Set `openshell` to enable it.
 */
export interface OpenShellConfig {
    /** The openshell CLI the runner drives (it talks to the gateway). */
    cli: string;
    /** Named gateway from `openshell gateway list`; unset uses the active one. */
    gateway?: string;
    /** Direct gateway URL instead of a stored gateway. */
    gatewayEndpoint?: string;
    /**
     * "docker" (default): containers through the gateway's Docker driver. "vm": microVMs through its
     * VM driver (own kernel; the image is exported as a rootfs archive, Docker volumes are copied to host
     * directories, and the gateway needs the VM driver; see docs/multi-host.md).
     */
    driver: "docker" | "vm";
    /** Sandbox image (a Docker image); it must contain bun, git and the agent runtime's tools. */
    image: string;
    /** bun inside the image (runs the sandbox host). */
    bun: string;
    /** Name sandboxes resolve for the runner's host side (relay forwarder). */
    relayHost: string;
    cpu?: string;
    memory?: string;
    /** Harness CLIs the image provides (sandbox_list advertises them to Board). */
    harnesses: string[];
    /** Extra mounts, e.g. the harness volume at /opt/carapa-harness/bin. */
    mounts: OpenShellMount[];
    /** Extra directories the sandbox may read (besides the system defaults and the mounts). */
    readOnlyPaths: string[];
    stacks: Record<string, OpenShellStack>;
}

export interface RunnerConfig {
    root: string;
    /** Runner-private state (projects, relay credentials, VM assets). Default <root>/state; a VM sandbox mounts root, so outside it there. */
    stateDir: string;
    hubUrl: string;
    boxId: string;
    /** Hub connection secret issued by Board (Admin → CarapaBox hosts). */
    credential: string;
    /** Central api-relay forwarder endpoint on the hub (https://hub:8443). */
    relayUpstream: string;
    relayUpstreamInsecure: boolean;
    /** Local forwarder port agents reach at 127.0.0.1 (advertised to Board). */
    relayPort: number;
    /** Agent runtime bin dir (stacks/carapa-bot/bin of this checkout). */
    runtimeBinDir: string;
    /** Absolute host paths projects may mount besides the runner root. */
    allowedRoots: string[];
    /** Network destinations sandboxed tool commands may reach. */
    allowedDomains: string[];
    /** Extra paths agents must never read (the home directory is already denied). */
    denyRead: string[];
    /** Extra paths under the home directory agents may read, e.g. a toolchain the defaults miss. */
    allowRead: string[];
    /**
     * Host serving the local models (llama.cpp, Ollama, ...) that agents
     * address as http://llama-proxy:<port>. Unset: no local models.
     */
    llamaUpstreamHost?: string;
    /** llama-proxy ports agents may use; each forwards to the same upstream port. */
    llamaPorts: number[];
    /** llama-proxy tool profiles (a copy of the hub's egress-proxy/tool_profiles.jsonc). */
    llamaToolProfiles: string;
    /**
     * Directory (e.g. the operator's AGENT_HOME/.codex) whose config.toml, *.config.toml profiles and
     * models/ are copied into every project's ~/.codex. Without it Codex only gets the relay provider.
     */
    codexSeed?: string;
    /** Run agents in OpenShell sandboxes (Linux) instead of Seatbelt. */
    openshell?: OpenShellConfig;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

type RawStack = Partial<Omit<OpenShellStack, "service">> & { service?: Partial<OpenShellService> };
type FileConfig = Partial<Omit<RunnerConfig, "openshell">> & {
    credentialFile?: string;
    openshell?: Partial<Omit<OpenShellConfig, "mounts" | "stacks">> & { mounts?: Array<Partial<OpenShellMount>>; stacks?: Record<string, RawStack> };
};

function readFileConfig(file: string): FileConfig {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error(`Cannot read runner config ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function parseStack(name: string, raw: RawStack): OpenShellStack {
    const service = raw.service;
    if (service) {
        const port = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
        if (!Array.isArray(service.argv) || !service.argv.length || !service.argv.every(arg => typeof arg === "string")) {
            throw new Error(`openshell.stacks.${name}.service.argv must be a command (list of strings)`);
        }
        if (!port(service.port) || !port(service.hostPort)) throw new Error(`openshell.stacks.${name}.service needs port and hostPort`);
        if (!service.host || !/^[A-Za-z0-9.-]+$/.test(service.host)) throw new Error(`openshell.stacks.${name}.service.host must be a host name or IP address`);
    }
    return {
        image: raw.image || undefined,
        envFile: raw.envFile ? path.resolve(raw.envFile) : undefined,
        env: raw.env ?? {},
        service: service ? {
            argv: service.argv!, port: service.port!, hostPort: service.hostPort!,
            bind: service.bind || "127.0.0.1", host: service.host!, health: service.health || "/health",
        } : undefined,
    };
}

function parseOpenShell(raw: NonNullable<FileConfig["openshell"]>): OpenShellConfig {
    const mounts = (raw.mounts ?? []).map((mount, index): OpenShellMount => {
        if ((mount.type !== "bind" && mount.type !== "volume") || !mount.source || !mount.target) {
            throw new Error(`openshell.mounts[${index}] needs type (bind|volume), source and target`);
        }
        if (!path.isAbsolute(mount.target) || (mount.type === "bind" && !path.isAbsolute(mount.source))) {
            throw new Error(`openshell.mounts[${index}]: target (and a bind source) must be absolute paths`);
        }
        if (mount.subpath && (mount.type !== "volume" || path.isAbsolute(mount.subpath) || mount.subpath.split("/").includes(".."))) {
            throw new Error(`openshell.mounts[${index}]: subpath is a relative path inside a volume`);
        }
        return { type: mount.type, source: mount.source, target: mount.target, readOnly: mount.readOnly !== false, ...(mount.subpath ? { subpath: mount.subpath } : {}) };
    });
    const config: OpenShellConfig = {
        cli: raw.cli || "openshell",
        gateway: raw.gateway || undefined,
        gatewayEndpoint: raw.gatewayEndpoint || undefined,
        driver: raw.driver === "vm" ? "vm" : "docker",
        image: raw.image || "",
        bun: raw.bun || "bun",
        relayHost: raw.relayHost || "host.openshell.internal",
        cpu: raw.cpu || undefined,
        memory: raw.memory || undefined,
        harnesses: raw.harnesses ?? ["claude"],
        mounts,
        readOnlyPaths: (raw.readOnlyPaths ?? []).map(entry => path.resolve(entry)),
        stacks: {},
    };
    for (const [name, stack] of Object.entries(raw.stacks ?? {})) config.stacks[name] = parseStack(name, stack);
    if (raw.driver !== undefined && raw.driver !== "docker" && raw.driver !== "vm") throw new Error("openshell.driver must be \"docker\" or \"vm\"");
    if (!config.image) throw new Error("openshell.image is required");
    if (!/^[A-Za-z0-9.-]+$/.test(config.relayHost)) throw new Error("openshell.relayHost must be a host name or IP address");
    return config;
}

/** A CARAPA_RUNNER_* variable. */
const runnerEnv = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[`CARAPA_RUNNER_${name}`] || undefined;

/** The real path when it exists: a checkout reached through a symlink must have one path (the VM mounts it once). */
function realPathOr(target: string): string {
    try { return fs.realpathSync(target); } catch { return target; }
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
    const home = os.homedir();
    const root = path.resolve(runnerEnv(env, "ROOT") || path.join(home, ".carapa-runner"));
    const file = readFileConfig(runnerEnv(env, "CONFIG") || path.join(root, "config.json"));
    const credentialFromFile = file.credentialFile ? fs.readFileSync(file.credentialFile, "utf8").trim() : "";
    const config: RunnerConfig = {
        root,
        stateDir: path.resolve(runnerEnv(env, "STATE_DIR") || file.stateDir || path.join(root, "state")),
        hubUrl: env.CARAPA_HUB_URL || file.hubUrl || "",
        boxId: env.CARAPA_BOX_ID || file.boxId || "",
        credential: env.CARAPA_HUB_BOX_SECRET || file.credential || credentialFromFile,
        relayUpstream: env.CARAPA_RELAY_UPSTREAM || file.relayUpstream || "",
        relayUpstreamInsecure: (env.CARAPA_RELAY_UPSTREAM_INSECURE || "") === "1" || file.relayUpstreamInsecure === true,
        relayPort: Number(runnerEnv(env, "RELAY_PORT") || file.relayPort || 18080),
        runtimeBinDir: realPathOr(path.resolve(runnerEnv(env, "BIN_DIR") || file.runtimeBinDir || path.join(REPO_ROOT, "stacks", "carapa-bot", "bin"))),
        allowedRoots: (file.allowedRoots ?? []).map(entry => path.resolve(entry)),
        allowedDomains: file.allowedDomains ?? ["localhost", "127.0.0.1"],
        denyRead: (file.denyRead ?? []).map(entry => path.resolve(entry)),
        allowRead: (file.allowRead ?? []).map(entry => path.resolve(entry)),
        llamaUpstreamHost: env.CARAPA_LLAMA_UPSTREAM_HOST || file.llamaUpstreamHost || undefined,
        llamaPorts: file.llamaPorts ?? [3001, 8881, 11434, 12434],
        llamaToolProfiles: path.resolve(file.llamaToolProfiles || path.join(root, "tool_profiles.jsonc")),
        codexSeed: file.codexSeed ? path.resolve(file.codexSeed) : undefined,
        openshell: file.openshell ? parseOpenShell(file.openshell) : undefined,
    };
    const missing = (["hubUrl", "boxId", "credential", "relayUpstream"] as const).filter(key => !config[key]);
    if (missing.length) throw new Error(`Runner config is missing: ${missing.join(", ")}`);
    if (!Number.isInteger(config.relayPort) || config.relayPort < 1024 || config.relayPort > 65535) {
        throw new Error("relayPort must be between 1024 and 65535");
    }
    if (config.llamaUpstreamHost && !/^[A-Za-z0-9.-]+$/.test(config.llamaUpstreamHost)) {
        throw new Error("llamaUpstreamHost must be a host name or IP address");
    }
    if (!config.llamaPorts.every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
        throw new Error("llamaPorts must be TCP port numbers");
    }
    return config;
}
