import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as compose from "../compose/client.js";
import * as utils from "../utils.js";
import { registerTools } from "./register.js";

type Result = { code: number; stdout: string; stderr: string };
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

const ok: Result = { code: 0, stdout: "", stderr: "" };
const GIT_FAIL: Result = { code: 128, stdout: "", stderr: "fatal: boom" };

type Overrides = {
    branchVerify?: Result;
    baseVerify?: Result;
    isAncestor?: Result;
    revList?: Result;
};

// Clean working tree everywhere; hook scripts report themselves absent.
function mockGit(overrides: Overrides) {
    const commands: string[] = [];
    spyOn(compose, "execInService").mockImplementation((async (_s: string, _svc: string, cmd: string) => {
        commands.push(cmd);
        const hook = cmd.match(/__WT_HOOK_ABSENT_[A-Za-z0-9_]+__/);
        if (hook) return { code: 0, stdout: `${hook[0]}\n`, stderr: "" };
        if (cmd.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n", stderr: "" };
        if (cmd.includes("rev-parse --verify") && cmd.includes("^{commit}")) return overrides.baseVerify ?? ok;
        if (cmd.includes("rev-parse --verify")) return overrides.branchVerify ?? ok;
        if (cmd.includes("merge-base --is-ancestor")) return overrides.isAncestor ?? { code: 1, stdout: "", stderr: "" };
        if (cmd.includes("rev-list")) return overrides.revList ?? { code: 0, stdout: "1\n", stderr: "" };
        return ok;
    }) as unknown as typeof compose.execInService);
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: "/nonexistent-stack", projectName: "p" } as never);
    return commands;
}

const mergeArgs = { name: "s", action: "merge", branch: "task1", base: "develop", localRepo: "/repo", worktreePath: ".worktrees/task1" };
const isCleanup = (c: string) => c.includes("branch -D") || c.includes("worktree remove") || c.includes("rm -rf");

async function runMerge() {
    const result = await handlers.get("sandbox_branch")!(mergeArgs, {});
    return { result, body: JSON.parse(result.content[0].text) as { merged: boolean; pushed: boolean; output: string } };
}

describe("sandbox_branch merge fails closed on git errors", () => {
    it("refuses and does not clean up when the base branch cannot be resolved", async () => {
        const commands = mockGit({
            baseVerify: { code: 128, stdout: "", stderr: "fatal: Needed a single revision" },
            isAncestor: GIT_FAIL,
            revList: GIT_FAIL,
        });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(body.pushed).toBe(false);
        expect(body.output).toContain("[env] base branch develop cannot be resolved; refusing to merge or clean up:");
        expect(commands.some(isCleanup)).toBe(false);
    });

    it("refuses when merge-base --is-ancestor exits with an error code other than 0/1", async () => {
        const commands = mockGit({ isAncestor: GIT_FAIL });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(commands.some(isCleanup)).toBe(false);
    });

    it("refuses when rev-list --count fails transiently (exit 128, empty stdout)", async () => {
        const commands = mockGit({ revList: GIT_FAIL });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(commands.some(isCleanup)).toBe(false);
    });

    it("refuses when rev-list exits 0 but prints a non-numeric count", async () => {
        const commands = mockGit({ revList: { code: 0, stdout: "", stderr: "" } });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(body.output).toContain("unexpected output");
        expect(commands.some(isCleanup)).toBe(false);
    });

    it("refuses when the branch rev-parse fails for a reason other than a missing ref", async () => {
        const commands = mockGit({ branchVerify: GIT_FAIL });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(commands.some(isCleanup)).toBe(false);
    });

    it("refuses when rev-parse reports a broken (corrupt) branch ref instead of an absent one", async () => {
        const commands = mockGit({
            branchVerify: {
                code: 128,
                stdout: "",
                stderr: "warning: ignoring broken ref refs/heads/task1\nfatal: Needed a single revision\n",
            },
        });
        const { result, body } = await runMerge();
        expect(result.isError).toBe(true);
        expect(body.merged).toBe(false);
        expect(body.output).toContain("could not resolve branch task1");
        expect(commands.some(isCleanup)).toBe(false);
    });
});
