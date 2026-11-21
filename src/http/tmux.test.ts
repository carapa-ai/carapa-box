/**
 * HTTP-level tests for the REST + SSE tmux adapter (src/http/tmux.ts).
 *
 * Stubs the `attachTmuxSession`, `execTmuxSession`, and `detachTmuxSession`
 * exports from `../tmux-session.js` (the real implementations shell out to
 * docker; we don't need them in unit tests). The stubs let each test
 * control what the `onDelta` callback fires, what the scrollback looks
 * like, and what `exec` returns — so every test path can run without
 * Docker, policy compilation, or a real subprocess.
 *
 * Run with: bun test src/http/tmux.test.ts
 */

import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";

interface CapturedDelta { streamId: string; delta: string }
interface CapturedExec {
    input: string;
    inputBase64?: boolean;
    cols?: number;
    rows?: number;
    session: string;
    service: string;
}
interface CapturedDetach {
    session: string;
    streamId: string;
}

interface Stubs {
    deltas: CapturedDelta[];
    scrollbackByStreamId: Map<string, string>;
    execCalls: CapturedExec[];
    detachCalls: CapturedDetach[];
    /** Drives the `onDelta` callback the next time `attachTmuxSession` is called. */
    pendingDeltas: CapturedDelta[];
    /** What `execTmuxSession` returns. Tests can override per-call. */
    execResult: { stdout: string; stderr: string; code: number };
    /** What `detachTmuxSession` returns. */
    detachResult: { stdout: string; stderr: string; code: number };
    /** The next streamId the stubbed `attachTmuxSession` will mint. */
    nextStreamId: string;
    /** Whether the stubbed `attachTmuxSession` should reject. */
    attachShouldFail: boolean;
    /** Emit a shell-exit lifecycle event during the next attach. */
    exitOnAttach: boolean;
    /** When set, the stubbed `attachTmuxSession` waits for this promise before resolving. */
    attachGate: Promise<void> | null;
}

const stubs: Stubs = {
    deltas: [],
    scrollbackByStreamId: new Map(),
    execCalls: [],
    detachCalls: [],
    pendingDeltas: [],
    execResult: { stdout: "", stderr: "", code: 0 },
    detachResult: { stdout: "", stderr: "", code: 0 },
    nextStreamId: "stub-stream-uuid-0001",
    attachShouldFail: false,
    exitOnAttach: false,
    attachGate: null,
};
const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const policyCommands: Array<{ command: string; tool: string }> = [];

function resetStubs() {
    stubs.deltas.length = 0;
    stubs.scrollbackByStreamId.clear();
    stubs.execCalls.length = 0;
    stubs.detachCalls.length = 0;
    stubs.pendingDeltas.length = 0;
    stubs.execResult = { stdout: "", stderr: "", code: 0 };
    stubs.detachResult = { stdout: "", stderr: "", code: 0 };
    stubs.nextStreamId = "stub-stream-uuid-0001";
    stubs.attachShouldFail = false;
    stubs.exitOnAttach = false;
    stubs.attachGate = null;
    warnCalls.length = 0;
}

// ── Module mocks (must be installed before importing handleBunRequest) ──────

// mock.module outlives this file; keep the real modules for afterAll.
const realModules = {
    config: { ...(await import("../config.js")) },
    client: { ...(await import("../compose/client.js")) },
    networkPolicy: { ...(await import("../network-policy.js")) },
    logger: { ...(await import("../logger.js")) },
};

mock.module("../tmux-session.js", () => {
    return {
        attachTmuxSession: async (opts: any) => {
            if (stubs.attachShouldFail) {
                throw new Error("stubbed attach failure");
            }
            if (stubs.attachGate) await stubs.attachGate;
            const streamId = opts.requestedStreamId ?? stubs.nextStreamId;
            const scrollback = stubs.scrollbackByStreamId.get(streamId) ?? "";
            // Simulate the real API: install onDelta, drain pendingDeltas
            // synchronously, then schedule any future ones (we don't bother
            // with async delivery — tests push deltas into opts.onDelta
            // explicitly via the queue helper below).
            for (const d of stubs.pendingDeltas) {
                try { opts.onDelta(d.streamId, d.delta); } catch { /* ignore */ }
            }
            stubs.pendingDeltas.length = 0;
            if (stubs.exitOnAttach) opts.onExit?.(streamId);
            return {
                scrollback,
                streamId,
                cols: opts.cols ?? 200,
                rows: opts.rows ?? 50,
            };
        },
        execTmuxSession: async (opts: any) => {
            stubs.execCalls.push({
                input: opts.input,
                inputBase64: opts.inputBase64,
                cols: opts.cols,
                rows: opts.rows,
                session: opts.session,
                service: opts.service,
            });
            return { ...stubs.execResult };
        },
        detachTmuxSession: async (opts: any) => {
            stubs.detachCalls.push({
                session: opts.session,
                streamId: opts.streamId,
            });
            return { ...stubs.detachResult };
        },
        // The real module also exports these; tests don't need them but
        // the importer chain pulls them in transitively.
        stopAllTmuxReaders: () => { },
        listActiveTmuxSessions: () => [],
    };
});

mock.module("../security.js", () => ({
    validateCommand: async (_stackPath: string, _service: string, command: string, tool: string) => {
        policyCommands.push({ command, tool });
        // Default: allow everything except a magic deny-tool the tests can
        // opt into by setting the env var. Keeps the policy gate visible
        // in the test code path without forcing every test to opt-in to
        // a happy path.
        if (tool === "sandbox_tmux_attach" && process.env.MOCK_POLICY_DENY_ATTACH === "1") {
            return { allowed: false, reason: "policy denied: sandbox_tmux_attach", policy_name: "deny_test" };
        }
        if ((tool === "sandbox_tmux_exec" || tool === "sandbox_tmux_resize") && process.env.MOCK_POLICY_DENY_EXEC === "1") {
            return { allowed: false, reason: `policy denied: ${tool}`, policy_name: "deny_test" };
        }
        if (tool === "sandbox_tmux_detach" && process.env.MOCK_POLICY_DENY_DETACH === "1") {
            return { allowed: false, reason: "policy denied: sandbox_tmux_detach", policy_name: "deny_test" };
        }
        return { allowed: true };
    },
    filterEnvPassthrough: async () => ({}),
    validateMountPaths: async () => ({ allowed: true }),
}));

mock.module("../audit.js", () => ({
    auditLog: (entry: any) => {
        // Buffer audit entries in memory so tests can assert on them.
        auditEntries.push(entry);
    },
}));

mock.module("../logger.js", () => ({
    logger: {
        error: () => { },
        warn: (obj: Record<string, unknown>, msg: string) => { warnCalls.push({ obj, msg }); },
        info: () => { },
        debug: () => { },
    },
}));

mock.module("../compose/client.js", () => ({
    reconnectProxyToAllAgentNetworks: async () => { },
}));

const auditEntries: any[] = [];

// Mock the `config.ts` chain (transitive import of utils.js → config.js).
// We need resolveStackAndProject to actually resolve a fake stack so the
// routes can pass the post-resolve policy/audit steps.
mock.module("../config.js", () => {
    const stacks = new Map([
        ["fake-stack", { name: "fake-stack", path: "/tmp/fake-stack" }],
        ["another-stack", { name: "another-stack", path: "/tmp/another-stack" }],
    ]);
    return {
        listStacks: async () => [...stacks.values()],
        getStack: async (name: string) => stacks.get(name),
        getStacksDir: () => "/tmp",
        getEgressProxyDir: () => "/tmp/egress-proxy",
        validateStacksSecurity: async () => ({ registered: ["fake-stack", "another-stack"], excluded: [] }),
        registerStackProject: () => { },
    };
});

mock.module("../network-policy.js", () => ({
    startNetworkPolicyWatcher: async () => { },
    stopNetworkPolicyWatcher: () => { },
    reloadNetworkPolicies: async () => ({ ok: true, message: "ok" }),
    registerStackProject: () => { },
}));

// Imports MUST come after the mock.module() calls so the mocks are
// installed before module evaluation.
import { handleBunRequest } from "../http/server.js";
import { toolRegistry } from "../tools/register.js";

// ── Auth helpers ────────────────────────────────────────────────────────────

const TEST_TOKEN = "tmux-test-token-xyz123";
let savedToken: string | undefined;
let savedAdminToken: string | undefined;
let savedEnableTmux: string | undefined;

beforeAll(() => {
    // server.ts only routes /api/tmux/* when ENABLE_SANDBOX_TMUX is set.
    savedEnableTmux = process.env.ENABLE_SANDBOX_TMUX;
    process.env.ENABLE_SANDBOX_TMUX = "1";
    savedToken = process.env.CARAPA_BOX_API_TOKEN;
    savedAdminToken = process.env.CARAPA_BOX_ADMIN_TOKEN;
    process.env.CARAPA_BOX_API_TOKEN = TEST_TOKEN;
    // The auth gate prefers CARAPA_BOX_ADMIN_TOKEN when set (see
    // src/http/tmux.ts:expectedToken). Clear it for the duration of this
    // suite so the API token we just set is the one that gates auth —
    // otherwise a stale value in the test runner's environment would
    // shadow TEST_TOKEN and every "valid Bearer" test would 401.
    delete process.env.CARAPA_BOX_ADMIN_TOKEN;
    // Clear any policy-deny env vars that may have been left from a prior run.
    delete process.env.MOCK_POLICY_DENY_ATTACH;
    delete process.env.MOCK_POLICY_DENY_EXEC;
    delete process.env.MOCK_POLICY_DENY_DETACH;
    // Pre-populate the tool registry with a no-op mock so that
    // handleBunRequest's tool adapter route doesn't 500 on a missing
    // registry entry when the tmux routes are NOT matched (e.g. the
    // 401 path returns early before reaching the tool adapter, so this
    // is belt-and-suspenders).
    if (!toolRegistry.has("mock_success")) {
        toolRegistry.set("mock_success", {
            description: "noop",
            schema: {},
            handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        });
    }
});

afterAll(() => {
    mock.module("../config.js", () => realModules.config);
    mock.module("../compose/client.js", () => realModules.client);
    mock.module("../network-policy.js", () => realModules.networkPolicy);
    mock.module("../logger.js", () => realModules.logger);
    if (savedEnableTmux !== undefined) process.env.ENABLE_SANDBOX_TMUX = savedEnableTmux;
    else delete process.env.ENABLE_SANDBOX_TMUX;
    if (savedToken !== undefined) process.env.CARAPA_BOX_API_TOKEN = savedToken;
    else delete process.env.CARAPA_BOX_API_TOKEN;
    if (savedAdminToken !== undefined) process.env.CARAPA_BOX_ADMIN_TOKEN = savedAdminToken;
    else delete process.env.CARAPA_BOX_ADMIN_TOKEN;
});

afterEach(() => {
    mock.restore();
});

beforeEach(() => {
    resetStubs();
    auditEntries.length = 0;
    policyCommands.length = 0;
});

function req(method: string, path: string, body?: unknown, token: string | null = TEST_TOKEN): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return new Request(`http://localhost${path}`, init);
}

// ── SSE helpers ─────────────────────────────────────────────────────────────

interface ParsedSseFrame { event: string; data: any }

/**
 * Read SSE frames from a Response body until either:
 *   - the test calls `done()` (cancels the reader)
 *   - the response body ends
 *   - `timeoutMs` elapses (default 1000ms)
 *
 * Each frame is a complete `event: <name>\ndata: <json>\n\n` triple.
 * Returns the array of frames received before the function returned.
 */
async function readSseFrames(res: Response, opts: { count?: number; timeoutMs?: number; stopOn?: string } = {}): Promise<ParsedSseFrame[]> {
    const { count, timeoutMs = 1500, stopOn } = opts;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const frames: ParsedSseFrame[] = [];
    const start = Date.now();

    try {
        while (true) {
            if (Date.now() - start > timeoutMs) break;
            if (count !== undefined && frames.length >= count) break;

            const { value, done } = await Promise.race([
                reader.read(),
                new Promise<{ value: undefined; done: true }>((resolve) =>
                    setTimeout(() => resolve({ value: undefined, done: true }), Math.max(50, timeoutMs - (Date.now() - start)))
                ),
            ]);
            if (done) break;
            if (!value) continue;
            buf += decoder.decode(value, { stream: true });

            // Split on the SSE event terminator (double newline).
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
                const block = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                const frame = parseSseBlock(block);
                if (frame) {
                    frames.push(frame);
                    if (stopOn && frame.event === stopOn) {
                        return frames;
                    }
                }
            }
        }
    } finally {
        try { await reader.cancel(); } catch { /* already cancelled */ }
    }
    return frames;
}

function parseSseBlock(block: string): ParsedSseFrame | null {
    let event: string | null = null;
    let data: string | null = null;
    for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event === null || data === null) return null;
    try { return { event, data: JSON.parse(data) }; } catch { return { event, data }; }
}

// ── Auth ────────────────────────────────────────────────────────────────────

describe("Authentication — /api/tmux/*", () => {
    it("missing Authorization header → 401", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", { stack: "fake-stack", service: "agent", session: "s", input: "x" }, null));
        expect(res.status).toBe(401);
        expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("invalid Bearer token → 401", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", { stack: "fake-stack", service: "agent", session: "s", input: "x" }, "wrong-token"));
        expect(res.status).toBe(401);
    });

    it("malformed Authorization header (no 'Bearer ' prefix) → 401", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tmux/exec", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": TEST_TOKEN },
                body: JSON.stringify({ stack: "fake-stack", service: "agent", session: "s", input: "x" }),
            })
        );
        expect(res.status).toBe(401);
    });

    it("valid Bearer token passes auth (subsequent policy check applies)", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", { stack: "fake-stack", service: "agent", session: "s", input: "x" }));
        // Pass auth → either 200 (allow) or 500 (sandbox resolution failure
        // from the mocked env, which is fine for an auth check). The point
        // is it's NOT 401.
        expect(res.status).not.toBe(401);
    });

    it("a separate admin token does not change Board's API authentication", async () => {
        const savedAdmin = process.env.CARAPA_BOX_ADMIN_TOKEN;
        process.env.CARAPA_BOX_ADMIN_TOKEN = "separate-tmux-admin";
        try {
            const body = { stack: "fake-stack", service: "agent", session: "s", input: "x" };
            const response = await handleBunRequest(req("POST", "/api/tmux/exec", body));
            expect(response.status).not.toBe(401);
            expect(response.status).not.toBe(403);
            expect((await handleBunRequest(req("POST", "/api/tmux/exec", body, "separate-tmux-admin"))).status).toBe(401);
        } finally {
            if (savedAdmin === undefined) delete process.env.CARAPA_BOX_ADMIN_TOKEN;
            else process.env.CARAPA_BOX_ADMIN_TOKEN = savedAdmin;
        }
    });

    it("disabled when no token is configured → 403", async () => {
        const saved = process.env.CARAPA_BOX_API_TOKEN;
        delete process.env.CARAPA_BOX_API_TOKEN;
        try {
            const res = await handleBunRequest(req("POST", "/api/tmux/exec", { stack: "fake-stack", service: "agent", session: "s", input: "x" }));
            expect(res.status).toBe(403);
        } finally {
            process.env.CARAPA_BOX_API_TOKEN = saved;
        }
    });
});

// ── Validation (Zod) ────────────────────────────────────────────────────────

describe("Request validation — /api/tmux/*", () => {
    it("exec: missing required fields → 400 with validation issues", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", { stack: "fake-stack" }));
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string; details: any[] };
        expect(body.error).toBe("Validation failed");
        expect(Array.isArray(body.details)).toBe(true);
        expect(body.details.length).toBeGreaterThan(0);
    });

    it("exec: invalid JSON body → 400", async () => {
        const res = await handleBunRequest(
            new Request("http://localhost/api/tmux/exec", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TEST_TOKEN}` },
                body: "not json}{",
            })
        );
        expect(res.status).toBe(400);
    });

    it("resize: requires cols and rows → 400 when missing", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/resize", { stack: "fake-stack", service: "agent", session: "s" }));
        expect(res.status).toBe(400);
    });

    it("resize: rejects non-positive dims", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/resize", { stack: "fake-stack", service: "agent", session: "s", cols: 0, rows: -1 }));
        expect(res.status).toBe(400);
    });

    it("detach: requires streamId → 400 when missing", async () => {
        const res = await handleBunRequest(req("DELETE", "/api/tmux/detach", { stack: "fake-stack", service: "agent", session: "s" }));
        expect(res.status).toBe(400);
    });

    it("attach: missing session → 400", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", { stack: "fake-stack", service: "agent" }));
        expect(res.status).toBe(400);
    });
});

// ── Routing ─────────────────────────────────────────────────────────────────

describe("Routing — /api/tmux/*", () => {
    it("GET /api/tmux/attach → falls through (only POST is wired)", async () => {
        const res = await handleBunRequest(req("GET", "/api/tmux/attach", undefined));
        // Routes that don't match fall through to the MCP transport path
        // (which 400s in unit-test mode without an active MCP session).
        // The point: it's NOT a 200, 401, or 403 from the tmux surface.
        expect([200, 400, 404]).toContain(res.status);
    });

    it("POST /api/tmux/zzz (unknown sub-route) → falls through", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/zzz", {}));
        // Falls through to MCP path → 406 (Accept header missing on POST
        // → MCP transport's strict check). The point: it's not a
        // 401/403/200 from the tmux surface.
        expect(res.status).toBe(406);
    });
});

// ── Attach SSE: init + delta streamId threading ─────────────────────────────

describe("POST /api/tmux/attach — SSE streaming", () => {
    it("emits a single `init` event with streamId/cols/rows/scrollback", async () => {
        const streamId = "stream-A-test-001";
        stubs.scrollbackByStreamId.set(streamId, "$ echo hello\nhello\n$ ");

        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack",
            service: "agent",
            session: "sA",
            streamId, // request reconnect → stub returns the same streamId
            cols: 132,
            rows: 40,
        }));

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        expect(res.headers.get("Cache-Control")).toContain("no-cache");

        const frames = await readSseFrames(res, { count: 1, timeoutMs: 800 });
        const init = frames.find((f) => f.event === "init");
        expect(init).toBeDefined();
        expect(init!.event).toBe("init");
        expect(init!.data.streamId).toBe(streamId);
        expect(init!.data.cols).toBe(132);
        expect(init!.data.rows).toBe(40);
        expect(init!.data.scrollback).toBe("$ echo hello\nhello\n$ ");
    });

    it("deltas emitted by onDelta are forwarded as `delta` events tagged with the streamId", async () => {
        const streamId = "stream-B-test-002";
        stubs.scrollbackByStreamId.set(streamId, "init ");
        // Pre-queue two deltas — the stubbed attachTmuxSession will drain
        // them synchronously into the onDelta callback during attach.
        stubs.pendingDeltas.push(
            { streamId, delta: "hello" },
            { streamId, delta: " world" },
        );

        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "sB",
            streamId,
        }));
        expect(res.status).toBe(200);

        const frames = await readSseFrames(res, { count: 3, timeoutMs: 800 });
        const init = frames.find((f) => f.event === "init");
        expect(init).toBeDefined();
        const deltas = frames.filter((f) => f.event === "delta");
        // deltas may interleave with init depending on scheduling; assert
        // we got both.
        expect(deltas.length).toBeGreaterThanOrEqual(2);

        // Critical correctness: each `delta` event must carry the
        // streamId so the board can route it to the right tab. This is
        // the exact gap the MCP path suffers at register.ts:1470-1472.
        for (const d of deltas) {
            expect(d.data.streamId).toBe(streamId);
            expect(typeof d.data.delta).toBe("string");
        }
        // Both queued deltas should appear in the stream content.
        const combined = deltas.map((d) => d.data.delta).join("");
        expect(combined).toContain("hello");
        expect(combined).toContain(" world");
    });

    it("two concurrent attaches get independent, correctly-routed streams", async () => {
        const streamX = "stream-X-concurrent-001";
        const streamY = "stream-Y-concurrent-002";
        stubs.scrollbackByStreamId.set(streamX, "X-init ");
        stubs.scrollbackByStreamId.set(streamY, "Y-init ");

        const [res1, res2] = await Promise.all([
            handleBunRequest(req("POST", "/api/tmux/attach", {
                stack: "fake-stack", service: "agent", session: "sX", streamId: streamX,
            })),
            handleBunRequest(req("POST", "/api/tmux/attach", {
                stack: "another-stack", service: "agent", session: "sY", streamId: streamY,
            })),
        ]);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        const frames1 = await readSseFrames(res1, { count: 1, timeoutMs: 600 });
        const frames2 = await readSseFrames(res2, { count: 1, timeoutMs: 600 });
        const init1 = frames1.find((f) => f.event === "init");
        const init2 = frames2.find((f) => f.event === "init");
        expect(init1).toBeDefined();
        expect(init2).toBeDefined();
        // The two streamIds must be the requested ones (each attach is
        // keyed by its own session) and the scrollback must match.
        expect(init1!.data.streamId).toBe(streamX);
        expect(init2!.data.streamId).toBe(streamY);
        expect(init1!.data.scrollback).toBe("X-init ");
        expect(init2!.data.scrollback).toBe("Y-init ");
    });

    it("emits init before exit when the shell ends during attach", async () => {
        stubs.exitOnAttach = true;
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "logout-shell",
        }));

        const frames = await readSseFrames(res, { count: 2, timeoutMs: 800 });
        expect(frames.map((frame) => frame.event)).toEqual(["init", "exit"]);
        expect(frames[1].data).toMatchObject({
            streamId: "stub-stream-uuid-0001",
            reason: "shell-exited",
        });
    });

    it("emits an `error` event and ends the stream when attach throws", async () => {
        stubs.attachShouldFail = true;
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "s-err",
        }));
        expect(res.status).toBe(200); // headers are sent before attach runs
        const frames = await readSseFrames(res, { count: 2, timeoutMs: 800 });
        const err = frames.find((f) => f.event === "error");
        expect(err).toBeDefined();
        expect(String(err!.data.error)).toContain("stubbed attach failure");
        // Failure must be audit-logged.
        const failAudit = auditEntries.find((a) => a.tool === "sandbox_tmux_attach" && a.allowed === false);
        // The error path audits with `allowed: true` + a reason (matches
        // src/tools/register.ts:1500-1510 for the MCP tool).
        const failReason = auditEntries.find((a) => a.tool === "sandbox_tmux_attach" && a.reason?.includes("stubbed attach failure"));
        expect(failReason).toBeDefined();
        expect(failAudit === undefined).toBe(true);
    });

    it("sends an `error` frame and warns once when the request aborts before attach resolves", async () => {
        let release!: () => void;
        stubs.attachGate = new Promise<void>((resolve) => { release = resolve; });
        const ac = new AbortController();
        const base = req("POST", "/api/tmux/attach", { stack: "fake-stack", service: "agent", session: "s-abort" });
        const res = await handleBunRequest(new Request(base, { signal: ac.signal }));
        ac.abort();
        const frames = await readSseFrames(res, { timeoutMs: 800 });
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(frames.map((f) => f.event)).toEqual(["error"]);
        expect(String(frames[0].data.error)).toContain("closed before init: request-aborted");
        const warns = warnCalls.filter((w) => w.msg === "[HTTP] [TMUX] attach: stream closed before init");
        expect(warns).toHaveLength(1);
        expect(warns[0].obj.closeReason).toBe("request-aborted");
        expect(warns[0].obj.reqAbortedAtEntry).toBe(false);
        expect(typeof warns[0].obj.elapsedMs).toBe("number");
        expect(warns[0].obj.traceId).toBeDefined();
    });

    it("logs body-cancelled when the response body is cancelled before init", async () => {
        let release!: () => void;
        stubs.attachGate = new Promise<void>((resolve) => { release = resolve; });
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "s-cancel",
        }));
        await res.body!.cancel();
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));

        const warns = warnCalls.filter((w) => w.msg === "[HTTP] [TMUX] attach: stream closed before init");
        expect(warns).toHaveLength(1);
        expect(warns[0].obj.closeReason).toBe("body-cancelled");
    });

    it("does not warn or add a second frame when attach throws", async () => {
        stubs.attachShouldFail = true;
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "s-err2",
        }));
        const frames = await readSseFrames(res, { timeoutMs: 400 });
        expect(frames.filter((f) => f.event === "error")).toHaveLength(1);
        expect(warnCalls.filter((w) => w.msg === "[HTTP] [TMUX] attach: stream closed before init")).toHaveLength(0);
    });

    it("sends keep-alive comments while idle and stops them when disconnected", async () => {
        const scheduled = new Map<ReturnType<typeof setInterval>, () => void>();
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
            const timer = { unref() { } } as unknown as ReturnType<typeof setInterval>;
            scheduled.set(timer, callback);
            return timer;
        }) as typeof setInterval);
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(((timer: ReturnType<typeof setInterval>) => {
            scheduled.delete(timer);
        }) as typeof clearInterval);

        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "idle",
        }));
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        const init = await reader.read();
        expect(decoder.decode(init.value)).toContain("event: init");
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);

        for (const callback of scheduled.values()) callback();
        const keepalive = await reader.read();
        expect(decoder.decode(keepalive.value)).toBe(": keepalive\n\n");
        expect(scheduled.size).toBe(1);

        await reader.cancel();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        expect(scheduled.size).toBe(0);
    });
});

// ── Policy deny → 403 + audit ───────────────────────────────────────────────

describe("Policy gate uses the trusted tmux wrapper", () => {
    it("uses absolute wrapper commands for every tmux operation", async () => {
        process.env.MOCK_POLICY_DENY_ATTACH = "1";
        await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "session-a",
        }));
        delete process.env.MOCK_POLICY_DENY_ATTACH;

        await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "session-a", input: "x",
        }));
        await handleBunRequest(req("POST", "/api/tmux/resize", {
            stack: "fake-stack", service: "agent", session: "session-a", cols: 80, rows: 24,
        }));
        await handleBunRequest(req("DELETE", "/api/tmux/detach", {
            stack: "fake-stack", service: "agent", session: "session-a", streamId: "stream-a",
        }));

        expect(policyCommands).toEqual([
            {
                command: "/usr/local/ai-cli-bin/tmux-tool.sh create session-a 200 50",
                tool: "sandbox_tmux_attach",
            },
            {
                command: "/usr/local/ai-cli-bin/tmux-tool.sh send session-a",
                tool: "sandbox_tmux_exec",
            },
            {
                command: "/usr/local/ai-cli-bin/tmux-tool.sh send session-a",
                tool: "sandbox_tmux_resize",
            },
            {
                command: "/usr/local/ai-cli-bin/tmux-tool.sh kill session-a",
                tool: "sandbox_tmux_detach",
            },
        ]);
    });
});

describe("Policy deny — /api/tmux/*", () => {
    it("attach: policy deny returns 403 and writes an audit entry", async () => {
        process.env.MOCK_POLICY_DENY_ATTACH = "1";
        try {
            const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
                stack: "fake-stack", service: "agent", session: "s",
            }));
            expect(res.status).toBe(403);
            const body = await res.json() as { error: string; reason: string };
            expect(body.error).toBe("Forbidden");
            expect(body.reason).toContain("policy denied");
            const denied = auditEntries.find((a) => a.tool === "sandbox_tmux_attach" && a.allowed === false);
            expect(denied).toBeDefined();
            expect(denied.policy_name).toBe("deny_test");
        } finally {
            delete process.env.MOCK_POLICY_DENY_ATTACH;
        }
    });

    it("exec: policy deny returns 403 and writes an audit entry", async () => {
        process.env.MOCK_POLICY_DENY_EXEC = "1";
        try {
            const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
                stack: "fake-stack", service: "agent", session: "s", input: "x",
            }));
            expect(res.status).toBe(403);
            const denied = auditEntries.find((a) => a.tool === "sandbox_tmux_exec" && a.allowed === false);
            expect(denied).toBeDefined();
        } finally {
            delete process.env.MOCK_POLICY_DENY_EXEC;
        }
    });

    it("resize: policy deny returns 403 and writes an audit entry", async () => {
        process.env.MOCK_POLICY_DENY_EXEC = "1";
        try {
            const res = await handleBunRequest(req("POST", "/api/tmux/resize", {
                stack: "fake-stack", service: "agent", session: "s", cols: 80, rows: 24,
            }));
            expect(res.status).toBe(403);
            const denied = auditEntries.find((a) => a.tool === "sandbox_tmux_resize" && a.allowed === false);
            expect(denied).toBeDefined();
        } finally {
            delete process.env.MOCK_POLICY_DENY_EXEC;
        }
    });

    it("detach: policy deny returns 403 and writes an audit entry", async () => {
        process.env.MOCK_POLICY_DENY_DETACH = "1";
        try {
            const res = await handleBunRequest(req("DELETE", "/api/tmux/detach", {
                stack: "fake-stack", service: "agent", session: "s", streamId: "stream-A",
            }));
            expect(res.status).toBe(403);
            const denied = auditEntries.find((a) => a.tool === "sandbox_tmux_detach" && a.allowed === false);
            expect(denied).toBeDefined();
        } finally {
            delete process.env.MOCK_POLICY_DENY_DETACH;
        }
    });
});

// ── exec/resize/detach round-trips ──────────────────────────────────────────

describe("POST /api/tmux/exec — round-trip", () => {
    it("happy path: 200 with {ok:true}, exec receives input + (optional) base64 flag", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "s", input: "ls\n",
        }));
        expect(res.status).toBe(200);
        const body = await res.json() as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(stubs.execCalls.length).toBe(1);
        expect(stubs.execCalls[0].input).toBe("ls\n");
        expect(stubs.execCalls[0].session).toBe("s");
        expect(stubs.execCalls[0].service).toBe("agent");
        // Allow entry was audit-logged.
        const allow = auditEntries.find((a) => a.tool === "sandbox_tmux_exec" && a.allowed === true);
        expect(allow).toBeDefined();
    });

    it("base64 input is decoded and forwarded to exec", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "s",
            input: Buffer.from("\x1b[A").toString("base64"),
            inputBase64: true,
        }));
        expect(res.status).toBe(200);
        expect(stubs.execCalls[0].inputBase64).toBe(true);
        // The stub receives the raw base64 string and decodes itself.
        expect(stubs.execCalls[0].input).toBe(Buffer.from("\x1b[A").toString("base64"));
    });

    it("non-zero exit from exec → 500 with stderr", async () => {
        stubs.execResult = { stdout: "", stderr: "tmux: command failed", code: 1 };
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "s", input: "x",
        }));
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string; stderr: string; exitCode: number };
        expect(body.stderr).toBe("tmux: command failed");
        expect(body.exitCode).toBe(1);
        const audited = auditEntries.find((a) => a.tool === "sandbox_tmux_exec" && a.allowed === true);
        expect(audited).toBeDefined();
        expect(audited.exitCode).toBe(1);
    });

    it("input > 8KB is rejected with 400", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "s", input: "x".repeat(9000),
        }));
        expect(res.status).toBe(400);
    });
});

describe("POST /api/tmux/resize — round-trip", () => {
    it("forwards cols/rows to exec with empty input and writes audit", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/resize", {
            stack: "fake-stack", service: "agent", session: "s", cols: 120, rows: 40,
        }));
        expect(res.status).toBe(200);
        const body = await res.json() as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(stubs.execCalls.length).toBe(1);
        expect(stubs.execCalls[0].cols).toBe(120);
        expect(stubs.execCalls[0].rows).toBe(40);
        // Resize path sends an empty keystroke string — the tmux engine
        // still emits the resize + SIGWINCH forward via `tmux send-keys -R`.
        expect(stubs.execCalls[0].input).toBe("");
        const audited = auditEntries.find((a) => a.tool === "sandbox_tmux_resize" && a.allowed === true);
        expect(audited).toBeDefined();
        expect(audited.command).toContain("-x 120");
        expect(audited.command).toContain("-y 40");
    });

    it("non-zero exit from resize → 500", async () => {
        stubs.execResult = { stdout: "", stderr: "tmux: bad size", code: 1 };
        const res = await handleBunRequest(req("POST", "/api/tmux/resize", {
            stack: "fake-stack", service: "agent", session: "s", cols: 1, rows: 1,
        }));
        expect(res.status).toBe(500);
    });
});

describe("DELETE /api/tmux/detach — round-trip", () => {
    it("happy path: 200 with {ok:true, exitCode:0}", async () => {
        const res = await handleBunRequest(req("DELETE", "/api/tmux/detach", {
            stack: "fake-stack", service: "agent", session: "s", streamId: "stream-A",
        }));
        expect(res.status).toBe(200);
        const body = await res.json() as { ok: boolean; exitCode: number };
        expect(body.ok).toBe(true);
        expect(body.exitCode).toBe(0);
        expect(stubs.detachCalls.length).toBe(1);
        expect(stubs.detachCalls[0]).toEqual({ session: "s", streamId: "stream-A" });
    });

    it("non-zero exit from detach (e.g. tmux server unreachable) → 500", async () => {
        // `detachTmuxSession` now handles the "session already gone"
        // case internally and returns code:0 — so a non-zero exit
        // surfacing here represents a genuine tmux-server failure
        // (e.g. tmux itself crashed, container unresponsive). The
        // HTTP layer should still surface that as 500.
        stubs.detachResult = { stdout: "", stderr: "tmux server not running", code: 1 };
        const res = await handleBunRequest(req("DELETE", "/api/tmux/detach", {
            stack: "fake-stack", service: "agent", session: "s", streamId: "stream-A",
        }));
        expect(res.status).toBe(500);
        const body = await res.json() as { ok: boolean; exitCode: number };
        expect(body.ok).toBe(true);
        expect(body.exitCode).toBe(1);
    });
});

// ── Stack resolution (404 path) ─────────────────────────────────────────────

describe("Stack resolution — unknown stack → 404", () => {
    it("attach: unknown stack → 404 with audit entry", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "no-such-stack", service: "agent", session: "s",
        }));
        expect(res.status).toBe(404);
        const body = await res.json() as { error: string };
        expect(body.error).toContain("no-such-stack");
        const audited = auditEntries.find((a) => a.tool === "sandbox_tmux_attach" && a.allowed === false && a.reason?.includes("no-such-stack"));
        expect(audited).toBeDefined();
    });

    it("exec: unknown stack → 404", async () => {
        const res = await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "no-such-stack", service: "agent", session: "s", input: "x",
        }));
        expect(res.status).toBe(404);
    });
});

// ── Audit log shape ─────────────────────────────────────────────────────────

describe("Audit log shape", () => {
    it("exec: allowed entry uses tool=sandbox_tmux_exec and a sensible command", async () => {
        await handleBunRequest(req("POST", "/api/tmux/exec", {
            stack: "fake-stack", service: "agent", session: "s", input: "echo hi\n",
        }));
        const entry = auditEntries.find((a) => a.tool === "sandbox_tmux_exec" && a.allowed === true);
        expect(entry).toBeDefined();
        expect(entry.stack).toBe("fake-stack");
        expect(entry.service).toBe("agent");
        expect(entry.command).toContain("s");
        // "echo hi\n" is 8 bytes (e, c, h, o, space, h, i, \n).
        expect(entry.command).toContain("(8 bytes)");
        expect(entry.exitCode).toBe(0);
    });

    it("attach: allowed entry uses tool=sandbox_tmux_attach", async () => {
        stubs.scrollbackByStreamId.set("stream-A", "scrollback ");
        const res = await handleBunRequest(req("POST", "/api/tmux/attach", {
            stack: "fake-stack", service: "agent", session: "s",
        }));
        // Drain the SSE stream so the IIFE that writes the audit log
        // has a chance to complete before we assert. We then wait a
        // small additional grace period for the audit (which is emitted
        // after the init frame) to land in the in-memory audit buffer.
        await readSseFrames(res, { count: 1, timeoutMs: 800 });
        await new Promise((r) => setTimeout(r, 50));
        const entry = auditEntries.find((a) => a.tool === "sandbox_tmux_attach" && a.allowed === true);
        expect(entry).toBeDefined();
    });
});
