import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findUnsafeHookEnvKeys, runHook, sanitizeHookEnv } from "./hooks.js";

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeHook(body: string, mode = 0o755) {
    const file = path.join(dir, "before-start.sh");
    fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
    fs.chmodSync(file, mode);
}

describe("runHook", () => {
    it("reports a signal-killed hook as failure", async () => {
        writeHook("echo hi; kill -9 $$");
        const r = await runHook(dir, "before-start");
        expect(r.exitCode).not.toBe(0);
        expect(r.exitCode).toBe(137);
        expect(r.stderr).toContain("SIGKILL");
    });

    it("propagates exit codes", async () => {
        writeHook("exit 3");
        expect((await runHook(dir, "before-start")).exitCode).toBe(3);
    });

    it("returns 0 and stdout on success", async () => {
        writeHook("echo ok");
        const r = await runHook(dir, "before-start");
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("ok");
    });

    it("kills descendants on timeout", async () => {
        const pidFile = path.join(dir, "pid");
        writeHook(`sleep 30 & echo $! > ${pidFile}; wait`);
        const r = await runHook(dir, "before-start", {}, undefined, 300);
        expect(r.exitCode).toBe(124);
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        await new Promise((res) => setTimeout(res, 200));
        expect(() => process.kill(pid, 0)).toThrow();
    });
});

describe("runHook without the executable bit", () => {
    it("runs a 0644 hook without chmod and propagates its exit code", async () => {
        writeHook("exit 7", 0o644);
        const chmod = spyOn(fsp, "chmod").mockRejectedValue(
            Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }),
        );
        try {
            const r = await runHook(dir, "before-start");
            expect(r.executed).toBe(true);
            expect(r.exitCode).toBe(7);
            expect(chmod).not.toHaveBeenCalled();
        } finally {
            chmod.mockRestore();
        }
    });

    it("runs a 0644 hook and returns its stdout", async () => {
        writeHook("echo ok", 0o644);
        const r = await runHook(dir, "before-start");
        expect(r.executed).toBe(true);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("ok");
    });
});

describe("runHook env sanitization", () => {
    it("does not execute BASH_FUNC_ overrides", async () => {
        const marker = path.join(dir, "pwned-func");
        writeHook('echo "hook ran"');
        const r = await runHook(dir, "before-start", {
            "BASH_FUNC_echo%%": `() { id > ${marker}; builtin echo "$@"; }`,
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("hook ran");
        expect(fs.existsSync(marker)).toBe(false);
    });

    it("drops BASH_ENV and LD_PRELOAD and keeps controller PATH", async () => {
        writeHook('echo "${BASH_ENV-unset}|${LD_PRELOAD-unset}|$PATH"');
        const r = await runHook(dir, "before-start", {
            BASH_ENV: "/tmp/evil.sh",
            LD_PRELOAD: "/tmp/evil.so",
            PATH: "/tmp/evil",
        });
        const [bashEnv, ldPreload, hookPath] = r.stdout.split("|");
        // Values are inherited from the controller's own env, never from the caller
        expect(bashEnv).toBe(process.env.BASH_ENV ?? "unset");
        expect(ldPreload).toBe(process.env.LD_PRELOAD ?? "unset");
        expect(hookPath).not.toContain("/tmp/evil");
        expect(hookPath.endsWith(process.env.PATH!)).toBe(true);
    });

    it("passes normal keys through", async () => {
        writeHook('echo "$GIT_REPO|$COMPOSE_PROJECT_NAME|$MY_VAR_1"');
        const r = await runHook(dir, "before-start", {
            GIT_REPO: "https://example.com/r.git",
            COMPOSE_PROJECT_NAME: "proj",
            MY_VAR_1: "v1",
        });
        expect(r.stdout).toBe("https://example.com/r.git|proj|v1");
    });
});

describe("sanitizeHookEnv", () => {
    it("reports dropped keys and keeps safe ones", () => {
        const { env, dropped } = sanitizeHookEnv({
            "BASH_FUNC_x%%": "() { :; }",
            BASH_ENV: "a",
            ENV: "a",
            SHELLOPTS: "a",
            BASHOPTS: "a",
            PS4: "a",
            IFS: "a",
            PATH: "a",
            CDPATH: "a",
            GLOBIGNORE: "a",
            PROMPT_COMMAND: "a",
            LD_PRELOAD: "a",
            DYLD_INSERT_LIBRARIES: "a",
            "1BAD": "a",
            GOOD: "ok",
        });
        expect(env).toEqual({ GOOD: "ok" });
        expect(dropped.sort()).toEqual(
            ["1BAD", "BASH_ENV", "BASHOPTS", "BASH_FUNC_x%%", "CDPATH", "DYLD_INSERT_LIBRARIES", "ENV", "GLOBIGNORE", "IFS", "LD_PRELOAD", "PATH", "PROMPT_COMMAND", "PS4", "SHELLOPTS"].sort(),
        );
    });

    it("handles empty and undefined input", () => {
        expect(sanitizeHookEnv(undefined)).toEqual({ env: {}, dropped: [] });
        expect(sanitizeHookEnv({})).toEqual({ env: {}, dropped: [] });
    });
});

describe("interpreter env keys", () => {
    const interpreterKeys = [
        "BUN_OPTIONS", "bun_options", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH", "DOCKER_HOST", "DOCKER_CONFIG",
        "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_SSH_COMMAND", "npm_config_node_options", "PERL5OPT", "RUBYOPT",
        "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "HOME", "XDG_CONFIG_HOME", "GLIBC_TUNABLES", "SSH_ASKPASS", "SSH_AUTH_SOCK",
    ];

    it("flags and drops every interpreter key but keeps GIT_REPO and SSH_KEYS_FOLDER", () => {
        const input = Object.fromEntries([...interpreterKeys, "GIT_REPO", "SSH_KEYS_FOLDER", "COMPOSE_PROJECT_NAME"].map((k) => [k, "x"]));
        expect(findUnsafeHookEnvKeys(input).sort()).toEqual([...interpreterKeys].sort());
        expect(Object.keys(sanitizeHookEnv(input).env).sort()).toEqual(["COMPOSE_PROJECT_NAME", "GIT_REPO", "SSH_KEYS_FOLDER"]);
    });

    it("does not let BUN_OPTIONS replace the script bun runs from a hook", async () => {
        const bun = Bun.which("bun");
        if (!bun) return;
        const script = path.join(dir, "ran.mjs");
        fs.writeFileSync(script, 'console.log("script ran");');
        writeHook(`'${bun}' '${script}'`);
        const r = await runHook(dir, "before-start", { BUN_OPTIONS: "-e console.log(42)" });
        expect(r.stdout).toBe("script ran");
    });
});
