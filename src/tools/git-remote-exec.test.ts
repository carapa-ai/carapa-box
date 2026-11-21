import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCommandArgv } from "../security.js";
import { buildRemoteGitDockerArgs, validateRemoteGitArgv, planRemotePull, pullViaFetchAndLocalMerge, fastForwardBaseFromRemote } from "./register.js";

const OPTS = { repoPath: "/host/repo", sshKeysPath: "/host/.ssh" };

function argvOf(command: string): string[] {
    const parsed = parseCommandArgv(command);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.argv;
}

function reject(command: string): string | null {
    return validateRemoteGitArgv(argvOf(command));
}

function dockerArgs(command: string): string[] {
    return buildRemoteGitDockerArgs(argvOf(command), OPTS);
}

describe("remote git shell injection", () => {
    it("never places caller text inside the sh -c script", () => {
        expect(parseCommandArgv("fetch; echo pwned").ok).toBe(false);
        expect(parseCommandArgv("fetch $(id)").ok).toBe(false);
        for (const command of ["fetch '$(id)'", "fetch 'a; echo pwned'"]) {
            const args = dockerArgs(command);
            const script = args[args.indexOf("-c") + 1];
            expect(script).not.toContain("pwned");
            expect(script).not.toContain("id)");
            expect(script).toContain('exec git "$@"');
            expect(args.slice(args.indexOf("git-ssh") + 1)).toEqual(argvOf(command));
        }
    });

    it("passes GIT_SSH_COMMAND and protocol hardening via -e", () => {
        const args = dockerArgs("fetch");
        expect(args).toContain("GIT_ALLOW_PROTOCOL=ssh");
        expect(args).toContain("GIT_CONFIG_NOSYSTEM=1");
        expect(args.some((a) => a.startsWith("GIT_SSH_COMMAND=ssh -F /tmp/.ssh/config"))).toBe(true);
        expect(args.find((a) => a.includes("exec git"))).not.toContain("GIT_SSH_COMMAND");
    });
});

describe("remote git option rejection", () => {
    it("rejects -c config overrides", () => {
        expect(reject("-c core.sshCommand=x fetch")).toContain("-c");
    });
    it("rejects --upload-pack on fetch", () => {
        expect(reject("fetch --upload-pack=x")).toContain("--upload-pack");
    });
    it("rejects --receive-pack on push", () => {
        expect(reject("push --receive-pack=x")).toContain("--receive-pack");
    });
    it("rejects clone -u", () => {
        expect(reject("clone -u x url")).toContain("-u");
    });
    it("rejects ext:: and fd:: URLs", () => {
        expect(reject("clone ext::sh -c x")).not.toBeNull();
        expect(reject("clone 'ext::sh -x'")).not.toBeNull();
        expect(reject("fetch fd::3")).not.toBeNull();
    });
    it("rejects --config-env and --exec", () => {
        expect(reject("--config-env=core.sshCommand=X fetch")).not.toBeNull();
        expect(reject("clone --exec=x")).not.toBeNull();
    });
    it("rejects abbreviated long options", () => {
        expect(reject("fetch --upload=x")).not.toBeNull();
        expect(reject("clone --u=x url")).not.toBeNull();
        expect(reject("clone --up=x url")).not.toBeNull();
        expect(reject("push --e=x origin")).not.toBeNull();
        expect(reject("push --ex=x origin")).not.toBeNull();
    });
    it("still allows full option names that are not blocked prefixes", () => {
        expect(reject("push --repo=origin")).toBeNull();
        expect(reject("fetch --update-head-ok")).toBeNull();
        expect(reject("push --set-upstream origin feat")).toBeNull();
    });
});

describe("remote git accepted commands", () => {
    it("allows push -u and fetch -u", () => {
        expect(reject("push -u origin feat")).toBeNull();
        expect(reject("fetch -u")).toBeNull();
    });

    it("produces expected argv for caller commands", () => {
        const cases: Array<[string, string[]]> = [
            ["push -u origin feat", ["push", "-u", "origin", "feat"]],
            ["push origin develop", ["push", "origin", "develop"]],
            ["-C '/workspace/a b' fetch origin", ["-C", "/workspace/a b", "fetch", "origin"]],
            ["pull origin develop", ["pull", "origin", "develop"]],
            ["status", ["status"]],
            ["log --oneline -5", ["log", "--oneline", "-5"]],
        ];
        for (const [command, expected] of cases) {
            expect(reject(command)).toBeNull();
            const args = dockerArgs(command);
            expect(args.slice(args.indexOf("git-ssh") + 1)).toEqual(expected);
        }
    });
});

describe("localRepo allowlist", () => {
    it("rejects outside and accepts inside the allowlist", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-localrepo-"));
        try {
            const allowed = path.join(dir, "allowed");
            const outside = path.join(dir, "outside");
            fs.mkdirSync(path.join(allowed, "repo"), { recursive: true });
            fs.mkdirSync(outside);
            fs.mkdirSync(path.join(dir, "config"));
            fs.writeFileSync(path.join(dir, "config", "mount-allowlist.yaml"), `allowed:\n  - ${allowed}\n`);
            const script = `import { validateLocalRepoArg } from ${JSON.stringify(path.resolve(import.meta.dir, "register.ts"))};
console.log(JSON.stringify([await validateLocalRepoArg(${JSON.stringify(path.join(allowed, "repo"))}), await validateLocalRepoArg(${JSON.stringify(outside)})]));`;
            const scriptPath = path.join(dir, "check.ts");
            fs.writeFileSync(scriptPath, script);
            const result = Bun.spawnSync(["bun", scriptPath], {
                env: { ...process.env, CARAPA_BOX_CONFIG_DIR: path.join(dir, "config") },
            });
            const lines = result.stdout.toString().trim().split("\n");
            const [inside, out] = JSON.parse(lines[lines.length - 1]);
            expect(inside).toBeNull();
            expect(out).toContain("not in the mount allowlist");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

function envOf(args: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-e") continue;
        const [k, ...v] = args[i + 1].split("=");
        env[k] = v.join("=");
    }
    return env;
}

describe("remote git config overrides", () => {
    it("sets every GIT_CONFIG override and hardening env", () => {
        const env = envOf(dockerArgs("fetch"));
        const pairs: Record<string, string> = {};
        for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
            pairs[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
        }
        expect(pairs).toEqual({
            "core.hooksPath": "/dev/null",
            "core.fsmonitor": "false",
            "core.alternateRefsCommand": "",
            "submodule.recurse": "false",
            "fetch.recurseSubmodules": "false",
            "push.recurseSubmodules": "no",
            "push.gpgSign": "false",
            "gc.auto": "0",
            "maintenance.auto": "false",
        });
        expect(env.GIT_EDITOR).toBe(":");
        expect(env.GIT_SEQUENCE_EDITOR).toBe(":");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_ALLOW_PROTOCOL).toBe("ssh");
    });

    it("runs no planted repo program during fetch or push", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-planted-"));
        try {
            const run = (cwd: string, env: Record<string, string>, ...a: string[]) =>
                Bun.spawnSync(["git", ...a], { cwd, env });
            const base = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
            const remote = path.join(dir, "remote.git");
            const repo = path.join(dir, "repo");
            run(dir, base, "init", "--bare", remote);
            run(dir, base, "init", repo);
            run(repo, base, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "x");
            const marker = (n: string) => path.join(dir, `marker-${n}`);
            const touch = (n: string) => `touch ${marker(n)}`;
            fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
            for (const hook of ["pre-push", "reference-transaction", "post-merge", "pre-auto-gc"]) {
                const hp = path.join(repo, ".git", "hooks", hook);
                fs.writeFileSync(hp, `#!/bin/sh\n${touch("hook-" + hook)}\n`, { mode: 0o755 });
            }
            fs.writeFileSync(path.join(dir, "fsm.sh"), `#!/bin/sh\n${touch("fsmonitor")}\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(dir, "alt.sh"), `#!/bin/sh\n${touch("alt")}\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(dir, "proxy.sh"), `#!/bin/sh\n${touch("proxy")}\nexit 1\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(dir, "ssh.sh"), `#!/bin/sh\nshift\neval "$@"\n`, { mode: 0o755 });
            fs.appendFileSync(path.join(repo, ".git", "config"), `[core]\n\tfsmonitor = ${path.join(dir, "fsm.sh")}\n\thooksPath = ${path.join(repo, ".git", "hooks")}\n\tgitProxy = ${path.join(dir, "proxy.sh")}\n`);
            fs.appendFileSync(repo + "/.git/config", `[core]\n\talternateRefsCommand = ${path.join(dir, "alt.sh")}\n`);
            const env = { ...base, ...envOf(dockerArgs("fetch")), GIT_SSH_COMMAND: path.join(dir, "ssh.sh") };
            const url = `ssh://host${remote}`;
            run(repo, env, "push", url, "HEAD:refs/heads/main");
            run(repo, env, "fetch", url, "main");
            run(repo, env, "fetch", "git://example.invalid/x.git");
            const created = fs.readdirSync(dir).filter((f) => f.startsWith("marker-"));
            expect(created).toEqual([]);
            // sanity: without overrides the planted hook does run
            const bare = { ...base, GIT_SSH_COMMAND: path.join(dir, "ssh.sh") };
            run(repo, bare, "push", url, "HEAD:refs/heads/other");
            expect(fs.readdirSync(dir).some((f) => f.startsWith("marker-"))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("internal worktree add/reset base pull", () => {
    const ok = { code: 0, stdout: "", stderr: "" };

    it("sends only fetch to the keyed container and ff-only merge to the service", async () => {
        const remote: string[][] = [];
        const local: string[][] = [];
        await fastForwardBaseFromRemote("develop",
            async (a) => { remote.push(a); return ok; },
            async (a) => { local.push(a); return ok; });
        expect(remote).toEqual([["fetch", "origin", "develop"]]);
        expect(local.map((a) => a.join(" "))).toEqual(["merge --no-edit --ff-only FETCH_HEAD"]);
    });

    it("does not merge a stale FETCH_HEAD when the fetch fails", async () => {
        const local: string[][] = [];
        const r = await fastForwardBaseFromRemote("develop",
            async () => ({ code: 128, stdout: "", stderr: "auth" }),
            async (a) => { local.push(a); return ok; });
        expect(r.code).toBe(128);
        expect(local).toEqual([]);
    });
});

describe("remote git pull never checks out in the keyed container", () => {
    it("plans fetch + local merge for the carapa-board form", () => {
        const plan = planRemotePull(argvOf("pull origin develop"));
        expect(plan).toEqual({ ok: true, fetchArgv: ["fetch", "origin", "develop"], localArgv: ["merge", "--no-edit", "--ff-only", "FETCH_HEAD"] });
    });

    it("keeps flags and supports rebase", () => {
        expect(planRemotePull(["pull", "--ff-only", "origin", "main"])).toEqual({ ok: true, fetchArgv: ["fetch", "origin", "main"], localArgv: ["merge", "--no-edit", "--ff-only", "FETCH_HEAD"] });
        expect(planRemotePull(["pull", "--no-ff", "origin"])).toMatchObject({ ok: true, localArgv: ["merge", "--no-edit", "--no-ff", "FETCH_HEAD"] });
        expect(planRemotePull(["pull", "--rebase", "origin", "main"])).toMatchObject({ ok: true, localArgv: ["rebase", "FETCH_HEAD"] });
        expect(planRemotePull(["pull", "--no-rebase", "origin"])).toMatchObject({ ok: true, localArgv: ["merge", "--no-edit", "--ff-only", "FETCH_HEAD"] });
    });

    it("defaults to --ff-only, keeps explicit --ff / --no-ff, leaves rebase alone", () => {
        expect(planRemotePull(["pull", "origin", "develop"]).ok && (planRemotePull(["pull", "origin", "develop"]) as { localArgv: string[] }).localArgv).toEqual(["merge", "--no-edit", "--ff-only", "FETCH_HEAD"]);
        expect(planRemotePull(["pull", "--ff", "origin"])).toMatchObject({ ok: true, localArgv: ["merge", "--no-edit", "--ff", "FETCH_HEAD"] });
        expect(planRemotePull(["pull", "--no-ff", "origin"])).toMatchObject({ ok: true, localArgv: ["merge", "--no-edit", "--no-ff", "FETCH_HEAD"] });
        expect(planRemotePull(["pull", "--rebase", "origin"])).toMatchObject({ ok: true, localArgv: ["rebase", "FETCH_HEAD"] });
    });

    it("real repos: divergent plain pull fails without a merge commit; fast-forward succeeds", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pull-ff-"));
        const git = (cwd: string, ...a: string[]) => {
            const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd });
            return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
        };
        const commit = (cwd: string, f: string) => { fs.writeFileSync(path.join(cwd, f), f); git(cwd, "add", "."); git(cwd, "commit", "-m", f); };
        try {
            const origin = path.join(root, "origin");
            const local = path.join(root, "local");
            fs.mkdirSync(origin);
            git(origin, "init", "-b", "develop");
            commit(origin, "base");
            git(root, "clone", origin, local);
            const run = (cwd: string) => pullViaFetchAndLocalMerge(["pull", "origin", "develop"],
                async (a) => { const r = git(cwd, ...a); return { code: r.code, stdout: r.out, stderr: r.err }; },
                async (a) => { const r = git(cwd, ...a); return { code: r.code, stdout: r.out, stderr: r.err }; });
            // fast-forward case
            commit(origin, "o1");
            expect((await run(local)).code).toBe(0);
            expect(fs.existsSync(path.join(local, "o1"))).toBe(true);
            // divergent case
            commit(origin, "o2");
            commit(local, "l1");
            const head = git(local, "rev-parse", "HEAD").out;
            expect((await run(local)).code).not.toBe(0);
            expect(git(local, "rev-parse", "HEAD").out).toBe(head);
            expect(git(local, "log", "--merges", "--oneline").out).toBe("");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("only fetch goes to the keyed container; merge goes to the service", async () => {
        const remoteCalls: string[][] = [];
        const localCalls: string[][] = [];
        const ok = { code: 0, stdout: "", stderr: "" };
        await pullViaFetchAndLocalMerge(["pull", "--ff-only", "origin", "main"],
            async (a) => { remoteCalls.push(a); return ok; },
            async (a) => { localCalls.push(a); return ok; });
        expect(remoteCalls).toEqual([["fetch", "origin", "main"]]);
        expect(localCalls).toEqual([["merge", "--no-edit", "--ff-only", "FETCH_HEAD"]]);
    });

    it("skips the local merge when fetch fails", async () => {
        const localCalls: string[][] = [];
        const r = await pullViaFetchAndLocalMerge(["pull", "origin", "main"],
            async () => ({ code: 1, stdout: "", stderr: "boom" }),
            async (a) => { localCalls.push(a); return { code: 0, stdout: "", stderr: "" }; });
        expect(r.code).toBe(1);
        expect(localCalls).toEqual([]);
    });

    it("finds the pull subcommand by position, not by value", () => {
        for (const globalOpt of ["-C", "--git-dir", "--work-tree"]) {
            const argv = globalOpt === "-C" ? [globalOpt, "pull", "pull", "origin", "main"] : [`${globalOpt}`, "pull", "pull", "origin", "main"];
            const plan = planRemotePull(argv);
            expect(plan).toEqual({ ok: true, fetchArgv: [globalOpt, "pull", "fetch", "origin", "main"], localArgv: [globalOpt, "pull", "merge", "--no-edit", "--ff-only", "FETCH_HEAD"] });
            expect(plan.ok && plan.fetchArgv[2]).toBe("fetch");
        }
        expect(planRemotePull(["-C", "pull", "fetch", "origin"]).ok).toBe(false);
    });

    it("rejects unsupported pull options", () => {
        const plan = planRemotePull(["pull", "--autostash", "origin"]);
        expect(plan.ok).toBe(false);
        expect(!plan.ok && plan.reason).toContain("use fetch, then merge locally");
        expect(planRemotePull(["pull", "-s", "ours", "origin"]).ok).toBe(false);
    });

    it("rejects --exec-path", () => {
        expect(reject("--exec-path=/tmp/x fetch")).toContain("--exec-path");
        expect(reject("fetch --exec-path=/tmp/x")).toContain("--exec-path");
    });
});

describe("buildRemoteGitDockerArgs volume subpath", () => {
    it("mounts only the repo subpath of a volume", () => {
        const args = buildRemoteGitDockerArgs(["fetch"], { repoPath: "carapa-mount-bbb", repoSubpath: "carapa-brain", sshKeysPath: "/host/.ssh" });
        expect(args).toContain("type=volume,src=carapa-mount-bbb,dst=/workspace,volume-subpath=carapa-brain,volume-nocopy");
        expect(args).not.toContain("carapa-mount-bbb:/workspace");
    });
    it("is unchanged without a subpath", () => {
        const args = buildRemoteGitDockerArgs(["fetch"], OPTS);
        expect(args.slice(0, 2)).toEqual(["-v", "/host/repo:/workspace"]);
    });
});
