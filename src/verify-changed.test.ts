/**
 * Runs the real scripts/verify-changed.sh inside throw-away git repos and
 * checks which phases it dispatches and how it exits.
 */
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptsDir = path.resolve(import.meta.dir, "../scripts");
// The public snapshot ships verify-changed.sh without the private name list; the gate is then off.
const HAS_NAME_LIST = fs.existsSync(path.join(scriptsDir, "public-name-check.sh"));
const tempRoots: string[] = [];

const TEST_A = `import { expect, test } from "bun:test";
import { a } from "./a.js";
test("a", () => expect(a).toBe(1));
`;
const TEST_B = `import { expect, test } from "bun:test";
import { a } from "./a.js";
test("b", () => expect(a).toBeGreaterThan(0));
`;
const TEST_SH = `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
test("sh", () => expect(existsSync(resolve(import.meta.dir, "../scripts/tool.sh"))).toBe(true));
`;
const TEST_C = `import { expect, test } from "bun:test";
test("c", () => expect(1).toBe(1));
`;

function run(cwd: string, home: string, command: string[], extraEnv: Record<string, string> = {}) {
    const result = Bun.spawnSync(command, {
        cwd,
        env: {
            ...extraEnv,
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            HOME: home,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.com",
        },
    });
    return {
        status: result.exitCode,
        output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
}

/** Creates a repo whose `develop` branch holds the real scripts, then branches off it. */
function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-changed-"));
    tempRoots.push(root);
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.mkdirSync(home);
    const files: Record<string, string> = {
        "package.json": JSON.stringify({
            scripts: { typecheck: "echo typecheck-ok", "knip:gate": "echo knip-ok", "policy:test": "echo policy-ok" },
        }),
        "README.md": "# demo\n",
        "src/a.ts": "export const a = 1;\n",
        "src/a.test.ts": TEST_A,
        "src/b.test.ts": TEST_B,
        "src/c.test.ts": TEST_C,
        "src/tool-script.test.ts": TEST_SH,
        "scripts/tool.sh": "#!/bin/sh\necho tool\n",
    };
    for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(repo, file), content);
    }
    const scripts = ["verify-changed.sh", "verify-changed-importers.ts"];
    if (HAS_NAME_LIST) {
        scripts.push("public-name-check.sh");
        fs.writeFileSync(path.join(repo, ".publicignore"), "ignored/\n");
    }
    for (const script of scripts) {
        fs.copyFileSync(path.join(scriptsDir, script), path.join(repo, "scripts", script));
    }
    const git = (...args: string[]) => run(repo, home, ["git", ...args]);
    git("init", "-q", "-b", "develop");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    return {
        repo,
        git,
        write: (file: string, content: string) => fs.writeFileSync(path.join(repo, file), content),
        verify: (env: Record<string, string> = {}) =>
            run(repo, home, ["bash", "scripts/verify-changed.sh"], env),
    };
}

afterAll(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("scripts/verify-changed.sh", () => {
    it("runs no gates for a docs-only diff", () => {
        const { write, verify } = makeRepo();
        write("README.md", "# demo\n\nmore docs\n");
        const { status, output } = verify();
        expect(status).toBe(0);
        expect(output).toContain("docs-only");
        expect(output).not.toContain("==> typecheck");
        expect(output).toContain("VERIFY CHANGED: PASS");
    });

    it("selects the colocated test and the direct importer of a changed source", () => {
        const { write, verify } = makeRepo();
        write("src/a.ts", "export const a = 1;\nexport const extra = 2;\n");
        const { status, output } = verify();
        expect(status).toBe(0);
        expect(output).toContain("==> typecheck");
        expect(output).toContain("src/a.test.ts");
        expect(output).toContain("src/b.test.ts");
        expect(output).not.toContain("src/c.test.ts");
        expect(output).not.toContain("full suite");
        expect(output).toContain("VERIFY CHANGED: PASS (tests: 2 test file(s)");
        expect(output).toContain("policy:test (no .rego change)");
    });

    it("selects the test that reaches a changed shell script by path", () => {
        const { write, verify } = makeRepo();
        write("scripts/tool.sh", "#!/bin/sh\necho changed\n");
        const { status, output } = verify();
        expect(status).toBe(0);
        expect(output).toContain("selected: ./src/tool-script.test.ts");
        expect(output).not.toContain("src/a.test.ts");
        expect(output).not.toContain("src/c.test.ts");
        expect(output).not.toContain("bun tests (none selected)");
        expect(output).toContain("VERIFY CHANGED: PASS (tests: 1 test file(s)");
    });

    it("falls back to the full suite when package.json changed in a commit", () => {
        const { git, write, verify } = makeRepo();
        write(
            "package.json",
            JSON.stringify({
                scripts: { typecheck: "echo typecheck-ok", "knip:gate": "echo knip-ok", "policy:test": "echo policy-ok" },
                private: true,
            }),
        );
        git("commit", "-q", "-am", "package change");
        const { status, output } = verify();
        expect(status).toBe(0);
        expect(output).toContain("full suite: package.json");
        expect(output).toContain("src/c.test.ts");
        expect(output).toContain("VERIFY CHANGED: PASS (tests: full suite");
    });

    it("reuses a pass on an unchanged tree, also after a content-neutral commit", () => {
        const { git, write, verify } = makeRepo();
        write("src/a.ts", "export const a = 1;\nexport const extra = 2;\n");
        expect(verify().output).toContain("==> typecheck");
        const second = verify();
        expect(second.status).toBe(0);
        expect(second.output).toMatch(/VERIFY CHANGED: PASS \(reused earlier pass for tree [0-9a-f]{40}\)/);
        expect(second.output).not.toContain("==>");
        git("commit", "-q", "-am", "leftover changes");
        expect(verify().output).toContain("reused earlier pass");
        const forced = verify({ CARAPA_VERIFY_REUSE: "0" });
        expect(forced.output).toContain("==> typecheck");
        expect(forced.output).not.toContain("reused earlier pass");
    });

    it("runs the gates again after a tracked, untracked or verifier-script edit", () => {
        const { repo, write, verify } = makeRepo();
        write("src/a.ts", "export const a = 1;\nexport const extra = 2;\n");
        expect(verify().status).toBe(0);
        write("src/a.ts", "export const a = 1;\nexport const extra = 3;\n");
        expect(verify().output).toContain("==> typecheck");
        write("src/new.ts", "export const n = 1;\n");
        expect(verify().output).toContain("==> typecheck");
        expect(verify().output).toContain("reused earlier pass");
        fs.appendFileSync(path.join(repo, "scripts/verify-changed.sh"), "# edited\n");
        expect(verify().output).toContain("==> typecheck");
    });

    it("exits non-zero when a selected test fails", () => {
        const { write, verify } = makeRepo();
        write("src/a.ts", "export const a = 2;\n");
        const { status, output } = verify();
        expect(status).not.toBe(0);
        expect(output).toContain("VERIFY CHANGED: FAIL - bun tests");
        expect(output).not.toContain("VERIFY CHANGED: PASS");
    });
});
