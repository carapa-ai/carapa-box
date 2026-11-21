/**
 * Unit tests for security helper functions in src/security.ts
 * Run with: bun test src/security.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
    splitShellCommand,
    splitRestartRecoveryReceipt,
    filterEnvPassthrough,
    isMountPathAllowed,
    validateMountPaths,
    validateCommand,
    parseCommandArgv,
    resolveTrustedCommand,
    validateComposeFileEnv,
} from "./security.js";
import { parseYamlList } from "./yaml-utils.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "carapabox-test-"));
}

function rmDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

// Mirrors MOUNT_ALLOWLIST_PATH in security.ts
const ALLOWLIST_PATH = path.resolve(import.meta.dir, "../config/mount-allowlist.yaml");

// Each write gets a strictly-incrementing mtime so the module-level cache in
// security.ts (which uses mtime-based invalidation) is always forced to reload.
const ALLOWLIST_BASE_TIME = Date.now();
let allowlistSeq = 0;

function writeAllowlist(allowed: string[]): void {
    const yaml = allowed.length > 0
        ? "allowed:\n" + allowed.map(p => `  - ${p}`).join("\n") + "\n"
        : "allowed:\n";
    fs.writeFileSync(ALLOWLIST_PATH, yaml, "utf-8");
    const t = new Date(ALLOWLIST_BASE_TIME + (++allowlistSeq) * 1000);
    fs.utimesSync(ALLOWLIST_PATH, t, t);
}

// Save and restore the real allowlist around all mount-path tests
let savedAllowlist: string | null = null;
let defaultAllowedPath = "/workspace";

beforeAll(() => {
    try {
        savedAllowlist = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
        const parsed = parseYamlList(savedAllowlist, "allowed");
        if (parsed.length > 0) {
            defaultAllowedPath = parsed[0];
        }
    } catch {
        savedAllowlist = null;
    }
});

afterAll(() => {
    if (savedAllowlist !== null) {
        fs.writeFileSync(ALLOWLIST_PATH, savedAllowlist, "utf-8");
    } else {
        try { fs.unlinkSync(ALLOWLIST_PATH); } catch { /* already gone */ }
    }
});

// ── splitShellCommand ──────────────────────────────────────────────────────

describe("trusted sandbox_exec commands", () => {
    it("uses image commands for published stacks even when their source exists on the host", async () => {
        const stack = makeTempDir();
        fs.mkdirSync(path.join(stack, "bin"));
        fs.writeFileSync(path.join(stack, "bin/run-agent.sh"), "source is not an executable override");
        try {
            fs.writeFileSync(path.join(stack, "docker-compose.yml"), "x-carapa-command-source: image\nservices: {}\n");
            const result = await resolveTrustedCommand(stack, 'run-agent.sh "two words"');
            expect(result.ok && result.value.argv).toEqual(["/usr/local/ai-cli-bin/run-agent.sh", "two words"]);
            // Explicit host overrides retain the executable validation boundary.
            expect((await resolveTrustedCommand(stack, '/usr/local/stack-cli-bin/run-agent.sh')).ok).toBe(false);
            fs.writeFileSync(path.join(stack, "docker-compose.yml"), "x-carapa-command-source: typo\n");
            expect((await resolveTrustedCommand(stack, 'run-agent.sh')).ok).toBe(false);
        } finally { rmDir(stack); }
    });
    it("parses quoted arguments but rejects shell composition and substitution", () => {
        expect(parseCommandArgv(`run-agent.sh "two words"`).ok).toBe(true);
        for (const command of [
            "run-agent.sh; id", "run-agent.sh && id", "run-agent.sh || id",
            "run-agent.sh | id", "run-agent.sh > /tmp/out", "run-agent.sh < /tmp/in",
            "run-agent.sh $(id)", "run-agent.sh `id`", "run-agent.sh\nid",
        ]) expect(parseCommandArgv(command).ok).toBe(false);
    });

    const suffix = (id: string, rid = id) => `run-agent.sh /workspace/ipc/runs/${id} && : > /workspace/ipc/runs/${rid}/.restart-recovery-dispatched`;

    it("splits the exact Board restart-recovery form into command and receipt", () => {
        for (const id of ["run-restart-0b5f3c1e-2d4a-4e6f-8a9b-1c2d3e4f5a6b", "run-1792204560451-n891sc"]) {
            expect(splitRestartRecoveryReceipt(suffix(id))).toEqual({
                command: `run-agent.sh /workspace/ipc/runs/${id}`,
                receipt: `/workspace/ipc/runs/${id}/.restart-recovery-dispatched`,
            });
        }
    });

    it("rejects every non-exact restart-recovery receipt variant", () => {
        const r = "/workspace/ipc/runs/x";
        for (const command of [
            suffix("x", "y"),
            `run-agent.sh ${r} && : > ${r}/.other`,
            `run-agent.sh ${r} && : > /tmp/x/.restart-recovery-dispatched`,
            `run-agent.sh ${r} && : > /workspace/ipc/x/.restart-recovery-dispatched`,
            suffix(".."), suffix("."), suffix("a/../b"), suffix("a/b"), suffix("a..b"),
            suffix("x").replace("run-agent.sh /", "run-agent.sh  /"),
            suffix("x").replace(" && ", "  && "),
            suffix("x").replace(" && ", "\t&&\t"),
            `run-agent.sh "${r}" && : > ${r}/.restart-recovery-dispatched`,
            `run-agent.sh ${r} extra && : > ${r}/.restart-recovery-dispatched`,
            suffix("x").replace("run-agent.sh", "id"),
            `${suffix("x")}; id`, `${suffix("x")} && id`, `${suffix("x")} && : > ${r}/.restart-recovery-dispatched`,
            suffix("x").replace("&&", "||"),
            suffix("x").replace(" > ", " >> "),
            `${suffix("x")}\n`, `\n${suffix("x")}`, suffix("x").replace(" && ", "\n&& "),
        ]) expect(splitRestartRecoveryReceipt(command)).toBeNull();
    });

    it("parseCommandArgv still rejects the full suffixed string", () => {
        expect(parseCommandArgv(suffix("x")).ok).toBe(false);
    });

    it("preserves shell-compatible backslashes inside double-quoted arguments", () => {
        expect(parseCommandArgv(String.raw`run-agent.sh "a\q"`)).toEqual({
            ok: true,
            argv: ["run-agent.sh", String.raw`a\q`],
        });
        expect(parseCommandArgv(String.raw`run-agent.sh "a\\b" "a\"b" "a\$b"`)).toEqual({
            ok: true,
            argv: ["run-agent.sh", String.raw`a\b`, `a"b`, "a$b"],
        });
        expect(parseCommandArgv("run-agent.sh one\\\ntwo")).toEqual({
            ok: true,
            argv: ["run-agent.sh", "onetwo"],
        });
        for (const command of ["fs-tool.sh \\\n   read-file x", "fs-tool.sh \\\nread-file x \\\n"]) {
            expect(parseCommandArgv(command)).toEqual({ ok: true, argv: ["fs-tool.sh", "read-file", "x"] });
        }
    });

    it("rejects unescaped substitutions inside double quotes", () => {
        expect(parseCommandArgv('run-agent.sh "$(id)"').ok).toBe(false);
        expect(parseCommandArgv('run-agent.sh "`id`"').ok).toBe(false);
    });

    it("prefers a stack override for a bare executable and preserves argv", async () => {
        const stack = makeTempDir();
        fs.mkdirSync(path.join(stack, "bin"));
        fs.writeFileSync(path.join(stack, "bin", "run-agent.sh"), "#!/bin/sh\n", { mode: 0o755 });
        try {
            const bare = await resolveTrustedCommand(stack, `run-agent.sh "two words"`);
            expect(bare.ok && bare.value.argv).toEqual(["/usr/local/stack-cli-bin/run-agent.sh", "two words"]);
            expect(bare.ok && bare.value.command).toBe("/usr/local/stack-cli-bin/run-agent.sh 'two words'");
        } finally { rmDir(stack); }
    });

    it("falls back to an image-built executable when the stack bin is absent", async () => {
        const stack = makeTempDir();
        try {
            const result = await resolveTrustedCommand(stack, "image-tool --flag");
            expect(result.ok && result.value.argv).toEqual(["/usr/local/ai-cli-bin/image-tool", "--flag"]);
        } finally { rmDir(stack); }
    });

    it("accepts exact immediate-child paths in both executable directories", async () => {
        const stack = makeTempDir();
        fs.mkdirSync(path.join(stack, "bin"));
        fs.writeFileSync(path.join(stack, "bin", "custom"), "#!/bin/sh\n", { mode: 0o755 });
        try {
            const custom = await resolveTrustedCommand(stack, "/usr/local/stack-cli-bin/custom --flag");
            expect(custom.ok && custom.value.argv[0]).toBe("/usr/local/stack-cli-bin/custom");
            const builtIn = await resolveTrustedCommand(stack, "/usr/local/ai-cli-bin/image-tool --flag");
            expect(builtIn.ok && builtIn.value.argv[0]).toBe("/usr/local/ai-cli-bin/image-tool");
        } finally { rmDir(stack); }
    });

    it("does not fall back when a same-name stack override is non-executable", async () => {
        const stack = makeTempDir();
        fs.mkdirSync(path.join(stack, "bin"));
        fs.writeFileSync(path.join(stack, "bin", "image-tool"), "x", { mode: 0o644 });
        try {
            expect((await resolveTrustedCommand(stack, "image-tool")).ok).toBe(false);
        } finally { rmDir(stack); }
    });

    it("rejects alternate, relative, traversal, nested, malformed, and escaping targets", async () => {
        const stack = makeTempDir();
        fs.mkdirSync(path.join(stack, "bin"));
        fs.writeFileSync(path.join(stack, "bin", "noexec"), "x", { mode: 0o644 });
        fs.symlinkSync("/bin/true", path.join(stack, "bin", "escape"));
        try {
            for (const command of [
                "/tmp/run-agent.sh", "./run-agent.sh", "../run-agent.sh",
                "/usr/local/ai-cli-bin/../run-agent.sh", "/usr/local/ai-cli-bin/nested/tool",
                "/usr/local/ai-cli-bin/run-agent.sh/", "/usr/local/ai-cli-bin//run-agent.sh",
                "/usr/local/stack-cli-bin/../run-agent.sh", "/usr/local/stack-cli-bin/nested/tool",
                "/usr/local/stack-cli-bin/run-agent.sh/", "/usr/local/stack-cli-bin//run-agent.sh",
                "noexec", "escape",
            ]) expect((await resolveTrustedCommand(stack, command)).ok).toBe(false);
        } finally { rmDir(stack); }
    });
});

describe("splitShellCommand", () => {
    it("returns a single segment for a plain command", () => {
        const r = splitShellCommand("echo hello");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toEqual(["echo hello"]);
    });

    it("splits on pipe |", () => {
        const r = splitShellCommand("ls | grep foo");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0].trim()).toBe("ls");
        expect(r.segments[1].trim()).toBe("grep foo");
    });

    it("splits on semicolon ;", () => {
        const r = splitShellCommand("echo a ; echo b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0].trim()).toBe("echo a");
        expect(r.segments[1].trim()).toBe("echo b");
    });

    it("splits on && as a single separator (skips second &)", () => {
        const r = splitShellCommand("make && ./run");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0].trim()).toBe("make");
        expect(r.segments[1].trim()).toBe("./run");
    });

    it("splits on || as a single separator (skips second |)", () => {
        const r = splitShellCommand("test -f foo || echo missing");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0].trim()).toBe("test -f foo");
        expect(r.segments[1].trim()).toBe("echo missing");
    });

    it("splits on > (output redirect)", () => {
        const r = splitShellCommand("echo hi > /tmp/out");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
    });

    it("splits on < (input redirect)", () => {
        const r = splitShellCommand("cat < /etc/hosts");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
    });

    it("splits on newline \\n", () => {
        const r = splitShellCommand("echo a\necho b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0].trim()).toBe("echo a");
        expect(r.segments[1].trim()).toBe("echo b");
    });

    it("splits on carriage return \\r", () => {
        const r = splitShellCommand("echo a\recho b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
    });

    it("does not split on | inside single quotes", () => {
        const r = splitShellCommand("echo 'a|b'");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]).toBe("echo 'a|b'");
    });

    it("does not split on ; inside double quotes", () => {
        const r = splitShellCommand('echo "a;b"');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]).toBe('echo "a;b"');
    });

    it("does not split on && inside single quotes", () => {
        const r = splitShellCommand("echo 'foo && bar'");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("does not split on > inside double quotes", () => {
        const r = splitShellCommand('echo "2 > 1 is true"');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("does not split on newline inside single quotes", () => {
        const r = splitShellCommand("echo 'line1\nline2'");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("treats escaped | as literal — not a split point", () => {
        const r = splitShellCommand("echo a\\|b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]).toBe("echo a\\|b");
    });

    it("treats escaped ; as literal — not a split point", () => {
        const r = splitShellCommand("echo a\\;b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("treats escaped & as literal — not a split point", () => {
        const r = splitShellCommand("echo a\\&b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("treats a backslash inside single quotes as literal (B-068)", () => {
        const cmd = "/usr/local/ai-cli-bin/x 'a\\' ; id ; echo '\\'";
        const r = splitShellCommand(cmd);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments.map(s => s.trim())).toEqual(["/usr/local/ai-cli-bin/x 'a\\'", "id", "echo '\\'"]);
        expect(parseCommandArgv(cmd).ok).toBe(false);
    });

    it("returns error for unterminated single quote", () => {
        const r = splitShellCommand("echo 'unterminated");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/unterminated/i);
    });

    it("returns error for unterminated double quote", () => {
        const r = splitShellCommand('echo "unterminated');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/unterminated/i);
    });

    it("returns error for trailing backslash (unterminated escape)", () => {
        const r = splitShellCommand("echo \\");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/unterminated/i);
    });

    it("returns error for single quote opened inside double-quoted region — edge case", () => {
        // Double-quoted string never closed (single quote inside double quotes is literal)
        const r = splitShellCommand('echo "hello');
        expect(r.ok).toBe(false);
    });

    it("filters out whitespace-only segments", () => {
        const r = splitShellCommand("echo a | echo b");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments.every(s => s.trim().length > 0)).toBe(true);
    });

    it("returns no segments for an empty string", () => {
        const r = splitShellCommand("");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(0);
    });

    it("returns no segments for a whitespace-only string", () => {
        const r = splitShellCommand("   ");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(0);
    });

    it("preserves a quoted commit message as one segment", () => {
        const r = splitShellCommand('git commit -m "fix: some bug"');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]).toBe('git commit -m "fix: some bug"');
    });

    it("produces four segments from chained operators a | b ; c && d", () => {
        const r = splitShellCommand("a | b ; c && d");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(4);
    });

    it("handles a single-quote inside a double-quoted string as a literal character", () => {
        const r = splitShellCommand("echo \"it's fine\"");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(1);
    });

    it("single & is also a split operator", () => {
        // The parser treats bare & the same as |/; at the character level
        const r = splitShellCommand("cmd1 & cmd2");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.segments).toHaveLength(2);
    });
});

// ── parseEnvPassthroughYaml (tested indirectly via filterEnvPassthrough) ──

describe("parseEnvPassthroughYaml", () => {
    let tmpDir: string;

    beforeAll(() => { tmpDir = makeTempDir(); });
    afterAll(() => { rmDir(tmpDir); });

    function writeYaml(content: string): void {
        fs.writeFileSync(path.join(tmpDir, "env-passthrough.yaml"), content, "utf-8");
    }

    it("parses an unquoted key list", async () => {
        writeYaml("allowed_keys:\n  - FOO\n  - BAR\n");
        expect(await filterEnvPassthrough(tmpDir, { FOO: "1", BAR: "2", BAZ: "3" }))
            .toEqual({ FOO: "1", BAR: "2" });
    });

    it("strips double quotes from key names", async () => {
        writeYaml('allowed_keys:\n  - "MY_KEY"\n');
        expect(await filterEnvPassthrough(tmpDir, { MY_KEY: "v" })).toEqual({ MY_KEY: "v" });
    });

    it("strips single quotes from key names", async () => {
        writeYaml("allowed_keys:\n  - 'MY_KEY'\n");
        expect(await filterEnvPassthrough(tmpDir, { MY_KEY: "v" })).toEqual({ MY_KEY: "v" });
    });

    it("ignores lines starting with #", async () => {
        writeYaml("# file-level comment\nallowed_keys:\n  # inline comment\n  - KEEP\n");
        expect(await filterEnvPassthrough(tmpDir, { KEEP: "1", OTHER: "2" })).toEqual({ KEEP: "1" });
    });

    it("ignores blank lines within the list", async () => {
        writeYaml("allowed_keys:\n\n  - KEY1\n\n  - KEY2\n");
        expect(await filterEnvPassthrough(tmpDir, { KEY1: "a", KEY2: "b" }))
            .toEqual({ KEY1: "a", KEY2: "b" });
    });

    it("stops parsing the list at a non-dash section header", async () => {
        writeYaml("allowed_keys:\n  - FIRST\nother_section:\n  - SECOND\n");
        expect(await filterEnvPassthrough(tmpDir, { FIRST: "1", SECOND: "2" }))
            .toEqual({ FIRST: "1" });
    });

    it("returns empty object for an empty allowed_keys section", async () => {
        writeYaml("allowed_keys:\n");
        expect(await filterEnvPassthrough(tmpDir, { FOO: "bar" })).toEqual({});
    });

    it("returns empty object when allowed_keys header is absent", async () => {
        writeYaml("other_key: value\n");
        expect(await filterEnvPassthrough(tmpDir, { FOO: "bar" })).toEqual({});
    });

    it("handles leading/trailing whitespace on key lines", async () => {
        writeYaml("allowed_keys:\n  -   PADDED   \n");
        // val = line.slice(2).trim() strips surrounding whitespace
        expect(await filterEnvPassthrough(tmpDir, { PADDED: "yes" })).toEqual({ PADDED: "yes" });
    });
});

// ── filterEnvPassthrough ───────────────────────────────────────────────────

describe("filterEnvPassthrough", () => {
    it("returns empty object when env-passthrough.yaml does not exist", async () => {
        const dir = makeTempDir();
        try {
            expect(await filterEnvPassthrough(dir, { FOO: "bar" })).toEqual({});
        } finally {
            rmDir(dir);
        }
    });

    it("removes undeclared sandbox_exec env keys and retains only allowlisted keys", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, "env-passthrough.yaml"), "allowed_keys:\n  - A\n");
            expect(await filterEnvPassthrough(dir, { A: "1", B: "2" })).toEqual({ A: "1" });
        } finally {
            rmDir(dir);
        }
    });

    it("omits allowlisted keys that are absent from the env record", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, "env-passthrough.yaml"), "allowed_keys:\n  - MISSING\n");
            expect(await filterEnvPassthrough(dir, { OTHER: "val" })).toEqual({});
        } finally {
            rmDir(dir);
        }
    });

    it("passes through multiple matching keys", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, "env-passthrough.yaml"), "allowed_keys:\n  - A\n  - C\n");
            expect(await filterEnvPassthrough(dir, { A: "1", B: "2", C: "3", D: "4" }))
                .toEqual({ A: "1", C: "3" });
        } finally {
            rmDir(dir);
        }
    });

    it("returns empty object on a completely empty file", async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, "env-passthrough.yaml"), "");
            expect(await filterEnvPassthrough(dir, { FOO: "bar" })).toEqual({});
        } finally {
            rmDir(dir);
        }
    });
});

// ── isMountPathAllowed ─────────────────────────────────────────────────────

describe("isMountPathAllowed", () => {
    it("allows an exact-match path", async () => {
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/allowed/base")).toBe(true);
    });

    it("allows a direct child of an allowed base", async () => {
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/allowed/base/child")).toBe(true);
    });

    it("allows a deeply nested path under an allowed base", async () => {
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/allowed/base/a/b/c")).toBe(true);
    });

    it("blocks a path outside the allowlist", async () => {
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/not/allowed")).toBe(false);
    });

    it("blocks a path that shares a prefix but lacks the directory boundary", async () => {
        // /allowed/basebad starts with /allowed/base but NOT /allowed/base/
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/allowed/basebad")).toBe(false);
    });

    it("blocks a sibling directory whose name begins with the allowed dir name", async () => {
        writeAllowlist(["/workspace/project"]);
        expect(await isMountPathAllowed("/workspace/project-evil")).toBe(false);
    });

    it("returns false when the allowlist is empty", async () => {
        writeAllowlist([]);
        expect(await isMountPathAllowed("/anything")).toBe(false);
    });

    it("returns false when the allowlist file does not exist", async () => {
        try { fs.unlinkSync(ALLOWLIST_PATH); } catch { /* may already be gone */ }
        expect(await isMountPathAllowed("/anything")).toBe(false);
        writeAllowlist([]); // ensure file exists for later tests
    });

    it("resolves a relative path against CWD before comparing", async () => {
        writeAllowlist(["/allowed/base"]);
        // "relative/path" resolves to process.cwd()/relative/path — not inside /allowed/base
        expect(await isMountPathAllowed("relative/path")).toBe(false);
    });

    it("normalises a trailing slash before comparing (path.resolve strips it)", async () => {
        writeAllowlist(["/allowed/base"]);
        // "/allowed/base/" → path.resolve → "/allowed/base" → exact match
        expect(await isMountPathAllowed("/allowed/base/")).toBe(true);
    });

    it("checks all entries and allows if any base matches", async () => {
        writeAllowlist(["/first/base", "/second/base"]);
        expect(await isMountPathAllowed("/first/base/file")).toBe(true);
        expect(await isMountPathAllowed("/second/base/dir")).toBe(true);
        expect(await isMountPathAllowed("/third/base")).toBe(false);
    });

    it("blocks a path that is a parent of an allowed base (no upward traversal)", async () => {
        writeAllowlist(["/allowed/base"]);
        expect(await isMountPathAllowed("/allowed")).toBe(false);
    });

    it("blocks a path with .. segments that resolve outside the allowlist", async () => {
        writeAllowlist(["/allowed/base"]);
        // path.resolve collapses the .. segments syntactically:
        // /allowed/base/subdir/../../etc/passwd → /etc/passwd
        expect(await isMountPathAllowed("/allowed/base/subdir/../../etc/passwd")).toBe(false);
    });

    it("resolves real symlink targets and permits new directories only beneath allowed roots", async () => {
        const root = makeTempDir();
        const allowed = path.join(root, "allowed");
        const outside = path.join(root, "outside");
        fs.mkdirSync(path.join(allowed, "inside"), { recursive: true });
        fs.mkdirSync(path.join(outside, "nested"), { recursive: true });
        fs.writeFileSync(path.join(outside, "secret"), "private");
        fs.writeFileSync(path.join(allowed, "file"), "plain file");
        fs.symlinkSync("inside", path.join(allowed, "safe-link"));
        fs.symlinkSync(outside, path.join(allowed, "escape"));
        fs.symlinkSync(path.join(outside, "nested"), path.join(allowed, "upward"));
        fs.symlinkSync("missing-target", path.join(allowed, "dangling"));
        fs.symlinkSync("loop", path.join(allowed, "loop"));
        fs.symlinkSync(allowed, path.join(root, "allowed-alias"));
        try {
            writeAllowlist([allowed]);
            for (const candidate of ["escape", "escape/secret", "escape/new/child",
                "upward/../secret", "dangling/new", "loop", "file/child"]) {
                expect(await isMountPathAllowed(`${allowed}/${candidate}`)).toBe(false);
            }
            for (const candidate of ["inside", "new/child", "safe-link/new/child"]) {
                expect(await isMountPathAllowed(`${allowed}/${candidate}`)).toBe(true);
            }
            expect(await validateMountPaths({ LOCAL_REPO: path.join(allowed, "escape/new") })).toContain("[SECURITY]");
            // Re-evaluate links even when the allowlist itself is cached.
            fs.unlinkSync(path.join(allowed, "safe-link"));
            fs.symlinkSync(outside, path.join(allowed, "safe-link"));
            expect(await isMountPathAllowed(path.join(allowed, "safe-link/new"))).toBe(false);
            // Operator-configured roots can themselves be symlink aliases.
            writeAllowlist([path.join(root, "allowed-alias")]);
            expect(await isMountPathAllowed(path.join(allowed, "inside/new"))).toBe(true);
            expect(await isMountPathAllowed(path.join(root, "allowed-alias/escape"))).toBe(false);
        } finally { rmDir(root); }
    });

    it("protects credential roots and their ancestors through aliases and missing descendants", async () => {
        const root = makeTempDir();
        const saved = process.env.PROVIDER_ACCOUNTS_HOST_DIR;
        fs.mkdirSync(path.join(root, "private"));
        fs.mkdirSync(path.join(root, "workspace"));
        fs.symlinkSync("private", path.join(root, "alias"));
        // The credential directory need not exist yet for its parent to be protected.
        process.env.PROVIDER_ACCOUNTS_HOST_DIR = path.join(root, "alias/credentials");
        try {
            writeAllowlist([root]);
            expect(await isMountPathAllowed(path.join(root, "workspace/new"))).toBe(true);
            for (const candidate of [root, path.join(root, "private"), path.join(root, "alias"),
                path.join(root, "private/credentials/new"), path.join(root, "alias/credentials/new")]) {
                expect(await isMountPathAllowed(candidate)).toBe(false);
            }
        } finally {
            if (saved === undefined) delete process.env.PROVIDER_ACCOUNTS_HOST_DIR;
            else process.env.PROVIDER_ACCOUNTS_HOST_DIR = saved;
            rmDir(root);
        }
    });
});

// ── validateMountPaths ─────────────────────────────────────────────────────

describe("validateMountPaths", () => {
    it("returns an error when the allowlist is empty (deny by default)", async () => {
        writeAllowlist([]);
        const result = await validateMountPaths({ LOCAL_REPO: "/anything/goes" });
        expect(result).not.toBeNull();
        expect(result).toContain("[SECURITY]");
        expect(result).toContain("LOCAL_REPO");
    });

    it("rejects LOCAL_REPO and IPC_MOUNT values that inject mount keys with a comma", async () => {
        writeAllowlist(["/srv/repos"]);
        for (const key of ["LOCAL_REPO", "IPC_MOUNT"]) {
            const result = await validateMountPaths({ [key]: "/srv/repos/a,src=/etc/b" });
            expect(result).toContain("[SECURITY]");
            expect(result).toContain(`${key} contains a comma, quote or control character`);
        }
    });

    it("rejects mount values containing a double quote", async () => {
        writeAllowlist(["/srv/repos"]);
        expect(await validateMountPaths({ LOCAL_REPO: '/srv/repos/a"b' })).toContain("comma, quote or control character");
    });

    it("still accepts an allowed path containing an equals sign", async () => {
        writeAllowlist(["/srv/repos"]);
        expect(await validateMountPaths({ LOCAL_REPO: "/srv/repos/a=b" })).toBeNull();
    });

    it("returns null when env contains no mount-path keys", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ OTHER_KEY: "/not/checked" })).toBeNull();
    });

    it("returns null when LOCAL_REPO resolves within an allowed base", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ LOCAL_REPO: "/workspace/my-repo" })).toBeNull();
    });

    it("returns an error string containing [SECURITY] when LOCAL_REPO is blocked", async () => {
        writeAllowlist(["/workspace"]);
        const result = await validateMountPaths({ LOCAL_REPO: "/tmp/evil" });
        expect(result).not.toBeNull();
        expect(result).toContain("[SECURITY]");
        expect(result).toContain("LOCAL_REPO");
        expect(result).toContain("/tmp/evil");
    });

    it("returns null when GROUP_DIR resolves within an allowed base", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ GROUP_DIR: "/workspace/group" })).toBeNull();
    });

    it("returns an error string when GROUP_DIR is blocked", async () => {
        writeAllowlist(["/workspace"]);
        const result = await validateMountPaths({ GROUP_DIR: "/home/hacker" });
        expect(result).not.toBeNull();
        expect(result).toContain("GROUP_DIR");
        expect(result).toContain("/home/hacker");
    });

    it("validates both extra read-only mount slots against the allowlist", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ EXTRA_MOUNT_1: "/workspace/data", EXTRA_MOUNT_2: "/workspace/docs" })).toBeNull();
        for (const key of ["EXTRA_MOUNT_1", "EXTRA_MOUNT_2"]) {
            const result = await validateMountPaths({ [key]: "/etc" });
            expect(result).toContain("[SECURITY]");
            expect(result).toContain(key);
        }
    });

    it("rejects extra mount names that are unsafe or collide with other /workspace mounts", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ EXTRA_MOUNT_1_NAME: "docs", EXTRA_MOUNT_2_NAME: "docs-2", WORKSPACE_PATH: "/workspace/repo" })).toBeNull();
        for (const env of <Record<string, string>[]>[
            { EXTRA_MOUNT_1_NAME: "ipc" },
            { EXTRA_MOUNT_1_NAME: "../etc" },
            { EXTRA_MOUNT_1_NAME: "repo", WORKSPACE_PATH: "/workspace/repo" },
            { EXTRA_MOUNT_1_NAME: "docs", EXTRA_MOUNT_2_NAME: "docs" },
        ]) {
            expect(await validateMountPaths(env)).toContain("[SECURITY]");
        }
    });

    it("returns null when IPC_MOUNT resolves within an allowed base", async () => {
        writeAllowlist(["/workspace"]);
        expect(await validateMountPaths({ IPC_MOUNT: "/workspace/data/ipc" })).toBeNull();
    });

    it("returns an error string when IPC_MOUNT is blocked", async () => {
        writeAllowlist(["/workspace"]);
        const result = await validateMountPaths({ IPC_MOUNT: "/tmp/ipc" });
        expect(result).not.toBeNull();
        expect(result).toContain("IPC_MOUNT");
    });

    it("returns null when AGENT_HOME resolves within an allowed base", async () => {
        writeAllowlist([defaultAllowedPath]);
        expect(await validateMountPaths({ AGENT_HOME: path.join(defaultAllowedPath, "docker_ai") })).toBeNull();
    });

    it("returns an error string when AGENT_HOME is blocked", async () => {
        writeAllowlist(["/workspace"]);
        const result = await validateMountPaths({ AGENT_HOME: "/root" });
        expect(result).not.toBeNull();
        expect(result).toContain("AGENT_HOME");
    });

    it("reports LOCAL_REPO (iterated first) when both keys are blocked", async () => {
        writeAllowlist(["/workspace"]);
        const result = await validateMountPaths({ LOCAL_REPO: "/forbidden", GROUP_DIR: "/also-forbidden" });
        expect(result).not.toBeNull();
        expect(result).toContain("LOCAL_REPO");
    });

    it("returns null for an exact match on an allowed path", async () => {
        writeAllowlist(["/exact/path"]);
        expect(await validateMountPaths({ LOCAL_REPO: "/exact/path" })).toBeNull();
    });

    it("returns an error when the allowlist file is absent (deny by default)", async () => {
        try { fs.unlinkSync(ALLOWLIST_PATH); } catch { /* may already be gone */ }
        const result = await validateMountPaths({ LOCAL_REPO: "/whatever" });
        expect(result).not.toBeNull();
        expect(result).toContain("[SECURITY]");
        writeAllowlist([]); // restore file for later tests
    });

    it("returns null when LOCAL_REPO key is present but has an empty-string value", async () => {
        writeAllowlist(["/workspace"]);
        // value is falsy ("") — the `if (value && ...)` guard skips the check
        expect(await validateMountPaths({ LOCAL_REPO: "" })).toBeNull();
    });
});

// ── validateCommand ────────────────────────────────────────────────────────

describe("validateCommand", () => {
    it("rejects a command that exceeds the 8192-byte length limit", async () => {
        const long = "echo " + "a".repeat(8200);
        const r = await validateCommand("/fake/stack", "svc", long);
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/exceeds maximum length/i);
        expect(r.reason).toContain(`${long.length}`);
    });

    it("rejects a command of exactly 8193 bytes (MAX+1)", async () => {
        const cmd = "a".repeat(8193);
        const r = await validateCommand("/fake/stack", "svc", cmd);
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/exceeds maximum length/i);
    });

    it("does not trigger length rejection for a command of exactly 8192 bytes", async () => {
        const dir = makeTempDir();
        try {
            const cmd = "a".repeat(8192);
            const r = await validateCommand(dir, "svc", cmd);
            // Length check passes; next check (missing policy) triggers instead
            expect(r.reason).not.toMatch(/exceeds maximum length/i);
        } finally {
            rmDir(dir);
        }
    });

    it("rejects when no policy.wasm exists in the stack directory", async () => {
        const dir = makeTempDir();
        try {
            const r = await validateCommand(dir, "service", "echo hi");
            expect(r.allowed).toBe(false);
            expect(r.reason).toMatch(/policy\.wasm/i);
        } finally {
            rmDir(dir);
        }
    });

    it("does not set policy_name when failing on missing policy.wasm", async () => {
        const dir = makeTempDir();
        try {
            const r = await validateCommand(dir, "service", "ls");
            expect(r.policy_name).toBeUndefined();
        } finally {
            rmDir(dir);
        }
    });

    it("rejects an empty command string (no policy.wasm)", async () => {
        const dir = makeTempDir();
        try {
            const r = await validateCommand(dir, "service", "");
            expect(r.allowed).toBe(false);
        } finally {
            rmDir(dir);
        }
    });
});

// ── shell_free call-site contract ──────────────────────────────────────────

describe("validateCommand shell_free callers", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dir, rel), "utf-8");
    const calls = (src: string) => src.match(/validateCommand\([^;]*?\);/gs) ?? [];

    it("sandbox_exec passes shellFree: true on the resolved-argv call only", () => {
        const flagged = calls(read("./tools/register.ts")).filter(c => c.includes("shellFree"));
        expect(flagged).toHaveLength(1);
        expect(flagged[0]).toContain("normalizedCommand");
        expect(flagged[0]).toContain("shellFree: true");
    });

    it("browser viewer attach passes shellFree: true", () => {
        const flagged = calls(read("./http/browser.ts")).filter(c => c.includes("validateCommand("));
        expect(flagged.some(c => c.includes("shellFree: true"))).toBe(true);
    });

    it("tmux path does not set shellFree", () => {
        expect(read("./http/tmux.ts")).not.toContain("shellFree");
    });

    it("validateCommand defaults shell_free to false", () => {
        const src = read("./security.ts");
        expect(src).toContain("options: { shellFree?: boolean } = {}");
        expect(src).toContain("shell_free: options.shellFree === true");
    });
});

describe("parseCommandArgv with expansion characters", () => {
    it("still rejects unquoted $( and backticks", () => {
        expect(parseCommandArgv("/usr/local/ai-cli-bin/fs-tool.sh ripgrep $(id)").ok).toBe(false);
        expect(parseCommandArgv("/usr/local/ai-cli-bin/fs-tool.sh ripgrep `id`").ok).toBe(false);
        expect(parseCommandArgv("/usr/local/ai-cli-bin/fs-tool.sh ripgrep \"$(id)\"").ok).toBe(false);
    });
    it("accepts single-quoted literals", () => {
        expect(parseCommandArgv("/usr/local/ai-cli-bin/fs-tool.sh ripgrep '$(document)'").ok).toBe(true);
    });
});

// ── validateComposeFileEnv ─────────────────────────────────────────────────

describe("validateComposeFileEnv", () => {
    const withStack = async (files: string[], fn: (dir: string) => Promise<void>) => {
        const dir = makeTempDir();
        try {
            for (const f of files) fs.writeFileSync(path.join(dir, f), "services: {}\n");
            await fn(dir);
        } finally {
            rmDir(dir);
        }
    };

    it("rejects absolute paths", async () => {
        await withStack(["docker-compose.yml"], async (dir) => {
            const err = await validateComposeFileEnv(dir, "docker-compose.yml:/abs/evil.yml");
            expect(err).toContain("[SECURITY]");
        });
    });

    it("rejects '..' traversal", async () => {
        await withStack(["docker-compose.yml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "../docker-compose.yml")).toContain("[SECURITY]");
            expect(await validateComposeFileEnv(dir, "docker-compose..yml")).toContain("[SECURITY]");
        });
    });

    it("rejects missing files", async () => {
        await withStack(["docker-compose.yml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "docker-compose.missing.yml")).toContain("[SECURITY]");
        });
    });

    it("rejects override names", async () => {
        await withStack(["docker-compose.override.foo.yml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "docker-compose.override.foo.yml")).toContain("[SECURITY]");
        });
    });

    it("rejects non-matching names", async () => {
        await withStack(["evil.yml", "docker-compose.yaml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "evil.yml")).toContain("[SECURITY]");
            expect(await validateComposeFileEnv(dir, "docker-compose.yaml")).toContain("[SECURITY]");
            expect(await validateComposeFileEnv(dir, "")).toContain("[SECURITY]");
        });
    });

    it("accepts docker-compose.git.yml", async () => {
        await withStack(["docker-compose.git.yml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "docker-compose.git.yml")).toBeNull();
        });
    });

    it("accepts docker-compose.yml:docker-compose.dev.yml", async () => {
        await withStack(["docker-compose.yml", "docker-compose.dev.yml"], async (dir) => {
            expect(await validateComposeFileEnv(dir, "docker-compose.yml:docker-compose.dev.yml")).toBeNull();
        });
    });
});
