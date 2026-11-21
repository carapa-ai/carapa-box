import { describe, expect, it, spyOn } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as compose from "../compose/client.js";
import * as directories from "../sandbox-directories.js";
import { registerTools } from "./register.js";

type ToolResult = { isError?: boolean; content: { text: string }[] };
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function registerSandboxStart(): ToolHandler {
    const handlers = new Map<string, ToolHandler>();
    const fakeServer = {
        tool: (name: string, _d: string, _s: unknown, cb: ToolHandler) => {
            handlers.set(name, cb);
        },
    };
    // The fake only implements McpServer.tool(), the one method registerTools calls.
    registerTools(fakeServer as unknown as McpServer, false);
    return handlers.get("sandbox_start")!;
}

describe("sandbox_start instance validation", () => {
    it("rejects a traversal instance before touching compose or host directories", async () => {
        const sandboxStart = registerSandboxStart();
        const startStack = spyOn(compose, "startStack");
        const prepare = spyOn(directories, "prepareSandboxDirectory");

        const result = await sandboxStart({ name: "example", instance: "../../x" }, {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toStartWith("Invalid instance:");
        expect(startStack).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
    });

    it("rejects interpreter env keys before running any hook", async () => {
        const sandboxStart = registerSandboxStart();
        const startStack = spyOn(compose, "startStack");
        const prepare = spyOn(directories, "prepareSandboxDirectory");
        startStack.mockClear();
        prepare.mockClear();

        const result = await sandboxStart({
            name: "example",
            env: { BUN_OPTIONS: "-e console.log(42)", GIT_CONFIG_COUNT: "1", GIT_REPO: "https://example.com/r.git" },
        }, {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("[SECURITY] sandbox_start env rejected: BUN_OPTIONS, GIT_CONFIG_COUNT");
        expect(result.content[0].text).not.toContain("GIT_REPO");
        expect(startStack).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
    });
});
