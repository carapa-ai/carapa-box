/**
 * Local models for native agents. Agents address llama-proxy as in a
 * container (http://llama-proxy:<port>); the runtime rewrites that to the
 * relay forwarder's /llama-proxy/<port>/..., the only local port their
 * sandbox may reach. The runner serves those paths with the llama-proxy
 * container's handler (same request transforms), forwarding to
 * <llamaUpstreamHost>:<port>, e.g. the hub's model servers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerConfig } from "./config.js";

export type LocalRoute = (req: IncomingMessage, res: ServerResponse) => boolean;

export async function startLlamaRoute(config: RunnerConfig): Promise<LocalRoute | undefined> {
    if (!config.llamaUpstreamHost) return undefined;
    // llama-proxy reads its settings from the environment when it loads.
    process.env.UPSTREAM_HOST = config.llamaUpstreamHost;
    process.env.TOOL_PROFILES_PATH = config.llamaToolProfiles;
    // @ts-ignore -- plain Node module shared with the llama-proxy container
    const proxy = await import("../../egress-proxy/llama-proxy.mjs");
    proxy.loadProfiles();
    const handlers = new Map<number, (req: IncomingMessage, res: ServerResponse) => void>(
        config.llamaPorts.map(port => [port, proxy.makeHandler(port)]));
    return (req, res) => {
        const match = /^\/llama-proxy\/(\d+)(\/.*)?$/.exec(req.url ?? "");
        if (!match) return false;
        const handler = handlers.get(Number(match[1]));
        if (!handler) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("llama-proxy port not enabled on this runner\n");
            return true;
        }
        req.url = match[2] || "/";
        handler(req, res);
        return true;
    };
}
