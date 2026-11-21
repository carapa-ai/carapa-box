import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

export type GitCommandResult = { code: number; stdout: string; stderr: string };

const USER = "[A-Za-z0-9_][A-Za-z0-9._-]*";
const HOST = "(?:[A-Za-z0-9][A-Za-z0-9.-]*|\\[[0-9A-Fa-f:.]+\\])";
const SCP_URL = new RegExp(`^${USER}@${HOST}:[^\\s]+$`);
const SSH_URL = new RegExp(`^ssh://(?:${USER}@)?${HOST}(?::\\d{1,5})?/[^\\s]*$`);

/** Returns a reason when `url` is not an acceptable pinned SSH remote, else null. */
export function validateRemoteUrl(url: unknown): string | null {
    if (typeof url !== "string" || url.length === 0) return "remoteUrl must be a non-empty string";
    if (url.length > 2048) return "remoteUrl is too long";
    // eslint-disable-next-line no-control-regex
    if (/[\s\x00-\x1f\x7f]/.test(url)) return "remoteUrl must not contain whitespace or control characters";
    if (url.startsWith("-")) return "remoteUrl must not start with '-'";
    if (/(^|[^a-z0-9])(ext|fd)::/i.test(url)) return "remoteUrl must not use the ext::/fd:: transports";
    if (!SCP_URL.test(url) && !SSH_URL.test(url)) {
        return "remoteUrl must be an SSH remote (git@host:path or ssh://[user@]host[:port]/path)";
    }
    return null;
}

export function remotePinRequired(): boolean {
    return process.env.GIT_REMOTE_PIN_REQUIRED === "true";
}

const REMOTE_NOT_PINNED_ERROR =
    "[SECURITY] remote URL not pinned: pass remoteUrl (SSH) for remote git operations (GIT_REMOTE_PIN_REQUIRED=true)";

/** Decide whether a keyed remote op may run, and against which pinned URL. */
export function resolveRemotePin(
    remoteUrl: string | undefined,
    projectName: string | undefined,
): { ok: true; remoteUrl?: string } | { ok: false; error: string } {
    if (remoteUrl !== undefined && remoteUrl !== "") {
        const reason = validateRemoteUrl(remoteUrl);
        return reason ? { ok: false, error: `Invalid remoteUrl: ${reason}` } : { ok: true, remoteUrl };
    }
    if (remotePinRequired()) return { ok: false, error: REMOTE_NOT_PINNED_ERROR };
    logger.warn({ project: projectName }, "[git] unpinned remote");
    return { ok: true };
}

/** Env shared by every git container the box starts for remote operations. */
export function gitHardeningEnvArgs(
    overrides: ReadonlyArray<readonly [string, string]>,
    allowProtocol: string,
): string[] {
    return [
        "-e", "HOME=/tmp",
        "-e", `GIT_ALLOW_PROTOCOL=${allowProtocol}`,
        "-e", "GIT_CONFIG_NOSYSTEM=1",
        "-e", "GIT_EDITOR=:",
        "-e", "GIT_SEQUENCE_EDITOR=:",
        "-e", "GIT_TERMINAL_PROMPT=0",
        ...overrides.flatMap(([key, value], i) => [
            "-e", `GIT_CONFIG_KEY_${i}=${key}`,
            "-e", `GIT_CONFIG_VALUE_${i}=${value}`,
        ]),
        "-e", `GIT_CONFIG_COUNT=${overrides.length}`,
    ];
}

const STAGE_REPO = "/stage/repo";

/**
 * Run in the keyed container before git: the keyless step runs inside the
 * agent-controlled repo config and may have written to the staging repo, so
 * everything git would trust there (config, hooks, redirections) is replaced
 * with box-written content. Fails closed if /stage/repo is not a plain directory.
 */
export const STAGE_SANITIZE_SCRIPT =
    ` [ -d ${STAGE_REPO} ] && [ ! -L ${STAGE_REPO} ] || { echo "[SECURITY] invalid staging repo" >&2; exit 1; };` +
    ` rm -rf ${STAGE_REPO}/config ${STAGE_REPO}/config.worktree ${STAGE_REPO}/hooks ${STAGE_REPO}/commondir ${STAGE_REPO}/gitdir ${STAGE_REPO}/objects/info/alternates ${STAGE_REPO}/info/grafts ${STAGE_REPO}/shallow;` +
    ` printf '[core]\n\trepositoryformatversion = 0\n\tbare = true\n' > ${STAGE_REPO}/config;`;

// Box-set so repo config (remote.<url>.receivepack/uploadpack) cannot pick a program for the keyless stage transfers.
const RECEIVE_PACK = "--receive-pack=git-receive-pack";
const UPLOAD_PACK = "--upload-pack=git-upload-pack";
const GIT_IMAGE = "carapa/git-ssh";

// ── argv planning ────────────────────────────────────────────────────────────

const FETCH_FLAGS = new Set(["-p", "--prune", "-t", "--tags", "--no-tags", "-f", "--force", "-q", "--quiet", "-v", "--verbose", "--prune-tags", "--unshallow"]);
const PUSH_FLAGS = new Set(["-f", "--force", "-n", "--dry-run", "-q", "--quiet", "-v", "--verbose", "--no-verify", "-u", "--set-upstream", "-d", "--delete", "--tags"]);
const LS_REMOTE_FLAGS = new Set(["--heads", "--tags", "--refs", "-q", "--quiet"]);
const CLONE_FLAGS = new Set(["-q", "--quiet"]);

export type PinnedPlan =
    | { kind: "fetch"; flags: string[]; stageSpecs: string[]; localSpecs: string[] }
    | { kind: "push"; flags: string[]; pushes: Array<{ src: string; dst: string; force: boolean }>; deleting: string[]; tags: boolean; upstream: Array<{ local: string; remote: string }> }
    | { kind: "ls-remote"; flags: string[]; patterns: string[] }
    | { kind: "clone"; flags: string[]; dir?: string }
    | { kind: "local"; argv: string[] };

function parseFlags(tokens: string[], allowed: Set<string>, sub: string): { flags: string[]; positional: string[] } | string {
    const flags: string[] = [];
    const positional: string[] = [];
    let rest = false;
    for (const tok of tokens) {
        if (rest) { positional.push(tok); continue; }
        if (tok === "--") { rest = true; continue; }
        if (!tok.startsWith("-")) { positional.push(tok); continue; }
        if (allowed.has(tok) || (sub === "fetch" && /^--(depth|deepen)=\d+$/.test(tok))) { flags.push(tok); continue; }
        return `Option "${tok}" is not supported by git ${sub} with a pinned remoteUrl`;
    }
    return { flags, positional };
}

/** The first positional is the remote: it must be `origin` or the pinned URL itself. */
function checkRemote(remote: string | undefined, pinnedUrl: string, allowOnlyUrl = false): string | null {
    if (remote === undefined) return `A remote is required: use 'origin' or ${pinnedUrl}`;
    if (remote === pinnedUrl || (!allowOnlyUrl && remote === "origin")) return null;
    return `[SECURITY] Remote "${remote}" does not match the pinned remoteUrl; only 'origin' or the pinned URL is allowed`;
}

function shortRef(ref: string): string {
    return ref.replace(/^refs\/heads\//, "");
}

/** Turn a git fetch/push refspec side into a fully qualified local branch/tag/ref name. */
function qualify(ref: string): string {
    return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

// eslint-disable-next-line no-control-regex
const SAFE_REFSPEC = /^\+?[^\s:~^?[\\\x00-\x1f\x7f-][^\s~^?[\\\x00-\x1f\x7f]*(?::[^\s:~^?[\\\x00-\x1f\x7f]+)?$/;

function checkRefspec(spec: string): string | null {
    return SAFE_REFSPEC.test(spec) ? null : `Unsupported refspec "${spec}"`;
}

export function planPinnedRemoteGit(argv: string[], pinnedUrl: string): PinnedPlan | { error: string } {
    if (argv.length === 0 || argv[0].startsWith("-")) return { error: "Global git options are not supported with a pinned remoteUrl" };
    const sub = argv[0];
    const rest = argv.slice(1);

    if (sub === "fetch") {
        const parsed = parseFlags(rest, FETCH_FLAGS, "fetch");
        if (typeof parsed === "string") return { error: parsed };
        const [remote, ...specs] = parsed.positional;
        const bad = checkRemote(remote ?? "origin", pinnedUrl);
        if (bad) return { error: bad };
        if (specs.length === 0) {
            return {
                kind: "fetch", flags: parsed.flags,
                stageSpecs: ["+refs/heads/*:refs/stage/heads/*", "+refs/tags/*:refs/tags/*"],
                localSpecs: ["+refs/stage/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"],
            };
        }
        const stageSpecs: string[] = [];
        const localSpecs: string[] = [];
        for (const [i, spec] of specs.entries()) {
            const refErr = checkRefspec(spec);
            if (refErr) return { error: refErr };
            const force = spec.startsWith("+");
            const [src, dst] = spec.replace(/^\+/, "").split(":");
            if (!src) return { error: `Unsupported refspec "${spec}"` };
            stageSpecs.push(`+${qualifyLocal(src)}:refs/stage/${i}`);
            const isTag = src.startsWith("refs/tags/");
            const localDst = dst ?? (isTag ? src : `refs/remotes/origin/${shortRef(src)}`);
            localSpecs.push(`${force || !dst ? "+" : ""}refs/stage/${i}:${qualify(localDst)}`);
        }
        return { kind: "fetch", flags: parsed.flags, stageSpecs, localSpecs };
    }

    if (sub === "push") {
        const parsed = parseFlags(rest, PUSH_FLAGS, "push");
        if (typeof parsed === "string") return { error: parsed };
        const [remote, ...specs] = parsed.positional;
        const bad = checkRemote(remote, pinnedUrl);
        if (bad) return { error: bad };
        const tags = parsed.flags.includes("--tags");
        const deleting = parsed.flags.includes("-d") || parsed.flags.includes("--delete");
        if (specs.length === 0 && !tags) return { error: "Specify a refspec to push, e.g. 'push origin <branch>', with a pinned remoteUrl" };
        const pushes: Array<{ src: string; dst: string; force: boolean }> = [];
        const del: string[] = [];
        const upstream: Array<{ local: string; remote: string }> = [];
        for (const spec of specs) {
            const refErr = checkRefspec(spec);
            if (refErr) return { error: refErr };
            const [src, dst] = spec.replace(/^\+/, "").split(":");
            if (deleting) { del.push(qualify(src)); continue; }
            if (src === "HEAD" && !dst) {
                return { error: "Pushing a bare HEAD is not supported with a pinned remoteUrl: use 'HEAD:<branch>' or name the branch" };
            }
            if (!src) return { error: `Use --delete instead of ':ref' ("${spec}") with a pinned remoteUrl` };
            if (src.includes("*") || (dst ?? "").includes("*")) return { error: `Glob refspec "${spec}" is not supported for push with a pinned remoteUrl` };
            pushes.push({ src: qualifyLocal(src), dst: qualify(dst ?? src), force: spec.startsWith("+") });
            // Upstream config belongs to the local source branch (HEAD is resolved at run time), tracking the pushed branch.
            const localRef = qualifyLocal(src);
            const remoteRef = qualify(dst ?? src);
            if ((localRef === "HEAD" || localRef.startsWith("refs/heads/")) && remoteRef.startsWith("refs/heads/")) {
                upstream.push({ local: shortRef(localRef), remote: remoteRef });
            }
        }
        const flags = parsed.flags.filter((f) => f !== "-u" && f !== "--set-upstream" && f !== "-d" && f !== "--delete" && f !== "--tags");
        return {
            kind: "push", flags, pushes, deleting: del, tags,
            upstream: parsed.flags.includes("-u") || parsed.flags.includes("--set-upstream") ? upstream : [],
        };
    }

    if (sub === "ls-remote") {
        const parsed = parseFlags(rest, LS_REMOTE_FLAGS, "ls-remote");
        if (typeof parsed === "string") return { error: parsed };
        const [remote, ...patterns] = parsed.positional;
        const bad = checkRemote(remote, pinnedUrl);
        if (bad) return { error: bad };
        return { kind: "ls-remote", flags: parsed.flags, patterns };
    }

    if (sub === "clone") {
        const parsed = parseFlags(rest, CLONE_FLAGS, "clone");
        if (typeof parsed === "string") return { error: parsed };
        const [url, dir, ...extra] = parsed.positional;
        const bad = checkRemote(url, pinnedUrl, true);
        if (bad) return { error: bad };
        if (extra.length > 0 || (dir !== undefined && (dir.startsWith("-") || dir.split("/").includes("..")))) {
            return { error: "Unsupported clone destination" };
        }
        return { kind: "clone", flags: parsed.flags, dir };
    }

    if (sub === "remote") {
        // `git remote` is configuration/listing only here; it never gets keys or network.
        return { kind: "local", argv };
    }

    return { error: `git ${sub} is not a remote operation` };
}

function qualifyLocal(src: string): string {
    return src === "HEAD" ? "HEAD" : qualify(src);
}

// ── docker args ──────────────────────────────────────────────────────────────

/** Mount args for the agent repo at /workspace; a volume subpath keeps sibling repos in the volume unexposed. */
export function workspaceMountArgs(opts: { repoPath: string; repoSubpath?: string }): string[] {
    if (opts.repoSubpath && opts.repoSubpath !== ".") {
        return ["--mount", `type=volume,src=${opts.repoPath},dst=/workspace,volume-subpath=${opts.repoSubpath},volume-nocopy`];
    }
    return ["-v", `${opts.repoPath}:/workspace`];
}

/** Keyless container with the agent repo, no network, no keys. */
export function buildKeylessGitDockerArgs(
    argv: string[],
    opts: { repoPath: string; repoSubpath?: string; stageVolume?: string },
    overrides: ReadonlyArray<readonly [string, string]>,
): string[] {
    const withSafe: Array<readonly [string, string]> = [...overrides, ["safe.directory", "*"]];
    return [
        ...workspaceMountArgs(opts),
        ...(opts.stageVolume ? ["-v", `${opts.stageVolume}:/stage`] : []),
        "-w", "/workspace",
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", "1000:1000",
        ...gitHardeningEnvArgs(withSafe, "file"),
        "--entrypoint", "git",
        GIT_IMAGE, ...argv,
    ];
}

function buildStageInitDockerArgs(stageVolume: string): string[] {
    return [
        "-v", `${stageVolume}:/stage`,
        "--network", "none",
        "--cap-drop", "ALL", "--cap-add", "CHOWN",
        "--security-opt", "no-new-privileges",
        "--user", "0:0",
        "-e", "HOME=/tmp", "-e", "GIT_CONFIG_NOSYSTEM=1",
        "--entrypoint", "sh",
        GIT_IMAGE, "-c", `git init --bare -q --template= ${STAGE_REPO} && chown -R 1000:1000 /stage`,
    ];
}

// ── execution ────────────────────────────────────────────────────────────────

export type PinnedDeps = {
    dockerRun: (args: string[], options?: { onLog?: (chunk: string) => void }) => Promise<GitCommandResult>;
    docker: (args: string[]) => Promise<unknown>;
    /** Keyed container args: (mounts, workdir, git argv). Built by the caller to share env hardening. */
    keyedArgs: (mounts: string[], workdir: string, argv: string[]) => string[];
    overrides: ReadonlyArray<readonly [string, string]>;
};

/**
 * Default branch from `ls-remote --symref <url> HEAD` output ("ref: refs/heads/<name>\tHEAD").
 * The name comes from the remote, so only conservative branch names are accepted.
 */
export function parseRemoteDefaultBranch(lsRemoteOutput: string): string | undefined {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(lsRemoteOutput);
    const name = match?.[1];
    return name && /^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock") ? name : undefined;
}

function join(...results: GitCommandResult[]): GitCommandResult {
    return {
        code: results.find((r) => r.code !== 0)?.code ?? 0,
        stdout: results.map((r) => r.stdout).filter(Boolean).join("\n"),
        stderr: results.map((r) => r.stderr).filter(Boolean).join("\n"),
    };
}

/**
 * Run a remote git operation against `pinnedUrl` through a box-owned staging
 * repo. The keyed container never mounts the agent repo; a keyless, network-less
 * container moves objects between the agent repo and the staging repo.
 */
export async function runPinnedRemoteGit(
    argv: string[],
    pinnedUrl: string,
    opts: { repoPath: string; repoSubpath?: string; sshKeysPath: string; onLog?: (chunk: string) => void },
    deps: PinnedDeps,
): Promise<GitCommandResult> {
    const plan = planPinnedRemoteGit(argv, pinnedUrl);
    if ("error" in plan) throw new Error(plan.error);
    const logOpts = { onLog: opts.onLog };
    const keyless = (gitArgv: string[], stageVolume?: string) =>
        deps.dockerRun(buildKeylessGitDockerArgs(gitArgv, { repoPath: opts.repoPath, repoSubpath: opts.repoSubpath, stageVolume }, deps.overrides), logOpts);

    if (plan.kind === "local") return keyless(plan.argv);

    if (plan.kind === "ls-remote") {
        return deps.dockerRun(deps.keyedArgs([], "/tmp", ["ls-remote", ...plan.flags, pinnedUrl, ...plan.patterns]), logOpts);
    }

    const stageVolume = `carapa-gitstage-${randomUUID()}`;
    const stageMount = ["-v", `${stageVolume}:/stage`];
    const keyed = (gitArgv: string[]) => deps.dockerRun(deps.keyedArgs(stageMount, STAGE_REPO, gitArgv), logOpts);
    try {
        await deps.dockerRun(buildStageInitDockerArgs(stageVolume), logOpts);

        if (plan.kind === "fetch") {
            const fetched = await keyed(["fetch", ...plan.flags, "--no-write-fetch-head", pinnedUrl, ...plan.stageSpecs]);
            const local = await keyless(["fetch", "--no-tags", UPLOAD_PACK, "file:///stage/repo", ...plan.localSpecs], stageVolume);
            return join(fetched, local);
        }

        if (plan.kind === "clone") {
            const fetched = await keyed(["fetch", ...plan.flags, "--no-write-fetch-head", pinnedUrl, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
            // A failed fetch leaves the stage empty; cloning it would create an empty directory that blocks the retry.
            if (fetched.code !== 0) return fetched;
            const dir = plan.dir ?? "";
            // The stage HEAD is unborn (init default) and fetch copies no HEAD, so name the remote's default branch for the clone.
            const head = await deps.dockerRun(deps.keyedArgs([], "/tmp", ["ls-remote", "--symref", pinnedUrl, "HEAD"]), logOpts);
            const defaultBranch = head.code === 0 ? parseRemoteDefaultBranch(head.stdout) : undefined;
            const cloned = await keyless(["clone", ...plan.flags, ...(defaultBranch ? [`--branch=${defaultBranch}`] : []), "--no-hardlinks", UPLOAD_PACK, "file:///stage/repo", ...(dir ? [dir] : [])], stageVolume);
            const target = dir || "repo";
            const pinned = await keyless(["-C", target, "remote", "set-url", "origin", pinnedUrl]);
            return join(fetched, cloned, pinned);
        }

        // push
        if (plan.deleting.length > 0) {
            return join(await keyed(["push", ...plan.flags, pinnedUrl, "--delete", ...plan.deleting]));
        }
        const results: GitCommandResult[] = [];
        const stageSpecs = plan.pushes.map((p, i) => `+${p.src}:refs/stage/${i}`);
        if (plan.tags) stageSpecs.push("+refs/tags/*:refs/tags/*");
        results.push(await keyless(["push", "--quiet", RECEIVE_PACK, "file:///stage/repo", ...stageSpecs], stageVolume));
        const keyedSpecs = plan.pushes.map((p, i) => `${p.force ? "+" : ""}refs/stage/${i}:${p.dst}`);
        results.push(await keyed(["push", ...plan.flags, ...(plan.tags ? ["--tags"] : []), pinnedUrl, ...keyedSpecs]));
        // Like plain git, set upstream only after a successful push.
        if (results.some((r) => r.code !== 0)) return join(...results);
        for (const { local, remote } of plan.upstream) {
            let branch = local;
            if (local === "HEAD") {
                const head = await keyless(["symbolic-ref", "--short", "-q", "HEAD"]);
                branch = head.code === 0 ? head.stdout.trim() : "";
                if (!branch) continue; // detached HEAD: no branch to configure
            }
            results.push(await keyless(["config", `branch.${branch}.remote`, "origin"]));
            results.push(await keyless(["config", `branch.${branch}.merge`, remote]));
        }
        return join(...results);
    } finally {
        await deps.docker(["volume", "rm", "-f", stageVolume]).catch((err: unknown) => {
            logger.warn({ stageVolume, error: String(err) }, "[git] failed to remove staging volume");
        });
    }
}
