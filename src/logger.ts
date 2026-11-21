/**
 * Structured logger using pino.
 *
 * All output goes to stderr (fd 2) so it never contaminates the stdout
 * MCP JSON-RPC transport used in stdio mode.
 *
 * Dev:  pretty-printed coloured output via pino-pretty (if installed)
 * Prod: JSON lines on stderr
 */

import pino from "pino";

function createLogger() {
    const level = process.env.LOG_LEVEL || "info";
    const dest = pino.destination(2); // stderr — never pollute stdout (MCP JSON-RPC transport)
    const timestamp = () => `,"time":"${new Date().toISOString()}"`;

    if (process.env.NODE_ENV === "production") {
        return pino({ level, timestamp }, dest);
    }

    // Dev: try pino-pretty, fall back to plain JSON if not installed
    try {
        require.resolve("pino-pretty");
        return pino({
            level,
            timestamp,
            transport: {
                target: "pino-pretty",
                options: { colorize: process.env.LOG_COLOR !== "false", destination: 2 },
            },
        });
    } catch {
        return pino({ level, timestamp }, dest);
    }
}

export const logger = createLogger();
