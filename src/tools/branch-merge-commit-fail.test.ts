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

function mockExec(commitResult: { code: number; stdout: string; stderr: string }, addCode = 0) {
    const commands: string[] = [];
    spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        if (cmd.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
        if (cmd.includes("status --porcelain")) return { code: 0, stdout: " M file.txt\n", stderr: "" };
        if (/ add \./.test(cmd)) return { code: addCode, stdout: "", stderr: addCode ? "add boom" : "" };
        if (/ commit -m /.test(cmd)) return commitResult;
        return { code: 0, stdout: "", stderr: "" };
    }) as unknown as typeof compose.execInService);
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return commands;
}

const mergeArgs = { name: "s", action: "merge", branch: "task1", base: "develop", localRepo: "/repo", worktreePath: ".worktrees/task1" };

describe("sandbox_branch merge auto-commit", () => {
    it("fails closed when the commit fails, before merge or cleanup", async () => {
        const commands = mockExec({ code: 1, stdout: "", stderr: "hook rejected" });
        const result = await handlers.get("sandbox_branch")!(mergeArgs, {});
        expect(result.isError).toBe(true);
        const body = JSON.parse(result.content[0].text);
        expect(body.merged).toBe(false);
        expect(body.pushed).toBe(false);
        expect(body.output).toBe("[env] auto-commit before merge failed: hook rejected");
        const commitIdx = commands.findIndex((c) => / commit -m /.test(c));
        expect(commitIdx).toBeGreaterThanOrEqual(0);
        const after = commands.slice(commitIdx + 1);
        expect(after.some((c) => c.includes("worktree remove") || c.includes("branch -D") || /\bmerge\b/.test(c))).toBe(false);
    });

    it("fails closed when git add fails", async () => {
        const commands = mockExec({ code: 0, stdout: "", stderr: "" }, 1);
        const result = await handlers.get("sandbox_branch")!(mergeArgs, {});
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).output).toBe("[env] auto-commit before merge failed: add boom");
        expect(commands.some((c) => c.includes("worktree remove") || c.includes("branch -D"))).toBe(false);
    });

    it("proceeds with the merge when the commit succeeds", async () => {
        const commands = mockExec({ code: 0, stdout: "", stderr: "" });
        await handlers.get("sandbox_branch")!(mergeArgs, {});
        const commitIdx = commands.findIndex((c) => / commit -m /.test(c));
        expect(commands.slice(commitIdx + 1).some((c) => c.includes("rev-parse --verify"))).toBe(true);
    });

    it("tolerates git's nothing-to-commit result", async () => {
        const commands = mockExec({ code: 1, stdout: "nothing to commit, working tree clean", stderr: "" });
        const result = await handlers.get("sandbox_branch")!(mergeArgs, {});
        expect(result.content[0].text).not.toContain("auto-commit before merge failed");
        const commitIdx = commands.findIndex((c) => / commit -m /.test(c));
        expect(commands.slice(commitIdx + 1).some((c) => c.includes("rev-parse --verify"))).toBe(true);
    });
});
