import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStack } from "./config.js";

describe("stack discovery", () => {
    it("discovers a stack without an exec approval manifest", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapabox-stacks-"));
        const stack = path.join(root, "fixture");
        const previous = process.env.SANDBOX_STACKS_DIR;
        fs.mkdirSync(stack);
        fs.writeFileSync(path.join(stack, "docker-compose.yml"), "services: {}\n");
        fs.writeFileSync(path.join(stack, "policy.wasm"), "fixture");
        process.env.SANDBOX_STACKS_DIR = root;
        try {
            expect((await getStack("fixture"))?.name).toBe("fixture");
        } finally {
            if (previous === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = previous;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a stack undiscoverable without policy.wasm", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "carapabox-stacks-"));
        const stack = path.join(root, "fixture");
        const previous = process.env.SANDBOX_STACKS_DIR;
        fs.mkdirSync(stack);
        fs.writeFileSync(path.join(stack, "docker-compose.yml"), "services: {}\n");
        process.env.SANDBOX_STACKS_DIR = root;
        try {
            expect(await getStack("fixture")).toBeNull();
        } finally {
            if (previous === undefined) delete process.env.SANDBOX_STACKS_DIR;
            else process.env.SANDBOX_STACKS_DIR = previous;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
