import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as compose from "../compose/client.js";
import * as utils from "../utils.js";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const handlers = new Map<string, Handler>();
const tmpDirs: string[] = [];

beforeAll(() => {
    process.env.ENABLE_SANDBOX_GIT = "1";
    const fakeServer = {
        tool: (name: string, _d: string, _s: unknown, cb: Handler) => {
            handlers.set(name, cb);
        },
    };
    registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], false);
});

afterEach(() => {
    spyOn(compose, "execInService").mockRestore();
    spyOn(utils, "resolveStackAndProject").mockRestore();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Temp repo with one commit on main plus a branch `feat` carrying its own commit. */
function makeRepo() {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-add-real-git-"));
    tmpDirs.push(root);
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const env = {
        ...process.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" }).toString();
    execFileSync("mkdir", ["-p", repo, home]);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("branch", "feat");
    git("checkout", "-q", "feat");
    writeFileSync(path.join(repo, "feat.txt"), "feature work\n");
    git("add", "feat.txt");
    git("commit", "-q", "-m", "feat commit");
    git("checkout", "-q", "main");
    return { repo, env, git };
}

/** Routes the handler's agent-container commands into the real temp repo. */
function routeIntoRepo(repo: string, env: NodeJS.ProcessEnv) {
    const commands: string[] = [];
    spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        const r = spawnSync("bash", ["-c", cmd], { cwd: repo, env });
        return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    }) as unknown as typeof compose.execInService);
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return commands;
}

const addArgs = (branch: string) => ({ name: "s", action: "add", branch, localRepo: "/repo" });

describe("sandbox_worktree add against a real git repository", () => {
    it("checks out an existing branch that has no worktree, keeping its commits", async () => {
        const { repo, env } = makeRepo();
        const commands = routeIntoRepo(repo, env);
        const result = await handlers.get("sandbox_worktree")!(addArgs("feat"), {});
        expect(result.isError).toBeFalsy();
        expect(readFileSync(path.join(repo, ".worktrees/feat/feat.txt"), "utf8")).toBe("feature work\n");
        expect(commands.some((c) => c.includes("rm -rf"))).toBe(false);
    });

    it("creates a new branch from the base when the branch is missing", async () => {
        const { repo, env, git } = makeRepo();
        routeIntoRepo(repo, env);
        const result = await handlers.get("sandbox_worktree")!(addArgs("fresh"), {});
        expect(result.isError).toBeFalsy();
        expect(git("rev-parse", "fresh").trim()).toBe(git("rev-parse", "main").trim());
    });

    it("ignores .worktrees via info/exclude and leaves the tracked .gitignore and checkout clean", async () => {
        const { repo, env, git } = makeRepo();
        writeFileSync(path.join(repo, ".gitignore"), "node_modules"); // no trailing newline
        git("add", ".gitignore");
        git("commit", "-q", "-m", "gitignore");
        routeIntoRepo(repo, env);
        for (const branch of ["one", "two"]) {
            const result = await handlers.get("sandbox_worktree")!(addArgs(branch), {});
            expect(result.isError).toBeFalsy();
        }
        expect(readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules");
        expect(git("status", "--porcelain")).toBe("");
        expect(readFileSync(path.join(repo, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === ".worktrees/")).toHaveLength(1);
    });

    it("reports git's own error when the branch is already checked out in another worktree", async () => {
        const { repo, env, git } = makeRepo();
        git("worktree", "add", path.join(path.dirname(repo), "other"), "feat");
        const commands = routeIntoRepo(repo, env);
        const result = await handlers.get("sandbox_worktree")!(addArgs("feat"), {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("already used by worktree");
        expect(commands.some((c) => c.includes("rm -rf") || c.includes("--force"))).toBe(false);
    });
});
