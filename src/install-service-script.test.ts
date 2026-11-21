import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bash = Bun.which("bash") ?? "/bin/bash";
const script = resolve(import.meta.dir, "../install-service.sh");
const root = mkdtempSync(join(tmpdir(), "install-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("install-service.sh", () => {
    test("prints the 'bun not found' error and exits non-zero when bun is missing from PATH", () => {
        const emptyBin = join(root, "empty-bin");
        const home = join(root, "home");
        mkdirSync(emptyBin);
        mkdirSync(home);
        const result = Bun.spawnSync([bash, script], {
            cwd: root,
            env: { PATH: emptyBin, HOME: home },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.stdout.toString()).toContain("'bun' not found in PATH");
        expect(result.exitCode).toBe(1);
    });
});
