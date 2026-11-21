import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "audit-test-"));
const logPath = path.join(dir, "audit.jsonl");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("concurrent writes at threshold rotate once and keep the backup", async () => {
    const MAX = 50 * 1024 * 1024;
    writeFileSync(logPath, "");
    truncateSync(logPath, MAX); // sparse file at the threshold

    // Child process: audit.ts resolves its path at import, and other test files
    // may already have cached it in this process with the real path.
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "audit-concurrent.fixture.ts")], {
        env: { ...process.env, AUDIT_LOG_PATH: logPath },
        stdout: "ignore",
        stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);

    const backup = logPath + ".1";
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).size).toBeGreaterThanOrEqual(MAX);

    const current = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const all = readFileSync(backup, "latin1").slice(MAX) + current;
    for (let i = 0; i < 20; i++) expect(all).toContain(`"command":"cmd-${i}"`);
});

test("resolveAuditLogPath host-dev fallback is <repo>/generated/audit.jsonl regardless of cwd", async () => {
    const script = `
        import { resolveAuditLogPath } from ${JSON.stringify(path.join(import.meta.dir, "audit.ts"))};
        console.log(resolveAuditLogPath());
    `;
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.AUDIT_LOG_PATH;
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    if (out !== "/var/log/carapabox/audit.jsonl") {
        expect(out).toBe(path.resolve(import.meta.dir, "..", "generated", "audit.jsonl"));
    }
});
