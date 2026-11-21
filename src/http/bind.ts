/**
 * HTTP listener bind policy.
 *
 * The HTTP endpoint binds to loopback by default. Binding to any other
 * interface exposes MCP and sandbox tools to the network, so it is refused
 * unless CARAPA_BOX_API_TOKEN is configured.
 */

const DEFAULT_BIND_HOST = "127.0.0.1";

export function isLoopbackHost(host: string): boolean {
    const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

/** --host=X > MCP_SANDBOX_HOST > 127.0.0.1 */
export function resolveBindHost(args: string[], env: Record<string, string | undefined> = process.env): string {
    const fromArg = args.find(a => a.startsWith("--host="))?.slice("--host=".length).trim();
    return fromArg || env.MCP_SANDBOX_HOST?.trim() || DEFAULT_BIND_HOST;
}

/** Returns an error message when the bind must be refused, otherwise null. */
export function bindHostError(host: string, apiToken: string | undefined): string | null {
    if (isLoopbackHost(host) || apiToken) return null;
    return `Refusing to bind CarapaBox HTTP on non-loopback host "${host}" without CARAPA_BOX_API_TOKEN. ` +
        `Configure the token (SECRETS_DIR/carapa_box_api_token or env) or bind to 127.0.0.1.`;
}
