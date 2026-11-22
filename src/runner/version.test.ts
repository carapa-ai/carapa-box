import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FALLBACK_VERSION, runnerVersion } from "./version.js";

describe("runnerVersion", () => {
    it("returns a short hex sha inside this repo", () => {
        expect(runnerVersion()).toMatch(/^[0-9a-f]{7,}$/);
    });

    it("returns the fallback for a non-git directory", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-version-"));
        try {
            expect(runnerVersion(dir)).toBe(FALLBACK_VERSION);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
