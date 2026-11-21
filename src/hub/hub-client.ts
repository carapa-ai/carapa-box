/**
 * Outbound control channel to a CarapaBoard hub.
 *
 * When CARAPA_HUB_URL, CARAPA_BOX_ID and CARAPA_HUB_BOX_SECRET are configured, the
 * box dials `<hub>/api/boxes/connect` and serves its MCP tool registry over
 * that WebSocket. Only the hub needs to be reachable; the box never accepts
 * inbound connections for this channel. The socket reconnects with backoff.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../logger.js";
import { HubSocketTransport } from "./socket-transport.js";
import { serveHttpTunnel, type HttpTunnelOptions } from "./http-tunnel.js";

export interface HubConfig {
    url: string;
    boxId: string;
    credential: string;
    kind: "docker" | "native";
    isolation?: string;
    version: string;
    capabilities: string[];
    /** Serve Board's browser viewer / tmux streams from this box's HTTP API. */
    tunnel?: HttpTunnelOptions;
    /**
     * Liveness check period. The box pings the hub every interval and drops the
     * connection after two intervals without any inbound traffic.
     */
    livenessIntervalMs?: number;
}

const MIN_BACKOFF_MS = 1_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/** Read hub settings from the environment; null when the box is not hub-managed. */
export function hubConfigFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    version = "0.1.0",
    /** Address the HTTP server actually bound (CLI flags win over env); falls back to env when omitted. */
    listen?: { host?: string; port?: number },
): HubConfig | null {
    const url = env.CARAPA_HUB_URL?.trim();
    const boxId = env.CARAPA_BOX_ID?.trim();
    const credential = env.CARAPA_HUB_BOX_SECRET?.trim();
    if (!url && !boxId && !credential) return null;
    if (!url || !boxId || !credential) {
        throw new Error("Hub mode requires CARAPA_HUB_URL, CARAPA_BOX_ID and CARAPA_HUB_BOX_SECRET");
    }
    const parsed = new URL(url);
    if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol)) throw new Error("CARAPA_HUB_URL must be a ws(s):// or http(s):// URL");
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    const local = ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(parsed.hostname);
    if (parsed.protocol === "ws:" && !local && env.CARAPA_HUB_ALLOW_INSECURE !== "1") {
        throw new Error("CARAPA_HUB_URL must use wss:// for a remote hub (set CARAPA_HUB_ALLOW_INSECURE=1 only on a trusted private network)");
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/api/boxes/connect";
    // Board reaches the streaming REST endpoints through the hub socket; the
    // box replays them against its own HTTP listener with its API token.
    const apiToken = env.CARAPA_BOX_API_TOKEN?.trim();
    const bindHost = (listen?.host ?? env.MCP_SANDBOX_HOST)?.trim();
    const loopbackHost = !bindHost || bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
    const tunnel = apiToken
        ? { baseUrl: `http://${loopbackHost.includes(":") ? `[${loopbackHost}]` : loopbackHost}:${listen?.port ?? (env.MCP_SANDBOX_PORT || 3100)}`, token: apiToken }
        : undefined;
    return {
        url: parsed.toString(),
        boxId,
        credential,
        kind: env.CARAPA_BOX_KIND === "native" ? "native" : "docker",
        isolation: env.CARAPA_BOX_ISOLATION?.trim() || undefined,
        version,
        capabilities: ["ipc-sync", "relay-token", ...(tunnel ? ["http-tunnel"] : [])],
        tunnel,
    };
}

export interface HubConnectionHandle {
    stop(): void;
}

/**
 * Keep a hub connection alive. `register` installs the tool registry on each
 * fresh McpServer (one per socket).
 */
export function startHubConnection(config: HubConfig, register: (server: McpServer) => void): HubConnectionHandle {
    let stopped = false;
    let connected = false;
    let backoff = MIN_BACKOFF_MS;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const livenessIntervalMs = config.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;

    const stopWatchdog = () => {
        if (watchdog) clearInterval(watchdog);
        watchdog = null;
    };

    const schedule = () => {
        if (stopped) return;
        const delay = Math.round(backoff * (0.5 + Math.random() / 2));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        timer = setTimeout(connect, delay);
    };

    const connect = () => {
        if (stopped) return;
        const headers: Record<string, string> = {
            "X-Carapa-Box-Id": config.boxId,
            "X-Carapa-Box-Kind": config.kind,
            "X-Carapa-Box-Version": config.version,
            "X-Carapa-Box-Capabilities": config.capabilities.join(","),
        };
        headers["Authorization"] = "Bearer " + config.credential;
        if (config.isolation) headers["X-Carapa-Box-Isolation"] = config.isolation;
        try {
            // Bun's WebSocket client accepts request headers.
            socket = new WebSocket(config.url, { headers } as unknown as string[]);
            socket.binaryType = "arraybuffer";
        } catch (err) {
            logger.warn({ err, url: config.url }, "[hub] Could not open hub connection");
            schedule();
            return;
        }
        const current = socket;
        let server: McpServer | null = null;
        let closed = false;
        let lastInbound = Date.now();
        const handleClosed = (code: number, reason: string) => {
            if (closed) return;
            closed = true;
            if (socket === current) stopWatchdog();
            const wasConnected = connected;
            connected = false;
            server?.close().catch(() => {});
            server = null;
            if (code === 4001) {
                logger.error({ reason }, "[hub] Hub revoked this box; not reconnecting until restart");
                stopped = true;
                return;
            }
            if (wasConnected) logger.warn({ code, reason }, "[hub] Hub connection closed; reconnecting");
            schedule();
        };
        // Any inbound frame (message or pong) proves the peer is alive.
        const markInbound = () => { lastInbound = Date.now(); };
        current.addEventListener("message", markInbound);
        current.addEventListener("pong", markInbound);
        current.addEventListener("open", () => {
            connected = true;
            lastInbound = Date.now();
            stopWatchdog();
            watchdog = setInterval(() => {
                if (Date.now() - lastInbound >= 2 * livenessIntervalMs) {
                    // A silently dead peer never answers the close handshake, so do not wait for the close event.
                    logger.warn({ idleMs: Date.now() - lastInbound }, "[hub] No traffic from hub; dropping connection");
                    try { current.close(); } catch { /* already closing */ }
                    handleClosed(4000, "hub liveness timeout");
                    return;
                }
                try { (current as unknown as { ping(): void }).ping(); } catch { /* socket closing */ } // Bun-only WebSocket.ping
            }, livenessIntervalMs);
            backoff = MIN_BACKOFF_MS;
            server = new McpServer({
                name: "carapa-box",
                version: config.version,
                description: "CarapaBox - Manages isolated coding environments.",
            }, { capabilities: { logging: {} } });
            register(server);
            if (config.tunnel) serveHttpTunnel(current, config.tunnel);
            server.connect(new HubSocketTransport(current)).catch((err) => {
                logger.warn({ err }, "[hub] MCP session failed to start");
                current.close();
            });
            logger.info({ url: config.url, boxId: config.boxId }, "[hub] Connected to CarapaBoard hub");
        });
        current.addEventListener("close", (event) => handleClosed(event.code, event.reason));
        current.addEventListener("error", () => {
            if (!connected) logger.debug({ url: config.url }, "[hub] Hub connection attempt failed");
        });
    };

    connect();
    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            stopWatchdog();
            socket?.close(1000);
        },
    };
}
