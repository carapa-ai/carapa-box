import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, toolRegistry } from "./tools/register.js";
import {
    DEFAULT_SHUTDOWN_DRAIN_MS,
    drainLimitFromEnv,
    inflightCount,
    isDraining,
    resetDrainState,
    startDraining,
    trackToolCall,
    waitForIdle,
} from "./shutdown-drain.js";

beforeEach(() => resetDrainState());
afterEach(() => resetDrainState());

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

describe("trackToolCall", () => {
    it("counts a running handler and returns to 0 after resolve and after throw", async () => {
        const gate = deferred();
        const ok = trackToolCall(async () => { await gate.promise; return "done"; });
        const p = ok();
        expect(inflightCount()).toBe(1);
        gate.resolve();
        expect(await p).toBe("done");
        expect(inflightCount()).toBe(0);

        const bad = trackToolCall(async () => { throw new Error("boom"); });
        await expect(bad()).rejects.toThrow("boom");
        expect(inflightCount()).toBe(0);
    });

    it("rejects new calls while draining but lets a running call finish", async () => {
        const gate = deferred();
        let calls = 0;
        const handler = trackToolCall(async () => { calls++; await gate.promise; return "result"; });
        const running = handler();
        startDraining();
        expect(isDraining()).toBe(true);
        const refused = await handler();
        expect(refused).toEqual({
            content: [{ type: "text", text: "carapa-box is restarting; retry in a few seconds" }],
            isError: true,
        });
        expect(calls).toBe(1);
        gate.resolve();
        expect(await running).toBe("result");
    });
});

describe("waitForIdle", () => {
    it("resolves true as soon as the count reaches 0", async () => {
        const gate = deferred();
        const p = trackToolCall(async () => { await gate.promise; })();
        const idle = waitForIdle(1000, 5);
        setTimeout(gate.resolve, 20);
        expect(await idle).toBe(true);
        await p;
    });

    it("resolves false after the limit while a handler is pending", async () => {
        const gate = deferred();
        const p = trackToolCall(async () => { await gate.promise; })();
        const started = Date.now();
        expect(await waitForIdle(50, 5)).toBe(false);
        expect(Date.now() - started).toBeLessThan(500);
        gate.resolve();
        await p;
    });
});

describe("drainLimitFromEnv", () => {
    it("falls back to the default for unset, invalid or negative values", () => {
        expect(drainLimitFromEnv(undefined)).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
        expect(drainLimitFromEnv("")).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
        expect(drainLimitFromEnv("abc")).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
        expect(drainLimitFromEnv("-5")).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
        expect(drainLimitFromEnv("Infinity")).toBe(DEFAULT_SHUTDOWN_DRAIN_MS);
        expect(DEFAULT_SHUTDOWN_DRAIN_MS).toBe(120000);
    });
    it("uses a valid number", () => {
        expect(drainLimitFromEnv("3000")).toBe(3000);
        expect(drainLimitFromEnv("0")).toBe(0);
    });
});

describe("registerTools wiring", () => {
    it("wraps the toolRegistry handler and the MCP-registered handler", async () => {
        const mcpHandlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
        const fake = {
            tool: (name: string, _d: string, _s: unknown, cb: (...a: unknown[]) => Promise<unknown>) => {
                mcpHandlers.set(name, cb);
            },
        } as unknown as McpServer;
        registerTools(fake, true);
        startDraining();
        const expected = {
            content: [{ type: "text", text: "carapa-box is restarting; retry in a few seconds" }],
            isError: true,
        };
        expect(await toolRegistry.get("sandbox_list")!.handler({}, {})).toEqual(expected);
        expect(await mcpHandlers.get("sandbox_list")!({}, {})).toEqual(expected);
    });
});
