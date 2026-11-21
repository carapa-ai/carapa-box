import { controlAppPublication } from '../app-publications.js';
import { trackToolCall } from '../shutdown-drain.js';
import { getConfigDir, getStateDir } from "../installation-paths.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildPreviewSyncScript, isSafePreviewSlug, parsePreviewConfName, previewConfName } from "./worktree-preview.js";
import { fileExists, execDocker, resolveStackAndProject, resolveOwnedProjects, sanitizeStatusObject, parseEnvFile, shellQuote, splitDockerOutput } from "../utils.js";
import { SandboxPsSchema, SandboxStartSchema, SandboxProxyAliasesSchema, SandboxLogsSchema, type ServiceInfo } from "./schemas.js";
import { listStacks, getStack, isValidStackName, getStacksDir } from "../config.js";
import { pinSandboxMounts } from "../sandbox-mounts.js";
import { toHostPath, startStack, stopStack, stopSandboxProcesses, getStackStatus, execInService, execArgvInService, getServiceLogs, getStackServices, listProjects, execDockerRun, execCompose } from "../compose/client.js";
import { runHook, formatHookResult, findUnsafeHookEnvKeys } from "../compose/hooks.js";
import { lockProjectStartup, recordProjectStartup, runProjectAfterStart } from "../compose/project-startup.js";
import { parseCommandArgv, splitRestartRecoveryReceipt, validateCommand, resolveTrustedCommand, filterEnvPassthrough, validateMountPaths, validateComposeFileEnv, pinMountSource } from "../security.js";
import { hasOpaPolicy } from "../policy.js";
import { reloadNetworkPolicies, scheduleNetworkPolicyReload } from "../network-policy.js";
import { auditLog } from "../audit.js";
import { logger } from "../logger.js";
import { issueConfigFor, parseGitRepository, validateParams, buildCurlCommand, parseCurlResponse, type IssueParams } from "../issues.js";
import { configuredProviderAccounts } from "../provider-accounts.js";
import { loadManagedServices, buildService, restartService, requestHostBuild, getHostBuildStatus } from "../deploy.js";
import { setRelayToken, deleteRelayToken } from "../relay-token-store.js";
import { configuredNginxProxyDomains, defaultNginxProxyHostnames, listNginxProxyUrls, nginxProxyEnabled, registerNginxProxyRoute } from "../nginx-proxy.js";
import { controlSandboxSsh, type SandboxSshStatus } from "../sandbox-ssh.js";
import { ingressEnabled, listIngressEndpoints } from '../ingress.js';
import { reuseManagedWorktree } from "./worktree-reuse.js";
import type { GitCommandResult } from "./pinned-git.js";
import { STAGE_SANITIZE_SCRIPT, workspaceMountArgs, gitHardeningEnvArgs, remotePinRequired, resolveRemotePin, runPinnedRemoteGit, validateRemoteUrl } from "./pinned-git.js";
import { registerIpcTools } from "../runs/tools.js";
import { resolveLogicalMount } from "../runs/ipc-store.js";
import { registerHubTools } from "../hub/hub-tools.js";
import { SLASH_COMMANDS_SCRIPT, parseSlashCommands } from "./slash-commands.js";
import { prepareSandboxDirectory } from "../sandbox-directories.js";
import { readContainerInventory, containerServiceInfo, type ContainerStatus } from '../compose/inventory.js';


// Helper type to break deep type inference in tool callbacks
type ToolResult = CallToolResult;

/** Load managed services; a malformed config entry becomes a named tool error instead of a thrown TypeError. */
async function tryLoadManagedServices(): Promise<{ services: Awaited<ReturnType<typeof loadManagedServices>> } | { error: ToolResult }> {
    try {
        return { services: await loadManagedServices(getConfigDir()) };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ error: message }, "[managed_services] invalid config");
        return { error: { content: [{ type: "text", text: `Invalid managed services config: ${message}` }], isError: true } };
    }
}

const remoteUrlSchema = z.string().optional().describe("Trusted SSH remote URL (git@host:path or ssh://...). Pins every keyed git operation; the repo's own remote config is ignored.");

/** Remote commands must not implicitly rewrite the caller's checkout on failure. */
export async function runRemoteGitCommand(
    command: string,
    execute: (command: string) => Promise<GitCommandResult>,
): Promise<ToolResult> {
    try {
        const result = await execute(command);
        return {
            content: [{ type: "text", text: result.stdout || result.stderr || "(no output)" }],
            isError: result.code !== 0,
        };
    } catch (error) {
        logger.warn({ command, error: String(error) }, "[sandbox_git] remote command failed");
        return {
            content: [{ type: "text", text: `Git operation failed: ${error}` }],
            isError: true,
        };
    }
}

type StatusCandidate = { safe: Record<string, unknown>; containerName: string; imageName: string };
type WorktreeHookResult = {
    present: boolean;
    ok: boolean;
    output: string;
    data?: unknown;
};

const WORKTREE_HOOK_RESULT_PREFIX = "CARAPA_HOOK_RESULT=";

function toStatusCandidate(obj: Record<string, unknown>, serviceFilter?: string): StatusCandidate | undefined {
    const service = (obj.Service ?? obj.service ?? "") as string;
    if (serviceFilter && service !== serviceFilter) return undefined;
    const safe = sanitizeStatusObject(obj);
    if (!safe) return undefined;
    return {
        safe,
        containerName: (safe.Name as string) || (obj.Name as string) || "",
        imageName: (safe.Image as string) || (obj.Image as string) || "",
    };
}

/** Collect termination evidence after a command dies with SIGKILL/137. */
async function collectTerminationEvidence(
    stackPath: string,
    projectName: string | undefined,
    service: string,
): Promise<string> {
    try {
        const ps = await execCompose(stackPath, ["ps", "-q", service], {
            allowFailure: true,
            projectName,
        });
        const containerId = splitDockerOutput(ps.stdout)[0];
        if (!containerId) return "termination evidence: container id unavailable";
        const inspected = await execDocker(["inspect", "--format", "{{json .State}}", containerId]);
        if (inspected.status !== 0) {
            return `termination evidence: docker inspect failed: ${inspected.stderr.trim() || `exit ${inspected.status}`}`;
        }
        let state: Record<string, unknown> = {};
        try { state = JSON.parse(inspected.stdout.trim()) as Record<string, unknown>; } catch { /* preserve raw below */ }
        const fields = ["Status", "Running", "OOMKilled", "ExitCode", "Error", "StartedAt", "FinishedAt"];
        const summary = fields
            .filter((field) => field in state)
            .map((field) => `${field}=${JSON.stringify(state[field])}`)
            .join(" ");
        return `termination evidence: container=${containerId} ${summary || inspected.stdout.trim()}`;
    } catch (error) {
        return `termination evidence unavailable: ${String(error)}`;
    }
}

// Serialize concurrent branch lifecycle mutations for the same worktree. Git
// worktrees share administrative state, so overlapping checkpoints can race.
const branchMutationTails = new Map<string, Promise<void>>();

async function withBranchMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = branchMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    branchMutationTails.set(key, current);
    await previous.catch(() => { /* a failed predecessor must not poison the queue */ });
    try {
        return await operation();
    } finally {
        release();
        if (branchMutationTails.get(key) === current) branchMutationTails.delete(key);
    }
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c"]);
const GIT_GLOBAL_OPTIONS_OPTIONAL_VALUE = ["--git-dir", "--work-tree", "--namespace"];
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "--bare", "-P", "--no-replace-objects", "--literal-pathspecs"]);
const GIT_REMOTE_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "ls-remote", "remote"]);

/** Returns the index of the git subcommand after skipping leading global options, or -1. */
function gitSubcommandIndex(argv: string[]): number {
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(tok)) { i++; continue; }
        if (GIT_GLOBAL_FLAGS.has(tok)) continue;
        if (GIT_GLOBAL_OPTIONS_OPTIONAL_VALUE.some((o) => tok.startsWith(`${o}=`))) continue;
        if (GIT_GLOBAL_OPTIONS_OPTIONAL_VALUE.includes(tok)) { i++; continue; }
        return i;
    }
    return -1;
}

/** Returns the git subcommand after skipping leading global options, or undefined. */
export function gitSubcommandFromArgv(argv: string[]): string | undefined {
    const idx = gitSubcommandIndex(argv);
    return idx < 0 ? undefined : argv[idx];
}

export function isRemoteGitSubcommand(subcommand: string | undefined): boolean {
    return subcommand !== undefined && GIT_REMOTE_SUBCOMMANDS.has(subcommand);
}

const BLOCKED_LONG_GIT_OPTIONS = ["--config-env", "--upload-pack", "--receive-pack", "--exec", "--exec-path"];

/**
 * Reject git arguments that can make git execute programs next to the SSH keys.
 * Returns an error message, or null when argv is acceptable on the remote path.
 */
export function validateRemoteGitArgv(argv: string[]): string | null {
    if (argv.length === 0) return "Empty git command";
    const subcommand = gitSubcommandFromArgv(argv);
    for (const tok of argv) {
        if (tok.startsWith("-c")) {
            return `Git option "${tok}" is not allowed on remote git commands (can execute programs)`;
        }
        if (tok.startsWith("--")) {
            const name = tok.split("=", 1)[0];
            if (name.length >= 3 && BLOCKED_LONG_GIT_OPTIONS.some((o) => o.startsWith(name))) {
                return `Git option "${tok}" is not allowed on remote git commands (can execute programs)`;
            }
        } else if (subcommand === "clone" && /^-[^-]*[cu]/.test(tok)) {
            return `Git option "${tok}" is not allowed on remote git clone (can execute programs)`;
        }
        if (/(^|[^a-z0-9])(ext|fd)::/i.test(tok)) {
            return `Git URL "${tok}" uses a disallowed transport (ext::/fd::)`;
        }
    }
    return null;
}

const REMOTE_GIT_SETUP = `cp -r /tmp/ssh-source /tmp/.ssh; chmod 700 /tmp/.ssh; chmod 600 /tmp/.ssh/* 2>/dev/null; chmod 644 /tmp/.ssh/*.pub 2>/dev/null; chmod 644 /tmp/.ssh/config 2>/dev/null`;

/** Repo-controlled config that would otherwise run programs next to the SSH keys. */
const REMOTE_GIT_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.alternateRefsCommand", ""],
    ["submodule.recurse", "false"],
    ["fetch.recurseSubmodules", "false"],
    ["push.recurseSubmodules", "no"],
    ["push.gpgSign", "false"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
];

const PULL_MERGE_FLAGS = new Set(["--ff-only", "--no-ff", "--ff"]);

/**
 * Split `pull [flags] [<remote> [<ref>...]]` into a remote fetch and a local
 * merge/rebase of FETCH_HEAD, so the keyed container never checks out or merges.
 */
export function planRemotePull(argv: string[]):
    | { ok: true; fetchArgv: string[]; localArgv: string[] }
    | { ok: false; reason: string } {
    const idx = gitSubcommandIndex(argv);
    if (idx < 0 || argv[idx] !== "pull") return { ok: false, reason: "not a pull command" };
    const globals = argv.slice(0, idx);
    let mode: "merge" | "rebase" = "merge";
    const mergeFlags: string[] = [];
    const positional: string[] = [];
    for (const tok of argv.slice(idx + 1)) {
        if (tok.startsWith("-") && positional.length === 0) {
            if (PULL_MERGE_FLAGS.has(tok)) { mergeFlags.push(tok); continue; }
            if (tok === "--rebase") { mode = "rebase"; continue; }
            if (tok === "--no-rebase") { mode = "merge"; continue; }
            return { ok: false, reason: `Unsupported pull option "${tok}": use fetch, then merge locally` };
        }
        if (tok.startsWith("-")) return { ok: false, reason: `Unsupported pull argument "${tok}": use fetch, then merge locally` };
        positional.push(tok);
    }
    // Plain `git pull` refuses divergent branches; keep that instead of silently merging.
    const flags = mergeFlags.length > 0 ? mergeFlags : ["--ff-only"];
    const localArgv = mode === "rebase"
        ? [...globals, "rebase", "FETCH_HEAD"]
        : [...globals, "merge", "--no-edit", ...flags, "FETCH_HEAD"];
    return { ok: true, fetchArgv: [...globals, "fetch", ...positional], localArgv };
}

/** Fetch via the keyed container, then merge/rebase FETCH_HEAD in the sandbox service. */
export async function pullViaFetchAndLocalMerge(
    pullArgv: string[],
    fetch: (argv: string[]) => Promise<GitCommandResult>,
    local: (argv: string[]) => Promise<GitCommandResult>,
    opts: { requireExplicitRef?: boolean } = {},
): Promise<GitCommandResult> {
    const plan = planRemotePull(pullArgv);
    if (!plan.ok) throw new Error(plan.reason);
    if (opts.requireExplicitRef) {
        const fetchIdx = gitSubcommandIndex(plan.fetchArgv);
        // positional: <remote> <ref>; without a ref FETCH_HEAD would mark every pinned branch for merge.
        if (plan.fetchArgv.slice(fetchIdx + 1).filter((t) => !t.startsWith("-")).length < 2) {
            throw new Error("A pinned remoteUrl requires an explicit ref: use 'pull origin <branch>' (or fetch, then merge)");
        }
    }
    const fetched = await fetch(plan.fetchArgv);
    if (fetched.code !== 0) return fetched;
    const merged = await local(plan.localArgv);
    return {
        code: merged.code,
        stdout: [fetched.stdout, merged.stdout].filter(Boolean).join("\n"),
        stderr: [fetched.stderr, merged.stderr].filter(Boolean).join("\n"),
    };
}

/** Fast-forward the local base branch: fetch in the keyed container, merge FETCH_HEAD locally (only if fetch succeeded). */
export function fastForwardBaseFromRemote(
    base: string,
    fetch: (argv: string[]) => Promise<GitCommandResult>,
    local: (argv: string[]) => Promise<GitCommandResult>,
): Promise<GitCommandResult> {
    return pullViaFetchAndLocalMerge(["pull", "--ff-only", "origin", base], fetch, local);
}

/** Keyed `docker run` args shared by the unpinned and pinned paths; caller text is only ever positional. */
function buildKeyedGitDockerArgs(mounts: string[], workdir: string, argv: string[], sshKeysPath: string, beforeGit = ""): string[] {
    return [
        ...mounts,
        "-w", workdir,
        "--user", "1000:1000",
        "-e", "GIT_SSH_COMMAND=ssh -F /tmp/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
        ...gitHardeningEnvArgs(REMOTE_GIT_CONFIG_OVERRIDES, "ssh"),
        "-v", `${sshKeysPath}:/tmp/ssh-source:ro`,
        "--entrypoint", "sh",
        "carapa/git-ssh", "-c", `${REMOTE_GIT_SETUP};${beforeGit} exec git "$@"`, "git-ssh", ...argv,
    ];
}

/** Build `docker run` args for the unpinned path (agent repo mounted); caller text is only ever passed as positional parameters. */
export function buildRemoteGitDockerArgs(
    argv: string[],
    opts: { repoPath: string; sshKeysPath: string; repoSubpath?: string },
): string[] {
    return buildKeyedGitDockerArgs(workspaceMountArgs(opts), "/workspace", argv, opts.sshKeysPath);
}

/** Build keyed `docker run` args for the pinned path: box-owned staging volume only, never the agent repo. */
function buildPinnedKeyedDockerArgs(mounts: string[], workdir: string, argv: string[], sshKeysPath: string): string[] {
    return buildKeyedGitDockerArgs(mounts, workdir, argv, sshKeysPath, mounts.length > 0 ? STAGE_SANITIZE_SCRIPT : "");
}

/** Validate a caller-supplied localRepo against the mount allowlist. */
export async function validateLocalRepoArg(localRepo: string): Promise<string | null> {
    return validateMountPaths({ LOCAL_REPO: localRepo });
}

/** Branch-name rules from `git check-ref-format --branch`, plus no leading '+'. Returns a reason or null. */
function validateHookBranchName(base: string): string | null {
    if (!base) return "base branch is empty";
    if (/^[-+]/.test(base)) return "base branch must not start with '-' or '+'";
    if (base.includes(":")) return "base branch must not contain ':'";
    if (base.includes("..")) return "base branch must not contain '..'";
    if (base === "@" || base.includes("@{")) return "base branch must not be '@' or contain '@{'";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x20\x7f~^?*[\\]/.test(base)) return "base branch contains a forbidden character";
    if (base.startsWith("/") || base.endsWith("/") || base.includes("//")) return "base branch has an empty path component";
    if (base.endsWith(".")) return "base branch must not end with '.'";
    if (base.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
        return "base branch component must not start with '.' or end with '.lock'";
    }
    return null;
}

/** True when a branch/base name is safe as a path segment and git ref: git rules, no '..' segments, shell-inert charset. */
export function isSafeBranchArg(branch: string): boolean {
    return validateHookBranchName(branch) === null
        && /^[A-Za-z0-9._/-]+$/.test(branch);
}

/** True when `worktreePath` is exactly `.worktrees/<valid branch>` (relative, no '..'). */
export function isValidWorktreePathArg(worktreePath: string): boolean {
    const prefix = ".worktrees/";
    return worktreePath.startsWith(prefix) && isSafeBranchArg(worktreePath.slice(prefix.length));
}

const INVALID_BRANCH_RESULT = { content: [{ type: "text" as const, text: "Invalid branch name" }], isError: true };

/**
 * Push a hook-reported linked repository. The hook output is agent-written, so
 * localRepo and base are validated before the keyed git-ssh container sees them.
 */
export async function pushLinkedRepository(
    repository: Record<string, unknown>,
    defaultBase: string,
    sshKeysPath: string,
    onLog?: (chunk: string) => void,
    deps: {
        exec?: typeof execRemoteGit;
        validateRepo?: (localRepo: string) => Promise<string | null>;
    } = {},
): Promise<void> {
    const repoPath = typeof repository.localRepo === "string" ? repository.localRepo : "";
    if (!repoPath) return;
    if (remotePinRequired()) {
        repository.pushed = false;
        repository.pushError = "remote URL not pinned";
        logger.warn(
            { repository: repository.name },
            "[sandbox_branch:merge] linked repository push skipped: no trusted remote URL (GIT_REMOTE_PIN_REQUIRED=true)",
        );
        return;
    }
    logger.warn({ repository: repository.name }, "[git] unpinned remote (linked repository)");
    const base = typeof repository.base === "string" ? repository.base : defaultBase;
    const reason = (await (deps.validateRepo ?? validateLocalRepoArg)(repoPath)) ?? validateHookBranchName(base);
    if (reason) {
        repository.pushed = false;
        repository.pushError = reason;
        logger.warn(
            { repository: repository.name, reason },
            "[sandbox_branch:merge] linked repository push skipped: invalid hook data",
        );
        return;
    }
    try {
        const pushResult = await (deps.exec ?? execRemoteGit)(
            ["push", "origin", "--", `refs/heads/${base}:refs/heads/${base}`],
            { repoPath, sshKeysPath, onLog },
        );
        repository.pushed = pushResult.code === 0;
    } catch (pushErr) {
        repository.pushed = false;
        logger.warn(
            { repository: repository.name, pushErr: String(pushErr) },
            "[sandbox_branch:merge] linked repository push failed",
        );
    }
}

export function strictWorktreeHooksEnabled(stackEnv: Record<string, string>): boolean {
    return /^(1|true|yes|on)$/i.test(stackEnv.WORKTREE_HOOKS_STRICT || "");
}

export function parseWorktreeHookData(output: string): unknown {
    const line = output
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith(WORKTREE_HOOK_RESULT_PREFIX));
    if (!line) return undefined;
    const payload = line.slice(WORKTREE_HOOK_RESULT_PREFIX.length);
    try {
        return JSON.parse(payload);
    } catch (err) {
        logger.warn(
            { error: err instanceof Error ? err.message : String(err), payload: payload.slice(0, 200) },
            "[parseWorktreeHookData] malformed hook result JSON ignored",
        );
        return undefined;
    }
}

const BENIGN_STOP_ERROR = /\bnot running\b|\bno such (container|service)\b|\bno containers?\b/i;

export function isBenignStopError(message: string): boolean {
    return BENIGN_STOP_ERROR.test(message);
}

/**
 * Run a best-effort lifecycle step. Failures never propagate. Benign "not running"
 * style errors are logged as a one-line note; anything else is logged as a warning
 * and returned so callers can surface it.
 */
export async function runBestEffortLifecycleStep(
    operation: string,
    step: () => Promise<unknown>,
    log: (msg: string) => void,
): Promise<string | undefined> {
    try {
        await step();
        return undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isBenignStopError(message)) {
            logger.debug({ operation, error: message }, "[lifecycle] best-effort step skipped (benign)");
            log(`[lifecycle] ${operation}: ${message} (ignored)\n`);
            return undefined;
        }
        const warning = `${operation} failed: ${message}`;
        logger.warn({ operation, error: message }, "[lifecycle] best-effort step failed");
        log(`[lifecycle] WARNING ${warning}\n`);
        return warning;
    }
}

function hookRepositories(data: unknown): Array<Record<string, unknown>> {
    if (!data || typeof data !== "object") return [];
    const repositories = (data as { repositories?: unknown }).repositories;
    return Array.isArray(repositories)
        ? repositories.filter((repository): repository is Record<string, unknown> =>
            !!repository && typeof repository === "object")
        : [];
}

export function scopeRepositoryCommand(command: string, repoPath: string | undefined, git: boolean): string {
    if (!repoPath) return command;
    return git
        ? `-C ${shellQuote(repoPath)} ${command}`
        : `cd ${shellQuote(repoPath)} && ${command}`;
}

function repositoryExecutors(
    stackPath: string,
    service: string,
    projectName: string,
    repoPath: string | undefined,
    onLog: (chunk: string) => void,
) {
    return {
        execGit: async (cmd: string) => {
            const scopedCmd = scopeRepositoryCommand(cmd, repoPath, true);
            const gitCmd = `git config --global safe.directory '*' 2>/dev/null; git ${scopedCmd}`;
            return execInService(stackPath, service, gitCmd, projectName, onLog);
        },
        execShell: async (cmd: string, env?: Record<string, string>) => execInService(
            stackPath, service, scopeRepositoryCommand(cmd, repoPath, false),
            projectName, onLog, undefined, env,
        ),
    };
}

export function branchActionCheckout(
    worktreePath?: string,
): { checkoutPath: string; gitPrefix: string; usesWorktree: boolean } {
    if (!worktreePath) {
        return { checkoutPath: ".", gitPrefix: "", usesWorktree: false };
    }
    return {
        checkoutPath: worktreePath,
        gitPrefix: `-C ${shellQuote(worktreePath)}`,
        usesWorktree: true,
    };
}

export async function commitSandboxBranch(opts: {
    branch: string;
    message: string;
    paths?: string[];
    worktreePath?: string;
    repoPath?: string;
    repoPathError?: string;
    execGit: (cmd: string) => Promise<GitCommandResult>;
}): Promise<{ committed: boolean; message: string } | { error: string }> {
    const { branch, message, paths, worktreePath, repoPath, repoPathError, execGit } = opts;
    const workingDir = worktreePath || repoPath;
    const gitPrefix = workingDir ? `-C ${shellQuote(workingDir)} ` : "";

    if (!worktreePath) {
        if (!repoPath) {
            return { error: `commit failed: could not resolve repository path inside service${repoPathError ? `: ${repoPathError}` : ""}` };
        }
        // symbolic-ref also resolves the branch before its first commit.
        const headResult = await execGit(`${gitPrefix}symbolic-ref --quiet --short HEAD`);
        if ((headResult.stdout || "").trim() !== branch) {
            const checkoutResult = await execGit(`${gitPrefix}checkout ${branch}`);
            if (checkoutResult.code !== 0) {
                return { error: `commit failed: could not checkout ${branch}: ${checkoutResult.stderr || checkoutResult.stdout}` };
            }
        }
    }

    const quotedPaths = paths?.map(shellQuote).join(" ") ?? "";
    const pathsStr = quotedPaths ? ` -- ${quotedPaths}` : "";
    const statusResult = await execGit(`${gitPrefix}status --porcelain${pathsStr}`);
    if (!(statusResult.stdout || "").trim()) return { committed: false, message: "no changes" };

    const addTarget = quotedPaths || ".";
    const addResult = await execGit(`${gitPrefix}add -- ${addTarget}`);
    if (addResult.code !== 0) return { error: `git add failed: ${addResult.stderr || addResult.stdout}` };

    const commitResult = await execGit(`${gitPrefix}commit -m ${shellQuote(message)}`);
    if (commitResult.code !== 0) return { error: `commit failed: ${commitResult.stderr || commitResult.stdout}` };
    return { committed: true, message };
}

export type DefaultCheckoutMergeResult = {
    merged: boolean;
    pushed: false;
    output: string;
};

/**
 * Merge a task branch from the repository's primary checkout without ever
 * taking ownership of edits already present there. In particular, this helper
 * must not stash user changes: callers can safely retry after the user commits
 * or manually stashes them.
 */
export async function mergeIntoCleanDefaultCheckout(opts: {
    branch: string;
    baseBranch: string;
    execGit: (cmd: string) => Promise<GitCommandResult>;
}): Promise<DefaultCheckoutMergeResult> {
    const { branch, baseBranch, execGit } = opts;
    const statusResult = await execGit("status --porcelain");
    if (statusResult.code !== 0) {
        const out = statusResult.stderr || statusResult.stdout;
        return {
            merged: false,
            pushed: false,
            output: `[env] could not inspect the default checkout before merge: ${out}. Resolve the checkout state manually before retrying.`,
        };
    }

    if ((statusResult.stdout || "").trim()) {
        return {
            merged: false,
            pushed: false,
            output: "[env] default checkout is dirty; merge was not attempted. Commit or manually stash all tracked and untracked edits in the default checkout, then retry.",
        };
    }

    const checkoutResult = await execGit(`checkout ${baseBranch}`);
    if (checkoutResult.code !== 0) {
        const out = checkoutResult.stderr || checkoutResult.stdout;
        return {
            merged: false,
            pushed: false,
            output: `[env] failed to checkout ${baseBranch}: ${out}`,
        };
    }

    const mergeMsg = `merge: ${branch}`;
    const mergeResult = await execGit(`merge --no-ff ${branch} -m "${mergeMsg.replace(/"/g, '\\"')}"`);
    if (mergeResult.code === 0) {
        return { merged: true, pushed: false, output: "Merged" };
    }

    // The checkout was proven clean before the merge, so aborting only removes
    // merge-generated conflict state. It cannot remove pre-existing user edits.
    const abortResult = await execGit("merge --abort");
    const out = `${mergeResult.stdout || ""}${mergeResult.stderr || ""}`;
    const isRealConflict =
        /CONFLICT\(/.test(out) ||
        /Automatic merge failed/.test(out) ||
        /Merge conflict/.test(out);
    const abortFailure = abortResult.code === 0
        ? ""
        : ` [env] git merge --abort also failed: ${abortResult.stderr || abortResult.stdout}`;
    return {
        merged: false,
        pushed: false,
        output: `${isRealConflict ? out : `[env] merge failed (not a content conflict): ${out}`}${abortFailure}`,
    };
}

// --- Per-worktree nginx preview ---------------------------------------------
// Opt-in per stack: if the stack dir has `nginx-wt.conf.tmpl`, each worktree
// gets a generated server block on its own port at
// `<stackDir>/nginx-wt/<projectName>@<branch>.conf` (bind-mounted into nginx at /etc/nginx/conf.d/wt),
// and nginx is HUP-reloaded. The agent reaches it via http://nginx:<port>/,
// advertised via the `.preview-url` file written into the worktree (and a note
// CarapaBoard adds to the prompt). Best-effort: failures here never fail the
// worktree operation itself.
async function reloadNginx(stackDir: string, projectName?: string): Promise<void> {
    try {
        await execCompose(stackDir, ["kill", "-s", "SIGHUP", "nginx"], { projectName, allowFailure: true });
    } catch (err) {
        logger.warn(`[worktree-preview] nginx reload failed (best-effort): ${err}`);
    }
}

/**
 * Add/refresh (mode "add") or remove (mode "remove") the per-worktree nginx
 * server block. Returns the assigned port for "add" (undefined if the stack
 * has no template / branch is unsafe / nginx is down / nothing to do).
 *
 * IMPORTANT — why this execs into nginx instead of writing files directly:
 * carapa-box bind-mounts the stacks dir READ-ONLY (`/app/stacks:ro`), so
 * `fs.writeFileSync` into `<stackDir>/nginx-wt/` fails with EROFS. The one
 * writable handle to that exact host directory is `/etc/nginx/conf.d/wt` *inside the
 * project nginx container* (its bind mount is not `:ro`). So all conf
 * scan/prune/allocate/write happens in one locked shell script run via
 * `docker compose exec nginx` — the read-only mount is only used to read the
 * opt-in template (reads are allowed on `:ro`).
 *
 * Parallel-safety: the whole scan→prune→pick→write runs under a `mkdir`
 * spinlock inside nginx, so concurrent `:add` execs (parallel tasks) serialize
 * and never pick the same port. Stale-conf pruning uses `liveBranches` (the
 * worktree list gathered from the *agent* container, which actually mounts the
 * repo) — never a carapa-box `fs` check, which cannot see the repo and would
 * wrongly delete a concurrently-running task's conf.
 */
async function syncWorktreePreview(opts: {
    stackDir: string;
    /** Owner of the conf: the compose project name of this instance. */
    projectName: string;
    branch: string;
    mode: "add" | "remove";
    /** Branch names of worktrees that currently exist (from the agent: `ls .worktrees`). */
    liveBranches?: string[];
    /** True only if the live-worktree list was gathered successfully; when false, pruning is skipped (conservative). */
    liveKnown?: boolean;
}): Promise<number | undefined> {
    const { stackDir, projectName, branch, mode, liveBranches, liveKnown } = opts;
    const tmplPath = path.join(stackDir, "nginx-wt.conf.tmpl");
    const tmplExists = fs.existsSync(tmplPath); // read on :ro mount is allowed
    logger.info(
        `[worktree-preview] ${mode} branch="${branch}" stackDir="${stackDir}" tmpl=${tmplExists ? "found" : "MISSING"}`,
    );
    if (!tmplExists) {
        logger.warn(
            `[worktree-preview] no nginx-wt.conf.tmpl at "${tmplPath}" — per-worktree preview disabled for this stack/path`,
        );
        return undefined;
    }
    // Defense-in-depth: branch is already slugified upstream, but never let an
    // unexpected charset reach a conf filename / shell word.
    if (!isSafePreviewSlug(branch)) {
        logger.warn(`[worktree-preview] skipping — unsafe branch slug "${branch}"`);
        return undefined;
    }
    if (!isSafePreviewSlug(projectName)) {
        logger.warn(`[worktree-preview] skipping — unsafe project name "${projectName}"`);
        return undefined;
    }
    const confName = previewConfName(projectName, branch);

    // Run the conf write/scan inside nginx AS THE DIRECTORY'S OWNER UID, not
    // root. The project nginx has `cap_drop: ALL` and does NOT re-add
    // DAC_OVERRIDE, so container-root canNOT write the host-owned
    // (uid <owner>, mode 0755) bind-mounted nginx-wt dir — only the owner uid
    // can (owner `rwx`). carapa-box can `stat` the dir on its read-only mount
    // (reads are allowed on :ro); the whole stack tree shares one owner, so we
    // take the template's uid as the canonical owner. AppArmor already permits
    // /etc/nginx/conf.d/** rw and /tmp/** rw for any uid; files created land
    // mode 0644 so the nginx workers (uid 101) can read them.
    let ownerUid = 0;
    try {
        ownerUid = fs.statSync(tmplPath).uid;
    } catch {
        /* fall back to 0; if that can't write, the log below makes it obvious */
    }
    // The snippet is a single argv element; kept free of single quotes, only
    // interpolating slug-guarded / numeric / base64 values, so no escaping.
    const execNginx = (snippet: string) =>
        execCompose(stackDir, ["exec", "-T", "-u", String(ownerUid), "nginx", "sh", "-c", snippet], {
            projectName,
            allowFailure: true,
        });

    if (mode === "remove") {
        try {
            await execNginx(`rm -f /etc/nginx/conf.d/wt/${confName}`);
            await reloadNginx(stackDir, projectName);
        } catch (err) {
            logger.warn(`[worktree-preview] remove failed (best-effort): ${err}`);
        }
        return undefined;
    }

    try {
        // Render the template in carapa-box (RO read is fine): fill __BRANCH__
        // now, leave __PORT__ for the in-nginx script (it decides the port).
        const rendered = fs.readFileSync(tmplPath, "utf8").split("__BRANCH__").join(branch);
        const b64 = Buffer.from(rendered, "utf8").toString("base64"); // single line: [A-Za-z0-9+/=]
        // Live-worktree set for pruning. When unknown, leave empty AND signal
        // prune=off so we never delete a sibling conf we can't account for.
        const safeLive = (liveBranches || []).filter(isSafePreviewSlug);
        const script = buildPreviewSyncScript({
            owner: projectName,
            branch,
            liveBranches: safeLive,
            prune: !!liveKnown,
            base64Conf: b64,
        });

        const res = await execNginx(script);
        const out = `${res.stdout || ""}\n${res.stderr || ""}`;
        const m = out.match(/PREVIEW_PORT=(\d+)/);
        if (!m) {
            logger.warn(
                `[worktree-preview] add failed (best-effort): nginx exec produced no port (code ${res.code}): ${out.trim().slice(0, 400)}`,
            );
            return undefined;
        }
        const port = parseInt(m[1], 10);
        await reloadNginx(stackDir, projectName);
        logger.info(
            `[worktree-preview] branch="${branch}" -> port ${port}; wrote /etc/nginx/conf.d/wt/${confName} as uid=${ownerUid} (prune=${liveKnown ? "on" : "off"})`,
        );
        return port;
    } catch (err) {
        logger.warn(`[worktree-preview] add failed (best-effort): ${err}`);
        return undefined;
    }
}

/**
 * Best-effort: enumerate this instance's per-worktree nginx preview server
 * blocks by reading `<stackDir>/nginx-wt/*.conf` directly. carapa-box mounts the
 * stacks dir read-only, so `fs` reads are allowed (same as the
 * `nginx-wt.conf.tmpl` read in syncWorktreePreview). The folder is shared by
 * every instance of the stack, so only confs named `<owner>@<branch>.conf` are
 * returned; `slug` is the bare branch. The first `listen <port>` line is the
 * preview port. Returns [] when the stack has no preview template / nginx-wt dir.
 */
function listWorktreePreviews(stackDir: string, owner: string): { slug: string; port: number }[] {
    try {
        const dir = path.join(stackDir, "nginx-wt");
        const out: { slug: string; port: number }[] = [];
        for (const f of fs.readdirSync(dir)) {
            const parsed = parsePreviewConfName(f);
            if (!parsed || parsed.owner !== owner) continue;
            const m = fs.readFileSync(path.join(dir, f), "utf8").match(/^\s*listen\s+(\d+)/m);
            if (m) out.push({ slug: parsed.branch, port: parseInt(m[1], 10) });
        }
        return out.sort((a, b) => a.slug.localeCompare(b.slug));
    } catch {
        return []; // ENOENT (no template) / unreadable → no previews
    }
}

/**
 * Shell command (CWD = repo root) adding `.worktrees/` to `info/exclude` in the git common dir,
 * unless `.gitignore` or the exclude file already lists it. Starts a new line when the file has
 * no trailing newline. Best-effort: the result is not checked.
 */
const WORKTREES_EXCLUDE_CMD =
    `exclude="$(git rev-parse --git-path info/exclude 2>/dev/null)" && [ -n "$exclude" ] && ` +
    `{ grep -qs '^/\\{0,1\\}\\.worktrees' .gitignore "$exclude" || ` +
    `{ mkdir -p "$(dirname "$exclude")" && ` +
    `{ [ -z "$(tail -c1 "$exclude" 2>/dev/null)" ] || echo >> "$exclude"; } && ` +
    `echo '.worktrees/' >> "$exclude"; }; }`;

/**
 * Write the per-worktree preview URL into `<worktree>/.preview-url` (the agent's
 * CWD at run time). This is the primary, parallel-safe transport: each worktree
 * gets its own file, so N concurrent tasks never share state — no env-passthrough
 * allowlist, no cross-container env plumbing. The agent's login scripts / testing
 * prompt read this file as their base URL. Best-effort: never fails the worktree
 * op. Runs via execShell (agent container, CWD = repo root) so the file lands at
 * the real worktree path. `.preview-url` must be in the repo's .gitignore.
 *
 * `port` is a validated integer and `worktreePath` is `<worktreeDir>/<slug>`
 * (slug-guarded in syncWorktreePreview), so interpolation here is safe.
 */
async function writeWorktreePreviewUrl(
    execShell: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    port: number | undefined,
    strict = false,
): Promise<void> {
    if (!port) return; // preview disabled / no port — nothing to advertise
    try {
        const r = await execShell(
            `[ ! -L ${shellQuote(`${worktreePath}/.preview-url`)} ] && printf 'http://nginx:%s/\\n' '${port}' > ${shellQuote(`${worktreePath}/.preview-url`)}`,
        );
        if (r.code !== 0) {
            if (strict) throw new Error(`Unable to write worktree preview URL: ${r.stderr || r.stdout || `exit ${r.code}`}`);
            logger.warn(
                `[worktree-preview] could not write ${worktreePath}/.preview-url (exit ${r.code}): ${(r.stderr || r.stdout || "").trim()}`,
            );
        } else {
            logger.info(`[worktree-preview] wrote ${worktreePath}/.preview-url -> http://nginx:${port}/`);
        }
    } catch (err) {
        if (strict) throw err;
        logger.warn(`[worktree-preview] .preview-url write failed (best-effort): ${err}`);
    }
}

/**
 * (Re)create the `worktreeFiles` symlinks (e.g. `vendor`, `storage`) from the
 * main checkout into the worktree. Called on BOTH worktree create AND reuse:
 * `sandbox_worktree:reset` runs `git reset --hard` which wipes these, and the
 * reuse path would otherwise return without re-establishing them — leaving the
 * worktree missing `vendor/` so the app 500s. Idempotent: `ln -sfn` replaces an
 * existing link/dir in place instead of nesting a link inside it (the plain
 * `ln -sf` footgun when the target is a symlink-to-directory). Best-effort.
 *
 * `symlinkFiles` entries come from group settings (operator-controlled) and are
 * joined with the slug-guarded `worktreePath`, so interpolation here is safe.
 */
async function provisionWorktreeSymlinks(
    execGit: (cmd: string) => Promise<{ stdout: string }>,
    execShell: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    symlinkFiles: string[] | undefined,
): Promise<void> {
    if (!symlinkFiles?.length) return;
    try {
        const topResult = await execGit("rev-parse --show-toplevel");
        const repoRoot = (topResult.stdout || "").trim();
        if (!repoRoot) {
            logger.warn(`[worktree-symlinks] could not resolve repo root — skipping (${worktreePath})`);
            return;
        }
        for (const file of symlinkFiles) {
            if (!file || file.startsWith("/") || file.split("/").includes("..") || /[\x00-\x1f]/.test(file)) {
                logger.warn(`[worktree-symlinks] rejecting unsafe symlink entry ${JSON.stringify(file)}`);
                continue;
            }
            const dir = file.includes("/") ? file.substring(0, file.lastIndexOf("/")) : "";
            const mkdirCmd = dir ? `mkdir -p ${shellQuote(`${repoRoot}/${worktreePath}/${dir}`)} && ` : "";
            const r = await execShell(
                `${mkdirCmd}ln -sfn ${shellQuote(`${repoRoot}/${file}`)} ${shellQuote(`${repoRoot}/${worktreePath}/${file}`)}`,
            );
            if (r.code !== 0) {
                logger.warn(
                    `[worktree-symlinks] ${file} -> ${worktreePath}/${file} failed (exit ${r.code}): ${(r.stderr || r.stdout || "").trim()}`,
                );
            }
        }
        logger.info(`[worktree-symlinks] (re)linked [${symlinkFiles.join(", ")}] into ${worktreePath}`);
    } catch (err) {
        logger.warn(`[worktree-symlinks] provisioning failed (best-effort): ${err}`);
    }
}

/**
 * Derive a DB-safe slug from a branch name: lowercased, every run of characters
 * outside `[a-z0-9_]` collapsed to a single `_`, trimmed, capped at 40 chars.
 * Exposed to worktree hooks as `WT_SLUG` so a project can name per-worktree
 * resources (e.g. `${BASE_DB}_wt_<slug>`) deterministically.
 */
export function worktreeListText(r: { code: number; stdout: string; stderr: string }): string {
    if (r.code !== 0) {
        return r.stderr.trim() || r.stdout.trim() || `git worktree list failed (exit ${r.code})`;
    }
    return r.stdout || "(no worktrees)";
}

/**
 * True when `git worktree list --porcelain` registers `worktreePath` (relative to the
 * repo root, e.g. `.worktrees/task-1`). Compares whole `worktree <path>` entries so a
 * sibling such as `.worktrees/task-10` does not count as `.worktrees/task-1`.
 */
export function isRegisteredWorktree(porcelain: string, worktreePath: string): boolean {
    return porcelain.split(/\r?\n/).some((line) => {
        if (!line.startsWith("worktree ")) return false;
        const registered = line.slice("worktree ".length).replace(/\/+$/, "");
        return registered === worktreePath || registered.endsWith(`/${worktreePath}`);
    });
}

/**
 * Admin dir (`.git/worktrees/<name>`, relative to the repo root) registered for
 * `worktreePath`. git names it after the worktree path's basename (`feature/x` ->
 * `x`, plus a numeric suffix on collisions), so it cannot be derived from the
 * branch name. Matches each admin dir's `gitdir` file (`<abs worktree>/.git`)
 * against the path; an admin dir without a `gitdir` file (half-written by an
 * interrupted add) is only claimed via the legacy `.git/worktrees/<branch>` name.
 * Returns null when none is found.
 */
export async function findWorktreeAdminDir(
    execShell: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    branch: string,
): Promise<string | null> {
    const script =
        `wt=${shellQuote(worktreePath)}; ` +
        `for d in .git/worktrees/*/; do d=\${d%/}; g=$(cat "$d/gitdir" 2>/dev/null) || continue; ` +
        `case "$g" in */"$wt"/.git) echo "$d"; exit 0;; esac; done; ` +
        `d=${shellQuote(`.git/worktrees/${branch}`)}; ` +
        `if [ -d "$d" ] && [ ! -e "$d/gitdir" ]; then echo "$d"; fi`;
    const r = await execShell(script);
    const found = (r.stdout || "").trim();
    return r.code === 0 && found.startsWith(".git/worktrees/") ? found : null;
}

/** Remove only the admin dir registered for `worktreePath` (never a blanket `worktree prune`). */
async function removeWorktreeAdminDir(
    execShell: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    branch: string,
): Promise<void> {
    const admin = await findWorktreeAdminDir(execShell, worktreePath, branch);
    if (admin) await execShell(`rm -rf ${shellQuote(admin)}`);
}

export function worktreeSlug(branch: string): string {
    return branch
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
}

function pickProvisionEnv(source: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(source)) {
        if (k.startsWith("PROVISION_") && v !== undefined) env[k] = v;
    }
    return env;
}

/**
 * Build the environment forwarded to the `.agent/worktree-{setup,teardown}.sh`
 * hooks: the `PROVISION_*` keys from the stack `.env` plus `WT_BRANCH`/`WT_SLUG`.
 * Any value given is readable by the project's agent, because the hooks are
 * agent-editable repo content.
 */
export function buildProvisionEnv(stackEnv: Record<string, string>, branch: string): Record<string, string> {
    const env = pickProvisionEnv(stackEnv);
    env.WT_BRANCH = branch;
    env.WT_SLUG = worktreeSlug(branch);
    return env;
}

/**
 * Run the repo-supplied per-worktree setup script if present, AFTER symlink
 * provisioning, on BOTH create and reuse. Convention: `<worktree>/.agent/
 * worktree-setup.sh`, run with CWD = the worktree. The script derives the main
 * checkout itself via `git worktree list` (no env coupling, layout-agnostic).
 * This is how a project (e.g. a PHP app) builds its frontend
 * assets for the branch — the smart node_modules + `yarn build` logic lives in
 * that project-owned script so carapa-box stays stack-agnostic (same opt-in
 * model as nginx-wt.conf.tmpl). Failures are best-effort by default; stacks
 * with WORKTREE_HOOKS_STRICT=1 make them task-fatal.
 *
 * `provisionEnv` (PROVISION_* from the stack `.env` + WT_BRANCH/WT_SLUG, with
 * WT_PATH added here) is forwarded to the hook via the container's environment
 * (`exec -e`), never via argv, so provisioning secrets stay out of the hook's
 * command line.
 *
 * `worktreePath` is slug-guarded and `repoRoot` comes from git, so the
 * interpolation here is safe; the script body itself is repo-controlled, which
 * is the same trust level as the code the agent already builds and runs.
 */
export async function runWorktreeHook(
    execGit: (cmd: string) => Promise<{ stdout: string }>,
    execShell: (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    hookName: string,
    provisionEnv?: Record<string, string>,
    strict = false,
): Promise<WorktreeHookResult> {
    try {
        const topResult = await execGit("rev-parse --show-toplevel");
        const repoRoot = (topResult.stdout || "").trim();
        if (!repoRoot) {
            const output = `could not resolve repo root (${worktreePath})`;
            if (strict) throw new Error(`[${hookName}] ${output}`);
            logger.warn(`[${hookName}] ${output} — skipping`);
            return { present: false, ok: false, output };
        }
        const wt = `${repoRoot}/${worktreePath}`;
        const hookEnv = { ...(provisionEnv || {}), WT_PATH: wt };
        const absentMarker = `__WT_HOOK_ABSENT_${hookName.replace(/[^A-Za-z0-9]/g, "_")}__`;
        const r = await execShell(
            `cd ${wt} && if [ -f .agent/${hookName} ]; then sh .agent/${hookName}; else echo ${absentMarker}; fi`,
            hookEnv,
        );
        const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
        if (out.includes(absentMarker)) {
            logger.info(`[${hookName}] no .agent/${hookName} in ${worktreePath} — skipped`);
            return { present: false, ok: true, output: "" };
        }
        if (r.code !== 0) {
            const message = `${worktreePath}/.agent/${hookName} FAILED (exit ${r.code}):\n${out.slice(-2000)}`;
            if (strict) throw new Error(message);
            logger.warn(`[${hookName}] ${message}`);
            return { present: true, ok: false, output: out, data: parseWorktreeHookData(out) };
        }
        logger.info(`[${hookName}] ran ${worktreePath}/.agent/${hookName} ok`);
        return { present: true, ok: true, output: out, data: parseWorktreeHookData(out) };
    } catch (err) {
        if (strict) throw err;
        logger.warn(`[${hookName}] failed (best-effort): ${err}`);
        return { present: false, ok: false, output: String(err) };
    }
}

async function runWorktreeSetup(
    execGit: (cmd: string) => Promise<{ stdout: string }>,
    execShell: (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    provisionEnv?: Record<string, string>,
    strict = false,
): Promise<WorktreeHookResult> {
    return runWorktreeHook(
        execGit,
        execShell,
        worktreePath,
        "worktree-setup.sh",
        provisionEnv,
        strict,
    );
}

/**
 * Run the repo-supplied per-worktree teardown script if present, BEFORE the
 * worktree is removed (so the hook's CWD and `.agent/worktree-teardown.sh` still
 * exist). Convention mirrors setup: `<worktree>/.agent/worktree-teardown.sh`,
 * run with CWD = the worktree, receiving the same `provisionEnv` so it can drop
 * the per-worktree resources it created (e.g. `DROP DATABASE ${BASE_DB}_wt_<slug>`)
 * with the provisioning creds rather than reading them from `MAIN/.env`.
 * Best-effort by default; strict stacks make a failing teardown block removal.
 */
async function runWorktreeTeardown(
    execGit: (cmd: string) => Promise<{ stdout: string }>,
    execShell: (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>,
    worktreePath: string,
    provisionEnv?: Record<string, string>,
    strict = false,
): Promise<WorktreeHookResult> {
    return runWorktreeHook(
        execGit,
        execShell,
        worktreePath,
        "worktree-teardown.sh",
        provisionEnv,
        strict,
    );
}

// --- REST TOOL REGISTRY ---
// Populated by registerTools() so every MCP tool is also reachable via POST /api/tools/:name
export const toolRegistry = new Map<string, { description: string; schema: Record<string, z.ZodType>; handler: (args: any, extra?: any) => Promise<any> }>();

// Cache for sandbox_ps. Stale-while-revalidate: the poll-driven path (no
// instance filter) always gets the cached value instantly; a stale cache
// triggers a single background refresh instead of blocking the request, so no
// poll ever pays the docker-compose-ps fan-out latency. The UI polls every 15s,
// so a 5s blocking TTL never reused the cache — every poll was a full miss.
let cachedPsResult: string | null = null;
let lastPsTime = 0;
let psRefreshInFlight: Promise<string> | null = null;
const PS_CACHE_TTL_MS = 10000;
// Bumped on every invalidation so a refresh that started earlier cannot write
// its (older) result back over the cache.
let psGeneration = 0;

/** Drop the sandbox_ps cache after a state change (start/stop/ssh). */
export function invalidatePsCache(): void {
    cachedPsResult = null;
    lastPsTime = 0;
    psRefreshInFlight = null;
    psGeneration++;
}

/**
 * Stale-while-revalidate access to the unfiltered ps text. A warm cache is
 * served instantly (stale triggers one background refresh); a cold cache
 * blocks on a single shared compute and surfaces its errors.
 */
export async function getPsCached(compute: () => Promise<string>): Promise<string> {
    const startRefresh = (): Promise<string> => {
        const generation = psGeneration;
        const p: Promise<string> = compute()
            .then((text) => {
                if (generation === psGeneration) { cachedPsResult = text; lastPsTime = Date.now(); }
                return text;
            })
            .finally(() => { if (psRefreshInFlight === p) psRefreshInFlight = null; });
        psRefreshInFlight = p;
        return p;
    };
    if (cachedPsResult) {
        const text = cachedPsResult;
        if (Date.now() - lastPsTime >= PS_CACHE_TTL_MS && !psRefreshInFlight) {
            startRefresh().catch((err) => {
                logger.warn({ err: String(err) }, "[sandbox_ps] background refresh failed; serving stale");
            });
        }
        return text;
    }
    return psRefreshInFlight ?? startRefresh();
}

/** Instance name of an owned project: its compose name without the `<stack>-` prefix. */
function runtimeInstanceName(project: { name: string; localStackPath: string }): string {
    const prefix = `${path.basename(project.localStackPath)}-`;
    return project.name.startsWith(prefix) ? project.name.slice(prefix.length) : project.name;
}

/**
 * Compute the sandbox_ps text payload: list owned compose projects and enrich
 * each with its services (hostname/status/ports/ip) and worktree previews.
 * Pure of caching — callers decide whether to cache or serve stale.
 */
async function computePs(instance?: string): Promise<string> {
    const MAX_PARALLEL_STATUS_CALLS = 4;
    const [result, containers] = await Promise.all([listProjects(), readContainerInventory()]);
    const projects = JSON.parse(result.stdout);
    const rawStacksDir = getStacksDir();
    const stacksDir = await fsp.realpath(rawStacksDir).catch(() => path.resolve(rawStacksDir));

    const byProject = new Map<string, ContainerStatus[]>();
    const workingDirectories = new Map<string, string[]>();
    for (const container of containers) {
        const labels = container.Config.Labels ?? {};
        const project = labels['com.docker.compose.project'];
        if (!project) continue;
        const peers = byProject.get(project) ?? [];
        peers.push(container);
        byProject.set(project, peers);
        const directories = workingDirectories.get(project) ?? [];
        directories.push(labels['com.docker.compose.project.working_dir'] ?? '');
        workingDirectories.set(project, directories);
    }
    let sandboxes = await resolveOwnedProjects(projects, stacksDir, { listStacks, execDocker, readFile: fsp.readFile, workingDirectories });
    if (instance) {
        sandboxes = sandboxes.filter((p) => {
            return runtimeInstanceName(p) === instance;
        });
    }
    const proxyEnabled = nginxProxyEnabled();
    const ingressIsEnabled = ingressEnabled();

    // Container discovery is shared; bound the remaining SSH status work.
    const enriched: Array<{
        name: string;
        stack: string;
        instance: string;
        url?: string;
        urls?: string[];
        services: ServiceInfo[];
        worktrees: { slug: string; port: number }[];
        ssh?: SandboxSshStatus;
        ingress?: Awaited<ReturnType<typeof listIngressEndpoints>>;
    }> = new Array(sandboxes.length);
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= sandboxes.length) return;
            const p = sandboxes[current];
            const projectContainers = byProject.get(p.name) ?? [];
            const services = projectContainers
                .filter(container => container.Config.Labels?.['com.docker.compose.oneoff']?.toLowerCase() !== 'true')
                .map(containerServiceInfo);
            // Independent of ps — read straight from the RO stack dir.
            const worktrees = listWorktreePreviews(p.localStackPath, p.name);
            const stack = path.basename(p.localStackPath);
            const instance = runtimeInstanceName(p);
            const hasPublishedWebPort = services.some(
                (service) =>
                    service.service === "nginx" &&
                    service.ports.some((port) => /->80\/(?:tcp|udp)$/.test(port)),
            );
            let url: string | undefined;
            let urls: string[] | undefined;
            if (proxyEnabled && (hasPublishedWebPort || ingressIsEnabled)) {
                try {
                    urls = await listNginxProxyUrls(p.name);
                    url = urls[0];
                } catch (err) {
                    logger.warn(
                        { projectName: p.name, err },
                        "Could not read nginx proxy route during sandbox_ps",
                    );
                }
            }
            const ssh = await controlSandboxSsh(p.localStackPath, p.name, 'status', {
                readFile: fsp.readFile, execDocker, containers: projectContainers,
            }).catch((error) => ({
                supported: true, containerRunning: false, running: false, error: String(error),
            }));
            const ingress = ingressIsEnabled ? await listIngressEndpoints(p.name) : undefined;
            enriched[current] = { name: p.name, stack, instance, url, urls, services, worktrees, ssh, ingress };
        }
    };

    const workerCount = Math.min(MAX_PARALLEL_STATUS_CALLS, sandboxes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return enriched.length > 0
        ? JSON.stringify(enriched, null, 2)
        : "No running sandboxes found.";
}

// Parse docker compose ps --format json (ndjson or single array)
export function parsePublishers(publishers: unknown): string[] {
    if (!Array.isArray(publishers)) return [];
    const ports: string[] = [];
    for (const p of publishers as Array<Record<string, unknown>>) {
        const target = p.TargetPort ?? p.targetPort;
        const published = p.PublishedPort ?? p.publishedPort;
        const protocol = (p.Protocol ?? p.protocol ?? "tcp") as string;
        const url = (p.URL ?? p.url ?? "") as string;
        if (target && published && Number(published) !== 0) {
            const host = url && url !== "0.0.0.0" && url !== "::" ? `${url}:` : "";
            ports.push(`${host}${published}->${target}/${protocol}`);
        }
    }
    return [...new Set(ports)];
}

function toServiceInfo(obj: Record<string, unknown>): ServiceInfo | undefined {
    const service = (obj.Service ?? obj.service ?? "") as string;
    const hostname = (obj.Name ?? obj.name ?? "") as string;
    const status = (obj.State ?? obj.Status ?? obj.status ?? "") as string;
    if (!service && !hostname) return undefined;
    return { service, hostname, status, ports: parsePublishers(obj.Publishers ?? obj.publishers), ip: "" };
}

/** Every hostname a sandbox's relay tokens may be registered under. */
export function relayTokenHostnames(projectName: string, ps: ServiceInfo[]): string[] {
    const names = new Set<string>();
    for (const info of ps) {
        if (info.hostname) names.add(info.hostname);
    }
    names.add(`${projectName}-agent-1`);
    names.add(`${projectName}-sandbox-1`);
    return [...names];
}

export function parseComposePsOutput(stdout: string): ServiceInfo[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    // Attempt to parse as a single JSON array (modern Docker Compose)
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
            const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
            return arr.map(toServiceInfo).filter((service): service is ServiceInfo => !!service);
        } catch { /* fall through to NDJSON */ }
    }

    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const out: ServiceInfo[] = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const service = toServiceInfo(obj);
            if (service) out.push(service);
        } catch { /* skip malformed */ }
    }
    return out;
}

/**
 * The agent container's real hostname, which the relay matches against its
 * clients. Most stacks use the compose-default `${project}-${service}-1`, but
 * some override `container_name`, so a running container's name wins.
 */
async function resolveAgentHostname(
    stackPath: string,
    projectName: string,
    service: string,
    getStatus: (stackPath: string, projectName: string, options: { fresh: boolean }) => Promise<{ stdout?: string }> = getStackStatus,
): Promise<string> {
    try {
        const ps = parseComposePsOutput((await getStatus(stackPath, projectName, { fresh: true })).stdout || "");
        const real = ps.find(svc => svc.service === service)?.hostname
            || ps.find(svc => svc.hostname?.endsWith(`-${service}-1`))?.hostname;
        if (real) return real;
    } catch { /* keep the derived name */ }
    return `${projectName}-${service}-1`;
}

/**
 * The names the relay's reverse DNS can report for the agent container: Docker
 * qualifies the container name with each network it is attached to
 * (`name.network`). The bare name comes last, as the fallback.
 */
export async function resolveAgentRelayHostnames(
    stackPath: string,
    projectName: string,
    service: string,
    deps: {
        getStatus: (stackPath: string, projectName: string, options: { fresh: boolean }) => Promise<{ stdout?: string }>;
        execDocker: (args: string[]) => Promise<{ status: number; stdout: string }>;
    } = { getStatus: getStackStatus, execDocker },
): Promise<string[]> {
    const name = await resolveAgentHostname(stackPath, projectName, service, deps.getStatus);
    let networks: string[] = [];
    try {
        const inspected = await deps.execDocker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", name]);
        if (inspected.status === 0) networks = Object.keys(JSON.parse(inspected.stdout) ?? {}).sort();
    } catch { /* keep the bare name */ }
    return [...networks.map(network => `${name}.${network}`), name];
}

/**
 * Run a git command on a workspace via the carapa/git-ssh container.
 * SSH keys are mounted read-only and never enter the agent sandbox.
 *
 * `repoPath` can be a host directory (bind mount) or a Docker named volume.
 */
export async function execRemoteGit(
    argv: string[],
    opts: {
        repoPath: string;
        sshKeysPath: string;
        onLog?: (chunk: string) => void;
        /** Trusted SSH URL; when set, ops go through a box-owned staging repo and ignore the repo's own remote config. */
        remoteUrl?: string;
        projectName?: string;
        /** Repo directory inside the `repoPath` volume; unset or "." mounts the volume root. */
        repoSubpath?: string;
    },
    deps: { dockerRun: typeof execDockerRun; docker: typeof execDocker } = { dockerRun: execDockerRun, docker: execDocker },
): Promise<{ stdout: string; stderr: string; code: number }> {
    const pin = resolveRemotePin(opts.remoteUrl, opts.projectName);
    if (!pin.ok) throw new Error(pin.error);

    // Pre-flight: verify carapa/git-ssh image exists locally
    const imageCheck = await deps.docker(["image", "inspect", "carapa/git-ssh:latest"]);
    if (imageCheck.status !== 0) {
        throw new Error(
            'Docker image "carapa/git-ssh:latest" not found. ' +
            'Build it with: docker build -t carapa/git-ssh git-ssh/'
        );
    }

    const rejection = validateRemoteGitArgv(argv);
    if (rejection) throw new Error(rejection);
    if (pin.remoteUrl) {
        return runPinnedRemoteGit(argv, pin.remoteUrl, opts, {
            dockerRun: deps.dockerRun,
            docker: deps.docker,
            keyedArgs: (mounts, workdir, gitArgv) => buildPinnedKeyedDockerArgs(mounts, workdir, gitArgv, opts.sshKeysPath),
            overrides: REMOTE_GIT_CONFIG_OVERRIDES,
        });
    }
    return deps.dockerRun(buildRemoteGitDockerArgs(argv, opts), { onLog: opts.onLog });
}

/**
 * Resolve the host-side repo path for a running instance by inspecting
 * the container's bind mounts. LOCAL_REPO is a compose-time variable
 * (not a container env var), so we read the actual mount source from Docker.
 *
 * Uses the container's WorkingDir (from docker inspect) to find the mount
 * whose destination matches, handling any non-standard workspace mount path.
 */
export function resolveWorkspaceMount(
    workingDir: string,
    mounts: ContainerMount[],
    missingVolumeMessage: (mount: ContainerMount) => string,
): { path: string; type: "bind" | "volume"; subpath?: string } | undefined {
    const workspaceMount = mounts.find((mount) =>
        (mount.Type === "bind" || mount.Type === "volume") &&
        mount.Destination === workingDir,
    );
    if (!workspaceMount) return undefined;
    if (workspaceMount.Type !== "volume") return { path: workspaceMount.Source, type: "bind" };
    if (!workspaceMount.Name) throw new Error(missingVolumeMessage(workspaceMount));
    return workspaceMount.Subpath && workspaceMount.Subpath !== "."
        ? { path: workspaceMount.Name, type: "volume", subpath: workspaceMount.Subpath }
        : { path: workspaceMount.Name, type: "volume" };
}

/** Resolved workspace repo: `path` is a host path or volume name; `subpath` is the repo's directory inside a volume. */
type HostRepo = { path: string; type?: "bind" | "volume"; subpath?: string };

/** Host repo path to report to callers: a volume name is useless on the host, so prefer the configured repo. */
export function displayRepoPath(repo: HostRepo, configuredRepo: string): string {
    return repo.type === "volume" && configuredRepo ? configuredRepo : repo.path;
}

async function resolveHostRepoPath(
    stackPath: string,
    service: string,
    projectName: string,
    fallback: string,
): Promise<string> {
    return (await resolveHostRepo(stackPath, service, projectName, fallback)).path;
}

export async function resolveHostRepo(
    stackPath: string,
    service: string,
    projectName: string,
    fallback: string,
    deps: {
        getStatus: (stackPath: string, projectName: string) => Promise<{ stdout?: string; code?: number }>;
        execDocker: (args: string[]) => Promise<{ stdout?: string }>;
        inspect: (containerName: string) => Promise<{ WorkingDir: string; Mounts: ContainerMount[] }>;
    } = {
        getStatus: getStackStatus,
        execDocker,
        inspect: inspectContainerWorkspace,
    },
): Promise<HostRepo> {
    try {
        // Get container name
        const psResult = await deps.getStatus(stackPath, projectName);
        const rawOutput = (psResult.stdout || "").trim();
        const services = parseComposePsOutput(rawOutput);
        for (const serviceInfo of services) {
            let containerName = "unknown";
            try {
                if (serviceInfo.service !== service) continue;
                containerName = serviceInfo.hostname;
                if (!containerName) continue;

                // Inspect working_dir and mounts in a single call
                const inspected = await deps.inspect(containerName);
                const workingDir = inspected.WorkingDir;
                const mounts = inspected.Mounts;

                const resolved = resolveWorkspaceMount(workingDir, mounts, (mount) =>
                    `Volume mount at ${mount.Destination} has no Name; ` +
                    `refusing to use host-internal Source path '${mount.Source}' ` +
                    `as a docker volume reference`,
                );
                if (resolved) {
                    return resolved;
                } else {
                    logger.warn({ containerName, workingDir, mounts: mounts.map(m => ({ Type: m.Type, Dest: m.Destination })) }, "[resolveHostRepoPath] no mount matched working_dir");
                }
            } catch (err) { logger.debug({ err: String(err), containerName }, "[resolveHostRepoPath] error during mount inspection"); }
        }

        // If compose ps returned no services, find the container by its exact compose labels.
        // Name filters are substring matches and can select a sibling project's container.
        if (!rawOutput) {
            // Docker label filters are applied first; both labels are re-checked exactly in JS below.
            const dockerPsResult = await deps.execDocker([
                "ps",
                "--filter", `label=com.docker.compose.project=${projectName}`,
                "--filter", `label=com.docker.compose.service=${service}`,
                "--format", "{{.Names}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}",
            ]);
            const projectVariants = [projectName, projectName.replace(/_/g, "-")];
            const containerName = (dockerPsResult.stdout || "").split(/\r?\n/).filter(Boolean)
                .map(line => line.split("\t"))
                .find(([, project, svc]) => projectVariants.includes(project) && svc === service)?.[0];
            logger.warn({ projectName, service, composeCode: psResult.code, matched: containerName ?? null }, "[resolveHostRepoPath] compose ps empty; label fallback");

            if (containerName) {
                const inspected = await deps.inspect(containerName);
                const workingDir = inspected.WorkingDir;
                const mounts = inspected.Mounts;

                const resolved = resolveWorkspaceMount(
                    workingDir,
                    mounts,
                    (mount) => `Volume mount at ${mount.Destination} has no Name`,
                );
                if (resolved) {
                    if (resolved.type === "volume") {
                        logger.debug({ resolved: resolved.path, type: "volume" }, "[resolveHostRepoPath] resolved volume name");
                    } else {
                        logger.debug({ resolved: resolved.path, type: "bind" }, "[resolveHostRepoPath] resolved bind mount");
                    }
                    return resolved;
                } else {
                    logger.warn({ containerName, workingDir, mounts: mounts.map(m => ({ Type: m.Type, Dest: m.Destination })) }, "[resolveHostRepoPath] no mount matches workingDir");
                }
            }
        }
    } catch (err) { logger.debug({ err: String(err), stackPath, service, projectName }, "[resolveHostRepoPath] resolution failed entirely"); }
    logger.warn({ fallback, stackPath, service, projectName }, "[resolveHostRepoPath] returning fallback path");
    return { path: fallback };
}

type ContainerMount = { Type: string; Source: string; Destination: string; Name?: string; Subpath?: string };
type HostConfigMount = { Type?: string; Source?: string; Target?: string; VolumeOptions?: { Subpath?: string } };

async function inspectContainerWorkspace(containerName: string): Promise<{ WorkingDir: string; Mounts: ContainerMount[] }> {
    const result = await execDocker([
        "inspect", "--format",
        `{"WorkingDir":"{{.Config.WorkingDir}}","Mounts":{{json .Mounts}},"HostMounts":{{json .HostConfig.Mounts}}}`,
        containerName,
    ]);
    const parsed = JSON.parse(result.stdout) as { WorkingDir: string; Mounts: ContainerMount[]; HostMounts: HostConfigMount[] | null };
    return { WorkingDir: parsed.WorkingDir, Mounts: withVolumeSubpaths(parsed.Mounts ?? [], parsed.HostMounts ?? []) };
}

/** .Mounts omits volume subpaths; copy them from the matching .HostConfig.Mounts entry. */
export function withVolumeSubpaths(mounts: ContainerMount[], hostMounts: HostConfigMount[]): ContainerMount[] {
    return mounts.map((m) => {
        if (m.Type !== "volume") return m;
        const subpath = hostMounts.find(h => h.Type === "volume" && h.Source === m.Name && h.Target === m.Destination)?.VolumeOptions?.Subpath;
        return subpath ? { ...m, Subpath: subpath } : m;
    });
}

export function containerRepoPathFromMounts(
    hostRepoPath: string,
    mounts: ContainerMount[],
    pinned?: { volume: string; subpath: string },
): string | undefined {
    const bind = mounts
        .filter(m => m.Type === "bind" && (hostRepoPath === m.Source || hostRepoPath.startsWith(`${m.Source}/`)))
        .sort((a, b) => b.Source.length - a.Source.length)[0];
    if (bind) {
        const relative = path.relative(bind.Source, hostRepoPath);
        return relative ? path.posix.join(bind.Destination, relative.split(path.sep).join(path.posix.sep)) : bind.Destination;
    }

    const volume = mounts.find(m => m.Type === "volume" && m.Name === hostRepoPath);
    if (volume) return volume.Destination;

    // Pinned sandbox mounts are subpaths of a per-allowlist-base volume.
    if (pinned) {
        const contains = (outer: string) => outer === "." || pinned.subpath === outer || pinned.subpath.startsWith(`${outer}/`);
        const sub = mounts
            .filter(m => m.Type === "volume" && m.Name === pinned.volume && contains(m.Subpath || "."))
            .sort((a, b) => (b.Subpath || ".").length - (a.Subpath || ".").length)[0];
        if (sub) {
            const outer = sub.Subpath || ".";
            const relative = outer === "." ? pinned.subpath : pinned.subpath.slice(outer.length + 1);
            return relative && relative !== "." ? path.posix.join(sub.Destination, relative) : sub.Destination;
        }
    }

    const containerMount = mounts
        .filter(m => hostRepoPath === m.Destination || hostRepoPath.startsWith(`${m.Destination}/`))
        .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    return containerMount ? hostRepoPath : undefined;
}

export type RepoPathResolution = { path: string } | { reason: string; mounts?: ContainerMount[] };

export async function containerRepoPathFromComposeStatus(
    stdout: string,
    service: string,
    hostRepoPath: string,
    inspectContainer: (containerName: string) => Promise<ContainerMount[]>,
    pinned?: { volume: string; subpath: string },
): Promise<RepoPathResolution> {
    const serviceInfo = parseComposePsOutput(stdout).find(info => info.service === service);
    if (!serviceInfo?.hostname) return { reason: `service "${service}" has no running container` };
    const mounts = await inspectContainer(serviceInfo.hostname);
    const resolved = containerRepoPathFromMounts(hostRepoPath, mounts, pinned);
    if (resolved !== undefined) return { path: resolved };
    return { reason: `no mount of service "${service}" maps host repo ${hostRepoPath}`, mounts };
}

/** Translate a host repository path through the selected service's mounts. */
export async function resolveContainerRepoPath(
    stackPath: string,
    service: string,
    projectName: string,
    hostRepoPath: string,
    deps: {
        getStatus: (stackPath: string, projectName: string) => Promise<{ stdout?: string }>;
        inspect: (containerName: string) => Promise<ContainerMount[]>;
        pin: (hostRepoPath: string) => Promise<{ volume: string; subpath: string } | undefined>;
    } = {
        getStatus: getStackStatus,
        inspect: async (name) => (await inspectContainerWorkspace(name)).Mounts,
        pin: pinMountSource,
    },
): Promise<RepoPathResolution> {
    const fail = (reason: string, mounts?: ContainerMount[]): { reason: string } => {
        logger.warn({
            service, projectName, hostRepoPath, reason,
            ...(mounts && { mounts: mounts.map(({ Type, Destination, Name, Subpath }) => ({ Type, Destination, Name, Subpath })) }),
        }, "[resolveContainerRepoPath] could not resolve repository path");
        return { reason };
    };
    const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
    let stdout: string;
    try {
        const status = await deps.getStatus(stackPath, projectName);
        stdout = status.stdout || "";
    } catch (error) {
        return fail(`compose status failed: ${messageOf(error)}`);
    }
    let pinError: string | undefined;
    const pinned = await deps.pin(hostRepoPath).catch((error: unknown) => {
        pinError = messageOf(error);
        return undefined;
    });
    let containerName = "";
    try {
        const resolved = await containerRepoPathFromComposeStatus(stdout, service, hostRepoPath, async (name) => {
            containerName = name;
            return deps.inspect(name);
        }, pinned);
        if ("path" in resolved) return resolved;
        const note = resolved.mounts && pinError ? ` (mount pin lookup failed: ${pinError})` : "";
        return fail(`${resolved.reason}${note}`, resolved.mounts);
    } catch (error) {
        return fail(`inspecting container ${containerName} failed: ${messageOf(error)}`);
    }
}

// --- TOOL REGISTRATION ---
export function registerTools(s: McpServer, updateRegistry = true) {
    // Typed wrapper around s.tool() that breaks Zod's deep type inference.
    // Without this, tsc OOMs resolving Zod 3.25 + MCP SDK generic chains.
    // All tool handlers cast args manually, so the inferred schema type is unused.
    // Also registers each tool in the module-level toolRegistry for the REST adapter.
    // updateRegistry=false is used by createSession() so per-session handlers do not
    // overwrite the registry entries (which must stay bound to _registryServer's no-op
    // transport so that REST-triggered sendLoggingMessage() calls never reach an
    // unrelated MCP client).
    const tool = (name: string, description: string, schema: Record<string, z.ZodType>, cb: (args: any, extra: any) => Promise<any>) => {
        const tracked = trackToolCall(cb);
        if (updateRegistry) {
            toolRegistry.set(name, { description, schema, handler: tracked });
        }
        return (s.tool.bind(s) as any)(name, description, schema, tracked);
    };

    /** Fire-and-forget MCP log notification; a failed send must not interrupt tool execution. */
    const sendLog = (data: string) => {
        s.sendLoggingMessage({ level: "info", data }).catch(() => { /* intentionally swallowed: fire-and-forget log */ });
    };

    /** Lifecycle log sink: mirrors to stderr and the MCP log channel. */
    const localLog = (msg: string) => {
        process.stderr.write(msg);
        sendLog(msg);
    };

    // sandbox_list - List all available stacks
    tool(
        "sandbox_list",
        "List all available sandbox environments (stacks) that can be started. Returns a list of stack names and their capabilities.",
        {},
        async () => {
            const stacks = await listStacks();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(stacks, null, 2),
                    },
                ],
            };
        }
    );

    // sandbox_ps - List running sandbox instances with their services
    tool(
        "sandbox_ps",
        "List all currently running sandbox instances. Each instance includes a list of services with hostname, status, and exposed ports. Can be filtered by instance ID.",
        SandboxPsSchema,
        async (args): Promise<ToolResult> => {
            const { instance } = args as { instance?: string };

            try {
                // Instance-filtered queries are rare and must be fresh — bypass the cache.
                // Otherwise serve the cached value instantly; refresh in the background if stale.
                const text = instance ? await computePs(instance) : await getPsCached(() => computePs());
                return { content: [{ type: "text", text }] };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Failed to list sandboxes: ${error.message}` }],
                    isError: true,
                };
            }
        }
    );

    tool(
        "sandbox_ssh",
        "Get, enable, or disable key-only SSH inside an approved sandbox. Preserves the stack's runtime and uses its fixed agent service; stopped sandboxes are not started.",
        {
            name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
            instance: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
            action: z.enum(["status", "start", "stop"]),
        },
        async ({ name, instance, action }): Promise<ToolResult> => {
            try {
                const stack = await getStack(name);
                if (!stack) throw new Error("Unknown sandbox stack");
                const state = await controlSandboxSsh(stack.path, instance ? `${name}-${instance}` : name, action);
                if (action !== "status") invalidatePsCache();
                return { content: [{ type: "text", text: JSON.stringify(state) }] };
            } catch (error) {
                return { content: [{ type: "text", text: String(error) }], isError: true };
            }
        },
    );

    // sandbox_start - Start a stack
    tool(
        "sandbox_start",
        "Start an isolated sandbox and run its optional project .agent/after-start.sh inside the agent service. Optionally pass non-secret environment variables via 'env' (visible in logs). Use this before executing commands. A project hook failure is reported even though the sandbox remains running.",
        SandboxStartSchema,
        async (args): Promise<ToolResult> => {
            const { name, instance, env, service } = args as { name: string; instance?: string; env?: Record<string, string>; service?: string };
            logger.info(`[sandbox_start] called: name="${name}" instance="${instance || ""}"`)
            if (!isValidStackName(name)) {
                logger.warn(`[sandbox_start] invalid stack name: ${name}`);
                return {
                    content: [{ type: "text", text: `Invalid stack name: ${name}` }],
                    isError: true,
                };
            }
            if (instance !== undefined && !isValidStackName(instance)) {
                logger.warn(`[sandbox_start] invalid instance: ${instance}`);
                return {
                    content: [{ type: "text", text: `Invalid instance: ${instance}` }],
                    isError: true,
                };
            }

            // Caller env is merged into the controller's hook environment: refuse keys
            // that make bun/node/python/git/docker load caller-chosen code or config.
            const unsafeEnvKeys = findUnsafeHookEnvKeys(env);
            if (unsafeEnvKeys.length > 0) {
                const message = `[SECURITY] sandbox_start env rejected: ${unsafeEnvKeys.join(", ")} can change how controller hooks run code (interpreter, loader, git, docker and shell variables are not allowed)`;
                logger.warn(message);
                return {
                    content: [{ type: "text", text: message }],
                    isError: true,
                };
            }

            const stack = await getStack(name);
            if (!stack) {
                logger.warn(`[sandbox_start] stack not found: ${name}`);
                return {
                    content: [{ type: "text", text: `Stack not found: ${name}` }],
                    isError: true,
                };
            }
            logger.info(`[sandbox_start] stack path: ${stack.path}`);

            // Caller-supplied COMPOSE_FILE could load arbitrary host compose files;
            // restrict to bare docker-compose*.yml names inside the stack directory.
            if (env && Object.hasOwn(env, "COMPOSE_FILE")) {
                const composeFileError = await validateComposeFileEnv(stack.path, String(env.COMPOSE_FILE));
                if (composeFileError) {
                    logger.warn(composeFileError);
                    return {
                        content: [{ type: "text", text: composeFileError }],
                        isError: true,
                    };
                }
            }

            const projectName = instance ? `${name}-${instance}` : name;
            const stackEnv = await parseEnvFile(path.join(stack.path, ".env"));
            const extraEnv: Record<string, string> = {
                COMPOSE_PROJECT_NAME: projectName,
                ...(instance ? { MEMORY_PROJECT: instance } : {}),
                ...stackEnv,
                ...(env || {})
            };

            let releaseStartup: (() => void) | undefined;
            try {
                const output: string[] = [];

                // Run before-start hook
                const beforeResult = await runHook(stack.path, "before-start", extraEnv, localLog);
                if (beforeResult.executed) {
                    output.push(formatHookResult("before-start", beforeResult, false));
                    if (beforeResult.exitCode !== 0) {
                        return {
                            content: [{ type: "text", text: `before-start hook failed:\n${output.join("\n")}` }],
                            isError: true,
                        };
                    }
                }

                // Resolve IPC_MOUNT: stack .env > root .env IPC_MOUNT > root CARAPA_DATA_DIR
                const ipcMount = stackEnv.IPC_MOUNT
                    || process.env.IPC_MOUNT
                    || (process.env.CARAPA_DATA_DIR ? path.join(process.env.CARAPA_DATA_DIR, 'data', 'ipc') : undefined);
                // Inject into stack env so compose files can reference ${IPC_MOUNT}
                if (ipcMount && !stackEnv.IPC_MOUNT) {
                    stackEnv.IPC_MOUNT = ipcMount;
                }
                // Start the stack — stack .env is trusted (admin-controlled), caller env
                // is filtered through the passthrough allowlist. Caller overrides stack defaults.
                const composeEnv = { ...stackEnv, ...(await filterEnvPassthrough(stack.path, env || {})) };
                // Project-scoped proxy aliases are controller metadata, not a
                // sandbox-container capability. Preserve this validated Board
                // setting without requiring every stack passthrough allowlist
                // to expose it inside containers.
                if (env && Object.hasOwn(env, "NGINX_PROXY_ALIASES")) {
                    composeEnv.NGINX_PROXY_ALIASES = env.NGINX_PROXY_ALIASES;
                }

                // Auto-inject MEMORY_PROJECT so containers know their project identity
                composeEnv.MEMORY_PROJECT = instance || name;

                // Board sends logical references (@group/<folder>, @repo/<name>)
                // for projects placed on this box: resolve them under this box's
                // own roots before the allowlist check.
                for (const key of ["LOCAL_REPO", "GROUP_DIR", ...Object.keys(composeEnv).filter(k => /^EXTRA_MOUNT_\d+$/.test(k))]) {
                    const value = composeEnv[key];
                    if (typeof value !== "string" || !value.startsWith("@")) continue;
                    try {
                        composeEnv[key] = resolveLogicalMount(value);
                    } catch (error) {
                        return {
                            content: [{ type: "text", text: `Cannot resolve ${key}: ${error instanceof Error ? error.message : String(error)}` }],
                            isError: true,
                        };
                    }
                }

                // Validate that mount paths are within the allowlist (security: prevents rogue path injection)
                const mountError = await validateMountPaths(composeEnv);
                if (mountError) {
                    logger.warn(mountError);
                    return {
                        content: [{ type: "text", text: mountError }],
                        isError: true,
                    };
                }

                // Board may select a workspace path that does not exist yet.
                // Docker's bind-mount auto-creation leaves it root/nobody-owned,
                // so create/check approved writable directories before stopping
                // the current instance or letting Compose create any mounts.
                const directoryDocker = process.env.SANDBOX_HOST_DIR ? execDocker : undefined;
                if (composeEnv.LOCAL_REPO) {
                    await prepareSandboxDirectory(composeEnv.LOCAL_REPO, "workspace", directoryDocker);
                }
                if (env?.GROUP_DIR?.startsWith("@group") && composeEnv.GROUP_DIR) {
                    // A project's group directory is created on its box.
                    await prepareSandboxDirectory(composeEnv.GROUP_DIR, "workspace", directoryDocker);
                }
                if (composeEnv.IPC_MOUNT) {
                    await prepareSandboxDirectory(path.join(composeEnv.IPC_MOUNT, projectName), "IPC", directoryDocker);
                }

                if (composeEnv.AGENT_HOME) {
                    // A volume subpath requires its target to exist.
                    await prepareSandboxDirectory(composeEnv.AGENT_HOME, "workspace", directoryDocker);
                }

                // Hand Docker volume subpaths, never the validated path strings:
                // it would re-follow any symlink swapped in after validation.
                const pinned = await pinSandboxMounts(composeEnv, projectName, toHostPath(stack.path), execDocker, stack.path);
                Object.assign(composeEnv, pinned.env);

                // Docker start events from this recreate must not trigger a
                // concurrent resume of the project hook.
                releaseStartup = await lockProjectStartup(projectName);

                // Best-effort cleanup of existing containers to prevent name conflicts on restart.
                // Run before-stop hook first (non-blocking) to keep lifecycle parity with sandbox_stop —
                // stacks like carapa-brain use it to flush state or drain connections before teardown.
                for (const step of [
                    { op: "pre-restart before-stop hook", run: async () => {
                        const beforeStopResult = await runHook(stack.path, "before-stop", extraEnv, localLog);
                        if (beforeStopResult.executed && beforeStopResult.exitCode !== 0) {
                            localLog(`[sandbox_start] before-stop hook exited with code ${beforeStopResult.exitCode} during pre-restart cleanup — continuing restart\n`);
                        }
                    } },
                    { op: "pre-restart stop", run: () => stopStack(stack.path, projectName, localLog) },
                ]) {
                    const warning = await runBestEffortLifecycleStep(step.op, step.run, localLog);
                    if (warning) output.push(warning);
                }

                await startStack(stack.path, projectName, composeEnv, localLog, pinned.pins);
                invalidatePsCache();
                output.push(`Stack ${name} (instance: ${projectName}) started successfully.`);

                // Resolve the agent container's REAL hostname for relay-token
                // registration. The relay derives its lookup key from the
                // container's actual reverse-DNS hostname ("before the first dot"),
                // so the store key must match that (service is `agent` for
                // carapa-bot, `php84` for custom stacks; carapa-projects overrides
                // `container_name` to `carapa-brain-carapa-agent-1`).
                const agentService = service || 'agent';
                const agentHostname = env && (env.CARAPA_BOARD_API_TOKEN || env.CARAPA_MAIL_MCP_TOKEN)
                    ? await resolveAgentHostname(stack.path, projectName, agentService)
                    : `${projectName}-${agentService}-1`;

                // Persist API token for the relay to discover if provided.
                // Note: we use the original 'env' because CARAPA_BOARD_API_TOKEN
                // is intentionally stripped from composeEnv to keep it out of the container.
                if (env && env.CARAPA_BOARD_API_TOKEN) {
                    try {
                        await setRelayToken(agentHostname, env.CARAPA_BOARD_API_TOKEN);
                        localLog(`[sandbox_start] Registered relay token for ${agentHostname}\n`);
                    } catch (err: any) {
                        localLog(`[sandbox_start] Error registering relay token: ${err.message}\n`);
                    }
                }

                // Per-project carapa-mail MCP token. This is the account-scoped
                // MCP token (NOT the admin CARAPA_MAIL_TOKEN) the relay injects
                // when this sandbox hits /carapa-mail/mcp. Stored under the
                // "carapa-mail" service scope so it doesn't collide with the
                // board token above.
                if (env && env.CARAPA_MAIL_MCP_TOKEN) {
                    try {
                        await setRelayToken(agentHostname, env.CARAPA_MAIL_MCP_TOKEN, "carapa-mail");
                        localLog(`[sandbox_start] Registered carapa-mail relay token for ${agentHostname}\n`);
                    } catch (err: any) {
                        localLog(`[sandbox_start] Error registering carapa-mail relay token: ${err.message}\n`);
                    }
                }

                // Run after-start hook
                const afterResult = await runHook(stack.path, "after-start", extraEnv, localLog);
                if (afterResult.executed) {
                    output.push(formatHookResult("after-start", afterResult, false));
                }

                // Board owns this preference; reconcile it after every managed
                // creation, including stacks whose compose env allowlist omits it.
                if (env?.CARAPA_SSH_ENABLED === "1" || env?.CARAPA_SSH_ENABLED === "0") {
                    const supportsSsh = await fileExists(path.join(stack.path, "ssh.json"));
                    if (supportsSsh) {
                        const ssh = await controlSandboxSsh(stack.path, projectName,
                            env.CARAPA_SSH_ENABLED === "1" ? "start" : "stop");
                        output.push(`SSH: ${ssh.running ? `listening on ${ssh.host}:${ssh.port}` : "disabled"}`);
                    } else if (env.CARAPA_SSH_ENABLED === "1") {
                        throw new Error("This stack does not support managed SSH");
                    }
                }

                // Project-owned startup follows controller setup and relay token
                // registration. Never source repository code in the controller.
                await recordProjectStartup(projectName, service).catch(err =>
                    localLog(`[sandbox_start] Could not record project startup: ${err.message}\n`));
                const projectStartup = await runProjectAfterStart(projectName, service, localLog);
                if (projectStartup) output.push(projectStartup);

                return {
                    content: [
                        {
                            type: "text",
                            text: output.join("\n"),
                        },
                    ],
                };
            } catch (error) {
                logger.error(`[sandbox_start] error: ${error}`);
                return {
                    content: [{ type: "text", text: `Failed to start stack: ${error}` }],
                    isError: true,
                };
            } finally {
                releaseStartup?.();
            }
        }
    );

    tool(
        "sandbox_publish_app",
        "Publish, inspect, or revoke one HTTP app on an owned sandbox service through CarapaBox ingress. Does not start the app or configure DNS/certificates.",
        {
            name: z.string(), instance: z.string().optional(),
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
            action: z.enum(['status', 'publish', 'unpublish']),
            service: z.string().optional(), targetPort: z.number().int().min(1024).max(65535).optional(),
            hostname: z.string().max(253).optional(),
            aliases: z.array(z.string().max(253)).max(8).optional().describe("The project's admin-configured proxy hostname aliases; the app may use one as its hostname"),
        },
        async (args): Promise<ToolResult> => {
            try {
                if (!isValidStackName(args.name) || (args.instance && !isValidStackName(args.instance))) throw new Error('Invalid sandbox identity');
                const stack = await getStack(args.name);
                if (!stack) throw new Error('Stack not found');
                const project = args.instance ? `${args.name}-${args.instance}` : args.name;
                // An app may take its own project's default hostname or aliases.
                const ownHostnames = [
                    ...defaultNginxProxyHostnames(stack.path, project, configuredNginxProxyDomains()),
                    ...(args.aliases ?? []),
                ];
                const result = await controlAppPublication(project, { ...args, ownHostnames });
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: String(error) }] };
            } finally {
                // The sandbox's own-hostname squid rule follows its published names.
                if (args.action !== 'status') scheduleNetworkPolicyReload();
            }
        },
    );

    // sandbox_proxy_aliases - Reconcile a running stack's generated nginx aliases
    tool(
        "sandbox_proxy_aliases",
        "Update public hostname aliases for a running sandbox's generated nginx route without restarting the sandbox.",
        SandboxProxyAliasesSchema,
        async (args): Promise<ToolResult> => {
            const { name, instance, aliases } = args as {
                name: string;
                instance?: string;
                aliases: string[];
            };
            if (!isValidStackName(name)) {
                return {
                    content: [{ type: "text", text: `Invalid stack name: ${name}` }],
                    isError: true,
                };
            }

            const stack = await getStack(name);
            if (!stack) {
                return {
                    content: [{ type: "text", text: `Stack not found: ${name}` }],
                    isError: true,
                };
            }

            const projectName = instance ? `${name}-${instance}` : name;
            try {
                const url = await registerNginxProxyRoute(
                    stack.path,
                    projectName,
                    execCompose,
                    JSON.stringify(aliases),
                );
                if (!url) {
                    return {
                        content: [{
                            type: "text",
                            text: `No active nginx proxy route for ${projectName}`,
                        }],
                        isError: true,
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text: `Updated nginx proxy aliases for ${projectName}`,
                    }],
                };
            } catch (error) {
                logger.error({ projectName, error }, "Could not update nginx proxy aliases");
                return {
                    content: [{
                        type: "text",
                        text: `Failed to update nginx proxy aliases: ${String(error)}`,
                    }],
                    isError: true,
                };
            } finally {
                scheduleNetworkPolicyReload();
            }
        },
    );

    // sandbox_stop - Stop a stack
    tool(
        "sandbox_stop",
        "Stop and remove sandbox containers, retaining stable network/IP reservations.",
        {
            name: z.string().describe("Name of the sandbox or instance to stop"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
        },
        async (args) => {
            const { name, instance } = args as { name: string; instance?: string };
            const { stackPath, projectName } = await resolveStackAndProject(name, instance);

            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            try {
                const output: string[] = [];
                const stackEnv = await parseEnvFile(path.join(stackPath, ".env"));
                const extraEnv = {
                    COMPOSE_PROJECT_NAME: projectName,
                    ...stackEnv,
                };

                // Read status before stopping: containers still exist (ps -a includes exited ones).
                // The relay tokens for these hostnames are only deleted once the stack has stopped.
                let relayPs: ServiceInfo[] = [];
                try {
                    relayPs = parseComposePsOutput((await getStackStatus(stackPath, projectName)).stdout || "");
                } catch {
                    // Best effort: fall back to the project-name hostnames only.
                }

                // Run before-stop hook
                const beforeResult = await runHook(stackPath, "before-stop", extraEnv, localLog);
                if (beforeResult.executed) {
                    output.push(formatHookResult("before-stop", beforeResult));
                    if (beforeResult.exitCode !== 0) {
                        return {
                            content: [{ type: "text", text: `before-stop hook failed:\n${output.join("\n")}` }],
                            isError: true,
                        };
                    }
                }

                // Gracefully stop all agent processes inside the container before tearing it down.
                // This ensures agents flush buffers and exit cleanly, so docker compose down
                // only needs to stop an idle shell (fast, no risk of file corruption).
                await runBestEffortLifecycleStep(
                    "stop sandbox processes",
                    () => stopSandboxProcesses(stackPath, projectName, localLog),
                    localLog,
                );

                // Stop the stack
                await stopStack(stackPath, projectName, localLog);
                invalidatePsCache();

                // Cleanup relay token(s) — board + carapa-mail — under every real container hostname.
                // Only after the stop succeeded: a failed stop leaves the sandbox running and it must keep its credentials.
                for (const hostname of relayTokenHostnames(projectName, relayPs)) {
                    try {
                        await deleteRelayToken(hostname);
                        await deleteRelayToken(hostname, "carapa-mail");
                    } catch {
                        // Ignore cleanup errors
                    }
                }

                // Run after-stop hook
                await runHook(stackPath, "after-stop", extraEnv, localLog);

                return {
                    content: [
                        {
                            type: "text",
                            text: `Stack ${name} (instance: ${projectName}) stopped.`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Failed to stop stack: ${error}` }],
                    isError: true,
                };
            }
        }
    );

    // sandbox_status - Get stack status
    tool(
        "sandbox_status",
        "Check if a sandbox is running and view its container health. Optionally filter by service name.",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            service: z.string().optional().describe("If set, return only this service's status"),
            checkUpdates: z.boolean().optional().describe("If true, perform expensive docker inspect calls to check if images are up to date"),
        },
        async (args) => {
            const { name, instance, service: serviceFilter, checkUpdates } = args as { name: string; instance?: string; service?: string; checkUpdates?: boolean };
            const { stackPath, projectName } = await resolveStackAndProject(name, instance);

            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            const result = await getStackStatus(stackPath, projectName);
            const stdout = (result.stdout || "").trim();
            if (!stdout) return { content: [{ type: "text", text: "[]" }] };

            const candidates: StatusCandidate[] = [];
            let parsedArray = false;

            // Efficient parsing without splitting if it's a JSON array
            if (stdout.startsWith("[") && stdout.endsWith("]")) {
                try {
                    const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
                    parsedArray = true;
                    for (const obj of arr) {
                        const candidate = toStatusCandidate(obj, serviceFilter);
                        if (candidate) candidates.push(candidate);
                    }
                } catch { /* fall through to NDJSON */ }
            }

            if (!parsedArray) {
                const lines = stdout.split(/\r?\n/).filter(Boolean);
                for (const line of lines) {
                    const obj = (() => {
                        try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
                    })();
                    if (!obj) continue;
                    const candidate = toStatusCandidate(obj, serviceFilter);
                    if (candidate) candidates.push(candidate);
                }
            }

            // Second pass: batch async docker inspect for image ID enrichment (only if requested)
            if (checkUpdates) {
                const latestImageIds = new Map<string, Promise<string>>();
                const latestImageId = (imageName: string) => {
                    let latest = latestImageIds.get(imageName);
                    if (!latest) {
                        latest = execDocker(["image", "inspect", imageName, "--format", "{{.Id}}"])
                            .then(result => result.stdout.trim());
                        latestImageIds.set(imageName, latest);
                    }
                    return latest;
                };
                await Promise.all(candidates.map(async ({ safe, containerName, imageName }) => {
                    if (containerName && imageName) {
                        try {
                            // Compose ps reports the running image ID once its tag has moved
                            // to a rebuilt image, so compare against the configured image.
                            const inspected = await execDocker(["inspect", containerName, "--format", "{{.Image}} {{.Config.Image}}"]);
                            const [running = "", configured] = inspected.stdout.trim().split(" ");
                            const latest = await latestImageId(configured || imageName);
                            safe.ImageID = running;
                            safe.UpToDate = running === latest;
                        } catch { /* best-effort — skip if inspect fails */ }
                    }
                }));
            }

            const out = candidates.map(c => c.safe);
            let text: string;
            if (serviceFilter && out.length === 0) {
                text = JSON.stringify({ error: `No container found for service '${serviceFilter}'.` });
            } else if (serviceFilter && out.length === 1) {
                text = JSON.stringify(out[0]);
            } else {
                text = JSON.stringify(out);
            }
            return {
                content: [{ type: "text", text }],
            };
        }
    );

    // sandbox_exec - Execute command in a service
    tool(
        "sandbox_exec",
        "Execute one trusted tool inside a running sandbox container. Bare names prefer a validated stack override, then fall back to an image-built executable.",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            service: z.string().describe("Name of the service (e.g. 'sandbox', 'browser')"),
            command: z.string().describe("Single trusted-tool invocation (e.g. 'run-agent.sh /workspace/ipc/runs/123')"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            timeout: z.number().optional().describe("Timeout in seconds. If not set, waits indefinitely."),
            env: z.record(z.string(), z.string()).optional().describe(
                "Environment variables forwarded via `docker compose exec -e` (values live in the compose process env, not argv)",
            ),
        },
        async (args) => {
            const { name, service, command, instance, timeout, env } = args as {
                name: string;
                service: string;
                command: string;
                instance?: string;
                timeout?: number;
                env?: Record<string, string>;
            };
            const { stackPath, projectName } = await resolveStackAndProject(name, instance);

            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            const restartReceipt = splitRestartRecoveryReceipt(command);
            const resolved = await resolveTrustedCommand(stackPath, restartReceipt?.command ?? command);
            const normalizedCommand = resolved.ok ? resolved.value.command : (resolved.command ?? command);
            let validation: { allowed: boolean; reason?: string; policy_name?: string };
            if (!resolved.ok) {
                validation = {
                    allowed: false,
                    reason: resolved.reason,
                    policy_name: "sandbox_exec.trusted_executable",
                };
            } else {
                validation = await validateCommand(stackPath, service, normalizedCommand, "sandbox_exec", { shellFree: true });
            }
            if (!validation.allowed) {
                auditLog({
                    timestamp: new Date().toISOString(),
                    tool: "sandbox_exec",
                    stack: name,
                    service,
                    command: normalizedCommand,
                    requested_command: command,
                    projectName: projectName ?? name,
                    allowed: false,
                    reason: validation.reason,
                    policy_name: validation.policy_name,
                });
                return {
                    content: [{ type: "text", text: `Security Error: ${validation.reason}` }],
                    isError: true,
                };
            }
            if (!resolved.ok) throw new Error("Trusted command resolution invariant failed");
            const { COMPOSE_FILE: _ignoredComposeFile, ...filteredEnv } = await filterEnvPassthrough(stackPath, env ?? {});

            try {
                let abortController: AbortController | undefined;
                let timer: ReturnType<typeof setTimeout> | undefined;
                if (timeout && timeout > 0) {
                    abortController = new AbortController();
                    timer = setTimeout(() => abortController!.abort(), timeout * 1000);
                }

                const execPromise = execArgvInService(
                    stackPath,
                    service,
                    resolved.value.argv,
                    projectName,
                    sendLog,
                    abortController?.signal,
                    filteredEnv,
                );

                let result;
                try {
                    result = await execPromise;
                } finally {
                    if (timer) clearTimeout(timer);
                }
                // Check if aborted
                if (abortController?.signal.aborted) {
                    throw new Error(`Command timed out after ${timeout}s`);
                }

                auditLog({
                    timestamp: new Date().toISOString(),
                    tool: "sandbox_exec",
                    stack: name,
                    service,
                    command: normalizedCommand,
                    requested_command: command,
                    projectName: projectName ?? name,
                    allowed: true,
                    exitCode: result.code,
                });

                if (restartReceipt && result.code === 0) {
                    const receiptResult = await execArgvInService(
                        stackPath, service, ["touch", "--", restartReceipt.receipt], projectName, undefined, undefined, {},
                    );
                    if (receiptResult.code !== 0) {
                        return {
                            content: [{ type: "text", text: `agent launched but restart-recovery receipt was not written: ${receiptResult.stderr}` }],
                            isError: true,
                        };
                    }
                }

                let output = result.stdout || result.stderr || "(no output)";
                if (result.code === 137) {
                    output += `\n${await collectTerminationEvidence(stackPath, projectName, service)}\n`;
                }
                return {
                    content: [{ type: "text", text: output }],
                    isError: result.code !== 0,
                };
            } catch (error) {
                auditLog({
                    timestamp: new Date().toISOString(),
                    tool: "sandbox_exec",
                    stack: name,
                    service,
                    command: normalizedCommand,
                    requested_command: command,
                    projectName: projectName ?? name,
                    allowed: true,
                    reason: `Exec failed: ${error}`,
                    exitCode: -1,
                });
                return {
                    content: [{ type: "text", text: `Exec failed: ${error}` }],
                    isError: true,
                };
            }
        }
    );

    // sandbox_ipc / sandbox_ipc_sync - Box-owned IPC tree (Board keeps a replica)
    registerIpcTools(tool);
    registerHubTools(tool);

    // ── Policy management tools ────────────────────────────────────────────

    // sandbox_policy_check — dry-run a command against the policy engine
    tool(
        "sandbox_policy_check",
        "Check if a command would be allowed by the security policy without executing it. Returns allow/deny, the reason, and which policy rule matched.",
        {
            name: z.string().describe("Name of the sandbox/stack"),
            service: z.string().describe("Service name"),
            command: z.string().describe("Command to check"),
            instance: z.string().optional().describe("Instance ID if applicable"),
        },
        async (args) => {
            const { name, service, command, instance } = args as { name: string; service: string; command: string; instance?: string };
            const { stackPath } = await resolveStackAndProject(name, instance);
            if (!stackPath) {
                return { content: [{ type: "text", text: `Stack not found: ${name}` }], isError: true } as ToolResult;
            }
            const result = await validateCommand(stackPath, service, command);
            const output = {
                allowed: result.allowed,
                reason: result.reason || "Allowed",
                policy_name: result.policy_name || "legacy_json",
                engine: (await hasOpaPolicy(stackPath)) ? "opa" : "none",
            };
            return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] } as ToolResult;
        }
    );

    // sandbox_network_policy_reload — hot-reload network policies
    tool(
        "sandbox_network_policy_reload",
        "Reload network policies from .rego files, regenerate squid ACLs, and apply via squid -k reconfigure. Use after editing network-policy.rego files.",
        {},
        async () => {
            const result = await reloadNetworkPolicies();
            return {
                content: [{ type: "text", text: result.ok ? `OK: ${result.message}` : `ERROR: ${result.message}` }],
                isError: !result.ok,
            } as ToolResult;
        }
    );

    // sandbox_git - Run git commands on workspace volume using host-side SSH keys
    if (process.env.ENABLE_SANDBOX_GIT) tool(
        "sandbox_git",
        "Run a git command on the sandbox workspace volume using host-side SSH keys. Runs in a temporary alpine/git container — SSH keys never enter the sandbox.",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            command: z.string().describe("Git command to run (e.g. 'push origin develop', 'status', 'log --oneline -5')"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            service: z.string().optional().describe("Service name to exec into for local git commands (default: 'agent')"),
            localRepo: z.string().optional().describe("Host-side repo path for remote git commands (overrides stack .env LOCAL_REPO)"),
            remoteUrl: remoteUrlSchema,
        },
        async (args) => {
            const { name, command, instance, service, localRepo: localRepoArg, remoteUrl } = args as { name: string; command: string; instance?: string; service?: string; localRepo?: string; remoteUrl?: string };
            const { stackPath, projectName } = await resolveStackAndProject(name, instance);

            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            // Determine if this git command needs SSH (remote operations) or is local-only.
            const parsedGit = parseCommandArgv(command);
            if (!parsedGit.ok) {
                return {
                    content: [{ type: "text", text: `Invalid git command: ${parsedGit.reason}` }],
                    isError: true,
                };
            }
            const needsSsh = isRemoteGitSubcommand(gitSubcommandFromArgv(parsedGit.argv));

            // Load stack .env for SSH keys path
            const stackEnv = await parseEnvFile(path.join(stackPath, ".env"));
            // SSH_KEYS_FOLDER points directly to the .ssh directory (not its parent)
            const sshKeysPath = stackEnv.SSH_KEYS_FOLDER || process.env.SSH_KEYS_FOLDER || null;

            if (needsSsh) {
                const rejection = validateRemoteGitArgv(parsedGit.argv);
                if (rejection) {
                    return { content: [{ type: "text", text: `Git command rejected: ${rejection}` }], isError: true };
                }
            }
            if (needsSsh && remoteUrl) {
                const urlError = validateRemoteUrl(remoteUrl);
                if (urlError) return { content: [{ type: "text", text: `Invalid remoteUrl: ${urlError}` }], isError: true };
            }
            if (needsSsh && localRepoArg) {
                const mountError = await validateLocalRepoArg(localRepoArg);
                if (mountError) return { content: [{ type: "text", text: mountError }], isError: true };
            }

            if (needsSsh && !sshKeysPath) {
                return {
                    content: [{ type: "text", text: `SSH keys not found. Set SSH_KEYS_FOLDER in stack .env` }],
                    isError: true,
                };
            }

            // When containerised, SSH_KEYS_FOLDER is a host path that doesn't
            // exist inside this container — but the Docker daemon resolves volume
            // mounts on the host, so the path is valid for docker run -v.
            const containerised = !!process.env.SANDBOX_HOST_DIR;
            if (needsSsh && !containerised && sshKeysPath && !(await fileExists(sshKeysPath))) {
                return {
                    content: [{ type: "text", text: `SSH keys not found at ${sshKeysPath}` }],
                    isError: true,
                };
            }

            // For local git commands, exec into the running agent container where
            // the repo is already bind-mounted (avoids the named-volume mismatch).
            if (!needsSsh) {
                try {
                    const result = await execArgvInService(stackPath, service || "agent", ["git", "-c", "safe.directory=*", ...parsedGit.argv], projectName, sendLog);
                    const output = result.stdout || result.stderr || "(no output)";
                    return {
                        content: [{ type: "text", text: output }],
                        isError: result.code !== 0,
                    };
                } catch (error) {
                    logger.warn(`[sandbox_git] [${projectName}] '${command}' failed: ${error}`);
                    return {
                        content: [{ type: "text", text: `Git operation failed: ${error}` }],
                        isError: true,
                    };
                }
            }

            try {
                const resolvedRepo = localRepoArg
                    ? { path: localRepoArg }
                    : await resolveHostRepo(stackPath, service || "agent", projectName, stackEnv.LOCAL_REPO || `${projectName}_workspace`);
                const repoPath = resolvedRepo.path;

                const remoteOpts = { repoPath, repoSubpath: resolvedRepo.subpath, sshKeysPath: sshKeysPath!, onLog: sendLog, remoteUrl, projectName };
                if (gitSubcommandFromArgv(parsedGit.argv) === "pull") {
                    return await runRemoteGitCommand(command, () => pullViaFetchAndLocalMerge(
                        parsedGit.argv,
                        (argv) => execRemoteGit(argv, remoteOpts),
                        (argv) => execArgvInService(stackPath, service || "agent", ["git", "-c", "safe.directory=*", ...argv], projectName, sendLog),
                        { requireExplicitRef: !!remoteUrl },
                    ));
                }
                return await runRemoteGitCommand(command, () => execRemoteGit(parsedGit.argv, remoteOpts));
            } catch (error) {
                logger.warn(`[sandbox_git] [${projectName}] '${command}' failed: ${error}`);
                return {
                    content: [{ type: "text", text: `Git operation failed: ${error}` }],
                    isError: true,
                };
            }
        }
    );

    // sandbox_worktree - Manage git worktrees for isolated task branches
    if (process.env.ENABLE_SANDBOX_GIT) tool(
        "sandbox_worktree",
        "Manage git worktrees on the sandbox workspace volume. Creates isolated working directories for concurrent task branches. Worktrees live at {WORKSPACE_PATH}/.worktrees/{branch}/.",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            action: z.enum(["add", "reuse", "remove", "list", "reset"]).describe("Worktree operation: add provisions or explicitly re-provisions, reuse validates an existing checkout and restores preview metadata without pulls or setup hooks, remove deletes it, list shows all, reset discards all changes and resets to the latest commit on the default branch"),
            branch: z.string().optional().describe("Branch name (required for add/reuse/remove/reset)"),
            base: z.string().optional().describe("Branch name only, not a full ref: use 'main' or 'develop', not 'origin/main'. Creates from this branch for add (default: HEAD) or resets to it for reset (default: remote default branch)."),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            localRepo: z.string().optional().describe("Host-side LOCAL_REPO path (overrides stack .env)"),
            repoPath: z.string().optional().describe("Container-side repository path for local worktree commands"),
            symlinkFiles: z.array(z.string()).optional().describe("Files to symlink from main repo into new worktree (e.g. ['.env', 'config/local.php'])"),
            service: z.string().optional().describe("Service name to exec into (default: 'agent')"),
            remoteUrl: remoteUrlSchema,
        },
        async (args) => {
            const { name, action, branch, base, instance, localRepo: localRepoArg, repoPath: repoPathArg, symlinkFiles, service, remoteUrl } = args as {
                name: string;
                action: "add" | "reuse" | "remove" | "list" | "reset";
                branch?: string;
                base?: string;
                instance?: string;
                localRepo?: string;
                repoPath?: string;
                symlinkFiles?: string[];
                service?: string;
                remoteUrl?: string;
            };

            if ((branch !== undefined && !isSafeBranchArg(branch)) || (base !== undefined && !isSafeBranchArg(base))) {
                return INVALID_BRANCH_RESULT;
            }

            const { stackPath, projectName } = await resolveStackAndProject(name, instance);
            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            const stackEnv = await parseEnvFile(path.join(stackPath, ".env"));
            const svcName = service || "agent";

            // Always resolve the actual repo path from the running container's bind mounts.
            // LOCAL_REPO in stack .env is a default that gets overridden at start time.
            const configuredRepo = localRepoArg || stackEnv.LOCAL_REPO || "";
            const hostRepo = await resolveHostRepo(stackPath, svcName, projectName, configuredRepo);
            const localRepo = hostRepo.path;
            const repoSubpath = hostRepo.subpath;
            const displayRepo = displayRepoPath(hostRepo, configuredRepo);
            if (!localRepo && action !== "list") {
                return {
                    content: [{ type: "text", text: "Could not resolve repo path — is the sandbox running?" }],
                    isError: true,
                };
            }

            const worktreeDir = ".worktrees";
            const { execGit, execShell } = repositoryExecutors(stackPath, svcName, projectName, repoPathArg, sendLog);
            // Provisioning env forwarded to .agent/worktree-{setup,teardown}.sh:
            // PROVISION_* from the stack .env plus WT_BRANCH/WT_SLUG.
            // Built per-branch (branch is required for add/remove/reset; null for list).
            const provisionEnv = branch && action !== "reuse" ? buildProvisionEnv(stackEnv, branch) : undefined;
            const strictHooks = strictWorktreeHooksEnabled(stackEnv);
            // Live worktree branches, read from the AGENT container (it mounts
            // the repo; carapa-box does not). Used to prune stale nginx-wt confs
            // safely. `known=false` when the listing failed — callers then skip
            // pruning entirely rather than risk deleting a live sibling's conf.
            const getLiveBranches = async (): Promise<{ branches: string[]; known: boolean }> => {
                try {
                    const r = await execShell(`ls -1 ${worktreeDir} 2>/dev/null`);
                    if (r.code !== 0) return { branches: [], known: false };
                    const branches = (r.stdout || "")
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    return { branches, known: true };
                } catch {
                    return { branches: [], known: false };
                }
            };

            if (action === "list") {
                try {
                    const result = await execGit("worktree list --porcelain");
                    return {
                        content: [{ type: "text", text: worktreeListText(result) }],
                        isError: result.code !== 0,
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Worktree list failed: ${error}` }], isError: true };
                }
            }

            if (!branch) {
                return {
                    content: [{ type: "text", text: `Branch name is required for action '${action}'` }],
                    isError: true,
                };
            }

            if (action === "reuse") {
                try {
                    const output = await reuseManagedWorktree(branch, displayRepo, {
                        execShell,
                        previewEnabled: await fileExists(path.join(stackPath, "nginx-wt.conf.tmpl")),
                        readPreviewPort: () => listWorktreePreviews(stackPath, projectName).find((entry) => entry.slug === branch)?.port,
                        restorePreview: () => syncWorktreePreview({
                            stackDir: stackPath, projectName, branch, mode: "add", liveKnown: false,
                        }),
                        writePreview: (port) => writeWorktreePreviewUrl(execShell, `${worktreeDir}/${branch}`, port, true),
                    });
                    return { content: [{ type: "text", text: output }] };
                } catch (error) {
                    return { content: [{ type: "text", text: `Worktree reuse failed: ${error}` }], isError: true };
                }
            }

            if (action === "add") {
                try {
                    // Ignore .worktrees via the untracked info/exclude (shared git common dir), never the
                    // tracked .gitignore: editing that leaves the default checkout dirty and blocks merges.
                    await execShell(WORKTREES_EXCLUDE_CMD);

                    // Pull latest changes on the base branch via SSH git container before branching
                    const baseArg = base || "HEAD";
                    if (base) {
                        const sshKeysPath = stackEnv.SSH_KEYS_FOLDER || process.env.SSH_KEYS_FOLDER || null;
                        if (sshKeysPath) {
                            try {
                                const remoteOpts = {
                                    repoPath: localRepo, sshKeysPath, onLog: sendLog, remoteUrl, projectName, repoSubpath,
                                };
                                const ff = await fastForwardBaseFromRemote(base, (argv) => execRemoteGit(argv, remoteOpts), (argv) => execGit(argv.join(" ")));
                                if (ff.code !== 0) {
                                    logger.warn(`[sandbox_worktree:add] [${projectName}] pull origin ${base} failed (best-effort): ${ff.stderr.trim()}`);
                                }
                            } catch (pullErr) {
                                logger.warn(`[sandbox_worktree:add] [${projectName}] pull origin ${base} failed (best-effort): ${pullErr}`);
                            }
                        }
                    }

                    // Create the worktree — try with -b first (new branch), fall back to existing
                    const worktreePath = `${worktreeDir}/${branch}`;

                    // If the worktree directory already exists, treat as idempotent
                    // success (e.g. task is being continued after pause/failure).
                    const qWt = shellQuote(worktreePath);
                    const qBranch = shellQuote(branch);
                    const qBase = shellQuote(baseArg);
                    const dirExists = await execShell(`test -d ${qWt}`);
                    if (dirExists.code !== 0) {
                        // Working tree is missing. If this worktree's admin metadata
                        // (.git/worktrees/<basename of the path>/, found via its gitdir file
                        // since slash-named branches differ) still exists (a prior interrupted run that created the branch + admin
                        // dir but never finished checking out files), it blocks `worktree add`
                        // until cleared. Remove ONLY this worktree's admin dir — never run a
                        // blanket `git worktree prune`, which could mark other live worktrees
                        // as prunable when their registered path doesn't resolve in this
                        // container's view (cross-container bind-mount path mismatch).
                        const orphanAdmin = await findWorktreeAdminDir(execShell, worktreePath, branch);
                        if (orphanAdmin) {
                            logger.info(`[sandbox_worktree:add] removing orphan admin metadata ${orphanAdmin} for branch ${branch}`);
                            await execShell(`rm -rf ${shellQuote(orphanAdmin)}`);
                        }
                    } else {
                        logger.info(`[sandbox_worktree:add] worktree already exists at ${worktreePath}, reusing`);
                        const listCheck = await execGit("worktree list --porcelain");
                        if (listCheck.code !== 0) {
                            // Unknown registration state: never delete a directory that may hold uncommitted work.
                            return {
                                content: [{ type: "text", text: `[env] could not list worktrees (exit ${listCheck.code}): ${(listCheck.stderr || "").trim()}; refusing to remove existing worktree ${worktreePath}` }],
                                isError: true,
                            };
                        }
                        if (!isRegisteredWorktree(listCheck.stdout || "", worktreePath)) {
                            // Directory exists but git doesn't track it — remove and recreate
                            await execShell(`rm -rf ${qWt}`);
                            logger.info(`[sandbox_worktree:add] orphaned directory removed, will recreate`);
                        } else {
                            // Worktree is tracked and directory exists — reuse it.
                            // Re-establish worktreeFiles symlinks first: a prior
                            // sandbox_worktree:reset (git reset --hard) wipes
                            // vendor/etc, and without this the reused worktree
                            // is missing them → app 500s.
                            const hostWorktreePath = `${displayRepo}/${worktreePath}`;
                            await provisionWorktreeSymlinks(execGit, execShell, worktreePath, symlinkFiles);
                            await runWorktreeSetup(
                                execGit,
                                execShell,
                                worktreePath,
                                { ...provisionEnv, WT_ACTION: "reuse" },
                                strictHooks,
                            );
                            const liveReuse = await getLiveBranches();
                            const reusePort = await syncWorktreePreview({
                                stackDir: stackPath, projectName, branch, mode: "add",
                                liveBranches: liveReuse.branches, liveKnown: liveReuse.known,
                            });
                            await writeWorktreePreviewUrl(execShell, worktreePath, reusePort);
                            const reusePortLine = reusePort ? `\npreview_port=${reusePort}` : "";
                            return {
                                content: [{ type: "text", text: `worktree_path=${hostWorktreePath}${reusePortLine}\nWorktree already exists, reusing` }],
                            };
                        }
                    }

                    // A signal kill is exit 128+N (N = 1..64) with no output: the process was
                    // killed, git never reported anything. Any `fatal:`/`error:` text means a git
                    // failure, whatever the code (git exits 128 for die(), 255 for error() paths
                    // such as `-b` naming an existing branch).
                    const isSignalKill = (r: { code: number; stdout: string; stderr: string }) =>
                        r.code >= 129 && r.code <= 192 && !(r.stderr || r.stdout || '').trim();

                    const describeFailure = (r: { code: number; stdout: string; stderr: string }) => {
                        const out = (r.stderr || r.stdout || '').trim();
                        if (out) return out;
                        // Exit 137 (SIGKILL) inside `docker exec` usually means the agent container
                        // was unhealthy/restarting (a sandbox restart clears it) or, less often,
                        // OOM-killed mid-checkout. Either way it's not a branch problem — say so
                        // and point at the box.
                        if (isSignalKill(r)) {
                            const sig = r.code - 128;
                            const names: Record<number, string> = { 9: 'SIGKILL', 15: 'SIGTERM', 2: 'SIGINT', 11: 'SIGSEGV' };
                            const sigName = names[sig] ? ` (${names[sig]})` : '';
                            const hint = sig === 9
                                ? ' — the agent container was killed mid-checkout (unhealthy/restarting container, or OOM). This is not a branch problem; restart the sandbox, and if it recurs check `docker stats`/container health and memory limits.'
                                : ' — the process was killed before git could report an error; restart the sandbox and check the agent container health/logs.';
                            return `git worktree add was killed by signal ${sig}${sigName}${hint}`;
                        }
                        return `git worktree add exited ${r.code} with no output (no stdout/stderr captured) — check the agent container health/logs.`;
                    };

                    // One add attempt. The branch's existence decides `-b` (new branch) vs
                    // checking out the existing branch — never an exit code. If the branch
                    // appears between the check and the add (race), a genuine git failure of the
                    // `-b` attempt still falls back to the existing-branch form. A signal kill
                    // is not a git failure, so it skips the fallback (same dead container).
                    const attemptAdd = async () => {
                        const exists = await execGit(`show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`);
                        if (exists.code === 0) return execGit(`worktree add ${qWt} ${qBranch}`);
                        let r = await execGit(`worktree add ${qWt} -b ${qBranch} ${qBase}`);
                        if (r.code !== 0 && !isSignalKill(r)) {
                            logger.warn({ error: describeFailure(r) }, "[sandbox_worktree:add] first attempt failed");
                            r = await execGit(`worktree add ${qWt} ${qBranch}`);
                        }
                        return r;
                    };

                    let result = await attemptAdd();

                    // One immediate retry rescues a rare one-off SIGKILL; a persistently
                    // wedged/OOM container fails again and falls through to the clear error
                    // below (which tells the user to restart the sandbox stack). No restart
                    // here — that would disrupt other agents sharing the instance.
                    if (isSignalKill(result)) {
                        logger.warn({ code: result.code }, "[sandbox_worktree:add] killed by signal — one immediate retry");
                        // Clear any half-written admin/worktree state the killed attempt left
                        // behind, so the retry isn't blocked by a stale path turning a kill
                        // into a misleading "already exists".
                        await removeWorktreeAdminDir(execShell, worktreePath, branch);
                        await execShell(`rm -rf ${qWt}`);
                        result = await attemptAdd();
                    }

                    if (result.code !== 0) {
                        return {
                            content: [{ type: "text", text: `Failed to create worktree: ${describeFailure(result)}` }],
                            isError: true,
                        };
                    }

                    // Symlink worktreeFiles (vendor/storage/…) from main checkout,
                    // then run the repo's optional post-provision setup (build).
                    await provisionWorktreeSymlinks(execGit, execShell, worktreePath, symlinkFiles);
                    await runWorktreeSetup(
                        execGit,
                        execShell,
                        worktreePath,
                        { ...provisionEnv, WT_ACTION: "add" },
                        strictHooks,
                    );

                    // Per-worktree nginx preview server (best-effort; opt-in per stack)
                    const liveAdd = await getLiveBranches();
                    const previewPort = await syncWorktreePreview({
                        stackDir: stackPath, projectName, branch, mode: "add",
                        liveBranches: liveAdd.branches, liveKnown: liveAdd.known,
                    });
                    await writeWorktreePreviewUrl(execShell, worktreePath, previewPort);
                    const previewPortLine = previewPort ? `\npreview_port=${previewPort}` : "";

                    // Return the host-side worktree path
                    const hostWorktreePath = `${displayRepo}/${worktreePath}`;
                    return {
                        content: [{ type: "text", text: `worktree_path=${hostWorktreePath}${previewPortLine}\n${result.stdout || "Worktree created"}` }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Worktree add failed: ${error}` }], isError: true };
                }
            }

            if (action === "remove") {
                try {
                    const worktreePath = `${worktreeDir}/${branch}`;
                    // Run the project's teardown hook (e.g. drop the per-worktree DB)
                    // BEFORE removal, while the worktree files and CWD still exist.
                    await runWorktreeTeardown(
                        execGit,
                        execShell,
                        worktreePath,
                        { ...provisionEnv, WT_ACTION: "remove" },
                        strictHooks,
                    );
                    const result = await execGit(`worktree remove ${shellQuote(worktreePath)} --force`);
                    if (result.code !== 0) {
                        // Fallback: manual cleanup if git worktree remove fails.
                        // Surgical removal of this branch's admin dir only — never a
                        // blanket `worktree prune`, which could detach the index/HEAD
                        // of unrelated live worktrees whose registered paths don't
                        // resolve in this container's view.
                        await execShell(`rm -rf ${shellQuote(worktreePath)}`);
                        await removeWorktreeAdminDir(execShell, worktreePath, branch);
                    }
                    await syncWorktreePreview({
                        stackDir: stackPath, projectName, branch, mode: "remove",
                    });
                    return {
                        content: [{ type: "text", text: result.stdout || "Worktree removed" }],
                    };
                } catch (error) {
                    return { content: [{ type: "text", text: `Worktree remove failed: ${error}` }], isError: true };
                }
            }

            if (action === "reset") {
                try {
                    const worktreePath = `${worktreeDir}/${branch}`;
                    logger.info(`[sandbox_worktree:reset] branch="${branch}" base="${base}" worktreePath="${worktreePath}"`);

                    // Determine the base ref: explicit arg or remote default branch
                    let baseRef: string;
                    if (base) {
                        baseRef = base;
                    } else {
                        const symResult = await execGit("symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null");
                        baseRef = (symResult.stdout || "").trim() || "origin/HEAD";
                    }
                    logger.info(`[sandbox_worktree:reset] baseRef="${baseRef}"`);

                    // Pull latest into the local base branch via SSH git container
                    if (base) {
                        const sshKeysPath = stackEnv.SSH_KEYS_FOLDER || process.env.SSH_KEYS_FOLDER || null;
                        if (sshKeysPath) {
                            try {
                                const remoteOpts = {
                                    repoPath: localRepo, sshKeysPath, onLog: sendLog, remoteUrl, projectName, repoSubpath,
                                };
                                const pullResult = await fastForwardBaseFromRemote(base, (argv) => execRemoteGit(argv, remoteOpts), (argv) => execGit(argv.join(" ")));
                                logger.info(`[sandbox_worktree:reset] pull code=${pullResult.code} stdout="${pullResult.stdout.trim()}" stderr="${pullResult.stderr.trim()}"`);
                            } catch (pullErr) {
                                logger.warn(`[sandbox_worktree:reset] [${projectName}] pull origin ${base} refused or failed (best-effort): ${pullErr}`);
                            }
                        } else {
                            logger.info(`[sandbox_worktree:reset] SSH_KEYS_FOLDER not set, skipping pull`);
                        }
                    }

                    // Log current HEAD of base branch before reset
                    const headResult = await execGit(`log -1 --oneline ${shellQuote(baseRef)}`);
                    logger.info(`[sandbox_worktree:reset] ${baseRef} HEAD: ${headResult.stdout.trim()}`);

                    // Create worktree if it doesn't exist (idempotent reset)
                    const checkResult = await execShell(`test -d ${shellQuote(worktreePath)}`);
                    if (checkResult.code !== 0) {
                        logger.info(`[sandbox_worktree:reset] worktree missing, creating it`);
                        // Clear stale admin metadata for this branch only, then delete
                        // the old branch so we start fresh from baseRef (the old branch
                        // may carry conflict markers or broken commits from a previous
                        // failed run). Surgical to avoid affecting other live worktrees.
                        await removeWorktreeAdminDir(execShell, worktreePath, branch);
                        await execGit(`branch -D ${shellQuote(branch)}`);
                        const addResult = await execGit(`worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branch)} ${shellQuote(baseRef)}`);
                        if (addResult.code !== 0) {
                            return {
                                content: [{ type: "text", text: `Failed to create missing worktree: ${addResult.stdout || addResult.stderr}` }],
                                isError: true,
                            };
                        }
                    } else {
                        await runWorktreeTeardown(
                            execGit,
                            execShell,
                            worktreePath,
                            { ...provisionEnv, WT_ACTION: "reset" },
                            strictHooks,
                        );
                    }

                    // Reset hard and remove all untracked files/dirs
                    const resetResult = await execShell(
                        `git config --global safe.directory '*' 2>/dev/null; cd ${shellQuote(worktreePath)} && git reset --hard ${shellQuote(baseRef)} && git clean -fd`
                    );
                    logger.info(`[sandbox_worktree:reset] reset code=${resetResult.code} stdout="${resetResult.stdout.trim().slice(0, 200)}" stderr="${resetResult.stderr.trim().slice(0, 200)}"`);
                    if (resetResult.code !== 0) {
                        return {
                            content: [{ type: "text", text: `Failed to reset worktree: ${resetResult.stdout || resetResult.stderr}` }],
                            isError: true,
                        };
                    }

                    await provisionWorktreeSymlinks(execGit, execShell, worktreePath, symlinkFiles);
                    await runWorktreeSetup(
                        execGit,
                        execShell,
                        worktreePath,
                        { ...provisionEnv, WT_ACTION: "reset" },
                        strictHooks,
                    );

                    // Reset may create a missing worktree or restore one after a
                    // sandbox restart. Refresh its preview just like add/reuse
                    // and rewrite .preview-url if the stack opts in.
                    const liveReset = await getLiveBranches();
                    const resetPort = await syncWorktreePreview({
                        stackDir: stackPath, projectName, branch, mode: "add",
                        liveBranches: liveReset.branches, liveKnown: liveReset.known,
                    });
                    await writeWorktreePreviewUrl(execShell, worktreePath, resetPort);
                    const resetPortLine = resetPort ? `\npreview_port=${resetPort}` : "";

                    return {
                        content: [{
                            type: "text",
                            text: `${resetResult.stdout || `Worktree reset to ${baseRef}`}${resetPortLine}`,
                        }],
                    };
                } catch (error) {
                    logger.error(`[sandbox_worktree:reset] EXCEPTION: ${error}`);
                    return { content: [{ type: "text", text: `Worktree reset failed: ${error}` }], isError: true };
                }
            }

            return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
        }
    );

    // sandbox_branch - Atomic git branch lifecycle operations for task transitions.
    // Bundles multi-step git sequences into single exec calls so failures are
    // rolled back cleanly without leaving the repo in an inconsistent state.
    if (process.env.ENABLE_SANDBOX_GIT) tool(
        "sandbox_branch",
        "Atomic git branch lifecycle operations for task stage transitions. Actions: commit (stage + commit in one call), prepare_review (commit + rebase onto base), inspect (optional project-owned nested-repository inspection), merge (merge branch into base + cleanup).",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            action: z.enum(["prepare_review", "inspect", "merge", "commit"]).describe("Lifecycle action"),
            branch: z.string().describe("Task branch name"),
            base: z.string().optional().describe("Default branch name (default: 'develop')"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            localRepo: z.string().optional().describe("Host-side LOCAL_REPO path (overrides stack .env)"),
            repoPath: z.string().optional().describe("Container-side repository path for local branch commands"),
            service: z.string().optional().describe("Service name to exec into (default: 'agent')"),
            autoPush: z.boolean().optional().describe("For merge: push default branch to remote after merge"),
            worktreePath: z.string().optional().describe("Relative worktree path (e.g. '.worktrees/my-branch'). If provided, git commands run inside this directory."),
            commitMessage: z.string().optional().describe("Commit message used by the commit action, and by prepare_review and merge when auto-committing uncommitted changes (default: auto-generated from branch name)."),
            paths: z.array(z.string()).optional().describe("Specific paths to stage for commit action. When omitted, stages everything (git add .)."),
            remoteUrl: remoteUrlSchema,
        },
        async (args) => {
            const { name, action, branch, base, instance, localRepo: localRepoArg, repoPath: repoPathArg, service, autoPush, worktreePath: wtPathArg, commitMessage, paths, remoteUrl } = args as {
                name: string;
                action: "prepare_review" | "inspect" | "merge" | "commit";
                branch: string;
                base?: string;
                instance?: string;
                localRepo?: string;
                repoPath?: string;
                service?: string;
                autoPush?: boolean;
                worktreePath?: string;
                commitMessage?: string;
                paths?: string[];
                remoteUrl?: string;
            };

            if (
                !isSafeBranchArg(branch)
                || (base !== undefined && !isSafeBranchArg(base))
                || (wtPathArg !== undefined && !isValidWorktreePathArg(wtPathArg))
            ) {
                return INVALID_BRANCH_RESULT;
            }

            const { stackPath, projectName } = await resolveStackAndProject(name, instance);
            if (!stackPath) {
                return { content: [{ type: "text", text: `Stack or instance not found: ${name}` }], isError: true };
            }

            const stackEnv = await parseEnvFile(path.join(stackPath, ".env"));
            const svcName = service || "agent";
            const baseBranch = base || "develop";
            const configuredRepo = localRepoArg || stackEnv.LOCAL_REPO || "";
            const hostRepo = await resolveHostRepo(
                stackPath, svcName, projectName,
                configuredRepo,
            );
            const localRepo = hostRepo.path;
            const resolvedRepo = repoPathArg || !(action === "commit" && !wtPathArg)
                ? undefined
                : await resolveContainerRepoPath(stackPath, svcName, projectName, configuredRepo || localRepo);
            const containerRepo = repoPathArg || (resolvedRepo && "path" in resolvedRepo ? resolvedRepo.path : undefined);
            const repoPathError = resolvedRepo && "reason" in resolvedRepo ? resolvedRepo.reason : undefined;

            const { execGit, execShell } = repositoryExecutors(stackPath, svcName, projectName, repoPathArg, sendLog);

            // An explicit worktreePath selects an isolated worktree. Its
            // absence is branch mode: operate in the repository root. Never
            // infer a .worktrees/<branch> directory for branch-mode actions.
            const {
                checkoutPath: wtRel,
                gitPrefix: gitC,
                usesWorktree,
            } = branchActionCheckout(wtPathArg);
            const provisionEnv = buildProvisionEnv(stackEnv, branch);
            const strictHooks = strictWorktreeHooksEnabled(stackEnv);
            const hookEnv = (hookAction: string) => ({
                ...provisionEnv,
                WT_ACTION: hookAction,
                WT_BASE_BRANCH: baseBranch,
                WT_COMMIT_MESSAGE: commitMessage || `feat: ${branch}`,
            });
            const runAuthoritativeHook = async (hookName: string, hookAction: string) => {
                return runWorktreeHook(
                    execGit,
                    execShell,
                    wtRel,
                    hookName,
                    hookEnv(hookAction),
                    true,
                );
            };
            const removePreview = () => syncWorktreePreview({
                stackDir: stackPath,
                projectName,
                branch,
                mode: "remove",
            });
            const removeWorktree = async (cleanupAction: string) => {
                await runWorktreeTeardown(
                    execGit,
                    execShell,
                    wtRel,
                    hookEnv(cleanupAction),
                    strictHooks,
                );
                const removeResult = await execGit(`worktree remove ${shellQuote(wtRel)} --force`);
                if (removeResult.code !== 0) {
                    // Surgical cleanup of just this branch's admin dir — never a
                    // blanket `worktree prune` that could detach live worktrees.
                    await execShell(`rm -rf ${shellQuote(wtRel)}`);
                    await removeWorktreeAdminDir(execShell, wtRel, branch);
                }
            };
            const deleteBranch = async () => {
                const deleteResult = await execGit(`branch -D ${shellQuote(branch)}`);
                if (deleteResult.code !== 0) {
                    logger.warn(`[sandbox_branch:cleanup] branch "${branch}" delete skipped/failed: ${(deleteResult.stderr || deleteResult.stdout || "").trim()}`);
                }
            };
            const cleanupBranchArtifacts = async (deleteGitBranch: boolean, cleanupAction: string) => {
                if (usesWorktree) {
                    await removeWorktree(cleanupAction);
                    await removePreview();
                }
                if (deleteGitBranch) await deleteBranch();
            };

            // ── inspect ─────────────────────────────────────────────
            if (action === "inspect") {
                try {
                    const inspected = await runWorktreeHook(
                        execGit,
                        execShell,
                        wtRel,
                        "worktree-inspect.sh",
                        hookEnv("inspect"),
                        false,
                    );
                    if (!inspected.present) {
                        return { content: [{ type: "text", text: JSON.stringify({ repositories: [] }) }] };
                    }
                    if (!inspected.ok) {
                        return {
                            content: [{ type: "text", text: inspected.output || "worktree inspection failed" }],
                            isError: true,
                        };
                    }
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(inspected.data ?? { repositories: [], output: inspected.output }),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `inspect failed: ${error}` }],
                        isError: true,
                    };
                }
            }

            // ── prepare_review ──────────────────────────────────────
            if (action === "prepare_review") {
                try {
                    logger.info(`[sandbox_branch:prepare_review] branch="${branch}" base="${baseBranch}" worktree="${wtRel}"`);
                    await runAuthoritativeHook("worktree-commit.sh", "prepare_review");

                    // 1. Check for a REAL merge-conflict state BEFORE committing — if the
                    //    working tree has unmerged paths (e.g. from a failed stash pop
                    //    rescue), do NOT commit them. Reset to clean state instead.
                    //    NOTE: we must NOT text-grep for "<<<<<<< " here — legitimate source
                    //    files (including this one) contain that literal and would trigger a
                    //    false positive that wipes the implementation's uncommitted work.
                    //    `git ls-files -u` lists only genuinely unmerged paths.
                    const unmergedCheck = await execGit(`${gitC} ls-files -u`);
                    if ((unmergedCheck.stdout || "").trim()) {
                        logger.warn({ files: (unmergedCheck.stdout || "").trim() }, "[sandbox_branch:prepare_review] unmerged paths found in worktree, resetting");
                        // Reset the conflicted files to the branch's last clean commit
                        await execGit(`${gitC} checkout -- .`);
                        await execShell(`cd ${shellQuote(wtRel)} && git clean -fd`);
                    }

                    // 2. Commit any uncommitted changes (never stage node_modules symlinks)
                    const statusResult = await execGit(`${gitC} status --porcelain`);
                    let committed = false;
                    if ((statusResult.stdout || "").trim()) {
                        const msg = commitMessage || `feat: ${branch}`;
                        await execGit(`${gitC} rm -r --cached --ignore-unmatch node_modules`);
                        await execShell(`rm -f ${shellQuote(`${wtRel}/node_modules`)}`);
                        const addResult = await execGit(`${gitC} add -A -- . ':!node_modules'`);
                        if (addResult.code !== 0) {
                            return {
                                content: [{ type: "text", text: `prepare_review: git add failed: ${addResult.stderr || addResult.stdout}` }],
                                isError: true,
                            };
                        }
                        const commitResult = await execGit(`${gitC} commit -m ${shellQuote(msg)}`);
                        committed = commitResult.code === 0;
                        logger.info(`[sandbox_branch:prepare_review] commit=${committed}`);
                    }

                    // 3. Rebase onto latest base branch
                    const rebaseResult = await execGit(`${gitC} rebase ${shellQuote(baseBranch)}`);
                    let rebased = rebaseResult.code === 0;
                    if (!rebased) {
                        logger.warn(`[sandbox_branch:prepare_review] rebase conflict, aborting`);
                        await execGit(`${gitC} rebase --abort`);
                    }
                    logger.info(`[sandbox_branch:prepare_review] rebased=${rebased}`);

                    return {
                        content: [{ type: "text", text: JSON.stringify({ committed, rebased }) }],
                    };
                } catch (error) {
                    logger.error(`[sandbox_branch:prepare_review] EXCEPTION: ${error}`);
                    // Best-effort abort any in-progress rebase
                    try { await execGit(`${gitC} rebase --abort`); } catch { /* intentionally swallowed: rebase may not have been started or is already aborted */ }
                    return { content: [{ type: "text", text: `prepare_review failed: ${error}` }], isError: true };
                }
            }

            // ── commit ──────────────────────────────────────────────
            if (action === "commit") {
                const lockKey = `${projectName}:${containerRepo || repoPathArg || wtRel}:${wtPathArg || branch}`;
                return withBranchMutationLock(lockKey, async () => {
                    try {
                        const msg = commitMessage || `feat: ${branch}`;
                        logger.info(`[sandbox_branch:commit] branch="${branch}" worktreePath="${wtPathArg}" paths=${JSON.stringify(paths)}`);
                        if (wtPathArg) await runAuthoritativeHook("worktree-commit.sh", "commit");
                        const result = await commitSandboxBranch({
                            branch, message: msg, paths, worktreePath: wtPathArg,
                            repoPath: containerRepo, repoPathError, execGit,
                        });
                        if ("error" in result) {
                            logger.warn({ branch, worktreePath: wtPathArg, error: result.error }, "[sandbox_branch:commit] failed");
                            return { content: [{ type: "text", text: result.error }], isError: true };
                        }
                        return { content: [{ type: "text", text: JSON.stringify(result) }] };
                    } catch (error) {
                        logger.error({ branch, worktreePath: wtPathArg, error }, "[sandbox_branch:commit] EXCEPTION");
                        return { content: [{ type: "text", text: `commit failed: ${error}` }], isError: true };
                    }
                });
            }

            // ── merge ───────────────────────────────────────────────
            if (action === "merge") {
                try {
                    logger.info(`[sandbox_branch:merge] branch="${branch}" base="${baseBranch}" autoPush=${autoPush}`);
                    await runAuthoritativeHook("worktree-commit.sh", "merge");

                    const refuseMerge = (output: string) => ({
                        content: [{ type: "text" as const, text: JSON.stringify({ merged: false, pushed: false, output }) }],
                        isError: true,
                    });

                    // 1. Commit any remaining changes on the task branch
                    const statusResult = await execGit(`${gitC} status --porcelain`);
                    if ((statusResult.stdout || "").trim()) {
                        const msg = commitMessage || `feat: ${branch}`;
                        const addResult = await execGit(`${gitC} add .`);
                        const commitResult = await execGit(`${gitC} commit -m ${shellQuote(msg)}`);
                        const commitOutput = `${commitResult.stdout || ""}\n${commitResult.stderr || ""}`;
                        const nothingToCommit = commitResult.code !== 0 && addResult.code === 0 && /nothing (added )?to commit/i.test(commitOutput);
                        if ((addResult.code !== 0 || commitResult.code !== 0) && !nothingToCommit) {
                            const failed = addResult.code !== 0 ? addResult : commitResult;
                            return refuseMerge(`[env] auto-commit before merge failed: ${failed.stderr || failed.stdout}`);
                        }
                    }

                    // 2. Check if the branch exists and is already merged into base.
                    // Any git failure that is not a clear "ref missing" or the
                    // documented is-ancestor "no" must fail closed: cleanup
                    // below deletes the worktree and branch.
                    const gitDetail = (result: { stderr?: string; stdout?: string; code: number }) =>
                        (result.stderr || result.stdout || `exit ${result.code}`).trim();
                    const branchExistsResult = await execGit(`rev-parse --verify ${shellQuote(branch)}`);
                    if (branchExistsResult.code !== 0) {
                        // A corrupt existing ref also ends in "Needed a single
                        // revision", preceded by "warning: ignoring broken ref".
                        // Only a stderr made solely of missing-ref fatals proves absence.
                        const stderrLines = (branchExistsResult.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean);
                        const missingRef = branchExistsResult.code === 128
                            && stderrLines.length > 0
                            && stderrLines.every((l) => /^fatal: .*(not a valid|unknown revision|needed a single revision)/i.test(l));
                        if (!missingRef) {
                            return refuseMerge(`[env] could not resolve branch ${branch}; refusing to merge or clean up: ${gitDetail(branchExistsResult)}`);
                        }
                        // Branch doesn't exist — already cleaned up from a previous merge/delete
                        logger.warn(`[sandbox_branch:merge] branch "${branch}" does not exist — treating as already merged`);
                        await cleanupBranchArtifacts(false, "merge");
                        return {
                            content: [{ type: "text", text: JSON.stringify({ merged: true, pushed: false, output: "Branch already deleted (previously merged)" }) }],
                        };
                    }
                    const baseResolved = await execGit(`rev-parse --verify ${shellQuote(`${baseBranch}^{commit}`)}`);
                    if (baseResolved.code !== 0) {
                        return refuseMerge(`[env] base branch ${baseBranch} cannot be resolved; refusing to merge or clean up: ${gitDetail(baseResolved)}`);
                    }
                    // Check if there's anything to merge:
                    // a) branch is already an ancestor of base (already merged)
                    // b) branch and base point to same commit (nothing to merge)
                    // c) branch has no commits beyond base (empty branch after rebase)
                    const mergeBaseResult = await execGit(`merge-base --is-ancestor ${shellQuote(branch)} ${shellQuote(baseBranch)}`);
                    if (mergeBaseResult.code !== 0 && mergeBaseResult.code !== 1) {
                        return refuseMerge(`[env] could not check whether ${branch} is merged into ${baseBranch}; refusing to merge or clean up: ${gitDetail(mergeBaseResult)}`);
                    }
                    const alreadyMerged = mergeBaseResult.code === 0;

                    let nothingToMerge = alreadyMerged;
                    if (!alreadyMerged) {
                        // Check if branch has any commits not in base
                        const aheadResult = await execGit(`rev-list ${shellQuote(`${baseBranch}..${branch}`)} --count`);
                        const aheadText = (aheadResult.stdout || "").trim();
                        if (aheadResult.code !== 0 || !/^\d+$/.test(aheadText)) {
                            return refuseMerge(`[env] could not count commits of ${branch} ahead of ${baseBranch}; refusing to merge or clean up: ${aheadResult.code !== 0 ? gitDetail(aheadResult) : `unexpected output "${aheadText}"`}`);
                        }
                        const aheadCount = parseInt(aheadText, 10);
                        logger.debug({ aheadCount, alreadyMerged }, "[sandbox_branch:merge] ahead count");
                        if (aheadCount === 0) {
                            nothingToMerge = true;
                        }
                    } else {
                        logger.debug({ branch, baseBranch }, "[sandbox_branch:merge] branch already merged, skipping");
                    }

                    // Refuse a dirty primary checkout before any linked
                    // repository hook is allowed to merge. Rechecking inside
                    // mergeIntoCleanDefaultCheckout still protects the narrow
                    // race between preflight and the actual primary merge.
                    const primaryStatus = await execGit("status --porcelain");
                    if (primaryStatus.code !== 0 || (primaryStatus.stdout || "").trim()) {
                        return refuseMerge(primaryStatus.code !== 0
                            ? `[env] could not inspect the default checkout before linked-repository merge: ${primaryStatus.stderr || primaryStatus.stdout}`
                            : "[env] default checkout is dirty; linked-repository merge was not attempted.");
                    }

                    if (!nothingToMerge) {
                        // Preflight the primary repository without mutating its
                        // default checkout. Linked-repository merge hooks run
                        // only after this confirms the primary merge is viable.
                        const primaryPreflight = await execGit(`merge-tree --write-tree ${shellQuote(baseBranch)} ${shellQuote(branch)}`);
                        if (primaryPreflight.code !== 0) {
                            const out = primaryPreflight.stderr || primaryPreflight.stdout;
                            return refuseMerge(out || "CONFLICT (primary): merge preflight failed");
                        }
                    }

                    // Linked repositories can contain the task's only changes,
                    // so their hooks must run even when the primary branch has
                    // no commits beyond base.
                    await runAuthoritativeHook("worktree-pre-merge.sh", "pre_merge");
                    const nestedMerge = await runAuthoritativeHook("worktree-merge.sh", "merge");
                    const nestedRepositories = hookRepositories(nestedMerge.data);

                    if (!nothingToMerge) {
                        // 3. The default checkout belongs to users and chat agents.
                        //    Refuse a dirty checkout before checkout/merge mutates it;
                        //    the caller can retry after committing or manually stashing.
                        const defaultMerge = await mergeIntoCleanDefaultCheckout({ branch, baseBranch, execGit });
                        if (!defaultMerge.merged) {
                            logger.warn(
                                { branch, output: defaultMerge.output.trim().slice(0, 2000) },
                                "[sandbox_branch:merge] default-checkout merge rejected or failed",
                            );
                            const partialOutput = nestedMerge.present
                                ? `[partial] linked repositories merged before primary merge failed: ${defaultMerge.output}`
                                : defaultMerge.output;
                            const publicNestedRepositories = nestedRepositories.map(
                                ({ localRepo: _localRepo, ...repository }) => repository,
                            );
                            return {
                                content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        ...defaultMerge,
                                        output: partialOutput,
                                        repositories: publicNestedRepositories,
                                    }),
                                }],
                                isError: true,
                            };
                        }
                        logger.info(`[sandbox_branch:merge] merged successfully`);
                        if (nestedMerge.present && nestedMerge.output) {
                            logger.info(
                                { branch, nested: nestedMerge.data ?? nestedMerge.output.slice(-2000) },
                                "[sandbox_branch:merge] linked repositories merged",
                            );
                        }
                    }

                    // A branch-mode commit may have checked out the task
                    // branch in the repository root. The normal merge path
                    // checks out base inside mergeIntoCleanDefaultCheckout;
                    // the already-merged path must do so explicitly before
                    // deleting the task branch.
                    if (!usesWorktree && nothingToMerge) {
                        const checkoutBase = await execGit(`checkout ${shellQuote(baseBranch)}`);
                        if (checkoutBase.code !== 0) {
                            return refuseMerge(`[env] failed to checkout ${baseBranch} before branch cleanup: ${checkoutBase.stderr || checkoutBase.stdout}`);
                        }
                    }

                    // 4. Clean up only task-worktree artifacts. Default-checkout
                    // preservation is complete before this independent phase starts.
                    try {
                        await cleanupBranchArtifacts(true, "merge");
                    } catch (cleanupError) {
                        logger.warn(`[sandbox_branch:merge] merge succeeded but task cleanup failed: ${cleanupError}`);
                        return {
                            content: [{ type: "text", text: JSON.stringify({
                                merged: true,
                                pushed: false,
                                output: `Merged, but task worktree cleanup failed: ${cleanupError}`,
                            }) }],
                            isError: true,
                        };
                    }
                    logger.info(`[sandbox_branch:merge] worktree+branch cleaned up`);

                    // 5. Push if requested
                    let pushed = false;
                    if (autoPush) {
                        const sshKeysPath = stackEnv.SSH_KEYS_FOLDER || process.env.SSH_KEYS_FOLDER || null;
                        if (sshKeysPath) {
                            try {
                                const pushResult = await execRemoteGit(["push", "origin", baseBranch], {
                                    repoPath: localRepo || await resolveHostRepoPath(stackPath, svcName, projectName, stackEnv.LOCAL_REPO || `${projectName}_workspace`),
                                    repoSubpath: hostRepo.subpath,
                                    sshKeysPath,
                                    onLog: sendLog,
                                    remoteUrl,
                                    projectName,
                                });
                                pushed = pushResult.code === 0;
                                logger.info(`[sandbox_branch:merge] push=${pushed}`);
                            } catch (pushErr) {
                                logger.warn(`[sandbox_branch:merge] push failed: ${pushErr}`);
                            }
                            for (const repository of nestedRepositories) {
                                await pushLinkedRepository(repository, baseBranch, sshKeysPath, sendLog);
                            }
                        } else {
                            logger.info(`[sandbox_branch:merge] SSH_KEYS_FOLDER not set, skipping push`);
                        }
                    }

                    const publicRepositories = nestedRepositories.map(({ localRepo: _localRepo, ...repository }) => repository);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                merged: true,
                                pushed,
                                output: alreadyMerged ? "Already merged" : "Merged",
                                repositories: publicRepositories,
                            }),
                        }],
                    };
                } catch (error) {
                    logger.error(`[sandbox_branch:merge] EXCEPTION: ${error}`);
                    // mergeIntoCleanDefaultCheckout owns aborting merge state that it
                    // started. An unconditional abort here could destroy a user's
                    // pre-existing conflict resolution when an earlier command throws.
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                            merged: false,
                            pushed: false,
                            output: `[env] merge failed unexpectedly: ${error}`,
                        }) }],
                        isError: true,
                    };
                }
            }

            return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
        }
    );

    // sandbox_issues - Read GitLab/GitHub issues via ephemeral container
    if (process.env.ENABLE_GIT_ISSUES) tool(
        "sandbox_issues",
        "Read GitLab or GitHub issues for the project with the account the relay serves to its agent container for the repository's server. Runs in a temporary container — API tokens never enter the sandbox.",
        {
            name: z.string().describe("Name of the sandbox or instance"),
            action: z.enum(["list", "get", "list_comments"])
                .describe("The issue operation to perform"),
            instance: z.string().optional().describe("Instance ID if running multiple copies"),
            service: z.string().optional().describe("Agent service whose relay client selects the account (default: agent)"),
            git_repo: z.string().describe("Git remote URL of the GitLab or GitHub repository"),
            issue_number: z.number().optional().describe("Issue number (required for get/list_comments)"),
            state: z.string().optional().describe("Filter by state: open, closed, all (for list, default: open)"),
            page: z.number().optional().describe("Page number for list pagination (default: 1)"),
            per_page: z.number().optional().describe("Results per page for list (default: 20, max: 100)"),
        },
        async (args) => {
            const { name, instance, service, git_repo, ...issueArgs } = args as {
                name: string;
                instance?: string;
                service?: string;
                git_repo: string;
                action: IssueParams["action"];
                issue_number?: number;
                state?: string;
                page?: number;
                per_page?: number;
            };

            const { stackPath, projectName } = await resolveStackAndProject(name, instance);
            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            const repository = parseGitRepository(git_repo);
            if ("error" in repository) {
                return { content: [{ type: "text", text: repository.error }], isError: true };
            }
            let config: ReturnType<typeof issueConfigFor>;
            let accountLabel: string;
            try {
                const hostnames = await resolveAgentRelayHostnames(stackPath, projectName, service || "agent");
                const account = configuredProviderAccounts().codeHostAccountFor(hostnames, repository.host);
                accountLabel = `${account.provider === "github" ? "GitHub" : "GitLab"} account ${account.label}`;
                config = issueConfigFor(git_repo, account);
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Issue account unavailable: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
            if ("error" in config) {
                return {
                    content: [{ type: "text", text: config.error }],
                    isError: true,
                };
            }

            const params: IssueParams = issueArgs;
            const validationError = validateParams(params);
            if (validationError) {
                return {
                    content: [{ type: "text", text: validationError }],
                    isError: true,
                };
            }

            const curlCmd = buildCurlCommand(config, params);

            // Write token to a temp env-file to avoid exposing it in `docker inspect` / `ps aux`
            const envFile = path.join(tmpdir(), `carapa-issue-${crypto.randomUUID()}.env`);
            await fsp.writeFile(envFile, `ISSUE_TOKEN=${config.token}\n`, { mode: 0o600 });

            try {
                const result = await execDockerRun([
                    "--env-file", envFile,
                    "--entrypoint", "sh",
                    "curlimages/curl:latest",
                    "-c",
                    curlCmd,
                ], {
                    onLog: sendLog,
                });

                const output = result.stdout || result.stderr || "(no output)";
                const parsed = parseCurlResponse(output);

                if (parsed.isError) {
                    return {
                        content: [{ type: "text", text: parsed.statusCode === 0 ? `Invalid API response (no HTTP status):\n${parsed.body}` : `API error (HTTP ${parsed.statusCode}) with ${accountLabel}:\n${parsed.body}` }],
                        isError: true,
                    };
                }

                return {
                    content: [{ type: "text", text: parsed.body || "(empty response)" }],
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Issue operation failed: ${error}` }],
                    isError: true,
                };
            } finally {
                await fsp.unlink(envFile).catch(() => { });
            }
        }
    );

    // sandbox_logs - Get logs from a service
    tool(
        "sandbox_logs",
        "Retrieve logs from a specific service in the sandbox. If the stack has only one service, service can be omitted.",
        SandboxLogsSchema,
        async (args): Promise<ToolResult> => {
            const { name, service: serviceArg, tail, instance } = args as { name: string; service?: string; tail?: number; instance?: string };
            const { stackPath, projectName } = await resolveStackAndProject(name, instance);

            if (!stackPath) {
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            let service = serviceArg;
            if (!service) {
                const configResult = await getStackServices(stackPath, projectName);
                const services = splitDockerOutput(configResult.stdout);
                if (services.length === 0) {
                    return {
                        content: [{ type: "text", text: "No services defined in stack." }],
                        isError: true,
                    };
                }
                if (services.length > 1) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Stack has multiple services. Specify one: ${services.join(", ")}`,
                            },
                        ],
                        isError: true,
                    };
                }
                service = services[0];
            }

            const result = await getServiceLogs(stackPath, service, tail, projectName);
            return {
                content: [
                    {
                        type: "text",
                        text: result.stdout || result.stderr || "(no logs)",
                    },
                ],
            };
        }
    );

    // --- build_service tool ---
    tool(
        "build_service",
        "Build the Docker image for a managed service. Tags current :latest as :rollback, then runs docker build. Services configured with build: host-request are queued for the host build runner instead; the JSON response has status \"queued\" and a requestedAt to pass to build_service_status. Restart is handled externally (e.g. image watcher sidecar).",
        {
            name: z.string().describe("Service name as registered in config/managed-services.yaml (e.g. 'carapa-brain')"),
        },
        async (args): Promise<ToolResult> => {
            const { name } = args as { name: string };
            logger.info(`[build_service] called with name="${name}"`);
            const loaded = await tryLoadManagedServices();
            if ("error" in loaded) return loaded.error;
            const services = loaded.services;
            logger.debug(`[build_service] loaded services: ${JSON.stringify(Object.keys(services))}`);
            const config = services[name];
            if (!config) {
                logger.warn(`[build_service] unknown service "${name}"`);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unknown managed service "${name}". Available: ${Object.keys(services).join(", ") || "(none)"}`,
                        },
                    ],
                    isError: true,
                };
            }
            logger.debug({ name, config }, "[build_service] config");

            if (config.build === "host-request") {
                try {
                    const request = await requestHostBuild(getStateDir(), name);
                    logger.info({ name, requestId: request.requestId }, "[build_service] queued host build");
                    return {
                        content: [{ type: "text", text: JSON.stringify({ status: "queued", ...request }) }],
                    };
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    logger.error({ name, error: errMsg }, "[build_service] host build request failed");
                    return {
                        content: [{ type: "text", text: `Build ${name}: could not queue host build: ${errMsg}` }],
                        isError: true,
                    };
                }
            }

            try {
                const result = await buildService(config, (msg) => {
                    logger.debug({ name }, `[build_service] log: ${msg.trim()}`);
                });
                if (result.ok) {
                    logger.info({ name }, "[build_service] succeeded");
                } else {
                    // Bound failure detail; the tool response retains the full output.
                    const outputTail = result.output.trimEnd().slice(-2000).split("\n").slice(-10).join("\n");
                    logger.error({ name, outputTail }, "[build_service] failed");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `Build ${name}: ${result.ok ? "SUCCESS" : "FAILED"}\n\n${result.output}`,
                        },
                    ],
                    isError: !result.ok,
                };
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error({ name, error: errMsg }, "[build_service] exception");
                return {
                    content: [{ type: "text", text: `Build ${name} threw: ${errMsg}` }],
                    isError: true,
                };
            }
        }
    );

    tool(
        "build_service_status",
        "Report a queued host build: pending, running, succeeded, failed (with exit code and log tail) or unknown (status file unreadable, with error).",
        {
            name: z.string().describe("Service name as registered in config/managed-services.yaml"),
            requestedAt: z.string().describe("requestedAt returned by build_service"),
        },
        async (args): Promise<ToolResult> => {
            const { name, requestedAt } = args as { name: string; requestedAt: string };
            const loaded = await tryLoadManagedServices();
            if ("error" in loaded) return loaded.error;
            const services = loaded.services;
            if (services[name]?.build !== "host-request") {
                return {
                    content: [{ type: "text", text: `"${name}" is not a host-request managed service` }],
                    isError: true,
                };
            }
            const status = await getHostBuildStatus(getStateDir(), name, requestedAt);
            return { content: [{ type: "text", text: JSON.stringify(status) }] };
        }
    );

    tool(
        "restart_service",
        "Force-recreate a managed Docker Compose service from its current image.",
        {
            name: z.string().describe("Service name as registered in config/managed-services.yaml"),
        },
        async (args): Promise<ToolResult> => {
            const { name } = args as { name: string };
            logger.info(`[restart_service] called with name="${name}"`);
            const loaded = await tryLoadManagedServices();
            if ("error" in loaded) return loaded.error;
            const services = loaded.services;
            const config = services[name];
            if (!config) {
                return {
                    content: [{
                        type: "text",
                        text: `Unknown managed service "${name}". Available: ${Object.keys(services).join(", ") || "(none)"}`,
                    }],
                    isError: true,
                };
            }

            try {
                const result = await restartService(config, (msg) => {
                    logger.info(`[restart_service] log: ${msg.trim()}`);
                });
                logger.info(`[restart_service] result: ok=${result.ok}`);
                return {
                    content: [{
                        type: "text",
                        text: `Restart ${name}: ${result.ok ? "SUCCESS" : "FAILED"}\n\n${result.output}`,
                    }],
                    isError: !result.ok,
                };
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error(`[restart_service] EXCEPTION: ${errMsg}`);
                return {
                    content: [{ type: "text", text: `Restart ${name} threw: ${errMsg}` }],
                    isError: true,
                };
            }
        }
    );

    // --- sandbox_commands tool ---
    tool(
        "sandbox_commands",
        "List available slash commands (skills + commands) from a running sandbox container.",
        {
            name: z.string().describe("Stack name"),
            service: z.string().optional().describe("Service name (default: 'agent')"),
            instance: z.string().optional().describe("Instance identifier"),
        },
        async (args): Promise<ToolResult> => {
            const { name, service: serviceArg, instance } = args as { name: string; service?: string; instance?: string };
            logger.info(`[sandbox_commands] called: name="${name}" service="${serviceArg ?? "(default:agent)"}" instance="${instance ?? ""}"`);

            const { stackPath, projectName } = await resolveStackAndProject(name, instance);
            logger.info(`[sandbox_commands] resolved: stackPath="${stackPath}" projectName="${projectName}"`);

            if (!stackPath) {
                logger.warn(`[sandbox_commands] stack not found: ${name}`);
                return {
                    content: [{ type: "text", text: `Stack or instance not found: ${name}` }],
                    isError: true,
                };
            }

            const service = serviceArg ?? "agent";
            logger.info(`[sandbox_commands] exec in service="${service}" stackPath="${stackPath}"`);

            const script = SLASH_COMMANDS_SCRIPT;

            let result = await execInService(stackPath, service, script, projectName);

            logger.info(`[sandbox_commands] exec done: code=${result.code} stdout=${JSON.stringify(result.stdout.slice(0, 200))} stderr=${JSON.stringify(result.stderr.slice(0, 200))}`);

            // Non-zero exit most commonly means the board sent a hardcoded service
            // name (e.g. "agent") that doesn't exist in this stack.  Fall back by
            // enumerating the stack's actual services and trying each one in order.
            if (result.code !== 0) {
                logger.warn(`[sandbox_commands] service "${service}" failed — enumerating stack services to retry`);
                const servicesResult = await getStackServices(stackPath, projectName);
                const candidates = splitDockerOutput(servicesResult.stdout).filter((s) => s !== service);
                logger.info(`[sandbox_commands] candidate services: ${JSON.stringify(candidates)}`);
                for (const svc of candidates) {
                    const r = await execInService(stackPath, svc, script, projectName);
                    logger.info(`[sandbox_commands] tried service="${svc}" code=${r.code} stderr=${JSON.stringify(r.stderr.slice(0, 100))}`);
                    if (r.code === 0) {
                        result = r;
                        break;
                    }
                }
                if (result.code !== 0) {
                    logger.warn(`[sandbox_commands] all services failed, returning []`);
                    return {
                        content: [{ type: "text", text: "[]" }],
                    };
                }
            }

            const output = JSON.stringify(parseSlashCommands(result.stdout));
            logger.info(`[sandbox_commands] returning ${output.length} bytes of JSON`);

            return {
                content: [{ type: "text", text: output }],
            };
        }
    );
}
