import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/compile-policies.sh");
const root = mkdtempSync(join(tmpdir(), "compile-policies-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Fake opa: `build` writes a tarball holding policy.wasm, anything else prints a version.
const fakeOpa = join(root, "fake-opa.sh");
writeFileSync(
    fakeOpa,
    `#!/usr/bin/env bash
if [ "$1" = "build" ]; then
    out=""
    while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
    d="$(mktemp -d)"; echo wasm > "$d/policy.wasm"
    tar -czf "$out" -C "$d" policy.wasm; rm -rf "$d"
else
    echo "fake 0.0.0"
fi
`,
);
chmodSync(fakeOpa, 0o755);

function makeProject(name: string, withBase: boolean): string {
    const project = join(root, name);
    mkdirSync(join(project, "scripts"), { recursive: true });
    mkdirSync(join(project, "config/policies"), { recursive: true });
    copyFileSync(script, join(project, "scripts/compile-policies.sh"));
    if (withBase) writeFileSync(join(project, "config/policies/base.rego"), "package carapabox.base\n");
    for (const [stack, rego] of [
        ["a-nopkg", "# no package here\nallow := true\n"],
        ["b-good", "package carapabox.stack.b\n"],
    ]) {
        mkdirSync(join(project, "stacks", stack), { recursive: true });
        writeFileSync(join(project, "stacks", stack, "policy.rego"), rego);
    }
    return project;
}

function run(project: string) {
    const result = Bun.spawnSync(["bash", join(project, "scripts/compile-policies.sh")], {
        env: { ...process.env, OPA: fakeOpa },
        stdout: "pipe",
        stderr: "pipe",
    });
    return { code: result.exitCode, out: result.stdout.toString() };
}

describe("compile-policies.sh", () => {
    test("reports a stack without a package line as FAILED and keeps going to later stacks and the summary", () => {
        const { code, out } = run(makeProject("nopkg", true));
        expect(out).toContain("Compiling a-nopkg/policy.rego... FAILED (no package declaration)");
        expect(out).toContain("Compiling b-good/policy.rego... OK");
        expect(out).toContain("Done: 2 compiled, 1 failed");
        expect(code).toBe(1);
    });

    test("reports a missing base.rego through the existence guard instead of aborting", () => {
        const { code, out } = run(makeProject("nobase", false));
        expect(out).toContain("Compiling base.rego... FAILED (missing");
        expect(out).toContain("Done:");
        expect(code).toBe(1);
    });
});
