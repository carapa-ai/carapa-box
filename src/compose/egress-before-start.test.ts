import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EGRESS_DIR = path.resolve(import.meta.dir, "../../egress-proxy");

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-before-start-"));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function composeImages(): string[] {
    const compose = fs.readFileSync(path.join(EGRESS_DIR, "docker-compose.yml"), "utf8");
    return [...compose.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/** Run before-start.sh with a fake `docker` that only knows `present` image tags. */
function runHook(present: string[]) {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const fake = path.join(bin, "docker");
    fs.writeFileSync(
        fake,
        `#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 1\ncase "$3" in\n${present
            .map((tag) => `  ${tag}) exit 0;;`)
            .join("\n")}\nesac\nexit 1\n`,
    );
    fs.chmodSync(fake, 0o755);
    return spawnSync("sh", [path.join(EGRESS_DIR, "before-start.sh")], {
        env: { PATH: `${bin}:${process.env.PATH}`, SECRETS_DIR: path.join(dir, "secrets"), HOME: dir },
        encoding: "utf8",
    });
}

describe("egress-proxy/before-start.sh image check", () => {
    it("passes when the images that docker-compose.yml builds exist", () => {
        const images = composeImages();
        expect(images.length).toBe(3);
        const r = runHook(images);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
    });

    it("fails and names the missing image", () => {
        const [first, ...rest] = composeImages();
        const r = runHook(rest);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`Image '${first}' not found`);
    });
});

describe("egress-proxy/before-start.sh secret placeholders", () => {
    it("creates a placeholder for every secret docker-compose.yml declares", () => {
        const compose = fs.readFileSync(path.join(EGRESS_DIR, "docker-compose.yml"), "utf8");
        const declared = [...compose.matchAll(/^\s+file:\s*\$\{SECRETS_DIR\}\/(\S+)\s*$/gm)].map((m) => m[1]);
        expect(declared.length).toBeGreaterThan(7);
        runHook(composeImages());
        for (const name of declared) {
            expect(fs.existsSync(path.join(dir, "secrets", name))).toBe(true);
        }
    });
});

describe("egress-proxy secret placeholders follow the .env next to the Compose file", () => {
    const composeSource = path.join(EGRESS_DIR, "docker-compose.yml");

    /** Private deploy dir holding a compose copy, the hook and the given .env text. */
    function deployDir(envText: string): string {
        const deploy = path.join(dir, "deploy");
        fs.mkdirSync(deploy);
        fs.copyFileSync(composeSource, path.join(deploy, "docker-compose.yml"));
        fs.copyFileSync(path.join(EGRESS_DIR, "before-start.sh"), path.join(deploy, "before-start.sh"));
        fs.writeFileSync(path.join(deploy, ".env"), envText);
        return deploy;
    }

    /** Run a script with a fake `docker` that succeeds, and no SECRETS_DIR in the environment. */
    function run(script: string, extraEnv: Record<string, string> = {}) {
        const bin = path.join(dir, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n");
        fs.chmodSync(path.join(bin, "docker"), 0o755);
        return spawnSync("sh", [script], {
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, "home"), ...extraEnv },
            encoding: "utf8",
        });
    }

    const variants: [string, (secrets: string) => string][] = [
        ["double-quoted", (s) => `SECRETS_DIR="${s}"\n`],
        ["single-quoted", (s) => `SECRETS_DIR='${s}'\n`],
        ["exported, with an inline comment", (s) => `export SECRETS_DIR=${s} # keys\n`],
        ["repeated (last wins)", (s) => `SECRETS_DIR=/ignored\nSECRETS_DIR=${s}\n`],
    ];

    for (const [name, line] of variants) {
        it(`before-start.sh reads a ${name} SECRETS_DIR from the deploy-dir .env`, () => {
            const secrets = path.join(dir, "my secrets");
            const deploy = deployDir(line(secrets));
            run(path.join(deploy, "before-start.sh"));
            expect(fs.existsSync(path.join(secrets, "anthropic_api_key"))).toBe(true);
            expect(fs.existsSync(path.join(dir, "home", ".secrets"))).toBe(false);
        });
    }

    it("build.sh reads the quoted SECRETS_DIR from the .env beside CARAPA_EGRESS_DEPLOY_DIR's compose file", () => {
        const secrets = path.join(dir, "my secrets");
        const deploy = deployDir(`SECRETS_DIR="${secrets}"\n`);
        const r = run(path.join(EGRESS_DIR, "build.sh"), { CARAPA_EGRESS_DEPLOY_DIR: deploy });
        expect(r.status).toBe(0);
        expect(fs.existsSync(path.join(secrets, "anthropic_api_key"))).toBe(true);
        expect(fs.existsSync(path.join(dir, "home", ".secrets"))).toBe(false);
    });
});
