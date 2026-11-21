/**
 * Integration tests for the REST tool adapter endpoints:
 *   GET  /api/tools
 *   POST /api/tools/:name
 *
 * Strategy: import handleBunRequest and toolRegistry directly from their modules
 * (import.meta.main guard prevents main() from running during import), then
 * inject lightweight mock tools so every code path can be exercised without
 * Docker, filesystem access, or a real subprocess.
 *
 * Run with: bun test src/http.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as z from "zod";
import { handleBunRequest, activeSessions } from "./http/server.js";
import { toolRegistry } from "./tools/register.js";
import { ADMIN_TOOL_ALLOWLIST } from "./http/admin.js";

// ---------------------------------------------------------------------------
// Test setup: token + mock tools
// ---------------------------------------------------------------------------

const TEST_TOKEN = "http-test-token-xyz987";

let savedToken: string | undefined;

beforeAll(() => {
    // Point auth middleware at our test token
    savedToken = process.env.CARAPA_BOX_API_TOKEN;
    process.env.CARAPA_BOX_API_TOKEN = TEST_TOKEN;

    // ── Mock tools ────────────────────────────────────────────────────────
    // mock_success — no required arguments, always returns a successful result
    toolRegistry.set("mock_success", {
        description: "Mock tool that succeeds with no arguments",
        schema: {},
        handler: async () => ({
            content: [{ type: "text", text: "hello from mock" }],
        }),
    });

    // mock_required_arg — requires { name: string }, used to trigger 400
    toolRegistry.set("mock_required_arg", {
        description: "Mock tool that requires a 'name' argument",
        schema: { name: z.string() },
        handler: async (args: { name: string }) => ({
            content: [{ type: "text", text: `name=${args.name}` }],
        }),
    });

    // mock_is_error — returns isError:true so the adapter must reply with HTTP 500
    toolRegistry.set("mock_is_error", {
        description: "Mock tool that returns isError: true",
        schema: {},
        handler: async () => ({
            content: [{ type: "text", text: "tool-level error occurred" }],
            isError: true as const,
        }),
    });

    // mock_throws — throws an unhandled exception; adapter must catch it and return INTERNAL_ERROR
    toolRegistry.set("mock_throws", {
        description: "Mock tool that throws an unhandled exception",
        schema: {},
        handler: async (): Promise<never> => {
            throw new Error("intentional exception in mock_throws");
        },
    });
});

afterAll(() => {
    // Restore the original API token (or unset if it wasn't set before)
    if (savedToken !== undefined) {
        process.env.CARAPA_BOX_API_TOKEN = savedToken;
    } else {
        delete process.env.CARAPA_BOX_API_TOKEN;
    }
    // Remove mock tools so they don't pollute other test suites
    toolRegistry.delete("mock_success");
    toolRegistry.delete("mock_required_arg");
    toolRegistry.delete("mock_is_error");
    toolRegistry.delete("mock_throws");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Request with the test auth token. */
function req(method: string, path: string, body?: unknown): Request {
    const init: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${TEST_TOKEN}`,
        },
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }
    return new Request(`http://localhost${path}`, init);
}

/** Assert that the response carries the expected CORS headers. */
function expectCorsHeaders(res: Response): void {
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
}

// ---------------------------------------------------------------------------
// GET /api/tools — list all registered tools
// ---------------------------------------------------------------------------

describe("GET /api/tools", () => {
    it("returns 200 with an array of tool definitions", async () => {
        const res = await handleBunRequest(req("GET", "/api/tools"));

        expect(res.status).toBe(200);
        expectCorsHeaders(res);

        const body = await res.json() as Array<{ name: string; description: string }>;
        expect(Array.isArray(body)).toBe(true);
    });

    it("includes mock tools in the listing and each entry has name + description", async () => {
        const res = await handleBunRequest(req("GET", "/api/tools"));
        const body = await res.json() as Array<{ name: string; description: string }>;

        const names = body.map((t) => t.name);
        expect(names).toContain("mock_success");
        expect(names).toContain("mock_is_error");

        for (const entry of body) {
            expect(typeof entry.name).toBe("string");
            expect(typeof entry.description).toBe("string");
        }
    });
});

// ---------------------------------------------------------------------------
// POST /api/tools/:name — happy paths
// ---------------------------------------------------------------------------

describe("POST /api/tools/:name — success", () => {
    it("returns 200 with { result, isError: false } for a valid no-arg tool call", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_success", {}));

        expect(res.status).toBe(200);
        expectCorsHeaders(res);

        const body = await res.json() as { result: string; isError: boolean };
        expect(body.result).toBe("hello from mock");
        expect(body.isError).toBe(false);
    });

    it("result is a string and isError is a boolean", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_success", {}));
        const body = await res.json() as { result: string; isError: boolean };

        expect(typeof body.result).toBe("string");
        expect(typeof body.isError).toBe("boolean");
    });

    it("passes an empty arguments object {} through to the handler", async () => {
        // mock_success has an empty schema so {} is the only valid input
        const res = await handleBunRequest(req("POST", "/api/tools/mock_success", {}));

        expect(res.status).toBe(200);
        const body = await res.json() as { result: string };
        expect(body.result).toBe("hello from mock");
    });

    it("passes validated arguments to the handler", async () => {
        const res = await handleBunRequest(
            req("POST", "/api/tools/mock_required_arg", { name: "world" })
        );

        expect(res.status).toBe(200);
        const body = await res.json() as { result: string; isError: boolean };
        expect(body.result).toBe("name=world");
        expect(body.isError).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// POST /api/tools/:name — error paths
// ---------------------------------------------------------------------------

describe("POST /api/tools/:name — error paths", () => {
    it("returns 404 for an unknown tool name", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/does_not_exist", {}));

        expect(res.status).toBe(404);
        expectCorsHeaders(res);

        const body = await res.json() as { error: string; tool: string };
        expect(body.error).toBe("Unknown tool");
        expect(body.tool).toBe("does_not_exist");
    });

    it("returns 404 for a tool name containing special characters (URL-decoded, still unknown)", async () => {
        // 'no%20such%20tool' decodes to 'no such tool' — not in the registry
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/no%20such%20tool", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${TEST_TOKEN}`,
                },
                body: JSON.stringify({}),
            })
        );

        expect(res.status).toBe(404);
        expectCorsHeaders(res);

        const body = await res.json() as { error: string };
        expect(body.error).toBe("Unknown tool");
    });

    it("returns 400 when required arguments are missing (Zod validation failure)", async () => {
        // mock_required_arg requires { name: string }; sending {} fails schema validation
        const res = await handleBunRequest(req("POST", "/api/tools/mock_required_arg", {}));

        expect(res.status).toBe(400);
        expectCorsHeaders(res);

        const body = await res.json() as { error: string; details: unknown[] };
        expect(body.error).toBe("Validation failed");
        expect(Array.isArray(body.details)).toBe(true);
        expect(body.details.length).toBeGreaterThan(0);
    });

    it("returns 400 when the request body is not valid JSON (falls back to {} which fails schema)", async () => {
        // Invalid JSON → req.json() rejects → caught and treated as {} → Zod rejects missing 'name'
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_required_arg", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${TEST_TOKEN}`,
                },
                body: "this is not valid json }{",
            })
        );

        expect(res.status).toBe(400);
        expectCorsHeaders(res);

        const body = await res.json() as { error: string };
        expect(body.error).toBe("Validation failed");
    });

    it("returns HTTP 500 when the tool returns isError: true", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_is_error", {}));

        expect(res.status).toBe(500);
        expectCorsHeaders(res);

        const body = await res.json() as { result: string; isError: boolean };
        expect(body.isError).toBe(true);
        expect(typeof body.result).toBe("string");
    });

    it("returns 500 with code INTERNAL_ERROR when the handler throws an exception", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_throws", {}));

        expect(res.status).toBe(500);
        expectCorsHeaders(res);

        const body = await res.json() as { error: string; code: string };
        expect(body.code).toBe("INTERNAL_ERROR");
        expect(body.error).toContain("intentional exception");
    });
});

// ---------------------------------------------------------------------------
// Auth — Admin routes (/api/admin/*)
// ---------------------------------------------------------------------------
// NOTE: /api/admin/stacks is used instead of /api/admin/info here because
// /info shells out to `docker compose ls` which is unavailable in the test
// environment.  Both routes share the exact same auth gate.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = "http-test-admin-token-abc123";

describe("Authentication — Admin routes", () => {
    let savedAdminToken: string | undefined;

    beforeAll(() => {
        savedAdminToken = process.env.CARAPA_BOX_ADMIN_TOKEN;
        process.env.CARAPA_BOX_ADMIN_TOKEN = ADMIN_TOKEN;
    });

    afterAll(() => {
        if (savedAdminToken !== undefined) {
            process.env.CARAPA_BOX_ADMIN_TOKEN = savedAdminToken;
        } else {
            delete process.env.CARAPA_BOX_ADMIN_TOKEN;
        }
    });

    it("valid admin token → 200", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/admin/stacks", {
                headers: { "Authorization": `Bearer ${ADMIN_TOKEN}` },
            })
        );
        expect(res.status).toBe(200);
        // Admin routes are same-origin — no CORS headers
    });

    it("admin routes fail closed without a distinct admin token", async () => {
        try {
            for (const configured of [undefined, TEST_TOKEN]) {
                if (configured === undefined) delete process.env.CARAPA_BOX_ADMIN_TOKEN;
                else process.env.CARAPA_BOX_ADMIN_TOKEN = configured;
                for (const supplied of [undefined, TEST_TOKEN, ADMIN_TOKEN]) {
                    const res = await handleBunRequest(new Request("http://localhost/api/admin/stacks", {
                        headers: supplied ? { Authorization: `Bearer ${supplied}` } : {},
                    }));
                    expect(res.status).toBe(503);
                }
            }
        } finally {
            process.env.CARAPA_BOX_ADMIN_TOKEN = ADMIN_TOKEN;
        }
    });

    it("API and admin credentials cannot cross roles", async () => {
        const admin = await handleBunRequest(new Request("http://localhost/api/admin/stacks", {
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        }));
        const api = await handleBunRequest(new Request("http://localhost/api/tools", {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }));
        expect(admin.status).toBe(401);
        expect(api.status).toBe(401);
    });

    it("no Authorization header → 401 with WWW-Authenticate: Bearer", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/admin/stacks")
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
        // Admin routes are same-origin — no CORS headers
    });

    it("wrong token → 401", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/admin/stacks", {
                headers: { "Authorization": "Bearer wrong-token-xyz" },
            })
        );
        expect(res.status).toBe(401);
    });

    it("malformed Authorization header (no 'Bearer ' prefix) → 401", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/admin/stacks", {
                // raw token value, no "Bearer " prefix
                headers: { "Authorization": ADMIN_TOKEN },
            })
        );
        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// POST /api/admin/tools/:name — operator control actions (admin dashboard)
// ---------------------------------------------------------------------------

describe("POST /api/admin/tools/:name — operator control actions", () => {
    let savedAdminToken: string | undefined;

    const adminReq = (path: string, body?: unknown, token: string | undefined = ADMIN_TOKEN): Request =>
        new Request(`http://localhost${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    beforeAll(() => {
        savedAdminToken = process.env.CARAPA_BOX_ADMIN_TOKEN;
        process.env.CARAPA_BOX_ADMIN_TOKEN = ADMIN_TOKEN;

        // Mock lifecycle tools temporarily allowlisted for the admin surface.
        toolRegistry.set("mock_ctrl", {
            description: "Mock lifecycle tool",
            schema: { name: z.string() },
            handler: async (args: { name: string }) => ({
                content: [{ type: "text", text: `ctrl:${args.name}` }],
            }),
        });
        toolRegistry.set("mock_ctrl_throws", {
            description: "Mock lifecycle tool that throws",
            schema: {},
            handler: async (): Promise<never> => { throw new Error("ctrl boom"); },
        });
        ADMIN_TOOL_ALLOWLIST.add("mock_ctrl");
        ADMIN_TOOL_ALLOWLIST.add("mock_ctrl_throws");
    });

    afterAll(() => {
        if (savedAdminToken !== undefined) process.env.CARAPA_BOX_ADMIN_TOKEN = savedAdminToken;
        else delete process.env.CARAPA_BOX_ADMIN_TOKEN;
        toolRegistry.delete("mock_ctrl");
        toolRegistry.delete("mock_ctrl_throws");
        ADMIN_TOOL_ALLOWLIST.delete("mock_ctrl");
        ADMIN_TOOL_ALLOWLIST.delete("mock_ctrl_throws");
    });

    it("runs an allowlisted tool with the admin token", async () => {
        const res = await handleBunRequest(adminReq("/api/admin/tools/mock_ctrl", { name: "openclaw" }));
        expect(res.status).toBe(200);
        const body = await res.json() as { result: string; isError: boolean };
        expect(body.result).toBe("ctrl:openclaw");
        expect(body.isError).toBe(false);
    });

    it("rejects invalid arguments with 400", async () => {
        const res = await handleBunRequest(adminReq("/api/admin/tools/mock_ctrl", { name: 42 }));
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string; details: unknown[] };
        expect(body.error).toBe("Validation failed");
        expect(Array.isArray(body.details)).toBe(true);
    });

    it("returns 500 with code INTERNAL_ERROR when the handler throws", async () => {
        const res = await handleBunRequest(adminReq("/api/admin/tools/mock_ctrl_throws", {}));
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string; code: string };
        expect(body.code).toBe("INTERNAL_ERROR");
        expect(body.error).toContain("ctrl boom");
    });

    it("rejects tools outside the allowlist even when registered", async () => {
        // mock_required_arg is registered but not allowlisted for the admin surface.
        const res = await handleBunRequest(adminReq("/api/admin/tools/mock_required_arg", { name: "x" }));
        expect(res.status).toBe(404);
    });

    it("rejects GET on the tools surface", async () => {
        const res = await handleBunRequest(new Request("http://localhost/api/admin/tools/mock_ctrl", {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        }));
        expect(res.status).toBe(404);
    });

    it("rejects unknown tool names", async () => {
        const res = await handleBunRequest(adminReq("/api/admin/tools/does_not_exist", {}));
        expect(res.status).toBe(404);
    });

    it("does not accept the sandbox API token for the admin surface", async () => {
        const res = await handleBunRequest(adminReq("/api/admin/tools/mock_ctrl", { name: "x" }, TEST_TOKEN));
        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// Auth — API (non-admin) routes
// ---------------------------------------------------------------------------

describe("Authentication — API routes", () => {
    it("valid API token → 200", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_success", {}));
        expect(res.status).toBe(200);
    });

    it("no Authorization header → 401 with WWW-Authenticate: Bearer", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            })
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("wrong token → 401", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer wrong-token-xyz",
                },
                body: JSON.stringify({}),
            })
        );
        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// Auth — Public routes (no auth required)
// ---------------------------------------------------------------------------

describe("Authentication — Public routes (bypass)", () => {
    it("GET /health with no token → 200", async () => {
        const res = await handleBunRequest(new Request("http://localhost/health"));
        expect(res.status).toBe(200);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("GET /status with no token → 200", async () => {
        const res = await handleBunRequest(new Request("http://localhost/status"));
        expect(res.status).toBe(200);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("OPTIONS preflight with no token → 204", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", { method: "OPTIONS" })
        );
        expect(res.status).toBe(204);
    });
});

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

describe("CORS headers", () => {
    it("authenticated API response includes Access-Control-Allow-Origin: *", async () => {
        const res = await handleBunRequest(req("POST", "/api/tools/mock_success", {}));
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("401 response includes Access-Control-Allow-Origin: *", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            })
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("OPTIONS preflight includes Access-Control-Allow-Methods with GET, POST, OPTIONS", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", { method: "OPTIONS" })
        );
        const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
        expect(methods).toContain("GET");
        expect(methods).toContain("POST");
        expect(methods).toContain("OPTIONS");
    });

    it("OPTIONS preflight includes Access-Control-Allow-Headers echoing the request", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tools/mock_success", {
                method: "OPTIONS",
                headers: { "Access-Control-Request-Headers": "Content-Type, Authorization" },
            })
        );
        expect(res.headers.get("Access-Control-Allow-Headers")).toBeTruthy();
    });

    it("public /health response includes Access-Control-Allow-Origin: *", async () => {
        const res = await handleBunRequest(new Request("http://localhost/health"));
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
});

// ---------------------------------------------------------------------------
// MCP session handling — unknown / expired session ids
// ---------------------------------------------------------------------------

describe("MCP /api/mcp — unknown session id", () => {
    const STALE_ID = "00000000-0000-0000-0000-000000000000";
    const INIT_BODY = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
        },
    };

    function mcpReq(method: string, body?: unknown, sessionId?: string): Request {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": `Bearer ${TEST_TOKEN}`,
        };
        if (sessionId) headers["mcp-session-id"] = sessionId;
        return new Request("http://localhost/api/mcp", {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    afterEach(async () => {
        for (const entry of activeSessions.values()) await entry.transport.close();
        activeSessions.clear();
    });

    it("POST tools/list with unknown session id → 404 / -32001, no session created", async () => {
        const before = activeSessions.size;
        const res = await handleBunRequest(mcpReq("POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, STALE_ID));
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.error.code).toBe(-32001);
        expect(json.id).toBeNull();
        expect(activeSessions.size).toBe(before);
    });

    it("GET with unknown session id → 404", async () => {
        const res = await handleBunRequest(mcpReq("GET", undefined, STALE_ID));
        expect(res.status).toBe(404);
    });

    it("DELETE with unknown session id → 404", async () => {
        const res = await handleBunRequest(mcpReq("DELETE", undefined, STALE_ID));
        expect(res.status).toBe(404);
    });

    it("POST initialize with unknown session id creates a new session", async () => {
        const res = await handleBunRequest(mcpReq("POST", INIT_BODY, STALE_ID));
        expect(res.status).toBe(200);
        const newId = res.headers.get("mcp-session-id");
        expect(newId).toBeTruthy();
        expect(newId).not.toBe(STALE_ID);
        expect(activeSessions.has(newId!)).toBe(true);
    });

    it("POST initialize without session id still works", async () => {
        const res = await handleBunRequest(mcpReq("POST", INIT_BODY));
        expect(res.status).toBe(200);
        expect(activeSessions.has(res.headers.get("mcp-session-id")!)).toBe(true);
    });
});
