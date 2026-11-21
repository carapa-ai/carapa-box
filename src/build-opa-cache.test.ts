import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const buildScript = resolve(import.meta.dir, "../build.sh");
const root = mkdtempSync(join(tmpdir(), "build-opa-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Fake host tools: docker answers `compose config` with a JSON mount list and
// records everything else; curl records the URL and writes a version-tagged body,
// or for `.sha256` URLs the body's checksum (a wrong one when FAKE_OPA_SHA256_MISMATCH is set).
function setup(): { stack: string; bin: string; curlLog: string } {
    const dir = mkdtempSync(join(root, "case-"));
    const stack = join(dir, "stack");
    const bin = join(dir, "bin");
    const curlLog = join(dir, "curl.log");
    mkdirSync(join(stack, "config", "policies"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(buildScript, join(stack, "build.sh"));
    const config = JSON.stringify({ services: { "carapa-box": { volumes: [{ target: "/app/config", source: join(stack, "config") }] } } });
    writeFileSync(join(bin, "docker"), `#!/bin/bash\nif [[ "$1 $2" == "compose config" ]]; then echo '${config}'; fi\nexit 0\n`);
    writeFileSync(
        join(bin, "curl"),
        `#!/bin/bash\nurl=""; out=""\nwhile [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac; done\necho "$url" >> "${curlLog}"\nif [[ "$url" == *.sha256 ]]; then\n  if [[ -n "$FAKE_OPA_SHA256_MISMATCH" ]]; then printf '%064d  opa\\n' 0 > "$out"; else echo "binary from \${url%.sha256}" | sha256sum > "$out"; fi\nelse\n  echo "binary from $url" > "$out"\nfi\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);
    return { stack, bin, curlLog };
}

function runBuild(stack: string, bin: string, opaVersion: string, extraEnv: Record<string, string> = {}) {
    return Bun.spawnSync(["bash", join(stack, "build.sh"), "--no-scan"], {
        cwd: stack,
        // Explicit env: inheriting SANDBOX_STACKS_DIR / CARAPA_BOX_DEPLOY_DIR would point build.sh at real host paths.
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, OPA_VERSION: opaVersion, ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
    });
}

describe("build.sh OPA binary cache", () => {
    test("re-downloads OPA and repoints .cache/opa/opa when OPA_VERSION changes", () => {
        const { stack, bin, curlLog } = setup();

        const first = runBuild(stack, bin, "v1.0.0");
        expect(first.exitCode).toBe(0);
        const second = runBuild(stack, bin, "v2.0.0");
        expect(second.exitCode).toBe(0);

        const binaryUrls = () => readFileSync(curlLog, "utf8").trim().split("\n").filter((u) => !u.endsWith(".sha256"));
        const urls = binaryUrls();
        expect(urls.map((u) => u.split("/downloads/")[1]?.split("/")[0])).toEqual(["v1.0.0", "v2.0.0"]);
        const link = join(stack, ".cache", "opa", "opa");
        expect(readFileSync(link, "utf8")).toContain("/downloads/v2.0.0/");
        expect(readlinkSync(link)).toContain("v2.0.0");

        // Same version again: cached binary is reused, no third download.
        expect(runBuild(stack, bin, "v2.0.0").exitCode).toBe(0);
        expect(binaryUrls()).toHaveLength(2);
    });

    test("rejects a downloaded OPA binary whose .sha256 does not match and caches nothing", () => {
        const { stack, bin } = setup();
        const run = runBuild(stack, bin, "v3.0.0", { FAKE_OPA_SHA256_MISMATCH: "1" });
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr.toString()).toContain("OPA checksum verification failed");
        const cacheDir = join(stack, ".cache", "opa");
        expect(readdirSync(cacheDir)).toEqual([]);
    });

    test("rejects an OPA_VERSION that is not a release tag", () => {
        const { stack, bin } = setup();
        const run = runBuild(stack, bin, "../evil");
        expect(run.exitCode).toBe(1);
        expect(run.stderr.toString()).toContain("OPA_VERSION must be a release");
    });
});
