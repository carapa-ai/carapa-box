/**
 * HTTP tunnel over the hub WebSocket.
 *
 * Board's browser viewer and tmux tab stream from this box's REST API
 * (/api/browser/*, /api/tmux/*). A remote box has no inbound port, so Board
 * sends those requests over the hub socket and the box replays them against
 * its own loopback HTTP server. MCP uses text frames; the tunnel uses binary
 * frames on the same socket:
 *
 *   [type u8][stream id u32 BE][payload]
 *
 *   Board -> box   0x01 REQUEST  JSON { method, path, headers, body? (base64) }
 *                  0x04 CANCEL   (empty)
 *   box -> Board   0x11 HEAD     JSON { status, statusText, headers }
 *                  0x12 DATA     raw body bytes
 *                  0x13 END      (empty)
 *                  0x14 ERROR    UTF-8 message
 *
 * Board's copy of this protocol lives in carapa-board
 * src/modules/boxes/http-tunnel.ts.
 */
import { logger } from "../logger.js";

export const FRAME = {
    request: 0x01,
    cancel: 0x04,
    head: 0x11,
    data: 0x12,
    end: 0x13,
    error: 0x14,
} as const;

/** Only the streaming endpoints Board cannot reach over MCP. */
const ALLOWED_PATH = /^\/api\/(browser|tmux)(\/[A-Za-z0-9._~-]+)*\/?(\?[A-Za-z0-9._~%&=-]*)?$/;
const FORWARDED_HEADERS = ["content-type", "accept", "last-event-id"];
const MAX_REQUEST_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** Pause a stream while this much is queued on the socket, so MCP stays responsive. */
const HIGH_WATER_BYTES = 1024 * 1024;

export function encodeFrame(type: number, id: number, payload: Uint8Array | string = new Uint8Array()): Uint8Array<ArrayBuffer> {
    const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    const frame = new Uint8Array(5 + body.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, type);
    view.setUint32(1, id);
    frame.set(body, 5);
    return frame;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): { type: number; id: number; payload: Uint8Array } | null {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 5) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { type: view.getUint8(0), id: view.getUint32(1), payload: bytes.subarray(5) };
}

export interface HttpTunnelOptions {
    /** Base URL of this box's own HTTP API, e.g. http://127.0.0.1:3100. */
    baseUrl: string;
    /** CARAPA_BOX_API_TOKEN; Board's credentials are never forwarded. */
    token: string;
    /** Defaults to fetch over baseUrl; a box with no listener dispatches in-process. */
    fetchImpl?: (input: URL, init: RequestInit) => Promise<Response>;
}

/** Serve Board's tunnelled requests on an open hub socket until it closes. */
export function serveHttpTunnel(socket: WebSocket, options: HttpTunnelOptions): void {
    const fetchImpl = options.fetchImpl ?? fetch;
    const streams = new Map<number, AbortController>();
    const send = (type: number, id: number, payload?: Uint8Array | string) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(type, id, payload));
    };
    const drained = async (signal: AbortSignal) => {
        while (socket.bufferedAmount > HIGH_WATER_BYTES && !signal.aborted && socket.readyState === WebSocket.OPEN) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return !signal.aborted && socket.readyState === WebSocket.OPEN;
    };

    const handle = async (id: number, payload: Uint8Array) => {
        const controller = new AbortController();
        streams.set(id, controller);
        try {
            if (payload.length > MAX_REQUEST_BYTES) throw new Error("Tunnel request too large");
            const request = JSON.parse(new TextDecoder().decode(payload)) as {
                method?: string; path?: string; headers?: Record<string, string>; body?: string;
            };
            const method = String(request.method || "GET").toUpperCase();
            const path = String(request.path || "");
            if (!["GET", "POST", "DELETE"].includes(method) || !ALLOWED_PATH.test(path) || path.includes("..")) {
                throw new Error(`Tunnel request not allowed: ${method} ${path.slice(0, 120)}`);
            }
            const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
            for (const name of FORWARDED_HEADERS) {
                const value = request.headers?.[name];
                if (typeof value === "string") headers[name] = value;
            }
            const response = await fetchImpl(new URL(path, options.baseUrl), {
                method,
                headers,
                body: request.body === undefined ? undefined : Buffer.from(request.body, "base64"),
                signal: controller.signal,
            });
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, name) => { responseHeaders[name] = value; });
            send(FRAME.head, id, JSON.stringify({ status: response.status, statusText: response.statusText, headers: responseHeaders }));
            if (response.body) {
                const reader = response.body.getReader();
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
                            if (!(await drained(controller.signal))) return;
                            send(FRAME.data, id, value.subarray(offset, offset + CHUNK_BYTES));
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            }
            send(FRAME.end, id);
        } catch (error) {
            if (!controller.signal.aborted) {
                send(FRAME.error, id, error instanceof Error ? error.message : String(error));
            }
        } finally {
            streams.delete(id);
        }
    };

    socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return; // MCP JSON-RPC
        const frame = decodeFrame(event.data as ArrayBuffer | Uint8Array);
        if (!frame) return;
        if (frame.type === FRAME.request) {
            if (streams.has(frame.id)) return;
            void handle(frame.id, frame.payload);
        } else if (frame.type === FRAME.cancel) {
            streams.get(frame.id)?.abort();
        }
    });
    socket.addEventListener("close", () => {
        for (const controller of streams.values()) controller.abort();
        streams.clear();
    });
    logger.debug("[hub] HTTP tunnel ready");
}
