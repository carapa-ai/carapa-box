import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as compose from "../compose/client.js";
import * as utils from "../utils.js";
import { isSafeBranchArg, isValidWorktreePathArg, registerTools } from "./register.js";

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

function mockExec() {
    const commands: string[] = [];
    const exec = spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        // `show-ref --verify` exits 1 when the branch does not exist.
        return { code: cmd.includes("show-ref") ? 1 : 0, stdout: "", stderr: "" };
    }) as unknown as typeof compose.execInService);
    const resolve = spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return { commands, exec, resolve };
}

describe("sandbox_worktree add branch validation", () => {
    for (const branch of ["../src", "a;touch x", "x/../y"]) {
        it(`rejects ${JSON.stringify(branch)} without any exec`, async () => {
            const { exec } = mockExec();
            const result = await handlers.get("sandbox_worktree")!({ name: "s", action: "add", branch, localRepo: "/repo" }, {});
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe("Invalid branch name");
            expect(exec).not.toHaveBeenCalled();
        });
    }

    it("rejects an invalid base", async () => {
        const { exec } = mockExec();
        const result = await handlers.get("sandbox_worktree")!({ name: "s", action: "add", branch: "ok", base: "x;y", localRepo: "/repo" }, {});
        expect(result.isError).toBe(true);
        expect(exec).not.toHaveBeenCalled();
    });

    for (const branch of ["task-123-abc", "feature/x"]) {
        it(`quotes paths for valid branch ${branch}`, async () => {
            const { commands } = mockExec();
            await handlers.get("sandbox_worktree")!({ name: "s", action: "add", branch, localRepo: "/repo", repoPath: "/repo" }, {});
            expect(commands.some((c) => c.includes(`test -d '.worktrees/${branch}'`))).toBe(true);
            expect(commands.some((c) => c.includes(`worktree add '.worktrees/${branch}' -b '${branch}' 'HEAD'`))).toBe(true);
            expect(commands.some((c) => c.includes(`test -d .worktrees/${branch}`))).toBe(false);
        });
    }
});

describe("sandbox_branch validation", () => {
    for (const worktreePath of ["../x", "/abs/path", ".worktrees/../x"]) {
        it(`rejects worktreePath ${worktreePath}`, async () => {
            const { exec } = mockExec();
            const result = await handlers.get("sandbox_branch")!({ name: "s", action: "commit", branch: "ok", worktreePath }, {});
            expect(result.isError).toBe(true);
            expect(exec).not.toHaveBeenCalled();
        });
    }

    it("rejects an invalid branch", async () => {
        const { exec } = mockExec();
        const result = await handlers.get("sandbox_branch")!({ name: "s", action: "merge", branch: "../src" }, {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("Invalid branch name");
        expect(exec).not.toHaveBeenCalled();
    });

    it("accepts valid branches and worktree paths", () => {
        expect(isSafeBranchArg("task-123-abc")).toBe(true);
        expect(isSafeBranchArg("feature/x")).toBe(true);
        expect(isValidWorktreePathArg(".worktrees/feature/x")).toBe(true);
        expect(isValidWorktreePathArg(".worktrees/..")).toBe(false);
    });
});
