export interface HttpMcpServer {
  name: string;
  url: string;
}

const CARAPA_MAIL_RELAY_URL = 'http://api-relay:8080/carapa-mail/mcp';

/**
 * The Carapa-Mail MCP server when this sandbox's project enabled it, else none.
 *
 * The agent never holds the mail token: api-relay injects the project's token
 * (Board's Carapa-Mail project setting). carapa-mail authenticates the Bearer
 * before parsing the body, so HTTP 200 to an MCP `initialize` means the project
 * has a working token; 401 means disabled or invalid. /health is
 * unauthenticated and cannot tell the two apart. carapa-mail's MCP transport is
 * stateless, so the probe leaves no session behind.
 */
export async function carapaMailMcpServers(url = CARAPA_MAIL_RELAY_URL): Promise<HttpMcpServer[]> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'carapa-agent-runtime', version: '2' } },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    await response.body?.cancel();
    return response.status === 200 ? [{ name: 'carapa-mail', url }] : [];
  } catch {
    return [];
  }
}
