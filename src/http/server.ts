import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod";
import path from "node:path";
import fs from "node:fs";
import { bearerToken, safeTokenCompare } from "./auth.js";
import { foreignBrowserRequestReason, isLoopbackOrigin } from "./origin-guard.js";

import { handleAdminApi } from "./admin.js";
import { handleAttach, handleExec, handleResize, handleDetach } from "./tmux.js";
import { jsonCors } from "./tmux-wire.js";
import { toolRegistry, registerTools } from "../tools/register.js";
import { reconnectProxyToAllAgentNetworks } from "../compose/client.js";
import { scheduleNetworkPolicyReload } from "../network-policy.js";
import { resumeProjectStartup } from "../compose/project-startup.js";
import { handleBrowserRequest } from './browser.js';
import { logger } from "../logger.js";
import { readBuildInfo, type BuildInfo } from "./build-info.js";

// One McpServer + transport per session, keyed by mcp-session-id.
const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const activeSessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; lastActive: number }>();

// Read once at process start.
const buildInfo = readBuildInfo(process.env.CARAPA_BOX_APP_ROOT || undefined);

function healthPayload(): BuildInfo & { status: string; name: string; active_sessions: number; memory: NodeJS.MemoryUsage; uptime: number } {
    return {
        status: "ok",
        name: "carapa-box",
        active_sessions: activeSessions.size,
        memory: process.memoryUsage(),
        uptime: Math.floor(process.uptime()),
        ...buildInfo,
    };
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".xml": "application/xml",
};

const TOOL_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function forbiddenBrowserResponse(reason: string, pathname: string): Response {
    logger.warn(`[HTTP] Rejected browser request to ${pathname} (${reason})`);
    return new Response(JSON.stringify({ error: `Forbidden: ${reason}` }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
    });
}

/** Close a single session: disconnect McpServer, clear SDK internal maps, close transport, remove from Map. */
async function closeSession(id: string): Promise<void> {
    const entry = activeSessions.get(id);
    if (!entry) return;

    try {
        // Clear _requestToStreamMapping workaround — the SDK's close() doesn't clear this map.
        // Access it via (any) since it's a private field.
        const transport = entry.transport as any;
        if (transport._requestToStreamMapping) {
            transport._requestToStreamMapping.clear();
        }

        await entry.server.close();
        await entry.transport.close();
    } catch (err) {
        logger.error({ err, sessionId: id }, "[HTTP] Error closing session");
    }

    activeSessions.delete(id);
    logger.info(`[HTTP] Session closed: ${id} (active: ${activeSessions.size})`);
}

/** Evict sessions older than SESSION_TTL_MS or when over MAX_SESSIONS. */
let isPruning = false;
async function pruneStaleSessions(): Promise<void> {
    if (isPruning) return;
    isPruning = true;
    try {
        const now = Date.now();

        // Pass 1: remove sessions that exceeded TTL
        for (const [id, entry] of activeSessions) {
            if (now - entry.lastActive > SESSION_TTL_MS) {
                await closeSession(id);
            }
        }

        // Pass 2: if still over limit, evict oldest until under MAX_SESSIONS
        if (activeSessions.size > MAX_SESSIONS) {
            const sorted = [...activeSessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
            const excess = activeSessions.size - MAX_SESSIONS;
            for (let i = 0; i < excess; i++) {
                await closeSession(sorted[i][0]);
                logger.info(`[HTTP] Evicted excess session: ${sorted[i][0]}`);
            }
        }
    } finally {
        isPruning = false;
    }
}

/** True if the POST body is a JSON-RPC `initialize` request (single or batch). Does not consume `req`. */
async function isInitializeRequest(req: Request): Promise<boolean> {
    try {
        const body = await req.clone().json();
        const msgs = Array.isArray(body) ? body : [body];
        return msgs.some((m) => m && typeof m === "object" && m.method === "initialize");
    } catch {
        return false;
    }
}

export async function createSession(): Promise<{ transport: WebStandardStreamableHTTPServerTransport; server: McpServer }> {
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessionclosed: (sessionId) => {
            closeSession(sessionId);
        },
    });
    const server = new McpServer({
        name: "carapa-box",
        version: "0.1.0",
        description: "CarapaBox - Manages isolated Docker-based coding environments.",
    }, { capabilities: { logging: {} } });
    // Pass updateRegistry=false: registry entries must stay bound to _registryServer
    // (no transport) so REST-invoked handlers never sendLoggingMessage to this client.
    registerTools(server, false);
    await server.connect(transport);
    return { transport, server };
}

// Bun server reference — set in main(), used to disable per-request idle timeout for SSE streams
export let _bunServer: { timeout(req: Request, seconds: number): void; stop(closeActiveConnections?: boolean): void } | null = null;
let memoryStatsInterval: ReturnType<typeof setInterval> | null = null;

export function setBunServer(server: typeof _bunServer): void {
    if (memoryStatsInterval) {
        clearInterval(memoryStatsInterval);
        memoryStatsInterval = null;
    }
    _bunServer = server;

    // Start periodic memory logger when server starts
    if (!server) return;

    memoryStatsInterval = setInterval(async () => {
            const mem = process.memoryUsage();
            let containerMem = "N/A";

            try {
                // Read the actual cgroup memory (what docker stats shows)
                const raw = await Bun.file("/sys/fs/cgroup/memory.current").text();
                containerMem = Math.round(parseInt(raw.trim()) / 1024 / 1024) + "MB";
            } catch {
                try {
                    // Fallback for cgroup v1
                    const raw = await Bun.file("/sys/fs/cgroup/memory/memory.usage_in_bytes").text();
                    containerMem = Math.round(parseInt(raw.trim()) / 1024 / 1024) + "MB";
                } catch { /* ignore if not on linux */ }
            }

            let pids = 0;
            let zombies = 0;
            try {
                // Count processes and check for zombies
                const procDir = fs.readdirSync("/proc");
                for (const f of procDir) {
                    if (/^\d+$/.test(f)) {
                        pids++;
                        try {
                            const stat = fs.readFileSync(`/proc/${f}/status`, "utf8");
                            if (stat.includes("State:\tZ (zombie)")) zombies++;
                        } catch { /* process exited while reading */ }
                    }
                }
            } catch { /* ignore */ }

            logger.info({
                container: containerMem,
                rss: Math.round(mem.rss / 1024 / 1024) + "MB",
                heap: Math.round(mem.heapUsed / 1024 / 1024) + "MB",
                pids,
                zombies,
                activeSessions: activeSessions.size
            }, "[MEMORY-STATS]");
    }, 60_000); // Every 60 seconds

    memoryStatsInterval.unref();
}

export async function handleBunRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;

    // 1. Health/Status check (bypass MCP and auth)
    if (url.pathname === "/health" || url.pathname === "/status") {
        return jsonCors(healthPayload());
    }

    // 1.1 Serve Generic Static Files & Admin Dashboard
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return Response.redirect(url.origin + "/admin/index.html", 301);
    }

    // Try serving from public/ folder (Admin Dashboard, icons, etc.)
    const publicDir = path.join(process.cwd(), "public");
    let targetPath = url.pathname === "/" ? "" : url.pathname;

    // Safety check: ensure we don't escape public/ directory
    const filePath = path.join(publicDir, targetPath);
    if (filePath.startsWith(publicDir)) {
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile()) {
                const fileBuffer = await fs.promises.readFile(filePath);
                // Serve with appropriate content-type based on extension
                const ext = path.extname(filePath).toLowerCase();
                return new Response(fileBuffer, {
                    headers: {
                        "Content-Type": STATIC_CONTENT_TYPES[ext] || "application/octet-stream",
                        "Access-Control-Allow-Origin": "*",
                    },
                });
            }
        } catch {
            // File doesn't exist — fall through to other routes
        }
    }

    // 2. CORS Preflight (bypass auth). Only loopback or absent origins get ACAO *;
    // a foreign page must not be told it may call the controller.
    if (method === "OPTIONS") {
        const origin = req.headers.get("origin");
        if (origin !== null && !isLoopbackOrigin(origin)) {
            return forbiddenBrowserResponse("non-loopback Origin", url.pathname);
        }
        const requestedHeaders = req.headers.get("Access-Control-Request-Headers") || req.headers.get("Access-Control-Allow-Headers");
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": requestedHeaders || "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    // 3. Authentication & API Routing
    const adminToken = process.env.CARAPA_BOX_ADMIN_TOKEN;
    const sandboxToken = process.env.CARAPA_BOX_API_TOKEN;

    // Board and the relay keep their API credential for these service operations.
    // Match documented methods and paths explicitly so future admin endpoints do
    // not inherit API access merely by sharing a prefix.
    const boardServiceRequest =
        (/^\/api\/admin\/relay-token\/[^/]+$/.test(url.pathname) &&
            ["GET", "POST", "PUT", "DELETE"].includes(method)) ||
        (/^\/api\/admin\/relay-identity\/[^/]+$/.test(url.pathname) && method === "GET") ||
        (url.pathname === "/api/admin/provider-accounts" && method === "GET") ||
        (url.pathname === "/api/admin/provider-accounts/usage" && method === "GET") ||
        (url.pathname === "/api/admin/provider-accounts/models" && method === "GET") ||
        (url.pathname === "/api/admin/provider-accounts/order" && method === "POST") ||
        (url.pathname === "/api/admin/provider-accounts/login" && method === "POST") ||
        (/^\/api\/admin\/provider-accounts\/login\/[a-f0-9-]{36}\/complete$/.test(url.pathname) && method === "POST") ||
        (/^\/api\/admin\/provider-accounts\/login\/[a-f0-9-]{36}$/.test(url.pathname) && method === "DELETE") ||
        (/^\/api\/admin\/provider-accounts\/[a-f0-9-]{36}$/.test(url.pathname) && ["PATCH", "DELETE"].includes(method)) ||
        (url.pathname === "/api/admin/mcp-connections" && method === "GET") ||
        (url.pathname === "/api/admin/mcp-connections/login" && method === "POST") ||
        (/^\/api\/admin\/mcp-connections\/login\/[a-f0-9-]{36}\/complete$/.test(url.pathname) && method === "POST") ||
        (/^\/api\/admin\/mcp-connections\/login\/[a-f0-9-]{36}$/.test(url.pathname) && method === "DELETE") ||
        (url.pathname === "/api/admin/mcp-connections/revoke" && method === "POST");

    // All other admin access requires a distinct, explicitly configured credential.
    if (url.pathname.startsWith("/api/admin/")) {
        const providedToken = bearerToken(req.headers);
        if (boardServiceRequest && sandboxToken && providedToken && safeTokenCompare(providedToken, sandboxToken)) {
            return await handleAdminApi(req, url);
        }
        if (!adminToken || (sandboxToken && safeTokenCompare(adminToken, sandboxToken))) {
            return new Response(JSON.stringify({ error: "Admin access requires a separate CARAPA_BOX_ADMIN_TOKEN" }), {
                status: 503,
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            });
        }
        if (!providedToken || !safeTokenCompare(providedToken, adminToken)) {
            logger.warn(`[HTTP] [ADMIN] Unauthorized request to ${url.pathname} (token: ${providedToken ? 'invalid' : 'missing'})`);
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
            });
        }
        return await handleAdminApi(req, url);
    }

    // 3.1 No token: any local process is allowed, but not a web page (foreign
    // Origin) or a rebound DNS name (foreign Host).
    if (!sandboxToken) {
        const reason = foreignBrowserRequestReason(req, url);
        if (reason) return forbiddenBrowserResponse(reason, url.pathname);
    }

    // 3.2 Standard MCP Sandbox Authentication
    // Only apply to routes NOT handled above (e.g. MCP protocol routes)
    if (sandboxToken) {
        const providedToken = bearerToken(req.headers);

        if (!providedToken || !safeTokenCompare(providedToken, sandboxToken)) {
            logger.warn(`[HTTP] [SANDBOX] Unauthorized request to ${url.pathname} (token: ${providedToken ? 'invalid' : 'missing'})`);
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "WWW-Authenticate": "Bearer"
                }
            });
        }
    }

    if (url.pathname.startsWith('/api/browser/')) return handleBrowserRequest(req, _bunServer);

    // 3.3 REST + SSE Tmux Adapter — POST /api/tmux/attach, /exec, /resize, DELETE /detach
    //
    // These routes handle Bearer auth internally (see src/http/tmux.ts) and
    // stream pane deltas over an SSE response on attach. They live here
    // (rather than in src/http/admin.ts) because admin.ts is keyed on
    // CARAPA_BOX_ADMIN_TOKEN whereas the tmux surface accepts the API token
    // exclusively — server-to-server board→box traffic uses the API token.
    //
    // Opt-in via ENABLE_SANDBOX_TMUX (there are no tmux MCP tools; this REST
    // surface is the only entry point). Leave UNSET while the tmux reader is
    // being investigated for interactions with running agents.
    if (process.env.ENABLE_SANDBOX_TMUX) {
        if (url.pathname === "/api/tmux/attach" && method === "POST") {
            return await handleAttach(req, _bunServer);
        }
        if (url.pathname === "/api/tmux/exec" && method === "POST") {
            return await handleExec(req);
        }
        if (url.pathname === "/api/tmux/resize" && method === "POST") {
            return await handleResize(req);
        }
        if (url.pathname === "/api/tmux/detach" && method === "DELETE") {
            return await handleDetach(req);
        }
    } else if (url.pathname.startsWith("/api/tmux/")) {
        return jsonCors({ error: "tmux surface disabled (set ENABLE_SANDBOX_TMUX=1 in carapa-box .env to enable)" }, 404);
    }

    // 3.4 REST Tool Adapter — GET /api/tools and POST /api/tools/:name
    if (method === "GET" && url.pathname === "/api/tools") {
        const tools = [...toolRegistry.entries()].map(([name, entry]) => ({
            name,
            description: entry.description,
        }));
        return new Response(JSON.stringify(tools), { headers: TOOL_CORS_HEADERS });
    }

    if (method === "POST" && url.pathname.startsWith("/api/tools/")) {
        const toolName = url.pathname.slice("/api/tools/".length);
        const entry = toolRegistry.get(toolName);
        if (!entry) {
            return new Response(JSON.stringify({ error: "Unknown tool", tool: toolName }), {
                status: 404,
                headers: TOOL_CORS_HEADERS,
            });
        }

        const body = await req.json().catch(() => ({}));
        const parsed = z.object(entry.schema).safeParse(body);
        if (!parsed.success) {
            return new Response(JSON.stringify({ error: "Validation failed", details: parsed.error.issues }), {
                status: 400,
                headers: TOOL_CORS_HEADERS,
            });
        }

        let result;
        try {
            result = await entry.handler(parsed.data);
        } catch (err) {
            logger.error({ tool: toolName, err: String(err) }, "[HTTP] [REST] tool execution failed");
            return new Response(JSON.stringify({ error: String(err), code: "INTERNAL_ERROR" }), {
                status: 500,
                headers: TOOL_CORS_HEADERS,
            });
        }
        const text = result.content?.[0]?.text ?? "";
        const status = result.isError ? 500 : 200;
        const isPoll = toolName === "sandbox_status" || toolName === "sandbox_ps";
        const execContext = toolName === "sandbox_exec"
            ? {
                stack: parsed.data.name,
                service: parsed.data.service,
                instance: parsed.data.instance,
                // Only a short prefix: enough to tell callers apart, not enough to leak arguments.
                cmd: String(parsed.data.command ?? "").slice(0, 10),
            }
            : undefined;
        // Board's IPC replica calls sandbox_ipc_sync per project and root on every
        // boot, reconnect and background tick; one info line each floods the log.
        const isQuiet = isPoll || toolName === "sandbox_ipc_sync";
        logger[isQuiet ? "debug" : "info"](
            { tool: toolName, ...execContext, status, rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB" },
            "[HTTP] [REST] tool completed",
        );

        const response = new Response(JSON.stringify({ result: text, isError: !!result.isError }), {
            status,
            headers: TOOL_CORS_HEADERS,
        });

        return response;
    }

    // 4. Handle MCP Request
    try {
        // Prune stale sessions on every request so sessions that never explicitly
        // close are still cleaned up based on TTL and MAX_SESSIONS bounds.
        pruneStaleSessions();

        const sessionId = url.searchParams.get("sessionId") || req.headers.get("mcp-session-id");

        const sessionEntry = sessionId ? activeSessions.get(sessionId) : undefined;
        let transport = sessionEntry?.transport;
        if (sessionEntry) sessionEntry.lastActive = Date.now();

        let session: { transport: WebStandardStreamableHTTPServerTransport; server: McpServer } | undefined;

        // No live session — only POST initialize may create one
        if (!transport) {
            if (sessionId) {
                // Unknown/expired id: per MCP spec answer 404 unless this is an initialize
                // request, in which case the stale id is ignored and a new session starts.
                const isInit = method === "POST" && (await isInitializeRequest(req));
                if (!isInit) {
                    return new Response(
                        JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
                        { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
                    );
                }
            } else if (method !== "POST") {
                return jsonCors({ error: "Session not found. Send POST initialize first." }, 400);
            }
            session = await createSession();
            transport = session.transport;
        }

        let mcpRequest = req;

        // Disable Bun's per-request idle timeout for SSE GET streams.
        // Bun caps idleTimeout at 255s (~4m15s); the global idleTimeout:0 doesn't
        // truly disable it. server.timeout(req, 0) is the correct per-request override.
        if (method === "GET" && _bunServer) {
            _bunServer.timeout(req, 0);
        }

        // --- COMPATIBILITY HACK (deprioritised — keep until upstream is fixed) ---
        // Claude Code (and NanoClaw, which delegates to it) does not send
        // `Accept: text/event-stream` on MCP Streamable HTTP GET requests, violating
        // the spec.  WebStandardStreamableHTTPServerTransport hard-codes a 406 check
        // with no opt-out (confirmed in @modelcontextprotocol/sdk ≥ 1.26.0).
        //
        // Upstream blockers (check before removing):
        //   • anthropics/claude-code#34498 — missing Accept header in Claude Code
        //   • modelcontextprotocol/typescript-sdk PR#1637 — client-side graceful 406
        //     fallback, still unmerged as of 2026-03-21
        //
        // Remove this block once Claude Code sends the correct header and/or the MCP
        // SDK server transport becomes lenient (e.g. adds an `allowMissingAccept`
        // option).
        // Security workaround for Claude Code Accept header
        if (method === "GET") {
            const accept = req.headers.get("accept") || "";
            if (url.pathname === "/api/mcp" && !accept.includes("text/event-stream")) {
                const newHeaders = new Headers(req.headers);
                newHeaders.set("Accept", "text/event-stream");
                mcpRequest = new Request(req.url, { method: req.method, headers: newHeaders, redirect: req.redirect });
            }
        }

        const reqLogContext = { method, path: url.pathname, sessionId: sessionId || "new" };
        logger.info(reqLogContext, "request received");

        const response = await transport.handleRequest(mcpRequest);

        // Store session after first initialize (session ID now assigned)
        if (session && transport.sessionId) {
            activeSessions.set(transport.sessionId, { transport, server: session.server, lastActive: Date.now() });
            logger.info({ ...reqLogContext, newSessionId: transport.sessionId, activeSessions: activeSessions.size }, "session created");
        }

        // We must add CORS. If the response headers are immutable, we might need a shallow copy.
        try {
            response.headers.set("Access-Control-Allow-Origin", "*");
            response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        } catch (e) {
            const newHeaders = new Headers(response.headers);
            newHeaders.set("Access-Control-Allow-Origin", "*");
            newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });
        }

        logger.info({ ...reqLogContext, status: response.status, rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB" }, "request completed");

        return response;
    } catch (err) {
        logger.error({ err, method, path: url.pathname, rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB" }, "[HTTP] Internal error handling request");
        return jsonCors({ error: String(err), code: "INTERNAL_ERROR" }, 500);
    }
}

// Current watcher handle — used to kill the old process before spawning a new one.
let _watcherProc: Bun.Subprocess<"ignore", "pipe", "ignore"> | null = null;

export function watchProxyContainerRestarts(): void {
    // Kill any previous watcher to prevent duplicate docker events processes.
    if (_watcherProc) {
        try { _watcherProc.stdout.cancel(); } catch { /* already closed */ }
        try { _watcherProc.kill("SIGTERM"); } catch { /* already exited */ }
    }

    // NOTE: These container names assume the Compose project name is "egress-proxy"
    const proxyNames = new Set([
        "egress-proxy-squid-1",
        "egress-proxy-api-relay-1",
        "egress-proxy-llama-proxy-1",
    ]);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const proc = Bun.spawn([
        "docker", "events", "--filter", "event=start",
        "--filter", "type=container",
        "--format", '{{.Actor.Attributes.name}} {{index .Actor.Attributes "com.docker.compose.project"}}',
    ], {
        stdout: "pipe",
        stderr: "ignore",
    });

    _watcherProc = proc;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
                    pending = lines.pop() ?? "";
                    for (const line of lines) {
                        const [name = "", project = ""] = line.trim().split(" ");
                        // Docker restarted a sandbox by itself (reboot, OOM): rerun its project hook.
                        if (project) void resumeProjectStartup(project);
                        if (proxyNames.has(name)) {
                            // Debounce — all 3 proxies restart close together, one reconnect covers all
                            if (debounceTimer) clearTimeout(debounceTimer);
                            debounceTimer = setTimeout(async () => {
                                logger.info("[HTTP] Proxy restart detected, reconnecting networks...");
                                try {
                                    await reconnectProxyToAllAgentNetworks();
                                    // api-relay may have a new IP: refresh squid relay_src
                                    scheduleNetworkPolicyReload();
                                } catch (err) {
                                    logger.error({ err }, "[HTTP] Proxy reconnect after restart failed");
                                }
                            }, 2000);
                        }
                    }
                }
            }
        } catch (err) {
            logger.error({ err }, "[HTTP] Proxy watcher stream error");
        } finally {
            reader.releaseLock();
        }
    })();

    proc.exited.then((code) => {
        logger.warn({ code }, "Docker events watcher exited, restarting in 5s");
        setTimeout(watchProxyContainerRestarts, 5000);
    });
}

// Periodic cleanup safety net — prunes stale sessions every minute regardless of
// whether clients explicitly close or are accessed via requests.
// Also the only place that forces a GC: a full synchronous GC stalls the event loop,
// so it must stay off the request path.
setInterval(async () => {
    await pruneStaleSessions();
    // Periodic garbage collection hint to reclaim native memory in Bun
    if (global.Bun) Bun.gc(true);
}, 60_000);
