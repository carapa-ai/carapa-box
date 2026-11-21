import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { decodeFrame, encodeFrame, FRAME, serveHttpTunnel } from "./http-tunnel.js";

// Box API stand-in: records what reached it and streams an SSE body.
const seen: Array<{ path: string; auth: string | null }> = [];
let releaseStream: (() => void) | null = null;
let streamAborted: Promise<void>;
let markAborted: () => void;
const api = Bun.serve({
    port: 0,
    fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
        if (url.pathname === "/api/tmux/attach") {
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("event: init\ndata: {}\n\n"));
                    releaseStream = () => controller.close();
                },
            });
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname === "/api/browser/attach") {
            req.signal.addEventListener("abort", () => markAborted());
            return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{\"type\":\"attached\"}\n")); } }));
        }
        return new Response("unexpected", { status: 500 });
    },
});

// Board stand-in: the WebSocket server the box dials.
type Frame = NonNullable<ReturnType<typeof decodeFrame>>;
const frames: Frame[] = [];
let waiter: { match: (f: Frame) => boolean; resolve: (f: Frame) => void } | null = null;
let board: { send(data: Uint8Array): void } | null = null;
const hub = Bun.serve({
    port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
        open(ws) { board = ws; },
        message(_ws, data) {
            const frame = decodeFrame(data as Uint8Array);
            if (!frame) return;
            frames.push(frame);
            if (waiter?.match(frame)) { waiter.resolve(frame); waiter = null; }
        },
    },
});
const next = (match: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
        const found = frames.find(match);
        if (found) resolve(found); else waiter = { match, resolve };
    });
const request = (id: number, body: object) => board!.send(encodeFrame(FRAME.request, id, JSON.stringify(body)));
const text = (f: Frame) => new TextDecoder().decode(f.payload);

let socket: WebSocket;
beforeAll(async () => {
    streamAborted = new Promise((resolve) => { markAborted = resolve; });
    socket = new WebSocket(`ws://127.0.0.1:${hub.port}`);
    socket.binaryType = "arraybuffer";
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    serveHttpTunnel(socket, { baseUrl: `http://127.0.0.1:${api.port}`, token: "box-token" });
    while (!board) await Bun.sleep(1);
});
afterAll(() => { socket.close(); hub.stop(true); api.stop(true); });

describe("HTTP tunnel over the hub socket", () => {
    it("streams an allowed request with the box token, never Board's credentials", async () => {
        request(1, { method: "POST", path: "/api/tmux/attach", headers: { "content-type": "application/json", authorization: "Bearer board-token" }, body: Buffer.from("{}").toString("base64") });
        const head = await next((f) => f.id === 1 && f.type === FRAME.head);
        expect(JSON.parse(text(head)).status).toBe(200);
        const data = await next((f) => f.id === 1 && f.type === FRAME.data);
        expect(text(data)).toContain("event: init");
        releaseStream!();
        await next((f) => f.id === 1 && f.type === FRAME.end);
        expect(seen.find((s) => s.path === "/api/tmux/attach")?.auth).toBe("Bearer box-token");
    });

    it("refuses other API routes and cancels upstream when Board cancels", async () => {
        request(2, { method: "GET", path: "/api/admin/stats" });
        const refused = await next((f) => f.id === 2 && f.type === FRAME.error);
        expect(text(refused)).toContain("not allowed");
        expect(seen.some((s) => s.path.startsWith("/api/admin"))).toBe(false);

        request(3, { method: "POST", path: "/api/browser/attach" });
        await next((f) => f.id === 3 && f.type === FRAME.data);
        board!.send(encodeFrame(FRAME.cancel, 3));
        await streamAborted;
    });
});
