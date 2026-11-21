import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../stacks/carapa-bot/bin/cleanup-branches.sh");
const root = mkdtempSync(join(tmpdir(), "cleanup-branches-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString();
}

describe("cleanup-branches.sh", () => {
    test("keeps main, master and develop, parses worktree branches, deletes other merged branches", () => {
        const repo = join(root, "repo");
        git(root, "init", "-q", "-b", "main", repo);
        git(repo, "commit", "-q", "--allow-empty", "-m", "base");
        git(repo, "branch", "master");
        git(repo, "branch", "feature-merged");
        git(repo, "branch", "my-develop-notes");
        git(repo, "branch", "linked");
        git(repo, "worktree", "add", "-q", join(root, "linked-wt"), "linked");
        git(repo, "checkout", "-q", "-b", "develop");
        git(repo, "commit", "-q", "--allow-empty", "-m", "dev");
        git(repo, "checkout", "-q", "-b", "unmerged");
        git(repo, "commit", "-q", "--allow-empty", "-m", "wip");
        git(repo, "checkout", "-q", "develop");

        const run = Bun.spawnSync(["bash", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        expect(run.stderr.toString()).not.toContain("error: branch '+");

        const left = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();
        expect(left).toEqual(["develop", "linked", "main", "master", "unmerged"]);
    });
});
