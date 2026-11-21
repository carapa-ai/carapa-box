import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as compose from "../compose/client.js";
import * as utils from "../utils.js";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const handlers = new Map<string, Handler>();

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
});

type Result = { code: number; stdout: string; stderr: string };

function mockExec(listing: Result) {
    const commands: string[] = [];
    spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes("test -d '.worktrees/task1'")) return { code: 0, stdout: "", stderr: "" };
        if (cmd.includes("worktree list --porcelain")) return listing;
        return { code: 0, stdout: "", stderr: "" };
    }) as unknown as typeof compose.execInService);
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return commands;
}

const addArgs = { name: "s", action: "add", branch: "task1", localRepo: "/repo" };

function expectNoDestructiveCommand(commands: string[]) {
    expect(commands.some((c) => c.includes("rm -rf"))).toBe(false);
    expect(commands.some((c) => c.includes("worktree remove") || c.includes("worktree add"))).toBe(false);
}

describe("sandbox_worktree add on an existing directory", () => {
    it("refuses to remove the directory when the listing fails with empty stdout", async () => {
        const commands = mockExec({ code: 128, stdout: "", stderr: "fatal: detected dubious ownership" });
        const result = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("[env] could not list worktrees (exit 128): fatal: detected dubious ownership");
        expect(result.content[0].text).toContain("refusing to remove existing worktree .worktrees/task1");
        expectNoDestructiveCommand(commands);
    });

    it("fails closed on a non-zero listing with partial stdout", async () => {
        const commands = mockExec({ code: 137, stdout: "worktree /repo\n", stderr: "" });
        const result = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(result.isError).toBe(true);
        expectNoDestructiveCommand(commands);
    });
});

describe("sandbox_worktree add registration match", () => {
    it("treats a leftover plain dir as orphaned when only a longer sibling path is registered", async () => {
        const commands = mockExec({ code: 0, stdout: "worktree /repo\nHEAD abc\n\nworktree /repo/.worktrees/task10\nHEAD def\n", stderr: "" });
        const result = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(result.content[0].text).not.toContain("already exists, reusing");
        expect(commands.some((c) => c.includes("rm -rf '.worktrees/task1'"))).toBe(true);
        expect(commands.some((c) => c.includes("worktree add '.worktrees/task1'"))).toBe(true);
    });

    it("still reuses the directory when its whole path is registered", async () => {
        const commands = mockExec({ code: 0, stdout: "worktree /repo/.worktrees/task1\nHEAD abc\n\nworktree /repo/.worktrees/task10\nHEAD def\n", stderr: "" });
        const result = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(result.content[0].text).toContain("Worktree already exists, reusing");
        expectNoDestructiveCommand(commands);
    });
});

function mockAdd(addResult: (cmd: string, n: number) => Result, branchExists = false) {
    const commands: string[] = [];
    spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes("test -d")) return { code: 1, stdout: "", stderr: "" };
        if (cmd.includes("show-ref")) return { code: branchExists ? 0 : 1, stdout: "", stderr: "" };
        if (cmd.includes("worktree add")) return addResult(cmd, commands.filter((c) => c.includes("worktree add")).length);
        return { code: 0, stdout: "", stderr: "" };
    }) as unknown as typeof compose.execInService);
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return commands;
}

const adds = (commands: string[]) => commands.filter((c) => c.includes("worktree add"));

describe("sandbox_worktree add failure classification", () => {
    it("falls back to the existing branch when git exits 255 because the branch appeared after the check", async () => {
        const commands = mockAdd((cmd) => cmd.includes(" -b ")
            ? { code: 255, stdout: "", stderr: "Preparing worktree (new branch 'task1')\nfatal: a branch named 'task1' already exists" }
            : { code: 0, stdout: "", stderr: "" });
        const result = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(result.isError).toBeFalsy();
        const added = adds(commands);
        expect(added).toHaveLength(2);
        expect(added[0]).toContain("-b 'task1'");
        expect(added[1]).toContain("worktree add '.worktrees/task1' 'task1'");
        expect(added[1]).not.toContain(" -b ");
        expect(commands.some((c) => c.includes("rm -rf"))).toBe(false);
    });

    it("adds an existing branch without -b, and surfaces git's own error without cleanup or retry", async () => {
        const ok = mockAdd(() => ({ code: 0, stdout: "", stderr: "" }), true);
        const okResult = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(okResult.isError).toBeFalsy();
        expect(adds(ok)).toEqual(["git config --global safe.directory '*' 2>/dev/null; git worktree add '.worktrees/task1' 'task1'"]);

        spyOn(compose, "execInService").mockRestore();
        const busy = mockAdd(() => ({ code: 255, stdout: "", stderr: "fatal: 'task1' is already used by worktree at '/repo/other'" }), true);
        const busyResult = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(busyResult.isError).toBe(true);
        expect(busyResult.content[0].text).toContain("is already used by worktree at '/repo/other'");
        expect(busyResult.content[0].text).not.toContain("signal");
        expect(adds(busy)).toHaveLength(1);
        expect(busy.some((c) => c.includes("rm -rf") || c.includes("--force") || c.includes("branch -"))).toBe(false);
    });

    it("retries a signal kill once without the fallback, but treats exit 128 without output as a git failure", async () => {
        const killed = mockAdd(() => ({ code: 137, stdout: "", stderr: "" }));
        const killedResult = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(killedResult.isError).toBe(true);
        expect(killedResult.content[0].text).toContain("killed by signal 9 (SIGKILL)");
        expect(adds(killed)).toHaveLength(2);
        expect(adds(killed).every((c) => c.includes(" -b "))).toBe(true);
        expect(killed.filter((c) => c.includes("rm -rf"))).toHaveLength(1);

        spyOn(compose, "execInService").mockRestore();
        const git = mockAdd(() => ({ code: 128, stdout: "", stderr: "" }));
        const gitResult = await handlers.get("sandbox_worktree")!(addArgs, {});
        expect(gitResult.isError).toBe(true);
        expect(gitResult.content[0].text).toContain("exited 128 with no output");
        expect(gitResult.content[0].text).not.toContain("signal");
        expect(adds(git)).toHaveLength(2);
        expect(adds(git)[1]).not.toContain(" -b ");
        expect(git.some((c) => c.includes("rm -rf"))).toBe(false);
    });
});
