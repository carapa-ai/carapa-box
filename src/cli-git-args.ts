import { shellQuote } from "./utils.js";

export const GIT_USAGE = "bun call git [-i instance] [-s service] <stack> <git-command...>";

export interface GitCliArgs {
    stack: string;
    /** Git command line for the sandbox_git tool (argv re-quoted so it survives the server's shell-like parse). */
    command: string;
    instance?: string;
    service?: string;
}

/**
 * Parse `bun call git` arguments: only leading `-i/-s` options (before the stack) are CLI options;
 * everything after the stack is git's and is forwarded unchanged, including `-s`, `-b`, `-i` and `--`.
 * A single trailing argument keeps the documented quoted form (`"log --oneline -5"`).
 */
export function parseGitCliArgs(args: string[]): GitCliArgs | null {
    let instance: string | undefined;
    let service: string | undefined;
    let i = 0;
    for (; i < args.length && args[i].startsWith("-"); i++) {
        const arg = args[i];
        const eq = arg.indexOf("=");
        const flag = eq > 0 ? arg.slice(0, eq) : arg;
        let value: string | undefined;
        if (eq > 0 && flag.startsWith("--")) value = arg.slice(eq + 1);
        else value = args[++i];
        if (value === undefined) return null;
        if (flag === "-i" || flag === "--instance") instance = value;
        else if (flag === "-s" || flag === "--service") service = value;
        else return null;
    }
    const stack = args[i];
    const gitArgs = args.slice(i + 1);
    if (!stack || gitArgs.length === 0) return null;
    const command = gitArgs.length === 1 ? gitArgs[0] : gitArgs.map(shellQuote).join(" ");
    return { stack, command, instance, service };
}
