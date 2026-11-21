import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execRemoteGit, pushLinkedRepository, pullViaFetchAndLocalMerge } from "./register.js";
import { buildKeylessGitDockerArgs, validateRemoteUrl, planPinnedRemoteGit, parseRemoteDefaultBranch, STAGE_SANITIZE_SCRIPT } from "./pinned-git.js";

const PINNED = "git@github.com:acme/app.git";
const EVIL = "git@evil.example:x/stolen.git";

type Call = { args: string[] };

function makeDeps() {
    const runs: Call[] = [];
    const docker: string[][] = [];
    return {
        runs,
        docker,
        deps: {
            dockerRun: async (args: string[]) => {
                runs.push({ args });
                return { stdout: "", stderr: "", code: 0 };
            },
            docker: async (args: string[]) => {
                docker.push(args);
                return { status: 0, stdout: "", stderr: "" };
            },
        },
    };
}

type Deps = ReturnType<typeof makeDeps>["deps"];
// The mock only implements the members execRemoteGit touches; the real signatures are wider.
const asDeps = (d: Deps) => d as unknown as Parameters<typeof execRemoteGit>[2];

const hasKeys = (args: string[]) => args.some((a) => a.includes("/tmp/ssh-source"));

let tmp: string;
let prevRequired: string | undefined;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-git-"));
    prevRequired = process.env.GIT_REMOTE_PIN_REQUIRED;
    delete process.env.GIT_REMOTE_PIN_REQUIRED;
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevRequired === undefined) delete process.env.GIT_REMOTE_PIN_REQUIRED;
    else process.env.GIT_REMOTE_PIN_REQUIRED = prevRequired;
});

function opts(repoPath: string) {
    return { repoPath, sshKeysPath: "/host/.ssh", projectName: "proj", remoteUrl: PINNED };
}

describe("pinned remote: keyed container isolation", () => {
    it("pins the URL, never mounts or targets the agent repo, and ignores a poisoned .git/config", async () => {
        const repo = path.join(tmp, "repo");
        fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
        fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = ${EVIL}\n\tpushurl = ${EVIL}\n[url "${EVIL}"]\n\tinsteadOf = ${PINNED}\n`);
        const { runs, deps } = makeDeps();
        await execRemoteGit(["fetch", "origin", "main"], opts(repo), asDeps(deps));

        const keyed = runs.filter((r) => hasKeys(r.args));
        expect(keyed.length).toBeGreaterThan(0);
        for (const { args } of keyed) {
            expect(args).toContain(PINNED);
            expect(args.join(" ")).not.toContain(repo);
            expect(args.join(" ")).not.toContain("/workspace");
            expect(args.some((a) => a.startsWith("GIT_DIR="))).toBe(false);
            expect(args.indexOf("-C")).toBe(-1);
            expect(args).toContain("GIT_ALLOW_PROTOCOL=ssh");
            expect(args).toContain("GIT_CONFIG_NOSYSTEM=1");
            expect(args).toContain("1000:1000");
        }
        expect(runs.flatMap((r) => r.args).some((a) => a.includes("evil"))).toBe(false);
    });

    it("keyless steps have no network and no keys", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "main"], opts("/host/repo"), asDeps(deps));
        const keyless = runs.filter((r) => r.args.some((a) => a === "/host/repo:/workspace"));
        expect(keyless.length).toBeGreaterThan(0);
        for (const { args } of keyless) {
            expect(hasKeys(args)).toBe(false);
            expect(args.join(" ")).toContain("--network none");
        }
    });

    it("push goes agent repo -> stage (keyless) then stage -> pinned URL (keyed)", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "develop"], opts("/host/repo"), asDeps(deps));
        const pushes = runs.filter((r) => r.args.includes("push"));
        expect(pushes).toHaveLength(2);
        expect(hasKeys(pushes[0].args)).toBe(false);
        expect(pushes[0].args).toContain("file:///stage/repo");
        expect(hasKeys(pushes[1].args)).toBe(true);
        expect(pushes[1].args).toContain(PINNED);
        expect(pushes[1].args.some((a) => a.includes("refs/heads/develop"))).toBe(true);
    });

    it("removes the staging volume afterwards", async () => {
        const { docker, deps } = makeDeps();
        await execRemoteGit(["fetch", "origin", "main"], opts("/host/repo"), asDeps(deps));
        expect(docker.some((a) => a[0] === "volume" && a[1] === "rm")).toBe(true);
    });
});

describe("pinned remote: staging repo is not trusted after keyless steps", () => {
    it("keyless stage push/fetch/clone pass box-set pack programs", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "develop"], opts("/host/repo"), asDeps(deps));
        await execRemoteGit(["fetch", "origin", "develop"], opts("/host/repo"), asDeps(deps));
        await execRemoteGit(["clone", PINNED, "dest"], opts("/host/repo"), asDeps(deps));
        const stageCalls = runs.filter((r) => !hasKeys(r.args) && r.args.includes("file:///stage/repo"));
        expect(stageCalls).toHaveLength(3);
        for (const { args } of stageCalls) {
            if (args.includes("push")) expect(args).toContain("--receive-pack=git-receive-pack");
            else expect(args).toContain("--upload-pack=git-upload-pack");
            // option must precede the URL so it overrides remote.<url>.receivepack/uploadpack
            expect(args.findIndex((a) => a.startsWith("--") && a.endsWith("-pack=git-" + (args.includes("push") ? "receive-pack" : "upload-pack")))).toBeLessThan(args.indexOf("file:///stage/repo"));
        }
    });

    it("push origin +branch forwards the force marker to the keyed push only for that refspec", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "+feature:feature", "other"], opts("/host/repo"), asDeps(deps));
        const keyedPush = runs.find((r) => hasKeys(r.args) && r.args.includes("push"))!;
        expect(keyedPush.args).toContain("+refs/stage/0:refs/heads/feature");
        expect(keyedPush.args).toContain("refs/stage/1:refs/heads/other");
    });

    it("keyed steps reset the staging config and hooks before running git", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "develop"], opts("/host/repo"), asDeps(deps));
        const keyedPush = runs.find((r) => hasKeys(r.args) && r.args.includes("push"))!;
        const script = keyedPush.args[keyedPush.args.indexOf("-c") + 1];
        const reset = script.indexOf("rm -rf /stage/repo/config");
        expect(reset).toBeGreaterThan(-1);
        expect(script).toContain("/stage/repo/hooks");
        expect(script).toContain("bare = true");
        expect(script).toContain("! -L /stage/repo");
        expect(reset).toBeLessThan(script.indexOf('exec git "$@"'));
    });

    it("rewriting the staging config cannot be observed by the keyed script", () => {
        const dir = fs.mkdtempSync(path.join(tmp, "stage-"));
        const repo = path.join(dir, "repo");
        fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
        fs.writeFileSync(path.join(repo, "config"), `[url "${EVIL}"]\n\tinsteadOf = ${PINNED}\n`);
        const script = STAGE_SANITIZE_SCRIPT.split("/stage/repo").join(repo);
        const res = Bun.spawnSync(["sh", "-c", script]);
        expect(res.exitCode).toBe(0);
        const cfg = fs.readFileSync(path.join(repo, "config"), "utf8");
        expect(cfg).not.toContain("insteadOf");
        expect(cfg).not.toContain("evil");
        expect(fs.existsSync(path.join(repo, "hooks"))).toBe(false);
    });
});

describe("pinned clone checks out the remote default branch", () => {
    it("clones with --branch=<remote HEAD> because the stage HEAD is unborn", async () => {
        const { runs, deps } = makeDeps();
        deps.dockerRun = async (args: string[]) => {
            runs.push({ args });
            const stdout = args.includes("ls-remote") ? "ref: refs/heads/main\tHEAD\nabc123\tHEAD\n" : "";
            return { stdout, stderr: "", code: 0 };
        };
        await execRemoteGit(["clone", PINNED], opts("/host/repo"), asDeps(deps));
        const clone = runs.find((r) => r.args.includes("clone"))!;
        expect(hasKeys(clone.args)).toBe(false);
        expect(clone.args).toContain("--branch=main");
        expect(clone.args.indexOf("--branch=main")).toBeLessThan(clone.args.indexOf("file:///stage/repo"));
    });

    it("returns the keyed fetch failure without cloning the empty stage", async () => {
        const { runs, deps } = makeDeps();
        deps.dockerRun = async (args: string[]) => {
            runs.push({ args });
            const failed = args.includes("fetch");
            return { stdout: "", stderr: failed ? "Permission denied (publickey)" : "", code: failed ? 128 : 0 };
        };
        const result = await execRemoteGit(["clone", PINNED, "dest"], opts("/host/repo"), asDeps(deps));
        expect(result.code).toBe(128);
        expect(result.stderr).toContain("Permission denied");
        expect(runs.some((r) => r.args.includes("clone"))).toBe(false);
        expect(runs.some((r) => r.args.includes("set-url"))).toBe(false);
    });

    it("only accepts plain branch names from the remote's symref", () => {
        expect(parseRemoteDefaultBranch("ref: refs/heads/release/1.x\tHEAD\nabc\tHEAD\n")).toBe("release/1.x");
        expect(parseRemoteDefaultBranch("abc\tHEAD\n")).toBeUndefined();
        expect(parseRemoteDefaultBranch("ref: refs/heads/--upload-pack=x\tHEAD\n")).toBeUndefined();
        expect(parseRemoteDefaultBranch("ref: refs/heads/a..b\tHEAD\n")).toBeUndefined();
    });
});

describe("pinned pull and HEAD push", () => {
    it("pinned pull without an explicit ref is rejected before any fetch", async () => {
        for (const pull of [["pull"], ["pull", "origin"], ["pull", "--rebase"], ["pull", "--rebase", "origin"]]) {
            const calls: string[][] = [];
            const fetch = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
            await expect(pullViaFetchAndLocalMerge(pull, fetch, fetch, { requireExplicitRef: true })).rejects.toThrow("explicit ref");
            expect(calls).toEqual([]);
        }
    });
    it("pinned pull with remote and ref still works; unpinned pull without ref is unchanged", async () => {
        const calls: string[][] = [];
        const fetch = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
        await pullViaFetchAndLocalMerge(["pull", "origin", "develop"], fetch, fetch, { requireExplicitRef: true });
        await pullViaFetchAndLocalMerge(["pull"], fetch, fetch);
        expect(calls[0]).toEqual(["fetch", "origin", "develop"]);
        expect(calls).toHaveLength(4);
    });
    it("push origin HEAD / push -u origin HEAD never reaches refs/heads/HEAD", async () => {
        for (const argv of [["push", "origin", "HEAD"], ["push", "-u", "origin", "HEAD"]]) {
            const { runs, deps } = makeDeps();
            await expect(execRemoteGit(argv, opts("/host/repo"), asDeps(deps))).rejects.toThrow("bare HEAD");
            expect(runs.flatMap((r) => r.args).some((a) => a.includes("refs/heads/HEAD") || a.includes("branch.HEAD"))).toBe(false);
        }
    });
    it("push origin HEAD:feat is allowed and upstream is keyed on the local HEAD branch", () => {
        const plan = planPinnedRemoteGit(["push", "-u", "origin", "HEAD:feat"], PINNED);
        expect("error" in plan).toBe(false);
        if (!("error" in plan) && plan.kind === "push") {
            expect(plan.pushes).toEqual([{ src: "HEAD", dst: "refs/heads/feat", force: false }]);
            expect(plan.upstream).toEqual([{ local: "HEAD", remote: "refs/heads/feat" }]);
        }
    });
    it("push -u mylocal:feat configures upstream on mylocal, tracking feat", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "-u", "origin", "mylocal:feat"], opts("/host/repo"), asDeps(deps));
        const configs = runs.map((r) => r.args).filter((a) => a.includes("config")).map((a) => a.slice(a.indexOf("config") + 1));
        expect(configs).toEqual([["branch.mylocal.remote", "origin"], ["branch.mylocal.merge", "refs/heads/feat"]]);
    });
    it("push -u HEAD:feat configures the checked-out branch, and nothing on a detached HEAD", async () => {
        for (const [head, expected] of [["mylocal\n", [["branch.mylocal.remote", "origin"], ["branch.mylocal.merge", "refs/heads/feat"]]], ["", []]] as const) {
            const { runs, deps } = makeDeps();
            const dockerRun = async (args: string[]) => {
                runs.push({ args });
                return args.includes("symbolic-ref") ? { stdout: head, stderr: "", code: head ? 0 : 1 } : { stdout: "", stderr: "", code: 0 };
            };
            await execRemoteGit(["push", "-u", "origin", "HEAD:feat"], opts("/host/repo"), asDeps({ ...deps, dockerRun }));
            const configs = runs.map((r) => r.args).filter((a) => a.includes("config")).map((a) => a.slice(a.indexOf("config") + 1));
            expect(configs).toEqual(expected as unknown as string[][]);
        }
    });
    it("a failed push -u sets no upstream config", async () => {
        const { runs, deps } = makeDeps();
        const dockerRun = async (args: string[]) => {
            runs.push({ args });
            return hasKeys(args) && args.includes("push") ? { stdout: "", stderr: "rejected", code: 1 } : { stdout: "", stderr: "", code: 0 };
        };
        const result = await execRemoteGit(["push", "-u", "origin", "mylocal:feat"], opts("/host/repo"), asDeps({ ...deps, dockerRun }));
        expect(result.code).toBe(1);
        expect(runs.some((r) => r.args.includes("config"))).toBe(false);
    });
});

describe("pinned remote: argv URL rejection", () => {
    it("rejects a different URL on push", async () => {
        const { runs, deps } = makeDeps();
        await expect(execRemoteGit(["push", EVIL, "main"], opts("/host/repo"), asDeps(deps))).rejects.toThrow("pinned remoteUrl");
        expect(runs).toHaveLength(0);
    });
    it("rejects other remote names and URLs on fetch/ls-remote/clone", () => {
        expect("error" in planPinnedRemoteGit(["fetch", "upstream"], PINNED)).toBe(true);
        expect("error" in planPinnedRemoteGit(["fetch", EVIL, "main"], PINNED)).toBe(true);
        expect("error" in planPinnedRemoteGit(["ls-remote", EVIL], PINNED)).toBe(true);
        expect("error" in planPinnedRemoteGit(["clone", "origin"], PINNED)).toBe(true);
        expect("error" in planPinnedRemoteGit(["clone", EVIL], PINNED)).toBe(true);
    });
    it("accepts origin or the exact pinned URL", () => {
        expect("error" in planPinnedRemoteGit(["fetch", "origin", "main"], PINNED)).toBe(false);
        expect("error" in planPinnedRemoteGit(["push", PINNED, "main"], PINNED)).toBe(false);
        expect("error" in planPinnedRemoteGit(["clone", PINNED], PINNED)).toBe(false);
    });
});

describe("GIT_REMOTE_PIN_REQUIRED", () => {
    beforeEach(() => { process.env.GIT_REMOTE_PIN_REQUIRED = "true"; });
    const unpinned = { repoPath: "/host/repo", sshKeysPath: "/host/.ssh", projectName: "proj" };

    it("refuses push/fetch/pull-fetch/worktree fast-forward/merge autoPush argv without remoteUrl", async () => {
        const { runs, deps } = makeDeps();
        for (const argv of [
            ["push", "origin", "develop"],
            ["fetch", "origin"],
            ["fetch", "origin", "develop"], // worktree add/reset fast-forward fetch
            ["push", "origin", "main"], // merge autoPush
        ]) {
            await expect(execRemoteGit(argv, unpinned, asDeps(deps))).rejects.toThrow("[SECURITY] remote URL not pinned");
        }
        expect(runs).toHaveLength(0);
    });

    it("skips linked pushes", async () => {
        const repository: Record<string, unknown> = { name: "r", localRepo: "/repo", base: "develop" };
        const calls: string[][] = [];
        await pushLinkedRepository(repository, "develop", "/keys", undefined, {
            exec: async (argv: string[]) => { calls.push(argv); return { stdout: "", stderr: "", code: 0 }; },
            validateRepo: async () => null,
        });
        expect(calls).toEqual([]);
        expect(repository.pushed).toBe(false);
    });

    it("still allows a pinned op", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["fetch", "origin", "main"], { ...unpinned, remoteUrl: PINNED }, asDeps(deps));
        expect(runs.length).toBeGreaterThan(0);
    });
});

describe("default (GIT_REMOTE_PIN_REQUIRED unset)", () => {
    it("keeps unpinned behaviour: agent repo mounted, argv passed through", async () => {
        const { runs, deps } = makeDeps();
        await execRemoteGit(["push", "origin", "develop"], { repoPath: "/host/repo", sshKeysPath: "/host/.ssh", projectName: "proj" }, asDeps(deps));
        expect(runs).toHaveLength(1);
        expect(runs[0].args).toContain("/host/repo:/workspace");
        expect(runs[0].args.slice(runs[0].args.indexOf("git-ssh") + 1)).toEqual(["push", "origin", "develop"]);
    });

    it("runs linked pushes unchanged", async () => {
        const repository: Record<string, unknown> = { name: "r", localRepo: "/repo", base: "develop" };
        const calls: string[][] = [];
        await pushLinkedRepository(repository, "develop", "/keys", undefined, {
            exec: async (argv: string[]) => { calls.push(argv); return { stdout: "", stderr: "", code: 0 }; },
            validateRepo: async () => null,
        });
        expect(calls).toHaveLength(1);
        expect(repository.pushed).toBe(true);
    });
});

describe("remoteUrl validation", () => {
    for (const bad of ["-oProxyCommand=x", "ext::sh -c x", "ext::sh", "file:///", "file:///etc/passwd", "git@host:a b", "git@host:a\nb", "git@-host:a", "ssh://-oProxyCommand=x/a", "", "https://github.com/a/b.git"]) {
        it(`rejects ${JSON.stringify(bad)}`, () => {
            expect(validateRemoteUrl(bad)).not.toBeNull();
        });
    }
    for (const good of [PINNED, "ssh://git@host.example:2222/acme/app.git", "ssh://host/a/b"]) {
        it(`accepts ${good}`, () => {
            expect(validateRemoteUrl(good)).toBeNull();
        });
    }
    it("execRemoteGit rejects an invalid remoteUrl before running docker", async () => {
        const { runs, docker, deps } = makeDeps();
        await expect(execRemoteGit(["fetch", "origin"], { repoPath: "/r", sshKeysPath: "/k", remoteUrl: "-oProxyCommand=x" }, asDeps(deps))).rejects.toThrow("Invalid remoteUrl");
        expect(runs).toHaveLength(0);
        expect(docker).toHaveLength(0);
    });
});

describe("buildKeylessGitDockerArgs volume subpath", () => {
    it("mounts only the repo subpath of a pinned volume", () => {
        const args = buildKeylessGitDockerArgs(["fetch"], { repoPath: "carapa-mount-bbb", repoSubpath: "carapa-brain" }, []);
        expect(args).toContain("type=volume,src=carapa-mount-bbb,dst=/workspace,volume-subpath=carapa-brain,volume-nocopy");
        expect(args).not.toContain("carapa-mount-bbb:/workspace");
    });
    it("keeps the plain -v mount without a subpath", () => {
        for (const repoSubpath of [undefined, "."]) {
            const args = buildKeylessGitDockerArgs(["fetch"], { repoPath: "carapa-mount-bbb", repoSubpath }, []);
            expect(args.slice(0, 2)).toEqual(["-v", "carapa-mount-bbb:/workspace"]);
        }
    });
});
