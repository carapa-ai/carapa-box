import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store computes its state dir at import time and bun shares one module
// registry across test files, so run it in a child process with its own env.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-token-store-"));
const file = path.join(dir, "relay-tokens.json");
const storeUrl = new URL("./relay-token-store.ts", import.meta.url).href;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function runChild(body: string, stateDir = dir): any {
    const script = `const s = await import(${JSON.stringify(storeUrl)});\n${body}`;
    const res = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, CARAPA_BOX_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    const lines = res.stdout.toString().trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
}

const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
const tmpFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("relay-token-store concurrency", () => {
    test("20 parallel sets are all persisted with no temp files", () => {
        runChild(`
            await Promise.all(Array.from({ length: 20 }, (_, i) => s.setRelayToken("sb-" + i, "tok-" + i)));
            console.log("{}");
        `);
        const disk = read();
        expect(Object.keys(disk).length).toBe(20);
        for (let i = 0; i < 20; i++) expect(disk[`sb-${i}`]).toBe(`tok-${i}`);
        expect(tmpFiles()).toEqual([]);
    });

    test("set racing delete leaves disk equal to memory", () => {
        const mem = runChild(`
            await Promise.all([s.setRelayToken("race-new", "x"), s.deleteRelayToken("sb-3")]);
            const out = {};
            for (let i = 0; i < 20; i++) { const t = s.getRelayToken("sb-" + i); if (t) out["sb-" + i] = t; }
            out["race-new"] = s.getRelayToken("race-new");
            console.log(JSON.stringify(out));
        `);
        expect(read()).toEqual(mem);
        expect("sb-3" in mem).toBe(false);
        expect(mem["race-new"]).toBe("x");
        expect(tmpFiles()).toEqual([]);
    });
});

describe("relay-token-store persist failure", () => {
    test("re-issuing the same token after a failed persist writes it", () => {
        const failDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-token-store-fail-"));
        try {
            // A directory at the store path makes the snapshot rename fail.
            const blocker = path.join(failDir, "relay-tokens.json");
            runChild(`
                import fs from "node:fs";
                fs.mkdirSync(${JSON.stringify(blocker)});
                await s.setRelayToken("sb-fail", "tok");
                fs.rmdirSync(${JSON.stringify(blocker)});
                await s.setRelayToken("sb-fail", "tok");
                console.log("{}");
            `, failDir);
            expect(JSON.parse(fs.readFileSync(path.join(failDir, "relay-tokens.json"), "utf8"))).toEqual({ "sb-fail": "tok" });
        } finally {
            fs.rmSync(failDir, { recursive: true, force: true });
        }
    });
});
