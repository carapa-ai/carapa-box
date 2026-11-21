/**
 * Tools Board needs on boxes it can reach only over the hub WebSocket.
 */
import * as z from "zod";
import { deleteRelayToken, setRelayToken } from "../relay-token-store.js";
import type { ToolFn } from "../runs/tools.js";


export function registerHubTools(tool: ToolFn): void {
    tool(
        "sandbox_relay_token",
        "Set or clear a per-sandbox relay credential (same store as PUT/DELETE /api/admin/relay-token/:name). Used by Board for boxes connected over the hub WebSocket.",
        {
            name: z.string().min(1).max(200).describe("Agent container hostname key, e.g. '<stack>-<instance>-<service>-1'"),
            service: z.string().max(100).optional().describe("Optional service scope (e.g. 'carapa-mail')"),
            value: z.string().min(1).max(4096).optional().describe("Credential to store; omit with clear=true to delete"),
            clear: z.boolean().optional().describe("Delete the stored credential"),
        },
        async (args) => {
            const { name, service, value, clear } = args as { name: string; service?: string; value?: string; clear?: boolean };
            if (clear) {
                await deleteRelayToken(name, service || undefined);
            } else if (value) {
                await setRelayToken(name, value, service || undefined);
            } else {
                return { content: [{ type: "text", text: "Provide value or clear=true" }], isError: true };
            }
            return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
        },
    );
}
