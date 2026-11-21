import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAppRoot, readBuildInfo } from "./build-info.js";

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "build-info-"));
}

describe("readBuildInfo", () => {
    it("reads VERSION and BUILD_TIME when present", () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, "VERSION"), "abc1234\n");
        fs.writeFileSync(path.join(dir, "BUILD_TIME"), "2026-10-13T10:00:00Z\n");
        expect(readBuildInfo(dir, "2026-10-13T11:00:00.000Z")).toEqual({
            version: "abc1234",
            buildTime: "2026-10-13T10:00:00Z",
            startedAt: "2026-10-13T11:00:00.000Z",
        });
    });

    it("falls back to development / null when files are missing", () => {
        const info = readBuildInfo(tmp());
        expect(info.version).toBe("development");
        expect(info.buildTime).toBeNull();
        expect(new Date(info.startedAt).toISOString()).toBe(info.startedAt);
    });

    it("finds the app root independent of cwd", () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, "dist"));
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
        expect(findAppRoot(path.join(dir, "dist"))).toBe(dir);
    });
});

interface HealthBody {
    version: unknown;
    buildTime: unknown;
    startedAt: unknown;
}

describe("/health payload", () => {
    it("keeps existing fields and adds build metadata on /health and /status", async () => {
        const { handleBunRequest } = await import("./server.js");
        for (const route of ["/health", "/status"]) {
            const res = await handleBunRequest(new Request(`http://localhost${route}`));
            const body: HealthBody & Record<string, unknown> = await res.json();
            for (const key of ["status", "name", "active_sessions", "memory", "uptime"]) expect(body).toHaveProperty(key);
            expect(typeof body.version).toBe("string");
            expect(body.buildTime === null || typeof body.buildTime === "string").toBe(true);
            if (typeof body.startedAt !== "string") throw new Error("startedAt must be a string");
            expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
        }
    });

    it("answers /health with development/null when metadata files are missing", async () => {
        const root = tmp();
        const script = 'const { handleBunRequest } = await import(process.argv[1]);'
            + 'const r = await handleBunRequest(new Request("http://localhost/health"));'
            + 'console.log(JSON.stringify(await r.json()));process.exit(0);';
        const proc = Bun.spawnSync(["bun", "-e", script, path.join(import.meta.dir, "server.js")], {
            env: { ...process.env, CARAPA_BOX_APP_ROOT: root },
            cwd: root,
        });
        expect(proc.exitCode).toBe(0);
        const body: HealthBody = JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "");
        expect(body.version).toBe("development");
        expect(body.buildTime).toBeNull();
    }, 20_000);
});
