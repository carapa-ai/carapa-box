import fsp from "node:fs/promises";
import path from "node:path";

import * as z from "zod";

import { fileExists, parseEnvFile, mergeEnvFile, execDocker, resolveOwnedProjects } from "../utils.js";
import { listStacks, getStack, getStacksDir, getEgressProxyDir } from "../config.js";
import { getStackStatus, listProjects } from "../compose/client.js";
import { readContainerInventory, type ContainerStatus } from "../compose/inventory.js";
import { toolRegistry } from "../tools/register.js";
import { logger } from "../logger.js";
import { resolveAuditLogPath } from "../audit.js";
import { getRelayToken, setRelayToken, deleteRelayToken } from "../relay-token-store.js";
import { configuredProviderAccounts, ProviderAccountError } from '../provider-accounts.js';
import { getEgressDeployDrift } from "../compose/egress-drift.js";
import { getProjectIdentity } from "../network-policy.js";
import { configuredMcpConnections } from '../mcp-connections.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(value), { ...init, headers });
}

export interface InstanceRow {
    /** Compose project name (e.g. "carapa-board-user1"). */
    project: string;
    /** Stack name the project runs from (e.g. "carapa-board"). */
    stack: string;
    /** Instance suffix when the project is `<stack>-<instance>`, else "". */
    instance: string;
    /** "running" (all services up) | "partial" | "stopped" (no running container). */
    status: "running" | "partial" | "stopped";
    /** Seconds since the oldest still-running container started; null when stopped. */
    uptime: number | null;
    /** IP of the agent (or first) service, "" when none is reachable. */
    ip: string;
    services: Array<{ service: string; hostname: string; status: string; running: boolean; ip: string }>;
}

/**
 * Build dashboard instance rows from the compose project list plus the shared
 * container inventory (one discovery + one batched inspect, no per-project
 * compose fan-out). Only projects owned by a local stack are reported —
 * infrastructure projects (egress-proxy, carapa-box) surface through their
 * own stat cards. Includes stopped projects (compose ls --all) whose
 * containers were not fully torn down, so crashed sandboxes stay visible.
 */
async function buildInstanceRows(): Promise<InstanceRow[]> {
    const [projectsResult, inventory] = await Promise.all([
        listProjects(true),
        readContainerInventory().catch((err) => {
            logger.warn({ err }, "Container inventory unavailable for admin dashboard");
            return [] as ContainerStatus[];
        }),
    ]);
    const projects = JSON.parse(projectsResult.stdout || "[]");

    const byProject = new Map<string, ContainerStatus[]>();
    const workingDirectories = new Map<string, string[]>();
    for (const container of inventory) {
        const labels = container.Config?.Labels ?? {};
        const project = labels["com.docker.compose.project"];
        if (!project) continue;
        const peers = byProject.get(project) ?? [];
        peers.push(container);
        byProject.set(project, peers);
        const workingDir = labels["com.docker.compose.project.working_dir"];
        if (workingDir) {
            const dirs = workingDirectories.get(project) ?? [];
            if (!dirs.includes(workingDir)) dirs.push(workingDir);
            workingDirectories.set(project, dirs);
        }
    }

    const rawStacksDir = getStacksDir();
    const stacksDir = await fsp.realpath(rawStacksDir).catch(() => path.resolve(rawStacksDir));
    const owned = await resolveOwnedProjects(projects, stacksDir, {
        listStacks, execDocker, readFile: fsp.readFile, workingDirectories,
    });

    const now = Date.now();
    return owned.map((project): InstanceRow => {
        const containers = (byProject.get(project.name) ?? []).filter(
            (container) => container.Config?.Labels?.["com.docker.compose.oneoff"]?.toLowerCase() !== "true",
        );
        const running = containers.filter((container) => container.State?.Running);
        const status = running.length === 0 ? "stopped"
            : running.length === containers.length ? "running"
            : "partial";

        // Uptime of the oldest still-running container ≈ when the stack started.
        // (Docker's zero time for never-started containers is filtered by > 0.)
        let uptime: number | null = null;
        if (running.length > 0) {
            let oldest = 0;
            for (const container of running) {
                const started = Date.parse(container.State?.StartedAt ?? "");
                if (Number.isFinite(started) && started > 0 && started <= now) {
                    const seconds = Math.floor((now - started) / 1000);
                    if (seconds > oldest) oldest = seconds;
                }
            }
            uptime = oldest;
        }

        const serviceOf = (container: ContainerStatus): string =>
            container.Config?.Labels?.["com.docker.compose.service"] ?? "";
        const ipOf = (container: ContainerStatus): string => {
            const networks = container.NetworkSettings?.Networks ?? {};
            // Prefer the per-instance agent network IP, then any network IP.
            const preferred = networks[`agent_egress_${project.name}`]?.IPAddress;
            if (preferred) return preferred;
            return Object.values(networks).find((network) => network.IPAddress)?.IPAddress ?? "";
        };

        // The agent service is the sandbox's front door; fall back to the first
        // running (then first) container so single-service stacks report an IP.
        const main =
            running.find((container) => serviceOf(container) === "agent") ??
            running[0] ??
            containers[0];

        const services = containers.map((container) => ({
            service: serviceOf(container),
            hostname: container.Name,
            status: container.State?.Status ?? "unknown",
            running: !!container.State?.Running,
            ip: ipOf(container),
        }));

        const stack = path.basename(project.localStackPath);
        const instance = project.name.startsWith(`${stack}-`)
            ? project.name.slice(stack.length + 1)
            : "";

        return {
            project: project.name,
            stack,
            instance,
            status,
            uptime,
            ip: main ? ipOf(main) : "",
            services,
        };
    });
}

/** Tools the operator dashboard may invoke via /api/admin/tools/:name. */
export const ADMIN_TOOL_ALLOWLIST = new Set(["sandbox_start", "sandbox_stop"]);

export async function handleAdminApi(req: Request, url: URL): Promise<Response> {
    const method = req.method;
    const pathname = url.pathname;

    if (pathname === '/api/admin/provider-accounts' || pathname.startsWith('/api/admin/provider-accounts/')) {
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        try {
            const accounts = configuredProviderAccounts();
            const suffix = pathname.slice('/api/admin/provider-accounts'.length);
            let result;
            if (!suffix && method === 'GET') result = await accounts.list();
            else if (suffix === '/usage' && method === 'GET') result = await accounts.usage();
            else if (suffix === '/models' && method === 'GET') result = await accounts.models();
            else if (suffix === '/order' && method === 'POST') result = await accounts.reorder((await req.json() as { ids?: unknown } | null)?.ids);
            else if (suffix === '/login' && method === 'POST') result = await accounts.start(await req.json());
            else if (method === 'PATCH' && /^\/[a-f0-9-]{36}$/.test(suffix)) result = await accounts.update(suffix.slice(1), await req.json());
            else if (method === 'DELETE' && /^\/[a-f0-9-]{36}$/.test(suffix)) result = await accounts.remove(suffix.slice(1));
            else {
                const match = /^\/login\/([a-f0-9-]{36})(\/complete)?$/.exec(suffix);
                if (!match) return jsonResponse({}, { status: 404, headers });
                if (match[2] && method === 'POST') result = await accounts.complete(match[1], (await req.json() as any)?.value);
                else if (!match[2] && method === 'DELETE') result = await accounts.cancel(match[1]);
                else return jsonResponse({}, { status: 405, headers });
            }
            return jsonResponse(result, { headers });
        } catch (error) {
            // A key check's refusal is written for the admin; nothing else is shown.
            if (error instanceof ProviderAccountError) return jsonResponse({ error: error.message }, { status: 400, headers });
            // Never serialize native provider errors, authorization codes or file contents.
            return jsonResponse({ error: 'Provider account operation failed. Check configuration, login state, or cancel and reconnect.' }, { status: 400, headers });
        }
    }

    if (pathname === '/api/admin/mcp-connections' || pathname.startsWith('/api/admin/mcp-connections/')) {
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        try {
            const connections = configuredMcpConnections();
            const suffix = pathname.slice('/api/admin/mcp-connections'.length);
            let result;
            if (!suffix && method === 'GET') result = connections.list();
            else if (suffix === '/login' && method === 'POST') result = connections.start(await req.json());
            else if (suffix === '/revoke' && method === 'POST') result = connections.revoke(await req.json());
            else {
                const match = /^\/login\/([a-f0-9-]{36})(\/complete)?$/.exec(suffix);
                if (!match) return jsonResponse({}, { status: 404, headers });
                if (match[2] && method === 'POST') result = connections.complete(match[1], ((await req.json()) as { value?: unknown } | null)?.value);
                else if (!match[2] && method === 'DELETE') result = connections.cancel(match[1]);
                else return jsonResponse({}, { status: 405, headers });
            }
            return jsonResponse(result, { headers });
        } catch {
            // Never serialize relay errors, authorization codes or file contents.
            return jsonResponse({ error: 'MCP connection operation failed. Check configuration, login state, or cancel and reconnect.' }, { status: 400, headers });
        }
    }

    // Relay token store — the api-relay pulls per-sandbox tokens from here
    // (GET). carapa-board can also write tokens out-of-band (POST/DELETE) so a
    // changed per-project token (e.g. carapa-mail) propagates to the relay
    // without restarting the sandbox: register.ts is no longer the only writer.
    // The HTTP server accepts the Board/relay API token or the operator admin
    // token for these service operations (agents never hold either Box token).
    if (pathname.startsWith("/api/admin/relay-token/")) {
        let name: string;
        try {
            name = decodeURIComponent(pathname.slice("/api/admin/relay-token/".length));
        } catch {
            return jsonResponse({ error: "Invalid token name encoding" }, { status: 400 });
        }
        // Optional service scope — e.g. ?service=carapa-mail addresses the
        // per-project mail MCP token instead of the bare (board) token.
        const service = url.searchParams.get("service") || undefined;
        if (!name) {
            return jsonResponse({ error: "Missing token name" }, { status: 400 });
        }
        if (method === "GET") {
            const token = getRelayToken(name, service);
            if (!token) {
                return jsonResponse({ error: "Not Found" }, { status: 404 });
            }
            return jsonResponse({ token });
        }
        if (method === "POST" || method === "PUT") {
            let body: any = null;
            try { body = await req.json(); } catch { /* invalid/empty body handled below */ }
            const token = body?.token;
            if (typeof token !== "string" || !token) {
                return jsonResponse({ error: "Body must be { token: string }" }, { status: 400 });
            }
            await setRelayToken(name, token, service);
            return jsonResponse({ ok: true });
        }
        if (method === "DELETE") {
            await deleteRelayToken(name, service);
            return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "Method Not Allowed" }, { status: 405 });
    }

    // Maps an egress network suffix (compose project name) to the board
    // project identity (stack + instance) the api-relay authorizes against.
    if (pathname.startsWith("/api/admin/relay-identity/")) {
        if (method !== "GET") {
            return jsonResponse({ error: "Method Not Allowed" }, { status: 405 });
        }
        let name = "";
        try { name = decodeURIComponent(pathname.slice("/api/admin/relay-identity/".length)); } catch { /* rejected below */ }
        if (!/^[\w-]{1,128}$/.test(name)) {
            return jsonResponse({ error: "Invalid name" }, { status: 400 });
        }
        const identity = getProjectIdentity(name);
        if (!identity) {
            return jsonResponse({ error: "Not Found" }, { status: 404 });
        }
        return jsonResponse(identity);
    }

    // 1. /info - System overview
    if (pathname === "/api/admin/info") {
        const [instances, egressStatus] = await Promise.all([
            buildInstanceRows(),
            (async () => {
                const egressDir = getEgressProxyDir();
                const status = { running: false, deploy_drift: getEgressDeployDrift() };
                if (await fileExists(egressDir)) {
                    const s = await getStackStatus(egressDir, "egress-proxy");
                    status.running = s.stdout.includes('"running"');
                }
                return status;
            })(),
        ]);

        return jsonResponse({
            uptime: Math.floor(process.uptime()),
            port: process.env.MCP_SANDBOX_PORT || "3100",
            stacks_dir: getStacksDir(),
            auth_enabled: !!process.env.CARAPA_BOX_API_TOKEN,
            active_sandboxes: instances.filter((row) => row.status !== "stopped").length,
            instances,
            egress_proxy: egressStatus,
            features: {
                git: !!process.env.ENABLE_SANDBOX_GIT,
                issues: !!process.env.ENABLE_GIT_ISSUES,
                tmux: !!process.env.ENABLE_SANDBOX_TMUX,
            }
        });
    }

    // 2. /stacks - List all stacks
    if (pathname === "/api/admin/stacks") {
        const stacks = await listStacks();
        return jsonResponse(stacks);
    }

    // 2.1 /tools/:name - Operator control actions for the admin dashboard.
    // Reuses the canonical sandbox tools (same lifecycle logic, hooks and
    // cleanup as the MCP/board path). Only lifecycle tools are exposed to the
    // admin surface; arbitrary tool dispatch stays on the API-token surface
    // (/api/tools/*) so the dashboard cannot exec inside sandboxes.
    if (pathname.startsWith("/api/admin/tools/")) {
        let toolName: string;
        try {
            toolName = decodeURIComponent(pathname.slice("/api/admin/tools/".length));
        } catch {
            return jsonResponse({ error: "Invalid tool name encoding" }, { status: 400 });
        }
        if (method !== "POST" || !ADMIN_TOOL_ALLOWLIST.has(toolName)) {
            return jsonResponse({ error: "Not Found" }, { status: 404 });
        }
        const entry = toolRegistry.get(toolName);
        if (!entry) {
            return jsonResponse({ error: `Unknown tool: ${toolName}` }, { status: 404 });
        }

        const body = await req.json().catch(() => ({}));
        const parsed = z.object(entry.schema).safeParse(body);
        if (!parsed.success) {
            return jsonResponse({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
        }

        try {
            const result = await entry.handler(parsed.data);
            const text = result?.content?.[0]?.text ?? "";
            return jsonResponse(
                { result: text, isError: !!result?.isError },
                { status: result?.isError ? 500 : 200 },
            );
        } catch (err) {
            logger.error({ tool: toolName, err: String(err) }, "[HTTP] [ADMIN] tool execution failed");
            return jsonResponse({ error: String(err), code: "INTERNAL_ERROR" }, { status: 500 });
        }
    }

    // 3. /logs - Audit logs (read last ~100 lines efficiently)
    if (pathname === "/api/admin/logs") {
        const logPath = resolveAuditLogPath();
        let entries: any[] = [];
        try {
            const fh = await fsp.open(logPath, "r");
            try {
                const stat = await fh.stat();
                // Read last 256KB (enough for ~100 JSON lines)
                const readSize = Math.min(stat.size, 256 * 1024);
                const buf = Buffer.alloc(readSize);
                await fh.read(buf, 0, readSize, stat.size - readSize);
                const tail = buf.toString("utf-8");
                const allLines = tail.split("\n").filter(Boolean);
                // If we read a partial first line (mid-file read), skip it
                const lines = stat.size > readSize ? allLines.slice(1) : allLines;
                entries = lines.map(line => {
                    try { return JSON.parse(line); } catch { return null; }
                }).filter(Boolean).slice(-100);
            } finally {
                await fh.close();
            }
        } catch (e) {
            // File doesn't exist or read error — return empty entries
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                logger.error({ err: e }, "Error reading audit logs");
            }
        }
        return jsonResponse(entries);
    }

    // 4. /config - Read/Write .env files
    if (pathname === "/api/admin/config") {
        const fileType = url.searchParams.get("file") || "root";
        const isSecretKey = (key: string) => /(_SECRET|_TOKEN|_API_KEY|_PASSWORD|_PAT)$/.test(key);
        const rootPath = path.resolve(process.cwd(), ".env");
        const egressPath = () => path.join(getEgressProxyDir(), ".env");
        const invalid = () => jsonResponse({ error: "Config must be an object of string values without line breaks", code: "INVALID_CONFIG" }, { status: 400 });
        // Returns the writable (non-secret) updates, or null when the body is not a flat string map without line breaks.
        const parseUpdates = (body: unknown): Record<string, string> | null => {
            if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
            const updates: Record<string, string> = {};
            for (const [key, val] of Object.entries(body)) {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== "string" || /[\r\n]/.test(val)) return null;
                // Secret keys must be managed via Docker secret files; never written here
                if (!isSecretKey(key)) updates[key] = val;
            }
            return updates;
        };

        if (method === "GET") {
            const config = await parseEnvFile(fileType === "egress" ? egressPath() : rootPath);
            // Never expose secrets through the admin API
            for (const key of Object.keys(config)) if (isSecretKey(key)) delete config[key];
            return jsonResponse(config);
        }
        if (method === "POST") {
            let newConfig: unknown;
            try {
                newConfig = await req.json();
            } catch (e) {
                return jsonResponse({ error: String(e), code: "PARSE_ERROR" }, { status: 400 });
            }

            if (fileType === "both") {
                // Paired save: root and egress must end up in the same state, so a failed write leaves both files as they were.
                if (typeof newConfig !== "object" || newConfig === null || Array.isArray(newConfig)) return invalid();
                const body = newConfig as Record<string, unknown>;
                const rootUpdates = parseUpdates(body.root);
                const egressUpdates = parseUpdates(body.egress);
                if (!rootUpdates || !egressUpdates) return invalid();
                const target = egressPath();
                let snapshot: { content: string; mode: number } | null = null;
                try {
                    snapshot = { content: await fsp.readFile(target, "utf-8"), mode: (await fsp.stat(target)).mode & 0o777 };
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return jsonResponse({ error: String(e), code: "INTERNAL_ERROR" }, { status: 500 });
                }
                try {
                    // Egress first: it is the file that can be unwritable in host mode (missing dir, EACCES)
                    await mergeEnvFile(target, egressUpdates);
                } catch (e) {
                    return jsonResponse({ error: String(e), code: "INTERNAL_ERROR" }, { status: 500 });
                }
                try {
                    await mergeEnvFile(rootPath, rootUpdates);
                } catch (e) {
                    try {
                        if (snapshot) await fsp.writeFile(target, snapshot.content, { encoding: "utf-8", mode: snapshot.mode });
                        else await fsp.rm(target, { force: true });
                    } catch (restoreErr) {
                        logger.error({ err: restoreErr }, "Failed to restore egress .env after root write failure");
                    }
                    return jsonResponse({ error: String(e), code: "INTERNAL_ERROR" }, { status: 500 });
                }
                for (const [key, val] of Object.entries(rootUpdates)) process.env[key] = val;
                return jsonResponse({ ok: true });
            }

            const updates = parseUpdates(newConfig);
            if (!updates) return invalid();
            try {
                await mergeEnvFile(fileType === "egress" ? egressPath() : rootPath, updates);

                // Only reload into process.env if it's the root config
                if (fileType === "root") {
                    for (const [key, val] of Object.entries(updates)) {
                        process.env[key] = val;
                    }
                }

                return jsonResponse({ ok: true });
            } catch (e) {
                return jsonResponse({ error: String(e), code: "INTERNAL_ERROR" }, { status: 500 });
            }
        }
    }

    // 5. /stacks/:name/policy - Read policy.rego source
    if (pathname.startsWith("/api/admin/stacks/") && pathname.endsWith("/policy")) {
        const stackName = pathname.split("/")[4];
        const stack = await getStack(stackName);
        if (!stack) return jsonResponse({ error: "Stack not found" }, { status: 404 });

        if (method === "GET") {
            const regoPath = path.join(stack.path, "policy.rego");
            if (!(await fileExists(regoPath))) return jsonResponse({ error: "No policy.rego found" }, { status: 404 });
            const content = await fsp.readFile(regoPath, "utf-8");
            return jsonResponse({ rego: content });
        }
    }

    return jsonResponse({ error: "Not Found" }, { status: 404 });
}
