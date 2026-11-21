import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as compose from "../compose/client.js";
import * as hooks from "../compose/hooks.js";
import * as relayTokens from "../relay-token-store.js";
import * as utils from "../utils.js";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const handlers = new Map<string, Handler>();

beforeAll(() => {
    const fakeServer = {
        tool: (name: string, _d: string, _s: unknown, cb: Handler) => {
            handlers.set(name, cb);
        },
    };
    registerTools(fakeServer as unknown as Parameters<typeof registerTools>[0], false);
});

let stackDir: string;

afterEach(() => {
    spyOn(compose, "getStackStatus").mockRestore();
    spyOn(compose, "stopStack").mockRestore();
    spyOn(hooks, "runHook").mockRestore();
    spyOn(relayTokens, "deleteRelayToken").mockRestore();
    spyOn(utils, "resolveStackAndProject").mockRestore();
    fs.rmSync(stackDir, { recursive: true, force: true });
});

function setup(opts: { beforeStopExit?: number; stopThrows?: boolean }) {
    stackDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-stop-tokens-"));
    const deleted: string[] = [];
    spyOn(utils, "resolveStackAndProject").mockResolvedValue({ stackPath: stackDir, projectName: "p" } as never);
    spyOn(compose, "getStackStatus").mockResolvedValue({ code: 0, stdout: "", stderr: "" } as never);
    spyOn(hooks, "runHook").mockImplementation((async (_dir: string, hook: string) => {
        if (hook === "before-stop" && opts.beforeStopExit !== undefined) {
            return { executed: true, exitCode: opts.beforeStopExit, stdout: "", stderr: "nope" };
        }
        return { executed: false, exitCode: 0, stdout: "", stderr: "" };
    }) as unknown as typeof hooks.runHook);
    spyOn(compose, "stopStack").mockImplementation((async () => {
        if (opts.stopThrows) throw new Error("compose down failed");
        return { code: 0, stdout: "", stderr: "" };
    }) as unknown as typeof compose.stopStack);
    spyOn(relayTokens, "deleteRelayToken").mockImplementation((async (name: string, service?: string) => {
        deleted.push(`${name}:${service ?? "board"}`);
    }) as unknown as typeof relayTokens.deleteRelayToken);
    return deleted;
}

describe("sandbox_stop relay tokens", () => {
    it("keeps the relay tokens when before-stop fails", async () => {
        const deleted = setup({ beforeStopExit: 1 });
        const result = await handlers.get("sandbox_stop")!({ name: "s" }, {});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("before-stop hook failed");
        expect(deleted).toEqual([]);
    });

    it("keeps the relay tokens when stopStack throws", async () => {
        const deleted = setup({ stopThrows: true });
        const result = await handlers.get("sandbox_stop")!({ name: "s" }, {});
        expect(result.isError).toBe(true);
        expect(deleted).toEqual([]);
    });

    it("deletes board and carapa-mail tokens after a successful stop", async () => {
        const deleted = setup({});
        const result = await handlers.get("sandbox_stop")!({ name: "s" }, {});
        expect(result.isError).toBeUndefined();
        expect(deleted).toContain("p-agent-1:board");
        expect(deleted).toContain("p-agent-1:carapa-mail");
    });
});
