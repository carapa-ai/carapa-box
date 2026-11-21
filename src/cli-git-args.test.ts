import { expect, test } from "bun:test";
import { parseGitCliArgs } from "./cli-git-args.js";
import { parseCommandArgv } from "./security.js";

/** What the sandbox_git tool will see as argv after its own shell-like parse. */
function serverArgv(command: string): string[] {
    const parsed = parseCommandArgv(command);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.argv;
}

test("git flags after the stack are forwarded unchanged, not parsed as CLI options", () => {
    for (const git of [["log", "--oneline"], ["status", "-s"], ["checkout", "-b", "feat"], ["--", "x"], ["commit", "-m", "fix bug"], ["log", "-i"]]) {
        const parsed = parseGitCliArgs(["mystack", ...git]);
        expect(parsed).not.toBeNull();
        expect(parsed!.stack).toBe("mystack");
        expect(parsed!.instance).toBeUndefined();
        expect(parsed!.service).toBeUndefined();
        expect(serverArgv(parsed!.command)).toEqual(git);
    }
});

test("leading -i/-s select instance and service; quoted single-argument form still works", () => {
    const parsed = parseGitCliArgs(["-i", "inst", "--service=svc", "mystack", "log --oneline -5"]);
    expect(parsed).toMatchObject({ stack: "mystack", instance: "inst", service: "svc" });
    expect(serverArgv(parsed!.command)).toEqual(["log", "--oneline", "-5"]);
});

test("missing stack, git command or option value is a usage error", () => {
    expect(parseGitCliArgs([])).toBeNull();
    expect(parseGitCliArgs(["mystack"])).toBeNull();
    expect(parseGitCliArgs(["-i"])).toBeNull();
    expect(parseGitCliArgs(["-x", "v", "mystack", "log"])).toBeNull();
});
