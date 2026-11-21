import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../logger.js";
import type { ServiceInfo } from "./schemas.js";

import {
    branchActionCheckout,
    buildProvisionEnv,
    getPsCached,
    invalidatePsCache,
    commitSandboxBranch,
    findWorktreeAdminDir,
    containerRepoPathFromComposeStatus,
    containerRepoPathFromMounts,
    resolveContainerRepoPath,
    resolveHostRepo,
    withVolumeSubpaths,
    resolveWorkspaceMount,
    displayRepoPath,
    mergeIntoCleanDefaultCheckout,
    parseWorktreeHookData,
    pushLinkedRepository,
    relayTokenHostnames,
    resolveAgentRelayHostnames,
    runBestEffortLifecycleStep,
    isBenignStopError,
    runWorktreeHook,
    runRemoteGitCommand,
    scopeRepositoryCommand,
    strictWorktreeHooksEnabled,
    worktreeListText,
    worktreeSlug,
} from "./register.js";

describe("findWorktreeAdminDir", () => {
    const git = (cwd: string, ...args: string[]) => {
        const r = spawnSync("git", args, { cwd, encoding: "utf8" });
        expect(r.status).toBe(0);
    };
    // Real shell in a temp repo, like execShell (CWD = repo root).
    const shellIn = (cwd: string) => async (cmd: string) => {
        const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
        return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };

    it("finds the admin dir of a slash-named branch (named after the path basename), even after the worktree dir is gone", async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-admin-dir-"));
        try {
            git(repo, "init", "-q");
            git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
            git(repo, "worktree", "add", "-q", ".worktrees/feature/x", "-b", "feature/x");
            git(repo, "worktree", "add", "-q", ".worktrees/other/x", "-b", "other/x");
            const exec = shellIn(repo);

            expect(await findWorktreeAdminDir(exec, ".worktrees/feature/x", "feature/x")).toBe(".git/worktrees/x");
            expect(await findWorktreeAdminDir(exec, ".worktrees/other/x", "other/x")).toBe(".git/worktrees/x1");

            fs.rmSync(path.join(repo, ".worktrees/feature"), { recursive: true });
            expect(await findWorktreeAdminDir(exec, ".worktrees/feature/x", "feature/x")).toBe(".git/worktrees/x");
            expect(await findWorktreeAdminDir(exec, ".worktrees/missing/y", "missing/y")).toBeNull();
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe("worktreeListText", () => {
    it("returns stderr when git fails", () => {
        expect(worktreeListText({ code: 128, stdout: "", stderr: "fatal: not a git repository\n" })).toContain("fatal");
    });
    it("falls back to exit code when failure output is empty", () => {
        expect(worktreeListText({ code: 1, stdout: "", stderr: "" })).toBe("git worktree list failed (exit 1)");
    });
    it("reports no worktrees on empty success", () => {
        expect(worktreeListText({ code: 0, stdout: "", stderr: "" })).toBe("(no worktrees)");
    });
    it("returns porcelain stdout unchanged on success", () => {
        const out = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n";
        expect(worktreeListText({ code: 0, stdout: out, stderr: "" })).toBe(out);
    });
});

describe("remote git failure isolation", () => {
    it("returns a rejected push without pulling, rebasing, or retrying", async () => {
        for (const command of [
            "push origin develop",
            "push -- 'ssh://git@git.example.com:22/team/project.git' 'refs/heads/develop'",
        ]) {
            const commands: string[] = [];
            const result = await runRemoteGitCommand(command, async (requested) => {
                commands.push(requested);
                throw new Error("[rejected] develop -> develop (non-fast-forward)");
            });
            expect(commands).toEqual([command]);
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([{
                type: "text",
                text: "Git operation failed: Error: [rejected] develop -> develop (non-fast-forward)",
            }]);
        }
    });

    it("reports an unsuccessful exit even when the executor does not throw", async () => {
        const commands: string[] = [];
        const result = await runRemoteGitCommand("push origin develop", async (command) => {
            commands.push(command);
            return { code: 1, stdout: "", stderr: "remote: protected branch" };
        });
        expect(commands).toEqual(["push origin develop"]);
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "remote: protected branch" }]);
    });
});

describe("sandbox branch checkout target", () => {
    it("uses the repository root when branch mode omits worktreePath", () => {
        expect(branchActionCheckout()).toEqual({
            checkoutPath: ".",
            gitPrefix: "",
            usesWorktree: false,
        });
    });

    it("uses only an explicitly supplied worktree path", () => {
        expect(branchActionCheckout(".worktrees/task-branch")).toEqual({
            checkoutPath: ".worktrees/task-branch",
            gitPrefix: "-C '.worktrees/task-branch'",
            usesWorktree: true,
        });
    });
});

describe("worktree repository command scope", () => {
    it("runs git and shell commands from a nested repository", () => {
        expect(scopeRepositoryCommand("worktree list --porcelain", "/srv/app/backend", true))
            .toBe("-C '/srv/app/backend' worktree list --porcelain");
        expect(scopeRepositoryCommand("test -d .worktrees/task", "/srv/app/backend", false))
            .toBe("cd '/srv/app/backend' && test -d .worktrees/task");
    });

    it("quotes repository paths and preserves the legacy default directory", () => {
        expect(scopeRepositoryCommand("status", "/var/www/client's/backend", true))
            .toBe("-C '/var/www/client'\"'\"'s/backend' status");
        expect(scopeRepositoryCommand("status", undefined, true)).toBe("status");
    });
});

describe("worktree provisioning env", () => {
    it("adds WT_BRANCH and a DB-safe WT_SLUG", () => {
        const env = buildProvisionEnv({}, "Feature/Provision DB!");

        expect(env.WT_BRANCH).toBe("Feature/Provision DB!");
        expect(env.WT_SLUG).toBe("feature_provision_db");
        expect(worktreeSlug("A".repeat(50))).toHaveLength(40);
    });

    it("forwards only PROVISION_* keys from the stack env", () => {
        const env = buildProvisionEnv({ PROVISION_DB_HOST: "h", OTHER: "x" }, "b");

        expect(env.PROVISION_DB_HOST).toBe("h");
        expect(env.OTHER).toBeUndefined();
    });

    it("ignores PROVISION_* in process.env", () => {
        process.env.PROVISION_DB_PASS = "secret";
        try {
            expect(buildProvisionEnv({}, "b").PROVISION_DB_PASS).toBeUndefined();
        } finally {
            delete process.env.PROVISION_DB_PASS;
        }
    });
});

describe("worktree hook contract", () => {
    it("enables strict hooks only for explicit truthy values", () => {
        expect(strictWorktreeHooksEnabled({ WORKTREE_HOOKS_STRICT: "1" })).toBe(true);
        expect(strictWorktreeHooksEnabled({ WORKTREE_HOOKS_STRICT: "true" })).toBe(true);
        expect(strictWorktreeHooksEnabled({ WORKTREE_HOOKS_STRICT: "off" })).toBe(false);
        expect(strictWorktreeHooksEnabled({})).toBe(false);
    });

    it("parses structured hook data without requiring clean stdout", () => {
        expect(parseWorktreeHookData([
            "hook progress",
            'CARAPA_HOOK_RESULT={"repositories":[{"name":"demo-app/ai"}]}',
            "hook complete",
        ].join("\n"))).toEqual({
            repositories: [{ name: "demo-app/ai" }],
        });
        expect(parseWorktreeHookData("CARAPA_HOOK_RESULT={invalid")).toBeUndefined();
    });

    it("keeps absent hooks optional and makes present strict failures fatal", async () => {
        const execGit = async () => ({ stdout: "/repo\n" });
        const absent = await runWorktreeHook(
            execGit,
            async () => ({ code: 0, stdout: "__WT_HOOK_ABSENT_worktree_inspect_sh__\n", stderr: "" }),
            ".worktrees/task",
            "worktree-inspect.sh",
            { WT_ACTION: "inspect" },
            false,
        );
        expect(absent).toEqual({ present: false, ok: true, output: "" });

        expect(runWorktreeHook(
            execGit,
            async () => ({ code: 7, stdout: "", stderr: "CONFLICT (linked demo-app/ai)" }),
            ".worktrees/task",
            "worktree-pre-merge.sh",
            { WT_ACTION: "pre_merge" },
            true,
        )).rejects.toThrow("CONFLICT (linked demo-app/ai)");
    });
});

type GitResult = { code: number; stdout: string; stderr: string };

function git(repo: string, command: string): GitResult {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const result = spawnSync("sh", ["-c", `git ${command}`], {
        cwd: repo,
        encoding: "utf8",
        env,
    });
    return {
        code: result.status ?? 1,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
    };
}

function expectGit(repo: string, command: string): string {
    const result = git(repo, command);
    expect(result.code, `${command}: ${result.stderr || result.stdout}`).toBe(0);
    return result.stdout.trim();
}

function createMergeRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-default-checkout-"));
    expectGit(repo, "init -b develop");
    expectGit(repo, "config user.name 'Carapa Test'");
    expectGit(repo, "config user.email carapa@ex.test");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    expectGit(repo, "add tracked.txt");
    expectGit(repo, "commit -m base");
    expectGit(repo, "checkout -b task");
    fs.writeFileSync(path.join(repo, "task.txt"), "task branch\n");
    expectGit(repo, "add task.txt");
    expectGit(repo, "commit -m task");
    expectGit(repo, "checkout develop");
    return repo;
}

describe("default checkout merge preservation", () => {
    let repo: string;

    afterEach(() => {
        if (repo) fs.rmSync(repo, { recursive: true, force: true });
    });

    it("merges a task branch when the default checkout is clean", async () => {
        repo = createMergeRepo();

        const result = await mergeIntoCleanDefaultCheckout({
            branch: "task",
            baseBranch: "develop",
            execGit: async (command) => git(repo, command),
        });

        expect(result).toEqual({ merged: true, pushed: false, output: "Merged" });
        expect(fs.readFileSync(path.join(repo, "task.txt"), "utf8")).toBe("task branch\n");
        expect(expectGit(repo, "rev-parse --abbrev-ref HEAD")).toBe("develop");
    });

    it("rejects tracked edits before merge and leaves their bytes unchanged", async () => {
        repo = createMergeRepo();
        const dirtyBytes = Buffer.from([0, 1, 2, 10, 255, 65, 66]);
        fs.writeFileSync(path.join(repo, "tracked.txt"), dirtyBytes);
        const commands: string[] = [];

        const result = await mergeIntoCleanDefaultCheckout({
            branch: "task",
            baseBranch: "develop",
            execGit: async (command) => {
                commands.push(command);
                return git(repo, command);
            },
        });
        const structured = JSON.parse(JSON.stringify(result));

        expect(structured.merged).toBe(false);
        expect(structured.pushed).toBe(false);
        expect(structured.output).toStartWith("[env]");
        expect(structured.output).toContain("Commit or manually stash");
        expect(commands).toEqual(["status --porcelain"]);
        expect(fs.readFileSync(path.join(repo, "tracked.txt"))).toEqual(dirtyBytes);
        expect(expectGit(repo, "rev-parse --abbrev-ref HEAD")).toBe("develop");
    });

    it("merges when the only untracked file is a gitignored audit.jsonl", async () => {
        repo = createMergeRepo();
        fs.copyFileSync(path.join(import.meta.dir, "..", "..", ".gitignore"), path.join(repo, ".gitignore"));
        expectGit(repo, "add .gitignore");
        expectGit(repo, "commit -m ignore");
        fs.writeFileSync(path.join(repo, "audit.jsonl"), "{}\n");
        fs.writeFileSync(path.join(repo, "audit.jsonl.1"), "{}\n");

        const result = await mergeIntoCleanDefaultCheckout({
            branch: "task",
            baseBranch: "develop",
            execGit: async (command) => git(repo, command),
        });

        expect(result).toEqual({ merged: true, pushed: false, output: "Merged" });
    });

    it("rejects an untracked file before merge and leaves it in place", async () => {
        repo = createMergeRepo();
        const untrackedPath = path.join(repo, "chat-notes.txt");
        const contents = "uncommitted user notes\nwith another line\n";
        fs.writeFileSync(untrackedPath, contents);
        const commands: string[] = [];

        const result = await mergeIntoCleanDefaultCheckout({
            branch: "task",
            baseBranch: "develop",
            execGit: async (command) => {
                commands.push(command);
                return git(repo, command);
            },
        });

        expect(result.merged).toBe(false);
        expect(result.output).toStartWith("[env]");
        expect(commands).toEqual(["status --porcelain"]);
        expect(fs.readFileSync(untrackedPath, "utf8")).toBe(contents);
    });

    it("preserves an existing user stash when the merge fails", async () => {
        repo = createMergeRepo();
        // Replace the non-conflicting task commit with a conflicting edit.
        expectGit(repo, "checkout task");
        fs.writeFileSync(path.join(repo, "tracked.txt"), "task version\n");
        expectGit(repo, "add tracked.txt");
        expectGit(repo, "commit -m 'task conflict'");
        expectGit(repo, "checkout develop");
        fs.writeFileSync(path.join(repo, "tracked.txt"), "develop version\n");
        expectGit(repo, "add tracked.txt");
        expectGit(repo, "commit -m 'develop conflict'");

        const stashedContents = "recoverable user edit\n";
        fs.writeFileSync(path.join(repo, "user-draft.txt"), stashedContents);
        expectGit(repo, "stash push --include-untracked -m 'user-created stash'");
        const stashBefore = expectGit(repo, "stash list");
        const commands: string[] = [];

        const result = await mergeIntoCleanDefaultCheckout({
            branch: "task",
            baseBranch: "develop",
            execGit: async (command) => {
                commands.push(command);
                return git(repo, command);
            },
        });

        expect(result.merged).toBe(false);
        expect(expectGit(repo, "stash list")).toBe(stashBefore);
        expect(expectGit(repo, "stash show --include-untracked -p stash@{0}")).toContain(stashedContents.trim());
        expect(commands.some((command) => command.startsWith("stash "))).toBe(false);
        expect(expectGit(repo, "status --porcelain")).toBe("");
        expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("develop version\n");
    });
});

describe("sandbox_branch commit repository scoping", () => {
    it("resolves the nested repository from modern Compose array status output", async () => {
        const inspected: string[] = [];
        const repoPath = await containerRepoPathFromComposeStatus(
            JSON.stringify([{
                Service: "php84",
                Name: "easyonline-php84-1",
                State: "running",
                Publishers: [],
            }]),
            "php84",
            "/srv/easyonline/easyonline-sites",
            async (containerName) => {
                inspected.push(containerName);
                return [{ Type: "bind", Source: "/srv/easyonline", Destination: "/var/www/easyonline" }];
            },
        );

        expect(inspected).toEqual(["easyonline-php84-1"]);
        expect(repoPath).toEqual({ path: "/var/www/easyonline/easyonline-sites" });
    });

    it("reports a missing service in compose status", async () => {
        const result = await containerRepoPathFromComposeStatus(
            JSON.stringify([{ Service: "other", Name: "easyonline-other-1", State: "running", Publishers: [] }]),
            "php84",
            "/srv/easyonline/easyonline-sites",
            async () => [],
        );
        expect(result).toEqual({ reason: 'service "php84" has no running container' });
    });

    it("reports when no mount maps the repo without leaking mount sources", async () => {
        const result = await containerRepoPathFromComposeStatus(
            JSON.stringify([{ Service: "php84", Name: "easyonline-php84-1", State: "running", Publishers: [] }]),
            "php84",
            "/srv/easyonline/easyonline-sites",
            async () => [{ Type: "bind", Source: "/secret/host/dir", Destination: "/var/www/other" }],
        );
        expect(result).toMatchObject({ reason: 'no mount of service "php84" maps host repo /srv/easyonline/easyonline-sites' });
        const text = await commitSandboxBranch({
            branch: "b", message: "m",
            repoPathError: "reason" in result ? result.reason : undefined,
            execGit: async () => ({ code: 0, stdout: "", stderr: "" }),
        });
        expect(text).toEqual({
            error: 'commit failed: could not resolve repository path inside service: no mount of service "php84" maps host repo /srv/easyonline/easyonline-sites',
        });
        expect(JSON.stringify(text)).not.toContain("/secret/host/dir");
    });

    describe("resolveContainerRepoPath reasons", () => {
        const host = "/srv/easyonline/easyonline-sites";
        const status = JSON.stringify([{ Service: "php84", Name: "easyonline-php84-1", State: "running", Publishers: [] }]);
        const noMount = [{ Type: "bind", Source: "/secret/host/dir", Destination: "/var/www/other" }];
        const prefix = "commit failed: could not resolve repository path inside service: ";
        const commitError = async (resolved: Awaited<ReturnType<typeof resolveContainerRepoPath>>) => commitSandboxBranch({
            branch: "b", message: "m",
            repoPathError: "reason" in resolved ? resolved.reason : undefined,
            execGit: async () => ({ code: 0, stdout: "", stderr: "" }),
        });

        it("reports compose status failure", async () => {
            const resolved = await resolveContainerRepoPath("/stack", "php84", "proj", host, {
                getStatus: async () => { throw new Error("daemon down"); },
                inspect: async () => [],
                pin: async () => undefined,
            });
            expect(resolved).toEqual({ reason: "compose status failed: daemon down" });
            expect(await commitError(resolved)).toEqual({ error: `${prefix}compose status failed: daemon down` });
        });

        it("reports container inspection failure with the container name", async () => {
            const resolved = await resolveContainerRepoPath("/stack", "php84", "proj", host, {
                getStatus: async () => ({ stdout: status }),
                inspect: async () => { throw new Error("no such container"); },
                pin: async () => undefined,
            });
            expect(resolved).toEqual({ reason: "inspecting container easyonline-php84-1 failed: no such container" });
            expect(await commitError(resolved)).toEqual({
                error: `${prefix}inspecting container easyonline-php84-1 failed: no such container`,
            });
        });

        it("appends the pin lookup failure to the no-mount reason", async () => {
            const resolved = await resolveContainerRepoPath("/stack", "php84", "proj", host, {
                getStatus: async () => ({ stdout: status }),
                inspect: async () => noMount,
                pin: async () => { throw new Error("pin boom"); },
            });
            const reason = `no mount of service "php84" maps host repo ${host} (mount pin lookup failed: pin boom)`;
            expect(resolved).toEqual({ reason });
            const result = await commitError(resolved);
            expect(result).toEqual({ error: `${prefix}${reason}` });
            expect(JSON.stringify(result)).not.toContain("/secret/host/dir");
        });

        it("reports a service missing from status", async () => {
            const resolved = await resolveContainerRepoPath("/stack", "php84", "proj", host, {
                getStatus: async () => ({ stdout: "[]" }),
                inspect: async () => [],
                pin: async () => undefined,
            });
            expect(resolved).toEqual({ reason: 'service "php84" has no running container' });
        });

        it("returns the container path on success", async () => {
            const resolved = await resolveContainerRepoPath("/stack", "php84", "proj", host, {
                getStatus: async () => ({ stdout: status }),
                inspect: async () => [{ Type: "bind", Source: "/srv/easyonline", Destination: "/var/www/easyonline" }],
                pin: async () => undefined,
            });
            expect(resolved).toEqual({ path: "/var/www/easyonline/easyonline-sites" });
        });
    });

    describe("resolveHostRepo label fallback", () => {
        const stack = "/stack";
        const fallback = "/fallback";
        const ownName = "carapa-bot-carapa-agent-1";
        const siblingName = "carapa-bot-carapa-brain-agent-1";
        const ownMount = { WorkingDir: "/var/www", Mounts: [{ Type: "bind", Source: "/srv/carapa-bot-carapa", Destination: "/var/www" }] };
        const row = (name: string, project: string, service: string) => `${name}\t${project}\t${service}`;
        const fallbackMessage = "[resolveHostRepoPath] compose ps empty; label fallback";

        it("returns the fallback and never inspects a sibling project's container", async () => {
            const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
            try {
                const inspected: string[] = [];
                const repo = await resolveHostRepo(stack, "agent", "carapa-bot-carapa", fallback, {
                    getStatus: async () => ({ stdout: "", code: 1 }),
                    execDocker: async () => ({ stdout: `${row(siblingName, "carapa-bot-carapa-brain", "agent")}\n` }),
                    inspect: async (name) => { inspected.push(name); return ownMount; },
                });
                expect(repo).toEqual({ path: fallback });
                expect(inspected).toEqual([]);
                const entry = warnSpy.mock.calls.find(([, msg]) => msg === fallbackMessage);
                expect(entry?.[0]).toEqual({ projectName: "carapa-bot-carapa", service: "agent", composeCode: 1, matched: null });
            } finally {
                warnSpy.mockRestore();
            }
        });

        it("inspects the project's own container whichever row comes first", async () => {
            const rows = [row(siblingName, "carapa-bot-carapa-brain", "agent"), row(ownName, "carapa-bot-carapa", "agent")];
            for (const ordered of [rows, [...rows].reverse()]) {
                const inspected: string[] = [];
                const argv: string[][] = [];
                const repo = await resolveHostRepo(stack, "agent", "carapa-bot-carapa", fallback, {
                    getStatus: async () => ({ stdout: "" }),
                    execDocker: async (args) => { argv.push(args); return { stdout: ordered.join("\n") }; },
                    inspect: async (name) => { inspected.push(name); return ownMount; },
                });
                expect(repo).toEqual({ path: "/srv/carapa-bot-carapa", type: "bind" });
                expect(inspected).toEqual([ownName]);
                expect(argv[0]).toContain("label=com.docker.compose.project=carapa-bot-carapa");
                expect(argv[0]).toContain("label=com.docker.compose.service=agent");
                expect(argv[0].some(arg => arg.includes("name="))).toBe(false);
            }
        });

        it("keeps the compose ps path and skips the label fallback when services are listed", async () => {
            const execArgs: string[][] = [];
            const repo = await resolveHostRepo(stack, "agent", "carapa-bot-carapa", fallback, {
                getStatus: async () => ({ stdout: JSON.stringify([{ Service: "agent", Name: ownName, State: "running", Publishers: [] }]) }),
                execDocker: async (args) => { execArgs.push(args); return { stdout: "" }; },
                inspect: async () => ownMount,
            });
            expect(repo).toEqual({ path: "/srv/carapa-bot-carapa", type: "bind" });
            expect(execArgs).toEqual([]);
        });
    });

    describe("resolveAgentRelayHostnames", () => {
        const noPs = async () => ({ stdout: "" });

        it("qualifies the running container's name with each network, bare name last", async () => {
            const argv: string[][] = [];
            const names = await resolveAgentRelayHostnames("/stack", "carapa-bot-p", "agent", {
                getStatus: async () => ({ stdout: JSON.stringify([{ Service: "agent", Name: "carapa-bot-p-agent-1", State: "running", Publishers: [] }]) }),
                execDocker: async (args) => { argv.push(args); return { status: 0, stdout: '{"other":{},"agent_egress_carapa-bot-p":{}}' }; },
            });
            expect(names).toEqual(["carapa-bot-p-agent-1.agent_egress_carapa-bot-p", "carapa-bot-p-agent-1.other", "carapa-bot-p-agent-1"]);
            expect(argv[0].at(-1)).toBe("carapa-bot-p-agent-1");
        });

        it("keeps only the bare name when docker inspect fails or is unreadable", async () => {
            for (const result of [{ status: 1, stdout: "" }, { status: 0, stdout: "not json" }]) {
                expect(await resolveAgentRelayHostnames("/stack", "carapa-bot-p", "agent", { getStatus: noPs, execDocker: async () => result }))
                    .toEqual(["carapa-bot-p-agent-1"]);
            }
        });
    });

    it("maps a nested host repo into a service mounted above its working directory", () => {
        const repoPath = containerRepoPathFromMounts("/srv/easyonline/easyonline-sites", [
            { Type: "bind", Source: "/srv/easyonline", Destination: "/var/www/easyonline" },
        ]);

        // The service WorkingDir may be /var/www; Git must still target the
        // nested repository path derived from its actual bind mount.
        expect(repoPath).toBe("/var/www/easyonline/easyonline-sites");
    });

    it("maps a host repo mounted as a pinned volume subpath", () => {
        // docker inspect .Mounts shows the base volume's _data dir, not the host repo.
        const mounts = withVolumeSubpaths([
            { Type: "volume", Name: "carapa-mount-aaa", Source: "/var/lib/docker/volumes/carapa-mount-aaa/_data", Destination: "/workspace/group" },
            { Type: "volume", Name: "carapa-mount-bbb", Source: "/var/lib/docker/volumes/carapa-mount-bbb/_data", Destination: "/workspace/carapa-brain" },
        ], [
            { Type: "volume", Source: "carapa-mount-aaa", Target: "/workspace/group", VolumeOptions: { Subpath: "groups/carapa" } },
            { Type: "volume", Source: "carapa-mount-bbb", Target: "/workspace/carapa-brain", VolumeOptions: { Subpath: "carapa-brain" } },
        ]);
        const pinned = { volume: "carapa-mount-bbb", subpath: "carapa-brain" };

        expect(containerRepoPathFromMounts("/home/user/repos/carapa-brain", mounts)).toBeUndefined();
        expect(containerRepoPathFromMounts("/home/user/repos/carapa-brain", mounts, pinned)).toBe("/workspace/carapa-brain");
        expect(containerRepoPathFromMounts("/home/user/repos/carapa-brain/sub", mounts, { volume: "carapa-mount-bbb", subpath: "carapa-brain/sub" }))
            .toBe("/workspace/carapa-brain/sub");
        expect(containerRepoPathFromMounts("/home/user/repos/other", mounts, { volume: "carapa-mount-bbb", subpath: "other" })).toBeUndefined();
    });

    it("scopes every main working-tree command to a nested repository", async () => {
        const commands: string[] = [];
        const result = await commitSandboxBranch({
            branch: "develop",
            message: "fix: nested repo",
            repoPath: "/var/www/easyonline/easyonline-sites",
            execGit: async (command) => {
                commands.push(command);
                if (command.endsWith("symbolic-ref --quiet --short HEAD")) return { code: 0, stdout: "main\n", stderr: "" };
                if (command.includes("status --porcelain")) return { code: 0, stdout: " M src/file.php\n", stderr: "" };
                return { code: 0, stdout: "", stderr: "" };
            },
        });

        expect(result).toEqual({ committed: true, message: "fix: nested repo" });
        expect(commands).toEqual([
            "-C '/var/www/easyonline/easyonline-sites' symbolic-ref --quiet --short HEAD",
            "-C '/var/www/easyonline/easyonline-sites' checkout develop",
            "-C '/var/www/easyonline/easyonline-sites' status --porcelain",
            "-C '/var/www/easyonline/easyonline-sites' add -- .",
            "-C '/var/www/easyonline/easyonline-sites' commit -m 'fix: nested repo'",
        ]);
    });

    it("preserves explicit worktreePath behavior", async () => {
        const commands: string[] = [];
        const result = await commitSandboxBranch({
            branch: "task-branch",
            message: "feat: task",
            worktreePath: ".worktrees/task-branch",
            repoPath: "/var/www/easyonline/easyonline-sites",
            paths: ["src/a.ts"],
            execGit: async (command) => {
                commands.push(command);
                return { code: 0, stdout: command.includes("status --porcelain") ? " M src/a.ts\n" : "", stderr: "" };
            },
        });

        expect(result).toEqual({ committed: true, message: "feat: task" });
        expect(commands).toEqual([
            "-C '.worktrees/task-branch' status --porcelain -- 'src/a.ts'",
            "-C '.worktrees/task-branch' add -- 'src/a.ts'",
            "-C '.worktrees/task-branch' commit -m 'feat: task'",
        ]);
    });
});

describe("first commit", () => {
    it("preserves multiline commit messages without interpreting shell syntax", async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-commit-message-"));
        const message = [
            "refactor: simplify durable snapshot import and generation failure paths",
            "",
            "- Remove `resident()` pre-check from `DurableSharedSnapshotAccess`.",
            "- Collapse `take_failure_checkpoint_lifecycle()` indirection.",
            "- Preserve apostrophes: don't change the \"quoted\" text.",
            "- Keep $HOME, ${HOME}, $(touch dollar-expanded), `touch backtick-expanded`, and \\paths\\ literal.",
        ].join("\n");
        try {
            expectGit(repo, "init -b develop");
            expectGit(repo, "config user.name 'Carapa Test'");
            expectGit(repo, "config user.email carapa@ex.test");
            fs.writeFileSync(path.join(repo, "app.txt"), "initial app\n");
            const result = await commitSandboxBranch({
                branch: "develop", message, repoPath: repo,
                execGit: async (command) => git(repo, command),
            });
            expect(result).toEqual({ committed: true, message });
            expect(expectGit(repo, "log -1 --format=%B")).toBe(message);
            expect(fs.existsSync(path.join(repo, "dollar-expanded"))).toBe(false);
            expect(fs.existsSync(path.join(repo, "backtick-expanded"))).toBe(false);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it("stages only the named paths when they contain shell metacharacters", async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-commit-paths-"));
        try {
            expectGit(repo, "init -b develop");
            expectGit(repo, "config user.name 'Carapa Test'");
            expectGit(repo, "config user.email carapa@ex.test");
            fs.mkdirSync(path.join(repo, "app/routes"), { recursive: true });
            fs.writeFileSync(path.join(repo, "app/routes/$id.tsx"), "route\n");
            fs.writeFileSync(path.join(repo, "app/routes/it's `x`.tsx"), "quoted\n");
            fs.writeFileSync(path.join(repo, "app/routes/.tsx"), "expanded-empty-var\n");
            const result = await commitSandboxBranch({
                branch: "develop", message: "feat: routes", repoPath: repo,
                paths: ["app/routes/$id.tsx", "app/routes/it's `x`.tsx"],
                execGit: async (command) => git(repo, command),
            });
            expect(result).toEqual({ committed: true, message: "feat: routes" });
            expect(expectGit(repo, "ls-tree -r --name-only HEAD").split("\n").sort())
                .toEqual(["app/routes/$id.tsx", "app/routes/it's `x`.tsx"]);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it("commits an unborn default branch without checking out a nonexistent ref", async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-first-commit-"));
        try {
            expectGit(repo, "init -b develop");
            expectGit(repo, "config user.name 'Carapa Test'");
            expectGit(repo, "config user.email carapa@ex.test");
            fs.writeFileSync(path.join(repo, "app.txt"), "initial app\n");
            const result = await commitSandboxBranch({
                branch: "develop", message: "Initial commit", repoPath: repo,
                execGit: async (command) => git(repo, command),
            });
            expect(result).toEqual({ committed: true, message: "Initial commit" });
            expect(expectGit(repo, "symbolic-ref --short HEAD")).toBe("develop");
            expect(expectGit(repo, "show HEAD:app.txt")).toBe("initial app");
            expect(expectGit(repo, "status --porcelain")).toBe("");
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe("best-effort lifecycle diagnostics", () => {
    it("surfaces and logs a non-benign error with its message, without throwing", async () => {
        const logs: string[] = [];
        const warning = await runBestEffortLifecycleStep(
            "pre-restart stop",
            async () => { throw new Error("permission denied talking to docker"); },
            (m) => logs.push(m),
        );
        expect(warning).toBe("pre-restart stop failed: permission denied talking to docker");
        expect(logs.join("")).toContain("permission denied talking to docker");
    });

    it("does not surface benign not-running errors as warnings", async () => {
        for (const msg of ["service is not running", "No such container: x", "no such service: agent", "no containers to stop"]) {
            expect(isBenignStopError(msg)).toBe(true);
            const logs: string[] = [];
            const warning = await runBestEffortLifecycleStep("stop sandbox processes", async () => { throw new Error(msg); }, (m) => logs.push(m));
            expect(warning).toBeUndefined();
            expect(logs.join("")).not.toContain("WARNING");
        }
    });

    it("does not treat similar-looking real failures as benign", () => {
        for (const msg of ["no containerd socket", "no service account configured", "permission denied"]) {
            expect(isBenignStopError(msg)).toBe(false);
        }
    });

    it("returns undefined and logs nothing on success so flow continues", async () => {
        const logs: string[] = [];
        expect(await runBestEffortLifecycleStep("op", async () => {}, (m) => logs.push(m))).toBeUndefined();
        expect(logs).toEqual([]);
    });

    it("parseWorktreeHookData logs a warning for a malformed line and returns undefined", () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        try {
            const result = parseWorktreeHookData("noise\nCARAPA_HOOK_RESULT={not json");
            expect(result).toBeUndefined();
            expect(warnSpy.mock.calls.length).toBe(1);
            expect(JSON.stringify(warnSpy.mock.calls[0])).toContain("{not json");
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe("relayTokenHostnames", () => {
    it("always includes the default agent and sandbox hostnames", () => {
        const names = relayTokenHostnames("p1", []);
        expect(names).toContain("p1-agent-1");
        expect(names).toContain("p1-sandbox-1");
    });

    it("includes real hostnames without duplicates or empty strings", () => {
        const svc = (service: string, hostname: string): ServiceInfo => ({ service, hostname, status: "running", ports: [], ip: "" });
        const names = relayTokenHostnames("p1", [
            svc("agent", "custom-agent-1"),
            svc("db", "p1-db-1"),
            svc("x", "p1-db-1"),
            svc("y", ""),
        ]);
        expect(names).toContain("custom-agent-1");
        expect(names).toContain("p1-db-1");
        expect(names).not.toContain("");
        expect(new Set(names).size).toBe(names.length);
    });

    it("deleting every returned hostname clears board and carapa-mail tokens", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hosts-"));
        try {
            const script = `
                import { setRelayToken, getRelayToken, deleteRelayToken } from ${JSON.stringify(path.resolve(import.meta.dir, "../relay-token-store.ts"))};
                import { relayTokenHostnames } from ${JSON.stringify(path.resolve(import.meta.dir, "./register.ts"))};
                await setRelayToken("p1-agent-1", "t");
                await setRelayToken("p1-agent-1", "t", "carapa-mail");
                for (const h of relayTokenHostnames("p1", [])) {
                    await deleteRelayToken(h);
                    await deleteRelayToken(h, "carapa-mail");
                }
                console.log(JSON.stringify([getRelayToken("p1-agent-1"), getRelayToken("p1-agent-1", "carapa-mail")]));
            `;
            const r = spawnSync(process.execPath, ["-e", script], {
                env: { ...process.env, CARAPA_BOX_STATE_DIR: dir },
                encoding: "utf8",
            });
            expect(r.stdout.trim().split("\n").pop()).toBe("[null,null]");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("sandbox_ps cache invalidation", () => {
    beforeEach(() => invalidatePsCache());
    afterEach(() => invalidatePsCache());

    it("recomputes and returns the new text after invalidatePsCache", async () => {
        let calls = 0;
        const compute = async () => `snapshot-${++calls}`;
        expect(await getPsCached(compute)).toBe("snapshot-1");
        expect(await getPsCached(compute)).toBe("snapshot-1");
        expect(calls).toBe(1);
        invalidatePsCache();
        expect(await getPsCached(compute)).toBe("snapshot-2");
        expect(calls).toBe(2);
    });

    it("does not let a refresh started before invalidation overwrite newer data", async () => {
        let release!: (text: string) => void;
        const slow = () => new Promise<string>((resolve) => { release = resolve; });
        const pending = getPsCached(slow);
        invalidatePsCache();
        expect(await getPsCached(async () => "new")).toBe("new");
        release("old");
        expect(await pending).toBe("old");
        expect(await getPsCached(async () => "unused")).toBe("new");
    });
});

describe("pushLinkedRepository hook validation", () => {
    const ok = async () => null;
    const run = async (repository: Record<string, unknown>, validateRepo: (p: string) => Promise<string | null> = ok) => {
        const calls: string[][] = [];
        const exec = async (argv: string[]) => {
            calls.push(argv);
            return { stdout: "", stderr: "", code: 0 };
        };
        await pushLinkedRepository(repository, "develop", "/keys", undefined, { exec, validateRepo });
        return calls;
    };

    it("skips the push when localRepo is outside the allowlist", async () => {
        const repository: Record<string, unknown> = { name: "r", localRepo: "/etc", base: "develop" };
        const calls = await run(repository, async () => "[SECURITY] Mount path blocked");
        expect(calls).toEqual([]);
        expect(repository.pushed).toBe(false);
        expect(repository.pushError).toContain("Mount path blocked");
    });

    for (const base of ["--mirror", "+x:main", "a:b"]) {
        it(`skips the push for base ${base}`, async () => {
            const repository: Record<string, unknown> = { name: "r", localRepo: "/repo", base };
            const calls = await run(repository);
            expect(calls).toEqual([]);
            expect(repository.pushed).toBe(false);
            expect(typeof repository.pushError).toBe("string");
        });
    }

    it("pushes a valid repository with an explicit refspec", async () => {
        const repository: Record<string, unknown> = { name: "r", localRepo: "/repo", base: "feature/x" };
        const calls = await run(repository);
        expect(calls).toEqual([["push", "origin", "--", "refs/heads/feature/x:refs/heads/feature/x"]]);
        expect(repository.pushed).toBe(true);
        expect(repository.pushError).toBeUndefined();
    });
});

describe("resolveWorkspaceMount subpath", () => {
    const msg = () => "missing";
    it("returns the volume subpath for a subpath-mounted workspace", () => {
        const mounts = withVolumeSubpaths(
            [{ Type: "volume", Name: "carapa-mount-bbb", Source: "/var/lib/docker/volumes/carapa-mount-bbb/_data", Destination: "/workspace/carapa-brain" }],
            [{ Type: "volume", Source: "carapa-mount-bbb", Target: "/workspace/carapa-brain", VolumeOptions: { Subpath: "carapa-brain" } }]);
        expect(resolveWorkspaceMount("/workspace/carapa-brain", mounts, msg)).toEqual({ path: "carapa-mount-bbb", type: "volume", subpath: "carapa-brain" });
    });
    it("returns a plain path for a bind mount and a volume without subpath", () => {
        expect(resolveWorkspaceMount("/w", [{ Type: "bind", Source: "/host/repo", Destination: "/w" }], msg)).toEqual({ path: "/host/repo", type: "bind" });
        expect(resolveWorkspaceMount("/w", [{ Type: "volume", Name: "vol", Source: "/x", Destination: "/w" }], msg)).toEqual({ path: "vol", type: "volume" });
    });
    it("reports the configured host repo instead of the volume name", () => {
        expect(displayRepoPath({ path: "carapa-mount-bbb", type: "volume", subpath: "r" }, "/home/user/repos/r")).toBe("/home/user/repos/r");
        expect(displayRepoPath({ path: "carapa-mount-bbb", type: "volume" }, "")).toBe("carapa-mount-bbb");
        expect(displayRepoPath({ path: "/host/repo", type: "bind" }, "/other")).toBe("/host/repo");
    });
});
