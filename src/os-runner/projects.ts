/**
 * Native project "sandboxes": directory layout, path mapping and the agent
 * home (Claude settings, Board MCP server). Isolation is the per-project OS
 * sandbox applied by os-sandbox.ts to every process started for a project.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { closeFd, mkdirAt, openDirChain, openFileAt, unlinkAt, writeAtomicAt } from "../runs/fd-path.js";
import { validateRelativePath } from "../runs/ipc-store.js";
import type { RunnerConfig } from "./config.js";

export interface NativeProject {
    project: string;
    stack: string;
    instance: string;
    ipcDir: string;
    groupDir: string;
    repoDir: string;
    workspaceRoot: string;
    agentHome: string;
    /** Extra mounts (EXTRA_MOUNT_n) resolved on this host; absent in older state. */
    extraMounts?: string[];
    /**
     * Secret part of the project's relay address (/s/<project>/<capability>),
     * new at every sandbox_start. Only this project's sandbox receives it.
     */
    relayCapability?: string;
    /** Environment of the stack's service (OpenShell backend), kept to restart it after a runner restart. */
    serviceEnv?: Record<string, string>;
    running: boolean;
    startedAt: string;
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9_.-]{0,120}$/;

export function projectName(name: string, instance?: string): string {
    const project = instance ? `${name}-${instance}` : name;
    if (!PROJECT_NAME.test(project)) throw new Error(`Invalid project: ${project}`);
    return project;
}

function within(target: string, roots: string[]): boolean {
    const resolved = path.resolve(target);
    return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

/**
 * Resolve a mount value from Board: logical (@group/@repo) under the runner
 * root, or an absolute host path inside the configured allowed roots.
 */
export function resolveMount(value: string, config: RunnerConfig): string {
    const logical = /^@(group|repo)(?:\/(.*))?$/.exec(value);
    if (logical) {
        const [, kind, rest = ""] = logical;
        if (kind === "repo" && !rest) throw new Error("@repo requires a repository name");
        return path.join(config.root, kind === "group" ? "groups" : "repos", ...validateRelativePath(rest, kind === "group"));
    }
    if (!path.isAbsolute(value)) throw new Error(`Mount must be absolute or logical: ${value}`);
    const real = realpathDeepest(value);
    const root = realpathDeepest(config.root);
    if (within(real, [root])) {
        const [top, name] = path.relative(root, real).split(path.sep);
        if ((top !== "groups" && top !== "repos") || !name) {
            throw new Error(`Mount ${value} is inside the runner root but not under groups/<name> or repos/<name>`);
        }
        return real;
    }
    if (!within(real, config.allowedRoots.map(realpathDeepest))) {
        throw new Error(`Mount ${value} is outside the runner root and allowedRoots`);
    }
    return real;
}

/** Real path of an absolute path whose tail may not exist yet: resolve the deepest existing ancestor. */
function realpathDeepest(target: string): string {
    let existing = path.resolve(target);
    const rest: string[] = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(existing), ...rest);
        } catch (error) {
            const parent = path.dirname(existing);
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === existing) throw error;
            rest.unshift(path.basename(existing));
            existing = parent;
        }
    }
}

/** Rebuild <root>/workspaces/<project> so /workspace/<x> maps like the container mounts. */
function buildWorkspaceView(view: string, workspacePath: string, repoDir: string, extra: Array<[string, string]>): string {
    if (workspacePath === "/workspace" || !workspacePath.startsWith("/workspace/")) return repoDir;
    fs.rmSync(view, { recursive: true, force: true });
    fs.mkdirSync(view, { recursive: true });
    const link = (name: string, target: string) => {
        const segments = validateRelativePath(name);
        const at = path.join(view, ...segments);
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.symlinkSync(target, at);
    };
    link(workspacePath.slice("/workspace/".length), repoDir);
    for (const [name, target] of extra) link(name, target);
    return view;
}

/**
 * Claude Code settings for a native project. The whole process already runs
 * inside the project's Seatbelt profile, and macOS cannot nest a second
 * Seatbelt sandbox, so Claude Code's own Bash sandbox stays off.
 */
export function claudeSettings() {
    return { sandbox: { enabled: false } };
}

/**
 * Register Board's MCP server in the agent's Claude user config (as fixmcp.sh does in containers).
 * The agent can write agentHome, so the file is read and replaced through a directory handle:
 * a symlink or non-regular file counts as "no config" and is replaced, never followed.
 */
function registerBoardMcp(homeFd: number, project: string, agentHome: string, relay: string): void {
    let current: Record<string, unknown> = {};
    try {
        const fd = openFileAt(homeFd, ".claude.json", fs.constants.O_RDONLY);
        try { current = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { closeFd(fd); }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") logger.warn({ project, path: path.join(agentHome, ".claude.json"), code }, "[runner] ignoring unreadable agent .claude.json");
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) current = {};
    const servers = { ...(current.mcpServers as Record<string, unknown> | undefined) };
    servers["carapa-board"] = { type: "http", url: `${relay}/mcp-relay/mcp/carapa-board` };
    writeAtomicAt(homeFd, ".claude.json", Buffer.from(JSON.stringify({ ...current, mcpServers: servers }, null, 2)));
}

export interface StartEnv {
    GROUP_DIR?: string;
    LOCAL_REPO?: string;
    WORKSPACE_PATH?: string;
    [key: string]: string | undefined;
}

/** Open agentHome/.claude as a real directory; a planted symlink or file is removed and recreated. */
function openClaudeDir(homeFd: number, project: string, agentHome: string): number {
    try {
        return openDirChain(agentHome, [".claude"]);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
            logger.warn({ project, path: path.join(agentHome, ".claude"), code }, "[runner] replacing non-directory agent .claude");
            unlinkAt(homeFd, ".claude");
        }
        mkdirAt(homeFd, ".claude");
        return openDirChain(agentHome, [".claude"]);
    }
}

/**
 * Pi's model list in the agent home, as the container entrypoint (configure_pi_models) writes it:
 * the managed providers replace same-named ones, other providers are kept. Their container
 * addresses point at the relay forwarder. Optional: a missing template or unusable directory
 * only loses the Pi models, it does not stop the project.
 */
function registerPiModels(native: NativeProject, config: RunnerConfig): void {
    const templatePath = path.join(checkoutRoot(config), "stacks", "carapa-bot", "pi-models.json");
    const relay = relayUrl(native, config);
    const text = fs.readFileSync(templatePath, "utf8")
        .replace(/http:\/\/api-relay:8080(?=\/|")/g, relay)
        .replace(/http:\/\/llama-proxy:(\d+)(?=\/|")/g, (_, port) => `${relay}/llama-proxy/${port}`);
    const managed = JSON.parse(text) as { providers: Record<string, unknown> };
    const piFd = openDirChain(native.agentHome, [".pi", "agent"], { create: true });
    try {
        let current: { providers?: Record<string, unknown> } & Record<string, unknown> = {};
        try {
            const fd = openFileAt(piFd, "models.json", fs.constants.O_RDONLY);
            try { current = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { closeFd(fd); }
        } catch { /* absent or unreadable: start from the managed list */ }
        if (typeof current !== "object" || current === null || Array.isArray(current)) current = {};
        const merged = { ...current, providers: { ...current.providers, ...managed.providers } };
        writeAtomicAt(piFd, "models.json", Buffer.from(JSON.stringify(merged, null, 2)));
    } finally {
        closeFd(piFd);
    }
}

/**
 * Codex's model provider in the agent home. Containers share the operator's ~/.codex/config.toml,
 * whose `relay` provider sends Codex through api-relay; a native home starts empty, so Codex would
 * dial api.openai.com directly (refused by the sandbox). Written once and left alone afterwards:
 * the runtime copies it into each run's Codex home and points `api-relay:8080` at the forwarder.
 * WebSockets stay off (here and in copied seeds): the runner's forwarder runs under Bun, whose
 * http server cannot answer an upgrade request, so Codex would retry four times before using HTTP.
 */
const CODEX_SEED = `model_provider = "relay"

[model_providers.relay]
name = "relay"
base_url = "http://api-relay:8080/codex"
wire_api = "responses"
supports_websockets = false
`;

/** Operator files copied into a project's ~/.codex, with the container's home path made real. */
function codexSeedFiles(seed: string, codexDir: string): Array<{ name: string; models: boolean; data: Buffer }> {
    const files: Array<{ name: string; models: boolean; data: Buffer }> = [];
    const read = (dir: string, name: string, models: boolean) => {
        const file = path.join(dir, name);
        if (!fs.lstatSync(file).isFile()) return;
        const data = fs.readFileSync(file);
        const text = data.toString("utf8").replaceAll("/home/ubuntu/.codex", codexDir).replace(/^(\s*supports_websockets\s*=\s*)true/gm, "$1false");
        files.push({ name, models, data: models ? data : Buffer.from(text) });
    };
    for (const name of fs.readdirSync(seed)) if (name === "config.toml" || name.endsWith(".config.toml")) read(seed, name, false);
    const models = path.join(seed, "models");
    if (fs.existsSync(models)) for (const name of fs.readdirSync(models)) if (name.endsWith(".json")) read(models, name, true);
    return files;
}

function seedCodexConfig(native: NativeProject, config: RunnerConfig): void {
    const codexDir = path.join(native.agentHome, ".codex");
    const codexFd = openDirChain(native.agentHome, [".codex"], { create: true });
    try {
        if (config.codexSeed) {
            // Operator-managed files: refreshed at every start, as containers read them live.
            const modelsFd = openDirChain(native.agentHome, [".codex", "models"], { create: true });
            try {
                for (const file of codexSeedFiles(config.codexSeed, codexDir)) writeAtomicAt(file.models ? modelsFd : codexFd, file.name, file.data);
            } finally {
                closeFd(modelsFd);
            }
            return;
        }
        try {
            closeFd(openFileAt(codexFd, "config.toml", fs.constants.O_RDONLY));
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        writeAtomicAt(codexFd, "config.toml", Buffer.from(CODEX_SEED));
    } finally {
        closeFd(codexFd);
    }
}

/** Claude settings and the Board MCP server in the agent home (written via directory handles). */
function prepareAgentHome(native: NativeProject, config: RunnerConfig): void {
    const homeFd = openDirChain(native.agentHome, [], { create: true });
    try {
        const claudeFd = openClaudeDir(homeFd, native.project, native.agentHome);
        try {
            writeAtomicAt(claudeFd, "settings.json", Buffer.from(JSON.stringify(claudeSettings(), null, 2)));
        } finally {
            closeFd(claudeFd);
        }
        registerBoardMcp(homeFd, native.project, native.agentHome, relayUrl(native, config));
        try {
            registerPiModels(native, config);
        } catch (error) {
            logger.warn({ project: native.project, error: String(error) }, "[runner] Pi models not written");
        }
        try {
            seedCodexConfig(native, config);
        } catch (error) {
            logger.warn({ project: native.project, error: String(error) }, "[runner] Codex config not written");
        }
    } finally {
        closeFd(homeFd);
    }
}

/**
 * Create (or refresh) a native project from sandbox_start's environment. `running` is the project's
 * current entry: a refresh keeps its registered relay capability, so a start that fails after this
 * leaves the agent home pointing at the capability the relay still accepts.
 */
export function prepareProject(config: RunnerConfig, name: string, instance: string | undefined, env: StartEnv, running?: NativeProject): NativeProject {
    const project = projectName(name, instance);
    const ipcDir = path.join(config.root, "ipc", project);
    const groupDir = resolveMount(env.GROUP_DIR || `@group/${instance || name}`, config);
    const repoDir = resolveMount(env.LOCAL_REPO || env.GROUP_DIR || `@group/${instance || name}`, config);
    const extra: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(env)) {
        const slot = /^EXTRA_MOUNT_(\d+)$/.exec(key);
        const mountName = slot ? env[`EXTRA_MOUNT_${slot[1]}_NAME`] : undefined;
        if (slot && value && mountName) extra.push([mountName, resolveMount(value, config)]);
    }
    for (const dir of [path.join(ipcDir, "runs"), path.join(ipcDir, "sessions"), groupDir, repoDir]) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(projectTmpRoot(project), { recursive: true, mode: 0o700 });
    const workspaceRoot = buildWorkspaceView(path.join(config.root, "workspaces", project), env.WORKSPACE_PATH || "/workspace", repoDir, extra);
    const agentHome = path.join(config.root, "home", project);
    const native: NativeProject = {
        project, stack: name, instance: instance || name, ipcDir, groupDir, repoDir, workspaceRoot, agentHome,
        extraMounts: extra.map(([, target]) => target), relayCapability: (running?.running && running.relayCapability) || randomBytes(32).toString("hex"),
        running: true, startedAt: new Date().toISOString(),
    };
    prepareAgentHome(native, config);
    return native;
}

function requireDir(label: string, dir: string): void {
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} ${dir} no longer exists`);
}

/**
 * Bring one project saved as running back after a runner restart. Throws when it cannot run
 * (directories gone or outside the allowed roots, no relay capability, agent home not writable).
 * The saved relayCapability is kept: agents that outlived the restart still use it.
 */
function restoreProject(native: NativeProject, config: RunnerConfig): void {
    if (!native.relayCapability) throw new Error("no saved relay capability");
    for (const dir of [native.groupDir, native.repoDir, ...(native.extraMounts ?? [])]) {
        requireDir("directory", dir);
        resolveMount(dir, config);
    }
    requireDir("IPC directory", native.ipcDir);
    requireDir("workspace", native.workspaceRoot);
    // prepareAgentHome would silently recreate a missing home; a deleted one means the project is gone.
    requireDir("agent home", native.agentHome);
    prepareAgentHome(native, config);
    // /tmp may have been cleared by a reboot; the shell dir is created like tmux does (startup files are written on use).
    fs.mkdirSync(projectTmpRoot(native.project), { recursive: true, mode: 0o700 });
    fs.mkdirSync(shellDir(config, native.project), { recursive: true, mode: 0o700 });
}

/**
 * Keep the projects that were running when the runner last saved running; a project that cannot be
 * restored is marked stopped (Board's next sandbox_start handles it). Never throws for one project.
 * Sandbox hosts are not started here: they start on first use. The caller saves the result.
 */
export function restoreProjects(projects: Iterable<NativeProject>, config: RunnerConfig): void {
    for (const native of projects) {
        if (!native.running) continue;
        try {
            restoreProject(native, config);
        } catch (error) {
            native.running = false;
            logger.warn({ project: native.project, reason: error instanceof Error ? error.message : String(error) }, "[runner] project not restored, marked stopped");
        }
    }
}

/**
 * Read the saved projects. A missing file is a first run. A file that does not parse (a crash or a
 * full disk cut an older non-atomic save short) is moved aside as projects.json.corrupt-<time> so the
 * next save does not overwrite it; the runner then starts without projects. Other read errors throw.
 */
export function loadProjects(stateFile: string): Map<string, NativeProject> {
    const projects = new Map<string, NativeProject>();
    let raw: string;
    try {
        raw = fs.readFileSync(stateFile, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return projects;
        throw error;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        for (const entry of parsed as NativeProject[]) projects.set(entry.project, entry);
        return projects;
    } catch (error) {
        const backup = `${stateFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.renameSync(stateFile, backup);
        logger.error({ stateFile, backup, reason: error instanceof Error ? error.message : String(error) }, "[runner] projects state unreadable, kept as backup and starting without projects");
        return new Map();
    }
}

/** Write the saved projects through a temp file and rename, so a crash or full disk leaves the previous file intact. */
export function saveProjects(stateFile: string, projects: Iterable<NativeProject>): void {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify([...projects], null, 2), { mode: 0o600 });
        fs.renameSync(tmp, stateFile);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
}

/** This carapa-box checkout (the runtime bin dir is stacks/carapa-bot/bin). */
export function checkoutRoot(config: RunnerConfig): string {
    return path.resolve(config.runtimeBinDir, "..", "..", "..");
}

/**
 * The project's temporary root. Board places browser daemon sockets under
 * /tmp/; they are redirected here, the only place the project's sandbox may
 * use Unix sockets. Short: macOS limits socket paths to 104 bytes.
 */
export function projectTmpRoot(project: string): string {
    return `/tmp/cb-${createHash("sha256").update(project).digest("hex").slice(0, 8)}`;
}

/**
 * Private dir of the project's shell tab (tmux socket, pane FIFOs, startup files):
 * <root>/shell/<8 hex>. It is under the runner root, which the agent profile
 * neither reads nor writes, so agents cannot connect to its socket. Only the
 * shell sandbox may use it. Short: macOS limits socket paths to 104 bytes.
 */
export function shellDir(config: RunnerConfig, project: string): string {
    let root = path.resolve(config.root);
    try { root = fs.realpathSync(root); } catch { /* not created yet: the path as configured */ }
    return path.join(root, "shell", createHash("sha256").update(project).digest("hex").slice(0, 8));
}

/** The project's address on the runner's local relay forwarder (as the project's sandbox resolves it). */
export function relayUrl(project: Pick<NativeProject, "project" | "relayCapability">, config: RunnerConfig): string {
    const host = config.openshell?.relayHost ?? "127.0.0.1";
    return `http://${host}:${config.relayPort}/s/${project.project}/${project.relayCapability ?? ""}`;
}

/** The Playwright CLI backend installed with this checkout (the bin/playwright-cli shim runs it). */
function playwrightBackend(config: RunnerConfig): Record<string, string> {
    const cli = path.join(checkoutRoot(config), "node_modules", "@playwright", "cli", "playwright-cli.js");
    return fs.existsSync(cli) ? { CARAPA_PLAYWRIGHT_REAL: cli } : {};
}

/**
 * Environment Board sent for a container, translated for this project: the
 * same mapping the runtime applies to args.json (runtime/roots.ts
 * hostEnvValue), for commands the runner starts directly.
 */
export function mapBoardEnv(env: Record<string, string>, project: NativeProject, config: RunnerConfig): Record<string, string> {
    const relay = relayUrl(project, config);
    const map = (value: string): string => {
        const container = /^(https?|wss?):\/\/api-relay:8080(?=\/|$)/.exec(value);
        if (container) return (container[1].startsWith("ws") ? relay.replace(/^http/, "ws") : relay) + value.slice(container[0].length);
        const llama = /^http:\/\/llama-proxy:(\d+)(?=\/|$)/.exec(value);
        if (llama) return `${relay}/llama-proxy/${llama[1]}${value.slice(llama[0].length)}`;
        if (value.startsWith("/tmp/pwcli-")) return `${projectTmpRoot(project.project)}/${value.slice("/tmp/".length)}`;
        return mapContainerPath(value, project);
    };
    return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, map(value)]));
}

/** Environment for runtime processes of a project (agents never see real credentials). */
export function runtimeEnv(project: NativeProject, config: RunnerConfig, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const relay = relayUrl(project, config);
    const env: Record<string, string> = {};
    // Pinned harness selection (container images) is passed through when present.
    for (const key of ["PATH", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME", "TERM", "CARAPA_HARNESS_SNAPSHOT"]) {
        const value = base[key];
        if (value) env[key] = value;
    }
    return {
        ...env,
        PATH: `${config.runtimeBinDir}:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
        HOME: project.agentHome,
        // Per-project (0700) temp dir instead of the runner's shared one.
        TMPDIR: projectTmpRoot(project.project),
        CARAPA_IPC_ROOT: project.ipcDir,
        CARAPA_GROUP_ROOT: project.groupDir,
        CARAPA_WORKSPACE_ROOT: project.workspaceRoot,
        CARAPA_RELAY_URL: relay,
        ANTHROPIC_BASE_URL: `${relay}/anthropic`,
        ANTHROPIC_API_KEY: "relay-managed",
        OPENAI_API_KEY: "relay-managed",
        GEMINI_API_KEY: "relay-managed",
        GOOGLE_GEMINI_BASE_URL: `${relay}/google`,
        MEMORY_PROJECT: project.instance,
        CARAPA_TMP_ROOT: projectTmpRoot(project.project),
        ...playwrightBackend(config),
        NO_PROXY: "localhost,127.0.0.1",
    };
}

/** Map a container path from Board onto this project's host directories. */
export function mapContainerPath(value: string, project: NativeProject): string {
    const prefixes: Array<[string, string]> = [
        ["/workspace/ipc", project.ipcDir],
        ["/workspace/group", project.groupDir],
        ["/workspace", project.workspaceRoot],
    ];
    for (const [prefix, target] of prefixes) {
        if (value === prefix) return target;
        if (value.startsWith(`${prefix}/`)) return target + value.slice(prefix.length);
    }
    return value;
}
