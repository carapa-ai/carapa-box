/**
 * Mount pinning: sandbox mount sources are handed to Docker as volume subpaths.
 * Allowlist-dependent scenarios run in a child `bun` process with their own
 * config dir so they never depend on modules other tests already imported.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ensureBaseVolume } from "./security.js";

const SRC = import.meta.dir;
const STACK_FILES = ["docker-compose.yml", "docker-compose.git.yml"].map((f) => path.resolve(SRC, "../stacks/carapa-bot", f));
const MOUNT_KEYS = ["LOCAL_REPO", "GROUP_DIR", "IPC_MOUNT", "AGENT_HOME", "EXTRA_MOUNT_1", "EXTRA_MOUNT_2"];

let tmp: string;
let base: string;

beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "carapa-pin-test-")));
    base = path.join(tmp, "base");
    fs.mkdirSync(base);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run `body` (an async function body returning JSON) in a child bun with the given allowlist. */
function runScenario(allowed: string[], body: string, extraEnv: Record<string, string> = {}): any {
    const configDir = path.join(tmp, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mount-allowlist.yaml"), `allowed:\n${allowed.map((a) => `  - ${a}`).join("\n")}\n`);
    const fakeBin = path.join(tmp, "fakebin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const log = path.join(tmp, "docker.log");
    fs.writeFileSync(log, "");
    fs.writeFileSync(path.join(tmp, "config.json"), process.env.FAKE_COMPOSE_CONFIG ?? '{"services":{}}');
    fs.writeFileSync(path.join(fakeBin, "docker"),
        `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase " $* " in *" config "*) cat ${JSON.stringify(path.join(tmp, "config.json"))};; esac\nexit 0\n`,
        { mode: 0o755 });
    const script = path.join(tmp, "scenario.ts");
    fs.writeFileSync(script, `
import fs from "node:fs";
import * as security from ${JSON.stringify(path.join(SRC, "security.ts"))};
import * as client from ${JSON.stringify(path.join(SRC, "compose/client.ts"))};
import { pinSandboxMounts } from ${JSON.stringify(path.join(SRC, "sandbox-mounts.ts"))};
const out = await (async () => { ${body} })();
console.log("RESULT:" + JSON.stringify(out));
`);
    const result = Bun.spawnSync(["bun", script], {
        env: {
            ...process.env,
            CARAPA_BOX_CONFIG_DIR: configDir,
            PATH: `${fakeBin}:${process.env.PATH}`,
            ...extraEnv,
        },
    });
    const line = result.stdout.toString().split("\n").reverse().find((l) => l.startsWith("RESULT:"));
    if (!line) throw new Error(`scenario failed: ${result.stderr.toString()}\n${result.stdout.toString()}`);
    return { ...JSON.parse(line.slice("RESULT:".length)), dockerLog: fs.readFileSync(log, "utf8") };
}

const attempt = `const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: String(e.message) }; } };`;

describe("pinMountSource", () => {
    it("resolves a symlink inside the base to the canonical subpath", () => {
        fs.mkdirSync(path.join(base, "real/x"), { recursive: true });
        fs.symlinkSync("real", path.join(base, "link"));
        const { pinned } = runScenario([base], `return { pinned: await security.pinMountSource(${JSON.stringify(path.join(base, "link/x"))}) };`);
        expect(pinned.base).toBe(base);
        expect(pinned.subpath).toBe("real/x");
        expect(pinned.volume).toMatch(/^carapa-mount-[0-9a-f]{16}$/);
    });

    it("uses a dot for the base itself", () => {
        const { pinned } = runScenario([base], `return { pinned: await security.pinMountSource(${JSON.stringify(base)}) };`);
        expect(pinned.subpath).toBe(".");
    });

    it("picks the outermost allowlist base for nested bases", () => {
        fs.mkdirSync(path.join(base, "inner/a"), { recursive: true });
        const { pinned } = runScenario([path.join(base, "inner"), base], `return { pinned: await security.pinMountSource(${JSON.stringify(path.join(base, "inner/a"))}) };`);
        expect(pinned.base).toBe(base);
        expect(pinned.subpath).toBe("inner/a");
    });

    it("rejects paths outside the allowlist, '..' escapes and credential-root overlap as isMountPathAllowed does", () => {
        fs.mkdirSync(path.join(base, "secret"));
        fs.mkdirSync(path.join(tmp, "outside"));
        const targets = [path.join(tmp, "outside"), `${base}/../outside`, path.join(base, "secret"), base];
        const result = runScenario([base], `${attempt}
            const res = [];
            for (const t of ${JSON.stringify(targets)}) res.push({ allowed: await security.isMountPathAllowed(t), pin: await attempt(() => security.pinMountSource(t)) });
            return { res };`, { PROVIDER_ACCOUNTS_DIR: path.join(base, "secret") });
        for (const entry of result.res) {
            expect(entry.allowed).toBe(false);
            expect(entry.pin.error).toContain("[SECURITY]");
        }
    });
});

describe("swapped mount component", () => {
    it("is refused before up and the emitted env uses volume + subpath", () => {
        fs.mkdirSync(path.join(base, "a/b"), { recursive: true });
        const stackDir = path.join(tmp, "stack");
        fs.mkdirSync(stackDir);
        const result = runScenario([base], `${attempt}
            const devices = new Map();
            const docker = async (args) => {
                if (args[1] === "create") devices.set(args.at(-1), args.find((a) => a.startsWith("device=")).slice(7));
                return { status: 0, stderr: "", stdout: args[1] === "inspect"
                    ? JSON.stringify([{ Driver: "local", Options: { type: "none", o: "bind", device: devices.get(args[2]) } }]) : "" };
            };
            const { env, pins } = await pinSandboxMounts({ LOCAL_REPO: ${JSON.stringify(path.join(base, "a/b"))} }, "proj", ${JSON.stringify(stackDir)}, docker);
            fs.rmSync(${JSON.stringify(path.join(base, "a"))}, { recursive: true });
            fs.symlinkSync("/", ${JSON.stringify(path.join(base, "a"))});
            const start = await attempt(() => client.startStack(${JSON.stringify(stackDir)}, "proj", env, undefined, pins));
            return { env, start };`);
        expect(result.env.LOCAL_REPO_SUBPATH).toBe("a/b");
        expect(result.env.LOCAL_REPO_VOLUME).toMatch(/^carapa-mount-/);
        expect(JSON.stringify(result.env)).not.toContain(base);
        expect(result.start.error).toContain("[SECURITY]");
        expect(result.dockerLog).not.toMatch(/(^| )up( |$)/m);
    });

    it("is refused when the subpath moves inside the base", () => {
        fs.mkdirSync(path.join(base, "a/b"), { recursive: true });
        fs.mkdirSync(path.join(base, "other/b"), { recursive: true });
        const result = runScenario([base], `${attempt}
            const pin = { key: "LOCAL_REPO", value: ${JSON.stringify(path.join(base, "a/b"))}, base: ${JSON.stringify(base)}, subpath: "a/b" };
            fs.rmSync(${JSON.stringify(path.join(base, "a"))}, { recursive: true });
            fs.symlinkSync("other", ${JSON.stringify(path.join(base, "a"))});
            return { verify: await attempt(() => security.verifyPinnedMounts([pin])) };`);
        expect(result.verify.error).toContain("changed after validation");
    });
});

describe("stack-declared mounts", () => {
    it("pins each stack-mounts.yaml entry (including a single file) and rejects paths outside the allowlist", () => {
        fs.mkdirSync(path.join(base, "repo"), { recursive: true });
        fs.writeFileSync(path.join(base, "repo/.env.example"), "x");
        const stackDir = path.join(tmp, "stack-with-mounts");
        fs.mkdirSync(stackDir);
        const write = (yaml: string) => fs.writeFileSync(path.join(stackDir, "stack-mounts.yaml"), yaml);
        const scenario = `${attempt}
            const devices = new Map();
            const docker = async (args) => {
                if (args[1] === "create") devices.set(args.at(-1), args.find((a) => a.startsWith("device=")).slice(7));
                return { status: 0, stderr: "", stdout: args[1] === "inspect"
                    ? JSON.stringify([{ Driver: "local", Options: { type: "none", o: "bind", device: devices.get(args[2]) } }]) : "" };
            };
            return await attempt(() => pinSandboxMounts({ ROOT: ${JSON.stringify(base)} }, "proj", ${JSON.stringify(stackDir)}, docker));`;
        write('mounts:\n  - name: M_REPO\n    path: ${ROOT}/repo\n  - name: M_ENV\n    path: ${ROOT}/repo/.env.example\n');
        const ok = runScenario([base], scenario).ok;
        expect(ok.env.MOUNT_M_REPO_SUBPATH).toBe("repo");
        expect(ok.env.MOUNT_M_ENV_SUBPATH).toBe("repo/.env.example");
        expect(ok.env.MOUNT_M_REPO_VOLUME).toMatch(/^carapa-mount-/);
        expect(ok.pins.map((pin: { key: string }) => pin.key)).toEqual(["MOUNT_M_REPO", "MOUNT_M_ENV"]);
        write(`mounts:\n  - name: M_OUT\n    path: ${tmp}\n`);
        expect(runScenario([base], scenario).error).toContain("[SECURITY]");
        // Malformed shapes must fail with the [SECURITY] error, not a raw TypeError.
        for (const malformed of ["mounts: {a: 1}\n", "mounts: abc\n", "mounts:\n  - \n", "mounts:\n  - abc\n", "mounts:\n  - [a]\n"]) {
            write(malformed);
            expect(runScenario([base], scenario).error).toStartWith("[SECURITY] stack-mounts.yaml:");
        }
    });
});

describe("compose config guard", () => {
    it("refuses a bind under an allowlist base, a validated mount value, or a device volume; allows STACK_DIR binds", () => {
        const stackDir = path.join(tmp, "stack");
        fs.mkdirSync(path.join(stackDir, "empty"), { recursive: true });
        const cfg = (volumes: unknown[]) => ({ services: { agent: { volumes } } });
        const result = runScenario([base], `${attempt}
            const check = (config) => attempt(() => client.assertNoUserBindMounts(config, ${JSON.stringify(stackDir)}, []));
            return {
                user: await check(${JSON.stringify(cfg([{ type: "bind", source: path.join(base, "repo"), target: "/w" }]))}),
                owned: await check(${JSON.stringify(cfg([{ type: "bind", source: path.join(stackDir, "empty"), target: "/e" }, { type: "bind", source: "/var/run/docker.sock", target: "/s" }]))}),
                device: await check({ services: {}, volumes: { v: { driver_opts: { device: ${JSON.stringify(base)} } } } }),
                pinned: await attempt(() => client.assertNoUserBindMounts(${JSON.stringify(cfg([{ type: "bind", source: "/srv/pinned", target: "/p" }]))}, ${JSON.stringify(stackDir)}, [{ key: "LOCAL_REPO", value: "/srv/pinned", base: "/srv", subpath: "pinned" }])),
            };`);
        expect(result.user.error).toContain("[SECURITY]");
        expect(result.owned.error).toBeUndefined();
        expect(result.device.error).toContain("[SECURITY]");
        expect(result.pinned.error).toContain("[SECURITY]");
    });

    it("startStack refuses a rendered bind mount and never calls up", () => {
        const stackDir = path.join(tmp, "stack");
        fs.mkdirSync(stackDir);
        process.env.FAKE_COMPOSE_CONFIG = JSON.stringify({ services: { a: { volumes: [{ type: "bind", source: path.join(base, "x"), target: "/x" }] } } });
        try {
            const result = runScenario([base], `${attempt} return { start: await attempt(() => client.startStack(${JSON.stringify(stackDir)}, "proj", {}, undefined, [])) };`);
            expect(result.start.error).toContain("[SECURITY]");
            expect(result.dockerLog).not.toMatch(/(^| )up( |$)/m);
        } finally {
            delete process.env.FAKE_COMPOSE_CONFIG;
        }
    });
});

describe("stack compose files", () => {
    it.each(STACK_FILES)("%s mounts user paths only as volume + subpath", (file) => {
        const doc = parseYaml(fs.readFileSync(file, "utf8"));
        const volumes: any[] = doc.services.agent.volumes;
        for (const key of MOUNT_KEYS) {
            const references = volumes.filter((v) => JSON.stringify(v).includes("${" + key));
            for (const ref of references) {
                expect(typeof ref).toBe("object");
                expect(ref.type).toBe("volume");
                expect(ref.volume.subpath).toContain("${" + key + "_SUBPATH");
                expect(doc.volumes[ref.source].external).toBe(true);
                expect(doc.volumes[ref.source].name).toContain("${" + key + "_VOLUME");
            }
            if (file.endsWith("docker-compose.yml") || ["GROUP_DIR", "IPC_MOUNT", "AGENT_HOME"].includes(key)) {
                // The agent home is also mounted read-only for the container-local skill and rule views.
                expect(references.length).toBe(key === "AGENT_HOME" ? 2 : 1);
            }
        }
        expect(volumes.some((v) => typeof v === "string" && MOUNT_KEYS.some((k) => v.includes("${" + k)))).toBe(false);
        expect(volumes.some((v) => v.type === "bind" && MOUNT_KEYS.some((k) => String(v.source).includes(k)))).toBe(false);
    });
});

describe("ensureBaseVolume", () => {
    const volumeJson = (device: string) => JSON.stringify([{ Driver: "local", Options: { type: "none", o: "bind", device } }]);

    it("creates the bind volume and accepts a matching device", async () => {
        const calls: string[][] = [];
        await ensureBaseVolume("/srv/base", "carapa-mount-x", async (args) => {
            calls.push(args);
            return { status: 0, stdout: args[1] === "inspect" ? volumeJson("/srv/base") : "", stderr: "" };
        });
        expect(calls[0]).toEqual(["volume", "create", "--driver", "local", "-o", "type=none", "-o", "o=bind", "-o", "device=/srv/base", "carapa-mount-x"]);
    });

    it("refuses an existing volume whose device differs", async () => {
        await expect(ensureBaseVolume("/srv/base", "carapa-mount-x", async (args) => ({
            status: 0, stdout: args[1] === "inspect" ? volumeJson("/") : "", stderr: "",
        }))).rejects.toThrow("different device");
    });
});
