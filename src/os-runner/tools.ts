/**
 * MCP tools served by the native runner over the hub WebSocket. They mirror
 * the CarapaBox tool contracts Board relies on for a project's lifecycle;
 * container-only tools answer with a clear "not supported" error.
 */
import fs from "node:fs";
import path from "node:path";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../logger.js";
import { closeFd, openFileAt, withParent } from "../runs/fd-path.js";
import { applyIpcOps, IpcStore, validateRelativePath, type IpcOp } from "../runs/ipc-store.js";
import { syncIpcRoot, type SyncRequest } from "../runs/ipc-sync.js";
import type { RunnerConfig } from "./config.js";
import { mapBoardEnv, mapContainerPath, prepareProject, projectName, runtimeEnv, type NativeProject } from "./projects.js";
import type { CredentialStore } from "./credentials.js";
import type { CommandWrapper } from "./os-sandbox.js";
import type { StackServices } from "./stack-service.js";
import { ProjectHost, type HostRunOptions } from "./sandbox-host.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
const json = (value: unknown, isError = false) => text(JSON.stringify(value), isError);
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const failure = (error: unknown) => json({ error: errorText(error) }, true);

/** Creates, starts and stops the sandbox a project's commands run in. */
export interface SandboxBackend {
    /** Create or recreate the project's sandbox and start it (sandbox_start). */
    provision(native: NativeProject): Promise<void>;
    /** Start it if it is not running (first command after a runner restart). */
    ensure(native: NativeProject): Promise<void>;
    stop(native: NativeProject): Promise<void>;
}

export interface RunnerContext {
    config: RunnerConfig;
    /** A stack's long-lived service on the OpenShell backend (CarapaBrain). */
    services?: StackServices;
    projects: Map<string, NativeProject>;
    credentials: CredentialStore;
    /** Confines every process started for a project (os-sandbox.ts). */
    wrap: CommandWrapper;
    /** Sandbox hosts kept across hub reconnects: one per project for agents, and a second (hostKey) for its shell tab. */
    hosts: Map<string, ProjectHost>;
    /** Board's tmux tab (tmux.ts); its pane readers end with the project. */
    tmux?: { stopProject(project: string): Promise<void> };
    /** Board's browser viewer (browser.ts); its helpers run in the agent host, so they end before it closes. */
    browser?: { stopProject(project: string): Promise<void> };
    /** Sandbox lifecycle of backends that need one (OpenShell); Seatbelt has none. */
    backend?: SandboxBackend;
    save(): void;
}

/** Split a trusted command line (no shell): quotes group words; metacharacters are refused. */
export function splitCommand(command: string): string[] {
    const argv: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    let started = false;
    for (const ch of command.trim()) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
        if (/\s/.test(ch)) {
            if (started) { argv.push(current); current = ""; started = false; }
            continue;
        }
        if (";|&<>`$\\".includes(ch)) throw new Error(`Shell syntax is not allowed: ${ch}`);
        current += ch;
        started = true;
    }
    if (quote) throw new Error("Unterminated quote");
    if (started) argv.push(current);
    return argv;
}

/**
 * Board launches restart continuations as `run-agent.sh <dir> && : > <dir>/<receipt>`.
 * Accept exactly that form: run the command, then create the receipt on success.
 */
export function parseExecCommand(command: string): { argv: string[]; receipt?: string } {
    const match = /^(.*?)\s*&&\s*:\s*>\s*(\S+)\s*$/.exec(command);
    if (match) return { argv: splitCommand(match[1]), receipt: match[2] };
    return { argv: splitCommand(command) };
}

/** Only executables shipped in the runtime bin dir may run (as a container's trusted set). */
export function trustedExecutable(config: RunnerConfig, name: string): string {
    const base = path.basename(name);
    if (name !== base && path.dirname(name) !== config.runtimeBinDir && !/\/bin$/.test(path.dirname(name))) {
        throw new Error(`Untrusted executable path: ${name}`);
    }
    validateRelativePath(base);
    const file = path.join(config.runtimeBinDir, base);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || (stat.mode & 0o111) === 0) throw new Error(`Not a trusted runtime command: ${base}`);
    return file;
}

function project(ctx: RunnerContext, name: string, instance?: string): NativeProject {
    const key = projectName(name, instance);
    const found = ctx.projects.get(key);
    if (!found) throw new Error(`Sandbox not started on this runner: ${key}`);
    return found;
}

function ipcStoreFor(ctx: RunnerContext, args: { tree?: string; project?: string; name?: string; instance?: string }): IpcStore {
    if (args.tree === "group") {
        if (!args.project) throw new Error("tree='group' requires project");
        const segments = validateRelativePath(args.project);
        if (segments.length !== 1) throw new Error("Invalid group folder");
        return new IpcStore(path.join(ctx.config.root, "groups", args.project));
    }
    const key = args.project ?? projectName(args.name ?? "", args.instance);
    return new IpcStore(path.join(ctx.config.root, "ipc", projectName(key)));
}

/**
 * Key of a project's host in ctx.hosts. Agents use the project's own host; Board's
 * shell tab uses a second one with the pty profile. '#' is not valid in a project name.
 */
export const hostKey = (project: string, shell: boolean): string => (shell ? `${project}#shell` : project);

/** Run a command for a project inside its sandbox host (started on first use); `shell` selects the shell tab's host and profile. */
export async function runSandboxed(ctx: RunnerContext, native: NativeProject, file: string, argv: string[], options: HostRunOptions, shell = false) {
    // Before the host lookup: callers racing here share one attempt, and the host map is only read afterwards.
    await ctx.backend?.ensure(native);
    const key = hostKey(native.project, shell);
    let host = ctx.hosts.get(key);
    if (!host) {
        host = new ProjectHost((hostArgv, env) => ctx.wrap(native, hostArgv[0], hostArgv.slice(1), env, { shell }), native.repoDir);
        ctx.hosts.set(key, host);
    }
    return host.run(file, argv, options);
}

/** Close and forget one of a project's sandbox hosts. */
export function closeHost(ctx: RunnerContext, project: string, shell: boolean): void {
    const key = hostKey(project, shell);
    ctx.hosts.get(key)?.close();
    ctx.hosts.delete(key);
}

/** Whether two states of a project give its sandbox the same working directory, workspace view and writable mounts. */
function sameSandboxDirs(a: NativeProject, b: NativeProject): boolean {
    const mounts = (native: NativeProject) => JSON.stringify([native.repoDir, native.groupDir, native.workspaceRoot, [...(native.extraMounts ?? [])].sort()]);
    return mounts(a) === mounts(b);
}

/** worker.pid of a run, read through directory handles with a 32-byte cap; undefined when absent or not a plain small file. */
function readWorkerPid(native: NativeProject, runName: string): number | undefined {
    const pidPath = path.join(native.ipcDir, "runs", runName, "worker.pid");
    try {
        return withParent(native.ipcDir, ["runs", runName, "worker.pid"], {}, (dirFd, leaf) => {
            const fd = openFileAt(dirFd, leaf, fs.constants.O_RDONLY);
            try {
                const buf = Buffer.alloc(32);
                const n = fs.readSync(fd, buf, 0, buf.length, null);
                if (n >= buf.length) throw new Error("worker.pid too large");
                return Number(buf.toString("utf8", 0, n).trim());
            } finally {
                closeFd(fd);
            }
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn({ project: native.project, path: pidPath, err: (error as Error).message }, "[runner] skipping run with unsafe worker.pid");
        }
        return undefined;
    }
}

/** Most log bytes sandbox_logs reads from the end of a run's stderr log. */
const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Tail of the newest run's agent-stderr.log. The agent writes ipcDir, so every component is opened
 * through directory handles without following symlinks and the log must be a regular file: a planted
 * symlink or FIFO raises an error instead of reading a host file or blocking the runner.
 */
function readLatestRunLog(ipcDir: string): string | undefined {
    let entries: string[];
    try {
        entries = fs.readdirSync(path.join(ipcDir, "runs"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    let best: { fd: number; mtimeMs: number; size: number } | undefined;
    try {
        for (const entry of entries) {
            let fd: number;
            try {
                fd = withParent(ipcDir, ["runs", entry, "agent-stderr.log"], {}, (dirFd, leaf) => openFileAt(dirFd, leaf, fs.constants.O_RDONLY));
            } catch (error) {
                // Not a run directory, or no log yet.
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ENOENT" || code === "ENOTDIR") continue;
                throw error;
            }
            const { mtimeMs, size } = fs.fstatSync(fd);
            if (best && best.mtimeMs >= mtimeMs) { closeFd(fd); continue; }
            if (best) closeFd(best.fd);
            best = { fd, mtimeMs, size };
        }
        if (!best) return undefined;
        const start = Math.max(0, best.size - MAX_LOG_BYTES);
        const buf = Buffer.alloc(best.size - start);
        let filled = 0;
        while (filled < buf.length) {
            const n = fs.readSync(best.fd, buf, filled, buf.length - filled, start + filled);
            if (n <= 0) break;
            filled += n;
        }
        const content = buf.toString("utf8", 0, filled);
        // A tail that starts mid-file begins with a partial line.
        return start > 0 ? content.slice(content.indexOf("\n") + 1) : content;
    } finally {
        if (best) closeFd(best.fd);
    }
}

export function liveRunDirs(native: NativeProject): string[] {
    const runs = path.join(native.ipcDir, "runs");
    const dirs: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(runs, { withFileTypes: true });
    } catch (error) {
        // The agent can write to ipcDir, so it may remove or replace `runs`: no runs to stop then.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(runs, entry.name);
        if (fs.existsSync(path.join(dir, "metrics_complete"))) continue;
        try {
            const pid = readWorkerPid(native, entry.name);
            if (pid !== undefined && Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); dirs.push(dir); }
        } catch { /* no worker or not alive */ }
    }
    return dirs;
}

function statusEntries(native: NativeProject | undefined, key: string) {
    return [{
        Name: `${key}-agent-1`,
        Service: "agent",
        State: native?.running ? "running" : "exited",
        Status: native?.running ? `Up since ${native.startedAt} (native runner)` : "Exited",
        Health: "",
    }];
}

/**
 * Program each harness.py harness launches on the host (adapters in
 * stacks/carapa-bot/bin/runtime/harnesses). Antigravity runs fixed paths.
 */
const HARNESS_PROGRAMS: Record<string, string> = {
    claude: "claude", codex: "codex", pi: "pi", opencode: "opencode", omp: "omp",
    cursor: "agent", hermes: "hermes-acp", "prime-agent": "prime-agent",
};
const HARNESS_PATHS: Record<string, string[]> = {
    antigravity: ["/opt/carapa-harness/python-env/bin/python", "/opt/carapa-harness/venv/bin/python"],
    "antigravity-acp": ["/opt/carapa-harness/antigravity-acp/agy_acp_server.par"],
};

export const executable = (file: string): boolean => {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
};

/** Harnesses this runner can launch: their program is on the agents' PATH. */
export function installedNativeHarnesses(searchPath = process.env.PATH ?? ""): string[] {
    const dirs = searchPath.split(":").filter(Boolean);
    return [
        ...Object.entries(HARNESS_PROGRAMS).filter(([, program]) => dirs.some(dir => executable(path.join(dir, program)))),
        ...Object.entries(HARNESS_PATHS).filter(([, files]) => files.some(file => fs.existsSync(file))),
    ].map(([name]) => name).sort();
}

const UNSUPPORTED = [
    "sandbox_worktree", "sandbox_branch", "sandbox_publish_app", "build_service", "build_service_status", "restart_service", "sandbox_network_policy_reload",
];

export function registerRunnerTools(server: McpServer, ctx: RunnerContext): void {
    const tool = (name: string, description: string, schema: Record<string, z.ZodType>, cb: (args: any) => Promise<ToolResult>) =>
        (server.tool.bind(server) as any)(name, description, schema, cb);
    const log = (data: string) => server.sendLoggingMessage({ level: "info", data }).catch(() => { /* fire and forget */ });

    tool("sandbox_list", "List stacks available on this native runner.", {}, async () => json([ctx.config.openshell
        ? { name: "carapa-bot", description: "Native runner (OpenShell sandbox per project, no Docker Compose stack)", hasPolicy: false, harnesses: ctx.config.openshell.harnesses }
        : { name: "carapa-bot", description: "Native runner (reduced isolation: macOS Seatbelt sandbox, no container)", hasPolicy: false, harnesses: installedNativeHarnesses() }]));

    tool("sandbox_start", "Prepare a project's native workspace (no container).", {
        name: z.string(), instance: z.string().optional(), env: z.record(z.string(), z.string()).optional(), service: z.string().optional(),
    }, async ({ name, instance, env }) => {
        try {
            const native = prepareProject(ctx.config, name, instance, env ?? {}, ctx.projects.get(projectName(name, instance)));
            await ctx.backend?.provision(native);
            // Per-sandbox Board and mail credentials the relay forwarder attaches
            // (CarapaBox stores them the same way at sandbox_start).
            const agentHost = `${native.project}-agent-1`;
            if (env?.CARAPA_BOARD_API_TOKEN) ctx.credentials.set(agentHost, env.CARAPA_BOARD_API_TOKEN);
            if (env?.CARAPA_MAIL_MCP_TOKEN) ctx.credentials.set(agentHost, env.CARAPA_MAIL_MCP_TOKEN, "carapa-mail");
            // A host keeps the repo, cwd and sandbox policy it started with: replace it when they change.
            const previous = ctx.projects.get(native.project);
            if (previous && !sameSandboxDirs(previous, native)) {
                closeHost(ctx, native.project, false);
                closeHost(ctx, native.project, true);
            }
            ctx.projects.set(native.project, native);
            ctx.save();
            await ctx.services?.start(native, env);
            ctx.save();
            return text(`Started ${native.project} on the native runner (workspace ${native.repoDir}).`);
        } catch (error) {
            return text(`sandbox_start failed: ${errorText(error)}`, true);
        }
    });

    tool("sandbox_stop", "Stop a project's running agents on this runner.", {
        name: z.string(), instance: z.string().optional(),
    }, async ({ name, instance }) => {
        const key = projectName(name, instance);
        const native = ctx.projects.get(key);
        if (!native) return text(`Sandbox ${key} is not running.`);
        const failures: string[] = [];
        try {
            const stopAgent = trustedExecutable(ctx.config, "stop-agent.sh");
            for (const dir of liveRunDirs(native)) {
                try {
                    const result = await runSandboxed(ctx, native, stopAgent, [dir], {
                        env: runtimeEnv(native, ctx.config), timeoutMs: 15_000,
                    });
                    if (result.code !== 0) failures.push(`stop-agent.sh ${dir} exited ${result.code}`);
                } catch (error) {
                    failures.push(`stop-agent.sh ${dir} failed: ${errorText(error)}`);
                }
            }
        } catch (error) {
            failures.push(`could not list or stop runs: ${errorText(error)}`);
        } finally {
            // Shell readers run through the shell host, so they end before it closes.
            await ctx.tmux?.stopProject(key);
            await ctx.browser?.stopProject(key);
            ctx.services?.stop(native);
            // Closing the hosts does not kill agents; it only drops the sandbox hosts and the project's running state.
            closeHost(ctx, key, false);
            closeHost(ctx, key, true);
            native.running = false;
            ctx.save();
            try {
                await ctx.backend?.stop(native);
            } catch (error) {
                failures.push(`could not stop the sandbox: ${errorText(error)}`);
            }
        }
        if (failures.length) return text(`Stopped ${key} with errors: ${failures.join("; ")}`, true);
        return text(`Stopped ${key}.`);
    });

    tool("sandbox_status", "Native project status (sandbox_status contract).", {
        name: z.string(), instance: z.string().optional(), service: z.string().optional(), checkUpdates: z.boolean().optional(),
    }, async ({ name, instance, service }) => {
        const key = projectName(name, instance);
        const entries = statusEntries(ctx.projects.get(key), key);
        return json(service ? entries[0] : entries);
    });

    tool("sandbox_ps", "Running native projects (sandbox_ps contract).", { instance: z.string().optional() }, async ({ instance }) => {
        const rows = [...ctx.projects.values()]
            .filter(native => native.running && (!instance || native.instance === instance))
            .map(native => ({
                name: native.project, stack: native.stack, instance: native.instance, status: "running",
                services: [{ service: "agent", hostname: `${native.project}-agent-1`, status: "running", ports: [], ip: "127.0.0.1" }],
                // Where Board reaches a stack's service (CarapaBrain's API).
                ...(ctx.services?.has(native) ? { ingress: ctx.services.ingress(native) } : {}),
            }));
        return text(rows.length ? JSON.stringify(rows, null, 2) : "No running sandboxes found.");
    });

    tool("sandbox_exec", "Run one trusted runtime command natively for a project.", {
        name: z.string(), service: z.string(), command: z.string(), instance: z.string().optional(),
        timeout: z.number().optional(), env: z.record(z.string(), z.string()).optional(),
    }, async ({ name, command, instance, timeout, env }) => {
        try {
            const native = project(ctx, name, instance);
            if (!native.running) throw new Error(`Sandbox ${native.project} is stopped`);
            const parsed = parseExecCommand(command);
            const [executable, ...rest] = parsed.argv;
            if (!executable) throw new Error("Empty command");
            const file = trustedExecutable(ctx.config, executable);
            const argv = rest.map(arg => mapContainerPath(arg, native));
            const result = await runSandboxed(ctx, native, file, argv, {
                // Board's per-command environment (e.g. web_view's browser session);
                // the runner's own roots and relay settings win.
                env: { ...mapBoardEnv(env ?? {}, native, ctx.config), ...runtimeEnv(native, ctx.config) },
                timeoutMs: timeout ? timeout * 1000 : undefined,
                onOutput: log,
            });
            if (result.code === 0 && parsed.receipt) {
                const receipt = path.resolve(mapContainerPath(parsed.receipt, native));
                if (!receipt.startsWith(native.ipcDir + path.sep)) throw new Error("Receipt must be inside the IPC directory");
                const segments = path.relative(native.ipcDir, receipt).split(path.sep);
                try {
                    withParent(native.ipcDir, segments, { create: false }, (dirFd, leaf) => {
                        closeFd(openFileAt(dirFd, leaf, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC));
                    });
                } catch (error) {
                    logger.warn({ project: native.project, path: receipt, err: (error as Error).message }, "[runner] refused unsafe exec receipt");
                    throw error;
                }
            }
            return text(result.output || "(no output)", result.code !== 0);
        } catch (error) {
            return text(`Exec failed: ${errorText(error)}`, true);
        }
    });

    tool("sandbox_git", "Run git in a project's workspace (argv, no shell).", {
        name: z.string(), command: z.string(), instance: z.string().optional(), service: z.string().optional(), localRepo: z.string().optional(),
    }, async ({ name, command, instance }) => {
        try {
            const native = project(ctx, name, instance);
            const argv = splitCommand(command);
            if (argv[0] === "git") argv.shift();
            // Sandboxed like the agent (repository config and hooks are agent-writable
            // content); the user's own git credentials are therefore not available.
            const result = await runSandboxed(ctx, native, "git", argv, { env: runtimeEnv(native, ctx.config), timeoutMs: 120_000 });
            return text(result.output || "(no output)", result.code !== 0);
        } catch (error) {
            return text(`git failed: ${errorText(error)}`, true);
        }
    });

    tool("sandbox_ipc", "Batch file operations on a project's IPC (or group) tree.", {
        tree: z.enum(["ipc", "group"]).optional(), project: z.string().optional(), name: z.string().optional(), instance: z.string().optional(),
        ops: z.array(z.record(z.string(), z.any())).max(500),
    }, async ({ ops, ...target }) => {
        try {
            const store = ipcStoreFor(ctx, target);
            const results: unknown[] = [];
            for (const op of ops) {
                if (op.op === "prepareRuns") {
                    fs.mkdirSync(path.join(store.projectDir, "runs"), { recursive: true });
                    results.push({ ok: true, op: "prepareRuns" });
                } else {
                    results.push(...(await applyIpcOps(store, [op as unknown as IpcOp])));
                }
            }
            return json({ results });
        } catch (error) {
            return failure(error);
        }
    });

    tool("sandbox_ipc_sync", "Replicate an IPC (or group) subtree with Board's replica.", {
        tree: z.enum(["ipc", "group"]).optional(), project: z.string().optional(), name: z.string().optional(), instance: z.string().optional(),
        root: z.string(), base: z.record(z.string(), z.tuple([z.number(), z.number().nullable()])).optional(),
        push: z.array(z.object({ op: z.enum(["write", "remove", "mkdir"]), path: z.string(), data: z.string().optional(), offset: z.number().optional(), recursive: z.boolean().optional() })).max(2000).optional(),
        maxBytes: z.number().optional(), replicaId: z.string().optional(), exclude: z.array(z.string()).max(50).optional(),
    }, async ({ tree, project: target, name, instance, ...request }) => {
        try {
            const store = ipcStoreFor(ctx, { tree, project: target, name, instance });
            fs.mkdirSync(store.projectDir, { recursive: true });
            return json(await syncIpcRoot(store, request as SyncRequest));
        } catch (error) {
            return failure(error);
        }
    });

    tool("sandbox_ipc_projects", "IPC projects on this runner.", {}, async () => {
        const dir = path.join(ctx.config.root, "ipc");
        const projects = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : [];
        return json({ projects });
    });

    for (const [toolName, description] of [["group_list", "List a group directory path."], ["group_read", "Read a group file."], ["group_write", "Write or delete a group file."]] as const) {
        tool(toolName, description, {
            folder: z.string(), path: z.string().optional(), offset: z.number().optional(), maxBytes: z.number().optional(),
            data: z.string().optional(), encoding: z.enum(["utf8", "base64"]).optional(), remove: z.boolean().optional(),
        }, async (args) => {
            try {
                const store = ipcStoreFor(ctx, { tree: "group", project: args.folder });
                if (toolName === "group_list") return json({ entries: await store.list(args.path ?? "") });
                if (toolName === "group_read") return json(await store.read(args.path ?? "", args.offset ?? 0, args.maxBytes));
                if (args.remove) await store.remove(args.path ?? "", true);
                else await store.write(args.path ?? "", Buffer.from(args.data ?? "", args.encoding === "base64" ? "base64" : "utf8"));
                return json({ ok: true });
            } catch (error) {
                return failure(error);
            }
        });
    }

    tool("sandbox_relay_token", "Set or clear a sandbox's relay credential on this runner.", {
        name: z.string().min(1).max(200), service: z.string().max(100).optional(), value: z.string().min(1).max(4096).optional(), clear: z.boolean().optional(),
    }, async ({ name, service, value, clear }) => {
        if (clear) ctx.credentials.delete(name, service);
        else if (value) ctx.credentials.set(name, value, service);
        else return text("Provide value or clear=true", true);
        return json({ ok: true });
    });

    tool("sandbox_proxy_aliases", "No-op on the native runner (no ingress).", {
        name: z.string(), instance: z.string().optional(), aliases: z.array(z.string()).max(8),
    }, async () => json({ ok: true, aliases: [] }));

    tool("sandbox_ssh", "SSH is not available on the native runner.", {
        name: z.string(), instance: z.string().optional(), action: z.string().optional(),
    }, async () => json({ enabled: false, supported: false }));

    tool("sandbox_logs", "Recent runtime stderr of a project's runs.", {
        name: z.string(), service: z.string().optional(), tail: z.number().optional(), instance: z.string().optional(),
    }, async ({ name, instance, tail }) => {
        try {
            const native = project(ctx, name, instance);
            const lines = readLatestRunLog(native.ipcDir)?.split("\n") ?? [];
            return text(lines.slice(-(tail || 200)).join("\n") || "(no logs)");
        } catch (error) {
            return failure(error);
        }
    });

    for (const name of UNSUPPORTED) {
        tool(name, "Not supported on the native runner.", {}, async () =>
            text(`${name} is not supported on the native runner (no containers). Use the shared checkout mode for projects placed here.`, true));
    }
}
