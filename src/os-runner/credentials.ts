/**
 * Per-sandbox relay credentials on the native runner (Board pushes them with
 * sandbox_relay_token), plus a loopback-only lookup endpoint compatible with
 * CarapaBox's GET /api/admin/relay-token/:name so the local relay forwarder
 * resolves them exactly as on a Linux box.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export class CredentialStore {
    private values = new Map<string, string>();

    constructor(private readonly file: string) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
            for (const [key, value] of Object.entries(parsed)) if (typeof value === "string" && value) this.values.set(key, value);
        } catch { /* first run */ }
    }

    private key(name: string, service?: string): string {
        return service ? `${service}::${name}` : name;
    }

    get(name: string, service?: string): string | undefined {
        return this.values.get(this.key(name, service));
    }

    set(name: string, value: string, service?: string): void {
        this.values.set(this.key(name, service), value);
        this.persist();
    }

    delete(name: string, service?: string): void {
        this.values.delete(this.key(name, service));
        this.persist();
    }

    private persist(): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.values)), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
}

/** Start the loopback lookup endpoint; returns its URL and bearer key. */
export async function startCredentialLookup(store: CredentialStore): Promise<{ url: string; key: string; close(): void }> {
    const key = crypto.randomBytes(24).toString("base64url");
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const match = /^\/api\/admin\/relay-token\/([^/]+)$/.exec(url.pathname);
        const presented = String(req.headers.authorization || "");
        if (req.method !== "GET" || !match || presented !== `Bearer ${key}`) {
            res.writeHead(match ? 401 : 404).end();
            return;
        }
        const value = store.get(decodeURIComponent(match[1]), url.searchParams.get("service") || undefined);
        if (!value) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: value }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}`, key, close: () => server.close() };
}
