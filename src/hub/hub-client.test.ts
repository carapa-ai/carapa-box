import { describe, expect, it } from "bun:test";
import { hubConfigFromEnv, startHubConnection } from "./hub-client.js";

const hubEnv = {
    CARAPA_HUB_URL: "wss://hub.example/",
    CARAPA_BOX_ID: "box-1",
    CARAPA_HUB_BOX_SECRET: "secret",
    CARAPA_BOX_API_TOKEN: "token",
};

describe("hubConfigFromEnv tunnel target", () => {
    it("uses the listen address the server bound instead of re-reading env", () => {
        const config = hubConfigFromEnv({ ...hubEnv, MCP_SANDBOX_PORT: "3100" }, "0.1.0", { host: "127.0.0.2", port: 4000 });
        expect(config?.tunnel?.baseUrl).toBe("http://127.0.0.2:4000");
    });

    it("maps a wildcard bind host to loopback and brackets IPv6", () => {
        expect(hubConfigFromEnv(hubEnv, "0.1.0", { host: "0.0.0.0", port: 4000 })?.tunnel?.baseUrl).toBe("http://127.0.0.1:4000");
        expect(hubConfigFromEnv(hubEnv, "0.1.0", { host: "::1", port: 4000 })?.tunnel?.baseUrl).toBe("http://[::1]:4000");
    });
});

describe("startHubConnection liveness", () => {
    const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    /** Raw TCP hub: completes the WS handshake, never answers pings and never closes. */
    function startRawHub(onConnect: (socket: { write(data: string | Uint8Array): number }) => (() => void) | void) {
        let connections = 0;
        const cleanups: Array<() => void> = [];
        const server = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: {
                data(socket, data) {
                    const key = /sec-websocket-key:\s*(\S+)/i.exec(Buffer.from(data).toString("latin1"))?.[1];
                    if (!key) return; // client frames after the handshake are ignored
                    const accept = new Bun.CryptoHasher("sha1").update(key + WS_GUID).digest("base64");
                    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                    connections++;
                    const cleanup = onConnect(socket);
                    if (cleanup) cleanups.push(cleanup);
                },
            },
        });
        return {
            url: `ws://127.0.0.1:${server.port}`,
            connections: () => connections,
            stop: () => {
                for (const cleanup of cleanups) cleanup();
                server.stop(true);
            },
        };
    }

    const baseConfig = (url: string) => ({
        url,
        boxId: "box-1",
        credential: "secret",
        kind: "native" as const,
        version: "0.1.0",
        capabilities: [],
        livenessIntervalMs: 100,
    });

    it("reconnects after a hub that completes the handshake and goes silent", async () => {
        const hub = startRawHub(() => {});
        const handle = startHubConnection(baseConfig(hub.url), () => {});
        try {
            await waitFor(() => hub.connections() >= 2, 5_000);
        } finally {
            handle.stop();
            hub.stop();
        }
        expect(hub.connections()).toBeGreaterThanOrEqual(2);
    });

    it("keeps a connection whose hub keeps sending messages", async () => {
        const frame = Buffer.concat([Buffer.from([0x81, 0x2f]), Buffer.from('{"jsonrpc":"2.0","method":"notifications/test"}')]);
        const hub = startRawHub((socket) => {
            const timer = setInterval(() => socket.write(frame), 40);
            return () => clearInterval(timer);
        });
        const handle = startHubConnection(baseConfig(hub.url), () => {});
        try {
            await Bun.sleep(1_500); // well past two liveness intervals, plus the 1 s minimum reconnect backoff
        } finally {
            handle.stop();
            hub.stop();
        }
        expect(hub.connections()).toBe(1);
    });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("waitFor timed out");
        await Bun.sleep(25);
    }
}
