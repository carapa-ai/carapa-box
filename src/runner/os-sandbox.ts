/**
 * OS sandbox for every process the native runner starts for a project.
 *
 * Claude Code's built-in sandbox covers only its Bash tool; its Read, Write,
 * Edit and web tools run outside it. The runner therefore confines the whole
 * agent runtime process tree with macOS Seatbelt, using the deny-by-default
 * profile of @anthropic-ai/sandbox-runtime:
 *   - reads: the user's home, /Volumes, the runner root and allowed roots are denied except this project's
 *     directories, the runtime checkout and the agent toolchain;
 *   - writes: only this project's directories and temporary space. Files that a
 *     trusted component outside the sandbox executes implicitly when the repository
 *     is merely opened (git hooks/config, nested .git, submodule config, .gitmodules,
 *     Claude Code settings/commands/agents, .mcp.json, IDE task folders) are denied;
 *     cloning, init or submodules inside the repo are therefore denied too (use $TMPDIR);
 *   - network: only the runner's local relay forwarder (127.0.0.1:<port>);
 *   - no Apple Events / LaunchServices, signals only within the sandbox.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Not re-exported from the package index; pinned to an exact version.
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import type { RunnerConfig } from "./config.js";
import { checkoutRoot, projectTmpRoot, shellDir, type NativeProject } from "./projects.js";

/**
 * Which profile a command gets. `shell` is the profile of Board's shell tab: the
 * project profile plus a pty and the runner-owned shell dir. Agents never get it.
 */
export interface WrapOptions { shell?: boolean }

/** Turns one project command into the argv the runner actually spawns. */
export type CommandWrapper = (native: NativeProject, file: string, argv: string[], env: Record<string, string>, options?: WrapOptions) => string[];

const TOOLCHAIN = ["claude", "bun", "node", "git", "tmux"];
const DEVICE_WRITES = ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"];
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function within(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Install locations of the agent toolchain under the home directory (they must stay readable). */
function toolchainReadRoots(searchPath: string, home = os.homedir()): string[] {
    const roots = new Set<string>();
    for (const name of TOOLCHAIN) {
        for (const dir of searchPath.split(":").filter(Boolean)) {
            const candidate = path.join(dir, name);
            if (!fs.existsSync(candidate)) continue;
            const installed = path.dirname(real(candidate));
            // An install prefix (<prefix>/bin/<tool>) also holds the tool's libraries.
            const prefix = path.basename(installed) === "bin" ? path.dirname(installed) : installed;
            for (const location of [path.dirname(candidate), installed, prefix]) {
                if (within(location, home) && location !== home) roots.add(location);
            }
            break;
        }
    }
    return [...roots];
}

/** PATH without directories the profile denies reading. */
function readablePath(searchPath: string, denyRead: string[], allowRead: string[]): string {
    return searchPath.split(":").filter(Boolean).filter(dir => {
        const resolved = real(dir);
        return !denyRead.some(deny => within(resolved, deny)) || allowRead.some(allow => within(resolved, allow));
    }).join(":");
}

/**
 * Write denies for files that run code when the repository is merely opened on the host.
 * Literals cover the root; globs (regex rules in Seatbelt) cover nested copies.
 */
function repoWriteDenies(dir: string): string[] {
    if (/[*?[\]]/.test(dir)) throw new Error(`protected repo path contains glob characters; refusing to start unconfined denies: ${dir}`);
    const literals = [".git/hooks", ".git/config", ".git/config.worktree", ".git/modules", ".gitmodules", ".mcp.json",
        ".claude/settings.json", ".claude/settings.local.json", ".claude/commands", ".claude/agents", ".vscode", ".idea"];
    const globs = ["*/**/.git", ".git/worktrees/*/config.worktree", "**/.gitmodules", "**/.mcp.json",
        "**/.claude/settings.json", "**/.claude/settings.local.json", "**/.claude/commands/**", "**/.claude/agents/**",
        "**/.vscode/**", "**/.idea/**"];
    return [...literals, ...globs].map(rel => path.join(dir, rel));
}

/** The Seatbelt policy for one project (paths only; exported for tests). */
export function projectPolicy(native: NativeProject, config: RunnerConfig, env: Record<string, string>, options: WrapOptions = {}) {
    const home = os.homedir();
    const projectDirs = [native.repoDir, native.groupDir, native.ipcDir, native.agentHome, ...(native.extraMounts ?? [])].map(real);
    const runtimeCheckout = real(checkoutRoot(config));
    // Known residual: the shared tmp write stays because harnesses may hard-code /tmp.
    const tmp = [real(os.tmpdir()), "/private/tmp", real(projectTmpRoot(native.project))];
    // The shell tab's private dir (tmux socket, pane FIFOs) is under the runner root, which agents cannot read.
    const shell = options.shell ? [real(shellDir(config, native.project))] : [];
    return {
        // The runner root and allowed roots hold other projects' repos, agent homes (relay
        // capabilities) and runner state; this project's own directories are re-allowed below.
        denyRead: [home, "/Volumes", config.root, ...config.allowedRoots, ...config.denyRead].map(real),
        allowRead: [...new Set([
            ...projectDirs, real(native.workspaceRoot), runtimeCheckout,
            ...toolchainReadRoots(env.PATH ?? "", home), ...config.allowRead.map(real), ...shell,
        ])],
        allowWrite: [...new Set([...projectDirs, ...tmp, ...DEVICE_WRITES, ...shell])],
        denyWrite: [native.repoDir, ...(native.extraMounts ?? [])].map(real).flatMap(repoWriteDenies),
        relayPort: config.relayPort,
        unixSockets: [real(projectTmpRoot(native.project)), ...shell],
        // allowPty opens every /dev/ttys*, not only ptys this sandbox created: the shell tab alone gets it.
        allowPty: options.shell === true,
    };
}

/** macOS: wrap a project command in its Seatbelt profile. */
export function seatbeltWrapper(config: RunnerConfig): CommandWrapper {
    return (native, file, argv, env, options) => {
        const policy = projectPolicy(native, config, env, options);
        // srt routes HTTP clients through its proxy; the runner has none, so
        // drop those variables and let the profile deny every destination
        // except the relay forwarder.
        // PATH entries the profile denies make program lookup fail with EPERM
        // instead of moving on, so only readable directories are kept.
        const command = ["exec", "/usr/bin/env", ...PROXY_VARS.flatMap(name => ["-u", name]),
            `PATH=${readablePath(env.PATH ?? "", policy.denyRead, policy.allowRead)}`, file, ...argv]
            .map((part, index) => index < 2 ? part : shellQuote(part)).join(" ");
        const wrapped = wrapCommandWithSandboxMacOS({
            command,
            needsNetworkRestriction: true,
            httpProxyPort: policy.relayPort,
            readConfig: { denyOnly: policy.denyRead, allowWithinDeny: policy.allowRead },
            writeConfig: { allowOnly: policy.allowWrite, denyWithinAllow: policy.denyWrite },
            allowLocalBinding: false,
            allowUnixSockets: policy.unixSockets,
            allowPty: policy.allowPty,
            allowAppleEvents: false,
        });
        return ["/bin/sh", "-c", wrapped];
    };
}

/**
 * The wrapper for this platform; there is no unconfined fallback. `openshell` is the OpenShell
 * backend's wrapper, used instead of Seatbelt when the config selects it.
 */
export function platformWrapper(config: RunnerConfig, openshell?: CommandWrapper): CommandWrapper {
    if (config.openshell) {
        if (!openshell) throw new Error("The OpenShell backend is configured but not available");
        return openshell;
    }
    if (process.platform !== "darwin") {
        throw new Error(`The native runner confines agents with macOS Seatbelt; ${process.platform} is not supported`);
    }
    if (!fs.existsSync("/usr/bin/sandbox-exec")) throw new Error("/usr/bin/sandbox-exec is missing; refusing to run agents unconfined");
    return seatbeltWrapper(config);
}
