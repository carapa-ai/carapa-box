/**
 * MCP server transport over an outbound WebSocket to the CarapaBoard hub:
 * one JSON-RPC message per text frame. Board is the MCP client.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class HubSocketTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    private closed = false;

    constructor(private readonly socket: WebSocket) {}

    async start(): Promise<void> {
        this.socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            let message: JSONRPCMessage;
            try {
                message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
            } catch (error) {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.onmessage?.(message);
        });
        this.socket.addEventListener("close", () => this.handleClose());
        this.socket.addEventListener("error", () => this.onerror?.(new Error("Hub WebSocket error")));
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error("Hub connection is closed");
        }
        this.socket.send(JSON.stringify(message));
    }

    async close(): Promise<void> {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
        this.handleClose();
    }

    private handleClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.();
    }
}
