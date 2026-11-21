import { describe, it, expect } from "bun:test";
import { parseCommandArgv } from "../security.js";
import { gitSubcommandFromArgv, isRemoteGitSubcommand } from "./register.js";

function isRemote(command: string): boolean {
    const parsed = parseCommandArgv(command);
    if (!parsed.ok) throw new Error(parsed.reason);
    return isRemoteGitSubcommand(gitSubcommandFromArgv(parsed.argv));
}

describe("git remote subcommand detection", () => {
    it("treats commands with leading global options as remote", () => {
        expect(isRemote("-C '/workspace/x' fetch origin")).toBe(true);
        expect(isRemote("-C /w pull origin develop")).toBe(true);
        expect(isRemote("-c http.extraHeader=x push")).toBe(true);
        expect(isRemote("--no-pager ls-remote origin")).toBe(true);
    });

    it("treats local commands as local", () => {
        expect(isRemote("-C /w status")).toBe(false);
        expect(isRemote("log --oneline -5")).toBe(false);
        expect(isRemote("-C /w checkout -b feat")).toBe(false);
    });

    it("keeps plain remote commands remote", () => {
        expect(isRemote("fetch origin")).toBe(true);
        expect(isRemote("push origin develop")).toBe(true);
    });

    it("skips other global options", () => {
        expect(gitSubcommandFromArgv(["--git-dir=/a", "--work-tree", "/b", "--bare", "-P", "fetch"])).toBe("fetch");
        expect(gitSubcommandFromArgv(["--git-dir", "/a", "--namespace=n", "--no-replace-objects", "--literal-pathspecs", "status"])).toBe("status");
        expect(gitSubcommandFromArgv([])).toBeUndefined();
    });
});
