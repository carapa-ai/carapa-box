/**
 * Wire contract of Board's tmux REST routes, shared by the Linux box
 * (src/http/tmux.ts) and the native runner (src/os-runner/tmux.ts).
 */
import * as z from "zod";

/** Send a wire-level SSE comment well below common proxy idle timeouts. */
export const TMUX_SSE_KEEPALIVE_INTERVAL_MS = 15_000;
export const TMUX_SSE_KEEPALIVE_FRAME = ": keepalive\n\n";
const sseEncoder = new TextEncoder();

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const attachSchema = z.object({
    stack: z.string().min(1, "stack is required"),
    service: z.string().min(1, "service is required"),
    instance: z.string().optional(),
    session: z.string().min(1, "session is required"),
    streamId: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    lines: z.number().int().positive().optional(),
});

export const execSchema = z.object({
    stack: z.string().min(1, "stack is required"),
    service: z.string().min(1, "service is required"),
    instance: z.string().optional(),
    session: z.string().min(1, "session is required"),
    input: z.string().min(1, "input is required"),
    inputBase64: z.boolean().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
});

export const resizeSchema = z.object({
    stack: z.string().min(1, "stack is required"),
    service: z.string().min(1, "service is required"),
    instance: z.string().optional(),
    session: z.string().min(1, "session is required"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
});

export const detachSchema = z.object({
    stack: z.string().min(1, "stack is required"),
    service: z.string().min(1, "service is required"),
    instance: z.string().optional(),
    session: z.string().min(1, "session is required"),
    streamId: z.string().min(1, "streamId is required"),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** JSON response with the REST surface's permissive CORS header. */
export function jsonCors(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
}

/** Parse + zod-validate a JSON request body. */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return {
            ok: false,
            res: jsonCors({ error: "Body must be valid JSON" }, 400),
        };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            res: jsonCors({ error: "Validation failed", details: parsed.error.issues }, 400),
        };
    }
    return { ok: true, data: parsed.data };
}

/**
 * Format a single SSE frame:
 *
 *     event: <name>\n
 *     data: <json>\n
 *     \n
 *
 * Trailing blank line is the event terminator per the SSE spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 */
export function sseFrame(event: string, payload: unknown): Uint8Array {
    const text = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    return sseEncoder.encode(text);
}
