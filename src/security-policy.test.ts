import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test.skipIf(!(process.env.OPA || Bun.which("opa")))("command validation evaluates real stack allows and overriding base denials", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapa-command-policy-"));
    const config = path.join(root, "config");
    const stack = path.join(root, "stack");
    fs.mkdirSync(path.join(config, "policies"), { recursive: true });
    fs.mkdirSync(stack);
    const compile = (source: string, entrypoint: string, output: string) => {
        const bundle = output + ".tar.gz";
        const build = Bun.spawnSync([process.env.OPA || "opa", "build", "-t", "wasm",
            "-e", entrypoint, "-o", bundle, source], { cwd: root, stdout: "pipe", stderr: "pipe" });
        expect(build.exitCode, `OPA compilation failed (install opa or set OPA): ${build.stderr}`).toBe(0);
        const extract = Bun.spawnSync(["tar", "-xOf", bundle, "--wildcards", "*policy.wasm"], {
            stdout: "pipe", stderr: "pipe",
        });
        expect(extract.exitCode, extract.stderr.toString()).toBe(0);
        fs.writeFileSync(output, extract.stdout);
    };
    try {
        compile(path.join(import.meta.dir, "../config/policies/base.rego"),
            "carapabox/base/deny", path.join(config, "policies/base.wasm"));
        compile(path.join(import.meta.dir, "test-fixtures/command-policy.rego"),
            "carapabox/test_stack/result", path.join(stack, "policy.wasm"));
        const cases = [
            { command: "ls -la", allowed: true, policy_name: "test_stack.allow" },
            { command: "pgrep bash", allowed: true, policy_name: "test_stack.allow" },
            { command: "whoami", allowed: false, policy_name: "test_stack.default_deny" },
            // The fixture allows echo; the real base policy must override it.
            { command: "echo $(id)", allowed: false, policy_name: "base.deny" },
            { command: "ls -la | whoami", allowed: false, policy_name: "test_stack.default_deny" },
        ];
        // Other unit tests replace the OPA module globally. A fresh process
        // exercises production imports and WASM with its own disposable config.
        const child = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", `
            const { validateCommand } = await import(${JSON.stringify(new URL("./security.ts", import.meta.url).href)});
            const results = [];
            for (const { command } of ${JSON.stringify(cases)}) {
                results.push(await validateCommand(${JSON.stringify(stack)}, "agent", command));
            }
            console.log(JSON.stringify(results));
        `], {
            cwd: root, stdout: "pipe", stderr: "pipe",
            env: { CARAPA_BOX_CONFIG_DIR: config, NODE_ENV: "production", LOG_LEVEL: "error" },
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        const results = JSON.parse(child.stdout.toString());
        for (const [index, { command, ...expected }] of cases.entries()) {
            expect(results[index], command).toMatchObject(expected);
        }
        expect(results[3].reason).toMatch(/subshell/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
