/**
 * Browser-origin guard for the unauthenticated loopback mode.
 *
 * With no API token configured any local process may call the controller, but
 * a web page the operator visits must not: a text/plain POST is a CORS simple
 * request and needs no preflight, and a rebound DNS name reaches 127.0.0.1
 * under a foreign Host. Non-browser local clients send no Origin and a
 * loopback Host, so they pass.
 */
import { isLoopbackHost } from "./bind.js";

/** Host header value (`name`, `name:port`, `[v6]`, `[v6]:port`) -> bare host. */
function hostnameOfHostHeader(host: string): string {
    const value = host.trim();
    if (value.startsWith("[")) {
        const end = value.indexOf("]");
        return end === -1 ? value : value.slice(0, end + 1);
    }
    return value.replace(/:\d*$/, "");
}

export function isLoopbackOrigin(origin: string): boolean {
    try {
        return isLoopbackHost(new URL(origin).hostname);
    } catch {
        return false; // "null" (sandboxed frame, file://) and malformed values
    }
}

/** Returns the rejection reason, or null when the request may proceed. */
export function foreignBrowserRequestReason(req: Request, url: URL): string | null {
    const origin = req.headers.get("origin");
    if (origin !== null && !isLoopbackOrigin(origin)) return "non-loopback Origin";
    const host = req.headers.get("host") ?? url.host;
    if (!isLoopbackHost(hostnameOfHostHeader(host))) return "non-loopback Host";
    return null;
}
