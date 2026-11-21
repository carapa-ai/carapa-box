import { expect, test } from "bun:test";
import { createSession } from "./server.js";

test("native MCP advertises and delivers logging notifications on its SSE session", async () => {
    const { server, transport } = await createSession();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        };
        const initialized = await transport.handleRequest(new Request("http://localhost/api/mcp", {
            method: "POST", headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
                protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "logging-test", version: "1" },
            } }),
        }));
        const payload = (await initialized.text()).split("\n").find(line => line.startsWith("data: "))!;
        expect(JSON.parse(payload.slice(6)).result.capabilities.logging).toEqual({});
        headers["mcp-session-id"] = transport.sessionId!;
        headers["mcp-protocol-version"] = "2025-03-26";
        await transport.handleRequest(new Request("http://localhost/api/mcp", {
            method: "POST", headers,
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }));
        const stream = await transport.handleRequest(new Request("http://localhost/api/mcp", { headers }));
        expect(stream.status).toBe(200);
        reader = stream.body!.getReader();
        await server.sendLoggingMessage({ level: "info", data: "native streaming regression" });
        const chunk = await reader.read();
        const text = new TextDecoder().decode(chunk.value);
        expect(text).toContain('"method":"notifications/message"');
        expect(text).toContain("native streaming regression");
    } finally {
        await reader?.cancel();
        await server.close();
    }
});
